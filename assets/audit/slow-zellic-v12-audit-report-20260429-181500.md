# 🔐 Security Review — SLOW (Zellic V12) + Maintainer Responses

---

## About this document

This is the autonomous AI audit of `src/SLOW.sol` produced by **Zellic V12** ([v12.sh](https://v12.sh/)), reproduced with a **Maintainer response** after each finding. Responses record the disposition (accept / false positive / redeploy) and the reasoning, verified against source and the pinned dependency.

| | |
| --- | --- |
| **Auditor** | Zellic V12 — autonomous AI auditor ([v12.sh](https://v12.sh/)) |
| **Files reviewed** | `src/SLOW.sol` |
| **Evaluated against** | commit `a00f1466c339d1ea85c07e21f44a0bdc6ef2d26b` (commit not pinned in the V12 export) |
| **Solady pin** | `09cdd7c8d4b4d83ab7b0c1e313df05310c4fc920` |
| **Response date** | 2026-07-22 |
| **Findings** | 3 — all **Low**, all **Validity: Unreviewed** (V12 did not self-verify any) |

### Maintainer verdict

**No finding forces a redeploy, and no confirmed fund-loss path exists.** All three are marked *Low / Unreviewed* — V12's pipeline surfaced hypotheses without verifying them. On verification:

- The one finding with a fund-draining *claimed* impact (**#54070**, multicall `msg.value` reuse) is a **verified false positive**: the pinned Solady `Multicallable.multicall` opens with `if (msg.value != 0) revert();`, so no ETH-bearing call can ever enter a multicall and the reuse premise is impossible.
- **#54067** is not a finding at all — V12's own conclusion is *"No root cause, behavior is mathematically sound."*
- **#54071** is the fee-on-transfer limitation already documented in NatSpec and README, and independently raised by the GPT-5.6 Pro and OneDollarAudit reviews.

| ID | V12 severity / validity | Maintainer disposition |
| --- | --- | --- |
| #54067 — Fungibility of timelocked wrappers is correct | Low / Unreviewed | **Non-finding** — self-resolved; confirms design |
| #54070 — Multicall reuses `msg.value` across payable deposits | Low / Unreviewed | **False positive** — verified against pinned Solady |
| #54071 — Face-value minting breaks fee-on-transfer deposits | Low / Unreviewed | Accept — documented, isolated per-token |

---

# Findings with maintainer responses

## #54067 — Fungibility of timelocked wrappers is correct

**V12 severity: Low · Validity: Unreviewed**

V12 walks the `reverse` / `clawback` paths and the fungible-id model at length, probing whether a recipient `to` could move or spend wrapper tokens out from under a pending `reverse` / `clawback`, or whether `unlockedBalances` could be manipulated. It observes that:

- delayed deposits `_mint(to, id, amount)` but **do not** credit `unlockedBalances[to][id]`, so `to` cannot move the wrapper until `unlock` runs;
- all `(token, delay)` pairs map to one fungible `id`, so `reverse` / `clawback` reclaim `amount` of a fungible balance rather than specific units;
- after settlement paths run, balances reconcile correctly.

**V12 root cause:** *"No root cause, behavior is mathematically sound."*
**V12 impact:** *"Clawback works correctly because the fungible tokens are just a representation."*

> ### 🛠 Maintainer response — **Non-finding. Confirms the design; no action.**
>
> This is V12 reasoning out loud and correctly talking itself out of a bug. Independently confirmed: the safety invariant is that **the sum of a recipient's not-yet-settled pending inbound amounts for an `id` is always ≤ their `balanceOf[id]`.** Pending tokens are minted to `to` and can only leave `to` via (a) `unlock` → then spend against `unlockedBalances`, or (b) `reverse` / `clawback`, which remove exactly `amount` and delete the pending record. Because a pending amount contributes to `balanceOf` but never to `unlockedBalances`, `to` cannot spend it down below the pending total — so `reverse` / `clawback` always find the `amount` they reclaim. Fungibility is the point, not a flaw. Nothing to change.

---

## #54070 — Multicall reuses `msg.value` across payable deposit paths

**V12 severity: Low · Validity: Unreviewed**

**V12 description.** `SLOW` inherits `Multicallable`, so batched calls execute through `delegatecall` and each sub-call observes the same original `msg.value`. `depositTo` and `depositToWithTip` use raw `msg.value` as if freshly supplied, without accounting for ETH consumed by earlier sub-calls. V12 claims this lets an attacker replay one ETH payment to mint the same wrapped amount multiple times, and replay the tip so the contract forwards `tip` on every sub-call.

**V12 impact (claimed).** *"An attacker can use one ETH payment to mint unbacked wrapped balances and then withdraw or reverse them, draining ETH that backs legitimate users' deposits… allowing protocol ETH to be siphoned out despite only a single upfront payment."*

> ### 🛠 Maintainer response — **False positive. Verified against the pinned dependency.**
>
> The premise is impossible for this contract. The pinned Solady `Multicallable` (commit `09cdd7c8…`, the exact submodule pin) begins `multicall` with:
>
> ```solidity
> function multicall(bytes[] calldata data) public payable virtual returns (bytes[] memory) {
>     if (msg.value != 0) revert();   // guard against double-spending
>     _multicallDirectReturn(_multicall(data));
> }
> ```
>
> **Any multicall carrying ETH reverts before dispatching a single sub-call**, so `msg.value` can never be multiplexed across delegated deposits. Concretely:
> - `depositTo`'s ETH branch requires `msg.value != 0` — unreachable inside a multicall.
> - `depositToWithTip` requires `tip != 0` and `msg.value == amount + tip` (ETH) or `msg.value == tip` (ERC20), so its `msg.value` is **always** nonzero — it can **never** be placed in a multicall at all.
> - The only multicall-eligible deposit is `depositTo` with an ERC-20 (`msg.value == 0`), which pulls a fresh `amount` via `safeTransferFrom(msg.sender, …)` on every sub-call — each mint is fully backed. No reuse, no unbacked minting.
>
> This is exactly why the contract's header NatSpec and README call it out ("payable deposits cannot be batched to drain the pool via `msg.value` reuse"), and the pashov-ai and GPT-5.6 Pro reviews independently classed it as structurally impossible / a correct control. V12 marked this *Unreviewed* — i.e. it generated the classic multicall-`msg.value` pattern without checking the dependency that neutralizes it. **No fund loss, no redeploy.**

---

## #54071 — Face-value minting breaks fee-on-transfer deposits

**V12 severity: Low · Validity: Unreviewed**

**V12 description.** `depositTo` / `depositToWithTip` credit and mint using the caller-supplied `amount` rather than the balance actually received, so fee-on-transfer ERC-20s leave wrapper supply overstated versus real reserves; later `withdrawFrom` / `claim` can redeem the inflated balance, consuming reserves of other depositors of that token. V12 notes the code comments already assume vanilla ERC-20 semantics.

**V12 impact.** Deposit a fee-on-transfer token, receive wrapper for more than the contract holds, redeem the inflated balance — draining reserves for that token id.

> ### 🛠 Maintainer response — **Accept. Documented, isolated per-token; not a redeploy blocker.**
>
> Valid and already an explicitly documented, accepted limitation — the [depositTo](../../src/SLOW.sol#L457-L460) NatSpec and README ("Unsupported tokens") both state fee-on-transfer / rebasing assets break the 1:1 accounting and should be wrapped to a non-rebasing equivalent first. Same substance as GPT-5.6 Pro **SLOW-05** and OneDollarAudit findings 3 / 7.
>
> The "drains reserves" framing overstates scope: reserves are pooled **per underlying token**, so a nonstandard token's deficit is confined to depositors who opted into that token — it cannot touch ETH, USDC, or any other id. A balance-delta measurement (`balanceOf` before/after) would harden the deposit path against transfer-tax tokens and is a reasonable future-version change, but it does not alter the risk for the intended assets and is not required of the deployed contract. **Accept.** (See the FoT caveat now mirrored onto `depositToWithTip` per the OneDollarAudit follow-up.)

---

## Maintainer remediation summary

**Redeploy required: none.**

1. **#54070** — no action; verified false positive against the pinned Solady `Multicallable`.
2. **#54067** — no action; V12 self-confirmed the design is sound.
3. **#54071** — no code change required; fee-on-transfer is a documented, per-token-isolated limitation. Optional future hardening: measure the received-balance delta on deposit.

## Review limitations

V12 is an autonomous AI auditor; every finding here is marked *Validity: Unreviewed*, meaning it was surfaced but not self-verified by the tool. Maintainer responses were verified against `src/SLOW.sol` and the pinned Solady dependency. Independent human review and executable regression tests remain recommended.

---

> ⚠️ This review was performed by an autonomous AI auditor (Zellic V12, [v12.sh](https://v12.sh/)), with maintainer responses added by a second AI assistant. AI analysis cannot guarantee the absence of vulnerabilities; team security reviews, bug bounties, and on-chain monitoring remain essential.
