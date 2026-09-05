# 🔐 Security Review — SLOW bridge layer, second pass

An independent re-review of the cross-chain contracts after the twelve-lens pass
of 2026-09-04, run against the branch as it stood rather than as it was written.
Three value-affecting findings, each with a proof of concept that fails without
the fix, plus the one open parameter from the previous report closed by
measurement instead of estimate.

---

## Scope

| | |
| --- | --- |
| **Method** | Manual review, adversarial, with executable proofs of concept |
| **Date** | 2026-09-05 |
| **Files reviewed** | `SlowOrigin.sol` · `SlowArrival.sol` · `SlowRelay.sol`<br>`SlowBridgeRegistry.sol` · `script/DeployBridge.s.sol`<br>bridge paths in `dapp/page.html` |
| **Prior** | `slow-bridge-pashov-ai-audit-report-20260904-120000.md` |
| **State at review** | Nothing deployed on any chain. Every finding was fixable at zero cost. |

**Where the previous report's eleven findings landed.** All confirmed fixed and
still fixed. The three below are new, and two of them are the *same* defect
class as findings the previous pass closed — reached through an address it did
not look at.

---

## Findings

### 1. A codeless route entry silently burns the whole forward

`SlowArrival` constructor / `_push` · **Fixed**

**Description**
The constructor refuses a codeless `slow_`, and the reason it gives is exactly
right: a value-bearing call to an address with no code **returns success**, so
`arrive` would read it as a failed deposit, credit `rescue` for ETH that had
already left, and let the first claimant drain the rest. That was finding 11 of
the previous pass.

The same constructor then wrote `routeTo` from its `routes[]` argument with no
check at all — and `_push` sends the payload to `r.entry` with precisely that
kind of call:

```solidity
sent := call(budget, entry, send, add(cd, 0x20), mload(cd), 0x00, 0x00)
if (sent) emit Forwarded(dstChainId, origin, to, value, delay);
```

Against an entry with no code, `sent` is true. `Forwarded` is emitted, no
`rescue` is credited, and the payload sits at an address nobody holds. Because
routes are immutable by design — there is no setter, deliberately — a mistyped
entry is not a bug that gets fixed afterwards. It is a destination that is dead
for the life of the contract, failing silently and looking like success.

`scripts/validate-bridge.mjs` checks the deployed entries against an expected
set, which catches this *after* the transaction that cannot be undone.

**Proof of concept.** One route, entry `0xDeaD…BEEf`, 1 ETH forwarded:
`forward` returns true, `rescue(alice) == 0`, and the ETH is at the codeless
address.

**Response — FIXED.** The constructor now requires `entry.code.length != 0`,
`kind ∈ {OP, ARB}` and `gasLimit != 0`, under a dedicated `BadRoute` error
(which also replaces the `NoSlow` the array-length mismatch was misreporting).
Four regressions cover the refusals, one pins what the check is worth, and two
confirm the ordinary routes still open.

---

### 2. The Arbitrum branch names refund addresses Nitro will alias

`SlowArrival._push` · **Fixed**

**Description**
`createRetryableTicket` was given `origin` as both `excessFeeRefundAddress` and
`callValueRefundAddress`. Nitro aliases both whenever they hold code on L1. So
for a contract origin — an L1 smart account calling `forward` directly, or an L2
contract whose address also carries code on L1 — the excess submission fee, the
unused prepaid gas, and, **if the ticket is never redeemed, the entire payload**
land at `applyAlias(origin)` on chain 4663.

This is not a novel hazard in this codebase; it is a known one that reached one
more place than it was closed in. `SlowRelay.pushProof` documents it at length
and works around it with `tx.origin`. The page refuses the route outright rather
than offer it — `canBridge` returns false for an Arbitrum destination whenever
the account holds code, in its own words because *"the alternative is offering a
send that quietly costs more than the review screen says."* `_push` had neither
the guard nor the workaround, and the amount at risk here is larger than in
either: the payload, not an over-provisioned fee.

**Proof of concept.** An ordinary contract wallet forwards 1 ETH to 4663. The
recording inbox shows both refund addresses set to the wallet, which holds L1
code — 0.999 ETH of call value refundable to `applyAlias(wallet)`.

**The obvious fix is wrong and worth recording as such.** Passing
`undoAlias(origin)` looks like it inverts the aliasing, but that address holds no
L1 code, so Nitro would not alias it and the refund would land there instead —
just as unreachable. `tx.origin` is not a substitute either: in `pushProof` it
names the keeper, who funded the call; here it names the finaliser, who is a
different party from the one whose money this is.

**Response — FIXED.** The Arbitrum branch returns false when
`origin.code.length != 0`, which lands the payload in `rescue[origin]` on this
chain where the origin can still reach it. The guard is narrow: OP Stack names
no refund address, so a contract origin keeps that route, and a regression pins
both halves.

---

### 3. The forward bought a flat gas budget where the page measures one

`script/DeployBridge.s.sol` · **Fixed**

**Description**
`FORWARD_GAS` was 1,000,000 for both routes. `depositTo` calls
`onERC1155Received` on the recipient and that hook spends from the same budget,
so the real cost is the recipient's to set — `test/ArrivalGas.t.sol` measures
281,495 at zero writes, 504,085 at ten, 726,663 at twenty, putting the cliff for
a 1,000,000 budget between ten and fifteen.

The page had already found this and sized around it: `destGasLimit` reads the
recipient's code on the destination chain and buys 600,000/800,000 for an
account against **2,500,000** for a contract. `_push` cannot probe — it runs on
L1 and the recipient is on the far side — so it was buying the account-sized
budget for every recipient.

This degrades rather than burns: `arrive`'s `FAILURE_RESERVE` catches the
shortfall and the payload lands in `rescue[origin]`. But the position never
arrives, and the origin has to discover that and claim on a chain they may never
have used, five days after a send they thought was finished.

**Response — FIXED.** `FORWARD_GAS` is 2,500,000, matching what the page buys
for the case `_push` cannot rule out. On the OP leg the extra is L1 gas paid by
the finaliser, who is claiming a bounty for exactly that work; on the Arbitrum
leg the unused portion is refunded on the far side to an origin that finding 2
now guarantees is not one Nitro will alias.

---

### 4. A successful deposit could be credited to `rescue`

`SlowArrival.arrive` · **Fixed** · defensive

**Description**
The branch was `if (ok && rds == 32)`, with everything else falling to
`rescue[origin] += value`. That puts a call which **succeeded** with an
unexpected return length into the failure arm — crediting a claim against ETH
the callee had already taken, and handing the first claimant a claim on someone
else's balance.

Not reachable against the real SLOW, whose `depositTo` returns a `uint256`, and
finding 1's constructor check closes the one path that made it reachable. But
`ok` is the only thing that says where the money went, and conflating "reverted"
with "returned something odd" is the wrong shape for a contract whose entire job
is knowing which of those happened.

**Response — FIXED.** The credit keys off `!ok` alone. A short return is
reported as an arrival with no id — the value moved, and nothing can be owned,
so nothing is recorded as owned. Pinned against a stand-in that takes the ETH
and answers with nothing.

---

## The open parameter from the previous report, closed

`PROOF_GRACE = 8 days` was left open with *"may be thin… worth checking Base's
live dispute-game parameters before launch."* Read off L1:

| | |
| --- | --- |
| Base `OptimismPortal` 5.2.0 | `proofMaturityDelaySeconds` **86,400** · `disputeGameFinalityDelaySeconds` **0** |
| Base game type 621 | resolution measured at **~5.00 days** (game 21,000: 432,144s created→resolved); games created ~20 min apart |
| Robinhood `Rollup` | `confirmPeriodBlocks` **45,818** ≈ **6.36 days** at 12s L1 blocks |

So the estimate was wrong in a safe direction and about the wrong chain. Base's
leg floors at ~5.1 days, not the 7 the constant was sized against; **Nitro is
the binding constraint at ~6.4 days**, and eight days clears it by ~1.6. That
slack is what absorbs the L1→L2 hop and a keeper late to `pushProof`.

What it does not absorb: a Base game invalidated after the fill, where a
re-prove restarts maturity against a new game and can push the total past eight
days. Rare and loud, and what it costs is the relayer's fill. Recorded at the
constant, worth monitoring rather than worth pricing in.

---

## Checked and clean

- **Escrow conservation in `SlowRelay`.** All four opening doors deposit exactly
  `amount + fee`; `statusOf` is one-way `NONE → OPEN → {RELEASED, CANCELLED}`;
  `release` and `cancel` each draw once. No cross-draw between the pooled
  zero-delay escrow id and a reversed destination leg — `reverse` withdraws at
  the delayed id, and a zero-delay fill returns no `transferId` to own.
- **`originOf` cannot collide** in either contract: SLOW's `transferId` folds in
  `nonces[msg.sender]++`.
- **No third party can set a guardian** on `SlowArrival` or `SlowRelay`, so
  `withdrawFrom` cannot be bricked out from under either contract's payout path.
- **`_authenticatedSelf` holds on all four real transports**, and the same
  intent id cannot be opened on a chain that is not its `srcChainId`.
- **The retryable arithmetic cannot overflow**: the `submission > value` guard
  makes both `submission * 3 / 2` and `submission + gasCost` safe, and checked
  arithmetic reverting is the one thing `forward` may never do.
- **`FAILURE_RESERVE` survives the worst case** including a bounty payout, since
  `tx.origin` has sent a transaction and so is never an empty account charged
  the 25,000 creation cost.
- **Fee-on-transfer tokens revert at open** rather than drawing from the pool:
  neither contract holds a standing ERC-20 balance for a short pull to hide in.

---

## Working order, at review

`forge build` clean. 451 local tests and 23 fork tests against chains 1, 8453 and
4663 pass, as do all seven node suites. Two things ship without a caller and it
is worth saying so plainly rather than discovering it later:

- **`SlowArrival.forward` has no composer.** Every entry in the page's `BRIDGES`
  is `from: 1`, and there is no L2→L1 withdrawal path anywhere in the dapp. The
  L2↔L2 send that forwarding exists to make one action cannot be started from
  the page.
- **`SlowRelay` is not referenced by the dapp at all.** It is driven only by
  `scripts/relayer.mjs`, which describes itself as not production
  infrastructure.

Neither is a defect. Both are the difference between a contract that is correct
and a product that is live, and only the first of those was in scope here.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify
> the complete absence of vulnerabilities and no guarantee of security is given.
> Team security reviews, bug bounty programs, and on-chain monitoring are
> strongly recommended.
