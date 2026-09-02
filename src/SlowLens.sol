// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

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
        bool guardianApproved;
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

        outbound = _load(user, SLOW.getOutboundTransfers(user), true);
        inbound = _load(user, SLOW.getInboundTransfers(user), false);
        account.outboundCount = outbound.length;
        account.inboundCount = inbound.length;

        tokens = _tokens(outbound, inbound);
    }

    /// @notice Outbound only, for a caller that wants one side.
    function outboundOf(address user) external view returns (Transfer[] memory) {
        return _load(user, SLOW.getOutboundTransfers(user), true);
    }

    /// @notice Inbound only.
    function inboundOf(address user) external view returns (Transfer[] memory) {
        return _load(user, SLOW.getInboundTransfers(user), false);
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
        transfers = _load(ward, SLOW.getOutboundTransfers(ward), true);
        tokens = _tokens(transfers, new Transfer[](0));
    }

    // ───────────────────────────────────────────────────────────── INTERNAL

    /// @dev A transfer id can outlive the entry it points at — settled, reversed
    ///      or clawed back — and those read as `timestamp == 0`. They are
    ///      dropped here so the interface never has to filter, and the array is
    ///      shortened in place rather than copied.
    function _load(address user, uint256[] memory ids, bool outbound)
        internal
        view
        returns (Transfer[] memory out)
    {
        out = new Transfer[](ids.length);
        uint256 n;
        for (uint256 i; i != ids.length; ++i) {
            (Transfer memory t, bool live) = _one(user, ids[i], outbound);
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
    function _one(address user, uint256 tid, bool outbound)
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
        // Only meaningful on the sender's own side; an inbound transfer is gated
        // by the RECIPIENT's guardian at withdrawal, not here.
        t.guardianApproved = outbound && SLOW.guardianApproved(user, tid);
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
    function _symbol(address token) private view returns (string memory, bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x95d89b41));
        if (!ok || ret.length == 0) return ("", false);
        if (ret.length == 32) {
            // bytes32: trim the trailing zero padding.
            bytes32 raw = abi.decode(ret, (bytes32));
            uint256 len;
            while (len < 32 && raw[len] != 0) ++len;
            bytes memory s = new bytes(len);
            for (uint256 i; i != len; ++i) s[i] = raw[i];
            return (string(s), len != 0);
        }
        if (ret.length < 64) return ("", false);
        return (abi.decode(ret, (string)), true);
    }

    function _decimals(address token) private view returns (uint8, bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x313ce567));
        if (!ok || ret.length < 32) return (18, false);
        uint256 d = abi.decode(ret, (uint256));
        if (d > 36) return (18, false);
        return (uint8(d), true);
    }
}
