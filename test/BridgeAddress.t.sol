// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "@forge/Test.sol";
import {DeployBridge} from "../script/DeployBridge.s.sol";

/// @title The published addresses, tied to the script that produces them
/// @notice `dapp/page.html` hardcodes `SLOW_ARRIVAL`, `manifest.json` publishes
///         both, and `deploy/SLOW-BRIDGE.md` prints them in a table. Nothing
///         tied any of those to the derivation, and the failure is silent and
///         permanent in both directions: deploy to an address the page does not
///         name and every bridged route stays closed forever with nothing
///         saying why — the page probes for code, finds none, and reports a
///         chain that is not ready.
///
/// @dev `predict` is `pure`, so this needs no fork and runs in the default
///      suite. `DeployBridgeFork` checks that the three chains AGREE with each
///      other, which is a different question and cannot catch all three
///      agreeing on the wrong address.
contract BridgeAddressTest is Test {
    DeployBridge internal script_;

    /// @dev The DEPLOYER, which is what salt bytes 0..19 must equal — CreateX
    ///      guards as `keccak256(sender ++ salt)`, so this address and the
    ///      published ones stand or fall together. It is NOT the steward:
    ///      stewardship is a constructor argument and goes to a different key,
    ///      so the deployer holds nothing once the transaction is mined.
    address internal constant STEWARD = 0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7;

    /// @dev The counters from the runbook. `run` derives the relay's as +1.
    uint64 internal constant ARRIVAL_NONCE = 0x5107a771;
    uint64 internal constant RELAY_NONCE = 0x5107a772;

    /// @dev What the page, the manifest and the runbook all name.
    address internal constant PUBLISHED_ARRIVAL = 0x9F8D89D298caBDC0D64cbA3888D0DA85Dc95097f;
    address internal constant PUBLISHED_RELAY = 0xC58C217791E397550492c4F84a6995Db60aDE2da;

    /// @dev The page contract, from `manifest.deployment`. Its counter is not
    ///      part of the bridge's `+1` pair — it was mined separately — but the
    ///      salt SHAPE is identical, so the same `_salt` derives it and the same
    ///      assertion protects it. The manifest read `src/SLOW.sol` for this
    ///      address while `chunks.artifact` read `SlowPage` and the rehearsal
    ///      deployed SlowPage here; pinning the address is what makes the
    ///      remaining question about naming rather than about which contract.
    uint64 internal constant PAGE_NONCE = 0x67eb8140;
    address internal constant PUBLISHED_PAGE = 0x6e2ca0EbF103fb2a2A7EBE2Cb12f7DE3A88BDCbc;

    function setUp() public {
        script_ = new DeployBridge();
    }


    function test_theScriptProducesThePublishedArrival() public view {
        assertEq(
            script_.predict(STEWARD, script_._salt(STEWARD, ARRIVAL_NONCE)),
            PUBLISHED_ARRIVAL,
            "SlowArrival is not where the page will look for it"
        );
    }

    function test_theScriptProducesThePublishedRelay() public view {
        assertEq(
            script_.predict(STEWARD, script_._salt(STEWARD, RELAY_NONCE)),
            PUBLISHED_RELAY,
            "SlowRelay is not where the manifest says it is"
        );
    }

    function test_theScriptProducesThePublishedPage() public view {
        assertEq(
            script_.predict(STEWARD, script_._salt(STEWARD, PAGE_NONCE)),
            PUBLISHED_PAGE,
            "SlowPage is not where the manifest and the rehearsal put it"
        );
    }

    /// @notice Four contracts, one steward, four different addresses. A counter
    ///         collision would put two of them on top of each other and the
    ///         second deploy would simply revert, after the first had spent the
    ///         address.
    function test_theFourAddressesAreDistinct() public view {
        address[3] memory a = [
            script_.predict(STEWARD, script_._salt(STEWARD, ARRIVAL_NONCE)),
            script_.predict(STEWARD, script_._salt(STEWARD, RELAY_NONCE)),
            script_.predict(STEWARD, script_._salt(STEWARD, PAGE_NONCE))
        ];
        assertTrue(a[0] != a[1] && a[1] != a[2] && a[0] != a[2], "two share an address");
    }

    /// @notice `run` takes ONE nonce and derives the relay's as `+1`. If that
    ///         ever drifts from the runbook's second counter the relay lands
    ///         somewhere nobody is looking.
    function test_theRelayCounterIsTheArrivalsPlusOne() public pure {
        assertEq(RELAY_NONCE, ARRIVAL_NONCE + 1);
    }

    /// @notice Byte 20 is CreateX's redeploy-protection flag. Set, it mixes
    ///         `block.chainid` into the guard and every chain gets a different
    ///         address — which would end `receiveRelay`'s whole premise.
    function test_thePublishedSaltsLeaveTheChainIdOut() public view {
        bytes32 a = script_._salt(STEWARD, ARRIVAL_NONCE);
        bytes32 r = script_._salt(STEWARD, RELAY_NONCE);
        assertEq(uint8(a[20]), 0, "arrival salt would be chain-dependent");
        assertEq(uint8(r[20]), 0, "relay salt would be chain-dependent");
        assertEq(bytes20(a), bytes20(STEWARD), "and only the steward may use it");
        assertEq(bytes20(r), bytes20(STEWARD));
    }

    /// @notice A CREATE3 address comes from the deployer and salt alone, never
    ///         from the child's initcode. This is what lets the contracts be
    ///         edited — as they were, to check their routes — without moving.
    function test_theAddressDoesNotDependOnWhatIsDeployed() public view {
        assertEq(
            script_.predict(STEWARD, script_._salt(STEWARD, ARRIVAL_NONCE)),
            PUBLISHED_ARRIVAL,
            "changing SlowArrival's code must not move SlowArrival"
        );
        // And a different steward lands elsewhere, so the salt is permissioned.
        assertTrue(
            script_.predict(address(0xBEEF), script_._salt(address(0xBEEF), ARRIVAL_NONCE))
                != PUBLISHED_ARRIVAL,
            "anyone could have burned the address"
        );
    }
}
