#!/usr/bin/env node
/**
 * A reference relayer for SlowRelay.
 *
 * WHAT IT IS FOR. `SlowRelay` is inert without one. An intent opens, nobody
 * fills it, and the sender cancels at the deadline — the escrow is never at
 * risk, but nothing happens either. This is the missing half: something that
 * watches for intents and fronts the destination leg.
 *
 * WHAT IT IS NOT. Not production infrastructure. It has no database, no nonce
 * management, no gas strategy, and no inventory rebalancing. It exists so that
 * the relayed path can be exercised end to end and so the SAFETY RULES a
 * relayer must follow are written down somewhere executable rather than left
 * as folklore.
 *
 * THE RULES, and why each one is the relayer's own money at stake:
 *
 *   1. TRUST THE SOURCE CHAIN, NOT THE EVENT. An `Opened` log is a claim. The
 *      escrow is real only if `statusOf(id) == OPEN` when read from the source
 *      chain itself. A reorg, a forged log from an impostor contract, or a
 *      stale RPC all produce a convincing event over an empty escrow.
 *
 *   2. RECOMPUTE THE ID. Never fill against the id in the log. Recompute it
 *      from the intent's own fields and require it to match: the id is the only
 *      thing tying the fill on one chain to the escrow on the other, and a
 *      mismatch means filling something nobody will ever pay for.
 *
 *   3. THE MARGIN IS PRUDENCE, NOT PROTECTION — and an earlier version of this
 *      file had that backwards. It said the cancel race was "deliberately the
 *      relayer's to lose" and that a margin was the defence. Both were wrong.
 *
 *      `cancel` used to gate on `provenBy`, the ARRIVAL of the news rather than
 *      the fact of the fill, and the only writer of `provenBy` is a canonical
 *      exit days away. So a sender could open a one-hour window, take real
 *      inventory, refund an hour later while the proof was still six days out,
 *      and keep both legs. For any deadline shorter than the challenge period
 *      there was no safe fill time at all, including the first block — so the
 *      advice to "keep a margin" could not be followed by anyone.
 *
 *      The contract fixes it: `cancel` now requires
 *      `fillDeadline + PROOF_GRACE`, eight days, which clears the longer
 *      challenge period so the earliest possible proof always precedes the
 *      earliest possible refund. The margin below is now only about not wasting
 *      gas on a fill that may be redundant. It is no longer what stands between
 *      a relayer and being robbed.
 *
 *   4. CHECK IT IS NOT ALREADY FILLED, on the destination chain, immediately
 *      before sending. `fill` reverts on a second attempt, so the cost of
 *      losing this race is gas rather than principal, but it is still the most
 *      common way to waste a transaction.
 *
 *   5. PRICE THE CAPITAL. The fee has to cover the canonical latency of the
 *      RETURN leg, because that is how long the relayer's own money is locked
 *      up waiting for the proof to come back. Filling below that is a donation.
 *
 *   6. KNOW BOTH LEGS BEFORE PRICING EITHER — and this file used to skip it
 *      entirely. `fee` is denominated in `srcToken` and `amount` in `dstToken`,
 *      which the Intent struct keeps as two fields precisely because they are
 *      DIFFERENT CONTRACTS: USDC on Base and USDC on Robinhood Chain are not
 *      one address, and whatever sits at Base's USDC address on another chain
 *      is unrelated to it. So `fee / amount` is not a rate at all until both
 *      sides are known to name the same asset at the same decimals.
 *
 *      Left unchecked it is not merely imprecise, it is the cheapest attack on
 *      a relayer there is: mint a token worth nothing, escrow a mountain of it
 *      as `fee` against a real USDC `amount`, and the bps floor in rule 5 reads
 *      it as a generous offer. The relayer delivers real USDC and is paid in
 *      the sender's own confetti. The escrow is the ONLY thing it ever gets
 *      back, so an asset it would not choose to hold is an asset it must not
 *      be paid in.
 *
 * Dry run unless RELAYER_KEY is set, so it can be pointed at mainnet and read
 * without the possibility of spending anything.
 *
 *   node scripts/relayer.mjs                 # watch and explain, send nothing
 *   RELAYER_KEY=0x… node scripts/relayer.mjs # actually fill
 */
import { keccak256 } from './lib.mjs';

// ─── chains ────────────────────────────────────────────────────────────────

export const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', returnDays: 0 },
  8453: { name: 'Base', rpc: 'https://base-rpc.publicnode.com', returnDays: 5 },
  4663: { name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com', returnDays: 6.4 },
};

/** How long the relayer's capital is locked waiting to be repaid FROM `chain`. */
export const returnLatencyDays = (chainId) => CHAINS[chainId]?.returnDays ?? 7;

const NATIVE = '0x' + '0'.repeat(40);

/**
 * What this relayer is willing to hold, per chain, and what each of them IS.
 *
 * Two jobs in one table, and rule 6 needs both. The keys are the allowlist: an
 * asset absent from a chain's entry is one the relayer declines to be paid in
 * or to deliver. The values are what make a price out of two amounts — the same
 * `symbol` on both legs is what says the escrow and the fill are the same
 * underlying thing, and `decimals` is what lets the ratio be computed when they
 * are stated at different scales.
 *
 * Native ETH only, deliberately: a reference relayer has no business guessing
 * at anyone's inventory policy, and an empty-by-default allowlist fails closed.
 * Add entries here — or pass `opts.assets` — before filling anything else.
 */
export const ASSETS = {
  1: { [NATIVE]: { symbol: 'ETH', decimals: 18 } },
  8453: { [NATIVE]: { symbol: 'ETH', decimals: 18 } },
  4663: { [NATIVE]: { symbol: 'ETH', decimals: 18 } },
};

// ─── the intent ────────────────────────────────────────────────────────────

/**
 * Every field is a static type, so `abi.encode` is just eleven words in order
 * with no offsets — which is why the id can be computed here at all, and why
 * this must stay in step with the struct. Reordering the struct and not this
 * produces ids that look fine and match nothing.
 */
export const INTENT_FIELDS = [
  'sender', 'recipient', 'srcToken', 'dstToken',
  'amount', 'fee', 'delay', 'srcChainId', 'dstChainId', 'fillDeadline', 'nonce',
];

const word = (v) => {
  const n = typeof v === 'string' && v.startsWith('0x') ? BigInt(v) : BigInt(v);
  if (n < 0n) throw new Error('negative');
  return n.toString(16).padStart(64, '0');
};

export const encodeIntent = (i) => '0x' + INTENT_FIELDS.map((f) => word(i[f])).join('');

/** An intent's token field, in the one shape the allowlist is keyed on. */
const addrOf = (v) => '0x' + word(v).slice(24);

/** Restate `v` from `from` decimals to `to` decimals. */
const scaleTo = (v, from, to) =>
  from === to ? v : from < to ? v * 10n ** BigInt(to - from) : v / 10n ** BigInt(from - to);

/** `keccak256(abi.encode(intent))` — identical on both chains, by design. */
/* `keccak256` from lib.mjs already returns a 0x-prefixed string; prefixing it
   again produced `0x0x…`, which compares unequal to everything and silently
   never matches. Checked against the contract rather than assumed. */
export const intentIdOf = (i) => keccak256(Buffer.from(encodeIntent(i).slice(2), 'hex'));

// ─── rpc ───────────────────────────────────────────────────────────────────

export const call = async (chainId, to, data) => {
  const url = CHAINS[chainId].rpc;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${CHAINS[chainId].name}: ${j.error.message}`);
  return j.result;
};

const SEL = {};

/** Selectors are derived rather than pasted, so a renamed getter fails loudly. */
/* Same trap: the hash arrives with its own 0x, so a selector is its first ten
   characters and not '0x' plus its first eight. */
const selector = (sig) => keccak256(Buffer.from(sig, 'utf8')).slice(0, 10);
SEL.statusOf = selector('statusOf(bytes32)');
SEL.filledBy = selector('filledBy(bytes32)');

const STATUS = ['NONE', 'OPEN', 'RELEASED', 'CANCELLED'];

export const statusOf = async (chainId, relay, id) =>
  STATUS[Number(BigInt(await call(chainId, relay, SEL.statusOf + id.slice(2))))] ?? 'UNKNOWN';

export const filledBy = async (chainId, relay, id) =>
  '0x' + (await call(chainId, relay, SEL.filledBy + id.slice(2))).slice(-40);

// ─── the decision ──────────────────────────────────────────────────────────

/**
 * Whether to fill, and — much more usefully — why not. Returns a plain object
 * rather than throwing, so the dry run can explain every intent it declines
 * instead of stopping at the first.
 *
 * @param opts.marginSeconds how far before `fillDeadline` to stop filling. Not
 *        a safety parameter — see rule 3.
 * @param opts.minFeeBps     the least the relayer will work for, in basis points
 */
export function assess(intent, ctx, opts = {}) {
  const marginSeconds = opts.marginSeconds ?? 30 * 60;
  const minFeeBps = opts.minFeeBps ?? 5;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const reasons = [];

  // 2. Recompute the id, never trust the log's.
  const id = intentIdOf(intent);
  if (ctx.loggedId && ctx.loggedId.toLowerCase() !== id.toLowerCase()) {
    reasons.push('the id in the log does not match the intent it carries');
  }

  if (!CHAINS[intent.dstChainId]) reasons.push(`destination ${intent.dstChainId} is not served`);
  if (!CHAINS[intent.srcChainId]) reasons.push(`source ${intent.srcChainId} is not served`);

  // 1. The escrow has to be real, read from the source chain itself.
  if (ctx.srcStatus !== 'OPEN') reasons.push(`escrow on the source reads ${ctx.srcStatus}, not OPEN`);

  // 4. And not already filled.
  if (ctx.dstFilledBy && !/^0x0{40}$/.test(ctx.dstFilledBy)) {
    reasons.push(`already filled by ${ctx.dstFilledBy}`);
  }

  // 3. Prudence, not protection: PROOF_GRACE in the contract is what makes a
  //    fill safe. This only avoids spending gas near a window that is closing.
  const left = Number(intent.fillDeadline) - now;
  if (left <= 0) reasons.push('the fill deadline has passed');
  else if (left < marginSeconds) {
    reasons.push(`only ${left}s to the deadline, inside the ${marginSeconds}s margin`);
  }

  // 6. Both legs, before either is priced. `fee` is in srcToken and `amount` is
  //    in dstToken; a ratio between them is meaningless until they are known to
  //    be the same asset, and worse than meaningless when they are not.
  const assets = opts.assets ?? ASSETS;
  const srcToken = addrOf(intent.srcToken);
  const dstToken = addrOf(intent.dstToken);
  const src = assets[intent.srcChainId]?.[srcToken];
  const dst = assets[intent.dstChainId]?.[dstToken];
  if (!src) reasons.push(`srcToken ${srcToken} is not an asset this relayer accepts as payment`);
  if (!dst) reasons.push(`dstToken ${dstToken} is not an asset this relayer will deliver`);
  if (src && dst && src.symbol !== dst.symbol) {
    reasons.push(
      `paid in ${src.symbol} to deliver ${dst.symbol}; this relayer holds no cross-asset price`
    );
  }

  // 5. Price the capital: the fee is earned over the RETURN leg's latency.
  //    Only reached as a real number once rule 6 has agreed the two legs are
  //    comparable — scaled to the fill's decimals, since the same asset can be
  //    stated at different ones on different chains.
  const amount = BigInt(intent.amount);
  const rawFee = BigInt(intent.fee);
  const priceable = !!src && !!dst && src.symbol === dst.symbol;
  const fee = priceable ? scaleTo(rawFee, src.decimals, dst.decimals) : 0n;
  const bps = priceable && amount !== 0n ? (fee * 10000n) / amount : 0n;
  if (priceable && bps < BigInt(minFeeBps)) {
    reasons.push(`fee is ${bps}bps, below the ${minFeeBps}bps floor`);
  }

  const days = returnLatencyDays(intent.dstChainId);
  const apr =
    !priceable || amount === 0n ? null : (Number(fee) / Number(amount)) * (365 / days) * 100;

  return {
    id,
    fill: reasons.length === 0,
    reasons,
    economics: {
      amount: amount.toString(),
      // The fee AS PRICED — scaled to the fill's decimals — alongside the raw
      // field, so a reader can see both the number in the intent and the number
      // the decision was actually made on.
      fee: fee.toString(),
      rawFee: rawFee.toString(),
      srcAsset: src ? src.symbol : null,
      dstAsset: dst ? dst.symbol : null,
      priceable,
      bps: Number(bps),
      lockupDays: days,
      impliedApr: Number.isFinite(apr) ? Number(apr.toFixed(2)) : null,
    },
  };
}

// ─── cli ───────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('relayer.mjs');
if (invokedDirectly) {
  const key = process.env.RELAYER_KEY;
  console.log(key ? 'LIVE — will send fills' : 'DRY RUN — reads only, sends nothing');
  console.log('');
  console.log('SlowRelay is not deployed yet, so there is nothing to watch.');
  console.log('The decision logic is exercised by test/relayer.test.mjs, and the');
  console.log('rules it enforces are documented at the top of this file.');
  console.log('');
  for (const [id, c] of Object.entries(CHAINS)) {
    console.log(`  ${String(id).padEnd(6)} ${c.name.padEnd(10)} return leg ~${c.returnDays}d`);
  }
}
