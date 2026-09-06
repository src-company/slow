# slow-relayer

`SlowRelay` is inert without one of these. An intent opens, nobody fills it, and
the sender cancels at the deadline — the escrow was never at risk, but nothing
happened either.

This worker watches all three chains for `Opened`, decides whether to fill using
the rules in [`scripts/relayer.mjs`](../scripts/relayer.mjs), fronts the
destination leg, and then pushes the proof and collects the escrow.

## It fails closed

Without `RELAYER_KEY` it is a **dry run**: it reads, explains every decision,
and sends nothing. That is the default, and it is a useful thing to run on its
own — it makes the relay path observable without putting up capital.

Filling is bounded even when live:

| variable | default | what it does |
| --- | --- | --- |
| `RELAYER_KEY` | unset | hex private key. Unset means dry run. |
| `MAX_FILL_WEI` | `1000000000000000` (0.001 ETH) | refuses any intent above this, whatever the fee |
| `MIN_FEE_BPS` | `5` | the least it will work for |
| `MARGIN_SECONDS` | `1800` | stops filling this long before `fillDeadline` |
| `POLL_MS` | `20000` | how often each chain is polled |
| `LOOKBACK_BLOCKS` | `5000` | how far back to scan on a cold start |

The asset allowlist is native ETH only and lives in `scripts/relayer.mjs`. An
asset absent from it is one this relayer declines to be paid in *or* to deliver
— see rule 6 there for why being paid in an unlisted token is the cheapest
attack on a relayer there is.

## The rules it follows

They are documented at the top of `scripts/relayer.mjs`, and each one is the
relayer's own money at stake. In short: trust the source chain rather than the
event, recompute the id rather than trusting the log's, fill from an EOA, and
never treat `fee/amount` as a rate until both legs are known to name the same
asset at the same decimals.

Two of those are also in [`deploy/OPERATING-RULES.md`](../deploy/OPERATING-RULES.md)
as rules 2 and 3, because they are what make the deployed `SlowRelay` safe
without changing it.

## Running it

```
cd relayer && npm install
node index.mjs                  # dry run
RELAYER_KEY=0x… node index.mjs  # live, still bounded by MAX_FILL_WEI
```

On Render it is a **background worker**, not a web service: it needs to run
continuously and serves no HTTP. A free web service would spin down and stop
watching.
