/**
 * The relayer's decision logic, and the one value that ties it to the contract.
 *
 * THE GOLDEN ID. `intentIdOf` here and `intentId` in SlowRelay must agree, or a
 * relayer fills something nobody will ever pay it for. Both are pinned to the
 * constant below: `test/RelayerId.t.sol` asserts the CONTRACT produces it, and
 * this file asserts the SCRIPT does. Neither can drift without one of them
 * failing, which is the point — a golden value only checked on one side moves
 * with whichever side changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intentIdOf, encodeIntent, assess, INTENT_FIELDS, returnLatencyDays,
} from '../scripts/relayer.mjs';

/** The same intent as test/RelayerId.t.sol, field for field. */
const INTENT = {
  sender: '0xa11ce',
  recipient: '0xb0b',
  srcToken: 0,
  dstToken: 0,
  amount: 10n ** 18n,
  fee: 2n * 10n ** 15n,
  delay: 259200,
  srcChainId: 8453,
  dstChainId: 4663,
  fillDeadline: 1700003600,
  nonce: 1,
};

const GOLDEN = '0xbabf3450d3376731938c939e16c5a0e9f840bf9ca1e1a8dd657961028f2fd414';

test('the intent id matches the contract', () => {
  assert.equal(intentIdOf(INTENT), GOLDEN);
});

test('the id is one 0x-prefixed 32-byte value', () => {
  // A double prefix compares unequal to everything and never matches anything,
  // silently. It is how the first version of this was wrong.
  assert.match(intentIdOf(INTENT), /^0x[0-9a-f]{64}$/);
});

test('the encoding is eleven static words, no offsets', () => {
  assert.equal(INTENT_FIELDS.length, 11);
  assert.equal(encodeIntent(INTENT).length, 2 + 11 * 64);
});

// ── the safety rules ────────────────────────────────────────────────────────

const ctx = (over = {}) => ({
  srcStatus: 'OPEN',
  dstFilledBy: '0x' + '0'.repeat(40),
  now: 1700000000,
  ...over,
});

test('fills a healthy intent', () => {
  const r = assess(INTENT, ctx());
  assert.equal(r.fill, true, r.reasons.join('; '));
  assert.equal(r.id, GOLDEN);
});

test('refuses when the source escrow is not OPEN', () => {
  for (const s of ['NONE', 'RELEASED', 'CANCELLED']) {
    const r = assess(INTENT, ctx({ srcStatus: s }));
    assert.equal(r.fill, false);
    assert.match(r.reasons.join(' '), /not OPEN/);
  }
});

test('refuses when the log id disagrees with the intent', () => {
  const r = assess(INTENT, ctx({ loggedId: '0x' + 'ff'.repeat(32) }));
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /does not match/);
});

test('refuses an intent already filled', () => {
  const r = assess(INTENT, ctx({ dstFilledBy: '0x000000000000000000000000000000000000dEaD' }));
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /already filled/);
});

test('keeps a margin before the deadline — prudence now, not protection', () => {
  // Ten minutes left, thirty-minute margin.
  const r = assess(INTENT, ctx({ now: INTENT.fillDeadline - 600 }));
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /inside the 1800s margin/);

  // And past it outright.
  const past = assess(INTENT, ctx({ now: INTENT.fillDeadline + 1 }));
  assert.equal(past.fill, false);
  assert.match(past.reasons.join(' '), /deadline has passed/);
});

test('refuses a fee that does not pay for the capital', () => {
  const stingy = { ...INTENT, fee: 1n };
  const r = assess(stingy, ctx());
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /below the 5bps floor/);
});

test('refuses a chain it does not serve', () => {
  const r = assess({ ...INTENT, dstChainId: 999999 }, ctx());
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /not served/);
});

test('prices the fee against the RETURN leg, not the outbound one', () => {
  // Repayment for a Robinhood fill comes back from Robinhood: ~6.4 days.
  assert.equal(returnLatencyDays(4663), 6.4);
  assert.equal(returnLatencyDays(8453), 5);

  const r = assess(INTENT, ctx());
  assert.equal(r.economics.bps, 20);
  assert.equal(r.economics.lockupDays, 6.4);
  // 20bps over 6.4 days is a bit over 11% annualised.
  assert.ok(r.economics.impliedApr > 10 && r.economics.impliedApr < 13, String(r.economics.impliedApr));
});

test('collects every reason rather than stopping at the first', () => {
  const r = assess({ ...INTENT, fee: 1n }, ctx({ srcStatus: 'CANCELLED' }));
  assert.equal(r.fill, false);
  assert.ok(r.reasons.length >= 2, r.reasons.join('; '));
});

/* ── rule 6: know both legs before pricing either ──────────────────────────
   The escrow is the only thing a relayer ever gets back, so `srcToken` is what
   it is being PAID IN. Before this rule existed `assess` never read either
   token field, and `fee / amount` was a ratio between two different contracts'
   units — which is not a rate, and which a sender could set to anything. */

test('refuses an escrow token it does not accept as payment', () => {
  // The confetti fee: a token the sender minted, escrowed in bulk against a
  // real fill. The bps floor reads it as generous; the relayer is paid nothing.
  const confetti = { ...INTENT, srcToken: '0x' + 'c0ffee'.padStart(40, '0'), fee: 10n ** 24n };
  const r = assess(confetti, ctx());
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /not an asset this relayer accepts as payment/);
  // And the headline number is withheld rather than quoted off a bad unit.
  assert.equal(r.economics.priceable, false);
  assert.equal(r.economics.impliedApr, null);
});

test('refuses to deliver an asset it does not carry', () => {
  const r = assess({ ...INTENT, dstToken: '0x' + '11'.repeat(20) }, ctx());
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /will deliver/);
});

test('refuses to price one asset against another', () => {
  const assets = {
    8453: { ['0x' + '0'.repeat(40)]: { symbol: 'ETH', decimals: 18 } },
    4663: { ['0x' + '22'.repeat(20)]: { symbol: 'USDC', decimals: 6 } },
  };
  const r = assess({ ...INTENT, dstToken: '0x' + '22'.repeat(20) }, ctx(), { assets });
  assert.equal(r.fill, false);
  assert.match(r.reasons.join(' '), /no cross-asset price/);
});

test('scales the fee when the same asset is stated at different decimals', () => {
  // USDC at 6 decimals on the source, 18 on the destination. The fee is 20bps
  // either way; only a scaled comparison says so.
  const assets = {
    8453: { ['0x' + '33'.repeat(20)]: { symbol: 'USDC', decimals: 6 } },
    4663: { ['0x' + '44'.repeat(20)]: { symbol: 'USDC', decimals: 18 } },
  };
  const i = {
    ...INTENT,
    srcToken: '0x' + '33'.repeat(20),
    dstToken: '0x' + '44'.repeat(20),
    amount: 10n ** 18n,        // 1 USDC at 18 decimals
    fee: 2n * 10n ** 3n,       // 0.002 USDC at 6 decimals
  };
  const r = assess(i, ctx(), { assets });
  assert.equal(r.economics.bps, 20, r.reasons.join('; '));
  assert.equal(r.economics.rawFee, '2000');
  assert.equal(r.economics.fee, (2n * 10n ** 15n).toString());
  assert.equal(r.fill, true, r.reasons.join('; '));
});
