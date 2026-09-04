// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {SlowOrigin} from "./SlowOrigin.sol";

interface IOpMessenger {
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external;
}

interface IArbSys {
    function sendTxToL1(address destination, bytes calldata data)
        external
        payable
        returns (uint256);
}

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
}

interface ISlow {
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
    function unlockedBalances(address user, uint256 id) external view returns (uint256);
}

/// @title SlowRelay
/// @notice Cross-chain SLOW sends where the only thing that waits on a bridge is
///         the relayer's capital.
///
/// @dev THE ASYMMETRY THIS EXPLOITS. Every bridge that fronts liquidity has to
///      price a relayer's exposure, and the user pays for it in latency, in
///      trust, or in fee. SLOW is the one protocol where the wait is already the
///      product: a sender who chose a three-day timelock has agreed to three
///      days. If the relayer's fill lands inside that window — and it lands in
///      seconds — the cross-chain send costs the recipient nothing at all.
///
/// @dev WHAT IS AND IS NOT AT RISK. The user's funds never enter a bridge. They
///      sit in an escrow on the chain they started on until either a proof of
///      fill releases them to a relayer, or the sender cancels. Only the
///      relayer's own inventory crosses, and the relayer is repaid by a
///      canonical message or not at all. There is no bond, no oracle, no
///      committee and no fraud window: the fee is a clean interest rate on the
///      canonical latency of the RETURN leg, which a relayer serving both
///      directions nets out to almost nothing.
///
/// @dev ONE ESCROW SHAPE, THREE DOORS. Every entry converges on the same thing:
///      an unlocked SLOW position at a zero-delay id, held by this contract.
///      That is what makes ETH and ERC-20 identical here — SLOW's id already
///      encodes the token — and it is why payouts are a single `withdrawFrom`
///      to whoever earned them.
///
///        open              native ETH, one transaction.
///        openToken         an ERC-20 this contract is approved for.
///        onERC1155Received a SLOW position handed straight over, in ONE
///                          transaction, with the intent riding in the `data`
///                          field `safeTransferFrom` already forwards. No
///                          approval, no second call, and it works for ETH- and
///                          ERC-20-backed positions alike.
///
/// @dev WHY THE ERC-1155 DOOR REFUSES A DELAYED ID. `SLOW.safeTransferFrom` of
///      an id with a delay does not settle — it opens a NEW pending transfer
///      with `from` still the sender, who keeps `reverse` for the whole
///      timelock. Accepting one would hand the sender the power to empty the
///      escrow after a relayer had already paid out on the far side. Only a
///      zero-delay id credits this contract irrevocably, so only a zero-delay
///      id is taken.
///
/// @dev THE SIGNED SLIP, AND EXACTLY WHAT IT BUYS. `openFor` lets a relayer
///      submit the source leg on the sender's behalf against an EIP-712
///      signature, so the sender signs once and sends no transaction. It proves
///      intent and terms. It does NOT prove the funds are still there — a
///      signature is not a lock — which is why it opens the same escrow rather
///      than replacing it. The chain binding is not decoration: this contract
///      has the SAME ADDRESS on every chain, so the EIP-712 domain's
///      `verifyingContract` is identical everywhere and `chainId` is the only
///      thing separating a Base slip from a Robinhood one. Both chain ids are
///      also inside the struct, so the id a relayer settles against on one
///      chain is the id it filled against on the other.
contract SlowRelay {
    using SafeTransferLib for address;

    // ───────────────────────────────────────────────────────────── TYPES

    struct Intent {
        address sender; // opens the escrow, cancels it, and keeps the far-side reverse
        address recipient; // receives the SLOW position on the destination
        // ONE ADDRESS CANNOT NAME THE SAME ASSET ON TWO CHAINS. USDC on Base
        // and whatever happens to sit at that address on Robinhood are
        // unrelated contracts, so a single `token` field let a relayer deliver
        // something worthless at the same address and then collect the real
        // escrow. The sender names BOTH legs, and neither is inferred.
        address srcToken; // what is escrowed here. address(0) is native ETH
        address dstToken; // what must be delivered there. address(0) is native ETH
        uint256 amount; // what the recipient's leg is worth
        uint256 fee; // the relayer's, paid out of the same escrow
        uint96 delay; // SLOW timelock, passed to the destination UNCHANGED
        uint64 srcChainId; // where the escrow is
        uint64 dstChainId; // where the fill is
        uint64 fillDeadline; // after this the sender may cancel; see the race note
        uint256 nonce; // the sender's, so identical terms are still distinct
    }

    enum Status {
        NONE,
        OPEN,
        RELEASED,
        CANCELLED
    }

    // ─────────────────────────────────────────────────────────── STORAGE

    /// @notice The SLOW deployment this escrows into.
    address public immutable slow;

    /// @notice Contracts whose word about a far-side sender is worth money.
    /// @dev Duck-typing alone is enough for `SlowArrival`, where mis-attribution
    ///      is a gift rather than a theft. It is NOT enough here: anyone can
    ///      deploy a contract whose `l2Sender()` returns whatever they like, and
    ///      `receiveRelay` moves other people's escrow. So an inbound proof must
    ///      also arrive through a known bridge. Constructor arguments do not
    ///      enter a CREATE3 address, so this contract still lands at one address
    ///      on every chain despite holding chain-specific values.
    mapping(address inbox => bool) public trustedInbox;

    mapping(bytes32 intentId => Status) public statusOf;
    /// @notice intentId => the escrowed SLOW id, so a payout needs no re-derivation.
    mapping(bytes32 intentId => uint256 slowId) public escrowIdOf;
    /// @notice intentId => who filled it on the destination.
    mapping(bytes32 intentId => address relayer) public filledBy;
    /// @notice intentId => the relayer a far-side proof named, on the source chain.
    mapping(bytes32 intentId => address relayer) public provenBy;
    /// @notice SLOW transferId => who may reverse the destination leg. The sender.
    mapping(uint256 transferId => address origin) public originOf;
    /// @notice Signed-slip replay protection, per sender.
    mapping(address sender => mapping(uint256 nonce => bool)) public slipUsed;

    // ──────────────────────────────────────────────────────── EIP-712

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address sender,address recipient,address srcToken,address dstToken,uint256 amount,uint256 fee,uint96 delay,uint64 srcChainId,uint64 dstChainId,uint64 fillDeadline,uint256 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ──────────────────────────────────────────────────────────── EVENTS

    event Opened(bytes32 indexed intentId, address indexed sender, uint256 slowId, Intent intent);
    event Filled(
        bytes32 indexed intentId,
        address indexed relayer,
        uint256 indexed transferId,
        address recipient
    );
    event Proven(bytes32 indexed intentId, address indexed relayer);
    event Released(bytes32 indexed intentId, address indexed relayer, uint256 amount);
    event Cancelled(bytes32 indexed intentId, address indexed sender, uint256 amount);
    event Reversed(uint256 indexed transferId, address indexed sender);
    event ProofSent(bytes32 indexed intentId, address indexed relayer, uint256 towardChainId);

    // ──────────────────────────────────────────────────────────── ERRORS

    error WrongChain();
    error NotOpen();
    error AlreadyOpen();
    error AlreadyFilled();
    error NotFilled();
    error NotProven();
    error NotSender();
    error NotOrigin();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error BadValue();
    error BadIntent();
    error DelayedIdRefused();
    error UntrustedInbox();
    error BadSignature();
    error SlipUsed();
    error NoRoute();

    constructor(address slow_, address[] memory inboxes) {
        slow = slow_;
        for (uint256 i; i != inboxes.length; ++i) {
            trustedInbox[inboxes[i]] = true;
        }
    }

    // ───────────────────────────────────────────────────────────── HASHING

    /// @notice The cross-chain key. Deliberately NOT an EIP-712 digest: both
    ///         chains must compute the same value, and a 712 digest folds in the
    ///         local `chainId`. The chain binding lives in the struct instead,
    ///         where both chains can read it.
    function intentId(Intent calldata i) public pure returns (bytes32) {
        return keccak256(abi.encode(i));
    }

    function _intentIdMem(Intent memory i) private pure returns (bytes32) {
        return keccak256(abi.encode(i));
    }

    /// @notice The digest a sender signs to let a relayer open the escrow for
    ///         them. Bound to `srcChainId` through the domain — never
    ///         `block.chainid`, so the digest is checkable from either side.
    function slipDigest(Intent calldata i) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("SlowRelay"),
                keccak256("1"),
                uint256(i.srcChainId),
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                i.sender,
                i.recipient,
                i.srcToken,
                i.dstToken,
                i.amount,
                i.fee,
                i.delay,
                i.srcChainId,
                i.dstChainId,
                i.fillDeadline,
                i.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    // ────────────────────────────────────────────────────────────── OPENING

    /// @notice Escrow native ETH against an intent.
    function open(Intent calldata i) external payable returns (bytes32 id) {
        require(i.srcToken == address(0), BadIntent());
        require(msg.value == i.amount + i.fee, BadValue());
        require(msg.sender == i.sender, NotSender());
        id = _checkOpen(i);
        uint256 slowId = _wrap(address(0), i.amount + i.fee);
        _record(id, i, slowId);
    }

    /// @notice Escrow an ERC-20 this contract is approved to pull.
    function openToken(Intent calldata i) external returns (bytes32 id) {
        require(i.srcToken != address(0), BadIntent());
        require(msg.sender == i.sender, NotSender());
        id = _checkOpen(i);
        uint256 total = i.amount + i.fee;
        i.srcToken.safeTransferFrom(msg.sender, address(this), total);
        uint256 slowId = _wrap(i.srcToken, total);
        _record(id, i, slowId);
    }

    /// @notice Escrow on a sender's behalf against their signed slip, so they
    ///         sign once and send nothing. ERC-20 only: native ETH cannot be
    ///         moved by an off-chain signature.
    /// @dev The slip proves intent and terms. It does not prove the funds are
    ///      still there — the `safeTransferFrom` below is what does that, and a
    ///      relayer must check it landed before filling on the far side.
    function openFor(Intent calldata i, bytes calldata signature) external returns (bytes32 id) {
        require(i.srcToken != address(0), BadIntent());
        require(!slipUsed[i.sender][i.nonce], SlipUsed());
        require(_validSignature(i.sender, slipDigest(i), signature), BadSignature());
        slipUsed[i.sender][i.nonce] = true;
        id = _checkOpen(i);
        uint256 total = i.amount + i.fee;
        i.srcToken.safeTransferFrom(i.sender, address(this), total);
        uint256 slowId = _wrap(i.srcToken, total);
        _record(id, i, slowId);
    }

    /// @notice The one-transaction door: hand a SLOW position straight to this
    ///         contract with the intent in `data`.
    /// @dev `SLOW.safeTransferFrom` forwards `data` here, so the escrow opens in
    ///      the same transaction that funds it — no approval, no second call,
    ///      and identical for ETH- and ERC-20-backed positions.
    ///
    ///      The position stays wrapped. Unwrapping here is impossible anyway:
    ///      this hook runs inside SLOW's `nonReentrant`, so a call back into
    ///      `withdrawFrom` would revert. Keeping it wrapped turns that
    ///      constraint into the design — the escrow IS a SLOW position, and a
    ///      payout is one `withdrawFrom` to whoever earned it.
    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata data)
        external
        returns (bytes4)
    {
        require(msg.sender == slow, BadIntent());
        if (data.length == 0) return this.onERC1155Received.selector; // a plain gift

        // A delayed id would arrive as a NEW pending transfer that `from` can
        // reverse for the whole timelock, which would let the sender empty this
        // escrow after a relayer had already been paid on the far side.
        require(id >> 160 == 0, DelayedIdRefused());

        Intent memory i = abi.decode(data, (Intent));
        // `from == address(0)` reaches this hook through `_mint`'s receiver
        // callback, which would open an escrow whose `i.sender` is the zero
        // address — and `cancel` requires `msg.sender == i.sender`, so nobody
        // could ever refund it.
        require(from != address(0), NotSender());
        require(i.sender == from, NotSender());
        require(i.srcToken == address(uint160(id)), BadIntent());
        require(value == i.amount + i.fee, BadValue());

        // The SAME predicate the other three doors use. This hook used to
        // re-implement it inline and had already drifted by two checks —
        // `amount != 0` and `recipient != address(0)` — which let an escrow be
        // opened that no `fill` could ever satisfy, freezing the value until
        // the deadline while looking OPEN to every relayer watching the event.
        _validate(i);
        bytes32 key = _intentIdMem(i);
        require(statusOf[key] == Status.NONE, AlreadyOpen());

        statusOf[key] = Status.OPEN;
        escrowIdOf[key] = id;
        emit Opened(key, from, id, i);
        return this.onERC1155Received.selector;
    }

    function _checkOpen(Intent calldata i) private view returns (bytes32 id) {
        _validate(i);
        id = intentId(i);
        require(statusOf[id] == Status.NONE, AlreadyOpen());
    }

    /// @dev What every opening door must agree on. Kept in one place because it
    ///      was in two and they diverged.
    function _validate(Intent memory i) private view {
        require(i.srcChainId == block.chainid, WrongChain());
        require(i.dstChainId != i.srcChainId, BadIntent());
        require(i.amount != 0, BadIntent());
        require(i.recipient != address(0), BadIntent());
        require(i.fillDeadline > block.timestamp, DeadlinePassed());
    }

    function _record(bytes32 id, Intent calldata i, uint256 slowId) private {
        statusOf[id] = Status.OPEN;
        escrowIdOf[id] = slowId;
        emit Opened(id, i.sender, slowId, i);
    }

    /// @dev Wrap into a zero-delay SLOW position held by this contract. Zero
    ///      delay means `depositTo` credits `unlockedBalances` directly: there
    ///      is no pending entry and so nothing anyone can reverse.
    function _wrap(address token, uint256 amount) private returns (uint256 slowId) {
        if (token == address(0)) {
            ISlow(slow).depositTo{value: amount}(address(0), address(this), 0, 0, "");
        } else {
            token.safeApproveWithRetry(slow, amount);
            ISlow(slow).depositTo(token, address(this), amount, 0, "");
        }
        slowId = uint256(uint160(token));
    }

    // ────────────────────────────────────────────────────────────── FILLING

    /// @notice Deliver the recipient's leg on the destination chain, from the
    ///         relayer's own inventory.
    /// @dev The delay is passed through UNCHANGED rather than reduced by the
    ///      elapsed time. SLOW encodes the delay into the position's id, so
    ///      subtracting would hand the recipient a one-off id — a different
    ///      token, and a strange string in the rendered art — to save the
    ///      seconds between opening and filling.
    function fill(Intent calldata i) external payable returns (uint256 transferId) {
        require(i.dstChainId == block.chainid, WrongChain());
        require(block.timestamp <= i.fillDeadline, DeadlinePassed());
        bytes32 id = intentId(i);
        require(filledBy[id] == address(0), AlreadyFilled());
        filledBy[id] = msg.sender;

        if (i.dstToken == address(0)) {
            require(msg.value == i.amount, BadValue());
            transferId =
                ISlow(slow).depositTo{value: i.amount}(address(0), i.recipient, 0, i.delay, "");
        } else {
            require(msg.value == 0, BadValue());
            i.dstToken.safeTransferFrom(msg.sender, address(this), i.amount);
            i.dstToken.safeApproveWithRetry(slow, i.amount);
            transferId = ISlow(slow).depositTo(i.dstToken, i.recipient, i.amount, i.delay, "");
        }

        // The sender keeps their reverse — it just lands on the far side. The
        // relayer cannot reverse: `pt.from` is this contract, and this contract
        // exposes the right to the sender alone.
        if (transferId != 0) originOf[transferId] = i.sender;
        emit Filled(id, msg.sender, transferId, i.recipient);
    }

    /// @notice Cancel the destination leg during its timelock, as the sender.
    /// @dev Reversing a cross-chain send returns the money on the FAR side. The
    ///      relayer is unaffected — it delivered, and is repaid from the source
    ///      escrow regardless. The sender simply ends up holding their own funds
    ///      on the destination chain, having paid the fee to get them there.
    function reverse(uint256 transferId, address to) external {
        address origin = originOf[transferId];
        require(origin != address(0) && msg.sender == origin, NotOrigin());
        (uint96 ts,,, uint256 id, uint256 amount) = ISlow(slow).pendingTransfers(transferId);
        require(ts != 0, NotFilled());
        delete originOf[transferId];
        ISlow(slow).reverse(transferId);
        ISlow(slow).withdrawFrom(address(this), to, id, amount);
        emit Reversed(transferId, origin);
    }

    /// @notice Recover the destination leg after the timelock and SLOW's grace,
    ///         as the sender, when the recipient never settled.
    /// @dev THE OTHER HALF OF `pt.from`, and it was missing. Filling makes this
    ///      contract the recorded sender of the destination deposit, which
    ///      carries two rights in SLOW: `reverse` during the timelock and
    ///      `clawback` thirty days after it expires. Only the first was exposed.
    ///      A recipient who never calls `unlock` — a lost key, a contract that
    ///      cannot receive, a typo — left the money with no exit at all: the
    ///      sender's `reverse` window had closed, `clawback` was gated on
    ///      `pt.from` and `pt.from` is this contract, which had no function that
    ///      could call it. The relayer is paid from the source escrow either
    ///      way, so the whole loss fell on the sender. `SlowArrival` exposes
    ///      exactly this for the same reason.
    function clawback(uint256 transferId, address to) external {
        address origin = originOf[transferId];
        require(origin != address(0) && msg.sender == origin, NotOrigin());
        (uint96 ts,,, uint256 id, uint256 amount) = ISlow(slow).pendingTransfers(transferId);
        require(ts != 0, NotFilled());
        delete originOf[transferId];
        ISlow(slow).clawback(transferId);
        ISlow(slow).withdrawFrom(address(this), to, id, amount);
        emit Reversed(transferId, origin);
    }

    // ───────────────────────────────────────────────────────────── PROVING

    /// @notice Record, on the SOURCE chain, that a far-side SlowRelay says this
    ///         intent was filled.
    /// @dev Two conditions, and both are needed. The origin must be this
    ///      contract's own address — CREATE3 puts it at the same address on
    ///      every chain, so "a message from SlowRelay elsewhere" is a value this
    ///      contract can name without a registry. And the message must have
    ///      arrived through a bridge, because `SlowOrigin`'s duck-typing is
    ///      forgeable by anyone willing to deploy a contract with an
    ///      `l2Sender()`. The alias branch needs no allowlist: forging it would
    ///      mean deploying code at `applyAlias(address(this))`, a specific
    ///      address nobody can reach.
    function receiveRelay(bytes32 id, address relayer) external {
        require(_authenticatedSelf(), UntrustedInbox());
        require(relayer != address(0), BadIntent());
        if (provenBy[id] == address(0)) {
            provenBy[id] = relayer;
            emit Proven(id, relayer);
        }
    }

    function _authenticatedSelf() private view returns (bool) {
        // Unforgeable: an L1→L2 message from this contract arrives aliased, and
        // nobody can put code at that address.
        if (SlowOrigin.undoAlias(msg.sender) == address(this)) return true;
        if (!trustedInbox[msg.sender]) return false;
        (address origin, bool authenticated) = SlowOrigin.recover(msg.sender, address(0));
        return authenticated && origin == address(this);
    }

    // ───────────────────────────────────────────────────────────── PAYOUT

    /// @notice Pay the relayer that a proof named, from the escrow.
    function release(Intent calldata i) external {
        _release(i, address(0));
    }

    /// @notice Release to an address the proven relayer names instead.
    /// @dev THE PUSH HAD NO RETRY, AND THAT WAS A LOCK. `withdrawFrom` sends ETH
    ///      with a hard `safeTransferETH`, so a `filledBy` address that rejects
    ///      ETH made `release` revert every time — while `provenBy != 0`
    ///      simultaneously and permanently blocked `cancel`. Anyone willing to
    ///      fill an intent from a contract with a reverting `receive()` could
    ///      strand the sender's escrow forever at the cost of gas, recovering
    ///      their own fill if they were also the recipient. The destination is
    ///      now the relayer's to choose and to change, so a failed payout is a
    ///      retry rather than a tomb. Everything else still gates on the proof.
    function releaseTo(Intent calldata i, address to) external {
        require(to != address(0), BadIntent());
        require(msg.sender == provenBy[intentId(i)], NotOrigin());
        _release(i, to);
    }

    function _release(Intent calldata i, address to) private {
        bytes32 id = intentId(i);
        require(statusOf[id] == Status.OPEN, NotOpen());
        address relayer = provenBy[id];
        require(relayer != address(0), NotProven());
        statusOf[id] = Status.RELEASED;
        uint256 total = i.amount + i.fee;
        emit Released(id, relayer, total);
        ISlow(slow).withdrawFrom(address(this), to == address(0) ? relayer : to, escrowIdOf[id], total);
    }

    /// @notice Take the escrow back when nobody filled.
    /// @dev The window is short so a refund is not itself a six-day wait, which
    ///      leaves a race: a relayer that fills at the deadline can be cancelled
    ///      out from under. That race is deliberately the RELAYER's — it is the
    ///      only party that chooses whether to act, and it protects itself by
    ///      not filling close to the deadline. The sender's refund stays
    ///      unconditional, which is the property worth keeping.
    function cancel(Intent calldata i) external {
        bytes32 id = intentId(i);
        require(statusOf[id] == Status.OPEN, NotOpen());
        require(msg.sender == i.sender, NotSender());
        // `+ PROOF_GRACE`, not bare `fillDeadline`: a fill delivered inside the
        // window cannot prove itself for days, and refunding before that proof
        // can land takes the relayer's money.
        require(block.timestamp > uint256(i.fillDeadline) + PROOF_GRACE, DeadlineNotPassed());
        require(provenBy[id] == address(0), NotOpen());
        statusOf[id] = Status.CANCELLED;
        uint256 total = i.amount + i.fee;
        emit Cancelled(id, i.sender, total);
        ISlow(slow).withdrawFrom(address(this), i.sender, escrowIdOf[id], total);
    }


    // ──────────────────────────────────────────────────────────── TRANSPORT
    //
    // The proof of fill has to be sent BY this contract, because the far side
    // authenticates on `origin == address(this)`. So unlike a deposit, this one
    // cannot be composed by the page.
    //
    // Only L2 PREDEPLOYS are compiled in, and that is a different kind of
    // constant from a bridge address: `ArbSys` and the OP `L2CrossDomainMessenger`
    // sit at the same address on every chain of their family, by protocol rather
    // than by deployment. Which family we are on is not configured either — it is
    // read off which predeploy has code. The chain-SPECIFIC entrypoints are the
    // L1 ones, and those are passed in by the caller and trusted with nothing.

    /// @dev Arbitrum's system precompile. Reports one byte of code on Nitro
    ///      chains and none anywhere else, which is the whole family test.
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    /// @dev OP Stack's L2 messenger. Chosen over the raw `L2ToL1MessagePasser`
    ///      because a messenger-relayed message is REPLAYABLE if it fails on L1,
    ///      and a raw portal withdrawal is not — a proof that reverts once would
    ///      otherwise leave a relayer unpayable forever.
    address internal constant OP_MESSENGER = 0x4200000000000000000000000000000000000007;

    uint32 internal constant PROOF_GAS = 250_000;

    /// @dev How long after `fillDeadline` the sender must wait before a refund.
    ///
    ///      WITHOUT THIS THE RELAYER IS ROBBED, and no amount of relayer care
    ///      helps. `provenBy` is the only thing standing between a filled intent
    ///      and a refund, and the only writer of `provenBy` is `receiveRelay`,
    ///      reachable only through a canonical L2->L1 exit plus an L1->L2 hop:
    ///      roughly seven days on OP Stack, 6.4 on Nitro. `_checkOpen` accepts
    ///      any `fillDeadline` one second in the future. So a sender could open
    ///      with a one-hour window, let a relayer deliver real funds, and refund
    ///      the escrow an hour later while the proof was still six days out —
    ///      and then `release` would revert `NotOpen` forever.
    ///
    ///      The old note here told relayers to protect themselves by not filling
    ///      close to the deadline. That advice cannot be followed: for any
    ///      deadline shorter than the challenge period there is NO fill time
    ///      that is safe, including the first block.
    ///
    ///      Eight days clears the longer of the two challenge periods, so the
    ///      earliest possible proof always lands before the earliest possible
    ///      cancel, whenever within the window the fill happened.
    uint256 internal constant PROOF_GRACE = 8 days;

    enum Kind {
        NONE,
        OP_STACK,
        ARBITRUM
    }

    /// @notice Send "this intent was filled by X" toward the source chain.
    /// @dev Carries no value: the money never moves across, only the fact does.
    function proveFill(Intent calldata i) external {
        bytes32 id = intentId(i);
        address relayer = filledBy[id];
        require(relayer != address(0), NotFilled());
        bytes memory message = abi.encodeCall(SlowRelay.receiveRelay, (id, relayer));
        require(_sendToL1(message), NoRoute());
        emit ProofSent(id, relayer, 1);
    }

    function _sendToL1(bytes memory message) private returns (bool) {
        if (OP_MESSENGER.code.length != 0) {
            IOpMessenger(OP_MESSENGER).sendMessage(address(this), message, PROOF_GAS);
            return true;
        }
        if (ARB_SYS.code.length != 0) {
            IArbSys(ARB_SYS).sendTxToL1(address(this), message);
            return true;
        }
        return false; // already on L1
    }

    /// @notice Forward a proof from L1 onward to the chain that holds the escrow.
    /// @dev `entry` is UNTRUSTED and does not need to be anything in particular.
    ///      A wrong one cannot steal: the far side only accepts a message whose
    ///      origin is this contract's own address, arriving aliased, and no
    ///      third party can produce that. The worst a wrong entry can do is
    ///      waste the gas of whoever passed it — which is the caller's.
    function pushProof(
        bytes32 id,
        Kind kind,
        address entry,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        uint256 submissionFee
    ) external payable {
        address relayer = provenBy[id];
        // L1 can be the destination as well as the hop, in which case the fill
        // is recorded right here.
        if (relayer == address(0)) relayer = filledBy[id];
        require(relayer != address(0), NotProven());
        bytes memory message = abi.encodeCall(SlowRelay.receiveRelay, (id, relayer));

        if (kind == Kind.OP_STACK) {
            // NO VALUE ON THIS BRANCH. An OP deposit needs no ETH — the L2 gas
            // is paid by burning L1 gas in the portal — and `depositTransaction`
            // treats what it is sent as a MINT to `from`, not as postage. `from`
            // here is `applyAlias(address(this))`, the address this contract
            // relies on nobody being able to reach; anything sent lands there
            // and never comes back. The Arbitrum twin below genuinely needs
            // value, so a keeper computing one fee for both kinds would burn it
            // every time. Refuse rather than accept and destroy.
            require(msg.value == 0, BadValue());
            IOptimismPortal(entry).depositTransaction(
                address(this), 0, uint64(gasLimit), false, message
            );
        } else if (kind == Kind.ARBITRUM) {
            // REFUNDS GO TO AN ADDRESS THAT EXISTS ON THE FAR SIDE. Nitro
            // aliases a refund address when it is a contract, so naming
            // `msg.sender` sends a keeper's excess submission fee and unused
            // prepaid gas to its own L2 alias — unreachable. Callers must
            // over-provision here (a ticket that underpays is unredeemable), so
            // that refund is not dust: it is most of what was paid. `tx.origin`
            // is an EOA, holds the same address on both sides, and is not
            // aliased.
            address refundTo = msg.sender.code.length == 0 ? msg.sender : tx.origin;
            IArbInbox(entry).createRetryableTicket{value: msg.value}(
                address(this),
                0,
                submissionFee,
                refundTo,
                refundTo,
                gasLimit,
                maxFeePerGas,
                message
            );
        } else {
            revert NoRoute();
        }
        emit ProofSent(id, relayer, 0);
    }

    // ─────────────────────────────────────────────────────────── SIGNATURES

    /// @dev EOA `ecrecover`, then ERC-1271 for a smart account. A smart account
    ///      may not hold the same address on both chains, which is the one place
    ///      the same-address assumption behind `originOf` can be wrong — so a
    ///      slip from one names its signer explicitly and this checks it there.
    function _validSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            if (uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            {
                address recovered = ecrecover(digest, v, r, s);
                if (recovered != address(0) && recovered == signer) return true;
            }
        }
        (bool ok, bytes memory ret) = signer.staticcall(
            abi.encodeWithSelector(0x1626ba7e, digest, signature) // isValidSignature
        );
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(bytes4(0x1626ba7e));
    }

    // ──────────────────────────────────────────────────────────────── HOOKS

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

    receive() external payable {}
}
