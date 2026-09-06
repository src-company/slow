#!/usr/bin/env node
/**
 * The admin console hard-codes selectors, addresses and runtime sizes, because
 * it is a single file with no build step and no dependency on an ABI it could
 * load at runtime. That is the right shape for a recovery tool — it has to work
 * from a USB stick years from now — but it means the constants can drift away
 * from the contracts silently, and the first symptom would be an admin action
 * that reverts, or worse, one that calls something other than what its button
 * says.
 *
 * So the constants are checked here against the compiled ABIs and the manifest.
 * A renamed function or a changed argument list fails this test rather than a
 * steward's transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, keccak256, loadManifest } from '../scripts/lib.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { cond ? pass++ : (fail++, console.error('  FAIL  ' + what)); };
const eq = (a, b, what) =>
  ok(String(a).toLowerCase() === String(b).toLowerCase(), what + '  (' + a + ' != ' + b + ')');

const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');

/** Pull one `const NAME = {...};` object literal out of the console's script. */
const literal = (name) => {
  const m = html.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*;'));
  if (!m) throw new Error('admin/index.html no longer defines ' + name);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*'?([^,'}\n]+)'?/g)) {
    out[k] = v.trim().replace(/'/g, '');
  }
  return out;
};
const scalar = (name) => html.match(new RegExp("const\\s+" + name + "\\s*=\\s*'([^']+)'"))[1];

const ADDR = literal('ADDR');
const SIZE = literal('SIZE');
const SEL = literal('SEL');

// ── 1. addresses and sizes agree with the manifest ────────────────────────
const m = loadManifest();
// The console uses short names; the manifest uses the contract names.
const NAME = {SLOW:'SLOW', Page:'SlowPage', Arrival:'SlowArrival',
              Relay:'SlowRelay', Lens:'SlowLens', Gate:'SLOWGate'};
ok(Object.keys(ADDR).length === Object.keys(NAME).length,
   'ADDR covers exactly the contracts this test maps');
for (const [k, addr] of Object.entries(ADDR)) {
  const full = NAME[k];
  ok(full !== undefined, 'ADDR.' + k + ' is a contract this test knows how to map');
  if (!full) continue;
  eq(addr, m.deployed.contracts[full], 'ADDR.' + k + ' matches manifest ' + full);
  eq(SIZE[k], String(m.deployed.runtimeBytes[full]),
     'SIZE.' + k + ' matches manifest runtimeBytes.' + full);
}

// ── 2. every selector is a real function on the contract it is called on ──
const utf8 = (s) => new TextEncoder().encode(s);
const sig = (s) => keccak256(utf8(s)).slice(0, 10);

/** Canonical signature of an ABI entry, expanding tuples the way solc does. */
const typeOf = (input) =>
  input.type.startsWith('tuple')
    ? '(' + input.components.map(typeOf).join(',') + ')' + input.type.slice(5)
    : input.type;
const abiOf = (file, name) => {
  const p = path.join(ROOT, 'out', file, name + '.json');
  if (!fs.existsSync(p)) throw new Error('missing artifact ' + p + ' — run `forge build` first');
  return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
};
const selectorsOf = (file, name) => {
  const out = new Map();
  for (const e of abiOf(file, name)) {
    if (e.type !== 'function') continue;
    const s = e.name + '(' + e.inputs.map(typeOf).join(',') + ')';
    out.set(sig(s), s);
  }
  return out;
};

const OWNER = {
  steward: 'Page', pendingSteward: 'Page', successor: 'Page', succeededAt: 'Page',
  generation: 'Page', transferStewardship: 'Page', acceptStewardship: 'Page',
  renounceStewardship: 'Page',
  page: 'SLOW', pendingTransfers: 'SLOW',
  slow: 'Arrival', rescue: 'Arrival', originOf: 'Arrival', claimRescue: 'Arrival',
  reverse: 'Arrival', clawback: 'Arrival',
  statusOf: 'Relay', filledBy: 'Relay', provenBy: 'Relay', intentId: 'Relay',
  fill: 'Relay', proveFill: 'Relay', release: 'Relay', cancel: 'Relay', open: 'Relay',
};
const TABLE = {
  Page: selectorsOf('SlowPage.sol', 'SlowPage'),
  SLOW: selectorsOf('SLOW.sol', 'SLOW'),
  Arrival: selectorsOf('SlowArrival.sol', 'SlowArrival'),
  Relay: selectorsOf('SlowRelay.sol', 'SlowRelay'),
};

for (const [name, selector] of Object.entries(SEL)) {
  const owner = OWNER[name];
  ok(owner !== undefined, 'SEL.' + name + ' is assigned to a contract by this test');
  if (!owner) continue;
  const found = TABLE[owner].get(selector);
  ok(found !== undefined,
     'SEL.' + name + ' (' + selector + ') is a real function on ' + owner);
  if (found) {
    ok(found.startsWith(name + '('),
       'SEL.' + name + ' resolves to ' + found + ', which is a DIFFERENT function');
  }
}

// ── 3. the console does not reach for anything with an owner ─────────────
// SLOW has no admin. If a future edit wires an owner-ish call into this page,
// that is a design change and should be a deliberate one.
for (const banned of ['selfdestruct', 'delegatecall', 'transferOwnership', 'upgradeTo']) {
  ok(!html.includes(banned), 'admin console does not reference ' + banned);
}

// ── 4. the steward it expects is the one actually recorded ───────────────
const stewardInPage = scalar('EXPECTED_STEWARD');
ok(/^0x[0-9a-fA-F]{40}$/.test(stewardInPage), 'EXPECTED_STEWARD is a well-formed address');
if (m.deployed.steward) eq(stewardInPage, m.deployed.steward, 'EXPECTED_STEWARD matches manifest');

console.log(`admin console: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
