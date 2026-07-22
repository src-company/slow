# SLOW SDK

Integrate the [SLOW](../README.md) wrapper — timelock + guardian safety rails over ETH and ERC-20s — into web3 apps, wallets, and dapps.

**Contract (Ethereum mainnet):** [`0x000000000000888741B254d37e1b27128AfEAaBC`](https://contractscan.xyz/contract/0x000000000000888741B254d37e1b27128AfEAaBC)

The SDK is two layers:

| Layer | Import | Dependencies |
|-------|--------|--------------|
| **Core** — codec, ABI, `SlowClient`, wallet display, keeper | `@slow/sdk` | **none** (any EIP-1193 provider) |
| **viem/wagmi + React** — typed configs, hooks, components | `@slow/sdk/viem`, `@slow/sdk/react` | `viem`, `wagmi`, `react` (peer, optional) |

The core carries **zero third-party dependencies** — matching the repo's ethos (the gateway and on-chain dapp are the same). The `keccak256`, ABI codec, and id codec are lifted verbatim from the deployed dapp (`SLOW.html`) and cross-checked against `cast`, so the SDK, the dapp, and the contract agree bit-for-bit. Run the checks with `node sdk/test/sdk.test.mjs`.

---

## Mental model (read this first)

Each SLOW position is an ERC-1155 id that packs a **token address** and a **timelock delay**:

```
| 96 bits delay (seconds) | 160 bits token address |   ← uint256 id   (delay 0, token 0x0 = plain ETH)
```

Every holder has two balances per id:

- **`balanceOf(user, id)`** — the full wrapper balance. This is what ERC-1155 wallets and marketplaces show. **It includes funds still locked in pending transfers.**
- **`unlockedBalances(user, id)`** — the spendable balance. Only this can leave via `withdrawFrom` / `safeTransferFrom`.

> ⚠️ **Any UI that lets a user act on funds must show `unlockedBalances`, not `balanceOf`.** Showing the wrapper balance promises funds the user cannot yet move. `wallet.portfolio()` and the `useSlowPosition` hook split the two for you.

Lifecycle of a delayed transfer: `depositTo` mints the wrapper to the recipient but parks the credit in a `pendingTransfer`. Before expiry the **sender** can `reverse`. After expiry the **recipient** (or an operator/keeper) settles via `unlock`/`claim`. 30 days past expiry, if still unsettled, the sender can `clawback`.

---

## Install

```sh
# from npm (once published)
npm i @slow/sdk
# optional layers
npm i viem wagmi @tanstack/react-query react
```

Or vendor it: the `sdk/src` folder is plain ESM and runs buildless in the browser (see [`examples/browser.html`](./examples/browser.html)).

---

## Core SDK — any provider

```js
import { SlowClient } from '@slow/sdk';

const slow = new SlowClient(window.ethereum);   // or a WalletConnect / viem / bare RPC provider
await slow.requestAccounts();

// Send 0.1 ETH with a 1-day timelock. Sender can reverse() until it expires.
const hash = await slow.deposit({ to: '0xRecipient…', amount: '0.1', token: 'ETH', delay: '1d' });
await slow.wait(hash);
```

ERC-20 deposits need a one-time approval of the wrapper:

```js
await slow.approveErc20('USDC');                                   // max approve
await slow.deposit({ to, amount: '100', token: 'USDC', delay: '7d' });
```

`token` accepts `"ETH"`, a known symbol (~25 curated majors — `USDC`, `USDT`, `DAI`, `WETH`, `wstETH`, `WBTC`, `LINK`, `UNI`, `AAVE`, … see `TOKENS`), or any ERC-20 address. `delay` accepts a preset (`"1h"`, `"1d"`, `"3d"`, `"7d"`, `"30d"`) or raw seconds. `amount` accepts a human string (`"0.1"`) or base-unit `bigint`. `to` accepts an address **or a name** — see below.

### Names — ENS and WNS (`.wei`)

`deposit`, `withdraw`, and `transfer` accept a name for `to` and resolve it before sending. `.wei` names route to the WNS registry; everything else routes to ENS. Same resolution paths as the on-chain dapp.

```js
await slow.deposit({ to: 'vitalik.eth', amount: '0.1' });   // ENS
await slow.deposit({ to: 'alice.wei',   amount: '0.1' });   // WNS

await slow.resolveName('alice.wei');     // → 0x… or null
await slow.reverseName('0x…');           // → prefers .wei, falls back to .eth
```

Standalone (no client instance needed beyond the transport): `import { resolveName, reverseName, namehash } from '@slow/sdk'`. In viem/wagmi apps, `.wei` is not covered by wagmi's native ENS hooks — use `resolveNameViem(publicClient, name)` / the `useResolveName()` hook (both handle `.eth` and `.wei`). `SlowSendForm` already resolves names on submit.

### Reading state

```js
const id = slow.encodeId('USDC', '7d');
await slow.unlockedBalanceOf(user, id);          // spendable
await slow.balanceOf(user, id);                  // full wrapper balance

const inbound = await slow.getInboundTransfers(user);   // pending transfer ids owed to `user`
const status  = await slow.pendingStatus(inbound[0]);   // { from, to, amount, expiry, settleable, reversible, clawbackReady, secondsUntilExpiry, … }
```

### Settling & recovering

```js
await slow.unlock(transferId);      // recipient/operator, after expiry → moves into unlockedBalance
await slow.reverse(transferId);     // sender, before expiry → cancels
await slow.clawback(transferId);    // sender, 30d after expiry → recover a dead send
await slow.withdraw({ from: user, to: user, id, amount });   // unwrap spendable back to the underlying
```

### Guardian (self-2FA)

```js
await slow.setGuardian(coldWallet);          // every future outflow now needs the guardian's co-sign
// …from the cold wallet, to approve one outflow:
await guardianClient.approveTransfer(hotWallet, transferId);
```

Rotating an active guardian stages a 1-day veto window (`GuardianChangeProposed`); either party can `cancelGuardianChange` during it. A stolen key can't quietly swap the guardian.

---

## Wallet display

```js
import { watchAsset, portfolio, describePosition } from '@slow/sdk/wallet';

await watchAsset(window.ethereum, id);                 // suggest the ERC-1155 id to the wallet (EIP-747)

const rows = await portfolio(slow, user, await slow.getInboundTransfers(user));
rows.forEach(r => console.log(describePosition(r)));   // "0.5 ETH spendable · 1.0 locked (2d timelock)"
```

Every id also renders an on-chain SVG via `slow.uri(id)` — usable directly as an `<img src>` or inlined with `wallet.svgFromDataUri`.

---

## Keeper / relayer (sponsored delivery)

A depositor can attach an ETH **tip** so a keeper settles on the recipient's behalf — the recipient never needs gas:

```js
await slow.deposit({ to, amount: '100', token: 'USDC', delay: '1d', tip: 2_000_000_000_000_000n }); // 0.002 ETH tip
```

A keeper scans matured, eligible transfers and collects the tips through the gate:

```js
import { scan, settle, runOnce } from '@slow/sdk/keeper';

const ids = await slow.getInboundTransfers(recipient);        // or from your indexer
const report = await runOnce(slow, ids, { minTip: 1n });      // scans + batches gate.claimMany
console.log(report.settled, report.txHashes);
```

`evaluate`/`scan` filter out transfers that would revert (timelock still active, recipient has a guardian which blocks `claimTipped`, or an untipped transfer whose recipient hasn't approved the gate). See [`examples/keeper-bot.mjs`](./examples/keeper-bot.mjs) for a standalone loop.

To let keepers settle your **untipped** inbound transfers, approve the gate once: `await slow.approveGate()`.

---

## viem / wagmi

```js
import { readContract, writeContract } from 'viem/actions';
import { slowContract, depositArgs, encodeIdViem } from '@slow/sdk/viem';

const id = encodeIdViem('0xA0b8…eB48', 604800);
const bal = await readContract(client, { ...slowContract, functionName: 'unlockedBalances', args: [user, id] });

const hash = await writeContract(walletClient, depositArgs({ to, amount: 10n ** 17n, token: 'ETH', delay: 86400 }));
```

`slowContract` / `gateContract` spread into any viem call; `depositArgs`/`withdrawArgs`/`reverseArgs`/… keep the ETH-vs-ERC20-vs-tip branching in one tested place. `slowAbi`/`gateAbi`/`erc20Abi` are the parsed typed ABIs.

---

## React (wagmi)

```jsx
import { SlowSendForm, PositionBadge, useInboundTransfers, usePendingTransfer, useUnlock } from '@slow/sdk/react';

<SlowSendForm onSent={hash => track(hash)} />
<PositionBadge owner={address} id={id} symbol="ETH" />
```

Hooks: `useUnlockedBalance`, `useBalance`, `useSlowPosition`, `useInboundTransfers`, `useOutboundTransfers`, `usePendingTransfer`, `useGuardian`, `useTokenUri`, and write hooks `useDeposit`/`useWithdraw`/`useReverse`/`useClawback`/`useUnlock`/`useSetGuardian`. Full wiring in [`examples/wagmi-react.jsx`](./examples/wagmi-react.jsx).

---

## Agent skill (CLI)

For AI agents, [`skills/`](./skills/slow) is a self-contained [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills): a lean `SKILL.md` (when/how), an on-demand `reference.md` (lifecycle, ids, errors), and `slow.mjs` — a **zero-dependency JSON-in/JSON-out CLI**.

```
node sdk/skills/slow/slow.mjs help
node sdk/skills/slow/slow.mjs inbox alice.wei                     # reads (RPC only)
node sdk/skills/slow/slow.mjs send --to alice.wei --amount 0.1 --delay 1d   # prepares an unsigned tx
node sdk/skills/slow/slow.mjs send --to alice.wei --amount 0.1 --delay 1d --send
```

It's designed to be agent-safe: **writes prepare an unsigned tx and print it — nothing is submitted without `--send`.** SLOW's timelock is the key property here — an agent can send reversibly, and a human can `reverse` a mistake before expiry. Signing uses `SLOW_PRIVATE_KEY` (local, via viem) or an unlocked node (`--from` / `eth_sendTransaction`); for a multisig/human step, take the prepared `tx` to your own signer.

### Install as a Claude Code plugin

The repo ships a plugin marketplace (`.claude-plugin/marketplace.json` at the repo root; the plugin manifest lives in `sdk/.claude-plugin/plugin.json`). In Claude Code:

```
/plugin marketplace add z0r0z/slow
/plugin install slow@slow
```

The skill then activates automatically when a task matches its description, or invoke it explicitly with `/slow:slow`. To iterate locally without installing, point Claude Code straight at the plugin dir: `claude --plugin-dir ./sdk`. Or just drop [`skills/slow/`](./skills/slow) into any agent's skills directory (e.g. `~/.claude/skills/slow/`) — it's self-contained.

## API surface

| Module | Exports |
|--------|---------|
| `@slow/sdk` (`src/index.js`) | `SlowClient`, all codec fns, `abi.js` constants, `wallet`, `keeper` namespaces |
| `@slow/sdk/codec` | `keccak256`, `selector`, `encode`/`decode`, `encodeCall`, `encodeId`/`decodeId`, `parseUnits`/`formatUnits`, `isAddress` |
| `@slow/sdk/abi` | `SLOW_ADDRESS`, `SEL`, `EVENTS`, `SLOW_ABI`/`GATE_ABI`/`ERC20_ABI`, `TOKENS`, `DELAYS`, `errorName` |
| `@slow/sdk/client` | `SlowClient` (`.resolveName`/`.reverseName`/`.resolveRecipient`) |
| `@slow/sdk/names` | `namehash`, `resolveName`, `reverseName`, `isName`, `ensResolve`/`ensReverse`, `wnsResolve`/`wnsReverse` |
| `@slow/sdk/wallet` | `watchAsset`, `portfolio`, `describePosition`, `svgFromDataUri` |
| `@slow/sdk/keeper` | `evaluate`, `scan`, `settle`, `runOnce`, `getTip` |
| `@slow/sdk/viem` | `slowAbi`, `slowContract`, `*Args` builders, `encodeIdViem`, `resolveNameViem`/`reverseNameViem` |
| `@slow/sdk/react` | hooks (+ `useResolveName`/`useReverseName`) + `SlowSendForm`, `PositionBadge`, `PositionArt` |

## Notes & gotchas

- **Mainnet only by default.** `SlowClient` asserts chain id 1 on every write; pass `{ chainId }` to target a fork/testnet deployment and `{ address }` to point at a non-canonical address.
- **`safeBatchTransferFrom` is disabled**, and zero-amount transfers revert — the SDK never calls them.
- **Fee-on-transfer / rebasing tokens break 1:1 accounting.** Wrap rebasing assets (e.g. stETH → wstETH) before depositing.
- **Inbound-set spam:** anyone can dust your inbound set. For on-chain iteration use `inboundTransferCount` + `inboundTransferAt(i)` to paginate; `getInboundTransfers` is fine off-chain.
- **Names** resolve on the network at call time. `.wei` uses the WNS registry, `.eth`/others use ENS; both forward-confirm reverse lookups. A name that doesn't resolve returns `null` from `resolveName`, and throws from `deposit`/`transfer`/`withdraw` (they need a concrete recipient).

## License

AGPL-3.0-only, same as the protocol.
