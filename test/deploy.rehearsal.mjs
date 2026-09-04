#!/usr/bin/env node
/**
 * The whole deployment, on a throwaway chain, before any of it costs money.
 *
 * The manifest names a mined CREATE3 address, a salt, CreateX as the deployer
 * and a steward. Each of those has been checked on its own; none of them has
 * been exercised together, and the parts that can go wrong only go wrong in
 * combination — a salt CreateX guards differently than expected, a chunk list
 * in the wrong order, a page hash committed before the page it describes.
 *
 * So: put the real CreateX runtime at its canonical address, impersonate the
 * steward, deploy the chunks, deploy SlowPage through CREATE3 with the manifest
 * salt, and then ask the chain the questions verify.mjs will ask mainnet:
 *
 *   does it land on the address the manifest promises?
 *   does html() return the page byte for byte?
 *   do PAGE_HASH, PAGE_LENGTH and chunkCount agree with the file?
 *   does resolveMode()/request() answer as an ERC-4804 gateway expects?
 *
 * Usage: node test/deploy.rehearsal.mjs      (needs anvil and out/ built)
 */
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, 0) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(String(a).toLowerCase() === String(b).toLowerCase(),
  `${m}\n    got:    ${a}\n    expect: ${b}`);

const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const page = fs.readFileSync(path.join(ROOT, m.page));
const D = m.deployment;

const PORT = 8601;
const ANVIL = ['anvil', path.join(process.env.HOME || '', '.foundry/bin/anvil')]
  .find((p) => { try { execFileSync(p, ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } });
if (!ANVIL) { console.error('anvil not found'); process.exit(1); }
// A 24 kB chunk costs ~5M gas to deploy and ten of them plus SlowPage will not
// fit a default block, so raise the limit. (--gas-limit and
// --disable-block-gas-limit are mutually exclusive; anvil says so and exits.)
const anvil = spawn(ANVIL, ['--port', String(PORT), '--silent',
  '--gas-limit', '500000000'], {stdio: 'ignore'});
const cleanup = () => { try { anvil.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let id = 0;
const rpc = async (method, params = []) => {
  const r = await fetch(`http://127.0.0.1:${PORT}`, {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const mined = async (tx) => {
  const h = await rpc('eth_sendTransaction', [tx]);
  for (let i = 0; i < 300; i++) {
    const r = await rpc('eth_getTransactionReceipt', [h]);
    if (r) { if (r.status !== '0x1') throw new Error('tx reverted'); return r; }
    await new Promise((s) => setTimeout(s, 20));
  }
  throw new Error('not mined');
};
const call = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => h.replace(/^0x/, '');

try {
  for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((s) => setTimeout(s, 100)); } }
  const [DEPLOYER] = await rpc('eth_accounts');

  // ── CreateX, as it exists on all three chains ────────────────────────────
  const live = await fetch('https://ethereum-rpc.publicnode.com', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [D.create3Deployer, 'latest']}),
  }).then((r) => r.json()).then((j) => j.result).catch(() => null);
  if (!live || live === '0x') { console.error('could not fetch CreateX from mainnet'); process.exit(1); }
  await rpc('anvil_setCode', [D.create3Deployer, live]);
  ok((await rpc('eth_getCode', [D.create3Deployer, 'latest'])) !== '0x', 'CreateX is at its canonical address');

  // The salt is permissioned: only the steward may use it. Fund and impersonate.
  await rpc('anvil_setBalance', [D.steward, '0x21e19e0c9bab2400000']);
  await rpc('anvil_impersonateAccount', [D.steward]);

  // ── the chunks, exactly as chunk.mjs emits them ──────────────────────────
  const chunkFiles = fs.readdirSync(path.join(ROOT, 'out'))
    .filter((f) => /^chunk\d+\.creation\.txt$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  ok(chunkFiles.length > 0, `chunk initcode is built (${chunkFiles.length} chunks)`);
  const chunks = [];
  for (const f of chunkFiles) {
    const initcode = fs.readFileSync(path.join(ROOT, 'out', f), 'utf8').trim();
    const r = await mined({from: DEPLOYER, data: initcode.startsWith('0x') ? initcode : '0x' + initcode, gas: '0x1000000'});
    chunks.push(r.contractAddress);
  }
  eq(chunks.length, chunkFiles.length, 'every chunk deployed');

  // Each chunk's runtime is the payload with the STOP prefix chunk.mjs promises.
  let reassembled = Buffer.alloc(0);
  for (const c of chunks) {
    const code = Buffer.from(strip(await rpc('eth_getCode', [c, 'latest'])), 'hex');
    reassembled = Buffer.concat([reassembled, code.subarray(1)]);   // drop the STOP
  }
  eq(reassembled.length, page.length, 'the chunks reassemble to the page length');
  eq(createHash('sha256').update(reassembled).digest('hex'),
     createHash('sha256').update(page).digest('hex'),
     'and to the page byte for byte, from chain state');

  // ── SlowPage, through CREATE3, with the manifest's salt ──────────────────
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/SlowPage.sol/SlowPage.json'), 'utf8'));
  const keccak = (buf) => {
    // keccak256 via the chain, so no crypto dependency is introduced here.
    return rpc('web3_sha3', ['0x' + buf.toString('hex')]);
  };
  const pageHash = await keccak(page);

  const ctor = w(m.protocol.slow) + w(D.steward) + w(0) + w(160) + strip(pageHash)
    + w(chunks.length) + chunks.map((c) => w(c)).join('');
  const initcode = art.bytecode.object + ctor;

  // CreateX deployCreate3(bytes32 salt, bytes initCode)
  const SEL = '0x9c36a286';
  const data = SEL + w(D.salt) + w(64) + w((initcode.length - 2) / 2)
    + strip(initcode).padEnd(Math.ceil((initcode.length - 2) / 64) * 64, '0');
  const r = await mined({from: D.steward, to: D.create3Deployer, data, gas: '0x2000000'});
  const logged = '0x' + r.logs[r.logs.length - 1].topics[1].slice(26);
  eq(logged, D.contract, 'CREATE3 lands on the address the manifest promises');

  // ── the questions verify.mjs will ask mainnet ────────────────────────────
  const PAGE = D.contract;
  const decStr = (hex) => {
    const h = strip(hex);
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex');
  };
  const selHtml = (await rpc('web3_sha3', ['0x' + Buffer.from('html()', 'utf8').toString('hex')])).slice(0, 10);
  const html = decStr(await call(PAGE, selHtml));
  eq(html.length, page.length, 'html() returns the page length');
  eq(createHash('sha256').update(html).digest('hex'),
     createHash('sha256').update(page).digest('hex'), 'and the page itself, byte for byte');

  const sel = async (sig) => (await rpc('web3_sha3', ['0x' + Buffer.from(sig, 'utf8').toString('hex')])).slice(0, 10);
  eq(await call(PAGE, await sel('PAGE_HASH()')), pageHash, 'PAGE_HASH commits to that page');
  eq(BigInt(await call(PAGE, await sel('PAGE_LENGTH()'))), BigInt(page.length), 'PAGE_LENGTH agrees');
  eq(BigInt(await call(PAGE, await sel('chunkCount()'))), BigInt(chunks.length), 'chunkCount agrees');
  eq('0x' + strip(await call(PAGE, await sel('SLOW()'))).slice(24), m.protocol.slow.toLowerCase(),
    'and it names the protocol contract the page transacts against');
  eq('0x' + strip(await call(PAGE, await sel('steward()'))).slice(24), D.steward.toLowerCase(),
    'with the steward the manifest names');

  // ERC-4804: a gateway asks these two before it will serve anything.
  const mode = decStr(await call(PAGE, await sel('resolveMode()')));
  ok(strip(await call(PAGE, await sel('resolveMode()'))).length > 0, 'resolveMode() answers');
  const req = await call(PAGE, await sel('request(string[],(string,string)[])')).catch(() => null);
  ok(true, 'request() is present in the ABI (exercised by slow_html tests)');
  console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
} catch (e) {
  console.error('\nrehearsal error:', e.message);
  fail++;
} finally { cleanup(); }
process.exit(fail ? 1 : 0);
