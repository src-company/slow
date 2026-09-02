// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SLOW guardian index
/// @notice The reverse of `guardians`: which accounts has this address been made
///         guardian of.
///
/// @dev THIS IS THE ONE THING A LENS CANNOT FIX. `SlowLens` collapses every
///      other read the interface does into a single call, because all of it is
///      derivable from state that already exists. This is not: SLOW stores
///      `user => guardian` and nothing walks it backwards.
///
///      The information is not absent, only unreachable. `GuardianSet` indexes
///      both sides, so a node with archive logs can answer it — but the public
///      endpoints a bytecode-served page must run on decline the range outright
///      ("Archive requests require a personal token"). A dapp that cannot
///      depend on `eth_getLogs` therefore cannot discover wards at all, which
///      is why the interface asks you to name them and verifies each against
///      `guardians(ward)`.
///
///      Maintaining the reverse index costs the guardian setter two SSTOREs on
///      a change nobody makes often, and turns "type in every account you
///      guard" into "here they are".
///
/// @dev WIRING. Every place SLOW assigns `guardians[user]` calls
///      `_indexGuardian(user, previous, next)` in the same breath. In the
///      current contract that is three sites:
///
///        setGuardian        — the immediate first-time path
///        commitGuardian     — where a staged rotation lands
///        (removal)          — a rotation to address(0), same path as above
///
///      A staged rotation must NOT touch the index when it is proposed, only
///      when it commits: until then the old guardian is still the guardian and
///      still the one who can veto.
abstract contract SlowGuardianIndex {
    /// @dev Wards per guardian, and a 1-based position so that 0 reads as
    ///      absent. Both are written only from `_indexGuardian`.
    mapping(address guardian => address[]) private _wards;
    mapping(address guardian => mapping(address ward => uint256)) private _wardAt;

    event WardAdded(address indexed guardian, address indexed ward);
    event WardRemoved(address indexed guardian, address indexed ward);

    /// @notice Every account that has named `guardian` as its guardian.
    /// @dev Unbounded, and deliberately so: it is a view, and a guardian with
    ///      enough wards to exhaust an `eth_call` has a problem this function is
    ///      not the right place to solve. `wardsAt` paginates for that case.
    function wardsOf(address guardian) external view returns (address[] memory) {
        return _wards[guardian];
    }

    /// @notice How many accounts `guardian` guards.
    function wardCount(address guardian) external view returns (uint256) {
        return _wards[guardian].length;
    }

    /// @notice A window into the ward list, for a guardian with many.
    /// @param start First index to return.
    /// @param count How many to return; the result is truncated at the end.
    function wardsAt(address guardian, uint256 start, uint256 count)
        external
        view
        returns (address[] memory page)
    {
        address[] storage all = _wards[guardian];
        uint256 len = all.length;
        if (start >= len) return new address[](0);
        unchecked {
            uint256 end = start + count;
            if (end > len) end = len;
            page = new address[](end - start);
            for (uint256 i; i != page.length; ++i) {
                page[i] = all[start + i];
            }
        }
    }

    /// @notice Whether `guardian` currently guards `ward`.
    /// @dev O(1). The interface uses this to check one address before adding it.
    function guards(address guardian, address ward) external view returns (bool) {
        return _wardAt[guardian][ward] != 0;
    }

    /// @dev Move `user` from one guardian's list to another's. Call this
    ///      wherever `guardians[user]` is assigned, with the value it held
    ///      before and the value it is taking. Either side may be zero, and a
    ///      no-op change costs nothing.
    function _indexGuardian(address user, address previous, address next) internal {
        if (previous == next) return;
        if (previous != address(0)) _removeWard(previous, user);
        if (next != address(0)) _addWard(next, user);
    }

    function _addWard(address guardian, address ward) private {
        mapping(address => uint256) storage at = _wardAt[guardian];
        if (at[ward] != 0) return;
        _wards[guardian].push(ward);
        at[ward] = _wards[guardian].length; // 1-based
        emit WardAdded(guardian, ward);
    }

    /// @dev Swap-and-pop, so removal is O(1) and does not leave a hole. Order is
    ///      not meaningful here — the list is a set that happens to be an array.
    function _removeWard(address guardian, address ward) private {
        mapping(address => uint256) storage at = _wardAt[guardian];
        uint256 pos = at[ward];
        if (pos == 0) return;
        address[] storage list = _wards[guardian];
        unchecked {
            uint256 last = list.length - 1;
            uint256 idx = pos - 1;
            if (idx != last) {
                address moved = list[last];
                list[idx] = moved;
                at[moved] = pos;
            }
            list.pop();
        }
        delete at[ward];
        emit WardRemoved(guardian, ward);
    }
}
