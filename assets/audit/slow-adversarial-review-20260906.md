# Adversarial review — the deployed SLOW suite

Three attacker-perspective agents against the **live, immutable** contracts, asking
one question: can anyone end up holding value they did not deposit, or can a
user's funds become unrecoverable? Not style, not smells — theft and loss.

| | |
| --- | --- |
| **Date** | 2026-09-06 |
| **Targets** | `SLOW` `0x000000006513B7821171C8447ec7ECdfa3b956Fd` · `SlowPage` `0x6e2ca0Eb…DCbc` · `SlowArrival` `0x9F8D89D2…097f` · `SlowRelay` `0xC58C2177…E2da` — the same addresses on Ethereum, Base and Robinhood Chain |
| **Method** | Three parallel adversarial agents, findings verified against deployed bytecode and by independent reproduction where the severity warranted it |

---

## The deployed bytecode is the audited source

Checked before anything else, because an audit of the repo is worthless if the
chain holds something else. The runtime at `0x0000…956Fd` on mainnet is
**byte-identical** to a local build of `src/SLOW.sol`, modulo the CBOR metadata
hash and seven immutable slots (`page` → `0x6e2ca0Eb…DCbc`, `gate` →
`0x76D1956b…8D34`). The live `SLOWGate` runtime likewise matches, with all five
of its immutables pointing back at SLOW.

---

## No theft path found in the core or the relay

**`SLOW` — conservation holds under fuzzing.** The invariant
`balanceOf(u,id) == unlockedBalances(u,id) + Σ pending-inbound(u,id)`, plus
reserve equality for ETH, ERC-20 and gate tips, held over **24,000 fuzzed calls**
(300 runs × depth 80) across all twelve entrypoints, with contract actors
re-entering from both the ERC-1155 hook and the ETH receive hook under
randomised guardian churn.

**No cross-user spending.** Both `unlockedBalances` decrements are followed by a
Solady authorisation check that reverts `NotOwnerNorApproved` and rolls the
decrement back.

**No id collision, replay, or cross-user pre-approval.** The preimage is 169
fixed-width bytes; the op byte separates withdraw, transfer and deposit spaces;
both nonces are monotone and post-incremented. A withdraw approval cannot
satisfy a transfer, and a used approval cannot be replayed.

**No reentrancy.** Every value-moving entrypoint is guarded. `multicall` is
unguarded but delegatecalls into guarded functions and refuses non-zero
`msg.value`. Every reentrant probe reverts `Reentrancy()`. The non-mainnet SSTORE
fallback behaves identically on Base and Robinhood and collides with nothing.

**`permitSelf` cannot pull from anyone but `msg.sender`.** Tested concretely: a
victim's real EIP-2612 signature was landed on the token so a live 1000e18
victim→SLOW allowance existed, and not one wei moved through any of the four
deposit paths.

**`SlowRelay`'s escrow pool cannot be over-drawn.** `unlockedBalances[from][id]
-= amount` sits *outside* the `unchecked` block, so over-draw is impossible
arithmetically rather than by logic. Destination `reverse`/`clawback` credit a
*delayed* id, disjoint from the zero-delay escrow pool. Proof forgery fails on
every chain: on both L2s `trustedMessenger` is empty, so the alias branch is the
only live path and it requires code at one unreachable address.

---

## What a user should be told

**A guardian you appoint can freeze your wrapped balance permanently.** This is
the largest live fund-loss surface. `withdrawFrom` and `safeTransferFrom` both
need approval, `claim` is refused while a guardian is set, and the only exit —
`setGuardian(0)` then `commitGuardian` after a day — can be vetoed by the
guardian an unlimited number of times for ~30,000 gas each. There is no timeout
and no escape hatch. It requires the victim to have appointed the attacker, but
the natspec calls it a trade-off when it is permanent loss.

**`setApprovalForAll(gate, true)` is a full operator grant, not a claim-only
capability.** A holder of that grant can call `withdrawFrom` and pay themselves.
It is safe only because the gate's *code* has no path to `withdrawFrom`,
`safeTransferFrom`, `unlock`, `reverse` or `clawback` — verified against the live
gate bytecode: immutable, no owner, no fallback, no `receive`, no `delegatecall`,
and its only attacker-influenced outbound call is a tip transfer with empty
calldata. "Cannot redirect funds" is true of the code, not of the grant.

**A `SlowPage` steward can do more than end the lineage.** `deployNext` executes
arbitrary steward-supplied initcode and requires the successor to answer only
two getters, so a steward may append an upgradeable proxy and publish an
arbitrary dapp under the root's accumulated trust. Separately, a successor whose
`successor()` later reverts bricks `latest()` permanently for itself *and every
predecessor including the immutable root* — `deployNext` checks that getter only
at deploy time. `html()` is unaffected; clients should pin `PAGE_HASH` per hop
rather than trust the walk.

**A registry owner can destroy value without touching an entrypoint.** On a
registry-added chain the owner sets `l2GasLimit` bounded only by `!= 0`; setting
it to 1 makes every arrival there run out of gas at the destination. Freezing a
route covers the gas limit, so freezing remains a complete handback.

---

## One finding neither confirmed nor refuted

An agent reports that a finaliser whose `tx.origin` carries an **EIP-7702
delegation** can force `arrive` to revert on the OP L2→L1 leg inside a ~13,000-gas
band, permanently stranding the withdrawal — the delegation lookup adds ~2,600
gas and puts the failure tail at ~68–74k against a 60,000 reserve.

**Attempted reproduction failed, and the harness was faulty**, so this is
recorded as open rather than as confirmed or dismissed: no deposit landed at any
gas level in the reproduction, meaning there was nothing for a divergence to
appear in.

Scope, if real: it needs `bounty != 0` on an **L2→L1** arrival. The dapp builds
no L2→L1 arrivals — every route is `from: 1` — and `SlowArrival.forward` has no
caller. The L1→L2 leg was swept separately (150k–400k gas, hostile recipients,
non-zero bounty) with **zero reverts**, because there the bounty credits `rescue`
with no external call. It must be settled before anyone builds an L2→L1 arrival
carrying a bounty.

---

## Assessment

The deposit-and-timelock product — wrap, timelock, guardian, reverse, clawback,
settle — is well established: no theft path found across three adversarial
passes and two earlier audits, conservation verified under fuzzing, and a live
deposit whose accounting and state machine were checked directly on chain.

The cross-chain relay is a different matter and deserves a different launch
decision. It has never executed end-to-end, its two multi-day exits are verified
by reasoning only, and it carries known open design properties around
same-address assumptions that are immutable now. It has no UI and no relayer,
but it is deployed and permissionless, so "not exposed in our frontend" is not
"not reachable".

No review of this kind can establish the absence of vulnerabilities, and none of
this substitutes for a human audit, a bounty, or monitoring.
