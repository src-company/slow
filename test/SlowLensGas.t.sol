// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {SLOWv1} from "../src/SLOWv1.sol";
import {SlowLens} from "../src/SlowLens.sol";
import {Test} from "../lib/forge-std/src/Test.sol";

/// @notice The lens's pagination has to be CHEAPER than the read it escapes,
///         and for a while it was not.
///
/// @dev THE BUG THIS PINS. `viewOfAt`, `inboundOfAt`, `outboundOfAt` and
///      `counts` were added so an account whose inbound set had been stuffed
///      with dust rows could still be read a window at a time. Every one of
///      them began with `SLOW.getInboundTransfers(user)` and then sliced the
///      result in memory — so returning ONE row cost the whole set, and
///      `counts`, which exists so a caller knows how far to page, materialised
///      the entire array to learn a number SLOW keeps in a storage slot.
///
///      `SlowLens.t.sol` tested the window's SEMANTICS — offsets, clamping,
///      short last pages — and every one of those tests passed against the
///      broken version, because the semantics were never wrong. Only the cost
///      was, and nothing measured it. That is why this file exists separately:
///      the property is a gas bound, and a gas bound has to be asserted as one.
///
/// @dev WHY IT RUNS AGAINST `SLOWv1`. The lens's own natspec promises it is
///      "deployable against the existing contract" — point it at 0x0000…AaBC
///      and it works. `outboundTransferCount` / `inboundTransferAt` are the
///      functions the fix depends on, so the test that they are reachable on
///      the LIVE build is worth more than one against the build that ships.
///      Both carry them; only one of them is already holding funds.
contract SlowLensGasTest is Test {
    SLOWv1 internal slow;
    SlowLens internal lens;

    address internal victim = address(0x71C);
    address internal attacker = address(0xA77E);

    /// @dev Enough rows to make the difference unambiguous without making the
    ///      test slow. The stuffing attack is bounded only by the griefer's
    ///      gas, so the real numbers are larger and the ratio is worse.
    uint256 internal constant ROWS = 2000;

    function setUp() public {
        slow = new SLOWv1(address(0), address(0));
        lens = new SlowLens(address(slow));
        vm.deal(attacker, 100 ether);

        // A dust deposit at the maximum delay: the row is in the victim's
        // inbound set and the victim cannot outlast it. Exactly the shape
        // SLOW's own note on the array getters describes.
        address token = address(new Tok());
        for (uint256 i; i != ROWS; ++i) {
            vm.prank(attacker);
            slow.depositTo(token, victim, 1, 3155760000, "");
        }
    }

    /// The paging primitive must not cost more than the thing it is paging.
    function testCountsIsCountedNotMeasured() public view {
        uint256 g = gasleft();
        lens.counts(victim);
        uint256 lensCost = g - gasleft();

        g = gasleft();
        slow.getInboundTransfers(victim);
        uint256 wholeSet = g - gasleft();

        // The old form WAS the whole-set read plus an ABI decode. A constant
        // multiple of the slot read is the only acceptable shape here, so the
        // bound is absolute rather than relative to a set size that grows.
        assertLt(lensCost, 50_000, "counts must read two storage slots, not two arrays");
        assertLt(lensCost * 20, wholeSet, "and be nowhere near the read it exists to replace");
    }

    /// One row must cost one row, not the whole set.
    function testOneRowWindowDoesNotPayForTheWholeSet() public view {
        uint256 g = gasleft();
        lens.inboundOfAt(victim, 0, 1);
        uint256 oneRow = g - gasleft();

        g = gasleft();
        slow.getInboundTransfers(victim);
        uint256 wholeSet = g - gasleft();

        // Before the fix this ratio was 0.998. A row carries a
        // `pendingTransfers` read and a `decodeId`, so it is not free — but it
        // must not scale with the set.
        assertLt(oneRow * 20, wholeSet, "a one-row window must not cost the whole set");
    }

    /// And the window must stay flat as the set grows, which is the property
    /// that actually makes it an escape hatch rather than a slower failure.
    function testWindowCostDoesNotGrowWithTheSet() public {
        uint256 g = gasleft();
        lens.inboundOfAt(victim, 0, 5);
        uint256 small = g - gasleft();

        address token = address(new Tok());
        for (uint256 i; i != ROWS; ++i) {
            vm.prank(attacker);
            slow.depositTo(token, victim, 1, 3155760000, "");
        }

        g = gasleft();
        lens.inboundOfAt(victim, 0, 5);
        uint256 large = g - gasleft();

        // Doubling the set must not move a five-row window by more than the
        // noise of one extra cold slot.
        assertLt(large, small + 5_000, "the window is not indexed if it grows with the set");
    }

    /// The whole-set reads are still allowed to be expensive — `viewOf`
    /// promises everything and cannot keep that promise cheaply. This pins that
    /// the fix did not silently change what `viewOf` returns.
    function testWindowAgreesWithTheWholeReadOnASmallAccount() public {
        SLOWv1 fresh = new SLOWv1(address(0), address(0));
        SlowLens l = new SlowLens(address(fresh));
        address who = address(0xB0B);
        address token = address(new Tok());
        for (uint256 i; i != 4; ++i) {
            vm.prank(attacker);
            fresh.depositTo(token, who, 1, 1 days, "");
        }

        SlowLens.Transfer[] memory whole = l.inboundOf(who);
        SlowLens.Transfer[] memory window = l.inboundOfAt(who, 0, type(uint256).max);
        assertEq(window.length, whole.length, "same rows");
        for (uint256 i; i != whole.length; ++i) {
            assertEq(window[i].transferId, whole[i].transferId, "in the same order");
        }
    }
}

/// @dev Enough of an ERC-20 for `safeTransferFrom` to accept it.
contract Tok {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }

    function symbol() external pure returns (string memory) {
        return "GOOD";
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }
}
