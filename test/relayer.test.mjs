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

test('keeps a margin before the deadline, because the cancel race is ours to lose', () => {
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
