# 🔐 Security Review — SLOW bridge layer

Twelve-lens adversarial review of the cross-chain contracts, run immediately
after they were written and before any of them shipped. Sixteen findings
confirmed and remediated; every fix carries a regression.

---

## Scope

| | |
| --- | --- |
| **Method** | [pashov-ai `solidity-auditor`](https://github.com/pashov/skills) v3 — 12 parallel attacker lenses, dedup, four-gate validation |
| **Date** | 2026-09-04 |
| **Files reviewed** | `SlowOrigin.sol` · `SlowArrival.sol` · `SlowRelay.sol`<br>`SlowBridgeRegistry.sol` — 1,184 lines |
| **Companion** | `slow-pashov-ai-audit-report-20260904-095600.md` covers the protocol contracts |

**The property everything here turns on.** SLOW records
`pendingTransfers[id].from = msg.sender`, and only that address may `reverse` or
`clawback`. So on any bridged deposit, whoever the destination chain believes is
calling owns the right to undo the transfer. Getting sender recovery wrong does
not degrade the product — it removes the only thing the product is for.

---

## Findings

### [95] 1. Every sender could rob every relayer

`SlowRelay.cancel` · Confidence 95 · **found by 10 of 12 lenses**

**Description**
`cancel` gated on `provenBy[id] == address(0)` — the arrival of the news, not the
fact of the fill. The only writer of `provenBy` is `receiveRelay`, reachable only
through a canonical L2→L1 exit: ~7 days on OP Stack, ~6.4 on Nitro. And
`_checkOpen` accepted any `fillDeadline` one second in the future.

So: open with a one-hour window, let a relayer deliver real inventory, refund the
escrow an hour later while the proof is still six days out. `release` then reverts
`NotOpen` forever. With `reverse` on the far side the sender takes both legs —
20.01 ETH out of 10.01 ETH in, repeatable, on four of the six routes.

The in-code mitigation told relayers to protect themselves by not filling close
to the deadline. That advice cannot be followed: for any deadline shorter than
the challenge period there is no safe fill time, including the first block.

**The test suite was hiding it.** `test_cancelIsBlockedOnceAFillIsProven` landed
the proof in the same block and *then* warped past the deadline, modelling zero
proof latency. It passed while the drain sat green underneath it.

**Response — FIXED.** `PROOF_GRACE = 8 days`, which clears the longer challenge
period, so the earliest possible proof always precedes the earliest possible
refund whenever within the window the fill happened. The test warps first now,
and `test_cancelCannotOutrunAnUnprovenFill` pins the drain itself.

---

### [90] 2. One token address used on two chains

`SlowRelay.fill` / `openToken` · Confidence 90 · found by 3 of 12 lenses

**Description**
`Intent` carried a single `token` used to escrow on the source chain and to
deliver on the destination. USDC is `0xA0b8…` on Ethereum and `0x8335…` on Base,
so for every canonical ERC-20 those are different contracts. Best case the honest
relay simply reverts (Solady rejects a codeless token) and the escrow is frozen
until the deadline; worst case a relayer replays a deterministic-factory
deployment on the destination, fills with a worthless clone, and collects the
real escrow. `SlowArrival` restricts itself to native ETH for exactly this
reason.

**Response — FIXED.** `Intent` carries `srcToken` and `dstToken`, both hashed
into `intentId` and `INTENT_TYPEHASH`, so neither leg is inferred.

---

### [90] 3. Three ways to destroy an arrival

`SlowArrival.arrive` · Confidence 90 · found by 5 of 12 lenses

**Description**
On the OP leg the portal marks a withdrawal finalized *before* calling, and never
replays it. So any revert in `arrive` burns the ETH permanently — which is why
the contract's own docblock says it must never revert. Three paths did:

- **The failure reserve inverted.** `budget > RESERVE ? budget - RESERVE : budget`
  kept nothing back in the one band the reserve exists for, handed everything to
  a deposit that could not fit, and left the rescue write without gas.
- **The deposit's return was read into `bytes memory`**, copying the full
  `returndatasize()`, while `_mint` bubbles the recipient hook's revert data
  verbatim.
- **A bounty at or above the payload** was clamped to the payload, so a finaliser
  took the whole arrival as a tip and the deposit was skipped entirely — with no
  `Arrived` and no `rescue` recording where it went.

**Response — FIXED.** The reserve bails out instead of gambling; the call uses a
fixed 32-byte return window; an over-large bounty is refused and the payload
continues to its recipient.

**One correction worth recording.** Two lenses asserted the returndata bomb was
exploitable here. A third tested it — 231 combinations, 200k–1.2M gas × 50KB–500KB
— and measured **zero reverts**: the callee pays memory expansion twice for every
once the caller pays, so it exhausts its own budget first. The fix stands on its
merits and removes the class, but that specific path was not demonstrated. The
same shape in `SlowOrigin._probe` **is** real and measured: 307,153 gas against
9,217 for one `recover()`, a 3× overrun of the documented cap.

---

### [88] 4. The bounty was paid to an address with no key

`SlowArrival.arrive` · Confidence 88 · found by 5 of 12 lenses

**Description**
The bounty went to `tx.origin`, correct on the L2→L1 legs where a finaliser
really did push the message. On the auto-executed L1→L2 legs nobody pushed
anything: both stacks run the message with `tx.origin == msg.sender == the
aliased sender`, an address with no key on either chain. And the failure was
silent — a value call to a codeless address returns success, so `paid` was true
and the `rescue` fallback never fired.

**Response — FIXED.** The payout is skipped and credited to `rescue` when
`tx.origin == msg.sender`, which is precisely the no-finaliser case.

---

### [85] 5. A relayer that rejects ETH entombed the escrow

`SlowRelay.release` · Confidence 85 · found by 1 of 12 lenses

**Description**
`release` pushed to the immutable `filledBy` address. A relayer filling from a
contract with a reverting `receive()` made the payout revert every time — while
`provenBy != 0` simultaneously and permanently blocked the sender's refund. The
escrow was unreachable for the cost of gas, and the griefer recovered their own
fill if they were also the recipient.

**Response — FIXED.** `releaseTo` lets the proven relayer name and re-name a
destination, so a failed payout is a retry rather than a tomb.

---

### [85] 6. `clawback` was missing entirely

`SlowRelay` · Confidence 85 · found by 3 of 12 lenses

**Description**
Filling makes SlowRelay `pt.from`, which carries two rights in SLOW: `reverse`
during the timelock and `clawback` thirty days after expiry. Only the first was
exposed. A recipient who never settled — lost key, a contract that cannot
receive, a typo — left the money with no exit at all. The relayer is paid from
the source escrow either way, so the entire loss fell on the sender.

**Response — FIXED.** `clawback(transferId, to)` mirrors `reverse`, with its own
`ClawedBack` event so nothing downstream confuses the two.

---

### [85] 7. `pushProof` burned whatever it was sent

`SlowRelay.pushProof` · Confidence 85 · found by 4 of 12 lenses

**Description**
The OP branch forwarded `msg.value` into `depositTransaction`, which reads
attached value as a **mint** to `from` — and `from` is `applyAlias(address(this))`,
the address this contract's own security argument relies on nobody being able to
reach. The Arbitrum twin genuinely needs value, so a keeper computing one fee for
both families destroyed it on every OP push. Separately, that twin named
`msg.sender` for both refund addresses, which Nitro aliases when the caller is a
contract — sending a keeper's excess submission fee and unused prepaid gas to its
own unreachable alias, every time.

**Response — FIXED.** The OP branch refuses non-zero `msg.value`; refunds go to
an address that exists on the far side. *Residual, disclosed:* the refund
heuristic sends a keeper **contract's** over-provisioned capital to `tx.origin`,
a different party from the one that funded it. An explicit `refundTo` parameter
is the honest fix and is an ABI change; deferred deliberately.

---

### [82] 8. `recover` claimed a proof it could not make

`SlowOrigin.recover` · Confidence 82 · found by 2 of 12 lenses

**Description**
Branch 4 returned `authenticated = true` whenever `applyAlias(hint) == msg.sender`,
on the stated reasoning that nobody could arrange to sit at that address for an
address they did not control. That reads the equation backwards: it pins `hint`
*given* `sender`, and `applyAlias` is a bijection, so for any caller there is
exactly one satisfying `hint` — `undoAlias(msg.sender)` — computable by anyone.
A genuine aliased arrival and a direct caller passing that value are
indistinguishable from inside the contract.

**Response — FIXED.** The branch returns `(hint, false)`. `hint` is still the
right origin — for a real arrival it is the true sender, for a forger it names an
address they are handing their own rights to — but the claim of proof is
withdrawn. The unforgeable form is the inverted one `SlowRelay._authenticatedSelf`
already uses, which pins the target instead of accepting it.

---

### [82] 9. Escrows could be opened that no fill could satisfy

`SlowRelay.onERC1155Received` / `_validate` · Confidence 82 · found by 6 of 12 lenses

**Description**
The ERC-1155 door re-implemented `_checkOpen` inline and had drifted by two
checks, admitting intents that `SLOW.depositTo` refuses on the destination — so
the escrow looked OPEN to every relayer watching the event while being
structurally unfillable, and the value was frozen until the deadline. The same
hook was reachable from `_mint` with `from == address(0)`, opening an escrow
whose `cancel` was unreachable forever.

**Response — FIXED.** One `_validate` used by both doors, `from == address(0)`
rejected. A later lens found the unified predicate still stopped two clauses
short of `depositTo`'s own preconditions — `to != slow` and the 100-year delay
ceiling — and both are now mirrored at open.

---

### [80] 10. A misnamed trusted set that fails silently

`SlowRelay` constructor · Confidence 80 · found by 1 of 12 lenses

**Description**
`trustedInbox` / `UntrustedInbox` / a constructor taking `inboxes` — and an Inbox
is precisely the one contract that must never go in it. `proveFill` sends through
`OP_MESSENGER.sendMessage` and `ArbSys.sendTxToL1`; what arrives is whatever
*delivers* the message: the L1CrossDomainMessenger on OP, the Arbitrum **Bridge**
on Nitro. Meanwhile `pushProof`'s Arbitrum branch genuinely takes an Inbox, so
the word named two different contracts in one file.

A deployer following the parameter name would fail silently: deployment succeeds,
`open`/`fill`/`cancel` all work, and only `receiveRelay` rejects every real proof.
Senders keep refunding; relayers are never paid for anything they delivered. The
test doubles implement only `l2Sender()`, so neither production authentication
shape is exercised — the suite would not catch it either.

**Response — FIXED.** Renamed `trustedMessenger` / `UntrustedMessenger` /
`messengers`, with the per-family values written at the mapping.

---

### [80] 11. `SlowArrival` trusted an undeployed SLOW

`SlowArrival` constructor · Confidence 80 · found by 1 of 12 lenses

**Description**
A value-bearing call to a codeless address returns success with empty
returndata, which `arrive` reads as a failed deposit — so it would credit
`rescue` for ETH that had already left the contract, and the first claimant
would drain whatever balance remained. The CREATE3 same-address design makes
deploying this before SLOW an easy ordering mistake.

**Response — FIXED.** The constructor refuses a codeless `slow_`.

---

## Findings list

| # | Conf. | Title | Lenses | Status |
| --- | --- | --- | --- | --- |
| 1 | 95 | `cancel` outruns the proof; every sender robs every relayer | 10/12 | Fixed |
| 2 | 90 | One token address used on two chains | 3/12 | Fixed |
| 3 | 90 | Three ways to destroy an arrival | 5/12 | Fixed |
| 4 | 88 | Bounty paid to an address with no key | 5/12 | Fixed |
| 5 | 85 | A relayer rejecting ETH entombed the escrow | 1/12 | Fixed |
| 6 | 85 | `clawback` missing entirely | 3/12 | Fixed |
| 7 | 85 | `pushProof` burned attached value; refunds aliased | 4/12 | Fixed |
| 8 | 82 | `recover` claimed an unprovable authentication | 2/12 | Fixed |
| 9 | 82 | Unfillable escrows through the 1155 door | 6/12 | Fixed |
| 10 | 80 | Misnamed trusted set fails silently at deploy | 1/12 | Fixed |
| 11 | 80 | `SlowArrival` trusted an undeployed SLOW | 1/12 | Fixed |

---

## A fix proposed and rejected

One lens proposed that `arrive` prefer an unmatched `originHint` over the
recovered origin, reasoning that the alias fallback burns funds while a
mis-attribution is only a gift. It was applied, and
`test_aliasHintWithoutAValueIsHarmless` failed.

The test pins the better property: an unmatched hint is **refused**, so a direct
caller owns its own deposit. Taking the hint would let anyone hand a stranger the
reverse right by naming them. It would also not fix the case that actually burns
— a hint *omitted*, where there is no hint to prefer. A correct hint is already
honoured through the alias branch, so the real requirement is that L1→L2 callers
pass one, and that is now documented where the decision lives.

---

## Open, and deliberately not fixed

- **`PROOF_GRACE = 8 days` may be thin.** An OP exit is not one clock: prove →
  7-day maturity → finalize, and an invalidated dispute game forces a re-prove
  that restarts maturity from zero. Roughly 24h of slack. Worth checking Base's
  live dispute-game parameters before launch.
- **`pushProof`'s refund heuristic** reassigns a keeper contract's capital to
  `tx.origin`. Needs an explicit `refundTo` parameter — an ABI change.
- **Nothing points at `SlowArrival`.** The page still bridges straight into SLOW,
  so `pt.from` is the alias and reverse/clawback are dead on those routes, while
  the review screen promises both. This is the exact bug `SlowArrival` was
  written to fix, and it is not yet wired up.
- **The same-address assumption** behind `originOf` holds for EOAs and is
  unverified for smart accounts, which may not share an address across chains.

---

## Checked and clean

- `_authenticatedSelf` is genuinely unforgeable — the alias branch has no
  reachable preimage, and the duck-typed branch is gated behind the trusted set.
- Escrow pool conservation: every intent draws exactly `amount + fee` once, and
  `intentId` is injective over a fixed-size struct.
- Exactly-once payout: `statusOf` is one-way `NONE → OPEN → {RELEASED, CANCELLED}`.
- ETH conservation in `SlowArrival` across the full deposit/bounty/rescue matrix.
- `_validSignature`: low-`s` enforced, zero-address recovery rejected, ERC-1271
  fallthrough returns false for EOAs, precompiles unreachable as signers.
- Reentrancy: every payout path is checks-effects-interactions, with `statusOf`
  and `originOf` written before any external call.
- Alias arithmetic round-trips exactly, and `intentId` agrees between calldata
  and memory encodings.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify
> the complete absence of vulnerabilities and no guarantee of security is given.
> Team security reviews, bug bounty programs, and on-chain monitoring are strongly
> recommended. For a consultation regarding your projects' security, visit
> [https://www.pashov.com](https://www.pashov.com)
