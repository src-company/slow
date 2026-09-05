#!/usr/bin/env node
/**
 * The whole deployment, on a throwaway chain, before any of it costs money.
 *
 * The manifest names a mined CREATE3 address, a salt, CreateX as the deployer
 * and a deployer. Each of those has been checked on its own; none of them has
 * been exercised together, and the parts that can go wrong only go wrong in
 * combination — a salt CreateX guards differently than expected, a chunk list
 * in the wrong order, a page hash committed before the page it describes.
 *
 * So: put the real CreateX runtime at its canonical address, impersonate the
 * deployer, deploy the chunks, deploy SlowPage through CREATE3 with the manifest
 * salt, and then ask the chain the questions verify.mjs will ask mainnet:
 *
 *   does it land on the address the manifest promises?
 *   does html() return the page byte for byte?
 *   do PAGE_HASH, PAGE_LENGTH and chunkCount agree with the file?
 *   does resolveMode()/request() answer as an ERC-4804 gateway expects?
 *
 * Usage: node test/deploy.rehearsal.mjs      (needs anvil and `forge build`)
 *
 * IT BUILDS ITS OWN CHUNKS, and that is not a convenience. This read them out
 * of `out/` and trusted whatever was there — so from the moment the page
 * changed and nobody re-ran `chunk.mjs`, it rehearsed a page that was never
 * going to be deployed and reported a hash mismatch as if the DEPLOYMENT were
 * wrong. It sat broken across two page changes for exactly that reason: `out/`
 * is gitignored build output with no freshness anyone was checking. A
 * rehearsal whose input can be stale is a rehearsal of the wrong thing, which
 * is the one failure this file exists to make impossible.
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

  // The salt is permissioned: only the DEPLOYER may use it. That is a different
  // key from the steward — the deployer sends the transaction and holds nothing
  // afterwards; the steward is a constructor argument and holds the lineage.
  await rpc('anvil_setBalance', [D.deployer, '0x21e19e0c9bab2400000']);
  await rpc('anvil_impersonateAccount', [D.deployer]);

  // ── the chunks, exactly as chunk.mjs emits them ──────────────────────────
  // Emitted HERE AND NOW rather than found. `chunk.mjs` reads the page through
  // `readPage`, which refuses to build when the manifest does not match it, so
  // running it is also the check that the pin and the page agree — before a
  // single chunk is deployed rather than after the reassembly disagrees.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/chunk.mjs')], {stdio: 'pipe'});
  const chunkFiles = fs.readdirSync(path.join(ROOT, 'out'))
    .filter((f) => /^chunk\d+\.creation\.txt$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  ok(chunkFiles.length > 0, `chunk initcode is built (${chunkFiles.length} chunks)`);
  const chunks = [];
  let chunkGas = 0n;
  for (const f of chunkFiles) {
    const initcode = fs.readFileSync(path.join(ROOT, 'out', f), 'utf8').trim();
    const r = await mined({from: DEPLOYER, data: initcode.startsWith('0x') ? initcode : '0x' + initcode, gas: '0x1000000'});
    chunks.push(r.contractAddress);
    chunkGas += BigInt(r.gasUsed);
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

  const ctor = w(m.protocol.slow) + w(D.initialSteward) + w(0) + w(160) + strip(pageHash)
    + w(chunks.length) + chunks.map((c) => w(c)).join('');
  const initcode = art.bytecode.object + ctor;

  // CreateX deployCreate3(bytes32 salt, bytes initCode)
  const SEL = '0x9c36a286';
  const data = SEL + w(D.salt) + w(64) + w((initcode.length - 2) / 2)
    + strip(initcode).padEnd(Math.ceil((initcode.length - 2) / 64) * 64, '0');
  const r = await mined({from: D.deployer, to: D.create3Deployer, data, gas: '0x2000000'});
  const logged = '0x' + r.logs[r.logs.length - 1].topics[1].slice(26);
  eq(logged, D.contract, 'CREATE3 lands on the address the manifest promises');

  // MEASURED, so the runbook never has to quote a number it guessed. The page
  // moves often and the wrapper's cost tracks the PAGE — it reassembles the
  // whole document in memory and hashes it — so a figure written down once is
  // wrong by the next edit. This one is produced by the run that proves the
  // deployment works, against the page that is actually pinned.
  const pageGas = BigInt(r.gasUsed);
  const total = chunkGas + pageGas;
  const at = (gwei) => Number(total) * gwei * 1e9 / 1e18;
  console.log(`\n  page deployment, measured on ${chunkFiles.length} chunks` +
    ` + the wrapper, for a ${page.length.toLocaleString()} B page:`);
  console.log(`    chunks   ${chunkGas.toLocaleString()} gas`);
  console.log(`    wrapper  ${pageGas.toLocaleString()} gas`);
  console.log(`    total    ${total.toLocaleString()} gas` +
    `   ~${at(0.1).toFixed(5)} ETH at 0.1 gwei` +
    `   ~${at(0.4).toFixed(5)} ETH at 0.4 gwei`);
  console.log('    (SLOW and the bridge pair are separate deploys, not counted here)\n');

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
  // THE POINT OF THE SPLIT: the page is deployed by one key and stewarded by
  // another, and the deployer must hold nothing when the transaction is done.
  eq('0x' + strip(await call(PAGE, await sel('steward()'))).slice(24), D.initialSteward.toLowerCase(),
    'stewardship lands with the steward, not the deployer');
  ok(D.initialSteward.toLowerCase() !== D.deployer.toLowerCase(),
    'and those are genuinely different keys');

  // ERC-4804 and ERC-5219: what a gateway asks before it will serve anything.
  //
  // `ok(true, 'request() is present in the ABI')` stood here, which passes
  // whatever the contract does — including not having the function. The two
  // hooks are the only way the page is reachable over the web, so they are
  // exercised rather than asserted about.
  const modeWord = strip(await call(PAGE, await sel('resolveMode()')));
  eq(Buffer.from(modeWord, 'hex').toString('utf8').replace(/\0+$/, ''), '5219',
    'resolveMode() is the ERC-5219 mode, so a gateway routes through request()');

  // request(string[] resource, KeyValue[] params) -> (uint16, string, KeyValue[])
  // Empty arrays for both: two head offsets, then two zero-length tails.
  const emptyArrays = w(64) + w(96) + w(0) + w(0);
  const res = strip(await call(PAGE, await sel('request(string[],(string,string)[])') + emptyArrays));
  eq(parseInt(res.slice(0, 64), 16), 200, 'request() answers 200');

  const bodyAt = parseInt(res.slice(64, 128), 16) * 2;
  const bodyLen = parseInt(res.slice(bodyAt, bodyAt + 64), 16);
  const bodyHex = res.slice(bodyAt + 64, bodyAt + 64 + bodyLen * 2);
  eq(bodyLen, page.length, 'and a body the length of the page');
  eq(createHash('sha256').update(Buffer.from(bodyHex, 'hex')).digest('hex'),
     createHash('sha256').update(page).digest('hex'),
     'which is the page itself, byte for byte');

  const headAt = parseInt(res.slice(128, 192), 16) * 2;
  const headCount = parseInt(res.slice(headAt, headAt + 64), 16);
  eq(headCount, 2, 'with two headers');
  const headerText = Buffer.from(res.slice(headAt), 'hex').toString('utf8');
  ok(headerText.includes('Content-Type') && headerText.includes('text/html'),
    'Content-Type: text/html, or a browser will not render it');
  ok(headerText.includes('Cache-Control') && headerText.includes('immutable'),
    'and an immutable cache hint, which the bytecode actually is');
  console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
} catch (e) {
  console.error('\nrehearsal error:', e.message);
  fail++;
} finally { cleanup(); }
process.exit(fail ? 1 : 0);
