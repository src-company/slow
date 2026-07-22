# 🔐 Security Review — SLOW (OneDollarAudit) + Maintainer Responses

---

## About this document

This is the AI-orchestrated multi-agent security audit of the deployed `SLOW` / `SLOWGate` contracts produced by **OneDollarAudit** (onedollaraudit.com), reproduced with a **Maintainer response** inserted after each finding. Responses record the disposition (accept / mitigate off-chain / redeploy) and the reasoning, verified against source.

| | |
| --- | --- |
| **Auditor** | OneDollarAudit — AI-orchestrated multi-agent pipeline |
| **Result page** | https://leftclaw.services/result/471.html |
| **IPFS (pinned copy)** | https://bafkreigcgf2rny7psw7diwvxgqmy6yui3g7i747362vinjljke3fqkhsda.ipfs.community.bgipfs.com/ |
| **Target** | `SLOW.sol` (1,007 lines) + `SLOWGate`, deployed at `0x000000000000888741B254d37e1b27128AfEAaBC` |
| **Source** | Verified on Sourcify as of April 2026, `solc 0.8.34` |
| **Response date** | 2026-07-22 |
| **Methodology** | Phase 0 protocol mapping → Phase 1 six checklist agents → Phase 2 twelve blind attack-simulation agents → hybrid reconciliation, confidence floor 50/100 |

### Maintainer verdict

**No finding forces a redeploy, and no finding is a fund-loss path.** This review is the most conservative of the three on file — every one of its 8 findings is Low or Info, and the report's own language ("no principal loss", "reverts only", "structural, not code-fixable", "documented in NatSpec") confirms it. Each finding is either already documented in `SLOW.sol` NatSpec / README or a trivial documentation improvement.

**Coverage note for future maintainers:** this review did **not** surface the guardian-`data`-binding item (see the GPT-5.6 Pro report, SLOW-01 — receiver `data` is not bound into the guardian-approval preimage). That remains the single item across all reviews worth a conscious accept-and-document decision. Its absence here is a coverage gap, not evidence the item is moot.

| # | Auditor confidence | Maintainer disposition |
| --- | --- | --- |
| 1 — Contract depositor cannot reverse/claw back | 85 | Accept — documented; "irreversible fund loss" overstated |
| 2 — `claimMany` griefable atomic batch | 80 | Accept — documented keeper responsibility |
| 3 — Token issuer blacklists/pauses the contract | 70 | Accept — inherent pooled-custody risk; document |
| 4 — Unbounded set growth via dust | 65 | Accept — documented, pagination exists |
| 5 — Permissionless `commitGuardian` invalidates in-flight approvals | 60 | Accept — intended behavior, not an attack |
| 6 — ERC-1155 compliance misrepresentation | 55 | Accept — intentional, documented |
| 7 — FoT caveat missing on `depositToWithTip` | 50 | **Actionable** — trivial NatSpec one-liner |
| 8 — Guardian indefinite veto window | 40 (Info) | Accept — documented trust model |

---

# Auditor report with maintainer responses

## Executive overview (auditor)

The review examined `SLOW` and `SLOWGate` on Ethereum mainnet using a hybrid methodology combining breadth-phase checklists with depth-phase attack simulations, identifying **8 findings, all Low or Info**. No Critical, High, or Medium issue survived the evaluation gates. All 21 external/public state-changing functions were examined; the report states no coverage gaps remain.

---

## Finding 1 — Irreversible fund loss for contract depositors

**Auditor confidence: 85**

Contract callers lacking an `IERC1155Receiver` implementation cannot recover deposits via `reverse` or `clawback`, because those functions invoke receiver hooks that revert on non-implementing contracts. Documented in NatSpec, but creates a latent trap where deposits appear successful but become unrecoverable by the sender.

> ### 🛠 Maintainer response — **Accept. Documented; severity label overstated.**
>
> **Confirmed.** [`reverse`](../../src/SLOW.sol) and [`clawback`](../../src/SLOW.sol) route the wrapper back to `pt.from` via `_safeTransfer`, which fires `onERC1155Received` on `pt.from`; a contract sender without the hook cannot be the recovery target. Documented in the NatSpec of both functions ("Contract depositors must implement `IERC1155Receiver` to be reverse-eligible").
>
> **"Irreversible fund loss" is an overstatement of impact.** No funds are stolen and nothing is stranded from the *recipient's* side — `pt.to` can still settle normally via `unlock` + `withdrawFrom` (or `claim`). What breaks is only the *sender's optional recovery path*, and only for a contract sender that directed tokens to a different `to`. This is a self-scoped ergonomics limitation, matching GPT-5.6 Pro SLOW-03 and the pashov-ai review's contract-sender lead.
>
> **Disposition:** accept; SDK/dapp integrators wiring depositor contracts should surface the receiver-hook requirement. A bound recovery address is a reasonable future-version ergonomics improvement, not a fix the deployed contract needs.

---

## Finding 2 — Griefable batch claims

**Auditor confidence: 80**

`claimMany` processes an uncapped array atomically. A recipient can front-run with `setGuardian` to block one id's settlement (`_doClaim` reverts `ClaimBlockedByGuardian`), reverting the entire keeper batch and burning gas across all transfers. No principal loss — griefing only.

> ### 🛠 Maintainer response — **Accept. Documented keeper responsibility.**
>
> **Confirmed.** [`claimMany`](../../src/SLOW.sol) loops `_claimAndPay` with no try/catch, so any single revert aborts the batch, and a recipient setting a guardian post-deposit blocks tipped settlement. This is documented at the `claimMany` NatSpec ("Keepers must filter ids off-chain — timelock-expired, no guardian on `pt.to`"), and the pashov-ai review flagged the same as a documented off-chain-filtering responsibility.
>
> No principal loss; SLOW's `nonReentrant` prevents any nested-claim theft. The keeper market absorbs the griefing by filtering ids before batching. **Disposition:** accept — no contract change; it is a keeper-integration property, not a defect.

---

## Finding 3 — Token-level blacklist / pause / burn risk

**Auditor confidence: 70**

Shared-vault architecture: if a token issuer blacklists or pauses the SLOW contract address, every holder of that token loses withdrawal access permanently — unlike recipient-level blacklists, which are recoverable by choosing an alternative withdrawal destination. Structural, requires token-issuer action rather than attacker exploitation.

> ### 🛠 Maintainer response — **Accept. Inherent pooled-custody risk; worth documenting.**
>
> **Correct, and correctly distinguished.** Because reserves are pooled per underlying token, an issuer freezing the SLOW contract address freezes every holder of that token — whereas a *recipient*-level freeze is recoverable, since [`withdrawFrom`](../../src/SLOW.sol) lets the holder choose `to`. This is inherent to any pooled-custody wrapper (it applies equally to any vault holding USDC/USDT), not specific to SLOW, and is not code-fixable without per-user segregated custody.
>
> **Disposition:** accept as an inherent systemic risk of admin-controlled underlying tokens. Worth a one-line addition to README Security Considerations alongside the existing nonstandard-token caveat, so integrators reason about issuer-controlled assets explicitly. New angle relative to the other two reviews; useful.

---

## Finding 4 — Unbounded set growth via dust deposits

**Auditor confidence: 65**

The unpaginated view functions `getInboundTransfers` / `getOutboundTransfers` can be pushed out-of-gas by third-party dust deposits accumulating in the underlying `EnumerableSet`. Paginated alternatives already exist as the intended mitigation.

> ### 🛠 Maintainer response — **Accept. Documented; pagination is the supported path.**
>
> Documented in the enumeration NatSpec block and README ("On-chain consumers should paginate via `inboundTransferCount` + `inboundTransferAt(i)`"). No state-mutating function walks the full set, so there is no on-chain DoS; attacker dust is recoverable via `clawback`, so it is not a fund-loss path. Impact is confined to off-chain indexers/UIs that ignore pagination. Matches GPT-5.6 Pro SLOW-06 and the pashov-ai below-threshold note. Accept.

---

## Finding 5 — Permissionless guardian-commitment races

**Auditor confidence: 60**

The permissionless `commitGuardian` can invalidate in-flight guardian-approved transfers by bumping `lastGuardianChange` before an approval lands, forcing reversions. No fund loss.

> ### 🛠 Maintainer response — **Accept. Intended behavior, not an attack.**
>
> **Accurate mechanic, but working as designed.** [`commitGuardian`](../../src/SLOW.sol) sets `lastGuardianChange = block.timestamp`, and every guardian-approval preimage folds in `lastGuardianChange` precisely so a rotation invalidates all dangling approvals at once — this is a deliberate safety property, documented at README's transfer-id section ("a guardian rotation invalidates every dangling approval"). It only fires on a rotation the user themselves staged via `setGuardian` and whose 1-day window already elapsed, so there is no arbitrary third-party trigger. Effect is a revert, never a loss. The 60 confidence and Low framing are appropriate; the disposition is accept — no change.

---

## Finding 6 — ERC-1155 compliance misrepresentation

**Auditor confidence: 55**

`supportsInterface` advertises ERC-1155, yet `safeBatchTransferFrom` unconditionally reverts and zero-amount transfers are rejected, contradicting integrator expectations at runtime.

> ### 🛠 Maintainer response — **Accept. Intentional and documented.**
>
> Explicitly documented in the contract header NatSpec ("ERC-1155 deviations… treat this as ERC-1155-derived rather than fully compliant") and README Security Considerations. Batch is disabled deliberately rather than shipped with inconsistent pending accounting; zero-amount transfers are rejected to prevent inbound/outbound-set spam. Matches GPT-5.6 Pro SLOW-04. Informational; no action beyond existing disclosure.

---

## Finding 7 — Incomplete fee-on-transfer documentation

**Auditor confidence: 50**

The fee-on-transfer caveat is documented on `depositTo` but missing from `depositToWithTip`, despite identical face-value minting logic in both.

> ### 🛠 Maintainer response — **Actionable. Trivial NatSpec fix.**
>
> **Valid and the cheapest real item on the list.** [`depositTo`](../../src/SLOW.sol) carries the fee-on-transfer / rebasing caveat in its NatSpec; [`depositToWithTip`](../../src/SLOW.sol) does not, though both mint at face value via `_finishDeposit`. The README "Unsupported tokens" section already covers this globally, so the risk is disclosed — but adding a one-line cross-reference to `depositToWithTip`'s NatSpec is worth doing for symmetry. **Disposition:** apply a documentation one-liner; no logic change.

---

## Finding 8 — Guardian indefinite veto window

**Auditor confidence: 40 (Info)**

A hostile guardian can cancel rotation proposals indefinitely during the 1-day veto window. Reported for completeness; documented as an accepted trust model.

> ### 🛠 Maintainer response — **Accept. Documented trust model.**
>
> Documented in the `cancelGuardianChange` NatSpec ("a hostile guardian can veto every rotation proposal indefinitely. Appoint a guardian only if you trust them — that is what co-sign means") and README §3. The asymmetry has no on-chain mitigation by design; the guardian is a trusted co-signer. Matches the pashov-ai review's hostile-guardian veto-loop lead. Accept.

---

## Notable rejected lead (auditor) — affirmed

Eight of twelve Phase 2 agents flagged a missing `to != gate` guard on the deposit path. The audit **rejected it on verification**: Solady's ERC-1155 receiver-hook mandate means `_mint(gate, …)` reverts at mint time (the gate implements no `onERC1155Received`), so such a deposit reverts rather than stranding funds.

> ### 🛠 Maintainer response — **Correct verification; affirmed.**
>
> Confirmed accurate. [`depositTo`](../../src/SLOW.sol) guards `to != address(this)` but not `to != gate`; it does not need to, because `_mint(gate, …)` reverts on the absent receiver hook. (By contrast, `safeTransferFrom` and `withdrawFrom` *do* explicitly guard `to != gate`, since those paths don't universally hit a minting receiver-hook check.) Good reconciliation discipline — a plausible-looking lead correctly killed rather than shipped as a false positive.

---

## Maintainer remediation summary

**Redeploy required: none.** Actions, all documentation/dapp-layer:

1. **Finding 7** — add the fee-on-transfer / rebasing caveat to `depositToWithTip` NatSpec (trivial; worth doing).
2. **Finding 3** — add a one-line note on issuer-controlled-token freeze risk (pooled custody) to README Security Considerations.
3. **Cross-review** — the guardian-`data`-binding item (GPT-5.6 Pro SLOW-01), not surfaced here, remains the one item to consciously accept + document and the top candidate for any future redeploy's preimage change.

## Review limitations (auditor)

AI-orchestrated multi-agent pipeline. No guarantee of complete vulnerability absence; team security reviews, bug-bounty programs, and on-chain monitoring remain essential.

---

> ⚠️ This review was performed by an AI-orchestrated pipeline (OneDollarAudit), with maintainer responses added by a second AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Result page: https://leftclaw.services/result/471.html · IPFS: https://bafkreigcgf2rny7psw7diwvxgqmy6yui3g7i747362vinjljke3fqkhsda.ipfs.community.bgipfs.com/
