---
name: slow
description: Use when an agent needs to send, hold, or settle ETH or ERC-20 value on Ethereum mainnet with a safety delay — reversible payments, timelocked transfers, guardian co-signing, or sponsored (gasless) delivery. Covers the SLOW protocol at 0x000000000000888741B254d37e1b27128AfEAaBC via a JSON CLI. Also use to inspect pending/inbound/outbound SLOW transfers or reverse a mistaken send.
---

# SLOW — a safe, reversible value rail for agents

SLOW wraps ETH or any ERC-20 into an ERC-1155 position that adds two opt-in safety rails to every transfer:

1. **Timelock** — the recipient must wait before extracting the underlying.
2. **Guardian** — an optional cosigner who must approve every outflow.

**Why this matters for agents:** a delayed send is *reversible*. If you (or the human you act for) send to the wrong address or the wrong amount, you can `reverse` any time before the timelock expires. This makes SLOW an unusually safe rail for agent-initiated payments — send with a delay, and a mistake is recoverable instead of final.

Contract (Ethereum mainnet): `0x000000000000888741B254d37e1b27128AfEAaBC` — no owner, no upgrades, no fees.

## The tool

Everything is one zero-dependency CLI that speaks **JSON in, JSON out**. Run it with Node ≥18:

```
node sdk/skills/slow/slow.mjs help
```

Reads need only an RPC (a keyless public pool is used if `RPC_URL` is unset). **Writes are safe by default: they PREPARE an unsigned transaction and print it — nothing is submitted unless you add `--send`.**

## Golden path — send reversibly

```
# 1. Resolve + preview the recipient (echoes the address you're about to pay)
node sdk/skills/slow/slow.mjs resolve alice.wei

# 2. Prepare a 0.1 ETH send with a 1-day timelock (prints an unsigned tx, sends nothing)
node sdk/skills/slow/slow.mjs send --to alice.wei --amount 0.1 --token ETH --delay 1d

# 3. Submit it (see "Signing" below)
node sdk/skills/slow/slow.mjs send --to alice.wei --amount 0.1 --delay 1d --send

# If you erred, reverse before the day is up:
node sdk/skills/slow/slow.mjs outbox <your-address>          # find the transferId
node sdk/skills/slow/slow.mjs reverse <transferId> --send
```

## What to run, by task

| Task | Command |
|------|---------|
| Send value with a safety delay | `send --to <addr\|name> --amount <n> [--token ETH] [--delay 1d]` |
| Undo a send before it matures | `reverse <transferId> --send` |
| Recover a never-claimed send (30d+) | `clawback <transferId> --send` |
| Recipient: settle a matured transfer | `unlock <transferId> --send` |
| Unwrap back to the underlying | `withdraw --from <addr> --to <addr\|name> --id <id> --amount <base>` |
| See what's owed to me | `inbox <addr\|name>` |
| See what I've sent (still pending) | `outbox <addr\|name>` |
| Full status of one transfer | `status <transferId>` |
| Spendable vs locked balance | `balance <owner> <token> <delaySpec>` |
| Resolve an ENS / `.wei` name | `resolve <name>` |
| Compute a token id | `id <token> <delaySpec>` |
| Set / use a guardian cosigner | `guardian set <addr>` · `guardian approve <from> <transferId>` |
| Sponsor gasless delivery (tip a keeper) | add `--tip <wei>` to `send` |

`delaySpec` is one of `none 1h 1d 3d 7d 30d` or raw seconds. `--token` is `ETH`, a known symbol (`USDC`, `USDT`, `DAI`, `WETH`, `WBTC`, `wstETH`, … run `help` for the list), or any ERC-20 address.

## Signing (`--send`)

- **Recommended for agents:** set `SLOW_PRIVATE_KEY` (a hot key funded for gas). The CLI signs locally via `viem` (`npm i viem`). The key is read from the env only — never pass it as an argument.
- **Unlocked/keystore node:** omit the key and pass `--from <addr>` (or set `SLOW_ACCOUNT`); the CLI uses `eth_sendTransaction`.
- **External signer / multisig / human approval:** don't use `--send`. Take the `tx` object the prepare step prints (`{ to, data, value, chainId }`) and hand it to your wallet, a Safe, or a human.

## Safety checklist (do this before every `--send`)

- [ ] **Amount and token** are correct — mainnet moves real funds.
- [ ] **Recipient resolved** — for a name, run `resolve` first and confirm the address.
- [ ] **Use a `--delay`** unless instant settlement is truly required. The delay is your undo button.
- [ ] For anything material or irreversible, **prepare first, then have a human review** the printed `tx` before `--send`.
- [ ] ERC-20 sends need a one-time token approval of the wrapper (the CLI/SDK expose `approveErc20`); ETH does not.
- [ ] Rebasing/fee-on-transfer tokens are unsupported — wrap stETH → wstETH first.

## Deeper details

Read [`reference.md`](./reference.md) for the id encoding, the full lifecycle (pending → reversed / unlocked / claimed / clawed-back), guardian rotation and its veto window, the tip/keeper flow, and error meanings. For programmatic integration (viem/wagmi, React, a keeper bot), use the SDK in [`../../`](../../README.md) directly.
