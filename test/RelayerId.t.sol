// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "../lib/forge-std/src/Test.sol";
import {SlowRelay} from "../src/SlowRelay.sol";

/// @notice The contract half of the golden intent id.
///
/// @dev `scripts/relayer.mjs` computes this id off chain to decide what to fill,
///      and a relayer that computes it differently fills something nobody will
///      ever pay it for. Both sides are pinned to the constant below — this file
///      asserts the CONTRACT produces it, `test/relayer.test.mjs` asserts the
///      SCRIPT does. A golden value checked on only one side just moves with
///      whichever side changed.
///
///      Reordering `Intent` will fail here first.
contract RelayerIdTest is Test {
    bytes32 internal constant GOLDEN =
        0xbabf3450d3376731938c939e16c5a0e9f840bf9ca1e1a8dd657961028f2fd414;

    function test_theGoldenIntentId() public pure {
        SlowRelay.Intent memory i = SlowRelay.Intent({
            sender: address(0xA11CE),
            recipient: address(0xB0B),
            srcToken: address(0),
            dstToken: address(0),
            amount: 1 ether,
            fee: 0.002 ether,
            delay: 3 days,
            srcChainId: 8453,
            dstChainId: 4663,
            fillDeadline: 1700003600,
            nonce: 1
        });
        assertEq(keccak256(abi.encode(i)), GOLDEN, "the off-chain relayer derives this id");
    }

    /// @dev Every field static means `abi.encode` is eleven words with no
    ///      offsets, which is the only reason the script can encode it by hand.
    function test_theEncodingIsElevenStaticWords() public pure {
        SlowRelay.Intent memory i;
        assertEq(abi.encode(i).length, 11 * 32, "no dynamic fields may be added");
    }
}
