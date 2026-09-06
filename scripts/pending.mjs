#!/usr/bin/env node
/**
 * What is still owed to the bridge, and whether it can be collected yet.
 *
 * Three things are in flight at any time on a system like this, each on its own
 * multi-day clock, each needing one more transaction from somebody. The failure
 * mode is not that they revert — it is that nobody remembers to send them. So
 * this is one command that answers "is there anything to do", and it is safe to
 * run as often as you like: it only reads.
 *
 *   node scripts/pending.mjs
 *
 * Items live in manifest.json under `bridge.proven.pending` and `relay-fill`,
 * so completing one is a manifest edit rather than a code change.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const m = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const proven = m.bridge?.proven ?? {};
const RELAY = m.bridge.contracts.SlowRelay.address;

const run = (script, arg, env = {}) => {
  try {
    return { ok: true, out: execFileSync('node', [path.join(ROOT, 'scripts', script), arg],
      { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
};

let ready = 0, waiting = 0, done = 0;
const report = (name, state, detail) => {
  const tag = { READY: 'READY   ', WAITING: 'waiting ', DONE: 'done    ' }[state];
  console.log(`${tag} ${name}`);
  for (const line of detail.filter(Boolean)) console.log(`         ${line}`);
  if (state === 'READY') ready++; else if (state === 'WAITING') waiting++; else done++;
};

// ── 1. the OP withdrawal out of Base ──────────────────────────────────────
const base = proven.pending?.['base-to-ethereum'];
if (base) {
  const r = run('opfinalize.mjs', base.initiatedTx,
    { PROOF_SUBMITTER: m.deployed.deployer, L2_RPC: 'https://mainnet.base.org' });
  const pick = (re) => (r.out.match(re) ?? [])[0];
  if (/Already finalised/.test(r.out)) report('Base -> Ethereum  finalise', 'DONE', ['already finalised']);
  else if (r.ok && /READY/.test(r.out))
    report('Base -> Ethereum  finalise', 'READY', ['node scripts/opfinalize.mjs ' + base.initiatedTx]);
  else report('Base -> Ethereum  finalise', 'WAITING',
    [pick(/proof maturity  :.*/), pick(/game resolution :.*/), pick(/NOT READY —.*/)]);
}

// ── 2. the Nitro message out of Robinhood ─────────────────────────────────
const rh = proven.pending?.['robinhood-to-ethereum'];
if (rh) {
  const r = run('arbexecute.mjs', rh.initiatedTx);
  if (/Already executed/.test(r.out)) report('Robinhood -> Ethereum  execute', 'DONE', ['already executed']);
  else if (r.ok && /READY/.test(r.out))
    report('Robinhood -> Ethereum  execute', 'READY', ['node scripts/arbexecute.mjs ' + rh.initiatedTx]);
  else report('Robinhood -> Ethereum  execute', 'WAITING',
    [(r.out.match(/NOT READY —[\s\S]*?\n/) ?? [''])[0].trim() || 'send root not confirmed yet']);
}

// ── 3. the relayer's escrow ───────────────────────────────────────────────
const fill = proven['relay-fill'];
if (fill) {
  const rpcUrl = 'https://mainnet.base.org';
  const call = async (to, data) => {
    const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
    return (await res.json()).result;
  };
  const { keccak256 } = await import('./lib.mjs');
  const sel = (s) => keccak256(Buffer.from(s, 'utf8')).slice(0, 10);
  const id = fill.intentId.replace(/^0x/, '');
  const status = Number(BigInt(await call(RELAY, sel('statusOf(bytes32)') + id)));
  const provenBy = '0x' + (await call(RELAY, sel('provenBy(bytes32)') + id)).slice(26);
  const STATUS = ['NONE', 'OPEN', 'RELEASED', 'CANCELLED'];
  if (status === 2) report('SlowRelay  release escrow', 'DONE', ['escrow released to the relayer']);
  else if (provenBy !== '0x' + '0'.repeat(40))
    report('SlowRelay  release escrow', 'READY',
      ['proof has landed; the Render relayer releases this automatically on its next pass',
       'provenBy ' + provenBy]);
  else report('SlowRelay  release escrow', 'WAITING',
    [`escrow is ${STATUS[status]}, provenBy still empty — the ArbSys proof needs ~6.4 days`]);
}

console.log(`\n${ready} ready, ${waiting} waiting, ${done} done`);
process.exit(ready ? 10 : 0);
