/**
 * Three chains, one canonical address — the state that must not survive a switch.
 *
 * SLOW sits at the same address on every chain, which is exactly what makes
 * stale state dangerous: nothing about a leftover value LOOKS wrong after a
 * switch, because the address it was read from is the address you are now
 * pointed at. Guardian state, balances, token metadata, tip capability and a
 * transfer detail are all per-chain, and leaving any of them on screen leaves
 * live buttons acting on one chain against facts read from another.
 *
 * This dirties every field of the state object, switches chain, and asserts the
 * per-chain ones came back to their initial values. It runs offline.
 *
 *   node test/chainswitch.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cutAt = body.indexOf('   Wiring');
const logic = body.slice(body.indexOf('{') + 1, body.lastIndexOf('/*', cutAt));

// ─── DOM stub, with `el` populated ─────────────────────────────────────────
const noop = () => {};
const stubEl = () => ({
  textContent: '', className: '', innerHTML: '', value: '', hidden: false, disabled: false,
  style: {}, dataset: {}, title: '', children: [],
  classList: {add: noop, remove: noop, toggle: noop, contains: () => false},
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  appendChild(c) { this.children.push(c); return c; },
  append(...c) { this.children.push(...c); },
  replaceChildren(...c) { this.children = c; },
  addEventListener: noop, removeEventListener: noop, click: noop, focus: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0}),
});
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.matchMedia = () => ({matches: false, addEventListener: noop});
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
// Offline: every network read fails, which the page is expected to survive.
globalThis.fetch = () => Promise.reject(new Error('offline'));

const captured = {};
globalThis.__capture = captured;
new Function(`${logic}\n;Object.assign(globalThis.__capture,{
  S, el, cfg, CHAINS, CHAIN_IDS, MAINNET, SLOW, switchChain, renderList, renderGuard,
  buildTokenGrid, wardsKey, ZERO,
});`)();
const C = captured;

let pass = 0;
const failures = [];
const eq = (a, b, msg) => {
  const A = typeof a === 'object' && a !== null ? JSON.stringify(a, (k, v) => typeof v === 'bigint' ? String(v) : v) : a;
  const B = typeof b === 'object' && b !== null ? JSON.stringify(b, (k, v) => typeof v === 'bigint' ? String(v) : v) : b;
  if (A === B) pass++;
  else failures.push(`  ${msg}\n    got:    ${A}\n    expect: ${B}`);
};
const ok = (c, msg) => eq(!!c, true, msg);

// ─── The canonical address is the same on both ─────────────────────────────
// This is the premise. If it ever stops being true, per-chain state stops being
// the subtle problem and becomes an obvious one.
for (const id of C.CHAIN_IDS) {
  ok(!C.CHAINS[id].slow || C.CHAINS[id].slow === C.SLOW,
    `chain ${id} does not override the canonical SLOW address`);
}
ok(/^0x[0-9a-fA-F]{40}$/.test(C.SLOW), 'SLOW is one address for every chain');

// ─── Everything per-chain is cleared on a switch ───────────────────────────
// Anything read from a per-chain mapping, or scoped to a chain's deployment,
// belongs here. Names do not: ENS, WNS and GNS are read on mainnet whatever is
// active, so their cache is chain-independent by design.
const PER_CHAIN = [
  'meta', 'permitCache', 'gate', 'slowPermit', 'batchCap',
  'out', 'inb', 'hasGuardian', 'balance',
  'token', 'symbol', 'amount', 'step',
  'detail', 'lastHash',
];
// `guard` is checked field by field: its transient flags are expected to be
// true straight after a switch, because the switch starts the reload.
const GUARD_DATA = ['guardian', 'pending', 'wards', 'open'];
const NOT_PER_CHAIN = ['ens', 'theme', 'account', 'resolved', 'resolvedName', 'delay', 'delayDisplay'];

const clean = JSON.parse(JSON.stringify(C.S, (k, v) => typeof v === 'bigint' ? String(v) : v));

// Dirty every per-chain field with something a real session would have left.
Object.assign(C.S, {
  meta: {'0xabc': {symbol: 'X', decimals: 9, ok: true}},
  permitCache: {'0xabc:0xdef': {name: 'X', version: '1', nonce: 3n}},
  gate: '0x000000000000000000000000000000000000dEaD',
  slowPermit: true,
  batchCap: true,
  out: [{id: '1'}], inb: [{id: '2'}],
  hasGuardian: true,
  balance: 123n,
  token: '0xabc', symbol: 'X', amount: '1.5', step: 2,
  guard: {
    guardian: '0x000000000000000000000000000000000000bEEF',
    pending: {guardian: '0x00000000000000000000000000000000000000Ff', at: 999},
    wards: [{addr: '0xabc', mine: true, txs: []}],
    open: '0xabc', loading: true, scanning: true,
  },
  detail: {t: {id: '7'}, sym: 'X'},
  lastHash: '0x' + 'ab'.repeat(32),
});
// And dirty the ones that must SURVIVE, so the test proves the reset is
// targeted rather than a blanket wipe.
C.S.ens = {'vitalik.eth': '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'};
C.S.account = '0x000000000000000000000000000000000000dEaD';
C.S.theme = 'dark';
C.S.resolved = '0x000000000000000000000000000000000000dEaD';
C.S.resolvedName = 'someone.eth';
C.S.delay = 86400;
C.S.delayDisplay = '1 DAY';

C.S.chain = C.MAINNET;
C.S.view = 'guard';
C.switchChain(4663);

eq(C.S.chain, 4663, 'the switch took effect');
for (const f of PER_CHAIN) {
  const now = JSON.parse(JSON.stringify(C.S[f] ?? null, (k, v) => typeof v === 'bigint' ? String(v) : v));
  const was = clean[f] ?? null;
  eq(JSON.stringify(now), JSON.stringify(was), `S.${f} is cleared on a chain switch`);
}
for (const f of GUARD_DATA) {
  eq(JSON.stringify(C.S.guard[f] ?? null), JSON.stringify(clean.guard[f] ?? null),
    `S.guard.${f} is cleared on a chain switch`);
}
// And the pane must actually go and re-read, not just blank itself.
ok(C.S.guard.loading, 'switching chain while on the guard pane starts a reload');

for (const f of NOT_PER_CHAIN) {
  ok(C.S[f] !== null && C.S[f] !== undefined && JSON.stringify(C.S[f]) !== '{}',
    `S.${f} survives a chain switch — it is not per-chain`);
}
eq(C.S.ens['vitalik.eth'], '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  'the name cache survives: names are read on mainnet whatever is active');

// ─── And in every direction, not just the one ──────────────────────────────
// Three chains is six ordered pairs. A reset that only works leaving mainnet is
// not a reset.
for (const from of C.CHAIN_IDS) {
  for (const to of C.CHAIN_IDS) {
    if (from === to) continue;
    C.S.chain = from;
    C.S.guard = {guardian: '0x00000000000000000000000000000000000000Ff', pending: {guardian: '0x0', at: 1},
      wards: [{addr: '0xabc'}], open: '0xabc', loading: false, scanning: false};
    C.S.out = [{id: '9'}]; C.S.balance = 7n; C.S.token = '0xabc'; C.S.detail = {t: {id: '9'}};
    C.S.view = 'take';
    C.switchChain(to);
    eq(C.S.chain, to, `${from} -> ${to}: the switch took effect`);
    eq(C.S.guard.guardian, null, `${from} -> ${to}: guardian cleared`);
    eq(C.S.guard.wards.length, 0, `${from} -> ${to}: wards cleared`);
    eq(C.S.out.length, 0, `${from} -> ${to}: transfers cleared`);
    eq(C.S.balance, null, `${from} -> ${to}: balance cleared`);
    eq(C.S.token, null, `${from} -> ${to}: asset cleared`);
    eq(C.S.detail, null, `${from} -> ${to}: open detail cleared`);
  }
}

// ─── The ward list is keyed by chain and account ───────────────────────────
{
  C.S.chain = 1; C.S.account = '0x000000000000000000000000000000000000dEaD';
  const a = C.wardsKey();
  C.S.chain = 4663;
  const b = C.wardsKey();
  ok(a !== b, 'wards are stored per chain, so one chain cannot show the other');
  ok(a.includes('1') && b.includes('4663'), 'the key names its chain');
  // All three must be distinct, or one chain's wards would show on another.
  const keys = C.CHAIN_IDS.map((id) => { C.S.chain = id; return C.wardsKey(); });
  eq(new Set(keys).size, keys.length, 'every chain gets its own ward list');
}

// ─── Pending deployment degrades honestly ──────────────────────────────────
// SLOW is not on Robinhood Chain yet. An empty list there is not "you have no
// transfers", it is "there is no contract to ask", and the two must not look
// the same.
{
  C.S.chain = 4663;
  C.S.account = '0x000000000000000000000000000000000000dEaD';
  C.S.slowDeployed = {4663: false};
  C.S.out = []; C.S.inb = []; C.S.loading = false;
  C.el.list.replaceChildren();
  C.renderList();
  const text = JSON.stringify(C.el.list.children);
  ok(/not deployed/i.test(text), 'the transfer list says the contract is absent');
  ok(!/Nothing sent yet/i.test(text), 'it does not claim you simply have nothing');

  C.renderGuard();
  ok(/not deployed/i.test(C.el.gNotDeployed.textContent),
    'the guard pane says the contract is absent rather than "None set"');
  eq(C.el.gNotDeployed.hidden, false, 'and shows it');

  // With the contract present, the notice goes away.
  C.S.slowDeployed = {4663: true};
  C.renderGuard();
  eq(C.el.gNotDeployed.hidden, true, 'the notice is hidden once SLOW is deployed');
  C.el.list.replaceChildren();
  C.renderList();
  ok(/Nothing sent yet/i.test(JSON.stringify(C.el.list.children)),
    'and an empty list reads as empty again');
}

// ─── The grid follows the chain ────────────────────────────────────────────
for (const id of C.CHAIN_IDS) {
  C.S.chain = id;
  C.buildTokenGrid();
  eq(C.el.cryptoGrid.children.length, C.CHAINS[id].tokens.length,
    `chain ${id} renders exactly its own assets`);
  const syms = C.el.cryptoGrid.children.map((b) => b.dataset.symbol);
  eq(syms.join(','), C.CHAINS[id].tokens.map((t) => t.symbol).join(','),
    `chain ${id} renders them in order`);
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failing:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
