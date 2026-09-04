#!/usr/bin/env node
/**
 * The page's own encoders, against a real EVM.
 *
 * Every other suite here checks the page against itself: its calldata builders
 * produce bytes, and assertions check those bytes look right. That proves the
 * encoder is self-consistent, not that a chain will accept what it makes. This
 * runs anvil, deploys the actual compiled SLOW, takes the calldata the PAGE
 * builds — pulled out of dapp/page.html, not reimplemented — sends it, and
 * asserts what the chain did afterwards.
 *
 * It is the difference between "the deposit encodes" and "the deposit lands".
 *
 * Usage: node test/e2e.live.mjs     (needs anvil on PATH)
 */
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, 0) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(a === b, `${m}\n    got:    ${a}\n    expect: ${b}`);

// ── the page's encoders, lifted from the file that ships ────────────────────
//
// Cut at the same "Wiring" banner test/page.test.mjs uses, with the same DOM
// stubs, so this exercises the code that ships rather than a copy of it.
const html = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cut = body.indexOf('   Wiring');
if (cut < 0) throw new Error('Wiring banner not found — did the page structure change?');
const logic = body.slice(body.indexOf('{') + 1, body.lastIndexOf('/*', cut));

const noop = () => {};
const stubEl = () => ({
  textContent: '', className: '', innerHTML: '', value: '', hidden: false, disabled: false,
  style: {}, dataset: {}, title: '',
  classList: {add: noop, remove: noop, toggle: noop, contains: () => false},
  setAttribute: noop, getAttribute: () => null, appendChild: noop, append: noop,
  replaceChildren: noop, addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [], focus: noop, click: noop,
  getBoundingClientRect: () => ({top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0}),
});
globalThis.localStorage = {getItem: () => null, setItem: noop, removeItem: noop};
globalThis.matchMedia = () => ({matches: false, addEventListener: noop});
globalThis.document = {body: stubEl(), hidden: false, activeElement: null,
  querySelector: () => null, querySelectorAll: () => [], createElement: stubEl, addEventListener: noop};
globalThis.window = globalThis;
globalThis.addEventListener = noop; globalThis.dispatchEvent = noop;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.innerWidth = 1024;
globalThis.location = {origin: 'https://slow.wei.limo', pathname: '/', hostname: 'slow.wei.limo', hash: ''};
const realFetch = globalThis.fetch;

const C = {};
globalThis.__capture = C;
const NAMES = ['SEL', 'cd', 'word', 'strip', 'encode', 'decode', 'parseUnits', 'formatUnits',
  'keccak256', 'decodeId', 'renderNFT', 'formatDelay', 'innerDepositCalldata', 'ZERO',
  'encAggregate3', 'decAggregate3', 'MC3'];
new Function(`${logic}\n;Object.assign(globalThis.__capture,{${NAMES.join(',')}});`)();
for (const n of NAMES) if (C[n] === undefined) { console.error(`missing encoder: ${n}`); process.exit(1); }

// ── anvil ───────────────────────────────────────────────────────────────────
const PORT = 8599;
// foundryup installs into ~/.foundry/bin, which is on an interactive PATH and
// not necessarily on this process's.
const ANVIL = ['anvil', path.join(process.env.HOME || '', '.foundry/bin/anvil')]
  .find((p) => { try { execFileSync(p, ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } });
if (!ANVIL) { console.error('anvil not found — install foundry (foundryup)'); process.exit(1); }
const anvil = spawn(ANVIL, ['--port', String(PORT), '--silent', '--accounts', '5'], {stdio: 'ignore'});
const RPC = `http://127.0.0.1:${PORT}`;
let id = 0;
const rpc = async (method, params = []) => {
  const r = await realFetch(RPC, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const mined = async (tx) => {
  const h = await rpc('eth_sendTransaction', [tx]);
  for (let i = 0; i < 200; i++) {
    const r = await rpc('eth_getTransactionReceipt', [h]);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 25));
  }
  throw new Error('not mined');
};
const call = (to, data) => rpc('eth_call', [{to, data}, 'latest']);
const hex = (v) => '0x' + v.toString(16);

const cleanup = () => { try { anvil.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

try {
  for (let i = 0; i < 60; i++) {
    try { await rpc('eth_chainId'); break; } catch { await new Promise((s) => setTimeout(s, 100)); }
  }
  const [ALICE, BOB, GUARD] = await rpc('eth_accounts');
  const art = (n, f) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${f || n + '.sol'}/${n}.json`), 'utf8'));

  // SLOW, exactly as compiled.
  const slowArt = art('SLOW');
  const dep = await mined({from: ALICE, data: slowArt.bytecode.object + C.word(0n) + C.word(0n)});
  const SLOW = dep.contractAddress;
  ok(!!SLOW, 'SLOW deploys');
  const code = await rpc('eth_getCode', [SLOW, 'latest']);
  const onChain = (code.length - 2) / 2;
  const artifactSize = (slowArt.deployedBytecode.object.length - 2) / 2;
  eq(onChain, artifactSize, 'deployed runtime is the size the artifact reports');
  ok(onChain <= 24576, `and fits EIP-170 with ${24576 - onChain} to spare`);

  console.log(`\n── SLOW at ${SLOW}`);

  // ═════ ETH deposit, with the calldata the page builds ═════
  {
    const delay = 3600;
    const data = C.innerDepositCalldata(BOB, delay);   // depositTo(ZERO, to, 0, delay, "")
    eq(data.slice(0, 10), C.SEL.depositTo, 'the page targets depositTo');
    const amount = C.parseUnits('1.5', 18);
    const r = await mined({from: ALICE, to: SLOW, data, value: hex(amount)});
    eq(r.status, '0x1', 'an ETH deposit built by the page lands on chain');

    // The chain agrees about who sent it and how much.
    const outs = await call(SLOW, C.cd(C.SEL.getOut, ['address'], [ALICE]));
    const ids = C.decode(['uint256[]'], outs)[0];
    eq(ids.length, 1, 'and appears in the sender’s outbound set');
    const pt = await call(SLOW, C.cd(C.SEL.pendingTransfers, ['uint256'], [ids[0]]));
    const [ts, from, to, tid, amt] = C.decode(['uint256', 'address', 'address', 'uint256', 'uint256'], pt);
    eq(from.toLowerCase(), ALICE.toLowerCase(), 'recorded against the sender, not a router');
    eq(to.toLowerCase(), BOB.toLowerCase(), 'to the recipient the page encoded');
    eq(amt, amount, 'for the amount the page parsed');
    const dec = C.decodeId(tid);
    eq(dec.delay, delay, 'and the id decodes to the delay the page chose');
    eq(dec.token.toLowerCase(), C.ZERO, 'with the zero address for ETH');
  }

  // ═════ The render the page previews is the render the chain draws ═════
  {
    const delay = 3600;
    const id = (BigInt(delay) << 160n).toString();
    const uri = await call(SLOW, C.cd('0x0e89341c', ['uint256'], [BigInt(id)]));
    const json = JSON.parse(Buffer.from(
      C.decode(['string'], uri)[0].split(',')[1], 'base64').toString('utf8'));
    const chain = Buffer.from(json.image.split(',')[1], 'base64').toString('utf8');
    const page = C.renderNFT(null, delay, 'ETH', 'Ether');
    eq(page, chain, 'the page’s preview is byte-identical to uri() from a live chain');
  }

  // ═════ Unlock and withdraw, end to end ═════
  {
    const delay = 60;
    const amount = C.parseUnits('0.25', 18);
    await mined({from: ALICE, to: SLOW, data: C.innerDepositCalldata(BOB, delay), value: hex(amount)});
    const outs = C.decode(['uint256[]'], await call(SLOW, C.cd(C.SEL.getOut, ['address'], [ALICE])))[0];
    const tid = outs[outs.length - 1];

    await rpc('evm_increaseTime', [delay + 5]);
    await rpc('evm_mine', []);

    const before = BigInt(await rpc('eth_getBalance', [BOB, 'latest']));
    const r = await mined({from: BOB, to: SLOW, data: C.cd(C.SEL.claim, ['uint256'], [tid])});
    eq(r.status, '0x1', 'the recipient can claim after the delay, with the page’s calldata');
    const after = BigInt(await rpc('eth_getBalance', [BOB, 'latest']));
    ok(after > before, 'and the ETH actually moved to them');
  }

  // ═════ Reverse, before the delay expires ═════
  {
    const amount = C.parseUnits('0.5', 18);
    await mined({from: ALICE, to: SLOW, data: C.innerDepositCalldata(BOB, 86400), value: hex(amount)});
    const outs = C.decode(['uint256[]'], await call(SLOW, C.cd(C.SEL.getOut, ['address'], [ALICE])))[0];
    const tid = outs[outs.length - 1];
    const r = await mined({from: ALICE, to: SLOW, data: C.cd(C.SEL.reverse, ['uint256'], [tid])});
    eq(r.status, '0x1', 'the sender can reverse before expiry');
    const pt = await call(SLOW, C.cd(C.SEL.pendingTransfers, ['uint256'], [tid]));
    eq(C.decode(['uint256', 'address', 'address', 'uint256', 'uint256'], pt)[0], 0n,
      'and the pending entry is gone');
  }

  // ═════ Guardian: the page’s approval id must match the chain’s ═════
  {
    const r = await mined({from: BOB, to: SLOW, data: C.cd(C.SEL.setGuardian, ['address'], [GUARD])});
    eq(r.status, '0x1', 'a guardian can be set with the page’s calldata');
    const g = await call(SLOW, C.cd(C.SEL.guardians, ['address'], [BOB]));
    eq('0x' + g.slice(-40).toLowerCase(), GUARD.toLowerCase(), 'and reads back');

    // A withdrawal the page would build, and the operation id it would show.
    const posId = (60n << 160n);
    const amount = 1n;
    const predicted = C.decode(['uint256'], await call(SLOW,
      C.cd(C.SEL.predictWithdrawalId, ['address', 'address', 'uint256', 'uint256'],
        [BOB, BOB, posId, amount])))[0];
    // isWithdrawalApprovalNeeded returns a BOOL, not an id — the flag and the
    // operation id are two different questions, and the page asks both, which
    // is what doWithdraw does. Asserting they are equal was my mistake, not the
    // contract's.
    const needed = C.decode(['uint256'], await call(SLOW,
      C.cd(C.SEL.isWithdrawalApprovalNeeded, ['address', 'address', 'uint256', 'uint256'],
        [BOB, BOB, posId, amount])))[0];
    eq(needed, 1n, 'a guarded withdrawal reports that approval is needed');
    ok(predicted !== 0n, 'and the page can derive the operation id to hand the guardian');

    // The guardian approves THAT id, and the flag flips. This is the loop the
    // Unlocked tab drives, end to end, against a real chain.
    const ap = await mined({from: GUARD, to: SLOW,
      data: C.cd(C.SEL.approveTransfer, ['address', 'uint256'], [BOB, predicted])});
    eq(ap.status, '0x1', 'the guardian can approve it');
    const after = C.decode(['uint256'], await call(SLOW,
      C.cd(C.SEL.isWithdrawalApprovalNeeded, ['address', 'address', 'uint256', 'uint256'],
        [BOB, BOB, posId, amount])))[0];
    eq(after, 0n, 'and the chain then says no approval is needed — the ids matched');
  }

  // ═════ An ERC-20 deposit, the way the page actually builds one ═════
  {
    const tok = art('MockERC20', 'SLOW.t.sol');
    // ABI-encode the constructor here rather than through the page: the page
    // never encodes a string and now refuses to, which is correct for it and
    // means test scaffolding has to do its own.
    const abiStr = (v) => {
      const b = Buffer.from(v, 'utf8').toString('hex');
      return C.word(BigInt(Buffer.byteLength(v))) + b.padEnd(Math.ceil(b.length / 64) * 64, '0');
    };
    const ctor = C.word(96n) + C.word(128n + BigInt(Math.ceil(Buffer.byteLength('Test Token') / 32) * 32)) +
      C.word(6n) + abiStr('Test Token') + abiStr('TEST');
    const t = (await mined({from: ALICE, data: tok.bytecode.object + ctor})).contractAddress;
    ok(!!t, 'a token deploys');
    const amount = C.parseUnits('250.5', 6);
    await mined({from: ALICE, to: t, data: C.cd('0x40c10f19', ['address', 'uint256'], [ALICE, amount * 4n])});

    // The exact allowance the page grants: the amount, not an infinity.
    await mined({from: ALICE, to: t, data: C.cd(C.SEL.approve, ['address', 'uint256'], [SLOW, amount])});
    const allow = C.decode(['uint256'], await call(t,
      C.cd(C.SEL.allowance, ['address', 'address'], [ALICE, SLOW])))[0];
    eq(allow, amount, 'the page approves the exact amount');

    const data = C.cd(C.SEL.depositTo, ['address', 'address', 'uint256', 'uint96', 'bytes'],
      [t, BOB, amount, 3600n, '0x']);
    const r = await mined({from: ALICE, to: SLOW, data});
    eq(r.status, '0x1', 'and the ERC-20 deposit lands');
    const bal = C.decode(['uint256'], await call(t, C.cd(C.SEL.balanceOf, ['address'], [SLOW])))[0];
    eq(bal, amount, 'the tokens are held by SLOW');
    eq(C.decode(['uint256'], await call(t, C.cd(C.SEL.allowance, ['address', 'address'], [ALICE, SLOW])))[0],
      0n, 'and the allowance is spent to zero, leaving nothing standing');

    // The decimals the page parsed are the decimals the render will show.
    const outs = C.decode(['uint256[]'], await call(SLOW, C.cd(C.SEL.getOut, ['address'], [ALICE])))[0];
    const tid = C.decode(['uint256', 'address', 'address', 'uint256', 'uint256'],
      await call(SLOW, C.cd(C.SEL.pendingTransfers, ['uint256'], [outs[outs.length - 1]])))[3];
    eq(C.decodeId(tid).token.toLowerCase(), t.toLowerCase(), 'the id carries the token address');
    eq(C.formatUnits(amount, 6), '250.5', 'and the amount round-trips through the page at 6 decimals');
  }

  // ═════ Unwrap and call: withdrawFrom to a third party, as exitRecipe builds it
  {
    const delay = 60;
    const amount = C.parseUnits('0.4', 18);
    await mined({from: ALICE, to: SLOW, data: C.innerDepositCalldata(ALICE, delay), value: hex(amount)});
    const outs = C.decode(['uint256[]'], await call(SLOW, C.cd(C.SEL.getOut, ['address'], [ALICE])))[0];
    const tid = outs[outs.length - 1];
    await rpc('evm_increaseTime', [delay + 5]); await rpc('evm_mine', []);
    // Unlock credits unlockedBalances; withdrawFrom then spends it, to anyone.
    await mined({from: ALICE, to: SLOW, data: C.cd(C.SEL.unlock, ['uint256'], [tid])});
    const pos = C.decode(['uint256', 'address', 'address', 'uint256', 'uint256'],
      await call(SLOW, C.cd(C.SEL.pendingTransfers, ['uint256'], [tid])));
    const posId = (BigInt(delay) << 160n);
    const unlocked = C.decode(['uint256'], await call(SLOW,
      C.cd(C.SEL.unlockedBalances, ['address', 'uint256'], [ALICE, posId])))[0];
    eq(unlocked, amount, 'unlock credits the unlocked balance the Unlocked tab reads');

    const before = BigInt(await rpc('eth_getBalance', [GUARD, 'latest']));
    const r = await mined({from: ALICE, to: SLOW,
      data: C.cd(C.SEL.withdrawFrom, ['address', 'address', 'uint256', 'uint256'],
        [ALICE, GUARD, posId, amount])});
    eq(r.status, '0x1', 'withdrawFrom to a third party succeeds — the exit recipe is real');
    eq(BigInt(await rpc('eth_getBalance', [GUARD, 'latest'])) - before, amount,
      'and the full amount lands at the destination, not the caller');
  }

  // ═════ The hand-rolled Multicall3 codec, against a real Multicall3 ═════
  try {
    // Every read in the page goes through encAggregate3/decAggregate3, both
    // written by hand. anvil ships Multicall3 at the canonical address on a
    // fresh chain; if it is not there, put the runtime there ourselves so the
    // codec is judged by the contract and not by our own decoder.
    let code = await rpc('eth_getCode', [C.MC3, 'latest']);
    if (code === '0x') {
      // Take the runtime from mainnet rather than compiling a copy: the point
      // is to be judged by the bytecode the page will actually talk to.
      const live = await realFetch('https://ethereum-rpc.publicnode.com', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [C.MC3, 'latest']}),
      }).then((r) => r.json()).then((j) => j.result).catch(() => null);
      if (!live || live === '0x') { console.log('  skip: could not fetch Multicall3 from mainnet'); throw {skip: true}; }
      await rpc('anvil_setCode', [C.MC3, live]);
      code = await rpc('eth_getCode', [C.MC3, 'latest']);
    }
    ok(code !== '0x', 'the real Multicall3 runtime is at the canonical address');

    const calls = [
      {to: SLOW, data: C.cd(C.SEL.guardians, ['address'], [BOB])},
      {to: SLOW, data: C.cd(C.SEL.getOut, ['address'], [ALICE])},
      {to: SLOW, data: C.cd(C.SEL.unlockedBalances, ['address', 'uint256'], [ALICE, 0n])},
      {to: SLOW, data: '0xdeadbeef'},                       // a call that must fail
    ];
    const enc = C.encAggregate3(calls);
    eq(enc.slice(0, 10), C.SEL.aggregate3, 'the batch calls aggregate3');
    const raw = await call(C.MC3, enc);
    const out = C.decAggregate3(raw);
    eq(out.length, calls.length, 'one result per call, from the real contract');

    // The answers have to match the same reads made individually.
    for (let i = 0; i < 3; i++) {
      const direct = await call(SLOW, calls[i].data);
      eq(out[i], direct, `batched read ${i} equals the direct read`);
    }
    eq(out[3], null, 'and a failing call comes back null, not as a thrown batch');
  } catch (e) { if (!e || !e.skip) throw e; }

  console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
} catch (e) {
  console.error('\nharness error:', e.message);
  fail++;
} finally {
  cleanup();
}
process.exit(fail ? 1 : 0);
