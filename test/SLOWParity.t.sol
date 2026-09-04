// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {SLOWv1 as SLOW} from "../src/SLOWv1.sol";
import {SLOW as SLOWBuild, SLOWGate as SLOWGateBuild} from "../src/SLOW.sol";
import {SLOWTest} from "./SLOW.t.sol";
import {SSTORE2} from "@solady/src/utils/SSTORE2.sol";

/// @notice The whole `SLOW.t.sol` suite, re-run against the build that ships.
///
/// @dev WHY. `SLOW.t.sol` deploys `src/SLOW.sol` — the 21,648-byte runtime frozen
///      on mainnet. It is not what the multichain deployment puts on chain.
///      `SLOWBuild` is the same source with two extensions folded in, but folding
///      them in moved every storage slot `SLOW` declares down by two and
///      recompiled the lot, so "the logic is unchanged" is an assertion, not a
///      fact, until the same tests run against it.
///
///      `_deploySlow` is the single place the suite constructs the contract, so
///      overriding it here re-runs all of it — deposits, timelocks, guardians,
///      reverse, clawback, the gate and the tip accounting — against `SLOWBuild`.
///      The cast is safe: every selector the suite calls is inherited unchanged,
///      and `SLOWGateBuild` is ABI-identical to `SLOWGate`.
contract SLOWNextParityTest is SLOWTest {
    function _deploySlow(bytes memory p1, bytes memory p2) internal override returns (SLOW) {
        return SLOW(address(new SLOWBuild(SSTORE2.write(p1), SSTORE2.write(p2))));
    }

    /// `SLOWBuild` CREATE2s a `SLOWGateBuild`, so the predicted address follows
    /// that creation code. The property under test is unchanged: the gate still
    /// lands where a caller can compute it without asking the contract — which
    /// is what puts it at one address on every chain.
    function _gateInitCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(SLOWGateBuild).creationCode);
    }

    /// Deposits carry `_OP_DEPOSIT` here and run off `nonces`, while the guarded
    /// ops moved to `guardianNonces` — so the deposit space has its own
    /// predictor. That split is the fix for a deposit being able to void a
    /// standing guardian approval.
    function _predictDepositId(address from, address to, uint256 id, uint256 amount)
        internal
        view
        override
        returns (uint256)
    {
        return SLOWBuild(payable(address(slow))).predictDepositId(from, to, id, amount);
    }

    /// `claimMany` isolates each id in this build.
    function _claimManyIsAtomic() internal pure override returns (bool) {
        return false;
    }

    /// Guarded ops consume `guardianNonces` here; `nonces` belongs to deposits.
    function _opNonce(address user) internal view override returns (uint256) {
        return SLOWBuild(payable(address(slow))).guardianNonces(user);
    }
}
