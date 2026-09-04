# Deploying the bridge

`SlowArrival` and `SlowRelay`, at one address on Ethereum, Base and Robinhood
Chain. This is the runbook; the reasoning lives in the contracts.

## What goes where

|              | address                                      | salt tail    |
| ------------ | -------------------------------------------- | ------------ |
| SlowArrival  | `0xCd42F279E58bdc1de6aE84D9ea2636fDc6eC8918` | `0x5107a771` |
| SlowRelay    | `0x4eF8416ceaC4Bf23fe1804Dcc95be7B37a61aca6` | `0x5107a772` |

Deployer `CreateX` `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, steward
`0x1c0aa8ccd568d90d61659f060d1bfb1e6f855a20` — the same pair the page's own
address rests on. Both derived before deployment, identical on all three chains,
and checked free on all three.

## Why the address has to match

`SlowRelay.receiveRelay` accepts a cross-chain proof only when the recovered
origin equals `address(this)`. That is what lets a message from the relay on
another chain be recognised with no registry, no owner and no oracle. If the
three deployments diverge by one byte the relay never settles: every escrow sits
until its deadline and nothing says why.

So the same-address property is a correctness requirement, not a convenience.
`test/DeployBridgeFork.t.sol` asserts it against the **live** CreateX on forks of
all three chains, passing a *different* `SLOW` on each — a CREATE3 address comes
from the deployer and salt alone and never from the child's initcode, which is
also what makes the relay's chain-specific messenger set affordable.

## The two CreateX traps

Both are already paid for in `scripts/address.mjs`, and both are unrecoverable
if got wrong.

1. **CreateX does not use your salt directly.** `deployCreate3` runs it through
   `_guard()` first, so the address must be derived from the *guarded* salt.
2. **Byte 20 is the redeploy-protection flag.** Setting it mixes `block.chainid`
   into the guard and yields three different addresses. It must stay `0x00`.
   This is the one that sounds safer and silently breaks the premise.

The salt used here is sender-prefixed with byte 20 clear: permissioned, so
nobody else can burn the address, and chain-independent, which is the point.

## Order

**Precondition: `SLOW` must already be live on the chain.** `SlowArrival`'s
constructor rejects a codeless `slow`, so a bridge cannot be pointed at an empty
address and left accepting ETH it can route nowhere.

Per chain, with the same steward key and the same salt nonce:

```
forge script script/DeployBridge.s.sol \
  --rpc-url <chain> --broadcast \
  --sig "run(address,uint64)" <slow-on-that-chain> 0x5107a771
```

The script supplies `SlowArrival`s forward routes itself, per chain — see below.
Its constructor takes `(slow, chainIds, routes)`, so the arrival deployed on an
L2 gets an empty set and the one on L1 gets both destinations.

```
```

The script asserts the deployed address equals the predicted one before the
transaction is worth anything, then checks `slow()` on both contracts and the
messenger set on the relay.

### Messenger sets

The relay must trust whatever *delivers* a cross-chain message, which is not
what sends one. `proveFill` leaves through `L2CrossDomainMessenger.sendMessage`
or `ArbSys.sendTxToL1`; what arrives on the far side is the executor.

| chain          | trusted deliverers                                       |
| -------------- | -------------------------------------------------------- |
| Ethereum       | Base L1CrossDomainMessenger `0x866E82a6…0Afa`, Robinhood Bridge `0xDf875533…64b3` |
| Base           | none                                                     |
| Robinhood      | none                                                     |

Empty on the L2s is deliberate, not an omission: a message from the relay on L1
arrives at `applyAlias(address(this))`, and forging that would mean deploying
code at one specific address nobody can reach. Only L1, which receives through
general-purpose bridge contracts, has to name them.

## Forwarding, and the trust it costs

`SlowArrival.forward` lands value on L1 only to send it on, so a Base-to-Robinhood
transfer is **one action by the sender** rather than a withdrawal plus a second
transaction five days later. The value is never at risk in the two-hop version
either — but a transfer that needs the sender to come back a working week later
is one most senders will not finish.

**Only L1 has routes, and that is not an omission.** Both legs of an L2-to-L2
send pass through L1; there is no canonical path from one L2 straight to
another, so an L2 has nowhere to forward to. `_forwardRoutes()` returns an empty
set anywhere but chain 1.

| destination | entrypoint | kind |
| --- | --- | --- |
| Base 8453 | OptimismPortal `0x49048044…E97e` | OP Stack |
| Robinhood 4663 | Delayed Inbox `0x1A07cc4B…7a2D` | Arbitrum |

with `FORWARD_GAS` 1,000,000 and `FORWARD_MAX_FEE` 1 gwei.

**This is the one place the contract trusts an address with value**, and it is
worth being clear about why it is different from the relay. `SlowRelay.pushProof`
takes an *untrusted* entrypoint because only a fact travels through it — a wrong
address wastes the caller's gas and nothing else. Here value travels, so a wrong
entrypoint is theft. The set is therefore fixed in the constructor, and there is
no setter: what a deployment writes is what the contract does forever. Still no
owner.

Two behaviours worth knowing before choosing the numbers above:

- **The retryable fee is priced live**, against `block.basefee` at the moment the
  forward lands. Anything decided at send time is five days stale by the time it
  is spent, so it cannot be carried in the message.
- **Fees larger than the payload are refused, not paid.** A fee that has grown
  past the amount would otherwise hand the whole transfer to the bridge. It goes
  to `rescue` for the sender instead.

Verified against the deployed contracts, not just mocks
(`test/ArrivalForwardFork.t.sol`): the real Base portal accepts the deposit and
the full payload arrives; the real Robinhood inbox accepts the retryable priced
against its own `calculateRetryableSubmissionFee`; and a dust payload is refused
against real fees rather than a mock's.

## After deployment

The page needs nothing: `SLOW_ARRIVAL` is already compiled into it, and
`probeArrival` checks for code per destination. Until the contract is there,
every route that needs it stays closed — so a wrong address is a route that
never opens, never a route that sends somewhere else.

Then, before anyone is invited to use it, **one real round trip with dust**.
Two paths no test can reach:

- **The finalisation transaction.** It needs a genuine Merkle proof, so no fork
  test covers `arrive` being called by a real finalising portal.
- **`ArbSys` on a real Orbit chain.** The precompile reports a single `0xfe`
  marker byte, which a forked EVM executes literally and reverts on. The
  outbound Arbitrum leg is only ever exercised stubbed.

## Destination gas — the number that can lose funds

The gas for a bridged arrival is bought on L1 at the moment of sending and
cannot be topped up. The page buys a fixed **400,000 for Base** and **600,000
for Robinhood**. Measured (`test/ArrivalGas.t.sol`):

| path | gas | against |
| --- | --- | --- |
| OP Stack deposit, ordinary recipient | 284,939 | 400,000 ✓ |
| Arbitrum retryable, ordinary recipient | 285,037 | 600,000 ✓ |
| with a bounty | 307,266 | 400,000 ✓ |
| rescue branch (inner deposit failed) | 92,058 | ✓ |
| `SlowArrival` overhead over a direct deposit | 35,705 | — |

Comfortable for an ordinary recipient. **Not bounded for a contract one.**
`depositTo` calls `onERC1155Received` on the recipient, and that hook spends from
the same budget:

| cold writes in the recipient's hook | gas | fits Base's 400k |
| --- | --- | --- |
| 0 | 281,392 | yes |
| 4 | 370,428 | yes |
| 6 | 414,946 | **no** |
| 20 | 731,265 | **no** |

So a bridged send to a contract whose hook does more than about **five cold
storage writes** overruns what was bought. On OP Stack the deposit is consumed
before the call and is not replayable, so that ETH is gone. An Arbitrum retryable
stays redeemable for seven days, which is survivable but needs someone to notice.

**This is older than `SlowArrival`.** The shipped route already bought a fixed
400,000 for a `depositTo` that calls an arbitrary hook, and already overran it at
around seven writes — `test_theCliffExistsWithoutTheWrapperToo` pins that. The
wrapper's 35,705 moves the threshold from about seven to about five. It makes a
pre-existing hazard modestly worse rather than creating one.

Worth fixing before the route carries value, in `dapp/page.html`:

- raise the fixed limits, and/or
- size them on the recipient: the page can `eth_getCode` the recipient on the
  destination chain and buy far more when it has any. An ordinary account needs
  nothing like 400,000; a contract can need several million.

The L1 cost of a larger `gasLimit` should be measured before picking a number —
OP Stack meters deposits, so it is not free.

## Known blockers

**SLOW is not deployed on Base or Robinhood at an address the page accepts.**
A new vanity address is being mined for all three chains, which is what settles
this. The address at `0x0000000000008887…AaBC` on Base holds an *older* SLOW —
13,386 bytes against mainnet's 21,648, missing `getOutboundTransfers`,
`getInboundTransfers`, `depositToWithTip`, `clawback` and `claim` — so it is not
a candidate, and the page already refuses it: `probeDeployed` checks for the
selectors the page actually calls, so Base reads as a mismatch rather than as
SLOW and every route into it stays closed.

**Two paths no test can reach.** They need a real transaction, not another test:

- **The finalisation transaction.** It needs a genuine Merkle proof, so no fork
  test covers `arrive` being called by a real finalising portal.
- **`ArbSys` on a real Orbit chain.** The precompile reports a single `0xfe`
  marker byte, which a forked EVM executes literally and reverts on, so the
  outbound Arbitrum leg is only ever exercised stubbed.

Do one small round trip with dust before either contract is trusted with more.
