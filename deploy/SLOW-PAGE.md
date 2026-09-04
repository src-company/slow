# SLOW onchain page — deployment plan (ERC-8244 / ERC-5219 / ERC-4804)

The page as its own contract, deployed through CREATE3, driving the already
deployed SLOW protocol at
[`0x000000000000888741B254d37e1b27128AfEAaBC`](https://etherscan.io/address/0x000000000000888741B254d37e1b27128AfEAaBC#code).

| piece | path |
| --- | --- |
| page source | `dapp/page.html` |
| wrapper | `src/SlowPage.sol` |
| permit extension (next protocol version) | `src/SlowPermit.sol` |
| chunker | `scripts/chunk.mjs` |
| local preview | `scripts/serve.mjs` |
| verifier | `scripts/verify.mjs` |
| release pin | `manifest.json` |

## Why a separate contract

SLOW already implements `html()`, from two `immutable` chunk pointers set in its
constructor. That put the page's ceiling in the constructor's arity rather than
in EIP-170, and the ceiling was reached with **47 bytes** to spare — measured on
chain, where the two chunks hold 24,551 and 24,552 payload bytes against a
24,575-byte limit each.

The protocol contract is audited, deployed and holding funds. A frontend fix is
not a reason to move it. So the page gets its own contract, which owns none of
the protocol and only names it — the same shape the ERC-8244 reference dapps
use, where `Fwa8244` points at an FWA core contract it does not control.

The frozen v1 page stays on `html()` at the protocol address. It cannot be
removed and should not be: it is what somebody audited. The routes move.

## Why CREATE3

The page embeds its own address so its footer can name the contract that served
it. CREATE2 cannot supply that:

```
page.html → chunk bytes → chunk addrs → initcode hash → mine salt → address
    ↑                                                                  │
    └──────────────── and the address is inside page.html ─────────────┘
```

CREATE3 derives the address from the deployer and the salt alone:

```
proxy = CREATE2(deployer, salt, keccak256(0x67363d3d37363d34f03d5260086018f3))
addr  = keccak256(0xd694 ‖ proxy ‖ 0x01)[12:]
```

so the salt is mined once, before any content exists, and the page is written
around an address that is already known. It also means the same salt lands the
same address on every chain that has the factory, regardless of what the chunks
did locally — which is the cross-chain confusion the ERC draft warns about.

`scripts/address.mjs` derives and mines:

```sh
node scripts/address.mjs <deployer> --mine 0x000000
node scripts/address.mjs <deployer> <salt>
```

The proxy initcode hash it uses is checked against the canonical
`0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f`.

## Steps

1. **Mine the salt** against the CREATE3 factory you will deploy through
   (Solady's `CREATE3.deployDeterministic`, or CreateX at
   `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`). Record deployer, salt and
   address in `manifest.json`.

2. **Write the address into the page** and pin it:

   ```sh
   node -e 'const f="manifest.json",m=require("./"+f),fs=require("fs"),
     b=fs.readFileSync(m.page);m.bytes=b.length;
     m.sha256=require("crypto").createHash("sha256").update(b).digest("hex");
     fs.writeFileSync(f,JSON.stringify(m,null,2)+"\n")'
   ```

   From here every command fails if the page and the manifest disagree. That is
   deliberate: a chunk set built from a page nobody pinned is how a deployment
   stops matching its repo.

3. **Chunk it.**

   ```sh
   node scripts/chunk.mjs
   ```

   Writes `out/chunkN.creation.txt` and prints the `keccak256` the constructor
   will be given, the chunk count, and the headroom. **Read the count from that
   output, never from here.** This page has been 5 chunks, then 10, and is 11
   at the time of writing; a runbook that names a number is wrong by the next
   time the page grows, and wrong quietly.

4. **Deploy the chunks** with plain `CREATE`, in order, and record the
   addresses. Each is `eth_sendTransaction` with the initcode as `data` and no
   `to`.

   Measured by deploying the real `out/chunkN.creation.txt` initcode to a local
   EVM, not estimated:

   | | gas |
   | --- | --- |
   | a full 24,575 B chunk | 5,368,866 |
   | the part-full last chunk, at 812 B | 228,981 |
   | the `SlowPage` wrapper, over 11 chunks | 1,458,564 |

   The first line confirms the FWA reference figure of ~5.37M to five digits.
   A chunk's cost is code deposit, so it scales with its bytes and nothing else:
   multiply by however many full chunks `chunk.mjs` emits. The wrapper does not
   scale that way — it reassembles the whole document in memory and hashes it,
   so its cost tracks the PAGE, and the figure above is for a 246,562 B one.

   That build — ten full chunks, one part-full, and the wrapper — is
   **55,376,205 gas, about 0.0055 ETH at 0.1 gwei**. Re-measure rather than
   scaling this if the page has moved much; it moves often.

5. **Deploy the wrapper through CREATE3** with the mined salt:

   ```
   SlowPage(slow, initialSteward, previous, chunks, pageHash)
     slow    = 0x000000000000888741B254d37e1b27128AfEAaBC
     previous = 0x0   (generation 1)
   ```

   The constructor reassembles the document and reverts unless it hashes to
   `pageHash`, so a missing chunk, a reordered list, or one chunk from a stale
   build cannot produce a deployed contract at all. The gas estimate succeeding
   is already proof that the chunks add up to exactly this page, before the
   transaction is broadcast.

6. **Verify against the chain**, then point the name:

   ```sh
   node scripts/verify.mjs
   ```

   Checks the chunk runtimes byte-for-byte, `html()` against the repo page, the
   wrapper's own `PAGE_HASH` / `PAGE_LENGTH` / `chunkCount`, that `SLOW()` names
   the protocol contract, that `resolveMode()` is `"5219"` and `request()`
   answers `200` with `text/html`, and that every route declared `exact` serves
   identical bytes.

## Three chains, one page

The page is a portal. It opens on the chain it was served from — a gateway
serving `<0xADDRESS>.<chainId>.<host>` names the chain in the hostname — and a
switcher moves between them. SLOW is at the same canonical address on Ethereum,
Base (8453) and Robinhood Chain (4663), so publishing this page on any one of
them gives readers a working portal onto the other two for free.

Multicall3, Permit2 and CreateX are canonical on all three. Names are the one
thing that is not: `.eth`, `.wei` and `.gwei` resolve on mainnet only, so name
reads are pinned to chain 1 unconditionally — see the ENS note below for why
that is a correctness requirement on 4663 rather than a convenience.

What is verified on chain 4663, the newest of the three, and what the page does
about it:

| | 4663 | consequence |
| --- | --- | --- |
| Multicall3 `0xcA11…CA11` | present | read batching works unchanged |
| Permit2 `0x0000…8BA3` | present | the Permit2 rung works |
| CreateX `0xba5E…ba5Ed` | present | the same CREATE3 salt lands the same address here |
| CREATE2 factory `0x4e59…956C` | present | chunk deploys are deterministic |
| WNS | absent | `.wei` reads go to mainnet |
| ENS registry | present but **empty** | `.eth` reads go to mainnet |
| SLOW | not yet deployed | the page says so instead of showing an empty list |

The ENS row is the one to be careful about. The registry has been
deterministic-deployed to its canonical address on 4663 and has real code, but
holds no records: `resolver(namehash('eth'))` is the zero address. Resolving
against the active chain would not throw — it would report that a valid name
does not exist. Name reads are pinned to chain 1 unconditionally.

Deploying SLOW itself on 4663 is a separate exercise, and it is the natural
place to ship `src/SlowPermit.sol`: a fresh deployment can carry the permit
entrypoints the frozen mainnet one cannot. The page already probes for them per
chain, so it will start using the permit rung on 4663 and keep skipping it on
mainnet, with no change to the page.

## Routes

Record each in `manifest.json` with what it actually serves. `verify.mjs` only
holds a route to the bytes if it claims them.

- `exact` — the contract's own bytes. `w4eth.io` and `wei.limo` both are.
- `resolver` — whatever release a resolver currently points at.
- `modified` — the gateway rewrites the document. `w3link.io` injects its own
  script after `<body>`, so its bytes are not the page's.

## Publishing model

Two options, and the second is the one to take.

`poidh.wei` and `fwa.wei` point their names at the version contract directly. A
successor deployed through `deployNext` does not move the name with it — the
name is repointed by hand, by one key.

`poidhverse` points its name at a **resolver** holding a release root, with a
mandatory three-day delay before a published release activates. A release
propagates to everyone on the name, and the delay is a window to catch a bad one
before it reaches anybody.

For SLOW the delay argues for itself. A frontend that constructs transactions
against a contract holding user funds is exactly the thing that should not be
able to change under its readers within the same block.

## Lineage

`html()` is immutable and stays that way. `successor` is a claim about lineage,
never a redirect: this contract serves its own chunks forever, whatever is
deployed later. A client wanting the newest build walks `successor` to zero; a
client wanting the bytes it audited stops where it is.

`deployNext` creates the successor by CREATE2 **from the predecessor**, so
`msg.sender == previous` in the child's constructor and the backward pointer
cannot be forged by anything outside that function. The steward that may append
is two-step transferable and renounceable; renouncing freezes the lineage
permanently.

## The next protocol build

`src/SLOWNext.sol` is `SLOW.sol` with both extensions folded in, for the
redeployment that puts one identical build on every chain. It is a separate file
so the deployed source stays byte-reproducible: compiling `src/SLOW.sol` under
solc 0.8.34, via-IR, 200 runs, prague still yields the **21,648-byte** runtime
that is live on mainnet today — which is how the settings above were confirmed
rather than assumed.

| build | runtime | under EIP-170 |
| --- | --- | --- |
| `SLOW.sol` as deployed | 21,648 B | 2,928 |
| 2612 + DAI + Permit2, with the improved render | 24,726 B | **150 OVER** |
| EIP-2612 only, `html()` kept | 23,850 B | 726 |
| EIP-2612 only, `html()` removed | 23,670 B | 906 |

The full set no longer fits. The improved `uri()` render pushed it 150 bytes
past the limit, so something has to give, and the numbers say which:

- Dropping the DAI-style and Permit2 entrypoints buys back **876 bytes**. Neither
  asset in any of the three token lists is a DAI-style permit token, and the
  EIP-5792 batch rung already covers "one confirmation" for wallets that can
  batch. This is the cheap cut.
- Dropping `html()` buys back only **180**. That is the surprise: the page
  machinery is two immutables and a concat, and it is nearly free in the protocol
  contract. The argument for moving the page into its own `SlowPage` contract was
  never about the protocol's code size — it is about the PAGE's budget, which
  goes from 47 bytes to unbounded. That argument stands on its own; this one does
  not support it.

Recommendation: EIP-2612 only, `html()` kept — 726 bytes clear.

As actually built today that recommendation lands at **24,356 B, 220 clear**,
not 726: the permit entrypoints carry `nonReentrant` and the two recipient
guards `depositTo` has, which the estimate above did not include. Re-measure
with `forge build --sizes` rather than planning against the table.

### Where the canonical address actually stands

Read off the three chains directly, not assumed:

| chain | `0x0000…AaBC` | what is there |
| --- | --- | --- |
| 1 | **21,648 B** | `SLOW.sol` byte-for-byte; `html()` answers; no permit, no `wardsOf` |
| 8453 | **13,386 B** | a genuine but OLDER SLOW — `name()` says `SLOW`, and `depositTo` / `reverse` / `unlock` / `guardians` / `pendingTransfers` are there, but `getOutboundTransfers`, `getInboundTransfers`, `gate()`, `clawback` and `html()` are NOT |
| 4663 | **0 B** | free |

**The canonical address is occupied on Base.** A CREATE3 deploy to an address
that already holds code fails, so `SLOWNext` cannot land at `0x0000…AaBC` on
8453 — which means the address cannot be the one canonical address across all
three chains. Either the new build goes to a freshly mined address on all three
(and the page's `SLOW` constant moves with it, leaving mainnet's existing
positions at the old address), or Base is dropped from the "same address
everywhere" claim. This is a decision, not a detail: the address gets baked into
an immutable page.

The page already fails loudly here rather than silently — `probeDeployed`
(`dapp/page.html:1824`) requires all five of `depositTo`, `getOutboundTransfers`,
`getInboundTransfers`, `pendingTransfers` and `guardians` in the runtime, and
Base's build is missing two, so it reports a mismatch instead of calling an
entrypoint that is not there. The comment above that probe describes Base's old
build in the past tense, as something fixed by a redeployment; that redeployment
has not happened, and the old build is still live there today.

### If the deployer is CreateX

CreateX is present at `0xba5Ed0…ba5Ed` on all three chains (11,838 B on each),
and both of its salt rules were confirmed against the live contract:

- **Byte 20 of the salt is the redeploy-protection flag, and it must be `0x00`.**
  Setting it mixes `block.chainid` into the guarded salt. Simulating
  `deployCreate3` with one salt across all three chains gives `0x72B1B286…`
  everywhere with the flag clear, and `0x8ee45838…` / `0xfA7E5660…` /
  `0x2DcD713A…` with it set. The protected form is the one that sounds safer and
  is the one that quietly breaks the premise the portal rests on.
- **`scripts/address.mjs` derives from the raw salt and CreateX does not.**
  `deployCreate3` runs the salt through `_guard()` first, so the script's answer
  is right only when fed the already-guarded salt. Same deployer and salt:
  the script says `0x038aC3b9…`, CreateX actually deploys to `0x72B1B286…`.

`manifest.json` still carries `deployment.contract`, `deployment.salt` and
`deployment.create3Deployer` as `null`, and `protocol.note` still reads "It is
not redeployed" — none of the above has been decided or recorded yet.

Two things the integration makes true that are easy to miss:

- **Storage is not compatible with the deployed build.** Base contracts lay out
  first, so the guardian index's two mappings take slots 0 and 1 and push
  everything `SLOW` declares down by two. Harmless at a fresh address, fatal
  behind a proxy. There is no proxy here, and that is the reason there should
  not be one.
- **The ward index is written only where `guardians[...]` is.** Two sites,
  both wired: the immediate first-set path in `setGuardian`, and `commitGuardian`
  where a staged rotation lands. Proposing a rotation deliberately does not touch
  it — until it commits, the old guardian is still the guardian and still the one
  who can veto.

## The permit extension

`src/SlowPermit.sol` is for the **next protocol version**, not for this page
contract, and it cannot be deployed as a router beside SLOW. The reason is in
the file and worth repeating here:

> SLOW records `pendingTransfers[id].from = msg.sender` and `reverse()` requires
> the caller to be that address. A helper that pulled tokens by permit and then
> called `depositTo` would make *itself* the recorded sender — the transfer
> would land in the helper's outbound list, and the user could never reverse or
> claw back their own funds.

Only SLOW can run the permit and keep `msg.sender` intact. Until a version ships
with it, the dapp's permit rung is simply skipped: `dapp/page.html` detects the
selector in the deployed runtime and falls through to EIP-5792 batching, which
needs no contract change at all and is the better path regardless.
