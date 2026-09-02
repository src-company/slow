#!/usr/bin/env node
/**
 * Verify the deployment against the chain — not against another file in the repo.
 *
 * A deployment cannot change, so this never complains when the repo drifts away
 * from it. This is what notices.
 *
 *   1. the page is what the manifest pins
 *   2. every chunk rebuilt from that page is byte-identical to the runtime code
 *      at its deployed address
 *   3. html() on the wrapper returns exactly that page
 *   4. the wrapper's own commitments (PAGE_HASH, PAGE_LENGTH, chunkCount) agree
 *   5. resolveMode() and request() answer as ERC-4804 gateways expect
 *   6. every published route serves exactly that page
 *
 * Usage: node scripts/verify.mjs
 *        ETH_RPC_URL=https://… node scripts/verify.mjs
 */
import {loadManifest, readPage, split, keccak256, rpc, MAX_PAYLOAD, HTML_SELECTOR, RESOLVE_MODE_SELECTOR, decodeString} from './lib.mjs';

const m = loadManifest();
const d = m.deployment || {};

let checks = 0, bad = 0;
const ok = (cond, label, detail) => {
  checks++;
  if (cond) console.log(`  ok    ${label}`);
  else { bad++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
};
const call = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
const sel = (sig) => keccak256(new TextEncoder().encode(sig)).slice(0, 10);
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);

// ─── 1. the page is what the manifest pins ────────────────────────────────
const {bytes, sha256} = readPage(m);
const pageHash = keccak256(bytes);
const parts = split(bytes, m.chunks?.maxPayload ?? MAX_PAYLOAD);

console.log(`\n${m.name}: ${bytes.length.toLocaleString()} B, ${parts.length} chunk(s)`);
console.log(`  sha256    ${sha256}`);
console.log(`  keccak256 ${pageHash}\n`);

if (!d.contract) {
  console.log('No deployment recorded in manifest.json — local checks only.\n');
  ok(true, 'page matches the manifest pin');
  ok(Buffer.concat(parts.map((p) => p.payload)).equals(bytes), 'chunks reassemble to the page');
  ok(parts.every((p) => p.runtime[0] === 0x00), 'every chunk runtime is STOP-prefixed');
  ok(new Set(parts.map((p) => p.runtime.toString('hex'))).size === parts.length, 'no two chunks are identical');
  console.log(`\n${checks - bad}/${checks} local checks passed. Deploy, then record the`);
  console.log('addresses in manifest.json and run this again against mainnet.\n');
  process.exit(bad ? 1 : 0);
}

console.log(`Verifying ${d.contract} on chain ${d.chainId}…\n`);

// ─── 2. chunk runtimes ────────────────────────────────────────────────────
const listed = d.chunkContracts || [];
ok(listed.length === parts.length, `chunk count: ${listed.length} deployed, ${parts.length} built`);
for (let i = 0; i < Math.min(listed.length, parts.length); i++) {
  const code = await rpc('eth_getCode', [listed[i], 'latest']);
  const want = '0x' + parts[i].runtime.toString('hex');
  ok(code.toLowerCase() === want.toLowerCase(),
    `chunk ${i + 1} runtime at ${listed[i]} (${parts[i].runtime.length.toLocaleString()} B)`,
    code.length !== want.length ? `deployed ${(code.length - 2) / 2} B, built ${(want.length - 2) / 2} B` : 'bytes differ');
}

// ─── 3. html() ────────────────────────────────────────────────────────────
const served = decodeString(await call(d.contract, HTML_SELECTOR));
ok(served.length === bytes.length, `html() returns ${served.length.toLocaleString()} B`,
  `expected ${bytes.length.toLocaleString()} B`);
ok(served.equals(bytes), 'html() is byte-identical to the repo page');

// ─── 4. the wrapper's own commitments ─────────────────────────────────────
const onchainHash = await call(d.contract, sel('PAGE_HASH()'));
ok(onchainHash.toLowerCase() === pageHash.toLowerCase(), 'PAGE_HASH matches keccak256(page)');
const onchainLen = BigInt(await call(d.contract, sel('PAGE_LENGTH()')));
ok(onchainLen === BigInt(bytes.length), `PAGE_LENGTH is ${onchainLen}`);
const count = BigInt(await call(d.contract, sel('chunkCount()')));
ok(count === BigInt(parts.length), `chunkCount() is ${count}`);
const slowAddr = '0x' + word(await call(d.contract, sel('SLOW()')), 0).slice(24);
ok(slowAddr.toLowerCase() === (m.protocol?.slow || '').toLowerCase(),
  `SLOW() names ${slowAddr}`, `manifest says ${m.protocol?.slow}`);

// ─── 5. ERC-4804 / ERC-5219 surface ───────────────────────────────────────
const mode = await call(d.contract, RESOLVE_MODE_SELECTOR);
ok(Buffer.from(word(mode, 0), 'hex').toString().replace(/\0+$/, '') === '5219', 'resolveMode() is "5219"');
// request(string[], (string,string)[]) with both arrays empty
const emptyReq = sel('request(string[],(string,string)[])')
  + (64).toString(16).padStart(64, '0') + (96).toString(16).padStart(64, '0')
  + '0'.repeat(64) + '0'.repeat(64);
const reqRet = await call(d.contract, emptyReq);
ok(BigInt('0x' + word(reqRet, 0)) === 200n, 'request() answers 200');
ok(reqRet.includes(Buffer.from('text/html').toString('hex')), 'request() sets Content-Type: text/html');
ok(reqRet.includes(Buffer.from('immutable').toString('hex')), 'request() sets an immutable Cache-Control');

// ─── 6. routes ────────────────────────────────────────────────────────────
for (const r of d.routes || []) {
  if (r.serves !== 'exact') { console.log(`  skip  ${r.url} (declared "${r.serves}")`); continue; }
  try {
    const res = await fetch(r.url);
    const body = Buffer.from(await res.arrayBuffer());
    ok(body.equals(bytes), `${r.kind} route ${r.url}`,
      `served ${body.length.toLocaleString()} B, page is ${bytes.length.toLocaleString()} B`);
  } catch (e) {
    ok(false, `${r.kind} route ${r.url}`, e.message);
  }
}

console.log(bad ? `\n${bad} of ${checks} checks FAILED\n` : `\nverified — ${checks} checks passed\n`);
process.exit(bad ? 1 : 0);
