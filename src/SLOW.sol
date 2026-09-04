// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Base64} from "@solady/src/utils/Base64.sol";
import {SSTORE2} from "@solady/src/utils/SSTORE2.sol";
import {ERC1155} from "@solady/src/tokens/ERC1155.sol";
import {LibString} from "@solady/src/utils/LibString.sol";
import {Multicallable} from "@solady/src/utils/Multicallable.sol";
import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {EnumerableSetLib} from "@solady/src/utils/EnumerableSetLib.sol";
import {MetadataReaderLib} from "@solady/src/utils/MetadataReaderLib.sol";
import {ReentrancyGuardTransient} from "@solady/src/utils/ReentrancyGuardTransient.sol";

import {SlowPermit} from "./SlowPermit.sol";
import {SlowGuardianIndex} from "./SlowGuardianIndex.sol";

/// @notice Timelocked token sends with optional guardian co-sign and tipped settlement.
/// @dev ERC1155 ids encode `(token, delay)`. Senders can `reverse` during the timelock
/// or `clawback` after a 30-day post-expiry grace. Recipients settle via `unlock` +
/// `withdrawFrom`, or `claim` for direct underlying payout. `depositToWithTip` posts
/// a relayer tip on the gate so any keeper can settle without recipient approval.
/// Guardian is a self-imposed co-sign mode on `safeTransferFrom` / `withdrawFrom`.
/// `multicall` is inherited from Solady's `Multicallable`, which reverts on nonzero
/// `msg.value` — payable deposits cannot be batched to drain the pool via msg.value reuse.
/// ERC-1155 deviations: `safeBatchTransferFrom` is disabled and zero-amount transfers
/// are rejected (avoids spamming the inbound/outbound sets via 0-amount delayed sends). `supportsInterface`
/// still reports ERC-1155 — treat this as ERC-1155-derived rather than fully compliant.
/// @dev NEXT BUILD. This is the v1 build with the two extensions folded in, for
///      the redeployment that puts one identical build on every chain. It is a
///      separate file so the deployed source stays byte-reproducible: compiling
///      `src/SLOWv1.sol` still yields the 21,648-byte runtime that is live on
///      mainnet today.
///
///      What is added, and nothing else:
///        SlowPermit        — signature-authorised deposits, so a wallet that
///                            cannot batch still lands one transaction.
///        SlowGuardianIndex — the reverse of `guardians`, so a guardian can be
///                            shown the accounts it guards instead of being
///                            asked to type them in.
///
/// @dev SIZE. 24,006 bytes of runtime against EIP-170's 24,576 — 570 to spare,
///      up from 21,648. The DAI-style and Permit2 entrypoints were already
///      dropped to buy that room (see `SlowPermit`), so the cheap headroom is
///      spent: anything added from here has to come out of those 570 bytes, or
///      out of something this contract currently does. Re-measure with
///      `forge build --sizes` after any change here or in the extensions — the
///      number above is a measurement, and a stale one reads as headroom that
///      is not there.
///
/// @dev STORAGE IS NOT COMPATIBLE WITH THE DEPLOYED BUILD, and does not need to
///      be. Base contracts are laid out first, so the index's two mappings take
///      slots 0 and 1 and push everything SLOW declares down by two. That is
///      harmless for a fresh deployment at a fresh address and fatal for
///      anything that tries to treat this as an upgrade — there is no proxy
///      here, and this note is why there should not be one.
contract SLOW is ERC1155, Multicallable, ReentrancyGuardTransient, SlowPermit, SlowGuardianIndex {
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;
    using MetadataReaderLib for address;
    using SafeTransferLib for address;
    using LibString for address;
    using LibString for uint256;

    event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
    event TransferApproved(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event TransferApprovalRevoked(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event GuardianChangeProposed(
        address indexed user, address indexed newGuardian, uint256 effectiveAt
    );
    event TransferPending(uint256 indexed transferId, uint256 indexed delay);
    event GuardianSet(address indexed user, address indexed guardian);
    event TransferClawedBack(uint256 indexed transferId);
    event TransferReversed(uint256 indexed transferId);
    event GuardianChangeCanceled(address indexed user);
    event TransferClaimed(uint256 indexed transferId);

    error GuardianChangeAlreadyCommittable();
    error GuardianApprovalRequired();
    error NoGuardianChangePending();
    error ClaimBlockedByGuardian();
    error GuardianChangeNotReady();
    error BatchTransferDisabled();
    error TransferDoesNotExist();
    error TimelockNotExpired();
    error ClawbackNotReady();
    error InvalidRecipient();
    error InvalidGuardian();
    error TimelockExpired();
    error InvalidDeposit();
    error InvalidAmount();
    error Unauthorized();

    struct PendingTransfer {
        uint96 timestamp;
        address from;
        address to;
        uint256 id;
        uint256 amount;
    }

    /// @dev Pending guardian rotation; packs into a single slot. `effectiveAt != 0` means in flight.
    struct PendingGuardian {
        address guardian;
        uint96 effectiveAt;
    }

    uint256 internal constant _GUARDIAN_CHANGE_DELAY = 1 days; // Veto window for guardian rotation.
    /// @dev Ceiling on a deposit's timelock, matching what the interface offers.
    ///      WITHOUT IT the delay is a full uint96, and at `type(uint96).max` the
    ///      entry is not slow, it is permanent: `unlock`, `claim` and `clawback`
    ///      all gate on `pt.timestamp + delay`, which never arrives, while
    ///      `reverse` stays with the sender.
    ///
    ///      WHAT THIS DOES NOT FIX, so that nobody reads it as fixed. Anyone can
    ///      still pin a row into a stranger's `_inboundTransfers` for the cost of
    ///      a dust deposit, and the recipient still cannot remove it: `unlock`
    ///      needs `pt.timestamp + delay` and `clawback` needs another 30 days on
    ///      top, both chosen by the sender. A hundred years is not meaningfully
    ///      shorter than forever for the account holding the row. Measured, the
    ///      array getter costs ~2,380 gas a row, so roughly 21,000 rows put
    ///      `getInboundTransfers` past a 50M `eth_call` — an afternoon's work on
    ///      a cheap chain. What the ceiling buys is that the delay stays a
    ///      duration rather than an assertion that time will not pass, and that
    ///      `pt.timestamp + delay + _CLAWBACK_GRACE` cannot be arranged to land
    ///      anywhere strange. The griefing itself is bounded by paginating the
    ///      read — `inboundTransferCount` + `inboundTransferAt`, or `SlowLens` —
    ///      never by the getter, and a caller that treats a failed
    ///      `getInboundTransfers` as an empty one will show a stuffed account
    ///      nothing at all.
    uint256 internal constant _MAX_DELAY = 3155760000; // 100 years, as the dapp offers.

    uint256 internal constant _CLAWBACK_GRACE = 30 days; // Wait after expiry before sender can clawback.

    // Op-type byte mixed into guardian-approval preimages. Distinguishes wrapper
    // transfers from raw withdrawals so a guardian approval for one cannot be
    // consumed as the other at the same `(from, to, id, amount)`.
    uint8 internal constant _OP_TRANSFER = 0;
    uint8 internal constant _OP_WITHDRAW = 1;

    /// @dev Deposits are a third op, and they need to be. They run off `nonces`
    ///      while both guarded ops now run off `guardianNonces`; two counters
    ///      sharing one op byte could put a deposit's id and a transfer's id at
    ///      the same preimage and let one overwrite the other's pending entry.
    ///      The byte keeps the two spaces disjoint however the counters line up.
    uint8 internal constant _OP_DEPOSIT = 2;

    mapping(address user => mapping(uint256 transferId => bool)) public guardianApproved;

    mapping(address user => EnumerableSetLib.Uint256Set) internal _outboundTransfers;

    mapping(address user => EnumerableSetLib.Uint256Set) internal _inboundTransfers;

    mapping(address user => mapping(uint256 id => uint256)) public unlockedBalances;

    mapping(uint256 transferId => PendingTransfer) public pendingTransfers;

    mapping(address user => uint256 timestamp) public lastGuardianChange;

    mapping(address user => PendingGuardian) public pendingGuardian;

    mapping(address user => address) public guardians;

    /// @notice Freshness counter for guardian approval preimages.
    /// @dev SEPARATE FROM `nonces` ON PURPOSE. Approvals used to be keyed on
    ///      `nonces[from]`, which `_finishDeposit` also advances — and deposits
    ///      are not guardian-gated. So the compromised key the guardian exists
    ///      to defend against could void every standing approval for 1 wei plus
    ///      gas, repeatedly, and batch ten of them per transaction through
    ///      `multicall`. The guardian survived; the rescue it existed to
    ///      authorise could never land. Worse, the victim could not escape by
    ///      removing the guardian either — that path stages a window and the
    ///      thief, still holding the key, takes the balance the moment it
    ///      clears. Only operations a guardian actually gates move this one.
    mapping(address user => uint256) public guardianNonces;

    mapping(address user => uint256) public nonces;

    /// @notice CREATE2-deployed auto-claim forwarder. Approve via
    /// `setApprovalForAll(slow.gate(), true)` to opt into keeper-driven settlement.
    address public immutable gate;

    address internal immutable htmlChunk1;
    address internal immutable htmlChunk2;

    constructor(address _htmlChunk1, address _htmlChunk2) payable {
        htmlChunk1 = _htmlChunk1;
        htmlChunk2 = _htmlChunk2;
        gate = address(new SLOWGate{salt: bytes32(0)}());
    }

    /// @notice Returns the full SLOW dapp HTML reassembled from onchain SSTORE2 chunks.
    function html() public view returns (string memory) {
        return string(bytes.concat(SSTORE2.read(htmlChunk1), SSTORE2.read(htmlChunk2)));
    }

    // METADATA

    function name() public pure returns (string memory) {
        return "SLOW";
    }

    function symbol() public pure returns (string memory) {
        return "SLOW";
    }

    function uri(uint256 id) public view override(ERC1155) returns (string memory) {
        return _createURI(id);
    }

    // VIEWERS

    /// @notice Hash matching the next guardian-gated or delayed `safeTransferFrom` by
    /// `from` at the current `nonces[from]` / `lastGuardianChange[from]`. Plain
    /// transfers (no delay, no guardian) consume no id. Use this for guardian co-sign
    /// of wrapper transfers; use `predictWithdrawalId` for raw exits, and
    /// `predictDepositId` for the entry a delayed `depositTo` creates — deposits run
    /// off `nonces` and carry `_OP_DEPOSIT`, so this function does NOT name one.
    function predictTransferId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    from, to, id, amount, guardianNonces[from], lastGuardianChange[from], _OP_TRANSFER
                )
            )
        );
    }

    /// @notice Hash matching the next delayed `depositTo` by `from`.
    /// @dev Deposits run off `nonces` and carry `_OP_DEPOSIT`, so they are NOT
    ///      predicted by `predictTransferId` — that one now answers only for the
    ///      guarded ops, which run off `guardianNonces`. Splitting the counters
    ///      is what stops a deposit voiding a guardian approval; splitting the
    ///      op byte is what stops the two id spaces overlapping. This is the
    ///      predictor for the deposit space, so an indexer or a wallet can still
    ///      name the pending entry a deposit is about to create.
    function predictDepositId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    from, to, id, amount, nonces[from], lastGuardianChange[from], _OP_DEPOSIT
                )
            )
        );
    }

    /// @notice Hash matching the next `withdrawFrom` by `from` at the current
    /// `nonces[from]` / `lastGuardianChange[from]`. The op-type byte separates
    /// withdraw approvals from transfer approvals at the same `(from, to, id, amount)`.
    function predictWithdrawalId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    from, to, id, amount, guardianNonces[from], lastGuardianChange[from], _OP_WITHDRAW
                )
            )
        );
    }

    function decodeId(uint256 id) public pure returns (address token, uint256 delay) {
        (token, delay) = (address(uint160(id)), id >> 160);
    }

    function encodeId(address token, uint96 delay) public pure returns (uint256 id) {
        id = uint256(uint160(token)) | (uint256(delay) << 160);
    }

    function canReverseTransfer(uint256 transferId)
        public
        view
        returns (bool canReverse, bytes4 reason)
    {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];

            if (pt.timestamp == 0) return (false, TransferDoesNotExist.selector);

            if (block.timestamp >= pt.timestamp + (pt.id >> 160)) {
                return (false, TimelockExpired.selector);
            }

            return (true, "");
        }
    }

    function isGuardianApprovalNeeded(address user, address to, uint256 id, uint256 amount)
        public
        view
        returns (bool needed)
    {
        return guardians[user] == address(0)
            ? false
            : !guardianApproved[
                user
            ][
                uint256(
                    keccak256(
                        abi.encodePacked(
                            user,
                            to,
                            id,
                            amount,
                            guardianNonces[user],
                            lastGuardianChange[user],
                            _OP_TRANSFER
                        )
                    )
                )
            ];
    }

    /// @notice Like `isGuardianApprovalNeeded` but for `withdrawFrom` instead of
    /// `safeTransferFrom`. Distinct preimage; a transfer approval will not satisfy this.
    function isWithdrawalApprovalNeeded(address user, address to, uint256 id, uint256 amount)
        public
        view
        returns (bool needed)
    {
        return guardians[user] == address(0)
            ? false
            : !guardianApproved[
                user
            ][
                uint256(
                    keccak256(
                        abi.encodePacked(
                            user,
                            to,
                            id,
                            amount,
                            guardianNonces[user],
                            lastGuardianChange[user],
                            _OP_WITHDRAW
                        )
                    )
                )
            ];
    }

    // PENDING TRANSFER ENUMERATION
    // EnumerableSetLib swaps with the last element on remove, so positional reads
    // (`outboundTransferAt` / `inboundTransferAt`) are not stable across settlement.
    // Indexers should snapshot via `getOutboundTransfers` / `getInboundTransfers`.
    // Both array getters are unbounded and grow with set size — `_inboundTransfers`
    // can be expanded by anyone via dust deposits. On-chain consumers that iterate
    // these getters can OOG; use `inboundTransferCount` + `inboundTransferAt(i)`
    // (or the outbound equivalents) to paginate and bound gas.

    function getOutboundTransfers(address user) public view returns (uint256[] memory) {
        return _outboundTransfers[user].values();
    }

    function getInboundTransfers(address user) public view returns (uint256[] memory) {
        return _inboundTransfers[user].values();
    }

    function outboundTransferCount(address user) public view returns (uint256) {
        return _outboundTransfers[user].length();
    }

    function inboundTransferCount(address user) public view returns (uint256) {
        return _inboundTransfers[user].length();
    }

    function outboundTransferAt(address user, uint256 index) public view returns (uint256) {
        return _outboundTransfers[user].at(index);
    }

    function inboundTransferAt(address user, uint256 index) public view returns (uint256) {
        return _inboundTransfers[user].at(index);
    }

    // GUARDIAN AUTH

    /// @notice Co-sign mode for `safeTransferFrom` / `withdrawFrom`: while
    /// `guardians[user] != 0`, every outflow needs `approveTransfer` from that address.
    /// @dev First-time set (or post-removal) is immediate. Rotating an active guardian
    /// stages `pendingGuardian` with a `_GUARDIAN_CHANGE_DELAY` veto window — user or
    /// current guardian can `cancelGuardianChange` before `effectiveAt`, and either
    /// of them can `commitGuardian` after. This protects already-wrapped balances against key
    /// compromise: a stolen key cannot remove a live guardian without the veto window.
    ///
    /// Post-window abort: once `block.timestamp >= effectiveAt`, the rotation is
    /// considered decided and only `commitGuardian` is left — neither
    /// `cancelGuardianChange` nor `setGuardian(currentGuardian)` can clear the
    /// pending entry. `commitGuardian` is restricted to `user` and the sitting
    /// guardian, and the note on it says why a third party must not have it. To abort late, propose a different guardian (this overwrites
    /// the pending entry and restarts the window), then `cancelGuardianChange`
    /// during the new window. This is intentional: the 1-day delay is the decision
    /// window, not an indefinite veto.
    function setGuardian(address newGuardian) public nonReentrant {
        // Self-guardian provides no protection: a stolen key can also `approveTransfer`.
        require(newGuardian != msg.sender, InvalidGuardian());
        if (newGuardian == guardians[msg.sender]) {
            // Re-proposing the current guardian cancels any in-flight rotation.
            // Bounded by the cancel window so post-delay only `commitGuardian` is valid.
            uint256 effectiveAt = pendingGuardian[msg.sender].effectiveAt;
            if (effectiveAt != 0 && block.timestamp < effectiveAt) {
                delete pendingGuardian[msg.sender];
                emit GuardianChangeCanceled(msg.sender);
            }
            return;
        }
        if (guardians[msg.sender] == address(0)) {
            // First-time / post-removal: immediate. Defensive pending-clear (invariant: empty here).
            delete pendingGuardian[msg.sender];
            lastGuardianChange[msg.sender] = block.timestamp;
            // Reverse index: previous is address(0) on this branch by definition.
            _indexGuardian(msg.sender, address(0), newGuardian);
            emit GuardianSet(msg.sender, guardians[msg.sender] = newGuardian);
        } else {
            // Active guardian — stage rotation. Each new proposal restarts the veto window.
            unchecked {
                uint256 effectiveAt = block.timestamp + _GUARDIAN_CHANGE_DELAY;
                pendingGuardian[msg.sender] = PendingGuardian(newGuardian, uint96(effectiveAt));
                emit GuardianChangeProposed(msg.sender, newGuardian, effectiveAt);
            }
        }
    }

    /// @notice Apply a proposed guardian change after the delay. Callable by `user`
    /// or the sitting `guardians[user]` — NOT by anyone, see the note in the body.
    /// `lastGuardianChange` updates here, invalidating any dangling approvals bound
    /// to the previous preimage.
    function commitGuardian(address user) public {
        PendingGuardian memory p = pendingGuardian[user];
        require(p.effectiveAt != 0, NoGuardianChangePending());
        require(block.timestamp >= p.effectiveAt, GuardianChangeNotReady());
        // NOT PERMISSIONLESS. The natspec above offers a late abort — propose
        // someone else, then cancel inside the new window — and a permissionless
        // commit defeats it: the guardian being installed watches the mempool,
        // front-runs that abort with this call, and is then the sitting guardian
        // with a legitimate veto over every later rotation. The user cannot even
        // name themselves (`InvalidGuardian`), so the position is permanent and
        // the balance is frozen behind a co-signer they were trying to refuse.
        // Restricting it to the two parties the change is actually between costs
        // nothing: either of them can still land it once the window has passed.
        require(msg.sender == user || msg.sender == guardians[user], Unauthorized());
        delete pendingGuardian[user];
        lastGuardianChange[user] = block.timestamp;
        // Only here, never when the rotation is PROPOSED: until it commits the
        // old guardian is still the guardian, and still the one who can veto.
        _indexGuardian(user, guardians[user], p.guardian);
        emit GuardianSet(user, guardians[user] = p.guardian);
    }

    /// @notice Veto a pending guardian change during the delay window. Callable by
    /// `user` or `guardians[user]`. After the delay only `commitGuardian` is valid.
    /// @dev Guardian-side cancel is the protection: it lets a legitimate guardian
    /// defeat a stolen key proposing `setGuardian(attacker)`. The trade-off is that
    /// a hostile guardian can veto every rotation proposal indefinitely. Appoint a
    /// guardian only if you trust them — that is what co-sign means.
    function cancelGuardianChange(address user) public {
        uint256 effectiveAt = pendingGuardian[user].effectiveAt;
        require(effectiveAt != 0, NoGuardianChangePending());
        require(block.timestamp < effectiveAt, GuardianChangeAlreadyCommittable());
        require(msg.sender == user || msg.sender == guardians[user], Unauthorized());
        delete pendingGuardian[user];
        emit GuardianChangeCanceled(user);
    }

    /// @notice Approve a precomputed transferId for `from`. Callable only by `guardians[from]`.
    /// @dev Use `predictTransferId` for transfer approvals and `predictWithdrawalId` for
    /// withdrawal approvals — the preimages differ, so approving one will not satisfy the
    /// other. `commitGuardian` bumps `lastGuardianChange` and invalidates every dangling
    /// approval. The on-chain op-split prevents cross-op consumption, not malicious
    /// approval of the wrong op — guardians must still verify intent off-chain.
    function approveTransfer(address from, uint256 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        guardianApproved[from][transferId] = true;
        emit TransferApproved(msg.sender, from, transferId);
    }

    /// @notice Retract a previously granted approval. Callable only by `guardians[from]`.
    /// @dev Undo a single mistaken approval without rotating the guardian (which would
    /// invalidate ALL approvals). Idempotent — revoking a clear slot is a no-op.
    function revokeApproval(address from, uint256 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        if (!guardianApproved[from][transferId]) return;
        delete guardianApproved[from][transferId];
        emit TransferApprovalRevoked(msg.sender, from, transferId);
    }

    // UNLOCK

    /// @notice After expiry, moves the pending transfer into `unlockedBalances[pt.to]`.
    /// The wrapper stays at `pt.to`; outbound transfers re-lock per the id's encoded delay.
    /// @dev Gated to `pt.to` or any operator approved via `setApprovalForAll`. Prevents
    /// third-party griefers from frontrunning settlement and stranding the sender's
    /// `clawback` path or the keeper's tip on `gate.claim`.
    function unlock(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(block.timestamp >= pt.timestamp + (id >> 160), TimelockNotExpired());
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            require(msg.sender == to || isApprovedForAll(to, msg.sender), Unauthorized());
            unlockedBalances[to][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit Unlocked(to, id, amount);
        }
    }

    /// @notice Auto-settle path. After expiry, burns the wrapper from `pt.to` and pays
    /// the raw underlying directly to `pt.to`. Skips the unlocked-balance step.
    /// @dev Callable by `pt.to` or any operator approved via `setApprovalForAll`.
    /// Reverts when `pt.to` has a guardian set — guardian-mode recipients settle via
    /// `unlock` + `withdrawFrom`, where the raw exit is guardian-gated.
    function claim(uint256 transferId) public nonReentrant {
        PendingTransfer memory pt = pendingTransfers[transferId];
        require(pt.timestamp != 0, TransferDoesNotExist());
        require(msg.sender == pt.to || isApprovedForAll(pt.to, msg.sender), Unauthorized());
        _doClaim(transferId, pt);
    }

    /// @notice Sender-sponsored claim path. Skips the operator-approval check;
    /// callable only by the gate, which only invokes this for transfers carrying
    /// a relayer tip posted via `depositToWithTip`. Guardian veto still applies.
    function claimTipped(uint256 transferId) public nonReentrant {
        require(msg.sender == gate, Unauthorized());
        PendingTransfer memory pt = pendingTransfers[transferId];
        require(pt.timestamp != 0, TransferDoesNotExist());
        _doClaim(transferId, pt);
    }

    /// @dev Settles `pt` and pays `pt.to`. Auth is upstream-gated by every caller
    /// (`claim` checks `msg.sender == pt.to || isApprovedForAll`; `claimTipped`
    /// checks `msg.sender == gate`). The internal `_burn(address(0), ...)` here
    /// passes the zero-address sentinel and skips Solady's `NotOwnerNorApproved`
    /// check — any future caller of this function MUST enforce its own auth.
    function _doClaim(uint256 transferId, PendingTransfer memory pt) internal {
        unchecked {
            require(block.timestamp >= pt.timestamp + (pt.id >> 160), TimelockNotExpired());
            require(guardians[pt.to] == address(0), ClaimBlockedByGuardian());

            _burn(address(0), pt.to, pt.id, pt.amount);
            _outboundTransfers[pt.from].remove(transferId);
            _inboundTransfers[pt.to].remove(transferId);
            delete pendingTransfers[transferId];

            address token = address(uint160(pt.id));
            if (token == address(0)) pt.to.safeTransferETH(pt.amount);
            else token.safeTransfer(pt.to, pt.amount);

            emit TransferClaimed(transferId);
        }
    }

    // DEPOSIT

    /// @notice Wraps `amount` of `token` (or `msg.value` for ETH) for `to` with `delay`
    /// timelock. `delay == 0` mints unlocked; otherwise creates a pending transfer.
    /// @dev Mints the wrapper at face value of the deposited amount. Assumes vanilla
    /// ERC20 semantics: fee-on-transfer, rebasing, and other nonstandard tokens will
    /// leave wrapper supply diverged from the contract's underlying reserves and may
    /// leave late withdrawers unable to exit. For rebasing assets use wstETH-style
    /// non-rebasing wrappers.
    function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
        public
        payable
        nonReentrant
        returns (uint256 transferId)
    {
        if (msg.value != 0) {
            require(token == address(0) && amount == 0, InvalidDeposit());
            amount = msg.value;
        } else {
            require(token != address(0) && amount != 0, InvalidDeposit());
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        return _finishDeposit(token, to, amount, delay, 0, data);
    }

    /// @notice Deposit with a relayer tip. Tip pays whoever lands `gate.claim`;
    /// otherwise refundable to the depositor via `gate.refundTip`.
    /// @dev `msg.value == amount + tip` for ETH or `tip` for ERC20. `delay != 0`,
    /// `tip != 0`, and `tip <= type(uint96).max` (the gate stores tips packed in a uint96).
    /// If `to` has a guardian when `claimTipped` runs, tipped settlement is blocked;
    /// the tip becomes refundable via `gate.refundTip` once the pending entry clears
    /// by any path (`unlock` by `to`, sender `reverse` during the timelock, or sender
    /// `clawback` after the 30-day grace).
    function depositToWithTip(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data
    ) public payable nonReentrant returns (uint256 transferId) {
        require(amount != 0, InvalidAmount());
        require(delay != 0, InvalidDeposit());
        require(tip != 0 && tip <= type(uint96).max, InvalidAmount());

        if (token == address(0)) {
            require(msg.value == amount + tip, InvalidDeposit());
        } else {
            require(msg.value == tip, InvalidDeposit());
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        return _finishDeposit(token, to, amount, delay, tip, data);
    }

    function _finishDeposit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data
    ) internal override returns (uint256 transferId) {
        // Bounded here rather than at each entrypoint: all four deposit paths
        // land in this function, so one check covers them and cannot drift.
        require(delay <= _MAX_DELAY, InvalidDeposit());
        // And `to`, for the same reason and now at the same price. These two
        // used to sit in `depositTo` and `depositToWithTip` and nowhere else,
        // which left the permit pair leaning on Solady's `_mint` to refuse the
        // zero address and on the receiver hook to refuse this contract. Both
        // hold, and neither is a property the entrypoint states — it is a
        // property of a dependency, asserted in a test rather than in the code.
        //
        // That trade was made when the check was priced per entrypoint at ~213
        // bytes. Made ONCE, here, where all four paths already converge, it is
        // 22 bytes CHEAPER than the two copies it replaces: 24,006 against
        // 24,028. The reason to spend the bytes is gone, so the reason to keep
        // them in two places went with it.
        require(to != address(0), InvalidRecipient());
        require(to != address(this), InvalidDeposit());
        uint256 id = encodeId(token, delay);

        unchecked {
            _mint(to, id, amount, data);

            if (delay != 0) {
                transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            msg.sender,
                            to,
                            id,
                            amount,
                            nonces[msg.sender]++,
                            lastGuardianChange[msg.sender],
                            _OP_DEPOSIT
                        )
                    )
                );

                pendingTransfers[transferId] =
                    PendingTransfer(uint96(block.timestamp), msg.sender, to, id, amount);

                _outboundTransfers[msg.sender].add(transferId);
                _inboundTransfers[to].add(transferId);

                emit TransferPending(transferId, delay);

                // `tip != 0` implies `delay != 0` (enforced by `depositToWithTip`).
                if (tip != 0) SLOWGate(gate).recordTip{value: tip}(transferId, msg.sender, to);
            } else {
                unlockedBalances[to][id] += amount;
            }
        }
    }

    // WITHDRAW

    /// @dev Caller authorization (msg.sender == from or operator-approved) is enforced by
    /// Solady's `_burn(by, from, ...)`, which reverts `NotOwnerNorApproved` on mismatch.
    /// Pre-burn state changes here roll back on that revert.
    function withdrawFrom(address from, address to, uint256 id, uint256 amount)
        public
        nonReentrant
    {
        require(to != address(0) && to != address(this) && to != gate, InvalidRecipient());
        require(amount != 0, InvalidAmount());
        unlockedBalances[from][id] -= amount;

        unchecked {
            if (guardians[from] != address(0)) {
                uint256 transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            from,
                            to,
                            id,
                            amount,
                            guardianNonces[from]++,
                            lastGuardianChange[from],
                            _OP_WITHDRAW
                        )
                    )
                );
                require(guardianApproved[from][transferId], GuardianApprovalRequired());
                delete guardianApproved[from][transferId];
            }

            _burn(msg.sender, from, id, amount);

            address token = address(uint160(id));

            if (token == address(0)) {
                to.safeTransferETH(amount);
            } else {
                token.safeTransfer(to, amount);
            }
        }
    }

    /// @dev The ERC-20 pull, exposed to `SlowPermit` so its entrypoints move
    ///      funds exactly as `depositTo` does — from `msg.sender`, which is what
    ///      keeps `pendingTransfers[id].from` the depositor rather than a router.
    function _pull(address token, address from, uint256 amount) internal override {
        token.safeTransferFrom(from, address(this), amount);
    }

    // TRANSFER

    /// @dev Caller authorization is enforced by `super.safeTransferFrom` (Solady), which
    /// reverts `NotOwnerNorApproved` unless msg.sender == from or operator-approved.
    /// Pre-call state changes roll back on that revert.
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) public override(ERC1155) nonReentrant {
        require(to != address(0) && to != address(this) && to != gate, InvalidRecipient());
        require(amount != 0, InvalidAmount());
        unlockedBalances[from][id] -= amount;

        unchecked {
            uint256 delay = id >> 160;
            address guardian = guardians[from];
            bool requiresDelayOrGuardian = guardian != address(0) || delay != 0;

            if (requiresDelayOrGuardian) {
                // One id, both roles: the guardian's approval handle and, when
                // delayed, the pending entry's key. It runs on `guardianNonces`,
                // which only guarded ops advance, so a deposit can no longer
                // void a standing approval. Deposits keep `nonces` and carry
                // `_OP_DEPOSIT`, which is what keeps the two id spaces disjoint
                // now that they no longer share a counter.
                uint256 transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            from,
                            to,
                            id,
                            amount,
                            guardianNonces[from]++,
                            lastGuardianChange[from],
                            _OP_TRANSFER
                        )
                    )
                );

                if (guardian != address(0)) {
                    require(guardianApproved[from][transferId], GuardianApprovalRequired());
                    delete guardianApproved[from][transferId];
                }

                if (delay != 0) {
                    pendingTransfers[transferId] =
                        PendingTransfer(uint96(block.timestamp), from, to, id, amount);

                    _outboundTransfers[from].add(transferId);
                    _inboundTransfers[to].add(transferId);

                    emit TransferPending(transferId, delay);
                } else {
                    unlockedBalances[to][id] += amount;
                }
            } else {
                unlockedBalances[to][id] += amount;
            }

            super.safeTransferFrom(from, to, id, amount, data);
        }
    }

    // REVERSE

    /// @notice Cancels a pending transfer before its timelock expires. Returns the wrapper
    /// to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from` or any
    /// operator approved via `setApprovalForAll`.
    /// @dev Move uses `_safeTransfer`, which calls `onERC1155Received` on `pt.from` per
    /// ERC1155 spec. Contract depositors must implement `IERC1155Receiver` to be
    /// reverse-eligible — they did not receive the 1155 at deposit (minted to `pt.to`).
    /// EOAs unaffected.
    function reverse(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(block.timestamp < pt.timestamp + (id >> 160), TimelockExpired());
            if (msg.sender != pt.from) {
                require(isApprovedForAll(pt.from, msg.sender), Unauthorized());
            }
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            unlockedBalances[from][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit TransferReversed(transferId);
            _safeTransfer(address(0), to, from, id, amount, "");
        }
    }

    // CLAWBACK

    /// @notice Sender recovery for unsettled transfers (e.g. dead/lost recipient). Returns
    /// the wrapper to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from`
    /// or any operator approved via `setApprovalForAll`.
    /// @dev Available 30 days past timelock expiry. Wrapper-route like `reverse`, so any
    /// subsequent raw exit goes through `withdrawFrom` and inherits guardian gating.
    /// `_safeTransfer` invokes `onERC1155Received` on `pt.from`; contract senders must
    /// implement `IERC1155Receiver`. Only catches transfers still pending — once `unlock`
    /// or `claim` runs, settlement to `pt.to` is final.
    function clawback(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(
                block.timestamp >= pt.timestamp + (id >> 160) + _CLAWBACK_GRACE, ClawbackNotReady()
            );
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            require(msg.sender == from || isApprovedForAll(from, msg.sender), Unauthorized());

            unlockedBalances[from][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit TransferClawedBack(transferId);
            _safeTransfer(address(0), to, from, id, amount, "");
        }
    }

    // URI HELPERS

    /// @dev Rolls up past days. The deployed build stops there, so a hundred-year
    ///      lock reads "36525 days" — correct, and not legible as a duration.
    /// @dev The largest unit that divides the delay EXACTLY.
    ///
    ///      Truncating to the largest unit that merely fits understates the
    ///      lock, and this is an immutable artefact: 23 months rendered as
    ///      "1 year" tells a holder their funds free eleven months before they
    ///      do, forever. Every round duration anyone actually chooses — ten
    ///      minutes, an hour, a day, a week, thirty days, a year — divides
    ///      exactly and reads exactly as it did. Only the awkward values change,
    ///      and they change from wrong to right: 1h30m is "90 minutes", not
    ///      "1 hour"; 23 months is "23 months", not "1 year".
    ///
    ///      Seconds divide everything, so there is always an answer.
    function _formatDelay(uint256 delay) internal pure returns (string memory) {
        unchecked {
            if (delay >= 31536000 && delay % 31536000 == 0) return _unit(delay / 31536000, "year");
            if (delay >= 2592000 && delay % 2592000 == 0) return _unit(delay / 2592000, "month");
            if (delay >= 86400 && delay % 86400 == 0) return _unit(delay / 86400, "day");
            if (delay >= 3600 && delay % 3600 == 0) return _unit(delay / 3600, "hour");
            if (delay >= 60 && delay % 60 == 0) return _unit(delay / 60, "minute");
            return _unit(delay, "second");
        }
    }

    /// @dev "1 day", "7 days". Factored out because it was written six times.
    function _unit(uint256 v, string memory w) private pure returns (string memory) {
        return string(abi.encodePacked(v.toString(), " ", w, v == 1 ? "" : "s"));
    }

    function _createURI(uint256 id) internal view returns (string memory) {
        (address token, uint256 delay) = decodeId(id);

        string memory tokenName;
        string memory tokenSymbol;
        string memory escSymbol;

        if (token != address(0)) {
            // `readName`/`readSymbol` cap at the byte length we pass and may cut mid-codepoint;
            // `_utf8Trim` keeps the JSON payload valid UTF-8 for strict marketplace parsers.
            tokenName = _utf8Trim(token.readName(64));
            tokenSymbol = _utf8Trim(token.readSymbol(16));
            escSymbol = LibString.escapeJSON(tokenSymbol);
        } else {
            // Literal symbol is JSON-safe; tokenName goes through escapeJSON below as a no-op.
            tokenName = "Ether";
            tokenSymbol = "ETH";
            escSymbol = "ETH";
        }

        string memory delayLabel = _formatDelay(delay);

        bytes memory head = abi.encodePacked(
            '{"name":"SLOW ',
            escSymbol,
            unicode" · ",
            delayLabel,
            '",',
            '"description":"Tokenized representation of a time-locked ',
            LibString.escapeJSON(tokenName),
            " (",
            escSymbol,
            ') transfer.",'
        );
        bytes memory image = abi.encodePacked(
            '"image":"', _createImage(token, delay, delayLabel, tokenName, tokenSymbol), '",'
        );
        // Token trait is suppressed for ETH (zero address has no contract);
        // mirrors the SVG which omits the address row for ETH.
        bytes memory tokenTrait = token == address(0)
            ? bytes("")
            : abi.encodePacked(
                ',{"trait_type":"Token","value":"', token.toHexStringChecksummed(), '"}'
            );
        bytes memory attrs = abi.encodePacked(
            '"attributes":[',
            '{"trait_type":"Asset","value":"',
            escSymbol,
            '"}',
            tokenTrait,
            ',{"trait_type":"Delay","value":"',
            delayLabel,
            '"},{"trait_type":"Delay (seconds)","value":',
            delay.toString(),
            ',"display_type":"number"}]}'
        );

        return string(
            abi.encodePacked(
                "data:application/json;base64,", Base64.encode(bytes.concat(head, image, attrs))
            )
        );
    }

    // Trim a trailing partial UTF-8 sequence so byte-bounded reads (`readName` /
    // `readSymbol`) and post-clip slices stay well-formed in the JSON / SVG payloads.
    function _utf8Trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        // Walk back over continuation bytes (10xxxxxx).
        while (n != 0 && (uint8(b[n - 1]) & 0xC0) == 0x80) {
            unchecked {
                --n;
            }
        }
        if (n != 0) {
            uint8 lead = uint8(b[n - 1]);
            if (lead >= 0xC0) {
                // Multi-byte sequence start; check if enough continuations followed.
                uint256 expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : 2;
                uint256 actual = b.length - (n - 1);
                if (actual >= expected) {
                    // Sequence is complete; restore the bytes we walked back.
                    n = (n - 1) + expected;
                } else {
                    // Incomplete; drop the lead.
                    unchecked {
                        --n;
                    }
                }
            }
        }
        if (n == b.length) return s;
        bytes memory out = new bytes(n);
        for (uint256 i; i != n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    // Clip to `maxBytes` for SVG display with `...` marker. Routes the slice through
    // `_utf8Trim` so a mid-codepoint cut doesn't reach the rendered SVG.
    function _clipForDisplay(string memory s, uint256 maxBytes)
        internal
        pure
        returns (string memory)
    {
        bytes memory b = bytes(s);
        if (b.length <= maxBytes) return s;
        bytes memory clipped = new bytes(maxBytes);
        for (uint256 i; i != maxBytes; ++i) {
            clipped[i] = b[i];
        }
        return string(abi.encodePacked(_utf8Trim(string(clipped)), "..."));
    }

    /// @dev Monospace has a fixed 0.6em advance, so the width of a string is
    ///      known without measuring it. That is what lets this CHOOSE a size
    ///      rather than force one: the deployed build sets
    ///      `textLength="260" lengthAdjust="spacingAndGlyphs"` on the name row,
    ///      which draws every name at exactly 260px however long it is. Measured
    ///      across the collection that is 23.6px per character for "Ether (ETH)"
    ///      and 8.4 for "Liquid staked Ether 2.0 (stETH)" — a 2.8x swing in
    ///      letterform width, driven by a name this contract does not control.
    /// @param len Character count of the string to be drawn.
    /// @param box Width in pixels it has to fit inside.
    function _fit(uint256 len, uint256 box, uint256 max, uint256 min)
        internal
        pure
        returns (uint256)
    {
        if (len == 0) return max;
        unchecked {
            uint256 size = (box * 10) / (len * 6);
            if (size > max) return max;
            if (size < min) return min;
            return size;
        }
    }

    function _createImage(
        address token,
        uint256 delay,
        string memory delayLabel,
        string memory tokenName,
        string memory tokenSymbol
    ) internal pure returns (string memory) {
        string memory escSymbol = LibString.escapeHTML(tokenSymbol);
        string memory dispName = LibString.escapeHTML(_clipForDisplay(tokenName, 28));



        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">',
            "<title>SLOW ",
            escSymbol,
            unicode" · ",
            delayLabel,
            "</title>",
            // The base plate. The supplied art's corners are continuous
            // (superelliptical), not circular: an rx rounded rect of the same
            // radius departs from it by 3.6px at this size, which is visible.
            // Coordinates are rounded to 0.1, which costs 0.03px and 56 bytes.
            // The old inset border is gone — it existed to find the edge against
            // a page, and a blue plate finds its own.
            '<path d="M0 23.7C0 15.6 0 11.5 1.5 8.4C3 5.4 5.4 3 8.4 1.5C11.5 0 15.6 0 23.7 0H276.3C284.4 0 288.5 0 291.6 1.5C294.6 3 297 5.4 298.5 8.4C300 11.5 300 15.6 300 23.7V276.3C300 284.4 300 288.5 298.5 291.6C297 294.6 294.6 297 291.6 298.5C288.5 300 284.4 300 276.3 300H23.7C15.6 300 11.5 300 8.4 298.5C5.4 297 3 294.6 1.5 291.6C0 288.5 0 284.4 0 276.3V23.7Z" fill="#0A0A0A" stroke="#fff" stroke-width="4"/>',
            // The rule needs a stated width: unstated it is 1 user unit, which at
            // 300 lands on a half-pixel and greys out at small sizes.
            '<line x1="20" y1="60" x2="280" y2="60" stroke="#fff" stroke-width="2"/>',
            '<text x="20" y="44" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#fff">SLOW</text>',
            '<g font-family="monospace" text-anchor="middle" fill="#fff">',
            '<text x="150" y="150" font-size="',
            _fit(bytes(escSymbol).length, 240, 44, 14).toString(),
            '">',
            escSymbol,
            "</text>"
        );
        bytes memory tail = abi.encodePacked(
            '<text x="150" y="185" font-size="',
            _fit(bytes(dispName).length, 250, 14, 8).toString(),
            '" fill="#8A8A8A">',
            dispName,
            '</text><text x="150" y="240" font-size="',
            _fit(bytes(delayLabel).length, 250, 22, 11).toString(),
            '">',
            delayLabel,
            "</text>",
            "</g></svg>"
        );

        return string(
            abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes.concat(svg, tail)))
        );
    }

    // BATCH (DISABLED)

    function safeBatchTransferFrom(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) public pure override(ERC1155) {
        revert BatchTransferDisabled();
    }
}

/// @notice `claim`-only operator for keeper-driven settlement. Approve via
/// `setApprovalForAll(slow.gate(), true)`. Cannot redirect funds: the gate has
/// no path to `safeTransferFrom` or `withdrawFrom`, and `claim` pins payout to `pt.to`.
/// Holds optional per-transfer relayer tips posted via `SLOW.depositToWithTip`.
contract SLOWGate {
    using SafeTransferLib for address;

    SLOW public immutable slow = SLOW(msg.sender);

    struct Tip {
        uint96 amount;
        address sender;
    }

    mapping(uint256 transferId => Tip) public tips;

    event TipPosted(
        uint256 indexed transferId, uint96 amount, address indexed sender, address indexed to
    );
    event TipRefunded(uint256 indexed transferId, uint96 amount, address indexed to);
    event TipPaid(uint256 indexed transferId, uint96 amount, address indexed to);

    error TipStillPending();
    error InvalidAmount();
    error Unauthorized();
    error NoTip();

    constructor() payable {}

    function recordTip(uint256 transferId, address sender, address to) public payable {
        require(msg.sender == address(slow), Unauthorized());
        // Defense-in-depth: SLOW.depositToWithTip already enforces `tip <= type(uint96).max`,
        // but the truncating cast below would silently lose value if a future caller skipped that.
        require(msg.value <= type(uint96).max, InvalidAmount());
        tips[transferId] = Tip(uint96(msg.value), sender);
        emit TipPosted(transferId, uint96(msg.value), sender, to);
    }

    /// @notice Settle one transfer through the gate. If a tip is attached, pays it
    /// to `msg.sender` and routes through `slow.claimTipped` (no recipient approval
    /// required); otherwise routes through `slow.claim`, which requires `pt.to` to
    /// have approved the gate via `setApprovalForAll`.
    function claim(uint256 transferId) public {
        _claimAndPay(transferId, msg.sender);
    }

    /// @notice One id, on behalf of `payee`. Callable only by this contract.
    /// @dev The isolation primitive `claimMany` needs: a `try` needs an external
    ///      call, an external call rewrites `msg.sender`, and the tip has to
    ///      keep going to the keeper who submitted the batch.
    function claimOne(uint256 transferId, address payee) public {
        require(msg.sender == address(this), Unauthorized());
        _claimAndPay(transferId, payee);
    }

    /// @notice Atomic batch settlement; the whole call reverts on the first failure.
    /// Keepers must filter ids off-chain (timelock-expired, no guardian on `pt.to`).
    function claimMany(uint256[] calldata transferIds) public {
        for (uint256 i; i != transferIds.length; ++i) {
            // PER-ID ISOLATION, because the failure is not hypothetical. Every
            // id in the batch belongs to a recipient who may `unlock` it at any
            // moment, and that is ordinary, honest behaviour — not an attack.
            // Settled ids make `claimTipped` revert `TransferDoesNotExist`, and
            // with a bare loop that one revert took the whole batch with it: a
            // 20-id batch cost the keeper 1,375,690 gas and one 77,602-gas
            // `unlock` destroyed it, ~18x leverage that scales with batch size.
            // Filtering off-chain, which the note above prescribes, cannot fix
            // it — the kill is a front-run, so no pre-flight read can see it.
            try this.claimOne(transferIds[i], msg.sender) {} catch {}
        }
    }

    /// @notice Recover an unclaimed tip after the underlying transfer cleared via a
    /// non-gate path (`unlock`, `reverse`, `clawback`, or recipient-direct `claim`).
    /// Callable only by the original depositor; reverts while the transfer is still pending.
    function refundTip(uint256 transferId) public {
        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        require(ts == 0, TipStillPending());
        Tip memory t = tips[transferId];
        require(t.amount != 0, NoTip());
        require(msg.sender == t.sender, Unauthorized());
        delete tips[transferId];
        msg.sender.safeTransferETH(t.amount);
        emit TipRefunded(transferId, t.amount, msg.sender);
    }

    /// @dev `payee` is threaded rather than read from `msg.sender`, because
    ///      `claimMany` reaches this through a `this.` self-call to isolate a
    ///      failing id — and inside that call `msg.sender` is the gate, not the
    ///      keeper. Reading it there would pay every tip to this contract.
    function _claimAndPay(uint256 transferId, address payee) internal {
        Tip memory t = tips[transferId];
        if (t.amount != 0) {
            delete tips[transferId];
            slow.claimTipped(transferId);
            payee.safeTransferETH(t.amount);
            emit TipPaid(transferId, t.amount, payee);
        } else {
            slow.claim(transferId);
        }
    }
}
