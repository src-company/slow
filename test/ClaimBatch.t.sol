// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "@forge/Test.sol";
import {SLOW, SLOWGate} from "../src/SLOW.sol";

/// @dev A recipient that accepts the mint so the deposit lands, then burns the keeper's gas on
///      receipt. `_doClaim` pays with `safeTransferETH`, which forwards
///      everything it has.
contract GasBurner {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return this.onERC1155Received.selector; }

    receive() external payable {
        uint256 x;
        while (gasleft() > 5_000) { x = uint256(keccak256(abi.encode(x))); }
    }
}

contract ClaimBatchTest is Test {
    SLOW slow;
    SLOWGate gate;
    address keeper = address(0xCAFE01);
    address alice = address(0xA11CE);

    function setUp() public {
        slow = new SLOW(address(0));
        gate = SLOWGate(payable(slow.gate()));
        vm.deal(alice, 100 ether);
        vm.deal(keeper, 10 ether);
    }

    function test_poc_oneHostileIdEatsTheWholeBatch() public {
        GasBurner evil = new GasBurner();
        uint256[] memory ids = new uint256[](12);

        // id 0: the attacker's dust deposit, tipped so the gate can settle it.
        vm.prank(alice);
        ids[0] = slow.depositToWithTip{value: 2}(address(0), address(evil), 1, 600, 1, "");

        // ids 1..5: honest recipients, each tipped.
        for (uint256 i = 1; i != 12; ++i) {
            address bob = address(uint160(0xB0B0 + i));
            vm.prank(alice);
            ids[i] = slow.depositToWithTip{value: 2}(address(0), bob, 1, 600, 1, "");
        }

        vm.warp(block.timestamp + 601);

        uint256 before = gasleft();
        vm.prank(keeper);
        gate.claimMany{gas: 12_000_000}(ids);
        emit log_named_uint("gas the batch consumed", before - gasleft());

        uint256 settled;
        for (uint256 i; i != 12; ++i) {
            (uint96 ts,,,,) = slow.pendingTransfers(ids[i]);
            if (ts == 0) settled++;
        }
        emit log_named_uint("settled out of 12", settled);
        // THE PROPERTY IS THE CEILING, not which ids survive. The hostile
        // recipient still gets its transfer — it just cannot spend more than
        // its own share getting it. Uncapped, this same batch burned the
        // keeper's entire limit and reverted, settling nothing.
        assertEq(settled, 12, "every id settles");
        assertLt(before - gasleft(), 3_000_000, "and one hostile id cannot eat the batch");
    }
}
