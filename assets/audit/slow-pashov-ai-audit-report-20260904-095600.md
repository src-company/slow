# 🔐 Security Review — SLOW (multichain redeployment)

Twelve-lens adversarial review of the build going to Ethereum (1), Base (8453)
and Robinhood Chain (4663). Seven findings confirmed, all remediated in this
repo; every fix carries a regression test.

---

## Scope

| | |
| --- | --- |
| **Method** | [pashov-ai `solidity-auditor`](https://github.com/pashov/skills) v3 — 12 parallel attacker lenses, dedup, four-gate validation |
| **Date** | 2026-09-04 |
| **Files reviewed** | `SLOWNext.sol` · `SlowPermit.sol` · `SlowGuardianIndex.sol`<br>`SlowBridgeRegistry.sol` · `SlowLens.sol` · `SlowPage.sol` — 2,184 lines |
| **Excluded** | `src/SLOW.sol` — the frozen v1 live at `0x0000…AaBC`, covered by the four earlier reports in this folder |
| **Confidence threshold** | ≥ 80 receives a fix |

**Why this review exists.** None of the four prior reports mentions `SlowPermit`,
`SlowGuardianIndex` or `SlowLens`. The redeployment ships ~2,400 bytes of code
that had never been audited, and that moves funds by signature.

---

## Findings

### [95] 1. Two dust deposits permanently brick the dapp's primary account read

`SlowLens._decimals` · Confidence 95 · found by 10 of 12 lenses

**Description**
`_decimals` staticcalls an attacker-chosen address with no gas stipend. The
address is the low 160 bits of an ERC-1155 id, and `depositTo` lets anyone plant
one in a stranger's inbound list at a delay the victim can never outlast —
`reverse` and `clawback` belong to the depositor, `unlock` never matures. The
sibling `_symbol` probe eleven lines above was capped, with a comment naming this
exact DoS. Measured: `viewOf` at a 50M budget survived two hostile tokens and
reverted on three, for ~826,000 gas of attacker cost, permanently.

**Response — FIXED.** Both probes now route through `MetadataReaderLib`. See
finding 2: a gas cap alone was not sufficient, so the fix is shared.

---

### [90] 2. The obvious fix for finding 1 does not close it

`SlowLens._symbol` · `_tokens` · Confidence 90 · found by 2 of 12 lenses

**Description**
Both probes read into `bytes memory`, which copies the full `returndatasize()`
into the caller's frame; memory expansion is quadratic and cumulative across the
`_tokens` loop. A token returning 134,400 bytes from `symbol()` fits *inside* the
50,000-gas cap, so the callee's budget bounds nothing that matters. Measured with
a cap on **both** probes: 5 tokens → 1,414,631 gas; 10 → 4,557,405; 20 →
16,196,596; 30 → past 30M and reverting, against 911,131 for thirty benign
tokens. Sixteen deposits at ~253,300 gas each brick the account for good.

This is the most valuable result of the run. Six lenses independently found
finding 1 and all prescribed a one-line gas cap; one lens tested that fix and
measured it insufficient.

**Response — FIXED.** Both hand-rolled probes replaced with
`MetadataReaderLib.readSymbol(token, 64, 50000)` and
`readDecimals(token, 50000)`, which bound the copy with
`min(returndatasize(), limit)` as well as the callee's gas. The library was
already imported by `SLOWNext` for `uri()` — which is precisely why `uri()` was
never griefable while the lens was. Regressions in `test/SlowLens.t.sol` cover a
gas bomb, a returndata bomb, and an assertion that cost stays linear rather than
quadratic in the number of hostile tokens.

```diff
- (bool ok, bytes memory ret) = token.staticcall{gas: 50000}(abi.encodeWithSelector(0x95d89b41));
- (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x313ce567));
+ string memory sym = MetadataReaderLib.readSymbol(token, 64, 50000);
+ uint256 d = MetadataReaderLib.readDecimals(token, 50000);
```

---

### [90] 3. A dust deposit permanently voids every guardian approval

`SLOWNext._finishDeposit` · Confidence 90 · found by 5 of 12 lenses

**Description**
Guardian approvals were keyed on `nonces[from]`, and `_finishDeposit` advances
that counter on any delayed deposit — a path with no guardian check anywhere on
it. So the compromised key the guardian exists to defend against could invalidate
every standing approval for 1 wei plus gas, repeatedly, and batch ten per
transaction through the inherited `multicall` (2,070,388 gas), out-ordering any
guardian who pre-approved a window of future nonces.

It was a freeze, not a delay, because the victim could not route around it.
`setGuardian(0)` stages a one-day window after which `commitGuardian` was
permissionless — so the thief committed it and, still holding the key, took the
balance. Keep the guardian and no approval is ever current; drop it and the funds
are stolen. Reproduced end-to-end: `guardianApproved` remained literally `true`
in storage while `withdrawFrom` reverted `GuardianApprovalRequired`.

**Response — FIXED.** Guarded operations moved to their own counter,
`guardianNonces`, advanced only by the `guardian != address(0)` paths of
`withdrawFrom` / `safeTransferFrom`. Deposits keep `nonces` and now carry a third
op byte, `_OP_DEPOSIT`. Both halves are necessary: separating the counters is
what stops a deposit voiding an approval, and separating the op byte is what
stops the two id spaces overlapping once they no longer share a counter — without
it, a deposit id and a transfer id could coincide and one would overwrite the
other's pending entry. `predictDepositId` was added so the deposit space stays
predictable. Regression: `testDepositCannotVoidAGuardianApproval`.

---

### [85] 4. A proposed guardian can install itself by front-running the documented abort

`SLOWNext.commitGuardian` · Confidence 85 · found by 1 of 12 lenses

**Description**
`cancelGuardianChange` required `msg.sender == user || guardians[user]`;
`commitGuardian` required nothing. The NatSpec advertises a late abort — propose
someone else, then cancel inside the new window — and any mempool observer, most
obviously the guardian being installed, front-ran that transaction with the
permissionless commit. Once installed it vetoed every later rotation using its
own legitimate cancel right, and the user could not name themselves
(`InvalidGuardian`). Five successive escape attempts were reproduced, all
blocked, leaving the balance permanently unreachable.

The hostile-guardian veto is documented as an accepted trade-off. A guardian
*installing itself against the user's will* is not.

**Response — FIXED.** `commitGuardian` now requires the caller to be one of the
two parties the change is between. Either can still land it once the window has
passed, so nothing is strandable. Regression:
`testCommitGuardianRejectsAStranger`.

```diff
+ require(msg.sender == user || msg.sender == guardians[user], Unauthorized());
```

---

### [85] 5. The lens had no pagination, so entry count alone was a denial of service

`SlowLens.viewOf` · `_load` · Confidence 85 · found by 6 of 12 lenses

**Description**
Independent of the probe bugs, `viewOf`, `inboundOf`, `outboundOf` and
`wardTransfers` iterated an attacker-growable, permanently-unremovable set with
no bound and no paginated variant. `SLOWNext`'s own NatSpec tells consumers to
paginate with `inboundTransferCount` + `inboundTransferAt`; the lens was the
consumer that warning was written for, and its interface did not even declare
those functions. Roughly 300 dust entries push the read past a 30M `eth_call`
ceiling — cheap on the L2 targets — taking the victim's outbound view with it.

**Response — FIXED.** Added `viewOfAt`, `outboundOfAt`, `inboundOfAt` and
`counts`, all built on a `_loadRange` whose clamp is computed before the add and
outside `unchecked`, so a large `count` cannot wrap into an underflowed length.
Regressions cover windowing, the short final window, and clamping at
`type(uint256).max`.

---

### [80] 6. One recipient's ordinary unlock destroyed a keeper's whole batch

`SLOWGateNext.claimMany` · Confidence 80 · found by 1 of 12 lenses

**Description**
`claimMany` settled ids in a loop with no per-id failure isolation. Any recipient
front-running with a normal `unlock` made `claimTipped` revert
`TransferDoesNotExist`, taking the entire batch with it. Measured 1,375,690 gas
for an uninterrupted `claimMany(20)` against 77,602 gas to kill it — 17.7×
leverage, scaling with batch size, and indistinguishable from honest behaviour.
The contract prescribed "keepers must filter ids off-chain", which cannot cover a
front-run. This attacked the tip mechanism the batch primitive exists to serve.

**Response — FIXED, with a correction worth recording.** Each id is now isolated.
The first attempt used `try this.claim(id)`, which was wrong: an external
self-call rewrites `msg.sender`, and `_claimAndPay` pays `msg.sender` — every tip
would have gone to the gate instead of the keeper. The repo's existing
`testGateClaimManyMixesTippedUntipped` caught it. The payee is now threaded
explicitly through a self-call-only `claimOne(transferId, payee)`.

```diff
- _claimAndPay(transferIds[i]);
+ try this.claimOne(transferIds[i], msg.sender) {} catch {}
```

---

### [80] 7. An unbounded delay made a pending entry unremovable forever

`SLOWNext.depositTo` · Confidence 80 · found by 1 of 12 lenses

**Description**
`delay` was an unvalidated `uint96`. At `type(uint96).max` (~7.9 × 10²⁸ seconds)
`unlock`, `_doClaim` and `clawback` are permanently unreachable while `reverse`
stays with the depositor, so an unwanted entry — and the wrapper minted to the
victim — was frozen in their account for good. This is the structural root cause
that made findings 1, 2 and 5 permanent rather than transient. The dapp already
offered a 100-year ceiling; the contract enforced none.

**Response — FIXED.** `_MAX_DELAY = 3155760000` (100 years, matching the
interface), enforced in `_finishDeposit` so one check covers all four deposit
entrypoints and cannot drift between them. Regression:
`testDepositRejectsADelayPastTheCeiling`.

---

## Findings list

| # | Confidence | Title | Lenses | Status |
| --- | --- | --- | --- | --- |
| 1 | 95 | Uncapped `_decimals` probe bricks the account read | 10/12 | Fixed |
| 2 | 90 | Returndata amplification survives the gas cap | 2/12 | Fixed |
| 3 | 90 | Dust deposit voids every guardian approval | 5/12 | Fixed |
| 4 | 85 | Proposed guardian front-runs the documented abort | 1/12 | Fixed |
| 5 | 85 | Lens has no pagination | 6/12 | Fixed |
| 6 | 80 | `claimMany` batch killed by an honest `unlock` | 1/12 | Fixed |
| 7 | 80 | Unbounded delay makes entries unremovable | 1/12 | Fixed |

---

## Leads

_Trails with concrete code smells where the exploit path could not be completed.
Not false positives — high-signal material for manual review. Unscored._

- **Guardian flag answered the wrong question** — `SlowLens._one` — 7 lenses. The
  field decorated an already-created pending transfer with
  `guardianApproved(user, predictWithdrawalId(...))`, a different operation under
  a different op byte, read at the live nonce so it flipped between blocks.
  **Response — FIXED.** Removed. A pending transfer has no outstanding guardian
  decision: the approval that authorised it was consumed and deleted at creation,
  and settlement consults none. Removing it also drops two external calls per
  outbound row, which was a measurable amplifier of finding 5.

- **`permitSelf` left unguarded on a false premise** — `SlowPermit.permitSelf` —
  5 lenses. The only state-mutating entrypoint without `nonReentrant`, reaching
  the same arbitrary `token.call`. The commit justified the omission as avoiding
  a `multicall` deadlock; that was tested and is wrong — Solady clears the
  transient slot at modifier exit and `multicall` is itself unguarded.
  **Response — FIXED.** Guard applied, false rationale replaced.

- **Recipient guards were dead code costing EIP-170 headroom** —
  `SlowPermit.depositToWithPermit` — verified directly: `_mint` already rejects a
  zero recipient, and `address(this)` is a code-bearing non-receiver so
  `_checkOnERC1155Received` rejects it too. ~213 bytes spent re-rejecting the
  unreachable, against a ~500-byte margin. **Response — REMOVED**, which funded
  the fixes above. The property is still asserted in tests, without pinning which
  layer enforces it.

- **Tip bound dropped on one of two sibling entrypoints** —
  `SlowPermit.depositToWithTipAndPermit` — 7 lenses. Unreachable at ~79 billion
  ETH, and the gate's own check catches it, but the two tipped paths validated
  the same parameter differently. **Response — FIXED**, bound restored.

- **Anyone can force wards onto any address** — `SlowGuardianIndex._addWard` — 4
  lenses. `setGuardian` needs no consent from the named guardian, each call
  permanently appends to `_wards`, and the guardian has no removal path.
  **Response — ACKNOWLEDGED, not fixed.** Read-side griefing only; `wardsAt`
  paginates and the dapp wraps the call in try/catch with fallback tiers. A
  `renounceWard` would cost EIP-170 headroom the build does not have. Revisit if
  the index ever gains a state-changing consumer.

- **Receiver hook fires before accounting is final** — `SLOWNext._finishDeposit`
  — 3 lenses. `_mint` calls `onERC1155Received` before `pendingTransfers`, the
  enumeration sets and the tip are written. **Response — ACKNOWLEDGED.** No path
  to funds was found; `nonReentrant` blocks every state-changing re-entry. The
  exposure is to integrators reading state from the callback, which is a
  documentation matter rather than a contract defect.

- **Tip strandable for a hookless contract depositor** — `SLOWGateNext.refundTip`
  — **Response — ACKNOWLEDGED.** Requires the recipient to grief at their own
  expense; the receiver-hook requirement on `reverse`/`clawback` is already
  documented.

---

## Checked and clean

- The conservation law `balanceOf(x,id) == unlockedBalances[x][id] + Σ
  pending-inbound` holds across every mutating path — verified independently by
  six lenses.
- Transfer-id uniqueness and the op-byte split: no collision, no cross-op
  approval consumption, no packing ambiguity (all preimage members fixed-width).
- ETH conservation across SLOW ↔ gate; both payout paths delete before their
  external call; re-entry from either is a no-op.
- `Multicallable` does revert on non-zero `msg.value`, so batched payable
  deposits cannot reuse ETH.
- `SlowGuardianIndex` swap-and-pop and both `_indexGuardian` wiring sites,
  including `idx == last`.
- `uri()` is grief-proof via `MetadataReaderLib`'s stipend and byte limit;
  `_utf8Trim` and the `_symbol` decoder bounds were exact.
- Deposits to the gate revert on the receiver check — verified directly, contrary
  to several lenses' assumption that an explicit guard was load-bearing.
- `TSTORE` and `MCOPY` execute on all three target chains, so the transient
  reentrancy guard and solc 0.8.34 codegen are safe everywhere.

---

## ⚠️ The live contract inherits findings 3 and 4

The shared-nonce structure exists verbatim in `src/SLOW.sol` at lines 154, 171,
534, 579 and 630, and `commitGuardian` is permissionless there too. The deployed
contract at `0x000000000000888741B254d37e1b27128AfEAaBC` holds real funds under
both defects today. It is immutable, so this redeployment is the only opportunity
to fix them — and the disclosure question for the live contract is separate from,
and more urgent than, the deployment itself.

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify
> the complete absence of vulnerabilities and no guarantee of security is given.
> Team security reviews, bug bounty programs, and on-chain monitoring are strongly
> recommended. For a consultation regarding your projects' security, visit
> [https://www.pashov.com](https://www.pashov.com)
