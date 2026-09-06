#!/usr/bin/env node
/**
 * The live half of SlowRelay.
 *
 * The decision — whether an intent is worth filling, and why not — lives in
 * `scripts/relayer.mjs` and is imported rather than restated here. That file is
 * dependency-free and unit-tested; this one adds only the two things a decision
 * cannot do by itself: watching, and signing.
 *
 * WHAT IS DELIBERATELY NOT HERE. No database. State is re-derived from chain
 * on every pass, because the chain is the only record that survives a restart
 * and a worker that trusts its own memory across a redeploy is a worker that
 * double-fills. The in-memory maps below are caches for the current process,
 * never a source of truth: every action re-reads the state that authorises it
 * immediately before sending.
 */
import { createPublicClient, createWalletClient, http, fallback, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base } from 'viem/chains';
import { CHAINS, ASSETS, assess, intentIdOf, INTENT_FIELDS } from '../scripts/relayer.mjs';
import { createPool } from './rpc.mjs';

const RELAY = '0xC58C217791E397550492c4F84a6995Db60aDE2da';

// ─── config ────────────────────────────────────────────────────────────────

const KEY = process.env.RELAYER_KEY;
const LIVE = !!KEY;
const MAX_FILL_WEI = BigInt(process.env.MAX_FILL_WEI ?? '1000000000000000');
const MIN_FEE_BPS = Number(process.env.MIN_FEE_BPS ?? 5);
const MARGIN_SECONDS = Number(process.env.MARGIN_SECONDS ?? 1800);
const POLL_MS = Number(process.env.POLL_MS ?? 20000);
/**
 * How far back a cold start scans, per chain.
 *
 * Not one number, because the chains do not offer the same history. The free
 * L1 endpoints serve only a few dozen blocks of `eth_getLogs`, so asking for
 * thousands fails the whole scan rather than returning less — and a uniform
 * 5,000 made Ethereum error on every pass while the L2s were fine. The L2
 * figures are roughly an hour at their block times; the L1 figure is what the
 * public pool will actually answer, which is about five minutes.
 *
 * Set LOOKBACK_BLOCKS to override all three, or give RPC_1 a keyed endpoint and
 * raise the L1 figure to something that would survive a restart.
 */
const LOOKBACK_DEFAULT = { 1: 25n, 8453: 1800n, 4663: 1800n };
const lookbackFor = (id) =>
  process.env.LOOKBACK_BLOCKS ? BigInt(process.env.LOOKBACK_BLOCKS) : LOOKBACK_DEFAULT[id] ?? 500n;

/**
 * The RPCs, and why there is a pool of them rather than one.
 *
 * `scripts/relayer.mjs` names one endpoint per chain, which is fine for the
 * `eth_call` it does. This worker also needs `eth_getLogs` over a range, and
 * that is where the free tier stops being uniform. Measured, on the same range,
 * the same minute:
 *
 *   drpc          "Can't route your request to suitable provider"
 *   publicnode    serves ~100 blocks, then "Archive requests require a token"
 *   1rpc          "eth_getLogs is limited to 0 - 50 blocks range"
 *   nodies        "maximum allowed is 50 blocks"
 *   ankr          needs an API key
 *   cloudflare    "Internal error"
 *   Robinhood     one endpoint, and it rate limits a four-chunk scan
 *
 * So `rpc.mjs` rotates, fails over on the ERROR RESULT rather than only on a
 * dead socket, learns each endpoint's real range cap, and waits out a rate
 * limit instead of writing the endpoint off. See the header there.
 *
 * ETHEREUM IS THE HONEST GAP. No free endpoint tested would serve `eth_getLogs`
 * more than a few dozen blocks back, so the L1 lookback is deliberately short
 * and an intent opened on L1 while this worker was down can be missed. Set
 * RPC_1 to a keyed endpoint before relying on the L1 leg. Base and Robinhood
 * are served fine by the public pools below.
 */
const list = (v, fallback) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : fallback);
const RPCS = {
  1: list(process.env.RPC_1, [
    'https://eth.drpc.org',
    'https://ethereum.publicnode.com',
    'https://cloudflare-eth.com',
  ]),
  8453: list(process.env.RPC_8453, [
    'https://mainnet.base.org',
    'https://base.drpc.org',
    'https://base-rpc.publicnode.com',
  ]),
  4663: list(process.env.RPC_4663, [CHAINS[4663].rpc]),
};
const RPC = Object.fromEntries(Object.entries(RPCS).map(([k, v]) => [k, v[0]]));

const pool = Object.fromEntries(
  Object.entries(RPCS).map(([k, urls]) => [k, createPool(urls, { maxSpan: Number(k) === 1 ? 30 : 500 })])
);

/**
 * How far behind the tip to scan. Two endpoints in a pool are never at exactly
 * the same height, and asking one for a range ending at another's head is an
 * error ("block range extends beyond current head block") rather than a short
 * answer. Staying behind the tip removes that, and it is what you want anyway:
 * a log read at the tip can be reorged out from under the decision it caused.
 */
const CONFIRMATIONS = { 1: Number(process.env.CONFIRMATIONS_1 ?? 3), 8453: 4, 4663: 4 };

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC[4663]] } },
});
const VIEM_CHAIN = { 1: mainnet, 8453: base, 4663: robinhood };

const account = LIVE ? privateKeyToAccount(KEY.startsWith('0x') ? KEY : '0x' + KEY) : null;

const pub = {}, wallet = {};
for (const id of Object.keys(CHAINS).map(Number)) {
  const chain = VIEM_CHAIN[id];
  const transport = fallback(RPCS[id].map((u) => http(u, { retryCount: 1 })));
  pub[id] = createPublicClient({ chain, transport });
  if (LIVE) wallet[id] = createWalletClient({ account, chain, transport });
}

// ─── abi ───────────────────────────────────────────────────────────────────

const INTENT_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'sender', type: 'address' }, { name: 'recipient', type: 'address' },
    { name: 'srcToken', type: 'address' }, { name: 'dstToken', type: 'address' },
    { name: 'amount', type: 'uint256' }, { name: 'fee', type: 'uint256' },
    { name: 'delay', type: 'uint96' }, { name: 'srcChainId', type: 'uint64' },
    { name: 'dstChainId', type: 'uint64' }, { name: 'fillDeadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const ABI = [
  { type: 'event', name: 'Opened', inputs: [
    { name: 'intentId', type: 'bytes32', indexed: true },
    { name: 'sender', type: 'address', indexed: true },
    { name: 'slowId', type: 'uint256' },
    { ...INTENT_TUPLE, name: 'intent' },
  ]},
  { type: 'function', name: 'statusOf', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'filledBy', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'provenBy', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'intentId', stateMutability: 'pure',
    inputs: [{ ...INTENT_TUPLE, name: 'i' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'fill', stateMutability: 'payable',
    inputs: [{ ...INTENT_TUPLE, name: 'i' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'proveFill', stateMutability: 'nonpayable',
    inputs: [{ ...INTENT_TUPLE, name: 'i' }], outputs: [] },
  { type: 'function', name: 'release', stateMutability: 'nonpayable',
    inputs: [{ ...INTENT_TUPLE, name: 'i' }], outputs: [] },
];
const STATUS = ['NONE', 'OPEN', 'RELEASED', 'CANCELLED'];
const NATIVE = '0x' + '0'.repeat(40);

// ─── plumbing ──────────────────────────────────────────────────────────────

const now = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(now(), ...a);
const err = (...a) => console.error(now(), 'ERROR', ...a);

const read = (chainId, name, args) =>
  pub[chainId].readContract({ address: RELAY, abi: ABI, functionName: name, args });

/** Intents this process has already acted on, so a poll does not repeat work. */
const seen = new Map();      // id -> intent
const filledHere = new Set(); // id, filled by THIS relayer in THIS process
const cursor = {};            // chainId -> next block to scan

// ─── the pass ──────────────────────────────────────────────────────────────

const OPENED_TOPIC = '0xdd10c5d1da4dfd4cb1bb4c515b2c692c4a4a67e18fcbcf1bb0a3ea4d01591865';

/**
 * Decode an `Opened` log by hand.
 *
 * Every field of `Intent` is a static type, so the non-indexed half of the
 * event is just twelve words in order — `slowId`, then the eleven fields — with
 * no offsets to follow. That is the same property that lets `encodeIntent`
 * exist in `scripts/relayer.mjs`, and it is why this needs no ABI decoder. It
 * must stay in step with the struct: reorder the struct without reordering
 * `INTENT_FIELDS` and this produces intents that look fine and hash to nothing.
 */
function decodeOpened(l) {
  const d = l.data.startsWith('0x') ? l.data.slice(2) : l.data;
  const word = (i) => d.slice(i * 64, (i + 1) * 64);
  if (d.length < 12 * 64) throw new Error('Opened log is too short to hold an intent');
  const intent = {};
  INTENT_FIELDS.forEach((f, k) => {
    const w = word(k + 1);
    intent[f] = f.endsWith('Token') || f === 'sender' || f === 'recipient'
      ? '0x' + w.slice(24)
      : BigInt('0x' + w).toString();
  });
  return { loggedId: l.topics[1], intent, blockNumber: BigInt(l.blockNumber) };
}

async function scan(srcChainId) {
  const tip = BigInt(await pool[srcChainId].send('eth_blockNumber', []));
  const conf = BigInt(CONFIRMATIONS[srcChainId] ?? 3);
  const head = tip > conf ? tip - conf : 0n;
  if (cursor[srcChainId] === undefined) {
    const back = lookbackFor(srcChainId);
    cursor[srcChainId] = head > back ? head - back : 0n;
    log(`${CHAINS[srcChainId].name}: cold start, scanning from block ${cursor[srcChainId]}`);
  }
  if (cursor[srcChainId] > head) return;

  let logs;
  try {
    logs = await pool[srcChainId].getLogs({
      address: RELAY, topics: [OPENED_TOPIC],
      fromBlock: cursor[srcChainId], toBlock: head,
    });
  } catch (e) {
    // The cursor is deliberately NOT advanced: a scan that skips the blocks it
    // could not read is a relayer that silently misses intents.
    err(`${CHAINS[srcChainId].name}: getLogs ${cursor[srcChainId]}-${head}: ${e.message.slice(0, 200)}`);
    return;
  }
  for (const l of logs) {
    try { await consider(srcChainId, decodeOpened(l)); }
    catch (e) { err(`${CHAINS[srcChainId].name} log at ${l.blockNumber}: ${e.message}`); }
  }
  cursor[srcChainId] = head + 1n;
}

async function consider(srcChainId, { loggedId, intent, blockNumber }) {

  // Rule 2: recompute, never trust the log's id.
  const id = intentIdOf(intent);
  if (id.toLowerCase() !== loggedId.toLowerCase()) {
    err(`id mismatch at ${CHAINS[srcChainId].name} block ${blockNumber}: log says ${loggedId}, fields give ${id} — IGNORED`);
    return;
  }
  if (seen.has(id)) return;
  seen.set(id, intent);

  const dst = Number(intent.dstChainId);
  if (!CHAINS[dst]) { log(`${id.slice(0,10)} targets chain ${dst}, which this relayer does not serve`); return; }
  if (Number(intent.srcChainId) !== srcChainId) {
    err(`${id.slice(0,10)} claims srcChainId ${intent.srcChainId} but was logged on ${srcChainId} — IGNORED`);
    return;
  }

  // Rule 1: the escrow is real only if the SOURCE chain says so, and rule 2's
  // sibling — whether someone already filled it — is a fact about the
  // DESTINATION. `assess` is the single decision point, so both are read here
  // and handed to it rather than re-checked afterwards. Reading them after the
  // decision, as this did, left rule 1 blind: `ctx.srcStatus` was undefined and
  // every intent was declined as "reads undefined, not OPEN".
  let srcStatus, dstFilledBy;
  try {
    srcStatus = STATUS[Number(await read(srcChainId, 'statusOf', [id]))] ?? 'UNKNOWN';
    dstFilledBy = await read(dst, 'filledBy', [id]);
  } catch (e) {
    err(`${id.slice(0,10)}: reading escrow state: ${e.shortMessage || e.message} — retried next pass`);
    seen.delete(id);
    return;
  }

  const decision = assess(intent, { loggedId, srcStatus, dstFilledBy },
                          { minFeeBps: MIN_FEE_BPS, marginSeconds: MARGIN_SECONDS });
  const e = decision.economics;
  log(`${id.slice(0,10)} ${CHAINS[srcChainId].name}->${CHAINS[dst].name} ` +
      `${e.amount} wei fee ${e.bps}bps` + (e.impliedApr !== null ? ` (~${e.impliedApr}% apr)` : ''));
  if (!decision.fill) {
    for (const r of decision.reasons) log(`    declined: ${r}`);
    return;
  }
  await tryFill(id, intent, srcChainId, dst);
}

async function tryFill(id, intent, srcChainId, dst) {
  const amount = BigInt(intent.amount);
  if (amount > MAX_FILL_WEI) {
    log(`    declined: ${amount} wei exceeds MAX_FILL_WEI ${MAX_FILL_WEI}`);
    return;
  }
  if (intent.dstToken.toLowerCase() !== NATIVE) {
    log('    declined: only native ETH fills are implemented here');
    return;
  }
  if (!LIVE) { log('    WOULD FILL (dry run — set RELAYER_KEY to act)'); return; }

  // Re-read immediately before spending. `assess` decided on state that is now
  // at least one RPC round trip old, and the gap between deciding and sending
  // is exactly where a cancel or a competing fill lands.
  if (STATUS[Number(await read(srcChainId, 'statusOf', [id]))] !== 'OPEN') {
    log('    aborted: escrow is no longer OPEN'); return;
  }
  if ((await read(dst, 'filledBy', [id])) !== NATIVE) {
    log('    aborted: someone filled it first'); return;
  }

  const bal = await pub[dst].getBalance({ address: account.address });
  if (bal < amount) { log(`    cannot fill: balance ${bal} < ${amount} on ${CHAINS[dst].name}`); return; }

  try {
    const hash = await wallet[dst].writeContract({
      address: RELAY, abi: ABI, functionName: 'fill', args: [asTuple(intent)], value: amount,
    });
    log(`    FILLED ${CHAINS[dst].name} ${hash}`);
    await pub[dst].waitForTransactionReceipt({ hash });
    filledHere.add(id);
  } catch (e) {
    err(`fill ${id.slice(0,10)}: ${e.shortMessage || e.message}`);
    return;
  }

  // The proof is what turns a fill into a claim on the escrow. Sent straight
  // away: it is the relayer's own money that is waiting on it.
  try {
    const hash = await wallet[dst].writeContract({
      address: RELAY, abi: ABI, functionName: 'proveFill', args: [asTuple(intent)],
    });
    log(`    PROOF SENT ${hash}`);
  } catch (e) {
    err(`proveFill ${id.slice(0,10)}: ${e.shortMessage || e.message} — retried next pass`);
  }
}

/** viem wants the tuple positionally typed; assess wants strings. */
const asTuple = (i) => ({
  sender: i.sender, recipient: i.recipient, srcToken: i.srcToken, dstToken: i.dstToken,
  amount: BigInt(i.amount), fee: BigInt(i.fee), delay: BigInt(i.delay),
  srcChainId: BigInt(i.srcChainId), dstChainId: BigInt(i.dstChainId),
  fillDeadline: BigInt(i.fillDeadline), nonce: BigInt(i.nonce),
});

/** Collect anything whose proof has landed. Re-read every pass, never cached. */
async function collect() {
  if (!LIVE) return;
  for (const id of [...filledHere]) {
    const intent = seen.get(id);
    const src = Number(intent.srcChainId);
    try {
      if (STATUS[Number(await read(src, 'statusOf', [id]))] !== 'OPEN') { filledHere.delete(id); continue; }
      const proven = await read(src, 'provenBy', [id]);
      if (proven.toLowerCase() !== account.address.toLowerCase()) continue;
      const hash = await wallet[src].writeContract({
        address: RELAY, abi: ABI, functionName: 'release', args: [asTuple(intent)],
      });
      log(`${id.slice(0,10)} RELEASED on ${CHAINS[src].name} ${hash}`);
      filledHere.delete(id);
    } catch (e) {
      err(`release ${id.slice(0,10)}: ${e.shortMessage || e.message}`);
    }
  }
}

// ─── run ───────────────────────────────────────────────────────────────────

log(LIVE ? `LIVE as ${account.address}` : 'DRY RUN — reads only, sends nothing');
log(`relay ${RELAY}  max fill ${MAX_FILL_WEI} wei  min fee ${MIN_FEE_BPS}bps  poll ${POLL_MS}ms`);
for (const [id, c] of Object.entries(CHAINS)) log(`  watching ${String(id).padEnd(5)} ${c.name.padEnd(10)} ${RPC[id]}`);

if (LIVE) {
  for (const id of Object.keys(CHAINS).map(Number)) {
    try { log(`  balance ${CHAINS[id].name}: ${await pub[id].getBalance({ address: account.address })} wei`); }
    catch (e) { err(`balance ${CHAINS[id].name}: ${e.shortMessage || e.message}`); }
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`${sig} — stopping`); stopping = true; });

while (!stopping) {
  for (const id of Object.keys(CHAINS).map(Number)) {
    try { await scan(id); } catch (e) { err(`${CHAINS[id].name}: ${e.shortMessage || e.message}`); }
  }
  try { await collect(); } catch (e) { err(`collect: ${e.shortMessage || e.message}`); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
