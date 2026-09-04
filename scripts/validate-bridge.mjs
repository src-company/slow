#!/usr/bin/env node
/**
 * Post-deploy validation for the bridge suite, against the live chains.
 *
 * WHAT IT IS FOR. Deploying is one transaction per chain; knowing the
 * deployment is correct is a different job, and the failures that matter here
 * are the quiet ones. An arrival wired to the wrong SLOW still answers calls. A
 * relay whose messenger set is empty on L1 accepts no proof and says nothing
 * until an escrow has been sitting for a week. A forward route pointed at the
 * wrong entrypoint is frozen forever and steals the first payload through it.
 * None of that shows up as a failed transaction.
 *
 * So this reads every invariant back off the chains themselves and prints a
 * table. It sends nothing and needs no key: safe to run against mainnet before,
 * during and after a deploy, and the honest answer before a deploy is a wall of
 * "not deployed", which is the point.
 *
 *   node scripts/validate-bridge.mjs
 *
 * WHAT IT CANNOT TELL YOU. That the bridges themselves work. Every check here
 * is a read; the two paths no test can reach — a real finalisation transaction
 * and `ArbSys` on a live Orbit chain — still need one dust round trip through a
 * burner. This narrows what that round trip has to prove, it does not replace
 * it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, ROOT } from './lib.mjs';

const CHAINS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com' },
  8453: { name: 'Base', rpc: 'https://base-rpc.publicnode.com' },
  4663: { name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
};

/**
 * WHAT THE DEPLOYMENT IS SUPPOSED TO CONTAIN — read out of the deploy script
 * rather than copied from it.
 *
 * The first version of this file hardcoded these addresses. That is the exact
 * failure this whole script exists to catch, committed by the checker itself:
 * change a constant in `DeployBridge.s.sol`, and a validator carrying the old
 * one reports a confident "ok" over a deployment wired somewhere else. A
 * checker that duplicates the thing it checks cannot see a change to it.
 *
 * So the expectations are parsed from the script's own source. If it stops
 * matching these shapes, this throws rather than falling back to a guess.
 */
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script/DeployBridge.s.sol'), 'utf8');

const constantIn = (name) => {
  const m = new RegExp(`constant\\s+${name}\\s*=\\s*(0x[0-9a-fA-F]{40}|[0-9_]+)`).exec(scriptSrc);
  if (!m) throw new Error(`DeployBridge.s.sol no longer defines ${name} — this validator is stale`);
  return m[1].includes('0x') ? m[1] : Number(m[1].replace(/_/g, ''));
};

/** The contracts that DELIVER a cross-chain message, which is not what sends one. */
const EXPECTED_MESSENGERS = {
  1: [
    ['Base L1CrossDomainMessenger', constantIn('BASE_L1_MESSENGER')],
    ['Robinhood Bridge', constantIn('ROBINHOOD_BRIDGE')],
  ],
  8453: [],
  4663: [],
};

/** Where a forward may push value on to. L1 only — an L2 has nowhere to go. */
const EXPECTED_ROUTES = {
  1: [
    [8453, 'Base OptimismPortal', constantIn('BASE_PORTAL'), 1],
    [4663, 'Robinhood Inbox', constantIn('ROBINHOOD_INBOX'), 2],
  ],
  8453: [],
  4663: [],
};

/** The portal SENDS; trusting it as a deliverer would be a mistake. */
const NOT_A_MESSENGER = constantIn('BASE_PORTAL');

const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).slice(0, 10);
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');

const rpc = async (chainId, method, params) => {
  const r = await fetch(CHAINS[chainId].rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

const codeSize = async (chainId, a) => ((await rpc(chainId, 'eth_getCode', [a, 'latest'])) || '0x').length / 2 - 1;
const call = (chainId, to, data) => rpc(chainId, 'eth_call', [{ to, data }, 'latest']);
const addrOf = (word) => '0x' + word.slice(-40);

// ─── checks ────────────────────────────────────────────────────────────────

const results = [];
const check = (chain, what, ok, detail) => results.push({ chain, what, ok, detail });

/** Selectors the page actually calls, so a look-alike at the address fails. */
const SLOW_REQUIRED = {
  depositTo: '0x94eeaec9',
  getOutboundTransfers: '0xd40d4bc6',
  getInboundTransfers: '0xe3993ee7',
  pendingTransfers: '0x6577b86a',
  guardians: '0x0633b14a',
};

async function validateChain(chainId, addrs) {
  const name = CHAINS[chainId].name;

  // ── SLOW: present, and the build the page drives rather than a look-alike.
  const slowCode = await rpc(chainId, 'eth_getCode', [addrs.slow, 'latest']).catch(() => '0x');
  const slowBytes = (slowCode || '0x').length / 2 - 1;
  if (slowBytes <= 0) {
    check(name, 'SLOW deployed', false, 'no code');
  } else {
    check(name, 'SLOW deployed', true, `${slowBytes.toLocaleString()} B`);
    const missing = Object.entries(SLOW_REQUIRED)
      .filter(([, s]) => !slowCode.includes(s.slice(2)))
      .map(([n]) => n);
    check(name, 'SLOW is the expected build', missing.length === 0,
      missing.length ? `missing ${missing.join(', ')}` : 'all called selectors present');
  }

  // ── SlowArrival: present, wired to THIS chain's SLOW, routes as intended.
  const arrBytes = await codeSize(chainId, addrs.arrival).catch(() => 0);
  if (arrBytes <= 0) {
    check(name, 'SlowArrival deployed', false, 'no code');
  } else {
    check(name, 'SlowArrival deployed', true, `${arrBytes.toLocaleString()} B`);
    try {
      const wired = addrOf(await call(chainId, addrs.arrival, sel('slow()')));
      check(name, 'SlowArrival wired to SLOW', wired.toLowerCase() === addrs.slow.toLowerCase(),
        wired.toLowerCase() === addrs.slow.toLowerCase() ? wired : `points at ${wired}`);
    } catch (e) { check(name, 'SlowArrival wired to SLOW', false, e.message.slice(0, 40)); }

    // Frozen at construction, so a wrong one is permanent and steals.
    for (const [dst, label, entry, kind] of EXPECTED_ROUTES[chainId]) {
      try {
        const ret = await call(chainId, addrs.arrival, sel('routeTo(uint256)') + pad(dst));
        const body = ret.slice(2);
        const gotEntry = '0x' + body.slice(24, 64);
        const gotKind = Number(BigInt('0x' + body.slice(64, 128)));
        const ok = gotEntry.toLowerCase() === entry.toLowerCase() && gotKind === kind;
        check(name, `forward route to ${dst} (${label})`, ok,
          ok ? `${entry} kind ${kind}` : `got ${gotEntry} kind ${gotKind}`);
      } catch (e) { check(name, `forward route to ${dst}`, false, e.message.slice(0, 40)); }
    }
    if (EXPECTED_ROUTES[chainId].length === 0) {
      try {
        const ret = await call(chainId, addrs.arrival, sel('routeTo(uint256)') + pad(1));
        const empty = /^0x0*$/.test(ret) || Number(BigInt('0x' + ret.slice(2, 66))) === 0;
        check(name, 'no forward routes (correct off L1)', empty, empty ? 'empty' : 'unexpected route set');
      } catch (e) { check(name, 'no forward routes', false, e.message.slice(0, 40)); }
    }
  }

  // ── SlowRelay: present, wired, and trusting exactly the right deliverers.
  const relBytes = await codeSize(chainId, addrs.relay).catch(() => 0);
  if (relBytes <= 0) {
    check(name, 'SlowRelay deployed', false, 'no code');
  } else {
    check(name, 'SlowRelay deployed', true, `${relBytes.toLocaleString()} B`);
    try {
      const wired = addrOf(await call(chainId, addrs.relay, sel('slow()')));
      check(name, 'SlowRelay wired to SLOW', wired.toLowerCase() === addrs.slow.toLowerCase(),
        wired.toLowerCase() === addrs.slow.toLowerCase() ? wired : `points at ${wired}`);
    } catch (e) { check(name, 'SlowRelay wired to SLOW', false, e.message.slice(0, 40)); }

    for (const [label, m] of EXPECTED_MESSENGERS[chainId]) {
      try {
        const ret = await call(chainId, addrs.relay, sel('trustedMessenger(address)') + pad(m));
        const trusted = BigInt(ret) === 1n;
        check(name, `trusts ${label}`, trusted, trusted ? m : 'NOT trusted — proofs will be refused');
      } catch (e) { check(name, `trusts ${label}`, false, e.message.slice(0, 40)); }
    }
    // The portal SENDS, it does not deliver: trusting it would be a mistake.
    if (chainId === 1) {
      try {
        const ret = await call(chainId, addrs.relay,
          sel('trustedMessenger(address)') + pad(NOT_A_MESSENGER));
        const trusted = BigInt(ret) === 1n;
        check(name, 'does NOT trust the portal', !trusted, trusted ? 'trusted in error' : 'correct');
      } catch { /* covered above */ }
    }
  }
}

// ─── run ───────────────────────────────────────────────────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const page = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');

const bridge = manifest.bridge?.contracts ?? {};
const addrs = {
  slow: manifest.protocol?.slow,
  arrival: bridge.SlowArrival?.address,
  relay: bridge.SlowRelay?.address,
};

console.log('SLOW bridge — post-deploy validation (reads only, sends nothing)\n');
console.log(`  SLOW         ${addrs.slow}`);
console.log(`  SlowArrival  ${addrs.arrival}`);
console.log(`  SlowRelay    ${addrs.relay}\n`);

// The page is immutable once chunked, so a drift here is unfixable later.
const pageSlow = /^const SLOW\s+=\s+'(0x[0-9a-fA-F]{40})'/m.exec(page)?.[1];
const pageArrival = /^const SLOW_ARRIVAL\s+=\s+'(0x[0-9a-fA-F]{40})'/m.exec(page)?.[1];
check('page', 'page names the manifest SLOW',
  pageSlow?.toLowerCase() === addrs.slow?.toLowerCase(), pageSlow ?? 'not found');
check('page', 'page names the manifest SlowArrival',
  pageArrival?.toLowerCase() === addrs.arrival?.toLowerCase(), pageArrival ?? 'not found');

for (const id of Object.keys(CHAINS)) {
  try {
    await validateChain(Number(id), addrs);
  } catch (e) {
    check(CHAINS[id].name, 'reachable', false, e.message.slice(0, 60));
  }
}

// Same address everywhere is a correctness requirement for the relay, not a nicety.
for (const [label, a] of [['SlowArrival', addrs.arrival], ['SlowRelay', addrs.relay]]) {
  const sizes = [];
  for (const id of Object.keys(CHAINS)) {
    sizes.push(await codeSize(Number(id), a).catch(() => -1));
  }
  const live = sizes.filter((s) => s > 0);
  check('all', `${label} identical on every chain where it exists`,
    live.length === 0 || new Set(live).size === 1,
    sizes.map((s, i) => `${Object.values(CHAINS)[i].name}:${s < 0 ? 'err' : s}`).join('  '));
}

const w = Math.max(...results.map((r) => r.what.length));
let failed = 0;
let chain = null;
for (const r of results) {
  if (r.chain !== chain) { chain = r.chain; console.log(`\n${chain}`); }
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.what.padEnd(w)}  ${r.detail ?? ''}`);
}

console.log(`\n${results.length - failed}/${results.length} checks passed.`);
if (failed) {
  console.log('\nA "no code" before deployment is expected. A wrong wiring after one is not:');
  console.log('routes and messenger sets are frozen at construction and cannot be corrected.');
}
console.log('\nStill unproven by any read: a real finalisation transaction, and ArbSys on a');
console.log('live Orbit chain. Both need one dust round trip through a burner.');
process.exitCode = failed ? 1 : 0;
