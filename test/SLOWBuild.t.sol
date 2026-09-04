// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {SLOW, SLOWGate} from "../src/SLOW.sol";
import {Test} from "../lib/forge-std/src/Test.sol";

/// @notice Coverage for the two extensions folded into the next build.
///
/// @dev WHY THIS FILE EXISTS. `test/SLOW.t.sol` exercises `src/SLOW.sol` — the
///      21,648-byte build frozen on mainnet. `SLOW` is what actually goes to
///      the new canonical address on every chain, and until this file it was
///      referenced by nothing but a render script. The delta between the two is
///      `SlowPermit` and `SlowGuardianIndex`, so that delta is what is tested
///      here; everything SLOW inherits unchanged is already covered next
///      door.
///
/// @dev No fork. `SLOW`'s constructor only writes two immutables and
///      CREATE2s its gate, so these run offline — which matters for a suite
///      meant to gate a deployment to three chains.
contract SLOWBuildTest is Test {
    SLOW internal slow;
    MockPermitToken internal token;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal guardian = address(0x6);

    uint256 internal constant AMOUNT = 1 ether;
    uint96 internal constant DELAY = 1 days;

    /// @dev Solady's `ReentrancyGuardTransient.Reentrancy()`.
    bytes4 internal constant REENTRANCY = 0xab143c06;

    function setUp() public {
        slow = new SLOW(address(0), address(0));
        token = new MockPermitToken("Test", "TEST", 18, false);
        owner = vm.addr(OWNER_PK);
        token.mint(owner, 100 ether);
        vm.deal(owner, 100 ether);
    }

    // ───────────────────────────────────────────────────────── helpers

    function _sign(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address from = vm.addr(pk);
        bytes32 structHash = keccak256(
            abi.encode(token.PERMIT_TYPEHASH(), from, spender, value, token.nonces(from), deadline)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    // ──────────────────────────────────────────────── SlowPermit: happy

    /// The property the whole extension exists for: the depositor stays the
    /// recorded sender, so they can still `reverse`. A permit *router* would
    /// record itself here and silently destroy that.
    function testPermitDepositRecordsDepositorAsSender() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        uint256 transferId =
            slow.depositToWithPermit(address(token), recipient, AMOUNT, DELAY, "", block.timestamp, v, r, s);

        (uint96 ts, address from, address to, uint256 id, uint256 amount) =
            slow.pendingTransfers(transferId);
        assertTrue(ts != 0, "no pending entry");
        assertEq(from, owner, "sender must be the depositor, not a router");
        assertEq(to, recipient);
        assertEq(id, slow.encodeId(address(token), DELAY));
        assertEq(amount, AMOUNT);
        assertEq(token.balanceOf(address(slow)), AMOUNT);
        assertEq(slow.balanceOf(recipient, id), AMOUNT);
    }

    function testPermitDepositIsReversibleByDepositor() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);
        vm.prank(owner);
        uint256 transferId =
            slow.depositToWithPermit(address(token), recipient, AMOUNT, DELAY, "", block.timestamp, v, r, s);

        vm.prank(owner);
        slow.reverse(transferId);

        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0, "pending entry should be cleared");
        assertEq(slow.unlockedBalances(owner, slow.encodeId(address(token), DELAY)), AMOUNT);
    }

    /// A permit is public once broadcast. If someone front-runs it the nonce is
    /// spent and `token.permit` reverts — but the allowance it wanted now
    /// exists, so the deposit must still land.
    function testPermitDepositToleratesFrontRunPermit() public {
        uint256 deadline = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, deadline);

        // A stranger lands the same signature first.
        token.permit(owner, address(slow), AMOUNT, deadline, v, r, s);
        assertEq(token.allowance(owner, address(slow)), AMOUNT);

        // The now-stale signature must not grief the deposit.
        vm.prank(owner);
        uint256 transferId =
            slow.depositToWithPermit(address(token), recipient, AMOUNT, DELAY, "", deadline, v, r, s);
        (, address from,,,) = slow.pendingTransfers(transferId);
        assertEq(from, owner);
    }

    function testPermitDepositRevertsWhenPermitFailsAndNoAllowance() public {
        // A signature over the wrong value: permit reverts, and no allowance
        // exists to fall back on.
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        vm.expectRevert(); // InsufficientPermit
        slow.depositToWithPermit(
            address(token), recipient, AMOUNT * 2, DELAY, "", block.timestamp, v, r, s
        );
    }

    // ───────────────────────────────────────── SlowPermit: recipient guards

    /// `depositTo` rejects both of these; the permit entrypoints must not be a
    /// softer door onto the same `_finishDeposit`.
    function testPermitDepositRejectsZeroRecipient() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);
        vm.prank(owner);
        vm.expectRevert(); // Solady's _mint: TransferToZeroAddress
        slow.depositToWithPermit(
            address(token), address(0), AMOUNT, DELAY, "", block.timestamp, v, r, s
        );
    }

    /// SLOW is not an ERC-1155 receiver, so `_mint` refuses it. The explicit
    /// `to != address(this)` check that used to sit here was removed once that
    /// was verified: it cost ~213 bytes of a ~500-byte EIP-170 margin to
    /// re-reject something already unreachable. The PROPERTY still has to hold,
    /// so it is still asserted — just without pinning which layer enforces it.
    function testPermitDepositRejectsContractItselfAsRecipient() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);
        vm.prank(owner);
        vm.expectRevert();
        slow.depositToWithPermit(
            address(token), address(slow), AMOUNT, 0, "", block.timestamp, v, r, s
        );
    }

    function testPermitDepositRejectsZeroTokenAndZeroAmount() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        vm.expectRevert(SlowPermitErrors.InvalidPermitDeposit.selector);
        slow.depositToWithPermit(address(0), recipient, AMOUNT, DELAY, "", block.timestamp, v, r, s);

        vm.prank(owner);
        vm.expectRevert(SlowPermitErrors.InvalidPermitDeposit.selector);
        slow.depositToWithPermit(address(token), recipient, 0, DELAY, "", block.timestamp, v, r, s);
    }

    // ────────────────────────────────────────────── SlowPermit: tipped path

    function testTippedPermitDepositRecordsTipOnGate() public {
        uint256 tip = 0.01 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        uint256 transferId = slow.depositToWithTipAndPermit{value: tip}(
            address(token), recipient, AMOUNT, DELAY, tip, "", block.timestamp, v, r, s
        );

        SLOWGate gate = SLOWGate(payable(slow.gate()));
        (uint96 amt, address sender) = gate.tips(transferId);
        assertEq(amt, uint96(tip));
        assertEq(sender, owner, "tip must be refundable to the depositor");
        assertEq(address(gate).balance, tip);
    }

    function testTippedPermitDepositRejectsValueTipMismatch() public {
        uint256 tip = 0.01 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        vm.expectRevert(SlowPermitErrors.InvalidPermitDeposit.selector);
        slow.depositToWithTipAndPermit{value: tip - 1}(
            address(token), recipient, AMOUNT, DELAY, tip, "", block.timestamp, v, r, s
        );
    }

    function testTippedPermitDepositRejectsZeroDelay() public {
        uint256 tip = 0.01 ether;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        vm.expectRevert(SlowPermitErrors.InvalidPermitDeposit.selector);
        slow.depositToWithTipAndPermit{value: tip}(
            address(token), recipient, AMOUNT, 0, tip, "", block.timestamp, v, r, s
        );
    }

    /// The gate packs tips into a uint96. `depositToWithTip` bounds the tip
    /// itself; the permit entrypoint does not, so the gate's own bound is the
    /// only thing standing between a huge tip and a truncating cast.
    function testGateRejectsTipAboveUint96() public {
        uint256 tip = uint256(type(uint96).max) + 1;
        vm.deal(owner, tip + 1 ether);
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, block.timestamp);

        vm.prank(owner);
        vm.expectRevert(); // SLOWGate.InvalidAmount
        slow.depositToWithTipAndPermit{value: tip}(
            address(token), recipient, AMOUNT, DELAY, tip, "", block.timestamp, v, r, s
        );
    }

    // ──────────────────────────────────────────── SlowPermit: reentrancy

    /// `depositTo` is `nonReentrant`; the permit entrypoints reach the same
    /// `_finishDeposit` and must be too. The token re-enters from inside
    /// `transferFrom` and records what it got back.
    function testPermitDepositIsNonReentrant() public {
        ReentrantPermitToken evil = new ReentrantPermitToken(slow);
        evil.mint(owner, 10 ether);

        vm.prank(owner);
        evil.approve(address(slow), type(uint256).max);

        vm.prank(owner);
        slow.depositToWithPermit(address(evil), recipient, AMOUNT, DELAY, "", block.timestamp, 0, 0, 0);

        assertEq(evil.caught(), REENTRANCY, "re-entry into the permit deposit must be rejected");
    }

    // ────────────────────────────────── audit regressions (2026-09-04)

    /// A dust deposit used to void every standing guardian approval: approvals
    /// were keyed on `nonces`, which `_finishDeposit` advances on a path with no
    /// guardian check. The compromised key the guardian defends against could
    /// therefore freeze the balance for 1 wei a time, and removing the guardian
    /// was no escape either — that stages a window the thief simply waits out.
    function testDepositCannotVoidAGuardianApproval() public {
        vm.prank(owner);
        slow.depositTo{value: 10 ether}(address(0), owner, 0, 0, "");
        uint256 id = slow.encodeId(address(0), 0);

        vm.prank(owner);
        slow.setGuardian(guardian);

        uint256 wid = slow.predictWithdrawalId(owner, recipient, id, 10 ether);
        vm.prank(guardian);
        slow.approveTransfer(owner, wid);

        // The attack: a delayed dust deposit from the compromised key. This
        // advances `nonces`, and used to advance the approval's counter with it.
        vm.prank(owner);
        slow.depositTo{value: 1}(address(0), address(0xBAD), 0, 1, "");

        // The approval must still be the one the withdrawal hashes to.
        assertEq(slow.predictWithdrawalId(owner, recipient, id, 10 ether), wid, "approval id moved");
        vm.prank(owner);
        slow.withdrawFrom(owner, recipient, id, 10 ether);
        assertEq(recipient.balance, 10 ether, "guarded recovery must land");
    }

    /// `commitGuardian` used to be permissionless, which defeated the late-abort
    /// the natspec advertises: the guardian being installed front-runs the
    /// user's abort, lands the commit, and then vetoes every later rotation.
    function testCommitGuardianRejectsAStranger() public {
        vm.prank(owner);
        slow.setGuardian(guardian);
        vm.prank(owner);
        slow.setGuardian(address(0x7)); // staged rotation

        vm.warp(vm.getBlockTimestamp() + 1 days);

        vm.prank(address(0xDEAD));
        vm.expectRevert();
        slow.commitGuardian(owner);

        // Either party to the change can still land it.
        vm.prank(guardian);
        slow.commitGuardian(owner);
        assertEq(slow.guardians(owner), address(0x7));
    }

    /// An unbounded `delay` made a pending entry permanent — no `unlock`, no
    /// `claim`, no `clawback` ever matures — so anyone could pin an unremovable
    /// row into a stranger's account, which is what made the lens DoS stick.
    function testDepositRejectsADelayPastTheCeiling() public {
        vm.prank(owner);
        vm.expectRevert();
        slow.depositTo{value: 1 ether}(address(0), recipient, 0, type(uint96).max, "");

        // The advertised ceiling itself still works.
        vm.prank(owner);
        slow.depositTo{value: 1 ether}(address(0), recipient, 0, 3155760000, "");
    }

    // ───────────────────────────────────── SlowPermit: cross-chain replay

    /// SLOW lands at one address on every chain, and USDe/cbBTC are at one
    /// address on more than one chain too. That makes the token's domain
    /// separator the only thing binding a permit to a chain. A token that
    /// rebuilds it per `block.chainid` is safe; one that caches it blindly
    /// makes the same signature spendable on the next chain over.
    function testPermitIsChainBoundForACorrectToken() public {
        uint256 deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = _sign(OWNER_PK, address(slow), AMOUNT, deadline);

        vm.chainId(8453);
        vm.prank(owner);
        vm.expectRevert(); // digest no longer matches: permit fails, no allowance
        slow.depositToWithPermit(address(token), recipient, AMOUNT, DELAY, "", deadline, v, r, s);
    }

    /// The same signature against a token that caches its domain separator with
    /// no chainid recheck. This is not a SLOW defect — SLOW cannot fix a token —
    /// but every listed asset must be checked for it before launch, so the
    /// hazard is pinned down by a test rather than a comment.
    function testPermitReplaysAcrossChainsForACachingToken() public {
        MockPermitToken cached = new MockPermitToken("Cached", "CACHE", 18, true);
        cached.mint(owner, 100 ether);

        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(
                cached.PERMIT_TYPEHASH(), owner, address(slow), AMOUNT, cached.nonces(owner), deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", cached.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);

        vm.chainId(4663);
        vm.prank(owner);
        uint256 transferId =
            slow.depositToWithPermit(address(cached), recipient, AMOUNT, DELAY, "", deadline, v, r, s);

        (, address from,,,) = slow.pendingTransfers(transferId);
        assertEq(from, owner, "a chain-1 signature was honoured on chain 4663");
    }

    // ───────────────────────────────────────── SlowGuardianIndex: the reverse

    function testWardIndexedOnFirstSet() public {
        vm.prank(owner);
        slow.setGuardian(guardian);

        assertEq(slow.wardCount(guardian), 1);
        assertTrue(slow.guards(guardian, owner));
        address[] memory wards = slow.wardsOf(guardian);
        assertEq(wards.length, 1);
        assertEq(wards[0], owner);
    }

    /// Until a rotation commits, the old guardian is still the guardian — and
    /// still the one who can veto it. The index must say so too.
    function testWardIndexDoesNotMoveUntilRotationCommits() public {
        address next = address(0x7);

        vm.prank(owner);
        slow.setGuardian(guardian);

        vm.prank(owner);
        slow.setGuardian(next); // staged, not applied

        assertTrue(slow.guards(guardian, owner), "old guardian lost the ward too early");
        assertFalse(slow.guards(next, owner), "new guardian gained the ward too early");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        slow.commitGuardian(owner);

        assertFalse(slow.guards(guardian, owner));
        assertTrue(slow.guards(next, owner));
        assertEq(slow.wardCount(guardian), 0);
        assertEq(slow.wardCount(next), 1);
    }

    function testWardRemovedOnRotationToZero() public {
        vm.prank(owner);
        slow.setGuardian(guardian);

        vm.prank(owner);
        slow.setGuardian(address(0));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        slow.commitGuardian(owner);

        assertEq(slow.wardCount(guardian), 0);
        assertFalse(slow.guards(guardian, owner));
        assertEq(slow.wardsOf(guardian).length, 0);
    }

    /// Swap-and-pop must leave every surviving ward still findable — the moved
    /// entry's stored position is the easy thing to get wrong.
    function testWardRemovalKeepsRemainingWardsIndexed() public {
        address[3] memory wards = [address(0x11), address(0x12), address(0x13)];
        for (uint256 i; i < wards.length; ++i) {
            vm.prank(wards[i]);
            slow.setGuardian(guardian);
        }
        assertEq(slow.wardCount(guardian), 3);

        // Remove the middle one, so the last is swapped into its slot.
        vm.prank(wards[1]);
        slow.setGuardian(address(0));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(wards[1]);
        slow.commitGuardian(wards[1]);

        assertEq(slow.wardCount(guardian), 2);
        assertFalse(slow.guards(guardian, wards[1]));
        assertTrue(slow.guards(guardian, wards[0]));
        assertTrue(slow.guards(guardian, wards[2]), "swapped ward lost its index entry");

        // And the moved entry is still removable, which is what a stale
        // position would break.
        vm.prank(wards[2]);
        slow.setGuardian(address(0));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(wards[2]);
        slow.commitGuardian(wards[2]);
        assertEq(slow.wardCount(guardian), 1);
        assertEq(slow.wardsOf(guardian)[0], wards[0]);
    }

    /// `wardsAt` documents "pass a big count for the rest of the list", so the
    /// clamp has to survive a count that would overflow `start + count`.
    function testWardsAtClampsAndDoesNotOverflow() public {
        address[3] memory wards = [address(0x21), address(0x22), address(0x23)];
        for (uint256 i; i < wards.length; ++i) {
            vm.prank(wards[i]);
            slow.setGuardian(guardian);
        }

        assertEq(slow.wardsAt(guardian, 0, type(uint256).max).length, 3);
        assertEq(slow.wardsAt(guardian, 1, type(uint256).max).length, 2);
        assertEq(slow.wardsAt(guardian, 3, 10).length, 0, "start past the end must be empty");
        assertEq(slow.wardsAt(guardian, 99, type(uint256).max).length, 0);
        assertEq(slow.wardsAt(guardian, 0, 2).length, 2);
    }

    function testGuardianIndexIgnoresRepeatedSet() public {
        vm.prank(owner);
        slow.setGuardian(guardian);
        vm.prank(owner);
        slow.setGuardian(guardian); // no-op branch

        assertEq(slow.wardCount(guardian), 1, "ward double-counted");
    }
}

/// @dev The custom errors `SlowPermit` declares, for `expectRevert` by selector.
interface SlowPermitErrors {
    error PermitFailed();
    error InsufficientPermit();
    error InvalidPermitDeposit();
}

/// @dev A standard EIP-2612 token. `cacheBlindly` reproduces the tokens that
///      pin their domain separator at construction and never recheck
///      `block.chainid`.
contract MockPermitToken {
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    bool public immutable cacheBlindly;
    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, bool _cacheBlindly) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        cacheBlindly = _cacheBlindly;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _build();
    }

    function _build() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (cacheBlindly || block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return _build();
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        require(block.timestamp <= deadline, "PERMIT_EXPIRED");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == owner, "INVALID_SIGNER");
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function mint(address to, uint256 amount) public {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Re-enters the permit deposit from inside the pull and records the
///      revert selector it gets back, so the guard can be asserted on rather
///      than inferred from an outer revert.
contract ReentrantPermitToken {
    string public name = "Evil";
    string public symbol = "EVIL";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    SLOW internal immutable slow;
    bytes4 public caught;
    bool internal entered;

    constructor(SLOW _slow) {
        slow = _slow;
    }

    function mint(address to, uint256 amount) public {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// A permit that quietly succeeds, so the deposit proceeds to the pull.
    function permit(address owner, address spender, uint256 value, uint256, uint8, bytes32, bytes32)
        public
    {
        allowance[owner][spender] = value;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (!entered) {
            entered = true;
            try slow.depositToWithPermit(
                address(this), address(0xCAFE), 1 ether, 1 days, "", block.timestamp, 0, 0, 0
            ) returns (uint256) {
                caught = bytes4(0xffffffff); // re-entry was NOT rejected
            } catch (bytes memory err) {
                caught = err.length >= 4 ? bytes4(err) : bytes4(0);
            }
        }
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
