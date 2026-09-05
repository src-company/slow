/**
 * The manifest is the file that governs an irreversible deployment, and it was
 * wrong about which contract goes to the mined address.
 *
 * `deployment.source` read `src/SLOW.sol` while `chunks.artifact` read
 * `SlowPage` and the rehearsal deployed SlowPage there — a contradiction inside
 * one file, about a vanity address that can be used exactly once. Nothing
 * checked it, because the manifest is data and data does not compile.
 *
 * So these are the questions a reader would have to ask by hand, asked here:
 * does the manifest agree with itself, do the published addresses actually
 * derive from the salts beside them, and does the page still fit the chunks it
 * claims.
 *
 *   node test/manifest.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT, MAX_PAYLOAD, loadManifest} from '../scripts/lib.mjs';
import {createxAddress} from '../scripts/address.mjs';

let pass = 0;
const failures = [];
const ok = (c, m) => c ? pass++ : failures.push(`  ${m}`);
const eq = (a, b, m) => ok(String(a).toLowerCase() === String(b).toLowerCase(),
  `${m}\n    got:    ${a}\n    expect: ${b}`);

const m = loadManifest();

// ─── the contradiction that started this ───────────────────────────────────
{
  const base = path.basename(m.deployment.source, '.sol');
  eq(base, m.chunks.artifact,
    'deployment.source names the same contract as chunks.artifact');
  eq(m.deployment.artifact, m.chunks.artifact,
    'and deployment.artifact agrees too');
}

// ─── the addresses derive from the salts printed beside them ───────────────
// A published address nobody can reproduce is a route that never opens: the
// page probes for code, finds none, and reports a chain that is not ready.
{
  // THE DEPLOYER AND THE STEWARD ARE DIFFERENT KEYS, and conflating them is
  // how a deployment ends up owned by the wrong one. `deployer` prefixes the
  // salt and sends the transaction; `initialSteward` is passed to SlowPage's
  // constructor and is the only one that holds anything afterwards.
  const steward = m.deployment.deployer;
  eq(m.deployment.salt.slice(0, 42), steward,
    'the page salt is sender-prefixed to the deployer');
  ok(m.deployment.salt.slice(42, 44) === '00',
    'and byte 20 is clear, so block.chainid stays out of CreateX\'s guard');
  eq(createxAddress(m.deployment.salt, steward, 1), m.deployment.contract,
    'deployment.contract is what that salt actually derives');

  // The same address on all three chains is a correctness requirement, not a
  // nicety: SlowRelay.receiveRelay authenticates on origin == address(this).
  for (const id of m.deployment.chains) {
    eq(createxAddress(m.deployment.salt, steward, id), m.deployment.contract,
      `and the same on chain ${id}`);
  }
}

// ─── the protocol contract's own mined salt ───────────────────────────────
{
  const b = m.bridge;
  eq(b.slowSalt.slice(0, 42), b.deployer, 'the SLOW salt is sender-prefixed');
  ok(b.slowSalt.slice(42, 44) === '00', 'and chain-independent');
  eq(createxAddress(b.slowSalt, b.deployer, 1), b.slowAddress,
    'bridge.slowAddress is what the mined salt derives');
  eq(b.slowAddress.toLowerCase(), m.protocol.slow.toLowerCase(),
    'and it is the address the page transacts against');
  for (const id of b.chains) {
    eq(createxAddress(b.slowSalt, b.deployer, id), b.slowAddress,
      `SLOW is the same address on chain ${id}`);
  }
  // Four contracts, four salts, four distinct addresses. A counter collision
  // would put the second deploy on top of the first, after the first had
  // already spent the address.
  const all = [m.deployment.contract, b.slowAddress,
    ...Object.values(b.contracts).map((c) => c.address)].map((a) => a.toLowerCase());
  eq(new Set(all).size, all.length, 'all four addresses are distinct');
}

// ─── the bridge pair, same treatment ───────────────────────────────────────
{
  const b = m.bridge;
  for (const [name, c] of Object.entries(b.contracts)) {
    eq(c.salt.slice(0, 42), b.deployer, `${name}: salt is sender-prefixed`);
    ok(c.salt.slice(42, 44) === '00', `${name}: byte 20 is clear`);
    eq(createxAddress(c.salt, b.deployer, 1), c.address,
      `${name}: the published address is what the salt derives`);
    for (const id of b.chains) {
      eq(createxAddress(c.salt, b.deployer, id), c.address,
        `${name}: identical on chain ${id}`);
    }
  }
  // `run(slow, saltNonce)` derives the relay's salt as the arrival's + 1. If
  // the manifest ever disagrees the relay lands where nobody is looking.
  const arr = BigInt(b.contracts.SlowArrival.salt) & 0xffffffffffffffffn;
  const rel = BigInt(b.contracts.SlowRelay.salt) & 0xffffffffffffffffn;
  eq(rel, arr + 1n, 'the relay counter is the arrival counter plus one');
  eq(BigInt(b.saltNonce), arr, 'and bridge.saltNonce is the arrival counter');
}

// ─── the C miner derives what the JS derives ───────────────────────────────
// `scripts/mine.c` is a SECOND implementation of the derivation, in C, because
// the JS does ~1,400 addresses a second and cannot mine with. Its own header
// says to verify it before trusting a salt from it: "A miner with the wrong
// derivation mines an address the deployer can never reach" — and nobody would
// find out until a deploy landed somewhere the page does not name. So the two
// are checked against each other, on the salts whose answers are already
// published.
{
  let mine;
  try {
    mine = path.join(os.tmpdir(), `slow-mine-check-${process.pid}`);
    execFileSync('cc', ['-O3', '-pthread', '-o', mine,
      path.join(ROOT, 'scripts/mine.c')], {stdio: 'pipe'});
  } catch {
    mine = null;
    console.log('  (no C compiler — skipping the mine.c cross-check)');
  }
  if (mine) {
    const known = [
      ['SlowPage', m.deployment.salt, m.deployment.deployer, m.deployment.contract],
      ...Object.entries(m.bridge.contracts).map(([n, c]) =>
        [n, c.salt, m.bridge.deployer, c.address]),
    ];
    for (const [name, salt, sender, want] of known) {
      const out = execFileSync(mine, [sender, '--check', salt], {encoding: 'utf8'});
      const got = (out.match(/0x[0-9a-f]{40}/g) || []).pop();
      eq(got, want, `mine.c derives ${name} exactly as the manifest publishes it`);
    }
    fs.rmSync(mine, {force: true});
  }
}

// ─── the fork test measures the parameters that ship ──────────────────────
// `ArrivalForwardFork` exists to measure what a forward costs against the real
// Base portal and Robinhood inbox. It pinned 1,000,000 / 1 gwei while
// `DeployBridge` shipped 2,500,000 / 4 gwei, so it was measuring a
// configuration nobody deploys — and the OP branch's L1 cost is
// `depositTransaction`'s ResourceMetering burn, which scales with exactly the
// number that had drifted. Compared across the two sources, because a Solidity
// test can only compare a constant with itself.
{
  const grab = (file, name) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const m = src.match(new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*(gwei)?`));
    if (!m) return null;
    const n = BigInt(m[1].replace(/_/g, ''));
    return m[2] === 'gwei' ? n * 1000000000n : n;
  };
  const pairs = [
    ['FORWARD_GAS', 'FWD_GAS', 'destination gas limit'],
    ['FORWARD_MAX_FEE', 'FWD_FEE', 'fee ceiling'],
  ];
  for (const [shipName, forkName, label] of pairs) {
    const shipped = grab('script/DeployBridge.s.sol', shipName);
    const forked = grab('test/ArrivalForwardFork.t.sol', forkName);
    ok(shipped !== null && forked !== null, `both ${label} constants are readable`);
    eq(forked, shipped, `the fork test's ${label} is the one that ships`);
  }
}

// ─── the pin still describes the page, and the page still fits ─────────────
{
  const bytes = fs.readFileSync(path.join(ROOT, m.page));
  eq(bytes.length, m.bytes, 'manifest.bytes matches the page on disk');
  eq(createHash('sha256').update(bytes).digest('hex'), m.sha256,
    'manifest.sha256 matches it too — run node scripts/pin.mjs');

  const maxPayload = m.chunks?.maxPayload ?? MAX_PAYLOAD;
  const n = Math.ceil(bytes.length / maxPayload);
  const headroom = n * maxPayload - bytes.length;
  ok(headroom >= 0, 'the page fits the chunks it needs');
  console.log(`  page ${bytes.length.toLocaleString()} B` +
    ` -> ${n} chunks, headroom ${headroom.toLocaleString()} B` +
    ` (next chunk at ${(n * maxPayload + 1).toLocaleString()} B)`);
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
