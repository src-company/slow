// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "@forge/Test.sol";
import {SLOW} from "../src/SLOW.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

/// @dev What an OP portal does: mark the withdrawal spent, call the target with
///      a bounded budget, and do NOT revert when the target fails.
contract Portal {
    address public l2Sender = SlowOrigin.DEAD;
    bool public lastOk;
    function finalize(address from, address target, uint256 value, bytes calldata data, uint256 cap)
        external payable
    {
        l2Sender = from;
        (bool ok,) = target.call{value: value, gas: cap}(data);
        lastOk = ok;                       // did `arrive` itself survive?
        l2Sender = SlowOrigin.DEAD;
    }
}

contract Eater { fallback() external payable { while (true) {} } }

/// @dev An OP portal from the SEND side, for the forward leg.
contract SendPortal {
    uint256 public received;
    function depositTransaction(address, uint256, uint64, bool, bytes calldata) external payable {
        received += msg.value;
    }
}

contract ArrivalFinaliserTest is Test {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address fin = address(0xF1);

    uint256 internal BOUNTY = 0.01 ether;

    /// @return arriveOk did `arrive` survive
    /// @return deposited did the deposit actually land
    /// @return rescued   rescue credited to the origin
    function _attempt(uint256 cap, bool delegated)
        internal returns (bool arriveOk, bool deposited, uint256 rescued)
    {
        SLOW s = new SLOW(address(0));
        SlowArrival a = new SlowArrival(address(s), new uint256[](0), new SlowArrival.Route[](0));
        Portal p = new Portal();
        vm.deal(address(p), 10 ether);
        if (delegated) vm.etch(fin, abi.encodePacked(hex"ef0100", address(new Eater())));
        else vm.etch(fin, "");
        vm.deal(fin, 1 ether);

        bytes memory cd = abi.encodeCall(SlowArrival.arrive, (bob, uint96(1 days), address(0), BOUNTY));
        vm.prank(fin, fin);                                   // msg.sender AND tx.origin
        address(p).call{value: 1 ether}(
            abi.encodeCall(Portal.finalize, (alice, address(a), 1 ether, cd, cap)));
        arriveOk = p.lastOk();
        deposited = address(s).balance > 0;
        rescued = a.rescue(alice);
    }

    /// @notice Does `forward` share the flaw? It has the same bounty branch but
    ///         reserves 80,000 rather than 60,000.
    /// @dev This sizes the cost of the zero-bounty rule. If `forward` is immune,
    ///      the rule bites only on a direct L2->L1 `arrive` — and the L2->L2
    ///      product, which is what the bounty was written for, keeps its keeper
    ///      incentive on the inbound leg.
    function test_doesForwardShareTheFlaw() public {
        uint256 diverged;
        for (uint256 g = 150_000; g <= 450_000; g += 2_000) {
            (bool okP,) = _forward(g, false);
            (bool okD,) = _forward(g, true);
            if (okP && !okD && diverged == 0) diverged = g;
        }
        emit log_named_uint("forward: first divergence", diverged);
        assertEq(diverged, 0, "forward must not be revertible either");
    }

    function _forward(uint256 cap, bool delegated) internal returns (bool fwdOk, bool sent) {
        SLOW s = new SLOW(address(0));
        SendPortal sp = new SendPortal();
        uint256[] memory ids = new uint256[](1);
        SlowArrival.Route[] memory rs = new SlowArrival.Route[](1);
        ids[0] = 8453;
        rs[0] = SlowArrival.Route(address(sp), 1, 2_500_000, 4 gwei);
        SlowArrival a = new SlowArrival(address(s), ids, rs);
        Portal p = new Portal();
        vm.deal(address(p), 10 ether);
        if (delegated) vm.etch(fin, abi.encodePacked(hex"ef0100", address(new Eater())));
        else vm.etch(fin, "");
        bytes memory cd = abi.encodeCall(SlowArrival.forward, (8453, bob, uint96(1 days), address(0), 0.01 ether));
        vm.prank(fin, fin);
        address(p).call{value: 1 ether}(
            abi.encodeCall(Portal.finalize, (alice, address(a), 1 ether, cd, cap)));
        fwdOk = p.lastOk();
        sent = sp.received() > 0;
    }

    /// @notice A finaliser must never be able to make `arrive` revert.
    /// @dev On the OP leg the portal marks a withdrawal finalized BEFORE calling
    ///      the target and never replays it, so a revert here destroys the
    ///      bridged ETH outright. That makes the finaliser — a permissionless
    ///      role — the adversary this function is written against.
    ///
    ///      Under EIP-7702 an EOA can carry a delegation and still send
    ///      transactions, so a finaliser controls `tx.origin`, its code, and how
    ///      much gas resolving it costs. Before the fix a delegated finaliser
    ///      reverted `arrive` across a 275,000-291,000 gas band where a plain
    ///      one succeeded: the delegation lookup plus the callee's burn pushed
    ///      the failure tail past the reserve.
    ///
    ///      The band is narrow, which is what makes a sweep the right shape of
    ///      test — a single gas value would have sat either side of it and
    ///      reported nothing.
    /// @notice THE MITIGATION FOR THE LIVE CONTRACT, which needs no redeploy.
    /// @dev The starvable branch is only entered when `pay != 0`, and `pay`
    ///      derives from `bounty` — a parameter in the calldata of the
    ///      withdrawal message, fixed by whoever INITIATES it. A finaliser
    ///      cannot change it. So a message carrying no bounty cannot be
    ///      reverted by any finaliser, on any build.
    ///
    ///      Verified against the DEPLOYED behaviour before the fix below
    ///      existed: with `bounty = 0.01 ether` a delegated finaliser reverted
    ///      `arrive` from 276,000 gas; with `bounty = 0` there was no
    ///      divergence anywhere from 150,000 to 450,000.
    ///
    ///      Every message the system can currently produce already satisfies
    ///      this: `_push` builds `arrive` with a bounty of zero, and the dapp
    ///      builds no L2->L1 arrivals at all. It is a rule to keep, not a
    ///      change to make.
    function test_aZeroBountyMessageIsImmune() public {
        BOUNTY = 0;
        uint256 diverged;
        for (uint256 g = 150_000; g <= 450_000; g += 2_000) {
            (bool okP,,) = _attempt(g, false);
            (bool okD,,) = _attempt(g, true);
            if (okP && !okD && diverged == 0) diverged = g;
        }
        emit log_named_uint("bounty=0: first divergence", diverged);
        assertEq(diverged, 0, "a zero-bounty arrival cannot be reverted by any finaliser");
    }

    function test_aDelegatedFinaliserCannotRevertArrive() public {
        uint256 firstDivergence;
        for (uint256 g = 150_000; g <= 450_000; g += 2_000) {
            (bool okP, bool depP,) = _attempt(g, false);
            (bool okD, bool depD,) = _attempt(g, true);
            if (false) {
                emit log_named_string(
                    string.concat("gas ", vm.toString(g)),
                    string.concat(
                        "plain arriveOk=", okP ? "1" : "0", " deposited=", depP ? "1" : "0",
                        "  |  7702 arriveOk=", okD ? "1" : "0", " deposited=", depD ? "1" : "0"));
            }
            if (okP && !okD && firstDivergence == 0) firstDivergence = g;
        }
        emit log_named_uint("first gas where 7702 reverts arrive but plain does not", firstDivergence);
        assertEq(firstDivergence, 0, "a finaliser must never be able to revert arrive");
    }
}
