#!/usr/bin/env node
/**
 * Watch the live deployment for the things a test cannot cover.
 *
 * The suite proves properties of the code. This asks whether the chain still
 * agrees with what was audited, and whether anything is happening on the parts
 * that are deployed but deliberately not wired up.
 *
 * Four questions, one `eth_call` each per chain:
 *
 *   1. Is the code still the code? Sizes are pinned from `manifest.json`. A
 *      mismatch means the address is not what this repo describes — which
 *      should be impossible, and is exactly why it is worth asserting.
 *   2. Does SLOW still point at the page, and both bridge contracts at SLOW?
 *      These are immutables; a change means the wrong address is being read.
 *   3. Is stewardship still where it was left? It is the only privileged role
 *      in the system and it can move in two steps.
 *   4. HAS ANYBODY USED THE RELAY? `SlowRelay` has no UI and no relayer, so any
 *      escrow opened on it is unexpected by definition — and it carries the
 *      known open issues around same-address assumptions. This is the one that
 *      should page someone.
 *
 *   node scripts/watch.mjs
 */
import {loadManifest} from './lib.mjs';

const m = loadManifest();
const D = m.deployed;
const RPC = {
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  4663: 'https://rpc.mainnet.chain.robinhood.com',
};

let bad = 0;
const ok = (c, label, detail = '') =>
  console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)}${detail}`) || (c ? 0 : bad++);

const call = async (chainId, method, params) => {
  const r = await fetch(RPC[chainId], {
    method: 'POST',
    headers: {'content-type': 'application/json', 'user-agent': 'curl/8'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const read = (chainId, to, data) => call(chainId, 'eth_call', [{to, data}, 'latest']);
const addrOf = (w) => '0x' + (w || '').slice(-40);

for (const chainId of D.chains ?? [1, 8453, 4663]) {
  console.log(`\nchain ${chainId}`);
  const C = D.contracts;
  try {
    // 1. the code is the code
    for (const [name, addr] of Object.entries(C)) {
      const size = ((await call(chainId, 'eth_getCode', [addr, 'latest'])).length - 2) / 2;
      ok(size === D.runtimeBytes[name], `${name} runtime unchanged`, `${size.toLocaleString()} B`);
    }
    // 2. the wiring
    ok(addrOf(await read(chainId, C.SLOW, '0x0df813b9')).toLowerCase() === C.SlowPage.toLowerCase(),
      'SLOW still points at SlowPage');
    for (const n of ['SlowArrival', 'SlowRelay']) {
      ok(addrOf(await read(chainId, C[n], '0xb00d4d70')).toLowerCase() === C.SLOW.toLowerCase(),
        `${n} still points at SLOW`);
    }
    // 3. the only privileged role
    const steward = addrOf(await read(chainId, C.SlowPage, '0x637eea19'));
    ok(steward.toLowerCase() === D.steward.toLowerCase(), 'stewardship unchanged', steward);
    const pending = addrOf(await read(chainId, C.SlowPage, '0x5f46c59d'));
    ok(/^0x0+$/.test(pending), 'no stewardship handover pending');
    // 4. the part nothing is supposed to be using
    const bal = BigInt(await call(chainId, 'eth_getBalance', [C.SlowRelay, 'latest']));
    ok(bal === 0n, 'SlowRelay holds no ETH', bal === 0n ? '' : `${bal} wei — INVESTIGATE`);
  } catch (e) {
    console.log(`  FAIL  chain ${chainId} unreachable: ${e.message}`);
    bad++;
  }
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
