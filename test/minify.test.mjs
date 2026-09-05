/**
 * The deployed artifact is no longer the file the tests read, so something has
 * to hold the two together.
 *
 * `dapp/page.html` is the source: commented, reviewable, and what every other
 * suite exercises. `dapp/page.min.html` is what gets pinned, chunked and
 * deployed — 92,216 bytes smaller, which is four fewer chunks and about 30% of
 * the deployment. Losing identity between them is the price, and these are what
 * is bought back with it:
 *
 *   1. the artifact is CURRENT, so nobody deploys a build of an older page
 *   2. every literal the program depends on survives the strip
 *   3. and the whole page suite passes against the artifact, run separately
 *      by scripts/test.sh with PAGE=dapp/page.min.html
 *
 * The third is the real one. An argument that a minifier is behaviour-preserving
 * is worth less than six hundred assertions passing on its output.
 *
 *   node test/minify.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT} from '../scripts/lib.mjs';

let pass = 0;
const failures = [];
const ok = (c, m) => c ? pass++ : failures.push(`  ${m}`);

const SRC = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const OUT = path.join(ROOT, 'dapp/page.min.html');

// ── 1. current ─────────────────────────────────────────────────────────────
ok(fs.existsSync(OUT), 'the artifact exists — run node scripts/minify.mjs');
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/minify.mjs'), '--check'], {stdio: 'pipe'});
  pass++;
} catch {
  failures.push('  the artifact is stale — run node scripts/minify.mjs');
}

const MIN = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

// ── 2. it is smaller, and by enough to be worth the split ─────────────────
{
  const a = Buffer.byteLength(SRC), b = Buffer.byteLength(MIN);
  const chunks = (n) => Math.ceil(n / 24575);
  ok(b < a, 'the artifact is smaller than the source');
  ok(chunks(b) < chunks(a),
    `it saves at least one chunk (${chunks(a)} -> ${chunks(b)})`);
  console.log(`  ${a.toLocaleString()} B / ${chunks(a)} chunks` +
    `  ->  ${b.toLocaleString()} B / ${chunks(b)} chunks` +
    `   (${(100 * (a - b) / a).toFixed(1)}% off, ${chunks(a) - chunks(b)} chunks)`);
}

// ── 3. nothing the program runs on was stripped ───────────────────────────
// Comments are prose; a selector, an address or a URL is not. Addresses are
// counted only where they appear in CODE, because two of them appear in the
// source solely as documentation of a proxy's implementation.
{
  const codeOnly = (s) => s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const sets = [
    [/'0x[0-9a-f]{8}'/g, 'four-byte selectors'],
    [/0x[0-9a-fA-F]{40}/g, 'addresses in code'],
    [/https?:\/\/[^\s'"`)]+/g, 'urls'],
  ];
  for (const [re, name] of sets) {
    const a = new Set(codeOnly(SRC).match(re) || []);
    const b = new Set(codeOnly(MIN).match(re) || []);
    const missing = [...a].filter((x) => !b.has(x));
    ok(missing.length === 0,
      `every one of the ${a.size} ${name} survives` +
      (missing.length ? ` — lost ${missing.slice(0, 4).join(', ')}` : ''));
  }
}

// ── 4. and it is still one self-contained document ────────────────────────
{
  ok(/^<!doctype html>/i.test(MIN.trim()), 'the artifact is still a document');
  ok((MIN.match(/<script/g) || []).length === (SRC.match(/<script/g) || []).length,
    'the same number of script blocks');
  ok(!/\bsrc=["']http/.test(MIN), 'and pulls in nothing from the network');
  ok(MIN.includes('Wiring'),
    'the Wiring banner is preserved, so the page suite can cut the artifact too');
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
