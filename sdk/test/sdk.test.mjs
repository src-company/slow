// sdk.test.mjs — zero-dependency tests for the SLOW SDK core.
// Run: node sdk/test/sdk.test.mjs   (vanilla Node, matches repo's test style)

import assert from 'node:assert/strict';
import {
  keccak256, selector, encode, decode, encodeId, decodeId, parseUnits, formatUnits,
} from '../src/index.js';
import { SEL, SLOW_ADDRESS, ETH, errorName, ENS_REGISTRY, WNS_REGISTRY, NAME_SEL, TOKENS } from '../src/abi.js';
import { SlowClient } from '../src/client.js';
import { namehash, resolveName, isName } from '../src/names.js';
import * as keeper from '../src/keeper.js';

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ok  ' + name); pass++; };

// --- codec ---------------------------------------------------------------
ok('keccak256("") known vector',
  keccak256('') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
ok('keccak256("abc") known vector',
  keccak256('abc') === '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');

// --- selectors match the deployed dapp's SEL map ---
const KNOWN = {
  depositTo: 'depositTo(address,address,uint256,uint96,bytes)',
  reverse: 'reverse(uint256)',
  claim: 'claim(uint256)',
  clawback: 'clawback(uint256)',
  unlock: 'unlock(uint256)',
  withdrawFrom: 'withdrawFrom(address,address,uint256,uint256)',
  pendingTransfers: 'pendingTransfers(uint256)',
  getOutboundTransfers: 'getOutboundTransfers(address)',
  getInboundTransfers: 'getInboundTransfers(address)',
  guardians: 'guardians(address)',
  isGuardianApprovalNeeded: 'isGuardianApprovalNeeded(address,address,uint256,uint256)',
  depositToWithTip: 'depositToWithTip(address,address,uint256,uint96,uint256,bytes)',
  tips: 'tips(uint256)',
  refundTip: 'refundTip(uint256)',
};
for (const [k, sig] of Object.entries(KNOWN)) {
  ok(`selector(${k})`, selector(sig) === SEL[k]);
}

// --- id codec roundtrip ---
{
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const id = encodeId(usdc, 86400);
  const d = decodeId(id);
  ok('id roundtrip token', d.token === usdc);
  ok('id roundtrip delay', d.delay === 86400);
  ok('ETH id delay=0 -> id == 0', encodeId(ETH, 0) === 0n);
}

// --- units ---
ok('parseUnits 1.5 @18', parseUnits('1.5', 18) === 1500000000000000000n);
ok('formatUnits back', formatUnits(1500000000000000000n, 18) === '1.5');
ok('parseUnits 6dp truncation', parseUnits('0.1234567', 6) === 123456n);

// --- abi encode/decode ---
{
  const enc = encode(['address', 'uint256'], [SLOW_ADDRESS, 42n]);
  const [a, n] = decode(['address', 'uint256'], '0x' + enc);
  ok('encode/decode address', a.toLowerCase() === SLOW_ADDRESS.toLowerCase());
  ok('encode/decode uint256', n === 42n);
}
ok('errorName maps selector', errorName('0x7a6fcaa6') === 'TimelockExpired');
ok('errorName ok on 0x', errorName('0x') === 'ok');

// --- client: calldata construction via a mock provider ---------------------
function mockProvider(handlers = {}) {
  const sent = [];
  return {
    sent,
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111'];
      if (method === 'eth_sendTransaction') { sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
      if (method === 'eth_call') return handlers.call ? handlers.call(params) : '0x' + '0'.repeat(64);
      throw new Error('unexpected ' + method);
    },
  };
}

// ETH deposit: value carried, token/amount zeroed, correct selector + delay.
{
  const p = mockProvider();
  const slow = new SlowClient(p);
  const to = '0x2222222222222222222222222222222222222222';
  await slow.deposit({ to, amount: '0.25', token: 'ETH', delay: 86400 });
  const tx = p.sent[0];
  ok('deposit hits SLOW address', tx.to.toLowerCase() === SLOW_ADDRESS.toLowerCase());
  ok('deposit uses depositTo selector', tx.data.startsWith(SEL.depositTo));
  ok('deposit ETH sets value', BigInt(tx.value) === 250000000000000000n);
  // decode args: token, to, amount, delay, (bytes offset)
  const [token, recip, amount, delay] = decode(['address', 'address', 'uint256', 'uint256'], '0x' + tx.data.slice(10));
  ok('deposit token == ETH(0)', token === '0x0000000000000000000000000000000000000000');
  ok('deposit recipient', recip.toLowerCase() === to.toLowerCase());
  ok('deposit ETH amount arg is 0 (value carries it)', amount === 0n);
  ok('deposit delay arg', delay === 86400n);
}

// Tipped deposit routes to depositToWithTip with value = amount + tip.
{
  const p = mockProvider();
  const slow = new SlowClient(p);
  await slow.deposit({ to: '0x2222222222222222222222222222222222222222', amount: 1000000000000000000n, token: 'ETH', delay: 3600, tip: 5000n });
  const tx = p.sent[0];
  ok('tipped deposit selector', tx.data.startsWith(SEL.depositToWithTip));
  ok('tipped deposit value = amount + tip', BigInt(tx.value) === 1000000000000005000n);
}

// pendingStatus decodes struct + lifecycle flags.
{
  const now = 1_000_000;
  const created = now - 100;        // 100s ago
  const delay = 200;                // expires 100s from now
  const from = '0x3333333333333333333333333333333333333333';
  const toA = '0x4444444444444444444444444444444444444444';
  const id = encodeId(ETH, delay);
  const struct = '0x'
    + BigInt(created).toString(16).padStart(64, '0')
    + from.slice(2).padStart(64, '0')
    + toA.slice(2).padStart(64, '0')
    + id.toString(16).padStart(64, '0')
    + (7n).toString(16).padStart(64, '0');
  const p = mockProvider({ call: () => struct });
  const slow = new SlowClient(p);
  const s = await slow.pendingStatus(123n, now);
  ok('pendingStatus from', s.from.toLowerCase() === from);
  ok('pendingStatus not yet settleable', s.settleable === false && s.reversible === true);
  ok('pendingStatus secondsUntilExpiry', s.secondsUntilExpiry === 100);
}

// keeper.evaluate filters a still-locked transfer.
{
  const now = 500;
  const id = encodeId(ETH, 1000); // long timelock
  const struct = '0x'
    + BigInt(now).toString(16).padStart(64, '0')   // created == now -> not expired
    + '3'.padStart(64, '0') + '4'.padStart(64, '0')
    + id.toString(16).padStart(64, '0') + '1'.padStart(64, '0');
  const p = mockProvider({ call: () => struct });
  const slow = new SlowClient(p, { account: '0x1111111111111111111111111111111111111111' });
  const e = await keeper.evaluate(slow, 9n, { now });
  ok('keeper skips timelock-active', e.eligible === false && e.reason === 'timelock-active');
}

// --- namehash known vectors (EIP-137) --------------------------------------
ok('namehash("") == 0', namehash('') === '0x' + '0'.repeat(64));
ok('namehash("eth")', namehash('eth') === '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
ok('namehash("foo.eth")', namehash('foo.eth') === '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');

// --- isName heuristic ---
ok('isName alice.wei', isName('alice.wei') === true);
ok('isName vitalik.eth', isName('vitalik.eth') === true);
ok('isName rejects address', isName('0x1111111111111111111111111111111111111111') === false);

// --- resolution routing: .wei -> WNS registry, .eth -> ENS registry --------
{
  const targets = [];
  const A = '0x' + 'ab'.repeat(20);
  // ENS: registry.resolver() returns a resolver, then resolver.addr() returns A.
  const p = mockProvider({
    call: (params) => {
      const { to, data } = params[0];
      targets.push(to.toLowerCase());
      if (to.toLowerCase() === WNS_REGISTRY.toLowerCase()) return '0x' + A.slice(2).padStart(64, '0'); // WNS addr()
      if (to.toLowerCase() === ENS_REGISTRY.toLowerCase()) return '0x' + '00'.repeat(12) + '99'.repeat(20); // resolver addr
      // resolver.addr()
      return '0x' + A.slice(2).padStart(64, '0');
    },
  });
  const slow = new SlowClient(p);
  const wei = await resolveName(slow, 'alice.wei');
  ok('.wei routes to WNS registry', targets.includes(WNS_REGISTRY.toLowerCase()));
  ok('.wei resolves to address', wei.toLowerCase() === A.toLowerCase());

  targets.length = 0;
  const eth = await resolveName(slow, 'alice.eth');
  ok('.eth routes to ENS registry', targets.includes(ENS_REGISTRY.toLowerCase()));
  ok('.eth resolves to address', eth.toLowerCase() === A.toLowerCase());
}

// --- deposit accepts a name and resolves it before sending -----------------
{
  const A = '0x' + 'cd'.repeat(20);
  const p = mockProvider({ call: () => '0x' + A.slice(2).padStart(64, '0') }); // WNS addr() -> A
  const slow = new SlowClient(p);
  await slow.deposit({ to: 'bob.wei', amount: '0.1', token: 'ETH', delay: 3600 });
  const [, recip] = decode(['address', 'address'], '0x' + p.sent[0].data.slice(10));
  ok('deposit resolves .wei recipient', recip.toLowerCase() === A.toLowerCase());
}

// --- prepare mode: build unsigned tx, submit nothing (agent-safe default) ---
{
  let submitted = false;
  const p = {
    async request({ method }) {
      if (method === 'eth_sendTransaction') { submitted = true; return '0x'; }
      if (method === 'eth_chainId') return '0x1';
      throw new Error('prepare mode should not call ' + method);
    },
  };
  const slow = new SlowClient(p, { account: '0x1111111111111111111111111111111111111111', mode: 'prepare' });
  const tx = await slow.reverse(42n);
  ok('prepare returns a tx object', typeof tx === 'object' && tx.to.toLowerCase() === SLOW_ADDRESS.toLowerCase());
  ok('prepare emits reverse calldata', tx.data.startsWith(SEL.reverse));
  ok('prepare sets chainId', tx.chainId === 1);
  ok('prepare carries from when known', tx.from === '0x1111111111111111111111111111111111111111');
  ok('prepare submits NOTHING', submitted === false);

  const dep = await slow.deposit({ to: '0x2222222222222222222222222222222222222222', amount: '0.1', token: 'ETH', delay: 86400 });
  ok('prepare deposit sets value', BigInt(dep.value) === 100000000000000000n);
  ok('prepare deposit uses depositTo', dep.data.startsWith(SEL.depositTo));
}

// --- token map sanity ---
ok('USDC has 6 decimals', TOKENS.USDC.decimals === 6);
ok('WBTC has 8 decimals', TOKENS.WBTC.decimals === 8);
ok('wstETH present (rebasing stETH excluded)', !!TOKENS.wstETH && !TOKENS.stETH);

console.log(`\n${pass} checks passed`);
