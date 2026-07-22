// keeper.js — settlement-keeper helper for SLOW.
//
// SLOW lets a depositor attach an ETH tip (via depositToWithTip) that pays
// whoever lands the settlement through the gate. A keeper watches for matured,
// eligible pending transfers and calls `gate.claim` / `gate.claimMany` to
// settle them and collect the tips. This is also how a recipient gets funds
// without ever holding ETH for gas ("sponsored delivery").
//
// Eligibility for a tipped `gate.claim` (claimTipped path):
//   1. the transfer exists and is pending,
//   2. its timelock has expired (now >= expiry),
//   3. the RECIPIENT has NO guardian — a guardian on `pt.to` blocks claimTipped,
//      and the tip becomes refundable instead. Filtering these out avoids
//      wasted reverts.
//
// This module is transport-agnostic: it drives a SlowClient for reads and a
// signer callback for the settlement tx, so it runs on top of the zero-dep
// client, viem, or ethers alike.

import { decode, encodeCall } from './codec.js';
import { SEL, EVENTS, GATE_ABI } from './abi.js';

const bn = v => (typeof v === 'bigint' ? v : BigInt(v));

/**
 * Read the tip attached to a transfer from the gate.
 * @returns {Promise<{amount: bigint, sender: string}>}
 */
export async function getTip(client, transferId) {
  const gate = await client.gate();
  const ret = await client.call(encodeCall(SEL.tips, ['uint256'], [bn(transferId)]), gate);
  const [amount, sender] = decode(['uint256', 'address'], ret);
  return { amount, sender };
}

/**
 * Decide whether a single transfer is settleable through the gate right now,
 * and (optionally) whether it currently carries a tip worth collecting.
 *
 * @param {import('./client.js').SlowClient} client
 * @param {bigint|string} transferId
 * @param {object} [opts]
 * @param {number} [opts.now] - wall-clock seconds (default: real time).
 * @param {bigint} [opts.minTip] - skip transfers whose tip is below this (0n = settle even untipped).
 * @returns {Promise<{eligible: boolean, reason?: string, tip: bigint, transfer: object}>}
 */
export async function evaluate(client, transferId, opts = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const minTip = opts.minTip ?? 0n;

  const pt = await client.getPendingTransfer(transferId);
  if (!pt) return { eligible: false, reason: 'not-pending', tip: 0n, transfer: null };
  if (now < pt.expiry) return { eligible: false, reason: 'timelock-active', tip: 0n, transfer: pt };

  const { amount: tip } = await getTip(client, transferId);
  if (tip < minTip) return { eligible: false, reason: 'tip-below-min', tip, transfer: pt };

  // A tipped claim (claimTipped) is blocked if the recipient has a guardian.
  if (tip > 0n) {
    const guardian = await client.guardianOf(pt.to);
    if (guardian !== '0x0000000000000000000000000000000000000000') {
      return { eligible: false, reason: 'recipient-has-guardian', tip, transfer: pt };
    }
  } else {
    // Untipped: gate.claim routes through slow.claim, which needs pt.to to have
    // approved the gate as an operator. Verify to avoid a guaranteed revert.
    const ok = await client.isApprovedForAll(pt.to, await client.gate());
    if (!ok) return { eligible: false, reason: 'recipient-has-not-approved-gate', tip, transfer: pt };
  }

  return { eligible: true, tip, transfer: pt };
}

/**
 * Scan a user's inbound (or any provided) transfer ids and return the subset
 * that is eligible to settle now, sorted by tip descending.
 *
 * @param {import('./client.js').SlowClient} client
 * @param {Array<bigint|string>} transferIds
 * @param {object} [opts] - forwarded to evaluate(); { minTip, now }.
 */
export async function scan(client, transferIds, opts = {}) {
  const results = await Promise.all(transferIds.map(id => evaluate(client, id, opts).catch(e => ({ eligible: false, reason: 'error:' + e.message, tip: 0n, transfer: null }))));
  return results
    .map((r, i) => ({ transferId: bn(transferIds[i]), ...r }))
    .filter(r => r.eligible)
    .sort((a, b) => (b.tip > a.tip ? 1 : b.tip < a.tip ? -1 : 0));
}

/**
 * Settle eligible transfers through the gate. Batches into `gate.claimMany`.
 * Because claimMany reverts atomically on the first bad id, keep batches to
 * ids you have already vetted with scan()/evaluate().
 *
 * @param {import('./client.js').SlowClient} client
 * @param {Array<bigint|string>} transferIds - already-vetted ids.
 * @param {object} [opts]
 * @param {number} [opts.batchSize] - max ids per tx (default 20).
 * @returns {Promise<string[]>} tx hashes.
 */
export async function settle(client, transferIds, opts = {}) {
  const gate = await client.gate();
  const batchSize = opts.batchSize ?? 20;
  const hashes = [];
  for (let i = 0; i < transferIds.length; i += batchSize) {
    const batch = transferIds.slice(i, i + batchSize).map(bn);
    const data = batch.length === 1
      ? encodeCall(SEL.claim, ['uint256'], [batch[0]])
      : encodeCall(SEL.claimMany, ['uint256[]'], [batch]);
    hashes.push(await client.send(data, { to: gate }));
  }
  return hashes;
}

/**
 * End-to-end one-shot: scan the given ids, settle the eligible ones, return a
 * report. Convenient for a cron-driven keeper.
 *
 * @example
 *   const client = new SlowClient(rpcProvider, { account: keeperAddr });
 *   const ids = await client.getInboundTransfers(someUser); // or from an indexer
 *   const report = await runOnce(client, ids, { minTip: 1n });
 */
export async function runOnce(client, transferIds, opts = {}) {
  const eligible = await scan(client, transferIds, opts);
  if (!eligible.length) return { settled: 0, txHashes: [], eligible };
  const txHashes = await settle(client, eligible.map(e => e.transferId), opts);
  return { settled: eligible.length, txHashes, eligible };
}

export { GATE_ABI, EVENTS };
