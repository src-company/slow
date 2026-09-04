// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {MetadataReaderLib} from "@solady/src/utils/MetadataReaderLib.sol";

/// @title SLOW lens
/// @notice Read helper for the SLOW dapp. Turns the N+1 read the interface has
///         to do today into a single `eth_call`.
///
/// @dev DEPLOYABLE AGAINST THE EXISTING CONTRACT. This owns nothing, holds
///      nothing and changes nothing — it only calls views on a SLOW that is
///      already live, so it needs no protocol redeploy and no migration. Point
///      it at 0x0000…AaBC and it works.
///
///      What it replaces: to draw one transfer list, the dapp reads
///      `getOutboundTransfers`, then one `pendingTransfers` per id, then two
///      metadata calls per distinct token, then one `isWithdrawalApprovalNeeded`
///      per outbound transfer when a guardian is set. Forty pending transfers
///      across three tokens comes to roughly a hundred calls. Multicall3 batches
///      them into a handful of round trips; this makes it one, and returns the
///      token metadata alongside so the interface never has to ask twice.
///
///      Everything here is `view`, so gas is a courtesy rather than a cost —
///      which is exactly why the loops are allowed to be this plain.
interface ISlow {
    function getOutboundTransfers(address user) external view returns (uint256[] memory);
    function getInboundTransfers(address user) external view returns (uint256[] memory);
    function pendingTransfers(uint256 transferId)
        external
        view
        returns (uint96 timestamp, address from, address to, uint256 id, uint256 amount);
    function guardians(address user) external view returns (address);
    function pendingGuardian(address user) external view returns (address guardian, uint96 effectiveAt);
    function guardianApproved(address user, uint256 transferId) external view returns (bool);
    function predictWithdrawalId(address from, address to, uint256 id, uint256 amount)
        external
        view
        returns (uint256);
    function unlockedBalances(address user, uint256 id) external view returns (uint256);
    function decodeId(uint256 id) external pure returns (address token, uint256 delay);
}

contract SlowLens {
    /// @notice The SLOW deployment this lens reads. Immutable: a lens that can
    ///         be repointed is a lens that can lie about which contract it read.
    ISlow public immutable SLOW;

    /// @notice Everything the interface needs to draw one row.
    /// @dev `unlockAt` is precomputed because every consumer derives it, and
    ///      `token`/`delay` are unpacked because every consumer unpacks them.
    struct Transfer {
        uint256 transferId;
        uint96 timestamp;
        address from;
        address to;
        uint256 id;
        uint256 amount;
        address token;
        uint96 delay;
        uint256 unlockAt;
    }

    /// @notice One entry per distinct token in a result, so the interface does
    ///         not follow up with two calls per token.
    struct TokenInfo {
        address token;
        string symbol;
        uint8 decimals;
        bool ok;
    }

    /// @notice The guardian half of the account, in the same breath as the rest.
    struct Account {
        address guardian;
        address pendingGuardian;
        uint96 pendingEffectiveAt;
        uint256 outboundCount;
        uint256 inboundCount;
    }

    constructor(address slow) {
        SLOW = ISlow(slow);
    }

    /// @notice Both directions, the guardian state, and the metadata for every
    ///         token involved — one call, one round trip.
    /// @param user The account to read.
    /// @return account Guardian state and counts.
    /// @return outbound Live outbound transfers, stale entries dropped.
    /// @return inbound Live inbound transfers, stale entries dropped.
    /// @return tokens Metadata for each distinct token across both lists.
    function viewOf(address user)
        external
        view
        returns (Account memory account, Transfer[] memory outbound, Transfer[] memory inbound, TokenInfo[] memory tokens)
    {
        account.guardian = SLOW.guardians(user);
        (account.pendingGuardian, account.pendingEffectiveAt) = SLOW.pendingGuardian(user);

        outbound = _load(SLOW.getOutboundTransfers(user));
        inbound = _load(SLOW.getInboundTransfers(user));
        account.outboundCount = outbound.length;
        account.inboundCount = inbound.length;

        tokens = _tokens(outbound, inbound);
    }

    /// @notice Outbound only, for a caller that wants one side.
    function outboundOf(address user) external view returns (Transfer[] memory) {
        return _load(SLOW.getOutboundTransfers(user));
    }

    /// @notice Inbound only.
    function inboundOf(address user) external view returns (Transfer[] memory) {
        return _load(SLOW.getInboundTransfers(user));
    }

    /// @notice `viewOf` over a window of each list, for an account whose sets
    ///         are too large to read whole.
    /// @dev SLOW's own note on the array getters says it plainly: the inbound
    ///      set "can be expanded by anyone via dust deposits", and consumers
    ///      that iterate it can run out of gas. This lens is that consumer, and
    ///      until now it offered no way out — a griefer who plants enough dust
    ///      entries, at a delay the victim can never outlast, takes the whole
    ///      account view down permanently. The window is the escape: the caller
    ///      pages instead of asking for everything.
    ///
    ///      `outboundCount` / `inboundCount` here are the sizes of the RETURNED
    ///      windows after stale ids are dropped, not the set sizes. Use
    ///      `counts` for the raw lengths to page against.
    function viewOfAt(address user, uint256 start, uint256 count)
        external
        view
        returns (Account memory account, Transfer[] memory outbound, Transfer[] memory inbound, TokenInfo[] memory tokens)
    {
        account.guardian = SLOW.guardians(user);
        (account.pendingGuardian, account.pendingEffectiveAt) = SLOW.pendingGuardian(user);

        outbound = _loadRange(SLOW.getOutboundTransfers(user), start, count);
        inbound = _loadRange(SLOW.getInboundTransfers(user), start, count);
        account.outboundCount = outbound.length;
        account.inboundCount = inbound.length;

        tokens = _tokens(outbound, inbound);
    }

    /// @notice Outbound window.
    function outboundOfAt(address user, uint256 start, uint256 count)
        external
        view
        returns (Transfer[] memory)
    {
        return _loadRange(SLOW.getOutboundTransfers(user), start, count);
    }

    /// @notice Inbound window.
    function inboundOfAt(address user, uint256 start, uint256 count)
        external
        view
        returns (Transfer[] memory)
    {
        return _loadRange(SLOW.getInboundTransfers(user), start, count);
    }

    /// @notice Raw set lengths, so a caller knows how far to page. These are
    ///         the unfiltered lengths SLOW keeps, unlike the counts in
    ///         `Account`, which describe a returned window after stale ids are
    ///         dropped.
    function counts(address user) external view returns (uint256 outbound, uint256 inbound) {
        outbound = SLOW.getOutboundTransfers(user).length;
        inbound = SLOW.getInboundTransfers(user).length;
    }

    /// @notice Confirm, in one call, which of `candidates` this account guards.
    /// @dev SLOW maps user to guardian and not the reverse, and the GuardianSet
    ///      event sits behind an `eth_getLogs` range that public nodes decline,
    ///      so the interface keeps its own list of wards. This is what lets it
    ///      verify that list cheaply instead of one call per entry. It is a
    ///      check, not a discovery: a ward this contract never hears about
    ///      stays invisible, which is the protocol change in SlowGuardianIndex.
    function guardsOf(address guardian, address[] calldata candidates)
        external
        view
        returns (bool[] memory guarded)
    {
        guarded = new bool[](candidates.length);
        for (uint256 i; i != candidates.length; ++i) {
            guarded[i] = SLOW.guardians(candidates[i]) == guardian;
        }
    }

    /// @notice Pending transfers for a ward, with this guardian's approval state
    ///         already resolved for each.
    function wardTransfers(address ward)
        external
        view
        returns (Transfer[] memory transfers, TokenInfo[] memory tokens)
    {
        transfers = _load(SLOW.getOutboundTransfers(ward));
        tokens = _tokens(transfers, new Transfer[](0));
    }

    // ───────────────────────────────────────────────────────────── INTERNAL

    /// @dev A transfer id can outlive the entry it points at — settled, reversed
    ///      or clawed back — and those read as `timestamp == 0`. They are
    ///      dropped here so the interface never has to filter, and the array is
    ///      shortened in place rather than copied.
    function _load(uint256[] memory ids) internal view returns (Transfer[] memory out) {
        return _loadRange(ids, 0, ids.length);
    }

    /// @dev The windowed form every public read is built on. `start` past the
    ///      end returns empty and `count` is clamped to what remains, so a
    ///      caller can walk a list it cannot size in advance without ever
    ///      reverting. The clamp is computed BEFORE the add, outside
    ///      `unchecked`: `start + count` with a large count wraps, and the
    ///      wrapped value can land below `len`, which would turn "pass a big
    ///      count for the rest" into an underflowed length.
    function _loadRange(uint256[] memory ids, uint256 start, uint256 count)
        internal
        view
        returns (Transfer[] memory out)
    {
        uint256 len = ids.length;
        if (start >= len) return new Transfer[](0);
        uint256 room = len - start;
        uint256 take = count < room ? count : room;
        out = new Transfer[](take);
        uint256 n;
        for (uint256 i; i != take; ++i) {
            (Transfer memory t, bool live) = _one(ids[start + i]);
            if (live) out[n++] = t;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// @dev One transfer, in its own frame. Reading and assembling this inline
    ///      puts nine live locals plus the struct on the stack at once, which is
    ///      past what the legacy codegen can reach — and reaching for `--via-ir`
    ///      to hold a loop body together is a worse trade than a function call
    ///      in a view nobody pays for.
    function _one(uint256 tid)
        private
        view
        returns (Transfer memory t, bool live)
    {
        (uint96 ts, address from, address to, uint256 id, uint256 amount) = SLOW.pendingTransfers(tid);
        if (ts == 0) return (t, false);
        (address token, uint256 delay) = SLOW.decodeId(id);
        t.transferId = tid;
        t.timestamp = ts;
        t.from = from;
        t.to = to;
        t.id = id;
        t.amount = amount;
        t.token = token;
        t.delay = uint96(delay);
        t.unlockAt = uint256(ts) + delay;
        // NO PER-ROW GUARDIAN FLAG, deliberately. A pending transfer has no
        // outstanding guardian decision: the approval that authorised its
        // creation was consumed and deleted at `safeTransferFrom`, under
        // `_OP_TRANSFER`. Settling it needs none — `unlock` consults no
        // guardian and `_doClaim` gates on `guardians[pt.to]`, not on an
        // approval. An earlier version asked `guardianApproved(user,
        // predictWithdrawalId(user, to, id, amount))`, which is a DIFFERENT
        // operation read at the live nonce, so it was false in the normal case,
        // true by coincidence, and flipped between blocks with no change to the
        // transfer. Two external calls per outbound row for an answer that did
        // not describe the row. A caller that wants the recipient's guardian
        // should read `guardians(to)` for the one row it is rendering.
        live = true;
    }

    /// @dev Distinct tokens across both lists, with metadata read defensively:
    ///      `symbol()` predates the string ABI and MKR and friends still answer
    ///      in bytes32, which a strict decode would throw on.
    function _tokens(Transfer[] memory a, Transfer[] memory b)
        internal
        view
        returns (TokenInfo[] memory tokens)
    {
        address[] memory seen = new address[](a.length + b.length);
        uint256 n;
        for (uint256 i; i != a.length; ++i) n = _push(seen, n, a[i].token);
        for (uint256 i; i != b.length; ++i) n = _push(seen, n, b[i].token);

        tokens = new TokenInfo[](n);
        for (uint256 i; i != n; ++i) {
            address t = seen[i];
            if (t == address(0)) {
                tokens[i] = TokenInfo(t, "ETH", 18, true);
                continue;
            }
            (string memory sym, bool symOk) = _symbol(t);
            (uint8 dec, bool decOk) = _decimals(t);
            tokens[i] = TokenInfo(t, sym, dec, symOk && decOk);
        }
    }

    function _push(address[] memory seen, uint256 n, address t) private pure returns (uint256) {
        for (uint256 i; i != n; ++i) {
            if (seen[i] == t) return n;
        }
        seen[n] = t;
        unchecked {
            return n + 1;
        }
    }

    /// @dev Handles both the string and the bytes32 shapes, and never reverts.
    /// @dev BOTH PROBES GO THROUGH `MetadataReaderLib`, AND THAT IS THE POINT.
    ///      `token` is attacker-chosen: `depositTo` accepts any address as a
    ///      "token", to anyone, at a delay the recipient cannot outlast, and
    ///      nothing lets them drop the entry. So every read here is a call into
    ///      hostile code, and it has to be bounded on BOTH axes.
    ///
    ///      A gas cap alone is not enough, which is the trap the hand-rolled
    ///      version fell into. It capped the callee at 50k and still wrote the
    ///      answer into `bytes memory`, and that form copies the FULL
    ///      `returndatasize()` into this frame — memory expansion is quadratic
    ///      and it accumulates across the loop in `_tokens`. A token returning
    ///      134,400 bytes from `symbol()` fits inside a 50k budget comfortably,
    ///      so the cap bounded nothing that mattered: sixteen dust deposits
    ///      still took the account view down for good.
    ///
    ///      `MetadataReaderLib` bounds both — `min(returndatasize(), limit)` on
    ///      the copy, plus `GAS_STIPEND_NO_GRIEF` on the callee — and it is
    ///      already what `SLOWNext.uri()` uses, which is exactly why `uri()`
    ///      was never griefable while this contract was.
    function _symbol(address token) private view returns (string memory, bool) {
        // 64 bytes: longer than any real ticker, and the same clip `uri()` takes.
        string memory sym = MetadataReaderLib.readSymbol(token, 64, 50000);
        return (sym, bytes(sym).length != 0);
    }

    /// @dev `readDecimals` returns 0 for a token that does not answer, which is
    ///      indistinguishable from a real 0-decimal token — so the fallback to
    ///      18 and the `ok` flag are decided here rather than inferred by the
    ///      caller. Anything above 36 is not a decimals value.
    function _decimals(address token) private view returns (uint8, bool) {
        uint256 d = MetadataReaderLib.readDecimals(token, 50000);
        if (d == 0 || d > 36) return (18, false);
        return (uint8(d), true);
    }
}
