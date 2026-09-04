// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {SLOWNext} from "../src/SLOWNext.sol";
import {SlowLens} from "../src/SlowLens.sol";
import {Test} from "../lib/forge-std/src/Test.sol";

/// @notice Regressions for the lens denial-of-service found in the 2026-09-04
///         review, and for the pagination that bounds it.
///
/// @dev THE SHAPE OF THE BUG, because it is easy to re-introduce. `viewOf` asks
///      every distinct token in an account's lists for its symbol and decimals.
///      Those tokens are not the account's choice: `depositTo` lets anyone plant
///      any address in a stranger's inbound list, and nothing lets the stranger
///      remove it. So every metadata read is a call into hostile code inside an
///      unbounded loop, and it has to be bounded on both axes — the callee's gas
///      AND the bytes it can make this contract copy back.
///
///      The first version capped only gas, on one of the two probes. The second
///      capped gas on both, which measurably did not help: returning 134 kB from
///      `symbol()` costs the callee almost nothing and charges the CALLER
///      quadratic memory expansion, cumulatively, across the loop.
contract SlowLensTest is Test {
    SLOWNext internal slow;
    SlowLens internal lens;

    address internal victim = address(0x71C);
    address internal attacker = address(0xA77E);

    function setUp() public {
        slow = new SLOWNext(address(0), address(0));
        lens = new SlowLens(address(slow));
        vm.deal(attacker, 100 ether);
        vm.deal(victim, 100 ether);
    }

    function _plant(address token, uint96 delay) internal {
        vm.prank(attacker);
        slow.depositTo(token, victim, 1, delay, "");
    }

    /// A token that burns everything it is given. Uncapped, this alone took the
    /// account view down permanently.
    function testGasBombsCannotBrickTheView() public {
        for (uint256 i; i != 4; ++i) _plant(address(new GasBomb()), 1 days);

        (, , SlowLens.Transfer[] memory inbound, SlowLens.TokenInfo[] memory tokens) =
            lens.viewOf{gas: 30_000_000}(victim);

        assertEq(inbound.length, 4, "rows must still load");
        assertEq(tokens.length, 4, "tokens must still resolve");
        for (uint256 i; i != tokens.length; ++i) {
            assertFalse(tokens[i].ok, "a bomb must degrade to ok == false");
            assertEq(tokens[i].decimals, 18, "and fall back to 18");
        }
    }

    /// The one a gas cap does not catch: cheap to produce, expensive to receive.
    /// Sixteen of these defeated the capped version.
    function testReturndataBombsCannotBrickTheView() public {
        for (uint256 i; i != 20; ++i) _plant(address(new ReturndataBomb()), 1 days);

        (, , SlowLens.Transfer[] memory inbound, SlowLens.TokenInfo[] memory tokens) =
            lens.viewOf{gas: 30_000_000}(victim);

        assertEq(inbound.length, 20, "rows must still load");
        assertEq(tokens.length, 20, "tokens must still resolve");
    }

    /// Cost must stay roughly linear in the number of hostile tokens. The bug
    /// was quadratic, which is what let twenty entries exhaust any budget.
    function testHostileMetadataCostStaysBounded() public {
        for (uint256 i; i != 10; ++i) _plant(address(new ReturndataBomb()), 1 days);
        uint256 g0 = gasleft();
        lens.viewOf{gas: 30_000_000}(victim);
        uint256 ten = g0 - gasleft();

        for (uint256 i; i != 10; ++i) _plant(address(new ReturndataBomb()), 1 days);
        g0 = gasleft();
        lens.viewOf{gas: 30_000_000}(victim);
        uint256 twenty = g0 - gasleft();

        // Quadratic would be ~4x. Allow generous headroom and still catch it.
        assertLt(twenty, ten * 3, "metadata cost must not grow quadratically");
    }

    /// Honest metadata still reads correctly — the fix must not blind the lens.
    function testGoodTokenMetadataStillReads() public {
        GoodToken g = new GoodToken();
        _plant(address(g), 1 days);

        (, , , SlowLens.TokenInfo[] memory tokens) = lens.viewOf(victim);
        assertEq(tokens.length, 1);
        assertTrue(tokens[0].ok, "a real token must resolve");
        assertEq(tokens[0].symbol, "GOOD");
        assertEq(tokens[0].decimals, 6);
    }

    /// ETH keeps its synthetic entry rather than being probed.
    function testEthNeedsNoProbe() public {
        vm.prank(attacker);
        slow.depositTo{value: 1 ether}(address(0), victim, 0, 1 days, "");

        (, , , SlowLens.TokenInfo[] memory tokens) = lens.viewOf(victim);
        assertEq(tokens.length, 1);
        assertTrue(tokens[0].ok);
        assertEq(tokens[0].symbol, "ETH");
        assertEq(tokens[0].decimals, 18);
    }

    // ─────────────────────────────────────────────────────── pagination

    /// The escape hatch the lens did not have. An account whose set has been
    /// inflated must still be readable a window at a time.
    function testPaginationWindowsTheLists() public {
        for (uint256 i; i != 7; ++i) _plant(address(new GoodToken()), 1 days);

        (uint256 outCount, uint256 inCount) = lens.counts(victim);
        assertEq(inCount, 7, "raw set length");
        assertEq(outCount, 0);

        assertEq(lens.inboundOfAt(victim, 0, 3).length, 3);
        assertEq(lens.inboundOfAt(victim, 3, 3).length, 3);
        assertEq(lens.inboundOfAt(victim, 6, 3).length, 1, "last window is short");
    }

    /// The clamp has to survive `start + count` wrapping, which is why it is
    /// computed before the add and outside `unchecked`.
    function testPaginationClampsWithoutOverflow() public {
        for (uint256 i; i != 3; ++i) _plant(address(new GoodToken()), 1 days);

        assertEq(lens.inboundOfAt(victim, 0, type(uint256).max).length, 3, "big count = the rest");
        assertEq(lens.inboundOfAt(victim, 1, type(uint256).max).length, 2);
        assertEq(lens.inboundOfAt(victim, 3, 10).length, 0, "start at the end is empty");
        assertEq(lens.inboundOfAt(victim, 99, type(uint256).max).length, 0, "start past the end too");
    }

    function testPaginatedViewMatchesTheWholeRead() public {
        for (uint256 i; i != 4; ++i) _plant(address(new GoodToken()), 1 days);

        (, , SlowLens.Transfer[] memory whole,) = lens.viewOf(victim);
        (, , SlowLens.Transfer[] memory window,) = lens.viewOfAt(victim, 0, 4);
        assertEq(window.length, whole.length);
        for (uint256 i; i != whole.length; ++i) {
            assertEq(window[i].transferId, whole[i].transferId);
        }
    }
}

// ───────────────────────────────────────────────────────────── fixtures

/// @dev Enough of an ERC-20 for `safeTransferFrom` to accept it: real code, and
///      a `transferFrom` that returns true without moving anything.
contract TokenBase {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @dev Burns every unit of gas it is handed, from both probes.
contract GasBomb is TokenBase {
    function symbol() external pure returns (string memory) {
        while (true) {}
        return "";
    }

    function decimals() external pure returns (uint8) {
        while (true) {}
        return 0;
    }
}

/// @dev Cheap to run, expensive to receive: returns ~134 kB, which fits inside a
///      50,000-gas stipend and used to charge the caller quadratic memory growth.
contract ReturndataBomb is TokenBase {
    fallback() external {
        assembly {
            return(0, 134400)
        }
    }
}

contract GoodToken is TokenBase {
    function symbol() external pure returns (string memory) {
        return "GOOD";
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }
}
