// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test} from "../lib/forge-std/src/Test.sol";
import {SLOWNext} from "../src/SLOWNext.sol";
import {SlowRelay} from "../src/SlowRelay.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        if (msg.sender != f) allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[t] += v;
        return true;
    }
}

/// @dev A trusted inbox: the shape of an L1CrossDomainMessenger or a portal.
contract MockInbox {
    address public l2Sender = SlowOrigin.DEAD;

    function relay(address from, address target, bytes calldata data) external {
        l2Sender = from;
        (bool ok, bytes memory ret) = target.call(data);
        l2Sender = SlowOrigin.DEAD;
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @dev The attack `SlowArrival` can safely ignore and `SlowRelay` cannot: a
///      contract that simply claims to be a bridge carrying a message from
///      SlowRelay on another chain.
contract ForgedInbox {
    address public l2Sender;

    constructor(address claim) {
        l2Sender = claim;
    }

    function push(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

contract SlowRelayTest is Test {
    SLOWNext internal slow;
    SlowRelay internal relay;
    MockERC20 internal token;
    MockInbox internal inbox;

    uint64 internal constant SRC = 8453; // Base
    uint64 internal constant DST = 4663; // Robinhood Chain

    uint256 internal constant ALICE_PK = 0xA11CE;
    address internal alice;
    address internal bob = address(0xB0B);
    address internal relayer = address(0x5E11E5);

    uint256 internal constant AMOUNT = 1 ether;
    uint256 internal constant FEE = 0.002 ether;
    uint96 internal constant DELAY = 3 days;

    function setUp() public {
        vm.chainId(SRC);
        slow = new SLOWNext(address(0), address(0));
        inbox = new MockInbox();
        address[] memory inboxes = new address[](1);
        inboxes[0] = address(inbox);
        relay = new SlowRelay(address(slow), inboxes);
        token = new MockERC20();

        alice = vm.addr(ALICE_PK);
        vm.deal(alice, 100 ether);
        vm.deal(relayer, 100 ether);
        token.mint(alice, 100 ether);
        token.mint(relayer, 100 ether);
        vm.warp(1_700_000_000);
    }

    // ─────────────────────────────────────────────────────────── helpers

    function _intent(address tok) internal view returns (SlowRelay.Intent memory i) {
        i = SlowRelay.Intent({
            sender: alice,
            recipient: bob,
            srcToken: tok,
            dstToken: tok,
            amount: AMOUNT,
            fee: FEE,
            delay: DELAY,
            srcChainId: SRC,
            dstChainId: DST,
            fillDeadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
    }

    function _id(address tok, uint96 delay) internal pure returns (uint256) {
        return (uint256(delay) << 160) | uint256(uint160(tok));
    }

    // ────────────────────────────────────────────────────── opening doors

    function test_openEscrowsAsAnUnlockedSlowPosition() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        bytes32 id = relay.open{value: AMOUNT + FEE}(i);

        assertEq(uint8(relay.statusOf(id)), 1, "OPEN");
        assertEq(relay.escrowIdOf(id), 0, "zero-delay ETH id");
        assertEq(
            slow.unlockedBalances(address(relay), 0),
            AMOUNT + FEE,
            "the escrow IS a SLOW position"
        );
        // Zero delay means no pending entry, so nothing anyone can reverse.
        assertEq(slow.getOutboundTransfers(address(relay)).length, 0);
    }

    function test_openTokenEscrowsTheSameShape() public {
        SlowRelay.Intent memory i = _intent(address(token));
        vm.startPrank(alice);
        token.approve(address(relay), AMOUNT + FEE);
        bytes32 id = relay.openToken(i);
        vm.stopPrank();

        assertEq(relay.escrowIdOf(id), uint256(uint160(address(token))));
        assertEq(
            slow.unlockedBalances(address(relay), uint256(uint160(address(token)))), AMOUNT + FEE
        );
    }

    /// @notice The one-transaction door: a SLOW position handed straight over,
    ///         with the intent riding in the `data` `safeTransferFrom` forwards.
    function test_erc1155DoorOpensTheEscrowInOneTransaction() public {
        // Alice already holds an unlocked, zero-delay position.
        vm.prank(alice);
        slow.depositTo{value: AMOUNT + FEE}(address(0), alice, 0, 0, "");
        assertEq(slow.unlockedBalances(alice, 0), AMOUNT + FEE);

        SlowRelay.Intent memory i = _intent(address(0));
        bytes32 id = keccak256(abi.encode(i));

        vm.prank(alice);
        slow.safeTransferFrom(alice, address(relay), 0, AMOUNT + FEE, abi.encode(i));

        assertEq(uint8(relay.statusOf(id)), 1, "opened by the transfer itself");
        assertEq(slow.unlockedBalances(address(relay), 0), AMOUNT + FEE);
        assertEq(slow.unlockedBalances(alice, 0), 0);
    }

    function test_erc1155DoorWorksForAnErc20BackedPosition() public {
        vm.startPrank(alice);
        token.approve(address(slow), AMOUNT + FEE);
        slow.depositTo(address(token), alice, AMOUNT + FEE, 0, "");
        SlowRelay.Intent memory i = _intent(address(token));
        slow.safeTransferFrom(
            alice, address(relay), uint256(uint160(address(token))), AMOUNT + FEE, abi.encode(i)
        );
        vm.stopPrank();
        assertEq(uint8(relay.statusOf(keccak256(abi.encode(i)))), 1);
    }

    /// @notice The guard that keeps the escrow an escrow. A delayed id would
    ///         arrive as a NEW pending transfer the sender can reverse for the
    ///         whole timelock — after a relayer had already paid out.
    function test_erc1155DoorRefusesADelayedId() public {
        // Give Alice an unlocked balance at a DELAYED id, the way a settled
        // inbound transfer leaves one.
        vm.prank(bob);
        vm.deal(bob, 10 ether);
        uint256 tid = slow.depositTo{value: AMOUNT + FEE}(address(0), alice, 0, DELAY, "");
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(alice);
        slow.unlock(tid); // only `pt.to` may unlock
        uint256 delayedId = _id(address(0), DELAY);
        assertEq(slow.unlockedBalances(alice, delayedId), AMOUNT + FEE);

        SlowRelay.Intent memory i = _intent(address(0));
        i.fillDeadline = uint64(block.timestamp + 1 hours);

        vm.prank(alice);
        vm.expectRevert(SlowRelay.DelayedIdRefused.selector);
        slow.safeTransferFrom(alice, address(relay), delayedId, AMOUNT + FEE, abi.encode(i));
    }

    function test_erc1155DoorRefusesAMismatchedAmount() public {
        vm.prank(alice);
        slow.depositTo{value: 5 ether}(address(0), alice, 0, 0, "");
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        vm.expectRevert(SlowRelay.BadValue.selector);
        slow.safeTransferFrom(alice, address(relay), 0, 5 ether, abi.encode(i));
    }

    function test_erc1155PlainGiftIsAccepted() public {
        vm.prank(alice);
        slow.depositTo{value: 1 ether}(address(0), alice, 0, 0, "");
        vm.prank(alice);
        slow.safeTransferFrom(alice, address(relay), 0, 1 ether, "");
        assertEq(slow.unlockedBalances(address(relay), 0), 1 ether);
    }

    // ────────────────────────────────────────────────────────── filling

    function _openAndFill() internal returns (SlowRelay.Intent memory i, bytes32 id, uint256 tid) {
        i = _intent(address(0));
        id = keccak256(abi.encode(i));
        vm.prank(alice);
        relay.open{value: AMOUNT + FEE}(i);

        vm.chainId(DST);
        vm.prank(relayer);
        tid = relay.fill{value: AMOUNT}(i);
    }

    function test_fillDeliversTheRecipientsLeg() public {
        (, bytes32 id, uint256 tid) = _openAndFill();
        assertEq(relay.filledBy(id), relayer);

        (, address from, address to, uint256 sid, uint256 amount) = slow.pendingTransfers(tid);
        assertEq(from, address(relay), "the relay is pt.from, not the relayer");
        assertEq(to, bob);
        assertEq(amount, AMOUNT);
        assertEq(sid, _id(address(0), DELAY), "the delay is passed through unchanged");
    }

    function test_recipientSettlesTheFillLikeAnyOtherPosition() public {
        (,, uint256 tid) = _openAndFill();
        vm.warp(block.timestamp + DELAY + 1);
        uint256 before = bob.balance;
        vm.prank(bob);
        slow.claim(tid);
        assertEq(bob.balance, before + AMOUNT);
    }

    function test_theRelayerCannotReverseTheFill() public {
        (,, uint256 tid) = _openAndFill();
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.NotOrigin.selector);
        relay.reverse(tid, relayer);
        // Nor directly: pt.from is the relay contract, which has no such path.
        vm.prank(relayer);
        vm.expectRevert();
        slow.reverse(tid);
    }

    /// @notice Reversing a cross-chain send returns the money on the FAR side.
    function test_theSenderReversesOnTheFarSide() public {
        (,, uint256 tid) = _openAndFill();
        uint256 before = alice.balance;
        vm.prank(alice);
        relay.reverse(tid, alice);
        assertEq(alice.balance, before + AMOUNT, "Alice holds her funds on the destination");
    }

    function test_aSecondFillIsRefused() public {
        (SlowRelay.Intent memory i,,) = _openAndFill();
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.AlreadyFilled.selector);
        relay.fill{value: AMOUNT}(i);
    }

    function test_fillOnTheWrongChainIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        relay.open{value: AMOUNT + FEE}(i);
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.WrongChain.selector); // still on SRC
        relay.fill{value: AMOUNT}(i);
    }

    function test_fillAfterTheDeadlineIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        relay.open{value: AMOUNT + FEE}(i);
        vm.chainId(DST);
        vm.warp(uint256(i.fillDeadline) + 1);
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.DeadlinePassed.selector);
        relay.fill{value: AMOUNT}(i);
    }

    // ──────────────────────────────────────────────────── proving, safely

    /// @notice THE security test. Duck-typing alone is forgeable, so an inbound
    ///         proof must also arrive through a bridge this contract was told
    ///         about. Without this check the forged inbox below drains every
    ///         escrow on the chain.
    function test_aForgedInboxCannotProveAnything() public {
        (SlowRelay.Intent memory i, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);

        ForgedInbox forged = new ForgedInbox(address(relay)); // claims to carry OUR message
        vm.expectRevert(SlowRelay.UntrustedMessenger.selector);
        forged.push(address(relay), abi.encodeCall(SlowRelay.receiveRelay, (id, address(0xBAD))));

        assertEq(relay.provenBy(id), address(0));
        vm.expectRevert(SlowRelay.NotProven.selector);
        relay.release(i);
    }

    function test_aTrustedInboxCarryingSomeoneElseIsRefused() public {
        (, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        // Right bridge, wrong origin: the message did not come from SlowRelay.
        vm.expectRevert(SlowRelay.UntrustedMessenger.selector);
        inbox.relay(
            address(0xDECAF),
            address(relay),
            abi.encodeCall(SlowRelay.receiveRelay, (id, relayer))
        );
    }

    function test_aTrustedInboxCarryingUsIsAccepted() public {
        (, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        inbox.relay(
            address(relay), address(relay), abi.encodeCall(SlowRelay.receiveRelay, (id, relayer))
        );
        assertEq(relay.provenBy(id), relayer);
    }

    /// @notice The branch that needs no allowlist at all: an L1→L2 message from
    ///         this contract arrives aliased, and nobody can put code at that
    ///         address to forge it.
    function test_ourOwnAliasIsAcceptedWithoutAnAllowlist() public {
        (, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        vm.prank(SlowOrigin.applyAlias(address(relay)));
        relay.receiveRelay(id, relayer);
        assertEq(relay.provenBy(id), relayer);
    }

    function test_someoneElsesAliasIsNotAccepted() public {
        (, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        vm.prank(SlowOrigin.applyAlias(address(0xDECAF)));
        vm.expectRevert(SlowRelay.UntrustedMessenger.selector);
        relay.receiveRelay(id, relayer);
    }

    // ────────────────────────────────────────────────────────── paying out

    function test_releasePaysTheRelayerFromTheEscrow() public {
        (SlowRelay.Intent memory i, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        vm.prank(SlowOrigin.applyAlias(address(relay)));
        relay.receiveRelay(id, relayer);

        uint256 before = relayer.balance;
        relay.release(i);
        assertEq(relayer.balance, before + AMOUNT + FEE, "principal plus the fee");
        assertEq(uint8(relay.statusOf(id)), 2, "RELEASED");
        assertEq(slow.unlockedBalances(address(relay), 0), 0, "escrow emptied");
    }

    function test_releaseTwiceIsRefused() public {
        (SlowRelay.Intent memory i, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        vm.prank(SlowOrigin.applyAlias(address(relay)));
        relay.receiveRelay(id, relayer);
        relay.release(i);
        vm.expectRevert(SlowRelay.NotOpen.selector);
        relay.release(i);
    }

    function test_cancelRefundsTheSenderAfterTheDeadline() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        relay.open{value: AMOUNT + FEE}(i);

        // Past the deadline AND the proof window: a fill delivered inside the
        // window has to have had time to prove itself before a refund can land.
        vm.warp(uint256(i.fillDeadline) + 8 days + 1);
        uint256 before = alice.balance;
        vm.prank(alice);
        relay.cancel(i);
        assertEq(alice.balance, before + AMOUNT + FEE, "unconditional, and whole");
    }

    function test_cancelBeforeTheDeadlineIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.prank(alice);
        relay.open{value: AMOUNT + FEE}(i);
        vm.prank(alice);
        vm.expectRevert(SlowRelay.DeadlineNotPassed.selector);
        relay.cancel(i);
    }

    function test_cancelIsBlockedOnceAFillIsProven() public {
        (SlowRelay.Intent memory i, bytes32 id,) = _openAndFill();
        vm.chainId(SRC);
        // The proof lands when a canonical exit actually delivers it, which is
        // days after the fill — not in the same block. Warping first is the
        // whole point: an earlier version of this test proved the relay here
        // and then warped, which modelled zero proof latency and let the
        // cancel-before-proof drain sit green underneath it.
        vm.warp(uint256(i.fillDeadline) + 8 days + 1);
        vm.prank(SlowOrigin.applyAlias(address(relay)));
        relay.receiveRelay(id, relayer);

        vm.prank(alice);
        vm.expectRevert(SlowRelay.NotOpen.selector);
        relay.cancel(i);
    }

    /// THE DRAIN THIS GRACE PERIOD EXISTS TO STOP. A sender opens with a short
    /// window, a relayer delivers real funds, and the sender refunds the escrow
    /// while the relayer's proof is still days from landing. Before the grace
    /// this cancel succeeded and the relayer's capital was simply gone.
    function test_cancelCannotOutrunAnUnprovenFill() public {
        (SlowRelay.Intent memory i,,) = _openAndFill();
        vm.chainId(SRC);

        vm.warp(uint256(i.fillDeadline) + 1);
        vm.prank(alice);
        vm.expectRevert(SlowRelay.DeadlineNotPassed.selector);
        relay.cancel(i);

        // Still refused one second before the window closes.
        vm.warp(uint256(i.fillDeadline) + 8 days);
        vm.prank(alice);
        vm.expectRevert(SlowRelay.DeadlineNotPassed.selector);
        relay.cancel(i);
    }

    // ──────────────────────────────────────────────────────── the slip

    function _sign(SlowRelay.Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = relay.slipDigest(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_aSignedSlipLetsARelayerOpenTheEscrow() public {
        SlowRelay.Intent memory i = _intent(address(token));
        vm.prank(alice);
        token.approve(address(relay), AMOUNT + FEE);

        bytes memory sig = _sign(i);
        // Alice sends nothing. The relayer submits her leg.
        vm.prank(relayer);
        bytes32 id = relay.openFor(i, sig);

        assertEq(uint8(relay.statusOf(id)), 1);
        assertEq(
            slow.unlockedBalances(address(relay), uint256(uint160(address(token)))), AMOUNT + FEE
        );
    }

    /// @notice The chain binding, which is not optional. This contract has the
    ///         SAME ADDRESS on every chain, so `verifyingContract` cannot
    ///         separate a Base slip from a Robinhood one — only `chainId` can.
    function test_aSlipIsBoundToTheChainItWasSignedFor() public {
        SlowRelay.Intent memory i = _intent(address(token));
        bytes32 onSrc = relay.slipDigest(i);

        // A deep copy: `memory` assignment is a reference, and mutating a
        // shared struct would silently re-sign the thing under test.
        SlowRelay.Intent memory j = SlowRelay.Intent({
            sender: i.sender,
            recipient: i.recipient,
            srcToken: i.srcToken,
            dstToken: i.dstToken,
            amount: i.amount,
            fee: i.fee,
            delay: i.delay,
            srcChainId: DST, // same terms, other chain
            dstChainId: SRC,
            fillDeadline: i.fillDeadline,
            nonce: i.nonce
        });
        bytes32 onDst = relay.slipDigest(j);

        assertTrue(onSrc != onDst, "a slip for one chain is not a slip for another");

        // And a signature over the Base slip does not open the Robinhood one.
        vm.chainId(DST);
        vm.prank(alice);
        token.approve(address(relay), AMOUNT + FEE);
        // Signed before the expectation is armed: `_sign` itself calls the
        // contract, and `expectRevert` would otherwise land on that call.
        bytes memory sigForSrc = _sign(i);
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.BadSignature.selector);
        relay.openFor(j, sigForSrc);
    }

    function test_aSlipCannotBeUsedTwice() public {
        SlowRelay.Intent memory i = _intent(address(token));
        vm.prank(alice);
        token.approve(address(relay), 10 ether);
        bytes memory sig = _sign(i);
        vm.prank(relayer);
        relay.openFor(i, sig);

        vm.prank(relayer);
        vm.expectRevert(SlowRelay.SlipUsed.selector);
        relay.openFor(i, sig);
    }

    function test_aSlipSignedByTheWrongKeyIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(token));
        bytes32 digest = relay.slipDigest(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBEEF, digest);
        vm.prank(relayer);
        vm.expectRevert(SlowRelay.BadSignature.selector);
        relay.openFor(i, abi.encodePacked(r, s, v));
    }

    // ──────────────────────────────────────────── the two-token identity

    /// @notice One address cannot name the same asset on two chains. USDC on
    ///         Base and whatever sits at that address on Robinhood are unrelated
    ///         contracts, so an intent carrying a single `token` field let a
    ///         relayer deliver something worthless at the same address and then
    ///         collect the real escrow. The sender names both legs now, and the
    ///         id commits to both, so neither can be substituted.
    function test_theEscrowedAssetAndTheDeliveredAssetAreNamedSeparately() public {
        MockERC20 onSrc = token;
        MockERC20 onDst = new MockERC20(); // the same asset, different address
        onDst.mint(relayer, 100 ether);

        SlowRelay.Intent memory i = _intent(address(onSrc));
        i.dstToken = address(onDst);
        bytes32 id = relay.intentId(i);

        vm.startPrank(alice);
        onSrc.approve(address(relay), AMOUNT + FEE);
        relay.openToken(i);
        vm.stopPrank();
        assertEq(onSrc.balanceOf(address(slow)), AMOUNT + FEE, "the source asset is escrowed");

        vm.chainId(DST);
        vm.startPrank(relayer);
        onDst.approve(address(relay), AMOUNT);
        uint256 tid = relay.fill(i);
        vm.stopPrank();

        (,, address to, uint256 sid,) = slow.pendingTransfers(tid);
        assertEq(to, bob);
        assertEq(
            sid,
            (uint256(DELAY) << 160) | uint256(uint160(address(onDst))),
            "the recipient is delivered the asset the SENDER named, not the escrow's"
        );
        assertEq(relay.filledBy(id), relayer);
    }

    /// @notice Substituting either leg produces a different intent, so a fill of
    ///         it can never be released against this escrow.
    function test_substitutingEitherLegChangesTheIntent() public {
        SlowRelay.Intent memory i = _intent(address(token));
        bytes32 base = relay.intentId(i);

        SlowRelay.Intent memory swapped = _intent(address(token));
        swapped.dstToken = address(new MockERC20());
        assertTrue(relay.intentId(swapped) != base, "the delivered asset is committed");

        SlowRelay.Intent memory other = _intent(address(token));
        other.srcToken = address(new MockERC20());
        assertTrue(relay.intentId(other) != base, "so is the escrowed one");
    }

    // ─────────────────────────────────────────────────── the id itself

    /// @notice The intent id must be identical on both chains — it is the only
    ///         thing tying a fill on one to an escrow on the other. So it is a
    ///         plain struct hash, never an EIP-712 digest, which would fold in
    ///         the local chain id and differ on each side.
    function test_theIntentIdDoesNotDependOnWhereItIsComputed() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.chainId(SRC);
        bytes32 a = relay.intentId(i);
        vm.chainId(DST);
        bytes32 b = relay.intentId(i);
        assertEq(a, b);
    }

    function test_openOnTheWrongChainIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.chainId(DST);
        vm.prank(alice);
        vm.expectRevert(SlowRelay.WrongChain.selector);
        relay.open{value: AMOUNT + FEE}(i);
    }

    function test_openTwiceIsRefused() public {
        SlowRelay.Intent memory i = _intent(address(0));
        vm.startPrank(alice);
        relay.open{value: AMOUNT + FEE}(i);
        vm.expectRevert(SlowRelay.AlreadyOpen.selector);
        relay.open{value: AMOUNT + FEE}(i);
        vm.stopPrank();
    }
}

// ──────────────────────────────────────────────────────────────── TRANSPORT

contract MockOpMessengerPredeploy {
    address public lastTarget;
    bytes public lastMessage;
    uint32 public lastGas;

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external {
        lastTarget = target;
        lastMessage = message;
        lastGas = minGasLimit;
    }
}

contract MockArbSysPredeploy {
    address public lastTarget;
    bytes public lastMessage;

    function sendTxToL1(address destination, bytes calldata data)
        external
        payable
        returns (uint256)
    {
        lastTarget = destination;
        lastMessage = data;
        return 1;
    }
}

contract MockPortalEntry {
    address public lastTo;
    bytes public lastData;
    uint64 public lastGas;

    function depositTransaction(
        address to,
        uint256,
        uint64 gasLimit,
        bool,
        bytes calldata data
    ) external payable {
        lastTo = to;
        lastData = data;
        lastGas = gasLimit;
    }
}

contract MockInboxEntry {
    address public lastTo;
    bytes public lastData;

    function createRetryableTicket(
        address to,
        uint256,
        uint256,
        address,
        address,
        uint256,
        uint256,
        bytes calldata data
    ) external payable returns (uint256) {
        lastTo = to;
        lastData = data;
        return 1;
    }
}

/// @notice The one part of the relay that cannot be composed by the page: the
///         proof has to be SENT by this contract, because the far side
///         authenticates on `origin == address(this)`. Only L2 predeploys are
///         compiled in — they sit at the same address on every chain of their
///         family, by protocol rather than by deployment — and which family we
///         are on is read off which predeploy has code, not configured.
contract SlowRelayTransportTest is Test {
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;
    address internal constant OP_MESSENGER = 0x4200000000000000000000000000000000000007;

    SLOWNext internal slow;
    SlowRelay internal relay;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal relayer = address(0x5E11E5);

    uint64 internal constant SRC = 8453;
    uint64 internal constant DST = 4663;
    uint256 internal constant AMOUNT = 1 ether;
    uint256 internal constant FEE = 0.002 ether;

    function setUp() public {
        vm.chainId(DST);
        slow = new SLOWNext(address(0), address(0));
        relay = new SlowRelay(address(slow), new address[](0));
        vm.deal(relayer, 100 ether);
        vm.warp(1_700_000_000);
    }

    function _intent() internal view returns (SlowRelay.Intent memory) {
        return SlowRelay.Intent({
            sender: alice,
            recipient: bob,
            srcToken: address(0),
            dstToken: address(0),
            amount: AMOUNT,
            fee: FEE,
            delay: 3 days,
            srcChainId: SRC,
            dstChainId: DST,
            fillDeadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
    }

    function _fill() internal returns (SlowRelay.Intent memory i, bytes32 id) {
        i = _intent();
        id = relay.intentId(i);
        vm.prank(relayer);
        relay.fill{value: AMOUNT}(i);
    }

    function test_proveFillLeavesAnOpChainThroughTheMessenger() public {
        // The messenger, not the raw L2ToL1MessagePasser: a messenger-relayed
        // message is replayable if it fails on L1, and a portal withdrawal is not.
        vm.etch(OP_MESSENGER, address(new MockOpMessengerPredeploy()).code);
        (SlowRelay.Intent memory i, bytes32 id) = _fill();

        relay.proveFill(i);

        MockOpMessengerPredeploy m = MockOpMessengerPredeploy(OP_MESSENGER);
        assertEq(m.lastTarget(), address(relay), "addressed to ourselves on the far side");
        assertEq(
            m.lastMessage(),
            abi.encodeCall(SlowRelay.receiveRelay, (id, relayer)),
            "carries the intent and who filled it"
        );
    }

    function test_proveFillLeavesAnArbitrumChainThroughArbSys() public {
        vm.etch(ARB_SYS, address(new MockArbSysPredeploy()).code);
        (SlowRelay.Intent memory i, bytes32 id) = _fill();

        relay.proveFill(i);

        MockArbSysPredeploy m = MockArbSysPredeploy(ARB_SYS);
        assertEq(m.lastTarget(), address(relay));
        assertEq(m.lastMessage(), abi.encodeCall(SlowRelay.receiveRelay, (id, relayer)));
    }

    function test_proveFillHasNoRouteOnL1() public {
        (SlowRelay.Intent memory i,) = _fill();
        vm.expectRevert(SlowRelay.NoRoute.selector);
        relay.proveFill(i); // neither predeploy has code
    }

    function test_proveFillNeedsAFill() public {
        vm.etch(ARB_SYS, address(new MockArbSysPredeploy()).code);
        vm.expectRevert(SlowRelay.NotFilled.selector);
        relay.proveFill(_intent());
    }

    /// @notice `entry` is untrusted on purpose. A wrong one cannot steal — the
    ///         far side only accepts a message whose origin is this contract's
    ///         own address, arriving aliased — so the worst it does is waste the
    ///         gas of whoever passed it.
    function test_pushProofForwardsThroughACallerSuppliedEntry() public {
        (, bytes32 id) = _fill();
        MockPortalEntry entry = new MockPortalEntry();

        relay.pushProof(id, SlowRelay.Kind.OP_STACK, address(entry), 300_000, 0, 0);

        assertEq(entry.lastTo(), address(relay));
        assertEq(entry.lastGas(), 300_000);
        assertEq(entry.lastData(), abi.encodeCall(SlowRelay.receiveRelay, (id, relayer)));
    }

    function test_pushProofAlsoSpeaksArbitrum() public {
        (, bytes32 id) = _fill();
        MockInboxEntry entry = new MockInboxEntry();
        relay.pushProof(id, SlowRelay.Kind.ARBITRUM, address(entry), 600_000, 1 gwei, 1e14);
        assertEq(entry.lastTo(), address(relay));
        assertEq(entry.lastData(), abi.encodeCall(SlowRelay.receiveRelay, (id, relayer)));
    }

    function test_pushProofNeedsSomethingToForward() public {
        MockPortalEntry entry = new MockPortalEntry();
        vm.expectRevert(SlowRelay.NotProven.selector);
        relay.pushProof(bytes32(uint256(1)), SlowRelay.Kind.OP_STACK, address(entry), 300_000, 0, 0);
    }

    function test_pushProofRejectsAnUnknownFamily() public {
        (, bytes32 id) = _fill();
        vm.expectRevert(SlowRelay.NoRoute.selector);
        relay.pushProof(id, SlowRelay.Kind.NONE, address(0xBEEF), 300_000, 0, 0);
    }
}
