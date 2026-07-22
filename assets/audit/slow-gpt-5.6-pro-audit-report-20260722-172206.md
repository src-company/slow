# 🔐 Security Review — SLOW (GPT-5.6 Pro) + Maintainer Responses

---

## About this document

This is the smart-contract security audit of `src/SLOW.sol` produced by **GPT-5.6 Pro**, reproduced verbatim, with a **Maintainer response** inserted after each finding. Responses record the disposition (accept / mitigate off-chain / redeploy) and the reasoning, verified against source.

| | |
| --- | --- |
| **Auditor** | GPT-5.6 Pro |
| **Original transcript** | https://chatgpt.com/share/6a60fc02-471c-83ea-b36a-90cc64303d99 |
| **Files reviewed** | `src/SLOW.sol` |
| **Reviewed commit** | `a00f1466c339d1ea85c07e21f44a0bdc6ef2d26b` |
| **Response date** | 2026-07-22 |
| **Toolchain** | Solidity 0.8.34, optimizer + `via_ir`, Prague EVM |

### Maintainer verdict

**No finding forces a redeploy, and no finding exposes an uncompromised user's already-wrapped funds.** The audit itself concludes there is no critical issue and no direct drain of reserves; that matches independent verification against source. The settlement-finality boundary holds: `reverse` requires `block.timestamp < expiry`, `clawback` requires the transfer to still be pending, and both `unlock` and `_doClaim` `delete pendingTransfers[...]` before paying — so once a recipient settles by the intended path, the position cannot be reversed or clawed back. There is no reentrancy path past the transient guard.

Four findings (SLOW-02, -04, -05, -06) re-derive limitations already documented in `SLOW.sol` NatSpec and the README. One (SLOW-03) is documented in code comments. Only **SLOW-01** warrants a deliberate accept-or-mitigate decision, and it is dapp/usage-mitigable rather than redeploy-forcing.

| ID | Auditor severity | Maintainer disposition |
| --- | --- | --- |
| SLOW-01 — Guardian approval does not bind receiver `data` | High | **Accept + document**; dapp-mitigable; top candidate for any future redeploy |
| SLOW-02 — Reversible balances credited as final by generic integrations | Medium | Accept — inherent to reversibility, already documented |
| SLOW-03 — Contract senders may be unable to reverse/claw back | Low | Accept — documented in code, self-scoped, no theft |
| SLOW-04 — ERC-1155 advertised despite missing behavior | Informational | Accept — intentional, documented |
| SLOW-05 — Non-standard ERC-20s can make reserves insolvent | Medium (ack) | Accept — documented, isolated per-token |
| SLOW-06 — Inbound dust spam degrades enumeration | Low (ack) | Accept — documented, pagination exists |

---

# Auditor report (verbatim) with maintainer responses

## Executive assessment

The reviewer covered the SLOW state machine, guardian authorization, ERC-1155 behavior, underlying-asset accounting, external callbacks, reentrancy, transfer recovery, and the pinned Solady implementations. No critical issue was found, and no direct arbitrary drain of reserves was identified when all of the following hold: underlying tokens are conventional non-rebasing ERC-20s; receiver contracts understand SLOW's pending-versus-unlocked model; guardian-approved transfers do not rely on `data`; and contract senders can receive ERC-1155 tokens during recovery.

---

## SLOW-01 — Guardian approval does not bind receiver `data`

**Auditor severity: High**

### Root cause

The transfer authorization identifier commits to `from`, `to`, token `id`, `amount`, sender nonce, guardian epoch, and operation type. It does **not** commit to the `data` argument supplied to `safeTransferFrom`. That `data` is forwarded unaltered to the recipient's `onERC1155Received` callback (along with the operator), so for a contract recipient it can determine the economic destination of the transfer (a bridge's destination-chain beneficiary, a vault subaccount, a router action, an escrow order, a minted-share address).

### Exploit scenario

1. A user has enabled a guardian.
2. The guardian approves a transfer of 100 SLOW to a bridge; the intended `data` names the user as destination-chain beneficiary.
3. The user's hot key (or an approved operator) is compromised.
4. The attacker submits the same `from`, `to`, `id`, `amount` but substitutes `data` naming the attacker.
5. The guardian authorization identifier is unchanged, so the approval is still valid.
6. The bridge credits the attacker.

### Recommendation

Bind `keccak256(data)` (and optionally `operator`) into the authorization identifier; update `predictTransferId`; add a regression test proving approval for `dataA` cannot authorize `dataB`. Changing the identifier invalidates outstanding approvals and requires a client/gateway migration.

> ### 🛠 Maintainer response — **Accept + document. Not redeploy-forcing.**
>
> **Confirmed accurate.** [`safeTransferFrom`](../../src/SLOW.sol) computes `transferId` over `(from, to, id, amount, nonce, lastGuardianChange, _OP_TRANSFER)` and forwards `data` to `super.safeTransferFrom` → `onERC1155Received` without binding it. For a data-routing recipient contract, a stale single-use approval can therefore be spent with attacker-chosen `data`.
>
> **Scope is narrow and fully self-contained.** `guardianApproved` is keyed `[from][transferId]`, and `transferId` folds in `from`, `from`'s own `nonce`, and `from`'s `lastGuardianChange`. The issue **cannot poison other users**: it can only redirect the compromised `from`'s *own* pending outflow. It does not touch any other user's balance, any other token's reserves, the shared pool, or any other user's approvals. It is scoped entirely to the single `(from → guardian → recipient)` relationship.
>
> **Exposure requires a rare intersection:** (a) a guardian is set, (b) the key is *already* compromised — the exact precondition the guardian exists to survive, and (c) the recipient is a contract that decodes `data` to determine an economic destination. There is **zero exposure** for EOA recipients or empty/normal `data`, which is the "cold wallet / trusted friend" model the README describes and the overwhelmingly common case.
>
> **The guardian model already leans on off-chain intent.** NatSpec on `approveTransfer` states the on-chain op-split "prevents cross-op consumption, not malicious approval of the wrong op — guardians must still verify intent off-chain." Receiver-side `data` routing is a residual of that stance: a guardian approving "send to bridge X" is approving the destination *contract*, and cannot on-chain constrain what that contract does with routing data.
>
> **Disposition:** accept for the deployed contract and document it explicitly in Security Considerations (guardian co-sign binds the destination, not receiver-side `data` routing; guardian-mode value exits should route through `withdrawFrom`, which carries no `data`, or avoid co-signed `safeTransferFrom` into data-routing contracts). This is logged as the **top candidate for a preimage change if a redeploy ever happens for another reason**, but it does not compel one now.
>
> **One correction to the recommendation:** point 4 ("use `abi.encode` rather than extending a packed encoding with variable-length values") is over-stated for the shipped code. The current preimage is entirely fixed-width (`address, address, uint256, uint256, uint256, uint256, uint8`), so `abi.encodePacked` has no collision ambiguity today; adding `keccak256(data)` (bytes32) and `operator` (address) keeps every field fixed-width. Good general hygiene, but there is no latent collision bug in the deployed preimage.

---

## SLOW-02 — Reversible balances can be credited as final by generic ERC-1155 integrations

**Auditor severity: Medium (potentially high impact for affected integrations)**

### Root cause / exploit

For a delayed transfer SLOW moves the ERC-1155 balance to the recipient, emits the standard transfer event, and invokes `onERC1155Received`, while excluding the amount from `unlockedBalances` and permitting the sender to `reverse` before finalization. A naïve vault that credits shares on ERC-1155 receipt can be drained: deposit delayed SLOW → vault mints shares → `reverse` before finalization → vault is undercollateralized. The same applies to marketplaces, bridges, lending, and settlement contracts that treat a successful ERC-1155 receipt as final. Additionally, `_finishDeposit` calls `_mint` (which fires the recipient callback) before the pending-transfer state is recorded, so a receiver inspecting pending records during its callback cannot find the new position.

### Recommendation

Escrow pending tokens inside SLOW rather than delivering an ordinary ERC-1155 balance; or require an explicit `ISLOWReceiver` acknowledgement, record pending state before callbacks, expose a `spendableBalanceOf`, and warn integrators never to credit value on `balanceOf` / transfer events / `onERC1155Received` alone.

> ### 🛠 Maintainer response — **Accept. Inherent to the reversibility feature; already documented.**
>
> **Confirmed and by design.** Reversibility of not-yet-final positions is the core product. The "pending shows in `balanceOf` but is not spendable/final" property is documented at README "Wallet display vs. spendability" and in NatSpec throughout. `unlockedBalances[user][id]` is the stated source of truth for spendability.
>
> The proposed primary fix — escrow inside SLOW and do not mint the 1155 to the recipient until finalization — deletes the "recipient sees the wrapper immediately" property and is a different protocol, not a patch. **No risk to existing SLOW users:** the hazard is borne entirely by a third-party integrator that chooses to credit value on a raw ERC-1155 receipt, analogous to a vault that blindly accepts an arbitrary token.
>
> **Callback ordering sub-point:** accurate but neutralized. `_finishDeposit` does `_mint` (line firing `onERC1155Received` on `to`) before writing `pendingTransfers`, but every value-bearing entry point is `nonReentrant`, so a receiver cannot re-enter SLOW during the callback; it merely cannot observe the not-yet-written pending record. Cosmetic ordering nit, no fund impact.
>
> **Disposition:** accept; optionally add the naïve-vault regression test as executable documentation of the intended behavior, and reinforce the integrator warning in Security Considerations.

---

## SLOW-03 — Contract senders may be unable to reverse or claw back

**Auditor severity: Low**

### Root cause / impact

A contract can call `depositTo` directing SLOW to another `to` without itself implementing `IERC1155Receiver`. If the transfer later needs `reverse`/`clawback`, `_safeTransfer` invokes `onERC1155Received` on the sender contract; a sender lacking the hook (or reverting) cannot receive the recovery transfer, so the reversal reverts and the sender may have no route to recover.

### Recommendation

Require contract senders of reversible transfers to implement the receiver hook; or add a bound `recoveryTo` address; or allow a persistent recovery address configured before transfers.

> ### 🛠 Maintainer response — **Accept. Documented in code; self-scoped; no theft.**
>
> **Confirmed.** Documented in the NatSpec of both [`reverse`](../../src/SLOW.sol) ("Contract depositors must implement `IERC1155Receiver` to be reverse-eligible — they did not receive the 1155 at deposit") and `clawback`. This is a self-inflicted limitation on the recovery path for contract senders: no attacker gains anything, no funds are stolen, and the recipient can still settle normally by the intended path. The pashov-ai review flagged the identical item as a documented tradeoff.
>
> **Disposition:** accept; SDK/dapp integrators wiring off-the-shelf depositor contracts should surface the requirement. A bound recovery address is a reasonable ergonomics improvement for a future version, not a fix the deployed contract needs.

---

## SLOW-04 — ERC-1155 support advertised despite intentionally missing behavior

**Auditor severity: Informational**

`safeBatchTransferFrom` always reverts and zero-amount operations are rejected, yet `supportsInterface` reports ERC-1155. Generic software may pick an ERC-1155 path via `supportsInterface` then fail on a batch or zero-value operation. Recommendation: fully implement ERC-1155, or stop advertising it and expose an explicit SLOW interface.

> ### 🛠 Maintainer response — **Accept. Intentional and documented.**
>
> Explicitly documented in the contract header NatSpec ("ERC-1155 deviations… `supportsInterface` still reports ERC-1155 — treat this as ERC-1155-derived rather than fully compliant") and README Security Considerations. Batch is disabled deliberately rather than shipped with inconsistent pending accounting, and zero-amount transfers are rejected to prevent inbound/outbound-set spam. Informational; no action beyond the existing disclosure.

---

## SLOW-05 — Non-standard ERC-20s can make reserves insolvent

**Auditor severity: Medium — acknowledged limitation**

`depositTo` pulls the requested `amount` and mints that same face amount without measuring the actual balance delta, so fee-on-transfer, deflationary, rebasing, or misreporting tokens create a liability exceeding reserves; because delay IDs for the same underlying share one balance, a deficit can affect other users of that token. Recommendation: measure `balanceOf` delta and revert on mismatch (fixes transfer-tax deposits but not rebasing); restrict to reviewed tokens or use adapters; consider segregating reserves per id.

> ### 🛠 Maintainer response — **Accept. Documented; isolated per-token.**
>
> Explicitly documented in the `depositTo` NatSpec and README ("Fee-on-transfer and rebasing tokens… break the wrapper's 1:1 accounting. Wrap rebasing assets to their non-rebasing equivalent"). The deposit path is permissionless, so a nonstandard token *can* be deposited, but the impact is **isolated to that token's own reserves** — each token's backing is its own ERC-20 balance, so a bad token's depositors can only harm each other, never holders of ETH/USDC/USDT/WETH or any other id. The balance-delta check is a reasonable hardening for a future version but does not change the risk profile for the intended assets. Accept.

---

## SLOW-06 — Inbound dust spam can make complete enumeration unusable

**Auditor severity: Low — acknowledged limitation**

Anyone can create small pending transfers to a victim, expanding inbound-transfer tracking; unbounded "return everything" getters can become too expensive for on-chain callers or RPC infrastructure. Recommendation: deprecate unbounded getters, make pagination the only path, consider a minimum deposit or refundable storage bond, and ensure frontends never load all inbound records at once.

> ### 🛠 Maintainer response — **Accept. Documented; pagination already the supported path.**
>
> Documented in the enumeration NatSpec block and README ("On-chain consumers should paginate via `inboundTransferCount` + `inboundTransferAt(i)`"). No state-mutating function iterates the full set, so there is no on-chain DoS; attacker dust is recoverable via `clawback`, so it is not a fund-loss path. The only impact is off-chain indexers/UIs that ignore pagination. Matches the pashov-ai review's below-threshold note. Accept.

---

## Guardian threat-model note (auditor)

Guardian protection applies to SLOW-controlled balances, not external ERC-20 allowances. A compromised wallet holding an allowance to SLOW can `depositTo(token, attacker, amount, 0, data)`, pulling the underlying to attacker-owned unlocked SLOW; no guardian approval protects that external ERC-20 operation. Unlimited allowances enlarge this exposure.

> ### 🛠 Maintainer response — **Accept. Standard allowance semantics; dapp guidance.**
>
> Correct and not a contract defect — it is the universal property that approving any contract is a trust decision, and the guardian is explicitly scoped to already-wrapped SLOW, not raw wallet allowances. Worth reinforcing in the dapp by preferring exact-amount approvals so users do not misread the guardian as protecting un-wrapped balances. No contract change.

---

## Positive observations (auditor)

Guardian identifiers include a per-user nonce, guardian-change epoch, and op-type byte (reducing replay and transfer-versus-withdraw confusion); value-bearing entry points use transient-storage reentrancy protection and the pinned multicall rejects value-bearing delegatecall batching; withdrawal/recovery state is changed before external interactions with EVM rollback preserving atomicity; the zero-address authorization sentinel used by `_burn`/`_safeTransfer` is not user-controlled; batch transfer is disabled rather than half-implemented. No credible reentrancy path bypassing balance, guardian, or pending-transfer accounting was found.

> ### 🛠 Maintainer response
>
> Concur with all of the above; independently verified. These are the properties that keep the fund-loss surface closed for the common (non-compromised, vanilla-token, EOA-or-informed-integrator) case.

---

## Maintainer remediation summary

**Redeploy required: none.** Planned actions, all documentation/dapp-layer:

1. **SLOW-01** — add a Security Considerations note (guardian co-sign binds destination, not receiver-side `data` routing; guardian value exits via `withdrawFrom` or non-data-routing recipients). Log as the top item for any future redeploy's preimage.
2. **SLOW-02 / SLOW-03** — optionally add the two regression tests as executable documentation of intended behavior; reinforce integrator warnings.
3. **Allowance note** — nudge the dapp toward exact-amount ERC-20 approvals.

## Review limitations (auditor)

This was a manual static source review of `SLOW.sol`, the security-critical pinned dependency behavior, and the test suite. The auditor did not execute Foundry tests or fuzzing, compare deployed bytecode to source, inspect deployment configuration, or audit the gateway, frontend, external tokens, or key management. Independent review and executable regression tests remain necessary before production use.

---

> ⚠️ This review was performed by an AI assistant (GPT-5.6 Pro), with maintainer responses added by a second AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. Original auditor transcript: https://chatgpt.com/share/6a60fc02-471c-83ea-b36a-90cc64303d99
