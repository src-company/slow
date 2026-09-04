// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {SlowOrigin} from "./SlowOrigin.sol";

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

    error NotOrigin();
    error NothingToRescue();
    error TransferGone();
    error SendFailed();

    constructor(address slow_) {
        slow = slow_;
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
        (address origin, bool authenticated) = SlowOrigin.recover(msg.sender, originHint);

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
