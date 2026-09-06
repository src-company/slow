# Verifying SlowArrival on Robinhood Chain (4663)

Everything here is prepared. The one thing that cannot be automated is the
Cloudflare challenge in front of the explorer, which needs a human in a browser.

## Why this is a manual step

`SlowArrival` is the only one of the six contracts without an attestation on
4663. Both automated routes are closed, for unrelated reasons:

- **Sourcify** accepts the submission and then fails with
  `bytecode_length_mismatch` against the *creation* bytecode. The contract was
  deployed through CreateX/CREATE3, so the creation transaction on chain is a
  call to the factory rather than raw initcode, and Sourcify cannot reconstruct
  it on this chain. The same submission is an `exact_match` on Ethereum and
  Base, where it can.
- **Blockscout** at `robinhoodchain.blockscout.com` sits behind a Cloudflare
  interstitial that returns an HTML challenge to any API client.

## What is not in doubt

The runtime bytecode is byte-identical on all three chains at 4,916 B, and the
same source is an `exact_match` on the two chains that could check it. What is
missing on 4663 is the attestation, not the correspondence — and
`node scripts/watch.mjs` re-checks the runtime on every run.

## To do it by hand

1. Open https://robinhoodchain.blockscout.com/address/0x9F8D89D298caBDC0D64cbA3888D0DA85Dc95097f/contract-verification
2. Choose **Solidity (Standard JSON Input)**
3. Compiler: `v0.8.34+commit.80d5c536`
4. Upload `SlowArrival.standard-input.json` from this directory
5. Constructor arguments (ABI-encoded), from `SlowArrival.constructor-args.txt`:

```
0x000000000000000000000000000000006513b7821171c8447ec7ecdfa3b956fd0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
```

   That is `(slow, [], [])` — on this chain the contract was deployed with **no
   routes**, so both arrays are empty. `routeTo` reads zero for every chain id,
   which is why `forward` is inert here and `arrive` is the only path in use.
