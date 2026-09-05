// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "@forge/Test.sol";
import {SlowBridgeRegistry} from "../src/SlowBridgeRegistry.sol";

/// @dev The registry shipped with no tests at all, which is the wrong shape for
///      the one contract here that has an owner. Nothing it can do is worth
///      money on its own — that is the design — but "cannot rug you" is a claim,
///      and a claim with no test is a comment.
contract SlowBridgeRegistryTest is Test {
    SlowBridgeRegistry internal reg;

    address internal owner = address(0x0E0E);
    address internal stranger = address(0x57A);
    address internal heir = address(0x8E14);

    bytes32 internal constant RELAY = bytes32("SlowRelay");
    bytes32 internal constant ARRIVAL = bytes32("SlowArrival");

    address internal constant PORTAL = address(0xB1DE01);
    address internal constant INBOX = address(0xB1DE02);

    function setUp() public {
        reg = new SlowBridgeRegistry(owner);
    }

    // ──────────────────────────────────────────────────────────── ROUTES

    function test_theOwnerPublishesARoute() public {
        vm.prank(owner);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);

        (address entry, SlowBridgeRegistry.Kind kind, uint64 gas, bool frozen) = reg.routes(8453);
        assertEq(entry, PORTAL);
        assertEq(uint8(kind), uint8(SlowBridgeRegistry.Kind.OP_STACK));
        assertEq(gas, 600_000);
        assertFalse(frozen);
        assertEq(reg.routeCount(), 1);
    }

    function test_aStrangerPublishesNothing() public {
        vm.prank(stranger);
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
    }

    /// @dev `NONE` is the zero value, so it has to mean "absent" and never
    ///      "registered but unusable" — otherwise an unset route reads as a
    ///      valid family.
    function test_aRouteWithNoFamilyIsRefused() public {
        vm.startPrank(owner);
        vm.expectRevert(SlowBridgeRegistry.InvalidRoute.selector);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.NONE, 600_000);
        vm.expectRevert(SlowBridgeRegistry.InvalidRoute.selector);
        reg.setRoute(8453, address(0), SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        vm.expectRevert(SlowBridgeRegistry.InvalidRoute.selector);
        reg.setRoute(0, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        vm.expectRevert(SlowBridgeRegistry.InvalidRoute.selector);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 0);
        vm.stopPrank();
    }

    /// @notice A frozen route is out of the owner's reach forever. This is the
    ///         property the whole "cannot rug you" argument rests on.
    function test_aFrozenRouteIsBeyondTheOwner() public {
        vm.startPrank(owner);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        reg.freezeRoute(8453);

        vm.expectRevert(SlowBridgeRegistry.RouteFrozen.selector);
        reg.setRoute(8453, address(0xBAD), SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        vm.expectRevert(SlowBridgeRegistry.RouteFrozen.selector);
        reg.freezeRoute(8453);
        vm.stopPrank();

        (address entry,,,) = reg.routes(8453);
        assertEq(entry, PORTAL, "and it still says what it said");
    }

    function test_aRouteThatDoesNotExistCannotBeFrozen() public {
        vm.prank(owner);
        vm.expectRevert(SlowBridgeRegistry.InvalidRoute.selector);
        reg.freezeRoute(8453);
    }

    function test_reregisteringAChainDoesNotDuplicateIt() public {
        vm.startPrank(owner);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        reg.setRoute(8453, INBOX, SlowBridgeRegistry.Kind.ARBITRUM, 800_000);
        vm.stopPrank();
        assertEq(reg.routeCount(), 1, "corrected, not appended");
        (uint256[] memory ids,) = reg.allRoutes();
        assertEq(ids.length, 1);
    }

    // ────────────────────────────────────────────────── THE ADDRESS BOOK

    function test_theBookNamesAContractPerChain() public {
        vm.startPrank(owner);
        reg.setDeployment(RELAY, 1, address(0xAAA1));
        reg.setDeployment(RELAY, 8453, address(0xAAA1));
        reg.setDeployment(ARRIVAL, 8453, address(0xBBB1));
        vm.stopPrank();

        (address at, bool frozen) = reg.deployments(RELAY, 8453);
        assertEq(at, address(0xAAA1));
        assertFalse(frozen);
        assertEq(reg.nameCount(), 2);
        assertEq(reg.chainCountFor(RELAY), 2);
        assertEq(reg.chainCountFor(ARRIVAL), 1);
    }

    function test_theWholeBookReadsInOneCall() public {
        vm.startPrank(owner);
        reg.setDeployment(RELAY, 1, address(0xAAA1));
        reg.setDeployment(RELAY, 4663, address(0xAAA2));
        reg.setDeployment(ARRIVAL, 1, address(0xBBB1));
        reg.freezeDeployment(ARRIVAL, 1);
        vm.stopPrank();

        (
            bytes32[] memory n,
            uint256[] memory ids,
            address[] memory at,
            bool[] memory frozen
        ) = reg.allDeployments();

        assertEq(n.length, 3, "every name-chain pair, flattened");
        assertEq(ids.length, 3);
        assertEq(at.length, 3);
        assertEq(frozen.length, 3);

        // Rows are parallel: row i is n[i] on ids[i].
        for (uint256 i; i != n.length; ++i) {
            (address expected, bool expectedFrozen) = reg.deployments(n[i], ids[i]);
            assertEq(at[i], expected);
            assertEq(frozen[i], expectedFrozen);
        }
    }

    function test_aStrangerPublishesNoAddressEither() public {
        vm.prank(stranger);
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.setDeployment(RELAY, 8453, address(0xAAA1));

        vm.prank(stranger);
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.freezeDeployment(RELAY, 8453);
    }

    /// @dev Zero means ABSENT. If it could be written it would mean "registered
    ///      but unusable", and a reader cannot tell those apart.
    function test_anAbsentEntryCannotBeWritten() public {
        vm.startPrank(owner);
        vm.expectRevert(SlowBridgeRegistry.InvalidDeployment.selector);
        reg.setDeployment(RELAY, 8453, address(0));
        vm.expectRevert(SlowBridgeRegistry.InvalidDeployment.selector);
        reg.setDeployment(bytes32(0), 8453, address(0xAAA1));
        vm.expectRevert(SlowBridgeRegistry.InvalidDeployment.selector);
        reg.setDeployment(RELAY, 0, address(0xAAA1));
        vm.stopPrank();
    }

    function test_aFrozenEntryIsBeyondTheOwner() public {
        vm.startPrank(owner);
        reg.setDeployment(RELAY, 8453, address(0xAAA1));
        reg.freezeDeployment(RELAY, 8453);

        vm.expectRevert(SlowBridgeRegistry.DeploymentFrozen.selector);
        reg.setDeployment(RELAY, 8453, address(0xBAD));
        vm.expectRevert(SlowBridgeRegistry.DeploymentFrozen.selector);
        reg.freezeDeployment(RELAY, 8453);
        vm.stopPrank();

        (address at,) = reg.deployments(RELAY, 8453);
        assertEq(at, address(0xAAA1));
    }

    /// @notice Freezing is per name AND per chain. Freezing one must not end the
    ///         register for a chain that has not been deployed to yet.
    function test_freezingOneChainLeavesTheOthersOpen() public {
        vm.startPrank(owner);
        reg.setDeployment(RELAY, 1, address(0xAAA1));
        reg.freezeDeployment(RELAY, 1);
        reg.setDeployment(RELAY, 8453, address(0xAAA2));
        reg.setDeployment(RELAY, 8453, address(0xAAA3)); // still correctable
        vm.stopPrank();

        (address at,) = reg.deployments(RELAY, 8453);
        assertEq(at, address(0xAAA3));
        assertEq(reg.chainCountFor(RELAY), 2, "corrected, not appended");
    }

    function test_anAbsentEntryCannotBeFrozen() public {
        vm.prank(owner);
        vm.expectRevert(SlowBridgeRegistry.InvalidDeployment.selector);
        reg.freezeDeployment(RELAY, 8453);
    }

    // ───────────────────────────────────────────────────────── OWNERSHIP

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        reg.transferOwnership(heir);
        assertEq(reg.owner(), owner, "not yet");
        assertEq(reg.pendingOwner(), heir);

        vm.prank(stranger);
        vm.expectRevert(SlowBridgeRegistry.NotPendingOwner.selector);
        reg.acceptOwnership();

        vm.prank(heir);
        reg.acceptOwnership();
        assertEq(reg.owner(), heir);
        assertEq(reg.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
    }

    /// @notice The intended end state: inert, a read-only public record with
    ///         nobody behind it.
    function test_renouncingEndsItForever() public {
        vm.startPrank(owner);
        reg.setDeployment(RELAY, 8453, address(0xAAA1));
        reg.freezeDeployment(RELAY, 8453);
        reg.renounceOwnership();
        vm.stopPrank();

        assertEq(reg.owner(), address(0));

        // And nobody inherits the vacancy — including address(0) itself, which
        // is what the `owner == address(0)` half of `onlyOwner` is there for.
        vm.prank(address(0));
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.setDeployment(RELAY, 1, address(0xBAD));

        vm.prank(stranger);
        vm.expectRevert(SlowBridgeRegistry.NotOwner.selector);
        reg.setDeployment(RELAY, 1, address(0xBAD));

        (address at,) = reg.deployments(RELAY, 8453);
        assertEq(at, address(0xAAA1), "and it still says what it said");
    }

    function test_aRenouncedRegistryStillReads() public {
        vm.startPrank(owner);
        reg.setRoute(8453, PORTAL, SlowBridgeRegistry.Kind.OP_STACK, 600_000);
        reg.setDeployment(RELAY, 8453, address(0xAAA1));
        reg.renounceOwnership();
        vm.stopPrank();

        (uint256[] memory ids, SlowBridgeRegistry.Route[] memory out) = reg.allRoutes();
        assertEq(ids[0], 8453);
        assertEq(out[0].entry, PORTAL);
        (bytes32[] memory n,,,) = reg.allDeployments();
        assertEq(n[0], RELAY);
    }
}
