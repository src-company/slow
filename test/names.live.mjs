/**
 * Name resolution against mainnet, and what it costs.
 *
 * Three registries now answer for a pasted address — WNS (.wei), GNS (.gwei)
 * and ENS (.eth) — and every one of them needs a forward check before its
 * reverse record can be trusted. Done one at a time that is up to eight
 * sequential round trips; batched it is two. This measures it rather than
 * asserting it, by counting the JSON-RPC requests the page actually makes.
 *
 *   node test/names.live.mjs
 *
 * Needs network. All reads are pinned to mainnet by the page itself, which is
 * the property under test: names resolve the same whichever chain is active.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cutAt = body.indexOf('   Wiring');
const logic = body.slice(body.indexOf('{') + 1, body.lastIndexOf('/*', cutAt));

// ─── DOM stub ──────────────────────────────────────────────────────────────
const noop = () => {};
const stubEl = () => ({
  textContent: '', className: '', style: {}, dataset: {}, hidden: false, disabled: false,
  classList: {add: noop, remove: noop, toggle: noop, contains: () => false},
  setAttribute: noop, appendChild: noop, append: noop, replaceChildren: noop,
  addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], focus: noop,
  getBoundingClientRect: () => ({top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0}),
});
globalThis.localStorage = {getItem: () => null, setItem: noop, removeItem: noop};
globalThis.matchMedia = () => ({matches: false, addEventListener: noop});
// The page paints a status dot on every RPC result, so `el` has to be populated
// or nodeRead throws inside its own try and reports each endpoint as unreachable
// — which looks exactly like the network being down.
const IDS = [...html.matchAll(/\bid="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const nodes = IDS.map((id) => Object.assign(stubEl(), {id}));
globalThis.document = {
  body: stubEl(), hidden: false, activeElement: null,
  querySelector: () => null,
  querySelectorAll: (sel) => (sel === '[id]' ? nodes : []),
  createElement: stubEl, addEventListener: noop,
};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.dispatchEvent = noop;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.innerWidth = 1024;
globalThis.location = {origin: 'https://x', pathname: '/', hostname: 'x', hash: ''};

// Count every JSON-RPC request the page makes, and note which chain it went to.
const realFetch = globalThis.fetch;
let calls = 0;
const hosts = new Set();
globalThis.fetch = (url, opts) => {
  calls++;
  hosts.add(new URL(url).host);
  return realFetch(url, opts);
};

const captured = {};
globalThis.__capture = captured;
new Function(`${logic}\n;Object.assign(globalThis.__capture,{
  resolveName, reverseAny, ensResolve, wnsResolve, gnsResolve, tldOf,
  namehash, WNS, GNS, ENS_REG, S, MAINNET, CHAINS,
});`)();
const C = captured;

let pass = 0;
const failures = [];
const eq = (a, b, msg) => {
  if (a === b) pass++;
  else failures.push(`  ${msg}\n    got:    ${a}\n    expect: ${b}`);
};
const ok = (c, msg) => eq(!!c, true, msg);

const measure = async (label, fn) => {
  calls = 0;
  const t0 = Date.now();
  const out = await fn();
  return {out, calls, ms: Date.now() - t0, label};
};

console.log('\n── Forward resolution ──');
for (const [name, tld] of [['luca.gwei', 'gwei'], ['vitalik.gwei', 'gwei'], ['z0r0z.eth', 'eth']]) {
  eq(C.tldOf(name), tld, `tldOf("${name}")`);
  const r = await measure(name, () => C.resolveName(name));
  const addr = r.out;
  console.log(`  ${name.padEnd(15)} -> ${addr || '(none)'}   ${r.calls} call${r.calls === 1 ? '' : 's'}, ${r.ms}ms`);
  if (tld === 'gwei') {
    ok(addr && /^0x[0-9a-f]{40}$/i.test(addr), `${name} resolves through GNS`);
    // A flat registry answers in one call; anything more means it went the
    // ENS route, which would be the wrong registry.
    eq(r.calls, 1, `${name} costs exactly one call`);
  }
}

// The dispatch must not confuse the two: ".gwei" does not end with ".wei", but
// that is a property of the characters, not something to rely on by accident.
eq(C.tldOf('a.wei'), 'wei', 'a .wei name');
eq(C.tldOf('a.gwei'), 'gwei', 'a .gwei name is not a .wei name');
eq(C.tldOf('plain'), '', 'a bare label has no TLD');
eq(await C.resolveName('nothing-here'), null, 'a bare label resolves to nothing');

console.log('\n── Reverse resolution (three registries, one address) ──');
{
  // A .gwei name whose forward record points back, so the verification passes.
  const luca = await C.resolveName('luca.gwei');
  const r = await measure('reverse', () => C.reverseAny(luca));
  console.log(`  ${luca} -> ${r.out || '(none)'}   ${r.calls} calls, ${r.ms}ms`);
  eq(r.out, 'luca.gwei', 'reverse finds the .gwei primary name');
  // Two multicalls: ask all three registries, then verify all three answers.
  // Unbatched this is six to eight sequential round trips.
  ok(r.calls <= 3, `reverse costs ${r.calls} calls, not one per registry`);
}
{
  // An address with no primary name anywhere still stops after the two rounds.
  const r = await measure('miss', () => C.reverseAny('0x000000000000000000000000000000000000dEaD'));
  console.log(`  0x0000…dEaD -> ${r.out || '(none)'}   ${r.calls} calls, ${r.ms}ms`);
  eq(r.out, null, 'an address with no name resolves to nothing');
  ok(r.calls <= 2, `a miss costs ${r.calls} calls`);
}

console.log('\n── Pinned to mainnet from either chain ──');
{
  // The registries live only on chain 1. Switching the active chain must not
  // move where a name is read from, or a .eth name would stop existing.
  C.S.chain = 4663;
  calls = 0; hosts.clear();
  const addr = await C.resolveName('luca.gwei');
  const rhHost = new URL(C.CHAINS[4663].rpcs[0]).host;
  console.log(`  active chain 4663, endpoints used: ${[...hosts].join(', ')}`);
  ok(addr && /^0x/.test(addr), 'a .gwei name still resolves with Robinhood active');
  ok(!hosts.has(rhHost), 'no name read went to the Robinhood endpoint');
  C.S.chain = C.MAINNET;
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failing:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
