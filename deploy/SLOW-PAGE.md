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
   will be given. At 99 KB the page is 5 chunks with 21,971 B of headroom.

4. **Deploy the chunks** with plain `CREATE`, in order, and record the
   addresses. Each is `eth_sendTransaction` with the initcode as `data` and no
   `to`. Reference cost from the FWA deployment: a full 24.5 KB chunk is about
   5.37M gas, so 5 chunks plus the wrapper is roughly 28M gas — under
   0.003 ETH at 0.1 gwei.

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

## Two chains, one page

The page is a portal. It opens on the chain it was served from — a gateway
serving `<0xADDRESS>.<chainId>.<host>` names the chain in the hostname — and a
switcher moves between them. SLOW is at the same canonical address on both, so
publishing this page on Robinhood Chain gives readers a working mainnet portal
for free.

What is verified on chain 4663, and what the page does about it:

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
