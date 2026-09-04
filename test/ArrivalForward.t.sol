// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {SLOW} from "../src/SLOW.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

/// @dev An OP portal, from the SEND side: `depositTransaction` mints `msg.value`
///      on the far side and calls `to` with `value`. Here it just records what
///      it was asked to do, which is what the forward has to get right.
contract MockPortalSend {
    address public lastTo;
    uint256 public lastValue;
    uint64 public lastGas;
    bytes public lastData;
    uint256 public received;
    bool public revertOnCall;

    function setRevert(bool v) external {
        revertOnCall = v;
    }

    function depositTransaction(
        address to,
        uint256 value,
        uint64 gasLimit,
        bool,
        bytes calldata data
    ) external payable {
        require(!revertOnCall, "portal down");
        lastTo = to;
        lastValue = value;
        lastGas = gasLimit;
        lastData = data;
        received += msg.value;
    }
}

/// @dev An Arbitrum inbox from the send side, with a real submission fee so the
///      forward's live pricing is exercised rather than stubbed to zero.
contract MockInboxSend {
    uint256 public feePerByte = 100;
    address public lastTo;
    uint256 public lastCallValue;
    uint256 public lastSubmission;
    bytes public lastData;
    uint256 public received;

    /// @dev How the fee getter misbehaves. `r.entry` is a PROXY on every real
    ///      chain, so its implementation can become any of these after
    ///      `SlowArrival` is deployed and can never be re-pointed.
    enum Fee {
        NORMAL,
        BURN_GAS, // spends everything it is given, then reverts
        HUGE, // an answer wide enough to overflow the 3/2 scaling
        FLOOD // returns megabytes, to bill the caller's frame for the copy
    }

    Fee public feeMode;

    function setFeeMode(Fee m) external {
        feeMode = m;
    }

    function calculateRetryableSubmissionFee(uint256 dataLength, uint256)
        external
        view
        returns (uint256)
    {
        if (feeMode == Fee.BURN_GAS) {
            uint256 x = 1;
            while (true) {
                x = uint256(keccak256(abi.encode(x)));
            }
        }
        if (feeMode == Fee.HUGE) return type(uint256).max;
        if (feeMode == Fee.FLOOD) {
            uint256 n = 524_288; // 512KB: the copy alone outweighs a real gas budget
            bytes memory big = new bytes(n);
            assembly {
                return(add(big, 0x20), n)
            }
        }
        return dataLength * feePerByte;
    }

    function setFee(uint256 v) external {
        feePerByte = v;
    }

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address,
        address,
        uint256,
        uint256,
        bytes calldata data
    ) external payable returns (uint256) {
        lastTo = to;
        lastCallValue = l2CallValue;
        lastSubmission = maxSubmissionCost;
        lastData = data;
        received += msg.value;
        return 1;
    }
}

/// @dev The RECEIVING side of an OP withdrawal: it sets `l2Sender` and calls the
///      target itself. This is what actually lands a `forward`, and the only
///      shape in which an origin hint is authenticated rather than refused.
contract MockFinalisingPortal {
    address public l2Sender = SlowOrigin.DEAD;

    function finalize(address from, address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bool ok)
    {
        l2Sender = from;
        (ok,) = target.call{value: value}(data);
        l2Sender = SlowOrigin.DEAD;
    }
}

contract ArrivalForwardTest is Test {
    SLOW internal slow;
    SlowArrival internal arrival;
    MockPortalSend internal portal;
    MockInboxSend internal inbox;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal keeper = address(0xCAFE01);

    uint96 internal constant DELAY = 3 days;
    uint256 internal constant AMOUNT = 1 ether;
    uint64 internal constant FWD_GAS = 1_000_000;
    uint128 internal constant FWD_FEE = 1 gwei;

    function setUp() public {
        slow = new SLOW(address(0), address(0));
        portal = new MockPortalSend();
        inbox = new MockInboxSend();

        uint256[] memory ids = new uint256[](2);
        SlowArrival.Route[] memory routes = new SlowArrival.Route[](2);
        ids[0] = 8453;
        routes[0] = SlowArrival.Route(address(portal), 1, FWD_GAS, FWD_FEE);
        ids[1] = 4663;
        routes[1] = SlowArrival.Route(address(inbox), 2, FWD_GAS, FWD_FEE);

        arrival = new SlowArrival(address(slow), ids, routes);
        vm.warp(1_700_000_000);
        vm.deal(alice, 100 ether);
    }

    function _forward(address caller, uint256 dst, address to, address hint, uint256 bounty)
        internal
        returns (bool ok)
    {
        return _forwardWithGas(caller, dst, to, hint, bounty, gasleft());
    }

    /// @dev The same, on a REALISTIC gas budget.
    ///
    ///      Forge hands a test effectively unbounded gas, and unbounded gas
    ///      hides every one of these bugs: 63/64 of a billion is still a
    ///      fortune, so a probe that burns everything it is given still leaves
    ///      the reserve intact and the assertion passes against the broken
    ///      contract. A finalisation on a real chain is a few million. That is
    ///      the number these have to be measured at, or they are not testing
    ///      anything.
    function _forwardWithGas(
        address caller,
        uint256 dst,
        address to,
        address hint,
        uint256 bounty,
        uint256 gasCap
    ) internal returns (bool ok) {
        vm.deal(caller, AMOUNT * 2);
        vm.prank(caller, caller == keeper ? keeper : caller);
        (ok,) = address(arrival).call{value: AMOUNT, gas: gasCap}(
            abi.encodeCall(SlowArrival.forward, (dst, to, DELAY, hint, bounty))
        );
    }

    /// @dev What an OP finalisation actually carries, near enough.
    ///
    ///      The number matters. An uncapped probe that burns everything leaves
    ///      the caller 1/64 of whatever it started with, and at 2,000,000 that
    ///      remainder — ~30,000 — still covers the one cold SSTORE `rescue`
    ///      needs, so the broken contract SURVIVES and the test says nothing.
    ///      At 1,000,000 the remainder is ~15,600, the rescue write runs out,
    ///      and `forward` reverts: the actual failure, at a budget a real
    ///      finalisation plausibly carries.
    uint256 internal constant REAL_GAS = 1_000_000;

    // ────────────────────────────────────────────────── the OP Stack leg

    function test_forwardToAnOpChainCarriesValueAndCalldata() public {
        assertTrue(_forward(alice, 8453, bob, address(0), 0));

        assertEq(portal.received(), AMOUNT, "the whole payload went to the portal");
        assertEq(portal.lastTo(), address(arrival), "addressed to itself on the far side");
        assertEq(portal.lastValue(), AMOUNT, "and mints the same amount there");
        assertEq(portal.lastGas(), FWD_GAS);

        // The onward call is an `arrive` naming the ORIGIN, with no bounty.
        bytes memory expected =
            abi.encodeCall(SlowArrival.arrive, (bob, DELAY, alice, uint256(0)));
        assertEq(portal.lastData(), expected, "arrive(to, delay, origin, 0)");
    }

    // ───────────────────────────────────────────────── the Arbitrum leg

    function test_forwardToAnArbitrumChainPricesTheTicketLive() public {
        assertTrue(_forward(alice, 4663, bob, address(0), 0));

        uint256 innerLen =
            abi.encodeCall(SlowArrival.arrive, (bob, DELAY, alice, uint256(0))).length;
        uint256 submission = (innerLen * 100) * 3 / 2; // the mock's fee, over-bought
        uint256 gasCost = uint256(FWD_GAS) * uint256(FWD_FEE);

        assertEq(inbox.received(), AMOUNT, "the payload funds the ticket");
        assertEq(inbox.lastSubmission(), submission, "priced against the live base fee");
        assertEq(
            inbox.lastCallValue(),
            AMOUNT - submission - gasCost,
            "what lands is the payload less the ticket and the gas it prepays"
        );
        assertEq(inbox.lastTo(), address(arrival));
    }

    /// @notice A five-day-old send meets whatever fees exist on the day it lands,
    ///         so a fee that has grown past the payload must not be paid anyway.
    function test_aFeeLargerThanThePayloadIsRefusedNotPaid() public {
        inbox.setFee(1e16); // absurd, so submission alone exceeds the amount
        assertTrue(_forward(alice, 4663, bob, address(0), 0), "must not revert");
        assertEq(inbox.received(), 0, "nothing was handed to the bridge");
        assertEq(arrival.rescue(alice), AMOUNT, "held for the sender instead");
    }

    // ─────────────────────────────────── never revert, whatever happens

    function test_anUnknownDestinationIsRescuedNotReverted() public {
        assertTrue(_forward(alice, 999999, bob, address(0), 0), "must not revert");
        assertEq(arrival.rescue(alice), AMOUNT);
    }

    function test_aFailingEntrypointIsRescuedNotReverted() public {
        portal.setRevert(true);
        assertTrue(_forward(alice, 8453, bob, address(0), 0), "must not revert");
        assertEq(portal.received(), 0);
        assertEq(arrival.rescue(alice), AMOUNT, "the payload survives a dead bridge");
    }

    function test_forwardingToThisChainIsRefused() public {
        // Configured, but the same chain: forwarding here would be a loop.
        uint256[] memory ids = new uint256[](1);
        SlowArrival.Route[] memory routes = new SlowArrival.Route[](1);
        ids[0] = block.chainid;
        routes[0] = SlowArrival.Route(address(portal), 1, FWD_GAS, FWD_FEE);
        SlowArrival a2 = new SlowArrival(address(slow), ids, routes);

        vm.prank(alice, alice);
        (bool ok,) = address(a2).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.forward, (block.chainid, bob, DELAY, address(0), uint256(0)))
        );
        assertTrue(ok);
        assertEq(a2.rescue(alice), AMOUNT);
    }

    // ─────────────────────────────────────────────────────── the bounty

    /// @notice This leg HAS a finaliser — someone proved and finalised the
    ///         withdrawal that landed it — so the bounty is settled here. The
    ///         next leg executes on its own, which is why the onward `arrive`
    ///         carries a bounty of zero.
    function test_theBountyIsPaidHereAndNotPassedOn() public {
        uint256 bounty = 0.01 ether;
        vm.deal(keeper, 0);
        MockFinalisingPortal fin = new MockFinalisingPortal();
        vm.deal(address(fin), AMOUNT * 2);

        // A real finaliser: the portal calls, and `tx.origin` is whoever pushed
        // the button. The portal's `l2Sender()` is what authenticates Alice.
        vm.prank(keeper, keeper);
        bool ok = fin.finalize(
            alice,
            address(arrival),
            AMOUNT,
            abi.encodeCall(SlowArrival.forward, (8453, bob, DELAY, alice, bounty))
        );
        assertTrue(ok);
        assertEq(keeper.balance, bounty, "the finaliser was paid on this side");
        assertEq(portal.received(), AMOUNT - bounty, "and the rest went on");

        bytes memory expected =
            abi.encodeCall(SlowArrival.arrive, (bob, DELAY, alice, uint256(0)));
        assertEq(portal.lastData(), expected, "the onward leg carries no bounty");
    }

    // ──────────────────────────── the reason this needed a new branch

    /// @notice THE DEFECT THIS DESIGN NEARLY REINTRODUCED. A forwarded message
    ///         arrives on the far side from THIS CONTRACT, which is a contract,
    ///         so it is aliased. `SlowOrigin`'s probes all miss and its hint
    ///         branch cannot match — the hint names the original sender, not
    ///         this contract — so recovery would fall through to `msg.sender`
    ///         and hand the position to an address with no key.
    ///
    ///         `_recoverOrigin` adds the one branch that saves it: a caller at
    ///         `applyAlias(address(this))` is this contract on another chain,
    ///         and nobody can put code there.
    function test_theOriginSurvivesTheForwardsOwnAlias() public {
        address selfAlias = SlowOrigin.applyAlias(address(arrival));
        vm.deal(selfAlias, AMOUNT);

        vm.prank(selfAlias, selfAlias);
        (bool ok,) = address(arrival).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.arrive, (bob, DELAY, alice, uint256(0)))
        );
        assertTrue(ok);

        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        assertEq(out.length, 1);
        assertEq(arrival.originOf(out[0]), alice, "Alice keeps the reverse across the hop");

        uint256 before = alice.balance;
        vm.prank(alice);
        arrival.reverse(out[0], alice);
        assertEq(alice.balance, before + AMOUNT, "and can actually use it");
    }

    /// @notice The same branch must not become a way to forge an origin from an
    ///         ordinary caller.
    function test_onlyOurOwnAliasGetsThatTrust() public {
        address otherAlias = SlowOrigin.applyAlias(address(0xDECAF));
        vm.deal(otherAlias, AMOUNT);
        vm.prank(otherAlias, otherAlias);
        (bool ok,) = address(arrival).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.arrive, (bob, DELAY, alice, uint256(0)))
        );
        assertTrue(ok);
        uint256[] memory out = slow.getOutboundTransfers(address(arrival));
        // alias(0xDECAF) is not alias(arrival), so the hint is not believed on
        // that branch — it is checked the ordinary way and refused.
        assertTrue(arrival.originOf(out[0]) != alice, "a stranger cannot name Alice");
    }

    /// @notice There is no setter, so what a deployment writes is permanent.
    function test_theRoutesCannotBeChangedAfterDeployment() public view {
        (address entry, uint8 kind, uint64 gasLimit,) = arrival.routeTo(8453);
        assertEq(entry, address(portal));
        assertEq(kind, 1);
        assertEq(gasLimit, FWD_GAS);
        // No function on this contract writes routeTo outside the constructor;
        // the ABI simply has no setter to call.
    }

    // ───────────────────── the fee probe is a call to somebody else's proxy

    /* `r.entry` looks like a trusted constant because it is fixed at
       construction, but on every real chain it is a PROXY: the address is
       frozen and the code behind it is not. So the one call this contract makes
       into it before committing has to survive whatever it becomes — and
       `forward` may not revert whatever happens, because on the OP leg the
       portal has already marked the withdrawal finalised. Each of these three
       reverted `forward` outright before the probe was bounded. */

    function test_aFeeGetterThatBurnsGasIsRescuedNotReverted() public {
        inbox.setFeeMode(MockInboxSend.Fee.BURN_GAS);
        assertTrue(
            _forwardWithGas(alice, 4663, bob, address(0), 0, REAL_GAS), "must not revert"
        );
        assertEq(inbox.received(), 0, "nothing was handed to the bridge");
        assertEq(arrival.rescue(alice), AMOUNT, "the reserve survived the probe");
    }

    function test_aFeeWiderThanThePayloadIsRescuedNotOverflowed() public {
        // `submission * 3 / 2` on type(uint256).max overflows, and a checked
        // overflow is a revert — which is the one outcome forbidden here.
        inbox.setFeeMode(MockInboxSend.Fee.HUGE);
        assertTrue(
            _forwardWithGas(alice, 4663, bob, address(0), 0, REAL_GAS), "must not revert"
        );
        assertEq(inbox.received(), 0);
        assertEq(arrival.rescue(alice), AMOUNT);
    }

    function test_aFloodingFeeGetterIsRescuedNotReverted() public {
        // Half a megabyte of return data. Read into `bytes memory` the copy
        // charges THIS frame quadratic memory expansion — ~570k on its own,
        // which is most of a real budget and more than the reserve was ever
        // holding. Behind a gas cap the callee cannot even allocate it, and
        // behind a fixed 32-byte window the caller would not copy it if it
        // could. Both protections land on this one; neither is testable alone,
        // because a callee has to pay for the memory before it can return it.
        inbox.setFeeMode(MockInboxSend.Fee.FLOOD);
        assertTrue(
            _forwardWithGas(alice, 4663, bob, address(0), 0, REAL_GAS), "must not revert"
        );
        assertEq(inbox.received(), 0);
        assertEq(arrival.rescue(alice), AMOUNT);
    }

    function test_aHealthyFeeGetterStillPricesAndSends() public {
        // The guard rails must not have closed the road: the normal path is
        // unchanged, priced live, and still reaches the inbox.
        assertTrue(_forwardWithGas(alice, 4663, bob, address(0), 0, REAL_GAS));
        assertEq(inbox.received(), AMOUNT);
        assertEq(arrival.rescue(alice), 0);
    }
}
