/**
 * Unit tests for the deterministic helpers inside dapp/page.html.
 *
 * The page is read from disk and never modified. Its script is cut at the
 * "Wiring" banner — everything above it is pure logic plus a handful of
 * module-level DOM touches, which the stubs below satisfy — and the captured
 * internals are exercised directly.
 *
 *   node test/page.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');

// ─── Extract the logic half of the page script ─────────────────────────────
const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cut = body.indexOf('   Wiring');
if (cut < 0) throw new Error('Wiring banner not found — did the page structure change?');
const logic = body.slice(body.indexOf('{') + 1, body.lastIndexOf('/*', cut));

// ─── Minimal DOM ───────────────────────────────────────────────────────────
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
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.matchMedia = () => ({matches: false, addEventListener: noop});
globalThis.document = {
  body: stubEl(),
  hidden: false,
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: stubEl,
  addEventListener: noop,
};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.dispatchEvent = noop;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.fetch = () => Promise.reject(new Error('no network in unit tests'));
globalThis.innerWidth = 1024;

const captured = {};
globalThis.__capture = captured;
const EXPORTS = [
  'SLOW', 'ZERO', 'ENS_REG', 'WNS', 'MC3', 'MAINNET', 'GRACE', 'SEL', 'TYPEHASH_2612', 'PRESETS',
  'CHAINS', 'CHAIN_IDS', 'cfg', 'TOKEN_COLORS',
  'keccak256', 'namehash', 'encode', 'decode', 'cd', 'word', 'strip',
  'encAggregate3', 'decAggregate3', 'chunk',
  'parseUnits', 'formatUnits', 'fmtAmt', 'group', 'fmtTime', 'fmtCustomTime',
  'decodeId', 'decodeStringLoose', 'isAddr', 'shortAddr', 'tokSym',
  'domainSeparator', 'isRejection', 'errText', 'hasAtomic', 'statusOf', 'progressOf',
  'presetsFor', 'S', 'depositCalldata', 'planLabel',
];
new Function(`${logic}\n;Object.assign(globalThis.__capture,{${EXPORTS.join(',')}});`)();
const C = captured;

// ─── Runner ────────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
const eq = (actual, expected, msg) => {
  const ok = typeof actual === 'object' && actual !== null
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) pass++;
  else failures.push(`  ${msg}\n    got:    ${actual}\n    expect: ${expected}`);
};
const ok = (cond, msg) => eq(!!cond, true, msg);
const throws = (fn, msg) => {
  try { fn(); failures.push(`  ${msg}\n    expected a throw, got a value`); }
  catch (e) { pass++; }
};

// ─── keccak256 ─────────────────────────────────────────────────────────────
// The hex/UTF-8 distinction is the point: a build that treats every string as
// hex returns a plausible but wrong digest for a signature, silently.
eq(C.keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("")');
eq(C.keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', 'keccak256("abc")');
eq(C.keccak256('0x'), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("0x") is empty input');
eq(C.keccak256(new Uint8Array([0x61, 0x62, 0x63])), C.keccak256('abc'), 'bytes and string agree');
throws(() => C.keccak256('0xabc'), 'keccak256 rejects odd-length hex');

// Every selector the page ships must be the real one.
const sigs = {
  depositTo: 'depositTo(address,address,uint256,uint96,bytes)',
  depositToWithPermit: 'depositToWithPermit(address,address,uint256,uint96,bytes,uint256,uint8,bytes32,bytes32)',
  depositToWithTipAndPermit: 'depositToWithTipAndPermit(address,address,uint256,uint96,uint256,bytes,uint256,uint8,bytes32,bytes32)',
  reverse: 'reverse(uint256)', claim: 'claim(uint256)', clawback: 'clawback(uint256)',
  unlock: 'unlock(uint256)', multicall: 'multicall(bytes[])',
  withdrawFrom: 'withdrawFrom(address,address,uint256,uint256)',
  approve: 'approve(address,uint256)', allowance: 'allowance(address,address)',
  decimals: 'decimals()', symbol: 'symbol()', name: 'name()', balanceOf: 'balanceOf(address)',
  permit: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  nonces: 'nonces(address)', domainSeparator: 'DOMAIN_SEPARATOR()', permitTypehash: 'PERMIT_TYPEHASH()',
  aggregate3: 'aggregate3((address,bool,bytes)[])',
  resolver: 'resolver(bytes32)', addr: 'addr(bytes32)',
};
for (const [key, sig] of Object.entries(sigs)) {
  eq(C.SEL[key], C.keccak256(sig).slice(0, 10), `selector ${key} = ${sig}`);
}
eq(C.TYPEHASH_2612,
  C.keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)').slice(2),
  'EIP-2612 Permit typehash');

// ─── namehash (ENSIP-1 vectors) ────────────────────────────────────────────
eq(C.namehash(''), '0x' + '0'.repeat(64), 'namehash("")');
eq(C.namehash('eth'), '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae', 'namehash("eth")');
eq(C.namehash('foo.eth'), '0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f', 'namehash("foo.eth")');

// ─── ABI codec ─────────────────────────────────────────────────────────────
eq('0x' + C.encode(['uint256'], [0x42n]), '0x' + '42'.padStart(64, '0'), 'encode uint256');
eq('0x' + C.encode(['address'], ['0x0000000000000000000000000000000000000001']),
  '0x' + '1'.padStart(64, '0'), 'encode address');
eq(C.encode(['bool'], [true]), '1'.padStart(64, '0'), 'encode bool true');
eq(C.encode(['bool'], [false]), '0'.repeat(64), 'encode bool false');

const roundTrip = C.cd(C.SEL.pendingTransfers, ['uint256'], [123n]);
eq(roundTrip.length, 10 + 64, 'cd() produces selector + one word');
eq(C.decode(['uint256'], '0x' + roundTrip.slice(10))[0], 123n, 'decode uint256 round-trip');

const arrHex = '0x' + '20'.padStart(64, '0') + '2'.padStart(64, '0')
  + 'a'.padStart(64, '0') + 'b'.padStart(64, '0');
eq(C.decode(['uint256[]'], arrHex)[0].map(String).join(','), '10,11', 'decode uint256[]');

// ─── Multicall3 aggregate3 round-trip ──────────────────────────────────────
// Encoding is cross-checked against an independent reimplementation of the
// same layout, then decoded back through the page's own decoder.
const calls = [
  {to: '0x000000000000000000000000000000000000dEaD', data: '0x12345678'},
  {to: C.MC3, data: '0x' + 'ab'.repeat(40)},
];
const encoded = C.encAggregate3(calls);
eq(encoded.slice(0, 10), C.SEL.aggregate3, 'aggregate3 selector');
eq(encoded.slice(10, 74), '20'.padStart(64, '0'), 'aggregate3 array offset');
eq(encoded.slice(74, 138), '2'.padStart(64, '0'), 'aggregate3 array length');
const refEnc = (cs) => {
  let head = '', tail = '', off = cs.length * 32;
  for (const c of cs) {
    const d = c.data.slice(2), len = d.length / 2;
    const body = c.to.slice(2).toLowerCase().padStart(64, '0')
      + '1'.padStart(64, '0') + (96).toString(16).padStart(64, '0')
      + len.toString(16).padStart(64, '0') + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += off.toString(16).padStart(64, '0'); tail += body; off += body.length / 2;
  }
  return C.SEL.aggregate3 + (32).toString(16).padStart(64, '0')
    + cs.length.toString(16).padStart(64, '0') + head + tail;
};
eq(encoded, refEnc(calls), 'aggregate3 encoding matches an independent encoder');

// Synthesise an aggregate3 return: (bool success, bytes returnData)[]
const encReturn = (results) => {
  let head = '', tail = '', off = results.length * 32;
  for (const r of results) {
    const d = r.data.slice(2), len = d.length / 2;
    const body = (r.ok ? '1' : '0').padStart(64, '0') + (64).toString(16).padStart(64, '0')
      + len.toString(16).padStart(64, '0') + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += off.toString(16).padStart(64, '0'); tail += body; off += body.length / 2;
  }
  return '0x' + (32).toString(16).padStart(64, '0')
    + results.length.toString(16).padStart(64, '0') + head + tail;
};
const decoded = C.decAggregate3(encReturn([
  {ok: true, data: '0x' + '7b'.padStart(64, '0')},
  {ok: false, data: '0x'},
  {ok: true, data: '0xdeadbeef'},
]));
eq(decoded.length, 3, 'decAggregate3 returns one entry per call');
eq(C.decode(['uint256'], decoded[0])[0], 123n, 'decAggregate3 decodes a success');
eq(decoded[1], null, 'decAggregate3 maps a failed sub-call to null, not a throw');
eq(decoded[2], '0xdeadbeef', 'decAggregate3 preserves raw bytes');

// ─── Units ─────────────────────────────────────────────────────────────────
eq(C.parseUnits('1', 18), 10n ** 18n, 'parseUnits whole');
eq(C.parseUnits('1.5', 6), 1500000n, 'parseUnits fractional');
eq(C.parseUnits('0.000001', 6), 1n, 'parseUnits smallest USDC unit');
throws(() => C.parseUnits('1.1234567', 6), 'parseUnits rejects excess decimals');
throws(() => C.parseUnits('abc', 18), 'parseUnits rejects non-numeric');
throws(() => C.parseUnits('-1', 18), 'parseUnits rejects negative');

eq(C.formatUnits(10n ** 18n, 18), '1', 'formatUnits whole');
eq(C.formatUnits(1500000n, 6), '1.5', 'formatUnits fractional');
// Exactness: this value cannot survive a float.
const big = 12345678901234567890123n;
eq(C.formatUnits(big, 18), '12345.678901234567890123', 'formatUnits keeps every digit');

// The bug this replaces: 1e-7 ETH used to render as "0.00".
eq(C.fmtAmt(100000000000n, 18), '0.0000001', 'fmtAmt shows a sub-micro amount');
eq(C.fmtAmt(1n, 18), '0.000000000000000001', 'fmtAmt shows one wei');
eq(C.fmtAmt(0n, 18), '0', 'fmtAmt zero');
eq(C.fmtAmt(10n ** 18n, 18), '1', 'fmtAmt whole');
eq(C.fmtAmt(1234500000n, 6), '1,234.5', 'fmtAmt groups thousands');
eq(C.fmtAmt(big, 18), '12,345.678901', 'fmtAmt caps at six decimals when the integer part is nonzero');
ok(C.fmtAmt(1n, 18) !== '0.00' && C.fmtAmt(100000000000n, 18) !== '0.00',
  'no nonzero amount ever renders as 0.00');

// ─── bytes32 symbols (MKR and friends) ─────────────────────────────────────
const b32 = '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0');
eq(C.decodeStringLoose(b32), 'MKR', 'decodeStringLoose reads a bytes32 symbol');
const strRet = '0x' + (32).toString(16).padStart(64, '0') + (4).toString(16).padStart(64, '0')
  + Buffer.from('USDC').toString('hex').padEnd(64, '0');
eq(C.decodeStringLoose(strRet), 'USDC', 'decodeStringLoose reads an ABI string');
eq(C.decodeStringLoose('0x'), '', 'decodeStringLoose on empty returndata');

// ─── Time & ids ────────────────────────────────────────────────────────────
eq(C.fmtTime(0), '0s', 'fmtTime zero');
eq(C.fmtTime(-5), '0s', 'fmtTime clamps negatives');
eq(C.fmtTime(90), '1m 30s', 'fmtTime minutes');
eq(C.fmtTime(3600), '1h 0m', 'fmtTime one hour');
eq(C.fmtTime(90061), '1d 1h 1m', 'fmtTime days');
eq(C.fmtCustomTime({d: 1, h: 0, m: 0, s: 0}).seconds, 86400, 'fmtCustomTime seconds');
eq(C.fmtCustomTime({d: 1, h: 2, m: 0, s: 0}).display, '1D 2H', 'fmtCustomTime display');

const id = (86400n << 160n) | BigInt('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
eq(C.decodeId(id).token, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'decodeId token');
eq(C.decodeId(id).delay, 86400, 'decodeId delay');

eq(C.isAddr('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), true, 'isAddr accepts');
eq(C.isAddr('0xnope'), false, 'isAddr rejects');
eq(C.shortAddr('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), '0xa0b8…eb48', 'shortAddr');
eq(C.tokSym('ETH'), 'ETH', 'tokSym known');
eq(C.tokSym('WBTC'), 'other', 'tokSym unknown');

// ─── EIP-712 domain separator ──────────────────────────────────────────────
// USDC mainnet: name "USD Coin", version "2".
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ds = C.domainSeparator('USD Coin', '2', usdc);
eq(ds.length, 66, 'domainSeparator returns 32 bytes');
eq(ds, C.keccak256('0x'
  + C.keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)').slice(2)
  + C.keccak256('USD Coin').slice(2) + C.keccak256('2').slice(2)
  + C.word(1) + C.word(usdc)), 'domainSeparator matches the EIP-712 construction');
ok(C.domainSeparator('USD Coin', '2', usdc) !== C.domainSeparator('USD Coin', '1', usdc),
  'domainSeparator is version-sensitive (this is what gates the permit rung)');

// ─── Wallet capability probing (EIP-5792) ──────────────────────────────────
eq(C.hasAtomic({'0x1': {atomic: {status: 'supported'}}}), true, 'hasAtomic: supported on mainnet');
eq(C.hasAtomic({'0x1': {atomic: {status: 'ready'}}}), true, 'hasAtomic: ready counts');
eq(C.hasAtomic({'0x1': {atomic: {status: 'unsupported'}}}), false, 'hasAtomic: unsupported');
eq(C.hasAtomic({'0x0': {atomic: {status: 'supported'}}}), true, 'hasAtomic: falls back to the 0x0 key');
eq(C.hasAtomic({'0xa': {atomic: {status: 'supported'}}}), false, 'hasAtomic: another chain does not count');
eq(C.hasAtomic(null), false, 'hasAtomic: no capabilities');
eq(C.hasAtomic({}), false, 'hasAtomic: empty capabilities');

// ─── Rejections are not crashes ────────────────────────────────────────────
eq(C.isRejection({code: 4001}), true, 'isRejection by code');
eq(C.isRejection({message: 'User rejected the request'}), true, 'isRejection by message');
eq(C.isRejection({code: 'ACTION_REJECTED'}), true, 'isRejection by ethers code');
eq(C.isRejection({message: 'execution reverted'}), false, 'a revert is not a rejection');
eq(C.errText({code: 4001}), 'Cancelled', 'a rejection reads as Cancelled');
ok(C.errText({message: 'x'.repeat(400)}).length <= 140, 'error text is truncated');
ok(/Not enough ETH/.test(C.errText({message: 'insufficient funds for gas'})), 'insufficient funds is explained');

// ─── Transfer status ───────────────────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const mk = o => ({timestamp: now - 100, delay: 200, unlockTime: now + 100, amountRaw: 1n, ...o});
C.S.tab = 'outbound';
eq(C.statusOf(mk()).key, 'pending', 'outbound before expiry is pending');
eq(C.statusOf(mk({unlockTime: now - 10})).key, 'settling', 'outbound after expiry awaits the recipient');
eq(C.statusOf(mk({unlockTime: now - C.GRACE - 10})).key, 'recover', 'outbound past the grace window is recoverable');
C.S.tab = 'inbound';
eq(C.statusOf(mk({unlockTime: now - 10})).key, 'ready', 'inbound after expiry is claimable');
eq(C.statusOf(mk()).key, 'pending', 'inbound before expiry is pending');
C.S.tab = 'outbound';

eq(C.progressOf({timestamp: now - 50, delay: 100}) > 40, true, 'progress advances');
eq(C.progressOf({timestamp: now - 500, delay: 100}), 100, 'progress clamps at 100');
eq(C.progressOf({timestamp: now, delay: 0}), 100, 'a zero delay does not divide by zero');
eq(C.progressOf({timestamp: now + 50, delay: 100}), 0, 'progress clamps at 0');

// ─── Presets are per-asset ─────────────────────────────────────────────────
ok(C.presetsFor('ETH')[0] !== C.presetsFor('USDC')[0],
  'ETH and USDC do not share an amount ladder');
eq(C.presetsFor('ETH').join(','), '0.01,0.1,1', 'ETH presets');
eq(C.presetsFor('WBTC').join(','), C.PRESETS.default.join(','), 'unknown tokens use the default ladder');

// ─── Deposit calldata ──────────────────────────────────────────────────────
// The ETH rung is the one that regressed during development: depositTo takes
// amount == 0 when the value is carried as msg.value, and the transaction must
// actually carry it.
const usdcAddr = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const to = '0x000000000000000000000000000000000000dEaD';

C.S.token = C.ZERO; C.S.resolved = to; C.S.delay = 86400; C.S.autoClaim = false; C.S.tip = 0n;
let data = C.depositCalldata(10n ** 18n);
eq(data.slice(0, 10), C.SEL.depositTo, 'ETH deposit uses depositTo');
eq(BigInt('0x' + data.slice(10 + 128, 10 + 192)), 0n,
  'ETH deposit passes amount == 0 — the value rides as msg.value');
eq('0x' + data.slice(10 + 24, 10 + 64), C.ZERO, 'ETH deposit passes the zero token');

C.S.token = usdcAddr;
data = C.depositCalldata(1500000n);
eq(BigInt('0x' + data.slice(10 + 128, 10 + 192)), 1500000n, 'ERC-20 deposit passes the amount');
eq('0x' + data.slice(10 + 24, 10 + 64), usdcAddr, 'ERC-20 deposit passes the token');
eq(BigInt('0x' + data.slice(10 + 192, 10 + 256)), 86400n, 'deposit passes the delay');

C.S.autoClaim = true; C.S.tip = 3000000000000000n;
eq(C.depositCalldata(1500000n).slice(0, 10), C.SEL.depositToWithTip, 'a tip switches to depositToWithTip');
C.S.token = C.ZERO;
eq(BigInt('0x' + C.depositCalldata(10n ** 18n).slice(10 + 128, 10 + 192)), 10n ** 18n,
  'the tipped ETH path passes the amount explicitly, unlike depositTo');

C.S.token = usdcAddr; C.S.autoClaim = false;
const sig = {v: 27n, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32)};
data = C.depositCalldata(1500000n, sig, 1234n);
eq(data.slice(0, 10), C.SEL.depositToWithPermit, 'a signature switches to depositToWithPermit');
ok(data.includes('11'.repeat(32)) && data.includes('22'.repeat(32)), 'permit r and s are carried');
C.S.autoClaim = true;
eq(C.depositCalldata(1500000n, sig, 1234n).slice(0, 10), C.SEL.depositToWithTipAndPermit,
  'a signature plus a tip switches to depositToWithTipAndPermit');
C.S.autoClaim = false; C.S.token = null; C.S.resolved = null;

// Every rung of the waterfall says something a person can act on.
for (const kind of ['direct', 'batch', 'permit', 'approve']) {
  ok(C.planLabel({kind, allowance: 0n}).length > 10, `planLabel describes the "${kind}" rung`);
}
ok(/reset first/.test(C.planLabel({kind: 'approve', allowance: 1n})),
  'the approve rung warns when a reset-to-zero is needed');

// ─── Constants ─────────────────────────────────────────────────────────────
eq(C.SLOW.toLowerCase(), '0x000000000000888741b254d37e1b27128afeaabc', 'SLOW address');
eq(C.MC3, '0xcA11bde05977b3631167028862bE2a173976CA11', 'Multicall3 canonical address');
eq(C.ENS_REG, '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', 'ENS registry');
eq(C.WNS, '0x0000000000696760E15f265e828DB644A0c242EB', 'WNS registry');
eq(C.GRACE, 2592000, 'clawback grace is 30 days');
eq(C.MAINNET, 1, 'mainnet is chain 1');

// ─── Chains ────────────────────────────────────────────────────────────────
// SLOW is at one canonical address everywhere; what differs per chain is the
// code at it, the token set, and whether the name registries exist at all.
eq(C.CHAIN_IDS.join(','), '1,4663', 'the page knows mainnet and Robinhood Chain');
eq(C.CHAINS[1].hex, '0x1', 'mainnet chain id hex');
eq(C.CHAINS[4663].hex, '0x1237', 'Robinhood Chain is 4663 == 0x1237');
eq(parseInt(C.CHAINS[4663].hex, 16), 4663, 'the hex and decimal chain ids agree');
eq(C.CHAINS[1].id, 1, 'registry keys match their ids');
eq(C.CHAINS[4663].id, 4663, 'registry keys match their ids (4663)');
ok(C.CHAINS[4663].addChain, 'Robinhood Chain carries wallet_addEthereumChain params');
eq(C.CHAINS[4663].addChain.chainId, '0x1237', 'addEthereumChain uses the same hex id');
eq(C.CHAINS[4663].addChain.nativeCurrency.symbol, 'ETH', 'gas on 4663 is paid in ETH');
eq(C.CHAINS[4663].addChain.rpcUrls[0], C.CHAINS[4663].rpcs[0],
  'the RPC offered to the wallet is the one the page reads from');
ok(!C.CHAINS[1].addChain, 'mainnet needs no add-chain fallback');

for (const id of C.CHAIN_IDS) {
  const c = C.CHAINS[id];
  ok(c.rpcs.length > 0, `chain ${id} has at least one RPC`);
  ok(/^https:\/\//.test(c.explorer), `chain ${id} explorer is https`);
  ok(c.tokens.length >= 2, `chain ${id} has a token list`);
  eq(c.tokens[0].address, C.ZERO, `chain ${id} lists native ETH first`);
  eq(c.tokens[0].decimals, 18, `chain ${id} native ETH has 18 decimals`);
  ok(c.tokens.every(t => /^0x[0-9a-f]{40}$/.test(t.address)),
    `chain ${id} token addresses are lowercase hex`);
  ok(new Set(c.tokens.map(t => t.address)).size === c.tokens.length,
    `chain ${id} lists no token twice`);
}

// Chain-native assets, each confirmed on chain 4663 to have code and to report
// this symbol and these decimals.
const rh = C.CHAINS[4663].tokens;
eq(rh.map(t => t.symbol).join(','), 'ETH,USDe,USDG,NVDA', '4663 lists its own assets');
eq(rh.find(t => t.symbol === 'USDe').address, '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', 'USDe on 4663');
eq(rh.find(t => t.symbol === 'USDe').decimals, 18, 'USDe has 18 decimals, not 6');
eq(rh.find(t => t.symbol === 'USDG').address, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG on 4663');
eq(rh.find(t => t.symbol === 'USDG').decimals, 6, 'USDG has 6 decimals');
eq(rh.find(t => t.symbol === 'NVDA').address, '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', 'NVDA on 4663');
eq(rh.find(t => t.symbol === 'NVDA').decimals, 18, 'NVDA has 18 decimals');
// None of the mainnet four appears on 4663, and nothing shares an address.
for (const sym of ['USDC', 'USDT', 'BOLD']) {
  ok(!rh.some(t => t.symbol === sym), `${sym} is not offered on 4663`);
}
const mainAddrs = new Set(C.CHAINS[1].tokens.filter(t => t.address !== C.ZERO).map(t => t.address));
ok(rh.filter(t => t.address !== C.ZERO).every(t => !mainAddrs.has(t.address)),
  'no 4663 asset reuses a mainnet address');

// A tokenized share must not be laddered like a dollar: 10/100/1000 NVDA would
// offer roughly $1.8k to $180k as the three default amounts.
eq(C.presetsFor('NVDA').join(','), '0.1,1,10', 'NVDA gets a share-scale ladder');
ok(C.presetsFor('NVDA').join(',') !== C.PRESETS.default.join(','),
  'NVDA does not inherit the stablecoin ladder');
ok(C.TOKEN_COLORS.NVDA && C.TOKEN_COLORS.USDe && C.TOKEN_COLORS.USDG,
  'every 4663 asset has a tile colour');
eq(new Set(rh.map(t => C.TOKEN_COLORS[t.symbol])).size, rh.length,
  'the four 4663 tiles are four different colours');

eq(C.cfg(4663).name, 'Robinhood Chain', 'cfg() resolves by id');
eq(C.cfg(999999).id, 1, 'cfg() falls back to mainnet for an unknown chain');

// Presets follow the asset, and WETH is an ether-scale asset like ETH.
eq(C.presetsFor('WETH').join(','), C.presetsFor('ETH').join(','), 'WETH shares the ETH ladder');
ok(C.TOKEN_COLORS.WETH === C.TOKEN_COLORS.ETH, 'WETH is painted as ether');

// ─── Report ────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} failing:\n${failures.join('\n')}\n`);
  console.error(`${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${pass} passed`);
