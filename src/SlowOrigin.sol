// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SlowOrigin
/// @notice Recovers who is really behind a cross-chain call, without knowing a
///         single bridge address.
///
/// @dev WHY THIS CAN BE ADDRESS-FREE. Both rollup families hand the far-side
///      sender to the target through a getter that is only meaningful while the
///      bridge is mid-call:
///
///        OP Stack, L2→L1        OptimismPortal.l2Sender()
///        OP Stack, either way   CrossDomainMessenger.xDomainMessageSender()
///        Arbitrum, L2→L1        Bridge.activeOutbox() → Outbox.l2ToL1Sender()
///        Either, L1→L2          the sender arrives ALIASED, so undo it
///
///      Duck-typing those beats a hardcoded table: one build works on chains
///      that did not exist when it was written, and there is no address anyone
///      can be wrong about or be persuaded to change.
///
/// @dev WHY `staticcall` AND NOT `try/catch`. Measured, not assumed — see
///      `SlowOriginProbeTest` in `test/SlowArrival.t.sol`. Solidity's `try`
///      does not catch either of the
///      two failures that actually happen here: a call to an address with no
///      code reverts on the compiler's `extcodesize` check BEFORE the callee is
///      reached, and a call that returns nothing reverts in the ABI decoder
///      AFTER it. Both are outside the `catch`. A raw `staticcall` with an
///      explicit length check survives both, which is the only reason a probe
///      can be pointed at an arbitrary `msg.sender`.
///
/// @dev WHAT `authenticated` MEANS, AND WHAT IT DOES NOT. It means the answer
///      came from the caller's own getter rather than from a guess. It does NOT
///      mean the caller is a real bridge: anyone can deploy a contract whose
///      `l2Sender()` returns whatever they like. That is deliberately fine for
///      any use where mis-attribution is harmless — see `SlowArrival` — and
///      deliberately NOT enough where money moves on the answer. A caller that
///      must not be forged has to be checked against an address as well; see
///      `SlowRelay._authenticatedSelf`, which is why that contract does hold
///      immutables and this library does not.
library SlowOrigin {
    /// @dev The offset Arbitrum and OP Stack both add to an L1 sender.
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    /// @dev Both stacks park their sender slot on this between calls, so it is
    ///      "nobody" rather than an answer. Read live off Base's portal.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev Bounded so a hostile `msg.sender` cannot burn the caller's gas in a
    ///      getter. A real one costs a cold account access plus an SLOAD.
    uint256 private constant PROBE_GAS = 100_000;

    bytes4 private constant L2_SENDER = 0x9bf62d82; // l2Sender()
    bytes4 private constant XDOMAIN_SENDER = 0x6e296e45; // xDomainMessageSender()
    bytes4 private constant ACTIVE_OUTBOX = 0xab5d8943; // activeOutbox()
    bytes4 private constant L2_TO_L1_SENDER = 0x80648b02; // l2ToL1Sender()

    /// @notice Add the L1→L2 alias, as both stacks do to a contract sender.
    function applyAlias(address a) internal pure returns (address) {
        unchecked {
            return address(uint160(a) + ALIAS_OFFSET);
        }
    }

    /// @notice Undo it.
    function undoAlias(address a) internal pure returns (address) {
        unchecked {
            return address(uint160(a) - ALIAS_OFFSET);
        }
    }

    /// @notice Who is behind `sender`, and whether the answer was told to us or
    ///         merely assumed.
    /// @param sender Normally `msg.sender`; taken as a parameter so it is testable.
    /// @param hint The origin the calldata claims. Only ever believed when the
    ///        caller sits at exactly `applyAlias(hint)`, which no one can arrange
    ///        for an address they do not already control.
    function recover(address sender, address hint)
        internal
        view
        returns (address origin, bool authenticated)
    {
        // 1. OP Stack, L2→L1: the portal is calling and knows who sent it.
        address s = _probe(sender, L2_SENDER);
        if (s != address(0) && s != DEAD) return (s, true);

        // 2. Either stack, through a CrossDomainMessenger, either direction.
        s = _probe(sender, XDOMAIN_SENDER);
        if (s != address(0) && s != DEAD) return (s, true);

        // 3. Arbitrum, L2→L1. `msg.sender` is the BRIDGE, not the outbox —
        //    `Outbox.executeTransaction` routes through `bridge.executeCall`.
        //    `activeOutbox()` is set only for the duration of that call and
        //    reads zero at rest, which is what makes it a proof of context
        //    rather than a lookup. (Verified live: Robinhood's bridge answers
        //    zero when nothing is executing.)
        address outbox = _probe(sender, ACTIVE_OUTBOX);
        if (outbox != address(0)) {
            s = _probe(outbox, L2_TO_L1_SENDER);
            if (s != address(0) && s != DEAD) return (s, true);
        }

        // 4. L1→L2, where the sender arrives aliased. Arbitrum does this to
        //    EVERY retryable sender including EOAs — established empirically
        //    against Robinhood Chain, where an L1 EOA calling
        //    createRetryableTicket arrives as its address plus the offset. OP
        //    Stack does it only to contracts.
        //
        //    UNAUTHENTICATED, AND IT HAS TO BE. This used to return `true`, on
        //    the reasoning that nobody could arrange to sit at `applyAlias(hint)`
        //    for an address they did not control. That reads the equation
        //    backwards: it pins `hint` GIVEN `sender`, and `applyAlias` is a
        //    bijection, so for any caller there is exactly one satisfying
        //    `hint` — `undoAlias(msg.sender)` — which anyone can compute and
        //    nobody needs permission for. A genuine aliased arrival and a
        //    direct caller passing that value are indistinguishable from
        //    inside this contract, so the branch cannot prove anything and must
        //    not claim to. The unforgeable form is the INVERTED one
        //    `SlowRelay._authenticatedSelf` uses — `undoAlias(msg.sender) ==
        //    address(this)` — which pins the target instead of accepting it.
        //
        //    `hint` is still the right ORIGIN to return: for a real arrival it
        //    is the true sender, and for a forger it names an address the
        //    forger is giving their own rights away to. Only the claim of proof
        //    is withdrawn.
        if (hint != address(0) && applyAlias(hint) == sender) return (hint, false);

        // 5. Nothing to learn. A local caller is its own origin.
        return (sender, false);
    }

    /// @dev A raw staticcall that cannot revert the caller, whatever is there.
    ///
    ///      FIXED 32-BYTE RETURN WINDOW. `PROBE_GAS` bounds what the callee may
    ///      SPEND; it does not bound what the callee may RETURN. Reading into
    ///      `bytes memory` copies the whole `returndatasize()` into this frame
    ///      and charges quadratic memory expansion here, so a callee that spends
    ///      its entire 100,000 on growing memory can cost the caller more than
    ///      the cap it was supposedly held to — four times over, once per probe.
    ///      A window the callee cannot size is the only bound that holds.
    function _probe(address target, bytes4 selector) private view returns (address out) {
        bool ok;
        uint256 word;
        uint256 rds;
        assembly ("memory-safe") {
            // 0x00-0x40 is Solidity's scratch space: safe to write, no allocation.
            mstore(0x00, selector)
            ok := staticcall(PROBE_GAS, target, 0x00, 0x04, 0x20, 0x20)
            word := mload(0x20)
            rds := returndatasize()
        }
        if (ok && rds == 32) {
            // A word with dirty upper bits is not an address; treat it as no answer
            // rather than silently truncating someone else's return value.
            if (word >> 160 == 0) out = address(uint160(word));
        }
    }
}
