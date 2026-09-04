// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {SLOW} from "../src/SLOW.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

// ─────────────────────────────────────────────────────────────── BRIDGE MOCKS
//
// Shaped after the real ones rather than after what would be convenient: the
// OP portal calls the target ITSELF and swallows failure, and the Arbitrum
// outbox routes through the bridge so `msg.sender` at the target is the bridge.

/// @dev `OptimismPortal.finalizeWithdrawalTransaction`: sets the sender slot,
///      calls the target, restores the slot, and — the part that matters —
///      marks the withdrawal spent BEFORE the call and does not revert if it
///      fails. A revert inside the target destroys the message.
contract MockOptimismPortal {
    address public l2Sender = SlowOrigin.DEAD;
    mapping(bytes32 => bool) public finalized;

    function finalizeWithdrawal(address from, address target, uint256 value, bytes calldata data)
        external
        returns (bool success)
    {
        bytes32 h = keccak256(abi.encode(from, target, value, data));
        require(!finalized[h], "replay");
        finalized[h] = true;
        l2Sender = from;
        (success,) = target.call{value: value}(data);
        l2Sender = SlowOrigin.DEAD;
    }

    receive() external payable {}
}

/// @dev `L1CrossDomainMessenger.relayMessage` / `L2CrossDomainMessenger`.
contract MockCrossDomainMessenger {
    address public xDomainMessageSender = SlowOrigin.DEAD;

    function relay(address from, address target, uint256 value, bytes calldata data)
        external
        returns (bool success)
    {
        xDomainMessageSender = from;
        (success,) = target.call{value: value}(data);
        xDomainMessageSender = SlowOrigin.DEAD;
    }

    receive() external payable {}
}

/// @dev Nitro's `Outbox` never touches the target. It proves the message and
///      then asks the `Bridge` to make the call, which is why the target sees
///      the bridge as `msg.sender` and has to walk back through
///      `activeOutbox()` to find out who sent it.
contract MockArbOutbox {
    address public l2ToL1Sender;
    MockArbBridge public immutable bridge;

    constructor(MockArbBridge b) {
        bridge = b;
    }

    function executeTransaction(address from, address to, uint256 value, bytes calldata data)
        external
    {
        l2ToL1Sender = from;
        bridge.executeCall(to, value, data);
        l2ToL1Sender = address(0);
    }
}

contract MockArbBridge {
    address public activeOutbox; // zero at rest — this is what makes it a proof of context
    address public outbox;

    function setOutbox(address o) external {
        outbox = o;
    }

    function executeCall(address to, uint256 value, bytes calldata data)
        external
        returns (bool success)
    {
        require(msg.sender == outbox, "not outbox");
        activeOutbox = msg.sender;
        (success,) = to.call{value: value}(data);
        activeOutbox = address(0);
        require(success, "call failed"); // Arbitrum reverts atomically; OP does not
    }

    receive() external payable {}
}

/// @dev A contract that lies about `l2Sender()`. Not a hazard for SlowArrival —
///      the point of the test is to pin that down rather than assume it.
contract LiarPortal {
    address public l2Sender;

    constructor(address who) {
        l2Sender = who;
    }

    function push(address target, uint256 value, bytes calldata data) external payable {
        (bool ok,) = target.call{value: value}(data);
        require(ok, "push failed");
    }
}

// ──────────────────────────────────────────────────────────────────── TESTS

contract SlowArrivalTest is Test {
    SLOW internal slow;
    SlowArrival internal arrival;

    MockOptimismPortal internal portal;
    MockCrossDomainMessenger internal messenger;
    MockArbBridge internal arbBridge;
    MockArbOutbox internal arbOutbox;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal keeper = address(0xCAFE01);

    uint96 internal constant DELAY = 1 days;
    uint256 internal constant AMOUNT = 1 ether;

    function setUp() public {
        slow = new SLOW(address(0), address(0));
        arrival = new SlowArrival(address(slow), new uint256[](0), new SlowArrival.Route[](0));

        portal = new MockOptimismPortal();
        messenger = new MockCrossDomainMessenger();
        arbBridge = new MockArbBridge();
        arbOutbox = new MockArbOutbox(arbBridge);
        arbBridge.setOutbox(address(arbOutbox));

        vm.deal(address(portal), 100 ether);
        vm.deal(address(messenger), 100 ether);
        vm.deal(address(arbBridge), 100 ether);
        vm.deal(alice, 100 ether);
        vm.warp(1_700_000_000);
    }

    function _arriveCalldata(address to, uint96 delay, address hint, uint256 bounty)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SlowArrival.arrive, (to, delay, hint, bounty));
    }

    function _id(address token, uint96 delay) internal pure returns (uint256) {
        return (uint256(delay) << 160) | uint256(uint160(token));
    }

    // ────────────────────────────────── the bug, demonstrated before the fix

    /// @notice Without SlowArrival, a bridged deposit on an Arbitrum chain is
    ///         owned by an address with no key. This is the live defect.
    function test_aliasedDepositIsUnreversibleWithoutArrival() public {
        address aliased = SlowOrigin.applyAlias(alice);
        vm.deal(aliased, AMOUNT);

        vm.prank(aliased);
        uint256 tid = slow.depositTo{value: AMOUNT}(address(0), bob, 0, DELAY, "");

        (, address from,,,) = slow.pendingTransfers(tid);
        assertEq(from, aliased, "SLOW records the alias, not Alice");

        // Alice cannot reverse: she is not `from`.
        vm.prank(alice);
        vm.expectRevert();
        slow.reverse(tid);

        // And nobody can act as the alias, because no key exists for it. The
        // only reason this test can is `vm.prank`.
        assertTrue(aliased != alice);
    }

    // ─────────────────────────────────────────────── inbound, every family

    function test_localCallerIsItsOwnOrigin() public {
        vm.prank(alice);
        (bool ok,) = address(arrival).call{value: AMOUNT}(
            _arriveCalldata(bob, DELAY, address(0), 0)
        );
        assertTrue(ok, "arrive from an EOA must not revert");

        assertEq(_onlyOrigin(), alice, "an EOA caller is its own origin");
    }

    /// @dev Reads the origin of the single transfer this contract has made.
    function _onlyOrigin() internal view returns (address) {
        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1, "expected exactly one outbound transfer");
        return arrival.originOf(out[0]);
    }

    function _onlyTransferId() internal view returns (uint256) {
        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1, "expected exactly one outbound transfer");
        return out[0];
    }

    function test_opPortalArrivalKeepsTheReverse() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );

        uint256 tid = _onlyTransferId();
        assertEq(arrival.originOf(tid), alice, "portal told us the L2 sender");

        (, address from, address to,, uint256 amount) = slow.pendingTransfers(tid);
        assertEq(from, address(arrival));
        assertEq(to, bob);
        assertEq(amount, AMOUNT);

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.reverse(tid, alice);
        assertEq(alice.balance, before + AMOUNT, "Alice got her ETH back on the far side");
        assertEq(arrival.originOf(tid), address(0), "the claim is consumed");
    }

    function test_crossDomainMessengerArrival() public {
        messenger.relay(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        assertEq(arrival.originOf(_onlyTransferId()), alice);
    }

    function test_arbitrumOutboxArrival() public {
        arbOutbox.executeTransaction(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        // msg.sender at the target was the BRIDGE; the origin came back through
        // activeOutbox() -> l2ToL1Sender().
        assertEq(arrival.originOf(_onlyTransferId()), alice);
    }

    function test_arbitrumRetryableAliasArrival() public {
        address aliased = SlowOrigin.applyAlias(alice);
        vm.deal(aliased, AMOUNT);
        vm.prank(aliased);
        (bool ok,) =
            address(arrival).call{value: AMOUNT}(_arriveCalldata(bob, DELAY, alice, 0));
        assertTrue(ok);
        assertEq(arrival.originOf(_onlyTransferId()), alice, "the alias was undone");
    }

    function test_aliasHintIsIgnoredWhenItDoesNotMatchTheSender() public {
        vm.prank(bob); // bob is not alias(alice)
        (bool ok,) =
            address(arrival).call{value: 0}(_arriveCalldata(bob, DELAY, alice, 0));
        assertTrue(ok);
        // Nothing deposited (zero value), but nothing was believed either.
        assertEq(slow.getOutboundTransfers(address(arrival)).length, 0);
    }

    function test_aliasHintWithoutAValueIsHarmless() public {
        vm.deal(bob, AMOUNT);
        vm.prank(bob);
        (bool ok,) =
            address(arrival).call{value: AMOUNT}(_arriveCalldata(bob, DELAY, alice, 0));
        assertTrue(ok);
        // bob != alias(alice), so the hint is refused and bob owns his own deposit.
        assertEq(arrival.originOf(_onlyTransferId()), bob);
    }

    /// @notice A contract can lie about `l2Sender()`. It gains nothing: the only
    ///         powers `pt.from` carries hand money BACK, and the money was the
    ///         liar's. This is the licence for the whole address-free design.
    function test_aLiarOnlyEverGivesItsOwnMoneyAway() public {
        LiarPortal liar = new LiarPortal(alice);
        vm.deal(address(liar), AMOUNT);
        liar.push(address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0));

        uint256 tid = _onlyTransferId();
        assertEq(arrival.originOf(tid), alice, "the lie is believed");

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.reverse(tid, alice);
        // Alice ends up with the liar's ETH. Nobody was robbed but the liar.
        assertEq(alice.balance, before + AMOUNT);
    }

    // ───────────────────────────────────────────────── never revert, ever

    function test_arriveDoesNotRevertOnAnUndepositableRecipient() public {
        // `to == address(0)` makes SLOW.depositTo revert. The withdrawal must
        // still finalise, or the ETH is destroyed in the portal.
        bool ok = portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(address(0), DELAY, address(0), 0)
        );
        assertTrue(ok, "the arrival absorbed the failure");
        assertEq(arrival.rescue(alice), AMOUNT, "held for its origin instead");
        assertEq(address(arrival).balance, AMOUNT);

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.claimRescue(alice);
        assertEq(alice.balance, before + AMOUNT);
        assertEq(arrival.rescue(alice), 0);
    }

    function test_arriveDoesNotRevertWhenSlowItselfIsTheRecipient() public {
        bool ok = portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(address(slow), DELAY, address(0), 0)
        );
        assertTrue(ok);
        assertEq(arrival.rescue(alice), AMOUNT);
    }

    function test_rescueRevertsWhenThereIsNothing() public {
        vm.prank(alice);
        vm.expectRevert(SlowArrival.NothingToRescue.selector);
        arrival.claimRescue(alice);
    }

    // ────────────────────────────────────────────────────────── the bounty

    function test_bountyGoesToWhoeverLandedTheMessage() public {
        uint256 bounty = 0.01 ether;
        vm.deal(keeper, 0);
        vm.prank(keeper, keeper); // msg.sender AND tx.origin
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), bounty)
        );
        assertEq(keeper.balance, bounty, "the finaliser was paid");

        (,,,, uint256 amount) = slow.pendingTransfers(_onlyTransferId());
        assertEq(amount, AMOUNT - bounty, "and the rest was deposited");
    }

    /// An over-large bounty is REFUSED, not clamped. Clamping it to `value` paid
    /// the whole arrival out as a tip and skipped the deposit, so a finaliser
    /// collected the recipient's funds and nothing recorded where they went.
    /// Reverting is not available here — it would destroy the withdrawal — so
    /// the bounty is dropped and the payload continues to its recipient.
    function test_anOverLargeBountyIsRefusedAndThePayloadStillLands() public {
        vm.deal(keeper, 0);
        vm.prank(keeper, keeper);
        bool ok = portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 10 ether)
        );
        assertTrue(ok, "a malformed bounty must not destroy the withdrawal");
        assertEq(keeper.balance, 0, "the finaliser must not take the payload as a tip");

        (,,,, uint256 amount) = slow.pendingTransfers(_onlyTransferId());
        assertEq(amount, AMOUNT, "the whole arrival reaches the recipient");
    }

    // ──────────────────────────────────────────────────── ownership of it

    function test_onlyTheOriginCanReverse() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        uint256 tid = _onlyTransferId();

        vm.prank(bob);
        vm.expectRevert(SlowArrival.NotOrigin.selector);
        arrival.reverse(tid, bob);

        vm.prank(alice);
        arrival.reverse(tid, alice);
    }

    function test_reverseIsRefusedAfterTheTimelock() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        uint256 tid = _onlyTransferId();
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(alice);
        vm.expectRevert(); // SLOW.TimelockExpired
        arrival.reverse(tid, alice);
    }

    function test_clawbackAfterTheGrace() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        uint256 tid = _onlyTransferId();

        vm.warp(block.timestamp + DELAY + 30 days + 1);
        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.clawback(tid, alice);
        assertEq(alice.balance, before + AMOUNT);
    }

    function test_zeroDelayArrivalHasNothingToOwn() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, 0, address(0), 0)
        );
        // Minted unlocked straight to bob: no pending entry, no claim to record.
        assertEq(slow.getOutboundTransfers(address(arrival)).length, 0);
        assertEq(slow.unlockedBalances(bob, _id(address(0), 0)), AMOUNT);
    }

    function test_recipientCanStillSettleNormally() public {
        portal.finalizeWithdrawal(
            alice, address(arrival), AMOUNT, _arriveCalldata(bob, DELAY, address(0), 0)
        );
        uint256 tid = _onlyTransferId();
        vm.warp(block.timestamp + DELAY + 1);

        uint256 before = bob.balance;
        vm.prank(bob);
        slow.claim(tid);
        assertEq(bob.balance, before + AMOUNT, "an arrived position settles like any other");
    }
}

// ────────────────────────────────────────────────────── why staticcall, not try

/// @notice The measurement behind `SlowOrigin._probe`. Solidity's `try/catch`
///         cannot be pointed at an arbitrary `msg.sender`: it does not catch the
///         `extcodesize` check that precedes a call to a codeless address, and
///         it does not catch the ABI decode that follows a call returning
///         nothing. A raw `staticcall` survives both.
contract SlowOriginProbeTest is Test {
    function _try(address who) internal view returns (bool ok) {
        try IAnswers(who).l2Sender() returns (address) {
            return true;
        } catch {
            return false;
        }
    }

    function _staticcall(address who) internal view returns (bool ok) {
        (bool s, bytes memory d) =
            who.staticcall(abi.encodeWithSelector(IAnswers.l2Sender.selector));
        return s && d.length == 32;
    }

    function test_tryCatchRevertsOnACodelessAddress() public {
        // Not `expectRevert` on the helper — the revert happens in this frame.
        (bool ok,) = address(this).call(abi.encodeCall(this.probeTry, (address(0xBEEF))));
        assertFalse(ok, "try/catch does NOT survive a call to an EOA");
    }

    function test_staticcallSurvivesACodelessAddress() public view {
        assertFalse(_staticcall(address(0xBEEF)), "no answer, but no revert either");
    }

    function test_tryCatchRevertsOnAnEmptyReturn() public {
        Silent s = new Silent();
        (bool ok,) = address(this).call(abi.encodeCall(this.probeTry, (address(s))));
        assertFalse(ok, "try/catch does NOT survive a short return");
    }

    function test_staticcallSurvivesAnEmptyReturn() public {
        Silent s = new Silent();
        assertFalse(_staticcall(address(s)));
    }

    function probeTry(address who) external view returns (bool) {
        return _try(who);
    }
}

interface IAnswers {
    function l2Sender() external view returns (address);
}

contract Silent {
    fallback() external {}
}
