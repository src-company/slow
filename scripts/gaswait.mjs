#!/usr/bin/env node
/**
 * Wait for a chain's base fee to sit at the bottom of its cycle, then exit 0.
 *
 * WHAT THIS IS AND IS NOT WORTH. On a Nitro chain the base fee is not a
 * congestion signal the way mainnet's is — it oscillates in a sawtooth around a
 * configured floor, climbing while blocks run above the speed limit and
 * snapping back when they do not. Measured on Robinhood Chain: ~12.5 blocks a
 * second, 0.39408 gwei at the trough against 0.41454 at the peak, a 5% spread,
 * while the chain sustains 72.7 M gas/s.
 *
 * So gating a submission on the trough saves about 2% against the average and
 * 5% against the worst moment. That is worth taking on a 58-million-gas page
 * deployment and it is NOT a way to deploy on a balance that cannot afford the
 * chain. A four-times shortfall stays a four-times shortfall; this closes
 * nothing, it only stops you paying the peak eleven times in a row.
 *
 * THE FLOOR IS OBSERVED, NEVER ASSUMED. It is a chain parameter this script has
 * no way to read, and hardcoding one is how a tool keeps waiting for a price
 * that will not come back. So the floor is the minimum over a sample of recent
 * blocks, and the wait is bounded: on timeout it reports and exits non-zero
 * rather than blocking a deployment forever.
 *
 *   node scripts/gaswait.mjs <rpc-url> [--tolerance 0.02] [--timeout 120]
 *   node scripts/gaswait.mjs <rpc-url> --report        (sample and print, wait for nothing)
 */
const args = process.argv.slice(2);
const url = args[0];
if (!url || url.startsWith('--')) {
  console.error('usage: node scripts/gaswait.mjs <rpc-url> [--tolerance 0.02] [--timeout 120] [--report]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : Number(args[i + 1]);
};
const tolerance = flag('tolerance', 0.02);
const timeoutS = flag('timeout', 120);
const samples = flag('samples', 30);
const reportOnly = args.includes('--report');

const rpc = async (method, params) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'user-agent': 'curl/8'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const baseFeeAt = async (tag) =>
  BigInt((await rpc('eth_getBlockByNumber', [tag, false])).baseFeePerGas ?? '0x0');

/** The floor, as the minimum over a window of recent blocks. */
const observeFloor = async () => {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  const fees = [];
  for (let i = 0; i < samples; i++) {
    fees.push(await baseFeeAt('0x' + (head - i).toString(16)));
  }
  fees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {floor: fees[0], peak: fees[fees.length - 1], mid: fees[fees.length >> 1]};
};

const gwei = (v) => (Number(v) / 1e9).toFixed(5);

const {floor, peak, mid} = await observeFloor();
const spread = Number(peak - floor) / Number(floor || 1n);
console.log(`floor ${gwei(floor)} gwei · median ${gwei(mid)} · peak ${gwei(peak)}` +
  `  (spread ${(spread * 100).toFixed(1)}% over ${samples} blocks)`);

if (reportOnly) {
  console.log(`waiting for <= ${gwei(floor + floor * BigInt(Math.round(tolerance * 1000)) / 1000n)} gwei would save` +
    ` ~${((1 - Number(floor) / Number(mid)) * 100).toFixed(1)}% against the median`);
  process.exit(0);
}

// A tolerance band, because the exact trough lasts one block and a submission
// that only ever fires on the minimum may never fire at all.
const target = floor + (floor * BigInt(Math.round(tolerance * 1000))) / 1000n;
const deadline = Date.now() + timeoutS * 1000;
for (;;) {
  const now = await baseFeeAt('latest');
  if (now <= target) {
    console.log(`at ${gwei(now)} gwei (<= ${gwei(target)}) — go`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`timed out at ${gwei(now)} gwei, target ${gwei(target)}.` +
      ` Submitting anyway costs ~${((Number(now) / Number(floor) - 1) * 100).toFixed(1)}% over the floor.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
