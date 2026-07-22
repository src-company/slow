# SLOW reference (load on demand)

Deeper detail behind [`SKILL.md`](./SKILL.md). Read this when a task needs the lifecycle, id math, guardian rules, tips, or error decoding.

## Token id encoding

Each SLOW position is an ERC-1155 id that packs a token address and a timelock delay:

```
| 96 bits delay (seconds) | 160 bits token address |   ← uint256 id
```

- `delay = 0`, `token = 0x0` → plain wrapped ETH.
- `node slow.mjs id USDC 7d` computes it. The delay is *baked into the id*: the same token at two delays is two different ids.

## Two balances per id

- **`balanceOf(user, id)`** — full wrapper balance. What ERC-1155 wallets show. **Includes funds still locked in pending transfers.**
- **`unlockedBalances(user, id)`** — spendable. Only this can leave via `withdraw` / transfer.

`balance` prints both plus `locked = total − unlocked`. Never tell a user they can spend the `total`.

## Lifecycle of a delayed transfer

```
send (delay>0)                        expiry                     expiry + 30d
   │                                     │                             │
   ●───────── pending ──────────────────●────── settleable ──────────●── clawback ──►
       sender can reverse()               recipient/keeper unlock()      sender clawback()
                                          or claim()
```

- **pending** (`now < expiry`): sender can `reverse` → funds return to sender's unlocked balance. Recipient cannot yet extract.
- **settleable** (`now ≥ expiry`): recipient (or an operator/keeper) `unlock`s or `claim`s → moves into the recipient's unlocked balance. `reverse` no longer works.
- **clawback-ready** (`now ≥ expiry + 30d`, still unsettled): sender can `clawback` a dead/never-claimed send.

`reverse` and `clawback` are mutually exclusive, and any settlement in between disables both. `status <transferId>` reports which window a transfer is in (`state`, `reversible`, `settleable`, `clawbackReady`, `secondsUntilExpiry`).

A `send` with `delay = 0` (or `--delay none`) skips the pending state entirely — funds land in the recipient's unlocked balance immediately and there is **no undo**. Prefer a delay for agent sends.

## Guardian (self-2FA / cosigner)

- `guardian set <cold-wallet>` — after this, every outflow from your account needs `guardian approve <you> <transferId>` from the guardian before it can leave.
- First-time set is immediate. **Rotating an active guardian** stages a 1-day veto window (`GuardianChangeProposed`); either the user or the current guardian can `cancelGuardianChange` during it, and anyone can `commitGuardian` after. A stolen key therefore cannot quietly swap the guardian.
- A guardian on the *recipient* blocks the tipped keeper path (`claimTipped`) — see below.

## Tips & keeper settlement (gasless / sponsored delivery)

Attach `--tip <wei>` to a `send` (requires a delay). The tip is escrowed in the gate and paid to whoever lands the settlement, so the recipient never needs gas:

- A keeper watches matured transfers and calls the gate to settle them, collecting the tip. The SDK's `keeper` module (`scan` / `settle` / `runOnce`) filters out ineligible ones (timelock still active; recipient has a guardian, which blocks `claimTipped`; or an untipped transfer whose recipient hasn't approved the gate).
- To let keepers settle your **untipped** inbound transfers, approve the gate operator once (`gate` prints its address; approve via `setApprovalForAll`).
- If a tipped transfer settles by another path (recipient `unlock`, sender `reverse`/`clawback`), the depositor can `refundTip`.

## Errors you may see (decoded from revert `reason`)

| Name | Meaning |
|------|---------|
| `TransferDoesNotExist` | bad/settled transferId |
| `TimelockExpired` | tried to `reverse` after expiry |
| `ClawbackNotReady` | `clawback` before expiry + 30d |
| `GuardianApprovalRequired` | outflow needs the guardian's `approve` first |
| `InvalidRecipient` / `InvalidDeposit` / `InvalidAmount` | malformed deposit (e.g. ETH with a nonzero token, zero amount) |
| `Unauthorized` | caller isn't the sender/operator for this action |

## Gotchas

- **`safeBatchTransferFrom` is disabled**; zero-amount transfers revert.
- **Fee-on-transfer / rebasing tokens break 1:1 accounting** — wrap stETH → wstETH before depositing.
- **Inbound-set spam:** anyone can dust your inbound set; `inbox` is fine off-chain, but on-chain consumers should paginate.
- **`.wei` names** resolve via WNS, `.eth`/others via ENS. `resolve` returns the address or errors.
- The contract also serves its own dapp via `html()` — see the root README's gateway.

## Installing as a plugin/skill

This folder is a self-contained skill: `SKILL.md` (instructions) + `slow.mjs` (executable) + `reference.md`.

- **Claude Code plugin:** `/plugin marketplace add z0r0z/slow` then `/plugin install slow@slow` (invoke with `/slow:slow`). Local iteration: `claude --plugin-dir ./sdk`.
- **Any agent framework:** drop this folder into the agent's skills directory (e.g. `~/.claude/skills/slow/`), or run `slow.mjs` directly as a tool.

Reads work with no config; set `RPC_URL` for your own endpoints and `SLOW_PRIVATE_KEY` (or an unlocked node + `SLOW_ACCOUNT`) to enable `--send`. The CLI imports the SDK from `../../src`, so keep it within the `sdk/` tree (the plugin bundles it).
