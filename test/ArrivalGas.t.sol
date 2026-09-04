// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Test, console2} from "../lib/forge-std/src/Test.sol";
import {SLOW} from "../src/SLOW.sol";
import {SlowArrival} from "../src/SlowArrival.sol";
import {SlowOrigin} from "../src/SlowOrigin.sol";

/// @notice What `arrive` actually costs, against the gas the page buys for it.
///
/// @dev WHY THIS IS NOT A MICRO-OPTIMISATION TEST. The destination gas for a
///      bridged deposit is bought on L1, at the moment of sending, and cannot be
///      topped up afterwards:
///
///        Base       depositTransaction(..., gasLimit, ...)   400,000
///        Robinhood  createRetryableTicket(..., gasLimit, ...) 600,000
///
///      If the arrival costs more than was bought, the OP Stack deposit runs out
///      of gas at the destination and the ETH is gone — `finalizeWithdrawalTransaction`
///      and the deposit path both consume the message before the call and neither
///      is replayable. An Arbitrum retryable is kinder (it stays redeemable for
///      seven days) but still needs someone to notice and pay again.
///
///      So the number below is a safety margin on unrecoverable funds, and the
///      point of measuring it is that `SlowArrival` sits in a path that used to
///      go straight to `SLOW.depositTo`. It added four staticcall probes, a
///      storage write and an event to a budget nobody re-checked.
///
/// @dev The measurements are of the WORST case on purpose: a cold recipient, a
///      cold `originOf` slot, a first-ever ERC-1155 mint to that address, and a
///      pending transfer created rather than an unlocked credit.
contract ArrivalGasTest is Test {
    SLOW internal slow;
    SlowArrival internal arrival;

    /// @dev What the page buys today, from `BRIDGES` in dapp/page.html.
    uint256 internal constant BASE_BUDGET = 400_000;
    uint256 internal constant ROBINHOOD_BUDGET = 600_000;

    uint96 internal constant DELAY = 1 days;
    uint256 internal constant AMOUNT = 1 ether;

    function setUp() public {
        slow = new SLOW(address(0), address(0));
        arrival = new SlowArrival(address(slow), new uint256[](0), new SlowArrival.Route[](0));
        vm.warp(1_700_000_000);
    }

    function _cd(address to, address hint, uint256 bounty)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SlowArrival.arrive, (to, DELAY, hint, bounty));
    }

    /// @dev Measures one `arrive` from a given caller, the way a bridge makes it.
    function _measure(address caller, address to, address hint, uint256 bounty)
        internal
        returns (uint256 used)
    {
        vm.deal(caller, AMOUNT * 2);
        vm.prank(caller, caller);
        uint256 before = gasleft();
        (bool ok,) = address(arrival).call{value: AMOUNT}(_cd(to, hint, bounty));
        used = before - gasleft();
        assertTrue(ok, "arrive must not revert");
    }

    /// @notice OP Stack, L1 to L2: an EOA arrives unaliased, so the origin is the
    ///         sender and no probe finds an answer — the most probes, the least
    ///         help from any of them.
    function test_gasOnAnOpStackDeposit() public {
        uint256 used = _measure(address(0xA11CE), address(0xB0B), address(0), 0);
        console2.log("OP Stack deposit            ", used);
        console2.log("  budget                    ", BASE_BUDGET);
        assertLt(used, BASE_BUDGET, "must fit what the page buys for Base");
    }

    /// @notice Arbitrum retryable: the sender arrives aliased and the hint is
    ///         what recovers it, so this is the path the Robinhood route takes.
    function test_gasOnAnArbitrumRetryable() public {
        address alice = address(0xA11CE);
        uint256 used =
            _measure(SlowOrigin.applyAlias(alice), address(0xB0B), alice, 0);
        console2.log("Arbitrum retryable          ", used);
        console2.log("  budget                    ", ROBINHOOD_BUDGET);
        assertLt(used, ROBINHOOD_BUDGET, "must fit what the page buys for Robinhood");
    }

    /// @notice With a bounty, which adds a value transfer to a cold account.
    function test_gasWithABounty() public {
        uint256 used =
            _measure(address(0xA11CE), address(0xB0B), address(0), 0.01 ether);
        console2.log("with a bounty               ", used);
        assertLt(used, BASE_BUDGET, "still fits");
    }

    /// @notice What the wrapper costs, measured honestly.
    /// @dev An earlier version of this test ran the direct deposit FIRST and the
    ///      wrapped one second, so the direct call paid the cold costs and the
    ///      wrapped one inherited them warm. It reported 15,773. Each path gets
    ///      its own fresh SLOW here, and the real figure is about 35,700 — the
    ///      four origin probes, the `originOf` write and the event.
    function test_theOverheadOverADirectDeposit() public {
        SLOW s1 = new SLOW(address(0), address(0));
        address c1 = address(0xD1);
        vm.deal(c1, AMOUNT * 2);
        vm.prank(c1, c1);
        uint256 g = gasleft();
        s1.depositTo{value: AMOUNT}(address(0), address(0xB0B), 0, DELAY, "");
        uint256 direct = g - gasleft();

        SLOW s2 = new SLOW(address(0), address(0));
        SlowArrival a2 = new SlowArrival(address(s2), new uint256[](0), new SlowArrival.Route[](0));
        address c2 = address(0xD2);
        vm.deal(c2, AMOUNT * 2);
        vm.prank(c2, c2);
        g = gasleft();
        (bool ok,) = address(a2).call{value: AMOUNT}(
            abi.encodeCall(SlowArrival.arrive, (address(0xB0B), DELAY, address(0), uint256(0)))
        );
        uint256 wrapped = g - gasleft();
        assertTrue(ok);

        console2.log("direct depositTo            ", direct);
        console2.log("through SlowArrival         ", wrapped);
        console2.log("overhead                    ", wrapped - direct);
        assertLt(wrapped - direct, 45_000, "the wrapper must stay cheap");
    }

    /// @notice THE RISK IS OLDER THAN THIS CONTRACT, which is the part that
    ///         decides who should fix it and where.
    /// @dev The page has always bought a FIXED 400,000 for Base, and `depositTo`
    ///         has always called an arbitrary recipient's `onERC1155Received`
    ///         inside it. So a contract recipient could already lose a bridged
    ///         send before `SlowArrival` existed — at around seven cold writes.
    ///         The wrapper moves that threshold to about five. It makes a
    ///         pre-existing hazard modestly worse; it does not create one.
    function test_theCliffExistsWithoutTheWrapperToo() public {
        SLOW s1 = new SLOW(address(0), address(0));
        HungryRecipient r = new HungryRecipient(8);
        address c = address(0xD3);
        vm.deal(c, AMOUNT * 2);
        vm.prank(c, c);
        uint256 g = gasleft();
        s1.depositTo{value: AMOUNT}(address(0), address(r), 0, DELAY, "");
        uint256 direct = g - gasleft();
        console2.log("direct, 8-write recipient   ", direct);
        assertGt(direct, BASE_BUDGET, "the shipped route already overruns 400k");
    }

    /// @notice THE ONE INPUT THIS BUDGET CANNOT BOUND, and it does not fit.
    ///
    ///         `_mint` calls `onERC1155Received` on a contract recipient, and
    ///         that hook runs inside the gas the sender bought on L1. Twenty
    ///         cold storage writes in a recipient's hook cost more than twice
    ///         what the page buys for Base — and an OP Stack deposit that runs
    ///         out of gas at the destination is not replayable, so the ETH is
    ///         gone.
    ///
    ///         This is not a defect in `SlowArrival`: the same hook runs on a
    ///         direct `depositTo`, and the sender chose the recipient. It is a
    ///         defect in buying a FIXED 400,000 for a call whose cost the
    ///         recipient controls. The numbers below are what a fix has to be
    ///         sized against.
    function test_aContractRecipientCanExceedTheBudget() public {
        HungryRecipient greedy = new HungryRecipient(20);
        uint256 used = _measure(address(0xA11CE), address(greedy), address(0), 0);
        console2.log("contract recipient, 20 writes", used);
        console2.log("  budget (Base)              ", BASE_BUDGET);
        assertGt(used, BASE_BUDGET, "twenty writes does NOT fit what Base buys");
        assertGt(used, ROBINHOOD_BUDGET, "nor what Robinhood buys");
    }

    /// @notice Where the cliff is, so the page has a number to size against
    ///         rather than a warning. Each cold write costs ~22k, and the
    ///         arrival itself takes ~285k of the 400k, so the recipient has
    ///         roughly five writes of room on Base before the send is lost.
    function test_whereTheContractRecipientCliffIs() public {
        uint256 last;
        for (uint256 n = 0; n <= 8; n += 2) {
            SLOW s2 = new SLOW(address(0), address(0));
            SlowArrival a2 = new SlowArrival(address(s2), new uint256[](0), new SlowArrival.Route[](0));
            HungryRecipient r = new HungryRecipient(n);

            address caller = address(uint160(0xA11CE + n));
            vm.deal(caller, AMOUNT * 2);
            vm.prank(caller, caller);
            uint256 before = gasleft();
            (bool ok,) = address(a2).call{value: AMOUNT}(
                abi.encodeCall(SlowArrival.arrive, (address(r), DELAY, address(0), uint256(0)))
            );
            uint256 used = before - gasleft();
            assertTrue(ok);
            console2.log("writes / gas / fits Base:", n, used);
            console2.log("   fits:", used < BASE_BUDGET);
            last = used;
        }
        // Eight writes is already past it, which is a very ordinary hook.
        assertGt(last, BASE_BUDGET, "eight writes overruns Base's 400k");
    }

    /// @notice The failure branch must also fit, because it is the one that runs
    ///         when something is wrong — and on OP Stack a revert there destroys
    ///         the withdrawal outright.
    function test_gasOnTheRescuePath() public {
        // `to == address(0)` makes the inner deposit revert, so this takes the
        // rescue branch and still has to complete.
        uint256 used = _measure(address(0xA11CE), address(0), address(0), 0);
        console2.log("rescue branch               ", used);
        assertEq(arrival.rescue(address(0xA11CE)), AMOUNT, "held, not lost");
        assertLt(used, BASE_BUDGET, "the failure path fits too");
    }
}

/// @dev A recipient whose ERC-1155 hook does real work, to price the tail.
contract HungryRecipient {
    uint256 private immutable writes;
    mapping(uint256 => uint256) private junk;

    constructor(uint256 n) {
        writes = n;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        for (uint256 i; i != writes; ++i) junk[i] = i + 1;
        return this.onERC1155Received.selector;
    }
}
