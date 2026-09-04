// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {SlowOrigin} from "./SlowOrigin.sol";

interface IOptimismPortal {
    function depositTransaction(
        address to,
        uint256 value,
        uint64 gasLimit,
        bool isCreation,
        bytes calldata data
    ) external payable;
}

interface IArbInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee)
        external
        view
        returns (uint256);
}

interface ISlowDeposit {
    function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
        external
        payable
        returns (uint256);
    function reverse(uint256 transferId) external;
    function clawback(uint256 transferId) external;
    function withdrawFrom(address from, address to, uint256 id, uint256 amount) external;
    function pendingTransfers(uint256 transferId)
        external
        view
        returns (uint96 timestamp, address from, address to, uint256 id, uint256 amount);
}

/// @title SlowArrival
/// @notice The far end of every bridge into SLOW, so a bridged deposit keeps the
///         one thing SLOW is for: the sender can take it back.
///
/// @dev THE BUG THIS EXISTS TO FIX. `SLOW._finishDeposit` records
///      `pendingTransfers[id].from = msg.sender`, and `reverse` and `clawback`
///      both check that field. So whoever the destination chain thinks is
///      calling `depositTo` owns the right to undo the transfer — and on FIVE of
///      the six routes between Ethereum, Base and Robinhood Chain, that is
///      nobody. Only Ethereum → Base survives, because OP Stack aliases a
///      deposit sender only when `msg.sender != tx.origin`:
///
///        Ethereum → Robinhood   Nitro aliases retryable senders UNCONDITIONALLY,
///                               EOAs included. Established empirically: an L1
///                               EOA calling `createRetryableTicket` arrives on
///                               chain 4663 as its own address plus
///                               0x1111…1111, an address with no key on either
///                               side. This route is live today and its reverse
///                               is dead.
///        Base → Ethereum        `OptimismPortal` calls the target itself, so
///                               `from` is the portal.
///        Robinhood → Ethereum   `Outbox` routes through `bridge.executeCall`,
///                               so `from` is the BRIDGE, not the outbox.
///        Base ↔ Robinhood       Both go through L1, and the second hop is a
///                               CONTRACT calling the portal or the inbox —
///                               which both stacks alias. So the far leg fails
///                               the same way even after the near one is fixed.
///
///      In each case `from` also has no `onERC1155Received`, so even a
///      cooperative bridge could not accept the wrapper back.
///
/// @dev THE FIX. Be the depositor, and remember who it was really for. This
///      contract becomes `pt.from`, holds the reverse and clawback rights that
///      come with it, and hands them to the origin it recovered.
///
/// @dev WHY IT NEEDS NO OWNER, NO ALLOWLIST AND NO CONFIGURATION. `pt.from`
///      confers exactly two powers and both GIVE MONEY BACK to `from` — money
///      `from`'s caller supplied in the first place. Attributing an arrival to
///      the wrong person is a gift, never a theft, so the origin can simply be
///      asserted and this contract's job is to route the claim rather than
///      police it. That is what lets one identical build sit at one CREATE3
///      address on every chain.
///
/// @dev WHY `arrive` MUST NEVER REVERT, which is the sharpest edge here.
///      `OptimismPortal.finalizeWithdrawalTransaction` sets
///      `finalizedWithdrawals[hash] = true` BEFORE calling the target and does
///      not revert when that call fails. A revert in here would therefore burn
///      the withdrawal permanently — the ETH stays in the portal and the
///      message can never be replayed. So every failure path lands in `rescue`
///      instead, the deposit runs on a gas budget that reserves enough to
///      record it, and the bounty transfer cannot take the arrival down with
///      it. (Arbitrum is the opposite: `Outbox.executeTransaction` reverts
///      atomically on failure, so there the message stays replayable. The
///      contract is written for the unforgiving one.)
///
/// @dev NATIVE ETH ONLY, deliberately. The value-plus-calldata paths are what
///      make a bridged deposit one transaction, and they carry the chain's own
///      currency. A canonical ERC-20 arrives at a DIFFERENT address on the far
///      side, so wrapping it would silently mint a SLOW position in a token
///      that is not the one the sender named.
contract SlowArrival {
    using SlowOrigin for address;

    /// @notice The SLOW deployment this fronts.
    address public immutable slow;

    /// @notice transferId => who may reverse or claw it back.
    /// @dev Set only for delayed arrivals. A zero-delay arrival mints unlocked
    ///      straight to the recipient and has nothing to undo.
    mapping(uint256 transferId => address origin) public originOf;

    /// @notice ETH that arrived but could not be deposited, held for its origin.
    /// @dev The alternative was reverting, which on an OP withdrawal destroys
    ///      the message. This is the lesser failure and it is recoverable.
    mapping(address origin => uint256 amount) public rescue;

    /// @dev Enough to take the failure branch — one SSTORE to a cold slot, the
    ///      event, and the return — after the deposit attempt has been given
    ///      everything else.
    uint256 private constant FAILURE_RESERVE = 60_000;

    /// @dev A bounty goes to an EOA. Bounded so a hostile finaliser contract
    ///      cannot consume the reserve the failure branch is holding.
    uint256 private constant BOUNTY_GAS = 8_000;

    event Arrived(
        uint256 indexed transferId,
        address indexed origin,
        address indexed to,
        uint256 amount,
        uint96 delay,
        bool authenticated
    );
    event ArrivalFailed(address indexed origin, address indexed to, uint256 amount, uint96 delay);
    event Rescued(address indexed origin, uint256 amount);
    event Reversed(uint256 indexed transferId, address indexed origin, uint256 amount);
    event ClawedBack(uint256 indexed transferId, address indexed origin, uint256 amount);

    /// @notice Where a `forward` may send value on from here.
    /// @dev THE ONE PLACE THIS CONTRACT HOLDS CONFIGURATION, and it is the price
    ///      of forwarding at all. `SlowRelay.pushProof` can take an untrusted
    ///      entrypoint because only a FACT travels through it — a wrong address
    ///      wastes the caller's gas and nothing else. Here VALUE travels, so a
    ///      wrong entrypoint is theft, and the set has to be fixed at
    ///      construction. There is still no owner and no setter: what is written
    ///      here at deploy is what this contract will do forever.
    mapping(uint256 chainId => Route) public routeTo;

    struct Route {
        address entry; // the local entrypoint for that destination
        uint8 kind; // 1 = OP Stack portal, 2 = Arbitrum inbox
        uint64 gasLimit; // destination gas to buy
        uint128 maxFeePerGas; // ceiling for the destination's gas price
    }

    uint8 internal constant KIND_OP = 1;
    uint8 internal constant KIND_ARB = 2;

    /// @dev The onward call is given a bounded budget for the same reason the
    ///      deposit is: whatever happens, the failure branch must still be able
    ///      to record where the value went.
    uint256 private constant FORWARD_RESERVE = 80_000;

    /// @dev What the Arbitrum fee probe may spend. A real
    ///      `calculateRetryableSubmissionFee` is arithmetic over one storage
    ///      read; this is generous for that and small enough that the reserve
    ///      above survives it, which is the property that matters.
    uint256 private constant FEE_PROBE_GAS = 30_000;

    event Forwarded(
        uint256 indexed dstChainId,
        address indexed origin,
        address indexed to,
        uint256 amount,
        uint96 delay
    );
    event ForwardFailed(
        uint256 indexed dstChainId, address indexed origin, address indexed to, uint256 amount
    );

    error NotOrigin();
    error NothingToRescue();
    error NoSlow();
    error TransferGone();
    error SendFailed();

    /// @dev `slow_` must already be deployed. A value-bearing call to a codeless
    ///      address returns success with empty returndata, which this contract
    ///      reads as a failed deposit — so it would credit `rescue` for ETH that
    ///      had already left, and the first claimant would drain the rest. The
    ///      CREATE3 same-address design makes deploying this before SLOW an easy
    ///      ordering mistake, so it is refused rather than trusted.
    constructor(address slow_, uint256[] memory chainIds, Route[] memory routes) {
        require(slow_.code.length != 0, NoSlow());
        slow = slow_;
        require(chainIds.length == routes.length, NoSlow());
        for (uint256 i; i != chainIds.length; ++i) {
            routeTo[chainIds[i]] = routes[i];
        }
    }

    /// @dev Who is behind this call, with one branch `SlowOrigin` cannot carry.
    ///
    ///      A message this contract forwards to itself on another chain arrives
    ///      ALIASED, because it is a contract sending it: `msg.sender` is
    ///      `applyAlias(address(this))`. None of the library's probes answer for
    ///      that, and its hint branch cannot match either — the hint names the
    ///      original sender, not this contract — so recovery would fall through
    ///      to `msg.sender` and hand the position to an address with no key.
    ///      That is exactly the defect this contract exists to fix, arriving
    ///      through the back door of its own forward.
    ///
    ///      Trusting the hint here is sound because nobody can put code at
    ///      `applyAlias(address(this))`: reaching that specific address would
    ///      mean finding a 160-bit preimage. The same argument `SlowRelay` uses
    ///      to accept a proof with no allowlist at all.
    function _recoverOrigin(address hint)
        private
        view
        returns (address origin, bool authenticated)
    {
        if (SlowOrigin.undoAlias(msg.sender) == address(this)) {
            return hint != address(0) ? (hint, true) : (msg.sender, false);
        }
        return SlowOrigin.recover(msg.sender, hint);
    }

    // ─────────────────────────────────────────────────────────── ARRIVING

    /// @notice Land bridged ETH inside SLOW as a normal position, keeping the
    ///         reverse for whoever sent it.
    /// @param to The recipient of the SLOW position.
    /// @param delay The timelock, passed through to `depositTo` unchanged.
    /// @param originHint Who the source chain says is behind this. Believed only
    ///        when it can be checked (see `SlowOrigin.recover`), and otherwise
    ///        harmless either way.
    /// @param bounty Paid out of the arriving value to whoever landed the
    ///        message. An OP exit needs two L1 transactions from someone —
    ///        prove, then finalise a day later — and an Arbitrum exit needs one.
    ///        This is what makes those somebody's business instead of a chore
    ///        the recipient has to remember five days later. Same idea as
    ///        `SLOWGate`'s tip, aimed at a different job.
    function arrive(address to, uint96 delay, address originHint, uint256 bounty)
        external
        payable
    {
        (address origin, bool authenticated) = _recoverOrigin(originHint);
        // ORIGIN HINTS ARE CHECKED, NEVER TAKEN ON TRUST. An unmatched hint is
        // refused and the caller owns its own deposit, which is what stops
        // anyone handing a stranger's address the reverse right by simply
        // naming it.
        //
        // THE COST OF THAT, and it is real: on an L1->L2 leg the caller IS the
        // aliased sender, so a message that OMITS `originHint` resolves to an
        // address with no key on either chain, and `rescue`/`originOf` land
        // somewhere nobody can claim from. A correct hint is honoured — the
        // alias branch in `SlowOrigin.recover` matches it — so the requirement
        // is that L1->L2 callers always pass one. Preferring an unmatched hint
        // instead was considered and rejected: it would rescue the omitted-hint
        // case not at all (there is no hint to prefer) while letting any direct
        // caller give their deposit away, which is a worse trade.

        uint256 value = msg.value;
        // A bounty at or above the payload is a malformed message. Clamping it
        // to `value` — as this did — paid the WHOLE arrival out as a tip and
        // skipped the deposit entirely, so a finaliser collected the recipient's
        // funds and no `Arrived` or `rescue` recorded where they went. Reverting
        // is not an option either; it would destroy the withdrawal. So the
        // bounty is simply refused and the payload continues to the recipient,
        // which is the reading that loses nobody anything.
        uint256 pay = bounty < value ? bounty : 0;
        unchecked {
            value -= pay;
        }

        if (value != 0) {
            // BAIL OUT RATHER THAN INVERT. The old form was
            //     budget > FAILURE_RESERVE ? budget - FAILURE_RESERVE : budget
            // which, in the one band the reserve exists for — gasleft() at or
            // below it — kept nothing back and handed the whole remainder to a
            // deposit that cannot finish in it. The deposit then burned 63/64,
            // the `rescue` write had no gas, and `arrive` reverted. On the OP
            // leg the portal has already marked the withdrawal finalized by
            // then and will never replay it, so the bridged ETH is stranded for
            // good — precisely what this function must never allow.
            bool ok;
            uint256 transferId;
            uint256 rds;
            if (gasleft() > FAILURE_RESERVE) {
                uint256 budget;
                unchecked {
                    budget = gasleft() - FAILURE_RESERVE;
                }
                address target = slow;
                bytes memory cd =
                    abi.encodeCall(ISlowDeposit.depositTo, (address(0), to, 0, delay, ""));
                // FIXED 32-BYTE RETURN WINDOW, not `bytes memory`. The high-level
                // form copies the whole `returndatasize()` into this frame before
                // anything looks at it, and `_mint` bubbles the recipient hook's
                // revert data verbatim — so a recipient that reverts with a large
                // buffer charges this frame quadratic memory expansion out of the
                // very reserve that is meant to survive the failure. A caller-side
                // window cannot be sized by the callee.
                assembly ("memory-safe") {
                    ok := call(budget, target, value, add(cd, 0x20), mload(cd), 0x00, 0x20)
                    transferId := mload(0x00)
                    rds := returndatasize()
                }
            }
            if (ok && rds == 32) {
                // Zero means the deposit was not delayed: it minted unlocked to
                // `to` and there is no pending entry to own.
                if (transferId != 0) originOf[transferId] = origin;
                emit Arrived(transferId, origin, to, value, delay, authenticated);
            } else {
                rescue[origin] += value;
                emit ArrivalFailed(origin, to, value, delay);
            }
        }

        if (pay != 0) {
            // `tx.origin` is the only handle on the finaliser: during a
            // withdrawal `msg.sender` IS the portal or the bridge. A keeper
            // contract wrapping the call gets the bounty at the EOA behind it,
            // which is a mild loss of precision and not a hazard.
            //
            // BUT ONLY WHEN THERE IS A FINALISER TO PAY. On the L1->L2 routes
            // the message auto-executes: nobody pushed a button, and both
            // stacks run it with `tx.origin == msg.sender == the ALIASED
            // sender` — an address with no key on either chain. Paying it burns
            // the bounty, and silently: a value call to a codeless address
            // returns success, so `paid` is true and the rescue below never
            // fires. Two of the six routes lost the bounty outright that way,
            // on exactly the routes where no bounty is owed to begin with.
            if (tx.origin == msg.sender) {
                rescue[origin] += pay;
            } else {
                (bool paid,) = tx.origin.call{value: pay, gas: BOUNTY_GAS}("");
                if (!paid) rescue[origin] += pay;
            }
        }
    }

    // ───────────────────────────────────────────────────────── FORWARDING

    /// @notice Land on this chain only to leave it again: take value arriving
    ///         from one chain and push it on to another, so a send between two
    ///         L2s is ONE action by the sender rather than two five days apart.
    ///
    /// @dev WHY THIS EXISTS. Without it, an L2-to-L2 send is a withdrawal to L1
    ///      and then, five days later, a second transaction the sender has to
    ///      come back and make. The value is not at risk in the meantime, but a
    ///      transfer that needs the sender to return a working week later is one
    ///      most senders will not finish. Forwarding makes the far side arrive
    ///      on its own.
    ///
    /// @dev THE BOUNTY IS PAID HERE, NOT PASSED ON. This leg has a finaliser —
    ///      somebody proved and finalised the withdrawal that landed this call —
    ///      and the next leg does not, because an L1 to L2 message executes on
    ///      its own. So the bounty is settled against `tx.origin` here and the
    ///      onward `arrive` is built with a bounty of zero.
    ///
    /// @dev AND IT MUST NOT REVERT, for the same reason `arrive` must not: on
    ///      the OP leg the portal has already marked the withdrawal finalised
    ///      before calling, and will never replay it. Every failure — no route,
    ///      fees larger than the payload, an entrypoint that reverts — lands in
    ///      `rescue` for the origin instead.
    function forward(
        uint256 dstChainId,
        address to,
        uint96 delay,
        address originHint,
        uint256 bounty
    ) external payable {
        (address origin,) = _recoverOrigin(originHint);

        uint256 value = msg.value;
        uint256 pay = bounty < value ? bounty : 0;
        unchecked {
            value -= pay;
        }

        if (value != 0 && !_push(dstChainId, to, delay, origin, value)) {
            rescue[origin] += value;
            emit ForwardFailed(dstChainId, origin, to, value);
        }

        if (pay != 0) {
            if (tx.origin == msg.sender) {
                rescue[origin] += pay;
            } else {
                (bool paid,) = tx.origin.call{value: pay, gas: BOUNTY_GAS}("");
                if (!paid) rescue[origin] += pay;
            }
        }
    }

    /// @dev The onward hop. Returns false rather than reverting, always.
    function _push(uint256 dstChainId, address to, uint96 delay, address origin, uint256 value)
        private
        returns (bool)
    {
        Route memory r = routeTo[dstChainId];
        if (r.entry == address(0) || dstChainId == block.chainid) return false;
        // The probe's cap is added rather than assumed to fit inside the
        // reserve: the reserve exists to survive a FAILED forward, and gas the
        // fee probe is allowed to spend is gas it will not have.
        if (gasleft() <= FORWARD_RESERVE + FEE_PROBE_GAS) return false;

        // The far side is this same contract at this same address, which is
        // what makes the origin survivable: it will see `applyAlias(this)` and
        // believe the hint. Bounty zero — see above.
        bytes memory inner =
            abi.encodeCall(this.arrive, (to, delay, origin, uint256(0)));

        bytes memory cd;
        uint256 send;
        if (r.kind == KIND_OP) {
            // The portal mints `msg.value` on the far side and calls `to` with
            // `value`, so the two are the same number and no fee is deducted.
            cd = abi.encodeCall(
                IOptimismPortal.depositTransaction,
                (address(this), value, r.gasLimit, false, inner)
            );
            send = value;
        } else if (r.kind == KIND_ARB) {
            // A retryable is bought here and now, five days after the sender
            // chose to send, so the submission fee has to be PRICED LIVE
            // against the current base fee. Anything decided at send time would
            // be a working week stale by the time it is spent.
            // THE ONLY CALL IN THIS FILE THAT HAD NEITHER PROTECTION THE REST
            // OF IT APPLIES, and it needs both. `r.entry` is a proxy whose
            // implementation can be replaced after this contract is deployed,
            // so it is not the trusted constant its position in a Route makes
            // it look like.
            //
            //   BOUNDED GAS, as `SlowOrigin._probe` bounds its probes. Uncapped,
            //   this call takes 63/64 of everything and can spend the reserve
            //   the failure branch is holding — the reserve is only reserved
            //   from the FORWARD, never from this.
            //
            //   A FIXED 32-BYTE WINDOW, as `arrive` uses for the same reason.
            //   `bytes memory` copies the whole `returndatasize()` into this
            //   frame and charges quadratic memory expansion here, which is how
            //   a callee held to a gas cap bills past it anyway.
            //
            // Either failure ends with `rescue` unable to run and `forward`
            // reverting, and on the OP leg the portal has already marked the
            // withdrawal finalised by then and will never replay it.
            uint256 submission;
            {
                bytes memory fd = abi.encodeCall(
                    IArbInbox.calculateRetryableSubmissionFee, (inner.length, block.basefee)
                );
                address feeTo = r.entry;
                bool ok;
                uint256 rds;
                assembly ("memory-safe") {
                    ok := staticcall(FEE_PROBE_GAS, feeTo, add(fd, 0x20), mload(fd), 0x00, 0x20)
                    submission := mload(0x00)
                    rds := returndatasize()
                }
                if (!ok || rds != 32) return false;
            }
            // BOUNDED BEFORE IT IS SCALED. `submission` is whatever `r.entry`
            // said, and `submission * 3 / 2` on a wide answer OVERFLOWS — which
            // under checked arithmetic REVERTS, the one thing this function may
            // never do. So does `submission + gasCost` below. A fee already
            // larger than the payload is refused three lines down anyway, so
            // refusing it here costs nothing and makes both sums safe.
            if (submission > value) return false;
            submission = submission * 3 / 2; // a rising base fee must not strand it

            uint256 gasCost = uint256(r.gasLimit) * uint256(r.maxFeePerGas);
            // If the fees eat the payload there is nothing worth sending, and
            // sending anyway would hand the whole amount to the bridge.
            if (value <= submission + gasCost) return false;
            uint256 callValue;
            unchecked {
                callValue = value - submission - gasCost;
            }
            cd = abi.encodeCall(
                IArbInbox.createRetryableTicket,
                (
                    address(this),
                    callValue,
                    submission,
                    origin, // excess fee refund, on the far side
                    origin, // call value refund, if the ticket is never redeemed
                    r.gasLimit,
                    r.maxFeePerGas,
                    inner
                )
            );
            send = value;
        } else {
            return false;
        }

        // CHECKED AGAIN HERE, not just at the top of this function. Between the
        // two the ARBITRUM branch makes an UNCAPPED staticcall into `r.entry`
        // for the live submission fee, and `r.entry` is a proxy whose
        // implementation can be replaced after this contract is deployed. If
        // that call spends the gap, the subtraction below — which has to stay
        // unchecked to be cheap — wraps to ~2^256, `call` takes 63/64 of what
        // is left, and the `rescue` write in the caller that must survive a
        // failed forward has nothing to run on. On the OP leg the portal has
        // already marked the withdrawal finalised by then and will never
        // replay it, so that is the one outcome this contract exists to
        // prevent. `arrive` guards its own budget the same way.
        if (gasleft() <= FORWARD_RESERVE) return false;
        uint256 budget;
        unchecked {
            budget = gasleft() - FORWARD_RESERVE;
        }
        address entry = r.entry;
        bool sent;
        assembly ("memory-safe") {
            sent := call(budget, entry, send, add(cd, 0x20), mload(cd), 0x00, 0x00)
        }
        if (sent) emit Forwarded(dstChainId, origin, to, value, delay);
        return sent;
    }

    /// @notice Recover ETH from an arrival that could not be deposited.
    function claimRescue(address to) external {
        uint256 amount = rescue[msg.sender];
        require(amount != 0, NothingToRescue());
        rescue[msg.sender] = 0;
        emit Rescued(msg.sender, amount);
        _sendETH(to, amount);
    }

    // ───────────────────────────────────────────────────── GIVING IT BACK

    /// @notice Cancel a bridged-in transfer during its timelock, as the sender
    ///         would have been able to had the bridge not stood in the way.
    /// @dev `SLOW.reverse` credits `unlockedBalances[pt.from]` and hands the
    ///      wrapper back to `pt.from` with `_safeTransfer`, which fires
    ///      `onERC1155Received` here — hence the hooks below. The wrapper is
    ///      then burnt straight through to `to`.
    function reverse(uint256 transferId, address to) external {
        (address origin, uint256 id, uint256 amount) = _take(transferId);
        ISlowDeposit(slow).reverse(transferId);
        ISlowDeposit(slow).withdrawFrom(address(this), to, id, amount);
        emit Reversed(transferId, origin, amount);
    }

    /// @notice The same, 30 days past expiry, for a recipient who never settled.
    function clawback(uint256 transferId, address to) external {
        (address origin, uint256 id, uint256 amount) = _take(transferId);
        ISlowDeposit(slow).clawback(transferId);
        ISlowDeposit(slow).withdrawFrom(address(this), to, id, amount);
        emit ClawedBack(transferId, origin, amount);
    }

    function _take(uint256 transferId)
        private
        returns (address origin, uint256 id, uint256 amount)
    {
        origin = originOf[transferId];
        require(origin != address(0) && msg.sender == origin, NotOrigin());
        // Read before the call: SLOW deletes the entry inside `reverse`.
        (uint96 timestamp,,, uint256 id_, uint256 amount_) =
            ISlowDeposit(slow).pendingTransfers(transferId);
        require(timestamp != 0, TransferGone());
        (id, amount) = (id_, amount_);
        delete originOf[transferId];
    }

    function _sendETH(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, SendFailed());
    }

    // ────────────────────────────────────────────────────────────── HOOKS

    /// @dev Required, not optional: without it `SLOW.reverse` reverts on the
    ///      hand-back and the rights this contract holds could never be used.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x4e2312e0;
    }

    /// @dev Value with no calldata is a message nobody can act on. It is
    ///      accepted and left where it lands, on purpose: reverting would
    ///      destroy an OP withdrawal outright, and doing enough work to record
    ///      an owner could itself run out of gas and do the same. Neither risk
    ///      is worth taking for a shape the page never builds — every route it
    ///      composes carries `arrive` calldata.
    receive() external payable {}
}
