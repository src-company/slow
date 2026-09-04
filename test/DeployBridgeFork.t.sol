// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {DeployBridge} from "../script/DeployBridge.s.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowRelay} from "../src/SlowRelay.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes memory initCode)
        external
        payable
        returns (address);
}

/// @notice Proves the deployment lands at ONE address on all three chains, by
///         running the real CreateX on forks of all three rather than by
///         reasoning about the derivation.
///
/// @dev WHY THIS IS A CORRECTNESS TEST AND NOT A CONVENIENCE ONE.
///      `SlowRelay.receiveRelay` accepts a proof only when the recovered origin
///      is `address(this)`. If the three deployments diverge by one byte the
///      relay never settles, every escrow sits until its deadline, and the
///      failure is silent. So the property is asserted against the deployed
///      CreateX on each chain, including the two traps in its salt guard.
///
/// @dev The forks are skipped rather than failed when no RPC is reachable, so
///      this file is safe in an offline CI and meaningful when it is not.
contract DeployBridgeForkTest is Test {
    ICreateX internal constant CREATEX =
        ICreateX(0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed);

    DeployBridge internal script_;

    /// @dev An arbitrary but FIXED deployer. The salt is prefixed with it, so
    ///      the address is only reproducible for this account — which is the
    ///      permissioning, and also why the same account must be used on every
    ///      chain.
    address internal constant DEPLOYER = address(uint160(0xDEB10));

    uint64 internal constant SALT_NONCE = 1;

    /// @dev SLOW differs per chain today: v1 is live on mainnet, and the L2s
    ///      await the redeployment. The bridge contracts take it as an argument,
    ///      so the address they land at does not depend on it — which this test
    ///      relies on by passing a DIFFERENT one on each chain and still
    ///      expecting the same result.
    address internal constant SLOW_MAINNET = 0x000000000000888741B254d37e1b27128AfEAaBC;

    /// @dev Stand-ins for the not-yet-deployed SLOW on the two L2s. They only
    ///      have to be DIFFERENT from each other and to have code, because
    ///      `SlowArrival`'s constructor rejects a codeless one — a guard worth
    ///      having, since a bridge pointed at an empty address would accept ETH
    ///      and route it nowhere. Different values on every chain are the point:
    ///      the addresses below must still converge.
    address internal constant BASE_STANDIN = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
    address internal constant ROBINHOOD_STANDIN = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // USDG

    string[3] internal RPCS = [
        "https://ethereum-rpc.publicnode.com",
        "https://base-rpc.publicnode.com",
        "https://rpc.mainnet.chain.robinhood.com"
    ];
    uint256[3] internal CHAINS = [uint256(1), 8453, 4663];

    function setUp() public {
        script_ = new DeployBridge();
        // A fork starts from the remote chain's state, so anything deployed
        // here is not there. Without this the helper simply has no code on the
        // fork and every call to it reverts.
        vm.makePersistent(address(script_));
    }

    function _fork(uint256 i) internal returns (bool) {
        try vm.createSelectFork(RPCS[i]) {
            return block.chainid == CHAINS[i];
        } catch {
            return false;
        }
    }

    /// @dev Mirrors `DeployBridge.run` without the broadcast, so the same salts
    ///      and the same initcode go through the same live CreateX.
    function _deploy(address slow) internal returns (address arrival, address relay) {
        bytes32 s0 = script_._salt(DEPLOYER, SALT_NONCE);
        bytes32 s1 = script_._salt(DEPLOYER, SALT_NONCE + 1);

        address[] memory messengers;
        if (block.chainid == 1) {
            messengers = new address[](2);
            messengers[0] = 0x866E82a600A1414e583f7F13623F1aC5d58b0Afa;
            messengers[1] = 0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3;
        } else {
            messengers = new address[](0);
        }

        vm.startPrank(DEPLOYER, DEPLOYER);
        arrival = CREATEX.deployCreate3(
            s0,
            abi.encodePacked(
                type(SlowArrival).creationCode,
                abi.encode(slow, new uint256[](0), new SlowArrival.Route[](0))
            )
        );
        relay = CREATEX.deployCreate3(
            s1, abi.encodePacked(type(SlowRelay).creationCode, abi.encode(slow, messengers))
        );
        vm.stopPrank();
    }

    /// @notice The whole premise, on the three real chains.
    function test_oneAddressOnEveryChain() public {
        address[3] memory arrivals;
        address[3] memory relays;
        uint256 reached;

        for (uint256 i; i != 3; ++i) {
            if (!_fork(i)) {
                console2.log("skipped (no RPC) chain", CHAINS[i]);
                continue;
            }
            assertGt(address(CREATEX).code.length, 0, "CreateX must be present");

            // Deliberately a DIFFERENT SLOW on each chain, to show the address
            // does not depend on the constructor arguments.
            address slow = _slowFor(i);
            assertGt(slow.code.length, 0, "the stand-in must have code");
            (arrivals[i], relays[i]) = _deploy(slow);

            assertEq(
                arrivals[i], script_.predict(DEPLOYER, script_._salt(DEPLOYER, SALT_NONCE)),
                "prediction must match what CreateX actually did"
            );
            assertEq(SlowArrival(payable(arrivals[i])).slow(), slow);
            assertEq(SlowRelay(payable(relays[i])).slow(), slow);

            console2.log("chain", CHAINS[i]);
            console2.log("  SlowArrival", arrivals[i]);
            console2.log("  SlowRelay  ", relays[i]);
            ++reached;
        }

        if (reached < 2) {
            console2.log("fewer than two chains reachable; nothing to compare");
            return;
        }

        // Compare every reached chain against the first one that was reached.
        address a0;
        address r0;
        for (uint256 i; i != 3; ++i) {
            if (arrivals[i] == address(0)) continue;
            if (a0 == address(0)) {
                (a0, r0) = (arrivals[i], relays[i]);
                continue;
            }
            assertEq(arrivals[i], a0, "SlowArrival diverged between chains");
            assertEq(relays[i], r0, "SlowRelay diverged between chains");
        }
    }

    function _slowFor(uint256 i) internal pure returns (address) {
        if (i == 0) return SLOW_MAINNET;
        if (i == 1) return BASE_STANDIN;
        return ROBINHOOD_STANDIN;
    }

    /// @notice Byte 20 is CreateX's redeploy-protection flag, and setting it
    ///         mixes `block.chainid` into the guard. The salt this script builds
    ///         must leave it clear, or the relay is inert on arrival.
    function test_theSaltLeavesTheChainIdOut() public view {
        bytes32 s = script_._salt(DEPLOYER, SALT_NONCE);
        assertEq(bytes20(s), bytes20(DEPLOYER), "sender-prefixed, so it is permissioned");
        assertEq(uint8(s[20]), 0, "byte 20 clear, so the address is chain-independent");
        assertEq(uint256(s) & type(uint64).max, SALT_NONCE, "counter in the tail");
    }

    /// @notice A salt that is not prefixed with the deployer guards differently
    ///         and would land somewhere else, so `predict` refuses it outright
    ///         rather than returning a confident wrong answer.
    function test_predictRefusesASaltItCannotDeriveFor() public {
        bytes32 wrong = script_._salt(address(0xBEEF), SALT_NONCE);
        vm.expectRevert(DeployBridge.BadSalt.selector);
        script_.predict(DEPLOYER, wrong);
    }

    /// @notice On L1 the relay must trust the two contracts that actually
    ///         deliver a message — and not the ones that only send.
    function test_theMessengerSetOnL1() public {
        if (!_fork(0)) return;
        (, address relay) = _deploy(SLOW_MAINNET);
        assertTrue(
            SlowRelay(payable(relay)).trustedMessenger(0x866E82a600A1414e583f7F13623F1aC5d58b0Afa),
            "Base's L1CrossDomainMessenger delivers OP proofs"
        );
        assertTrue(
            SlowRelay(payable(relay)).trustedMessenger(0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3),
            "Robinhood's BRIDGE delivers Nitro proofs, not its outbox"
        );
        assertFalse(
            SlowRelay(payable(relay)).trustedMessenger(
                0x49048044D57e1C92A77f79988d21Fa8fAF74E97e
            ),
            "the portal sends, it does not deliver"
        );
    }

    /// @notice An L2 trusts nothing, because the aliased branch is unforgeable
    ///         and needs no allowlist.
    /// @dev Its own test rather than a second half of the one above. Two
    ///      `createSelectFork` calls in one test share the test contract's
    ///      storage and the deployment made before the switch, which made the
    ///      second half assert against the first half's contract instead of a
    ///      freshly deployed one.
    function test_theMessengerSetOnAnL2() public {
        if (!_fork(1)) return;
        (, address relay) = _deploy(BASE_STANDIN);
        assertFalse(
            SlowRelay(payable(relay)).trustedMessenger(
                0x866E82a600A1414e583f7F13623F1aC5d58b0Afa
            ),
            "an L2 needs no allowlist at all"
        );
    }

    /// @notice The deployed arrival, on a real chain, still recovers an origin
    ///         through the real bridge contracts. Deployment and behaviour are
    ///         asserted together so a deployment that lands cannot also be inert.
    function test_theDeployedArrivalStillWorksOnMainnet() public {
        if (!_fork(0)) return;
        (address arrival,) = _deploy(SLOW_MAINNET);

        // The real Base portal parks its sender slot on 0x…dEaD between calls,
        // so an unprompted probe must decline to answer rather than invent one.
        vm.prank(0x49048044D57e1C92A77f79988d21Fa8fAF74E97e);
        (bool ok,) = arrival.call(
            abi.encodeCall(SlowArrival.arrive, (address(0xB0B), uint96(1 days), address(0), 0))
        );
        assertTrue(ok, "arrive must never revert, whatever the portal says");
    }
}
