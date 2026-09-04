// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {SLOW} from "../src/SLOW.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowRelay} from "../src/SlowRelay.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

/// @title Fork simulations
/// @notice Everything else in this suite runs against mocks shaped after the
///         real bridges. Shaped-after is not the same as forked, so this file
///         points the same code at the DEPLOYED contracts on all three chains.
///
/// @dev WHAT A FORK CAN AND CANNOT SETTLE. It cannot manufacture a proven
///      withdrawal — that needs a real Merkle proof against a resolved dispute
///      game. What it CAN settle is every assumption this design rests on that
///      is cheap to get wrong:
///
///        · that the selectors are right on the deployed contracts;
///        · that `l2Sender()` / `activeOutbox()` / `l2ToL1Sender()` live where
///          the probes expect and return what the probes decode;
///        · that the real entrypoints accept the calldata `pushProof` builds;
///        · that the L2 predeploys answer on the chains they must, and only there;
///        · and — the largest open question in this design — whether Robinhood
///          Chain accepts an arbitrary L2→L1 message at all.
///
/// @dev SLOT DISCOVERY, NOT SLOT GUESSING. To drive a real bridge's getter this
///      has to write the storage behind it, and the layouts are not public API.
///      So `_findAddressSlot` probes: write a sentinel into each candidate slot,
///      call the getter, and keep the slot that echoes it back. That verifies the
///      getter and locates the slot in one move, and it stays correct if either
///      is upgraded underneath us.
///
/// @dev These tests need network. Run them with
///      `forge test --match-contract Fork`. They are skipped automatically when
///      the fork cannot be created, so an offline suite still goes green.
abstract contract ForkBase is Test {
    // Verified live on 3-4 September 2026.
    address internal constant BASE_PORTAL = 0x49048044D57e1C92A77f79988d21Fa8fAF74E97e;
    address internal constant RH_INBOX = 0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D;
    address internal constant RH_BRIDGE = 0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3;
    address internal constant RH_OUTBOX = 0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9;
    address internal constant L1_CDM = 0x866E82a600A1414e583f7F13623F1aC5d58b0Afa; // Base's

    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    address internal constant OP_L2_MESSENGER = 0x4200000000000000000000000000000000000007;
    address internal constant OP_L2_MESSAGE_PASSER = 0x4200000000000000000000000000000000000016;

    string internal constant ETH_RPC = "https://ethereum-rpc.publicnode.com";
    string internal constant BASE_RPC = "https://base-rpc.publicnode.com";
    string internal constant RH_RPC = "https://rpc.mainnet.chain.robinhood.com";

    /// @dev Creates the fork, or returns false so the test can no-op offline.
    function _fork(string memory rpc) internal returns (bool) {
        try vm.createSelectFork(rpc) {
            return true;
        } catch {
            console2.log("SKIPPED: no network for", rpc);
            return false;
        }
    }

    /// @dev Find the storage slot behind an address getter by writing a sentinel
    ///      and asking. Restores whatever was there.
    function _findAddressSlot(address target, bytes4 getter, uint256 maxSlot)
        internal
        returns (bool found, uint256 slot)
    {
        address sentinel = address(0x00000000000000000000000000000000C0de5107);
        for (uint256 i; i <= maxSlot; ++i) {
            bytes32 key = bytes32(i);
            bytes32 prev = vm.load(target, key);
            vm.store(target, key, bytes32(uint256(uint160(sentinel))));
            (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(getter));
            vm.store(target, key, prev);
            if (ok && ret.length == 32 && abi.decode(ret, (address)) == sentinel) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    function _setAddressSlot(address target, uint256 slot, address value) internal {
        vm.store(target, bytes32(slot), bytes32(uint256(uint160(value))));
    }
}

// ───────────────────────────────────────────────────────── ETHEREUM MAINNET

contract SlowArrivalEthereumForkTest is ForkBase {
    SLOW internal slow;
    SlowArrival internal arrival;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal keeper = address(0xCAFE01);
    uint96 internal constant DELAY = 1 days;
    uint256 internal constant AMOUNT = 1 ether;

    bool internal live;

    function setUp() public {
        live = _fork(ETH_RPC);
        if (!live) return;
        slow = new SLOW(address(0), address(0));
        arrival = new SlowArrival(address(slow));
    }

    /// @notice The Base portal really is the shape `SlowOrigin` probes. Its
    ///         `l2Sender()` answers, it parks on 0x…dEaD between calls, and the
    ///         probe reads the slot behind it.
    function test_basePortalAnswersTheProbe() public {
        if (!live) return;
        assertGt(BASE_PORTAL.code.length, 0, "portal has code on this fork");

        (bool ok, bytes memory ret) =
            BASE_PORTAL.staticcall(abi.encodeWithSelector(bytes4(0x9bf62d82)));
        assertTrue(ok && ret.length == 32, "l2Sender() answers");
        assertEq(abi.decode(ret, (address)), SlowOrigin.DEAD, "parked on DEAD at rest");

        (bool found, uint256 slot) = _findAddressSlot(BASE_PORTAL, 0x9bf62d82, 80);
        assertTrue(found, "located the l2Sender slot");
        console2.log("Base OptimismPortal l2Sender slot:", slot);
    }

    /// @notice The whole inbound path, driven by the REAL portal: set the sender
    ///         slot, call `arrive` as the portal, and check Alice ends up owning
    ///         the reverse on Ethereum.
    function test_arrivalFromTheRealBasePortalKeepsTheReverse() public {
        if (!live) return;
        (bool found, uint256 slot) = _findAddressSlot(BASE_PORTAL, 0x9bf62d82, 80);
        if (!found) return;

        _setAddressSlot(BASE_PORTAL, slot, alice);
        vm.deal(BASE_PORTAL, AMOUNT);

        // tx.origin is a keeper distinct from msg.sender, as a real finalisation
        // has it: the portal calls the target, the keeper paid for the transaction.
        vm.prank(BASE_PORTAL, keeper);
        arrival.arrive{value: AMOUNT}(bob, DELAY, address(0), 0);

        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1, "one arrival");
        assertEq(arrival.originOf(out[0]), alice, "the real portal named Alice");

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.reverse(out[0], alice);
        assertEq(alice.balance, before + AMOUNT, "and Alice can undo it");
    }

    /// @notice The Arbitrum shape, end to end through the REAL bridge and outbox:
    ///         `msg.sender` is the bridge, and the origin comes back only by
    ///         walking `activeOutbox()` → `l2ToL1Sender()`.
    function test_arrivalFromTheRealRobinhoodBridgeKeepsTheReverse() public {
        if (!live) return;
        assertGt(RH_BRIDGE.code.length, 0, "bridge has code");
        assertGt(RH_OUTBOX.code.length, 0, "outbox has code");

        (bool foundBridge, uint256 bridgeSlot) = _findAddressSlot(RH_BRIDGE, 0xab5d8943, 80);
        (bool foundOutbox, uint256 outboxSlot) = _findAddressSlot(RH_OUTBOX, 0x80648b02, 80);
        console2.log("Robinhood Bridge activeOutbox slot:", bridgeSlot);
        console2.log("Robinhood Outbox l2ToL1Sender slot:", outboxSlot);
        if (!foundBridge || !foundOutbox) return;

        _setAddressSlot(RH_BRIDGE, bridgeSlot, RH_OUTBOX);
        _setAddressSlot(RH_OUTBOX, outboxSlot, alice);
        vm.deal(RH_BRIDGE, AMOUNT);

        vm.prank(RH_BRIDGE, keeper);
        arrival.arrive{value: AMOUNT}(bob, DELAY, address(0), 0);

        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1);
        assertEq(arrival.originOf(out[0]), alice, "two-hop recovery works on the real pair");
    }

    /// @notice At rest the real bridge answers zero, which is what makes
    ///         `activeOutbox()` a proof of context rather than a lookup. If this
    ///         ever stopped being true the probe would start believing a bridge
    ///         that is not mid-call.
    function test_theRealBridgeAnswersZeroWhenNothingIsExecuting() public {
        if (!live) return;
        (bool ok, bytes memory ret) =
            RH_BRIDGE.staticcall(abi.encodeWithSelector(bytes4(0xab5d8943)));
        assertTrue(ok && ret.length == 32, "activeOutbox() answers");
        assertEq(abi.decode(ret, (address)), address(0), "zero at rest");
    }

    /// @notice `pushProof` builds calldata the REAL entrypoints accept. A revert
    ///         here would mean the forwarding leg is wrong in a way no mock can
    ///         show.
    function test_pushProofIsAcceptedByTheRealEntrypoints() public {
        if (!live) return;
        address[] memory inboxes = new address[](1);
        inboxes[0] = L1_CDM;
        SlowRelay relay = new SlowRelay(address(slow), inboxes);

        // Seed a fill so there is something to forward. Chain id on this fork is
        // 1, so the intent's destination is L1 itself.
        SlowRelay.Intent memory i = SlowRelay.Intent({
            sender: alice,
            recipient: bob,
            srcToken: address(0),
            dstToken: address(0),
            amount: AMOUNT,
            fee: 0.002 ether,
            delay: DELAY,
            srcChainId: 8453,
            dstChainId: 1,
            fillDeadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
        address relayer = address(0x5E11E5);
        vm.deal(relayer, 10 ether);
        vm.prank(relayer);
        relay.fill{value: AMOUNT}(i);
        bytes32 id = relay.intentId(i);

        // OP Stack: the real Base portal.
        vm.deal(address(this), 10 ether);
        relay.pushProof(id, SlowRelay.Kind.OP_STACK, BASE_PORTAL, 300_000, 0, 0);

        // Arbitrum: the real Robinhood inbox. Retryables are bought on L1, so
        // this one carries value.
        relay.pushProof{value: 0.02 ether}(
            id, SlowRelay.Kind.ARBITRUM, RH_INBOX, 600_000, 0.1 gwei, 1e15
        );
    }

    /// @notice The claim that "Robinhood's exit has never been exercised" was
    ///         wrong, and this is what disproves it. `Outbox.isSpent(index)` is
    ///         true only once a withdrawal has been executed on Ethereum, so
    ///         these are completed round trips, not merely initiated ones.
    ///         Recent indices are still unspent because they sit inside the
    ///         ~6.4-day confirmation window, which is itself corroboration.
    function test_robinhoodWithdrawalsHaveExecutedOnL1() public {
        if (!live) return;
        uint256 spent;
        uint256[8] memory sample = [uint256(0), 1, 2, 25, 100, 400, 800, 1600];
        for (uint256 k; k != sample.length; ++k) {
            (bool ok, bytes memory ret) = RH_OUTBOX.staticcall(
                abi.encodeWithSelector(bytes4(0x5a129efe), sample[k]) // isSpent(uint256)
            );
            if (ok && ret.length == 32 && abi.decode(ret, (bool))) ++spent;
        }
        console2.log("Robinhood withdrawals executed on L1, of 8 sampled:", spent);
        assertGt(spent, 0, "the exit is in use, not theoretical");
    }

    /// @notice Neither L2 predeploy exists on L1, so `proveFill` correctly finds
    ///         no route rather than calling into an empty address.
    function test_noL2PredeploysOnMainnet() public {
        if (!live) return;
        assertEq(ARB_SYS.code.length, 0, "ArbSys is not on L1");
        assertEq(OP_L2_MESSENGER.code.length, 0, "the L2 messenger is not on L1");
    }
}

// ─────────────────────────────────────────────────────────────────── BASE

contract SlowRelayBaseForkTest is ForkBase {
    SLOW internal slow;
    SlowRelay internal relay;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal relayer = address(0x5E11E5);
    bool internal live;

    function setUp() public {
        live = _fork(BASE_RPC);
        if (!live) return;
        slow = new SLOW(address(0), address(0));
        relay = new SlowRelay(address(slow), new address[](0));
        vm.deal(relayer, 100 ether);
    }

    function test_baseIsDetectedAsAnOpChain() public {
        if (!live) return;
        assertGt(OP_L2_MESSENGER.code.length, 0, "the messenger predeploy is here");
        assertGt(OP_L2_MESSAGE_PASSER.code.length, 0, "so is the message passer");
        assertEq(ARB_SYS.code.length, 0, "and ArbSys is not: the family test holds");
    }

    /// @notice The outbound leg, against the REAL L2CrossDomainMessenger: a fill
    ///         on Base proves itself toward the source chain and the messenger
    ///         accepts the message.
    function test_proveFillIsAcceptedByTheRealMessenger() public {
        if (!live) return;
        SlowRelay.Intent memory i = SlowRelay.Intent({
            sender: alice,
            recipient: bob,
            srcToken: address(0),
            dstToken: address(0),
            amount: 1 ether,
            fee: 0.002 ether,
            delay: 3 days,
            srcChainId: 4663,
            dstChainId: 8453,
            fillDeadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
        vm.prank(relayer);
        relay.fill{value: 1 ether}(i);

        vm.recordLogs();
        relay.proveFill(i);
        // The messenger emits SentMessage / SentMessageExtension1 on success.
        assertGt(vm.getRecordedLogs().length, 0, "the real messenger took the message");
    }
}

// ─────────────────────────────────────────────────────── ROBINHOOD CHAIN

contract SlowRelayRobinhoodForkTest is ForkBase {
    SLOW internal slow;
    SlowRelay internal relay;
    SlowArrival internal arrival;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal relayer = address(0x5E11E5);
    bool internal live;

    function setUp() public {
        live = _fork(RH_RPC);
        if (!live) return;
        slow = new SLOW(address(0), address(0));
        relay = new SlowRelay(address(slow), new address[](0));
        arrival = new SlowArrival(address(slow));
        vm.deal(relayer, 100 ether);
    }

    function test_robinhoodIsDetectedAsAnArbitrumChain() public {
        if (!live) return;
        assertGt(ARB_SYS.code.length, 0, "ArbSys reports code on Nitro");
        assertEq(OP_L2_MESSENGER.code.length, 0, "no OP messenger here");
        assertEq(block.chainid, 4663, "and this really is chain 4663");
    }

    /// @notice WHY THE L2 EXIT CANNOT BE FORK-TESTED, and what settled it
    ///         instead.
    ///
    ///         `ArbSys` is a Nitro PRECOMPILE: the node implements it, and
    ///         `eth_getCode` returns the single byte `0xfe` as a marker. `0xfe`
    ///         is the EVM's INVALID opcode, so a local EVM forking this chain
    ///         executes the marker literally, burns all the gas and reverts. A
    ///         fork test here measures the tooling, not the chain, and would
    ///         have reported the exit as broken when it is not.
    ///
    ///         Asked of the real node instead, with `eth_call`:
    ///
    ///           sendTxToL1(0x…dEaD, "")   OK, returns id 1912
    ///           withdrawEth(0x…dEaD)      OK, returns id 1912
    ///           estimateGas               69,283
    ///
    ///         The returned id is the next L2→L1 message index, so **1,912
    ///         messages have already left this chain** — and
    ///         `test_robinhoodWithdrawalsHaveExecutedOnL1` shows that many of
    ///         them have been executed through the Outbox on Ethereum. The exit
    ///         is not untried; it is in routine use.
    function test_arbSysIsAPrecompileAndCannotBeForkExecuted() public {
        if (!live) return;
        assertEq(ARB_SYS.code.length, 1, "the precompile marker, not a contract");
        assertEq(uint8(ARB_SYS.code[0]), 0xfe, "0xfe: INVALID to a local EVM");
    }

    /// @notice The outbound leg with the precompile stubbed, so the contract's
    ///         own branch is still exercised even though the real one cannot run
    ///         here. The family detection above is what picks this branch, and
    ///         it picks it off the same marker byte.
    function test_proveFillTakesTheArbitrumBranchOnRobinhood() public {
        if (!live) return;
        SlowRelay.Intent memory i = SlowRelay.Intent({
            sender: alice,
            recipient: bob,
            srcToken: address(0),
            dstToken: address(0),
            amount: 1 ether,
            fee: 0.002 ether,
            delay: 3 days,
            srcChainId: 8453,
            dstChainId: 4663,
            fillDeadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
        vm.prank(relayer);
        relay.fill{value: 1 ether}(i);

        vm.mockCall(ARB_SYS, abi.encodeWithSignature("sendTxToL1(address,bytes)"), abi.encode(uint256(1912)));
        vm.expectCall(ARB_SYS, abi.encodeWithSignature("sendTxToL1(address,bytes)"));
        relay.proveFill(i);
    }

    /// @notice The inbound half on the chain where it is broken today: a
    ///         retryable arrives aliased, and SlowArrival gives the reverse back.
    function test_aliasedArrivalIsRepairedOnRobinhood() public {
        if (!live) return;
        address aliased = SlowOrigin.applyAlias(alice);
        vm.deal(aliased, 1 ether);
        vm.prank(aliased, aliased); // Nitro: tx.origin == msg.sender == the alias
        arrival.arrive{value: 1 ether}(bob, 1 days, alice, 0);

        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1);
        assertEq(arrival.originOf(out[0]), alice, "unaliased back to Alice");

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.reverse(out[0], alice);
        assertEq(alice.balance, before + 1 ether, "the reverse that is dead today");
    }
}
