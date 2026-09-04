// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {SlowArrival} from "../src/SlowArrival.sol";

/// @notice `forward` against the REAL Base portal and the REAL Robinhood inbox.
///
/// @dev WHY THIS FILE HAD TO EXIST. Everything else that tests `forward` tests
///      it against mocks written in the same sitting as the code, from the same
///      reading of the same docs. A mock cannot disagree with the encoding it
///      was written to match, so it cannot catch a wrong selector, a transposed
///      parameter, a fee function that is named something else, or an
///      entrypoint that rejects the shape entirely. Only the deployed contract
///      can, and the value moving through this path is unrecoverable if it is
///      wrong.
///
/// @dev Skipped rather than failed when no RPC is reachable.
contract ArrivalForwardForkTest is Test {
    /// @dev Live on mainnet, and what `SlowArrival`'s constructor insists on.
    address internal constant SLOW_MAINNET = 0x000000000000888741B254d37e1b27128AfEAaBC;

    /// @dev Base's OptimismPortal and Robinhood's Delayed Inbox, both on L1 —
    ///      the same two the page already builds its own deposits against.
    address internal constant BASE_PORTAL = 0x49048044D57e1C92A77f79988d21Fa8fAF74E97e;
    address internal constant ROBINHOOD_INBOX = 0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint96 internal constant DELAY = 3 days;
    uint256 internal constant AMOUNT = 1 ether;
    uint64 internal constant FWD_GAS = 1_000_000;
    uint128 internal constant FWD_FEE = 1 gwei;

    SlowArrival internal arrival;
    bool internal live;

    function setUp() public {
        try vm.createSelectFork("https://ethereum-rpc.publicnode.com") {
            live = block.chainid == 1;
        } catch {
            live = false;
        }
        if (!live) return;

        uint256[] memory ids = new uint256[](2);
        SlowArrival.Route[] memory routes = new SlowArrival.Route[](2);
        ids[0] = 8453;
        routes[0] = SlowArrival.Route(BASE_PORTAL, 1, FWD_GAS, FWD_FEE);
        ids[1] = 4663;
        routes[1] = SlowArrival.Route(ROBINHOOD_INBOX, 2, FWD_GAS, FWD_FEE);
        arrival = new SlowArrival(SLOW_MAINNET, ids, routes);
    }

    /// @notice The real OP portal accepts the deposit `forward` builds, and the
    ///         value actually leaves this contract for it.
    function test_theRealBasePortalAcceptsTheForward() public {
        if (!live) return;
        uint256 portalBefore = BASE_PORTAL.balance;
        // NOT `== 0`. This contract is deployed at a CREATE address derived from
        // the test's own nonce, and on a mainnet fork that address can already
        // hold ETH — it does, 0.000577. A deploy inherits it. The question is
        // whether the forward left anything of its OWN behind, so the balance is
        // measured as a delta.
        uint256 selfBefore = address(arrival).balance;

        vm.deal(alice, AMOUNT * 2);
        vm.prank(alice, alice);
        (bool ok,) = address(arrival).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.forward, (8453, bob, DELAY, alice, uint256(0)))
        );
        assertTrue(ok, "forward must not revert");

        assertEq(
            BASE_PORTAL.balance - portalBefore, AMOUNT, "the payload reached the real portal"
        );
        assertEq(address(arrival).balance, selfBefore, "nothing of the payload was left behind");
        assertEq(arrival.rescue(alice), 0, "and nothing fell into rescue");
    }

    /// @notice The real Robinhood inbox accepts the retryable, priced against
    ///         its own live `calculateRetryableSubmissionFee`.
    function test_theRealRobinhoodInboxAcceptsTheForward() public {
        if (!live) return;
        uint256 bridgeBefore = ROBINHOOD_INBOX.balance;
        uint256 selfBefore = address(arrival).balance;

        vm.deal(alice, AMOUNT * 2);
        vm.prank(alice, alice);
        (bool ok,) = address(arrival).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.forward, (4663, bob, DELAY, alice, uint256(0)))
        );
        assertTrue(ok, "forward must not revert");

        assertEq(address(arrival).balance, selfBefore, "nothing of the payload was left behind");
        assertEq(arrival.rescue(alice), 0, "and nothing fell into rescue");
        // The inbox forwards the ETH straight on to the Bridge, so its own
        // balance is not where the money lands; what matters is that the call
        // was accepted and this contract is empty.
        console2.log("inbox balance delta", ROBINHOOD_INBOX.balance - bridgeBefore);
    }

    /// @notice The fee function this depends on is real, is named what the
    ///         interface says, and returns something usable.
    function test_theSubmissionFeeFunctionIsTheOneWeThinkItIs() public {
        if (!live) return;
        (bool ok, bytes memory ret) = ROBINHOOD_INBOX.staticcall(
            abi.encodeWithSignature(
                "calculateRetryableSubmissionFee(uint256,uint256)", uint256(324), uint256(2 gwei)
            )
        );
        assertTrue(ok, "the real inbox answers it");
        assertEq(ret.length, 32);
        uint256 fee = abi.decode(ret, (uint256));
        assertGt(fee, 0, "and prices a ticket");
        console2.log("submission fee for 324 bytes at 2 gwei", fee);
    }

    /// @notice A payload too small to cover the real fees is refused rather than
    ///         handed to the bridge — checked against live pricing, not a mock's.
    function test_aDustPayloadIsRefusedAgainstRealFees() public {
        if (!live) return;
        uint256 dust = 1000 wei; // far below submission + prepaid gas
        vm.deal(alice, 1 ether);
        vm.prank(alice, alice);
        (bool ok,) = address(arrival).call{value: dust}(
            abi.encodeCall(SlowArrival.forward, (4663, bob, DELAY, alice, uint256(0)))
        );
        assertTrue(ok, "must not revert");
        assertEq(arrival.rescue(alice), dust, "held for the sender, not spent on a ticket");
    }
}
