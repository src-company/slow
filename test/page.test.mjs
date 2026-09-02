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
globalThis.location = {origin: 'https://slow.wei.limo', pathname: '/', hostname: 'slow.wei.limo', hash: ''};


const captured = {};
globalThis.__capture = captured;
const EXPORTS = [
  'SLOW', 'ZERO', 'ENS_REG', 'WNS', 'MC3', 'MAINNET', 'GRACE', 'SEL', 'TYPEHASH_2612', 'PRESETS',
  'CHAINS', 'CHAIN_IDS', 'cfg', 'TOKEN_COLORS',
  'keccak256', 'namehash', 'encode', 'decode', 'cd', 'word', 'strip',
  'encAggregate3', 'decAggregate3', 'chunk',
  'parseUnits', 'formatUnits', 'fmtAmt', 'group', 'fmtTime', 'fmtCustomTime',
  'decodeId', 'decodeStringLoose', 'isAddr', 'shortAddr',
  'domainSeparator', 'isRejection', 'errText', 'hasAtomic', 'statusOf', 'progressOf',
  'presetsFor', 'S', 'depositCalldata', 'planLabel', 'GUARD_DELAY', 'luminance', 'inkOn',
  'fmtWhen', 'ready', 'contrast', 'parseRoute', 'payLink', 'txLink', 'KEEPER_GAS',
  'LOADER', 'LOADER_STILL', 'GNS', 'tldOf',
  'BRIDGES', 'aliasOf', 'unaliasOf', 'L1_ALIAS', 'innerDepositCalldata', 'destinations',
  'depositRecipe', 'recipeText', 'unlockedKey', 'exitRecipe', 'exitText',
  'RETRY_CODES', 'rpcErr', 'rpcPool',
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
  guardians: 'guardians(address)',
  setGuardian: 'setGuardian(address)',
  commitGuardian: 'commitGuardian(address)',
  cancelGuardianChange: 'cancelGuardianChange(address)',
  pendingGuardian: 'pendingGuardian(address)',
  approveTransfer: 'approveTransfer(address,uint256)',
  revokeApproval: 'revokeApproval(address,uint256)',
  guardianApproved: 'guardianApproved(address,uint256)',
  isGuardianApprovalNeeded: 'isGuardianApprovalNeeded(address,address,uint256,uint256)',
  isWithdrawalApprovalNeeded: 'isWithdrawalApprovalNeeded(address,address,uint256,uint256)',
  predictWithdrawalId: 'predictWithdrawalId(address,address,uint256,uint256)',
  predictTransferId: 'predictTransferId(address,address,uint256,uint256)',
  unlockedBalances: 'unlockedBalances(address,uint256)',
  nonces: 'nonces(address)',
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
// Only pendingTransfers[id].from may reverse or recover, so a status is only
// actionable when the connected account IS that address.
const ME = '0x000000000000000000000000000000000000A11c';
C.S.account = ME;
const mk = o => ({timestamp: now - 100, delay: 200, unlockTime: now + 100, amountRaw: 1n, from: ME, ...o});
C.S.tab = 'outbound';
eq(C.statusOf(mk()).key, 'pending', 'outbound before expiry is pending');
eq(C.statusOf(mk({unlockTime: now - 10})).key, 'settling', 'outbound after expiry awaits the recipient');
eq(C.statusOf(mk({unlockTime: now - C.GRACE - 10})).key, 'recover', 'outbound past the grace window is recoverable');
// A transfer bridged in from L1 is recorded against the ALIAS of your address,
// so SLOW will reject a reverse from you. It is listed, and it offers nothing.
{
  const via = mk({from: C.aliasOf(ME), unlockTime: now - C.GRACE - 10});
  eq(C.statusOf(via).act, null, 'a bridged-in transfer offers no action');
  ok(/bridged in/i.test(C.statusOf(mk({from: C.aliasOf(ME)})).text), 'and says why');
  eq(C.statusOf(mk({from: '0x000000000000000000000000000000000000bEEF'})).act, null,
    'nor does a third party\u2019s transfer opened from a link');
  const noWallet = C.S.account; C.S.account = null;
  eq(C.statusOf(mk({unlockTime: now - C.GRACE - 10})).act, null,
    'and a reader with no wallet is offered nothing');
  C.S.account = noWallet;
}
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
eq(C.presetsFor('SOMETHING'), C.PRESETS.default, 'an unlisted token uses the default ladder');

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

// ─── Absolute time ─────────────────────────────────────────────────────────
// "in 4 hours" says how long; only a date says when. The review shows both.
const when = C.fmtWhen(Math.floor(Date.UTC(2026, 8, 4, 14, 32) / 1000));
ok(typeof when === 'string' && when.length > 6, 'fmtWhen returns a readable string');
ok(!/Invalid/.test(when), 'fmtWhen never emits Invalid Date');
ok(C.fmtWhen(Math.floor(Date.now() / 1000)) !== C.fmtWhen(Math.floor(Date.now() / 1000) + 86400 * 40),
  'fmtWhen distinguishes dates 40 days apart');

// ─── Send readiness ────────────────────────────────────────────────────────
// The review, and the send button, appear only when all four facts are known.
const snap = {...C.S};
Object.assign(C.S, {resolved: null, token: null, symbol: null, amount: null, delay: null});
eq(C.ready(), false, 'not ready with an empty form');
C.S.resolved = '0x000000000000000000000000000000000000dEaD';
eq(C.ready(), false, 'not ready with only a recipient');
C.S.token = C.ZERO; C.S.symbol = 'ETH';
eq(C.ready(), false, 'not ready without an amount');
C.S.amount = '0.1';
eq(C.ready(), false, 'not ready without a timelock');
C.S.delay = 86400;
eq(C.ready(), true, 'ready once recipient, asset, amount and timelock are all set');
Object.assign(C.S, snap);

// ─── Names ─────────────────────────────────────────────────────────────────
// GNS is an ownerless fork of wei-names, so it answers the same two selectors
// with the same namehash. Verified against the GWEI_NODE constant in its README.
eq(C.GNS, '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6', 'GNS registry address');
eq(C.namehash('gwei'), '0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f',
  'namehash("gwei") matches the GNS constant');
eq(C.namehash('alice.gwei'),
  C.keccak256(C.namehash('gwei') + C.keccak256('alice').slice(2)),
  'a .gwei name hashes under the gwei node');
ok(C.GNS !== C.WNS && C.GNS !== C.ENS_REG, 'three distinct registries');

// Dispatch is on the TLD, not a suffix test. ".gwei" happens not to end with
// ".wei" — the characters differ — but reading that off a comparison every time
// is how the wrong registry eventually gets asked.
eq(C.tldOf('a.wei'), 'wei', 'tldOf .wei');
eq(C.tldOf('a.gwei'), 'gwei', 'tldOf .gwei');
eq(C.tldOf('a.eth'), 'eth', 'tldOf .eth');
eq(C.tldOf('deep.sub.gwei'), 'gwei', 'tldOf a subdomain');
eq(C.tldOf('A.GWEI'), 'gwei', 'tldOf is case-insensitive');
eq(C.tldOf('plain'), '', 'a bare label has no TLD');
eq(C.tldOf(''), '', 'an empty name has no TLD');
ok(!'alice.gwei'.endsWith('.wei'), 'the suffix collision the dispatch avoids does not exist');

// ─── Loader ────────────────────────────────────────────────────────────────
{
  const frames = (C.LOADER.match(/<animate /g) || []).length;
  eq(frames, 16, 'the loader keeps all sixteen frames');
  eq((C.LOADER.match(/dur="3\.2s"/g) || []).length, 16, 'every frame shares the 3.2s loop');
  ok(!/<!--/.test(C.LOADER), 'comments are stripped');
  ok(!/\swidth="400"/.test(C.LOADER), 'the fixed pixel size is dropped so CSS can size it');
  ok(/viewBox="0 0 400 400"/.test(C.LOADER), 'the viewBox is kept');
  ok(/aria-label="Loading"/.test(C.LOADER), 'the loader is labelled for a screen reader');

  // SMIL cannot be stopped from CSS, so reduced motion gets a still frame —
  // and it must be the SAME drawing, not a different one.
  eq((C.LOADER_STILL.match(/<animate /g) || []).length, 0, 'the still frame animates nothing');
  const polys = (str) => (str.match(/<polygon /g) || []).length;
  eq(polys(C.LOADER_STILL), 6, 'the still frame is one complete frame, six facets');
  ok(polys(C.LOADER) > polys(C.LOADER_STILL), 'the animated loader has more frames than the still one');
  // Same drawing, minus the animation: every shape in the still frame appears
  // verbatim in the animated one.
  const shapes = C.LOADER_STILL.match(/<(?:polygon|line)[^>]*\/>/g) || [];
  eq(shapes.length, 8, 'the still frame has six facets and two rules');
  ok(shapes.every((sh) => C.LOADER.includes(sh)),
    'every shape in the still frame is drawn identically in the animation');
}

// ─── Regressions the bug hunt found ────────────────────────────────────────

// A short or empty return is not an address. '0x' + '0x'.slice(-40) is the
// literal string '0x0x', which is not the zero address, so an unreadable
// guardian rendered as a real one — with a live Remove button under it.
{
  const bad = '0x';
  const built = (bad && C.strip(bad).length >= 40) ? '0x' + bad.slice(-40) : C.ZERO;
  eq(built, C.ZERO, 'an empty guardian read falls back to the zero address');
  eq(C.isAddr('0x0x'), false, 'the old construction was never a valid address');
  ok(!C.isAddr('0x' + '0x'.slice(-40)), 'and would have been shown as a guardian');
}

// Unlocked positions are remembered per chain AND per account: the same wrapper
// id means a different position on a different chain.
{
  const snap = {chain: C.S.chain, account: C.S.account};
  C.S.account = '0x000000000000000000000000000000000000dEaD';
  const keys = C.CHAIN_IDS.map((id) => { C.S.chain = id; return C.unlockedKey(); });
  eq(new Set(keys).size, keys.length, 'each chain keeps its own unlocked list');
  C.S.chain = 1;
  const a = C.unlockedKey();
  C.S.account = '0x000000000000000000000000000000000000bEEF';
  ok(a !== C.unlockedKey(), 'and each account keeps its own');
  Object.assign(C.S, snap);
}

// The call recipe is the generalisation: anything that can send a transaction
// can deposit into SLOW without SLOW knowing it exists.
{
  const snap = {...C.S};
  Object.assign(C.S, {chain: 1, dest: null, token: C.ZERO, symbol: 'ETH', decimals: 18,
    amount: '0.5', delay: 3600, resolved: '0x000000000000000000000000000000000000dEaD'});
  const r = C.depositRecipe();
  ok(r, 'a complete form yields a recipe');
  eq(r.to, C.SLOW, 'the recipe targets SLOW');
  eq(r.value, 500000000000000000n, 'ETH rides as value');
  eq(r.data.slice(0, 10), C.SEL.depositTo, 'and calls depositTo');
  eq(BigInt('0x' + r.data.slice(10 + 128, 10 + 192)), 0n, 'with amount zero, as the local path does');
  ok(!r.note, 'native ETH needs no allowance note');
  // An ERC-20 recipe carries the amount and warns about the allowance.
  Object.assign(C.S, {token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, amount: '10'});
  const r2 = C.depositRecipe();
  eq(r2.value, 0n, 'an ERC-20 recipe sends no value');
  eq(BigInt('0x' + r2.data.slice(10 + 128, 10 + 192)), 10000000n, 'and carries the amount');
  ok(/allowance/i.test(r2.note), 'and says an allowance is needed first');
  ok(C.recipeText(r2).includes(C.SLOW) && C.recipeText(r2).includes('data:'),
    'the copyable text carries target and calldata');
  // A destination overrides the chain the recipe is for.
  C.S.dest = 8453;
  eq(C.depositRecipe().chainId, 8453, 'a destination retargets the recipe');
  Object.assign(C.S, snap);
}

// ─── What the second hunt found ────────────────────────────────────────────

// The `el` map is built last-wins from every [id]. A dead modal carrying the
// same ids as the live Send pane bound el.amountInput to an input nobody could
// see, so the listeners attached there and typing an amount did nothing.
{
  const doc = html.split('</style>')[1];
  const ids = [...doc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  eq([...new Set(dupes)].join(','), '', 'no id appears twice in the document');
}

// `hidden` is styled only by the UA sheet, and ANY author `display` outranks it
// whatever the specificity — so a class that sets display defeated the
// attribute on every panel toggled from JS.
{
  const css = html.split('<style>')[1].split('</style>')[0];
  ok(/\[hidden\]\{display:none!important\}/.test(css), 'the hidden attribute wins over author display');
  const doc = html.split('</style>')[1];
  const hidden = [...doc.matchAll(/<\w+[^>]*\bclass="([^"]+)"[^>]*\bhidden\b/g)].map((m) => m[1]);
  ok(hidden.length > 0, 'there are elements hidden by attribute');
}

// A tapped selection must keep its selected styling. Every hover rule is now
// behind (hover:hover), so on touch there is nothing to out-specify it.
{
  const css = html.split('<style>')[1].split('</style>')[0];
  const bare = css
    .replace(/\/\*[\s\S]*?\*\//g, '')                              // comments mention :hover too
    .replace(/@media \(hover:hover\)\{[^{}]*\{[^{}]*\}\}/g, '');   // the gated ones
  const stray = [...bare.matchAll(/(^|[};])([^{};@]*:hover[^{};]*)\{/g)].map((m) => m[2].trim());
  eq(stray.join(' | '), '', `every :hover rule is gated on (hover:hover) (stray: ${stray.join(', ') || 'none'})`);
  ok(!/transition-duration:0!important/.test(css), 'reduced motion uses a valid <time>, not a bare 0');
  ok(/\.modal\.on\{align-items:flex-end\}/.test(css), 'the bottom sheet matches .modal.on, which sets align-items');
}

// A destination is only correct for native ETH: the bridge sends the amount as
// msg.value with depositTo(ZERO, ...) as the inner call.
{
  const snap = {...C.S};
  C.S.chain = 1; C.S.token = C.ZERO;
  ok(C.destinations().length > 0, 'ETH on mainnet has destinations');
  C.S.token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  eq(C.destinations().length, 0, 'an ERC-20 has none');
  Object.assign(C.S, snap);
}

// Every chain the destination row can offer has to be probed, or the buttons
// stay disabled and captioned "awaiting deployment" whatever is really live.
{
  const bridged = C.CHAIN_IDS.filter((id) => C.BRIDGES[id]);
  ok(bridged.length > 0, 'there are bridge destinations to probe');
  ok(html.includes('CHAIN_IDS.filter(x => x!==id && BRIDGES[x])'),
    'checkDeployed probes the destination chains too, not just the active one');
}

// ─── RPC failover ──────────────────────────────────────────────────────────

// Only ask a different node about failures a different node might not have.
{
  const transient = [null, undefined, -32005, -32603, -32004, -32002, -32001, 429];
  for (const code of transient) {
    const retry = code == null || C.RETRY_CODES.has(code);
    ok(retry, `code ${code} is worth a second opinion`);
  }
  // A revert is the chain's answer. Walking five endpoints for it costs five
  // round trips to learn the same thing the first one said.
  for (const code of [3, -32000, -32602, -32601, 400]) {
    ok(!C.RETRY_CODES.has(code), `code ${code} is the chain's answer, not the node's`);
  }
  const e = C.rpcErr('execution reverted', false, 3);
  eq(e.retry, false, 'a non-retryable error says so');
  eq(e.code, 3, 'and carries its code');
  ok(C.rpcErr('timeout', true).retry, 'a transport failure is retryable');
}

// A reader's own node goes first; anything that is not plainly an https URL is
// ignored rather than trusted.
{
  const c = C.CHAINS[1];
  const snap = globalThis.localStorage.getItem('slow.rpc.1');
  eq(C.rpcPool(c), c.rpcs, 'with nothing stored the pool is the shipped one');
  globalThis.localStorage.setItem('slow.rpc.1', 'https://my.node.example');
  eq(C.rpcPool(c)[0], 'https://my.node.example', 'a stored node is tried first');
  eq(C.rpcPool(c).length, c.rpcs.length + 1, 'and the shipped pool stays behind it');
  for (const bad of ['http://insecure.example', 'javascript:alert(1)', 'not a url', '']) {
    globalThis.localStorage.setItem('slow.rpc.1', bad);
    eq(C.rpcPool(c), c.rpcs, `${bad || '(empty)'} is ignored`);
  }
  if (snap == null) globalThis.localStorage.removeItem('slow.rpc.1');
  else globalThis.localStorage.setItem('slow.rpc.1', snap);
}

// ─── Unwrap and call ───────────────────────────────────────────────────────

{
  const snap = {...C.S};
  C.S.chain = 1;
  C.S.account = '0x000000000000000000000000000000000000A11c';
  const ETH = {id: '0', token: C.ZERO, raw: 1000000000000000000n, amount: '1', symbol: 'ETH'};
  const ERC = {id: '1', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    raw: 25000000n, amount: '25', symbol: 'USDC'};
  const DEST = '0x000000000000000000000000000000000000bEEF';
  const wTo = (call) => '0x' + call.data.slice(10 + 64 + 24, 10 + 128);

  // A bare withdrawal is one call, to yourself, and needs no batching.
  {
    const r = C.exitRecipe(ERC, '', '');
    eq(r.calls.length, 1, 'no destination and no data is a single call');
    eq(r.needsAtomic, false, 'so nothing has to be atomic');
    eq(wTo(r.calls[0]).toLowerCase(), C.S.account.toLowerCase(), 'and it settles to you');
  }

  // A third-party destination is still ONE call: withdrawFrom takes an
  // arbitrary `to`, which is why none of this needed a contract change.
  {
    const r = C.exitRecipe(ERC, DEST, '');
    eq(r.calls.length, 1, 'exiting straight to someone else is still one call');
    eq(wTo(r.calls[0]).toLowerCase(), DEST.toLowerCase(), 'settling at the destination');
    eq(r.calls[0].to, C.SLOW, 'through SLOW');
    eq(r.settleTo.toLowerCase(), DEST.toLowerCase(), 'and that is what the guardian would approve');
  }

  // ERC-20 plus a call: push, then notify. The token lands at the destination
  // BEFORE the call, which is the gap the atomic requirement exists for.
  {
    const r = C.exitRecipe(ERC, DEST, '0xdeadbeef');
    eq(r.calls.length, 2, 'a call adds a second step');
    eq(wTo(r.calls[0]).toLowerCase(), DEST.toLowerCase(), 'the token goes to the destination first');
    eq(r.calls[1].to, DEST, 'then the destination is called');
    eq(r.calls[1].data, '0xdeadbeef', 'with the data given');
    eq(r.calls[1].value, 0n, 'and no value, since the asset is an ERC-20');
    eq(r.gap, true, 'the unattributed gap is flagged');
    eq(r.needsAtomic, true, 'so the pair may only be sent atomically');
  }

  // ETH plus a call is the other shape: the value rides WITH the call, so the
  // exit lands on the account first and nothing is ever unattributed.
  {
    const r = C.exitRecipe(ETH, DEST, '0xc0ffee');
    eq(r.calls.length, 2, 'still two calls');
    eq(wTo(r.calls[0]).toLowerCase(), C.S.account.toLowerCase(),
      'but the ETH comes to you, not to the destination');
    eq(r.calls[1].value, ETH.raw, 'and rides with the call');
    eq(r.gap, false, 'so there is no unattributed window');
    eq(r.settleTo.toLowerCase(), C.S.account.toLowerCase(),
      'and the guardian approves a withdrawal to you');
  }

  // SLOW must never be the destination: it is the one address where a call
  // would run with the whole pool behind it.
  ok(C.exitRecipe(ERC, C.SLOW, '0xdeadbeef').error, 'SLOW is rejected as a destination');
  ok(C.exitRecipe(ERC, C.ZERO, '').error, 'so is the zero address');
  ok(C.exitRecipe(ERC, '0xnope', '').error, 'a malformed destination is rejected');
  ok(C.exitRecipe(ERC, DEST, '0xabc').error, 'half a byte of call data is rejected');
  ok(!C.exitRecipe(ERC, DEST, '0x').error, 'an empty 0x is not call data, and is fine');
  eq(C.exitRecipe(ERC, DEST, '0x').calls.length, 1, 'and adds no second call');

  // The copyable form carries every call, and says why they belong together.
  {
    const t = C.exitText(C.exitRecipe(ERC, DEST, '0xdeadbeef'), ERC);
    ok(t.includes('call 1') && t.includes('call 2'), 'both calls are written out');
    ok(t.includes(C.SLOW) && t.includes(DEST), 'with both targets');
    ok(/atomic/i.test(t), 'and the atomicity requirement stated');
    ok(!/atomic/i.test(C.exitText(C.exitRecipe(ERC, DEST, ''), ERC)),
      'which a single call does not claim');
  }
  Object.assign(C.S, snap);
}

// ─── Bridging ──────────────────────────────────────────────────────────────
// Both rollups take value plus calldata in one L1 transaction, which is what
// makes this one step rather than bridge-then-deposit.
eq(C.L1_ALIAS, 0x1111000000000000000000000000000000001111n, 'the L1-to-L2 alias offset');
{
  const a = '0x000000000000000000000000000000000000dEaD';
  const al = C.aliasOf(a);
  eq(al, '0x111100000000000000000000000000000000efbe', 'alias adds the offset');
  eq(C.unaliasOf(al).toLowerCase(), a.toLowerCase(), 'un-alias is its inverse');
  // The offset wraps at 160 bits; an address near the top must not overflow out
  // of range.
  const hi = '0xffffffffffffffffffffffffffffffffffffffff';
  ok(/^0x[0-9a-f]{40}$/.test(C.aliasOf(hi)), 'aliasing wraps inside 160 bits');
  eq(C.unaliasOf(C.aliasOf(hi)), hi, 'and round-trips at the boundary');
}
// Routes are from Ethereum only, and name a family the page can build for.
eq(Object.keys(C.BRIDGES).sort().join(','), '4663,8453', 'routes to Base and Robinhood');
for (const [id, b] of Object.entries(C.BRIDGES)) {
  eq(b.from, 1, `chain ${id} is bridged from Ethereum`);
  ok(['op', 'arb'].includes(b.kind), `chain ${id} names a known bridge family`);
  ok(/^0x[0-9a-fA-F]{40}$/.test(b.entry), `chain ${id} has an entrypoint`);
  ok(typeof b.l2GasLimit === 'bigint' && b.l2GasLimit > 0n, `chain ${id} buys destination gas`);
  ok(C.CHAINS[id], `chain ${id} is a chain the page knows`);
}
eq(C.BRIDGES[8453].kind, 'op', 'Base is OP Stack');
eq(C.BRIDGES[4663].kind, 'arb', 'Robinhood is Arbitrum');
eq(C.BRIDGES[8453].entry, '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e', 'the Base portal');
eq(C.BRIDGES[4663].entry, '0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D', 'the Robinhood inbox');

// The bridged call must reproduce a local ETH deposit exactly: depositTo takes
// amount == 0 because the bridged ETH arrives as msg.value.
{
  const inner = C.innerDepositCalldata('0x000000000000000000000000000000000000dEaD', 86400);
  eq(inner.slice(0, 10), C.SEL.depositTo, 'the inner call is depositTo');
  eq('0x' + inner.slice(10 + 24, 10 + 64), C.ZERO, 'token is the zero address');
  eq(BigInt('0x' + inner.slice(10 + 128, 10 + 192)), 0n,
    'amount is zero — the value rides as msg.value on arrival');
  eq(BigInt('0x' + inner.slice(10 + 192, 10 + 256)), 86400n, 'the delay is carried');
}

// The destination row is gated on all three conditions, not just one.
{
  const snap = {chain: C.S.chain, token: C.S.token, deployed: C.S.slowDeployed};
  C.S.chain = 1; C.S.token = C.ZERO;
  eq(C.destinations().join(','), '8453,4663', 'from Ethereum, in ETH: both destinations offered');
  C.S.token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  eq(C.destinations().length, 0, 'an ERC-20 offers no destination — only ETH bridges here');
  C.S.token = C.ZERO; C.S.chain = 8453;
  eq(C.destinations().length, 0, 'no destinations when already off Ethereum');
  Object.assign(C.S, {chain: snap.chain, token: snap.token, slowDeployed: snap.deployed});
}

// ─── Links ─────────────────────────────────────────────────────────────────
// Routes live in the fragment because a gateway serves this document from every
// path on the contract and some rewrite the query; the fragment never reaches
// them.
globalThis.location.hash = '#/pay?to=vitalik.eth&asset=ETH&amount=0.1&delay=86400&chain=1';
let r = C.parseRoute();
eq(r.kind, 'pay', 'parses a pay route');
eq(r.q.get('to'), 'vitalik.eth', 'carries the recipient');
eq(r.q.get('amount'), '0.1', 'carries the amount');
eq(r.q.get('delay'), '86400', 'carries the delay');
eq(r.q.get('chain'), '1', 'carries the chain');

globalThis.location.hash = '#/tx/12345?chain=4663';
r = C.parseRoute();
eq(r.kind, 'tx', 'parses a transfer route');
eq(r.arg, '12345', 'carries the transfer id');
eq(r.q.get('chain'), '4663', 'carries the chain');

globalThis.location.hash = '';
eq(C.parseRoute(), null, 'no hash is no route');
globalThis.location.hash = '#/nonsense';
eq(C.parseRoute(), null, 'an unknown route is not a route');
globalThis.location.hash = '#/tx/';
eq(C.parseRoute().arg, '', 'a transfer route with no id parses but carries nothing');

// Round-trip: a link this page builds is a link this page can read.
{
  const snap = {...C.S};
  Object.assign(C.S, {chain: 4663, resolved: '0x000000000000000000000000000000000000dEaD',
    resolvedName: 'someone.eth', token: C.ZERO, symbol: 'ETH', amount: '0.25', delay: 3600});
  const link = C.payLink();
  ok(link.startsWith('https://slow.wei.limo/#/pay?'), 'pay link is built on the fragment');
  globalThis.location.hash = link.slice(link.indexOf('#'));
  const back = C.parseRoute();
  eq(back.kind, 'pay', 'the link it built parses back');
  eq(back.q.get('to'), 'someone.eth', 'recipient survives the round trip');
  eq(back.q.get('amount'), '0.25', 'amount survives');
  eq(back.q.get('delay'), '3600', 'delay survives');
  eq(back.q.get('chain'), '4663', 'chain survives');
  eq(back.q.get('asset'), 'ETH', 'native ETH is named, not addressed');
  const tl = C.txLink('987');
  eq(tl, 'https://slow.wei.limo/#/tx/987?chain=4663', 'transfer link shape');
  globalThis.location.hash = tl.slice(tl.indexOf('#'));
  eq(C.parseRoute().arg, '987', 'transfer link parses back');
  Object.assign(C.S, snap);
  globalThis.location.hash = '';
}

// ─── Keeper tip ────────────────────────────────────────────────────────────
// The estimator that shipped floored the priority fee at 1 gwei. Measured live,
// mainnet runs at 0.15 and Robinhood at 0, so with its 2x/2x buffers on top it
// overpaid by 17x and 7.6x. Gas units are identical on both chains — a bare
// value transfer is 21,000 on each — so only the price is per-chain.
eq(C.KEEPER_GAS.eth, 150000n, 'ETH claim gas units');
eq(C.KEEPER_GAS.erc20, 220000n, 'ERC-20 claim gas units');
ok(C.KEEPER_GAS.erc20 > C.KEEPER_GAS.eth, 'an ERC-20 claim costs more than an ETH one');
for (const id of C.CHAIN_IDS) {
  const c = C.CHAINS[id];
  ok(typeof c.minGasPrice === 'bigint', `chain ${id} has a gas price floor`);
  ok(typeof c.minTip === 'bigint', `chain ${id} has a tip floor`);
  ok(c.fallbackGasPrice > c.minGasPrice, `chain ${id} fallback is above its floor`);
  // A tip at the floor price must still be worth a keeper's while, and must not
  // be so large it dwarfs what it is paying for.
  const atFloor = C.KEEPER_GAS.erc20 * c.minGasPrice * 3n / 2n;
  const tip = atFloor < c.minTip ? c.minTip : atFloor;
  ok(tip >= c.minTip, `chain ${id} never tips below its floor`);
  ok(tip < 10n ** 15n, `chain ${id} floor tip stays under 0.001 ETH`);
}

// ─── Guardian ──────────────────────────────────────────────────────────────
eq(C.GUARD_DELAY, 86400, 'the guardian rotation veto window is 1 day');
const ward = '0x000000000000000000000000000000000000dEaD';
const gset = C.cd(C.SEL.setGuardian, ['address'], [ward]);
eq(gset.slice(0, 10), C.SEL.setGuardian, 'setGuardian calldata carries its selector');
eq('0x' + gset.slice(10 + 24), ward.toLowerCase(), 'setGuardian carries the address');
const appr = C.cd(C.SEL.approveTransfer, ['address', 'uint256'], [ward, 7n]);
eq(appr.length, 10 + 128, 'approveTransfer takes two words');
eq(BigInt('0x' + appr.slice(10 + 64)), 7n, 'approveTransfer carries the transfer id');
// Removal is a rotation to the zero address, not a separate entrypoint.
eq(BigInt('0x' + C.cd(C.SEL.setGuardian, ['address'], [C.ZERO]).slice(10)), 0n,
  'removing a guardian is setGuardian(0)');

// A guardian pre-authorises a prospective operation, whose id comes from
// predict*Id — not the id of a transfer that already exists. Approving the
// latter sets a flag nothing reads.
ok(C.SEL.predictWithdrawalId !== C.SEL.predictTransferId,
  'withdrawal and transfer derive different operation ids');
ok(C.SEL.approveTransfer !== C.SEL.predictWithdrawalId,
  'approving and predicting are different calls');

// ─── Tile contrast ─────────────────────────────────────────────────────────
// Robinhood's chartreuse is far too light for white text; the ink is derived
// rather than hand-maintained, so a custom token gets the same treatment.
ok(C.luminance('#000000') < C.luminance('#ffffff'), 'luminance is ordered');
eq(C.contrast('#ffffff', '#000000').toFixed(0), '21', 'contrast of black on white is 21:1');
eq(C.contrast('#777777', '#777777').toFixed(0), '1', 'a colour against itself is 1:1');
// Every tile the app ships must clear 3:1, the floor for large bold text.
for (const [sym, hex] of Object.entries(C.TOKEN_COLORS)) {
  const ratio = C.contrast(hex, C.inkOn(hex));
  ok(ratio >= 3, `${sym} ${hex} reaches ${ratio.toFixed(1)}:1 with its chosen ink`);
}
// The cases a single luminance threshold got wrong.
eq(C.inkOn('#ccff00'), '#110e08', 'chartreuse gets dark ink');
eq(C.inkOn('#ff69b4'), '#110e08', 'ETH pink gets dark ink — white on it is 2.6:1');
eq(C.inkOn('#f7931a'), '#110e08', 'cbBTC orange gets dark ink — white on it is 2.3:1');
eq(C.inkOn('#2775ca'), '#ffffff', 'USDC blue keeps white ink');
eq(C.inkOn('#4d7c0f'), '#ffffff', 'NVDA green keeps white ink');
eq(C.inkOn('hsl(210,55%,45%)'), '#ffffff', 'a hashed hsl() colour falls back to white ink');
// NVDA and USDG must not read as one colour side by side.
ok(Math.abs(C.luminance('#4d7c0f') - C.luminance('#ccff00')) > 0.3,
  'NVDA and USDG are separated by value, not just hue');

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
eq(C.CHAIN_IDS.join(','), '1,8453,4663', 'the page knows mainnet, Base and Robinhood Chain');
eq(C.CHAINS[8453].hex, '0x2105', 'Base is 8453 == 0x2105');
eq(parseInt(C.CHAINS[8453].hex, 16), 8453, 'Base hex and decimal agree');
eq(C.CHAIN_IDS.every((id) => C.CHAINS[id]), true, 'every listed id has a registry entry');
eq(Object.keys(C.CHAINS).length, C.CHAIN_IDS.length, 'no chain is defined but unlisted');
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

// Base, verified on chain.
{
  const b = C.CHAINS[8453].tokens;
  eq(b.map((t) => t.symbol).join(','), 'ETH,USDC,USDe,cbBTC,wstETH,cbETH,USDT,AERO', 'Base lists its own assets');
  eq(b.length % 4, 0, 'Base fills whole rows of four');
  eq(b.find((t) => t.symbol === 'USDC').address, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'native USDC on Base');
  eq(b.find((t) => t.symbol === 'USDC').decimals, 6, 'Base USDC has 6 decimals');
  eq(b.find((t) => t.symbol === 'cbBTC').decimals, 8, 'Base cbBTC has 8 decimals');
  eq(b.find((t) => t.symbol === 'AERO').address, '0x940181a94a35a4569e4529a3cdfb74e38fd98631', 'AERO on Base');
  // Deterministic deployments mean two of the aligned slots are literally the
  // same address across chains, which is worth pinning.
  eq(b.find((t) => t.symbol === 'USDe').address,
    C.CHAINS[4663].tokens.find((t) => t.symbol === 'USDe').address,
    'USDe is at one address on Base and Robinhood Chain');
  eq(b.find((t) => t.symbol === 'cbBTC').address,
    C.CHAINS[1].tokens.find((t) => t.symbol === 'cbBTC').address,
    'cbBTC is at one address on Base and mainnet');
  eq(C.presetsFor('AERO').join(','), '1,10,100', 'AERO gets its own ladder');
  eq(C.presetsFor('cbETH').join(','), C.presetsFor('wstETH').join(','), 'cbETH ladders at ether scale');
}

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
const m0 = (sym) => C.CHAINS[1].tokens.find((t) => t.symbol === sym);
eq(rh.map(t => t.symbol).join(','), 'ETH,USDG,USDe,cbBTC,NVDA,SPY,SPCX,GME', '4663 lists its own assets');
eq(C.CHAINS[1].tokens.map(t => t.symbol).join(','),
  'ETH,USDC,USDe,cbBTC,wstETH,WBTC,USDT,BOLD', 'mainnet lists its own assets');
eq(C.CHAINS[1].tokens.length % 4, 0, 'mainnet fills whole rows of four');

// Slot alignment: the first row means the same thing on either chain, and
// slots 1, 3 and 4 are literally the same asset.
{
  const m = C.CHAINS[1].tokens, r = C.CHAINS[4663].tokens;
  const b = C.CHAINS[8453].tokens;
  for (const slot of [0, 2, 3]) {
    eq(m[slot].symbol, r[slot].symbol, `slot ${slot + 1} is the same asset on mainnet and Robinhood`);
    eq(m[slot].symbol, b[slot].symbol, `slot ${slot + 1} is the same asset on mainnet and Base`);
    eq(m[slot].decimals, r[slot].decimals, `slot ${slot + 1} has the same decimals on mainnet and Robinhood`);
    eq(m[slot].decimals, b[slot].decimals, `slot ${slot + 1} has the same decimals on mainnet and Base`);
  }
  // Base shares more than the aligned four: mainnet's 2, 5 and 7 too.
  for (const slot of [1, 4, 6]) {
    eq(m[slot].symbol, b[slot].symbol, `slot ${slot + 1} matches mainnet on Base`);
  }
  // Slot 2 is each chain's own primary stable, so it differs by design.
  ok(m[1].symbol !== r[1].symbol, 'slot 2 is the chain\'s own primary stable');
  // The same asset is never at two different addresses within a chain.
  for (const ch of [m, r]) {
    eq(new Set(ch.map((t) => t.symbol)).size, ch.length, 'no symbol appears twice on a chain');
  }
}
// Mainnet additions, each verified on chain.
eq(m0('wstETH').address, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', 'wstETH on mainnet');
eq(m0('wstETH').decimals, 18, 'wstETH has 18 decimals');
eq(m0('WBTC').address, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 'WBTC on mainnet');
eq(m0('WBTC').decimals, 8, 'WBTC has 8 decimals, not 18');
eq(m0('cbBTC').address, '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC on mainnet');
eq(m0('cbBTC').decimals, 8, 'mainnet cbBTC has 8 decimals');
eq(m0('USDe').address, '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', 'USDe on mainnet');
// The same asset bridges to a different address, and must keep its decimals.
for (const sym of ['USDe', 'cbBTC']) {
  const a = m0(sym), b = rh.find((t) => t.symbol === sym);
  ok(a.address !== b.address, `${sym} is at a different address on each chain`);
  eq(a.decimals, b.decimals, `${sym} keeps its decimals across chains`);
  eq(C.TOKEN_COLORS[sym], C.TOKEN_COLORS[sym], `${sym} is one colour on both`);
}
eq(C.presetsFor('WBTC').join(','), C.presetsFor('cbBTC').join(','), 'both BTC assets ladder alike');
eq(C.presetsFor('wstETH').join(','), '0.01,0.1,1', 'wstETH ladders at ether scale');
eq(rh.length % 4, 0, '4663 fills whole rows of four');
eq(rh.find(t => t.symbol === 'GME').address, '0x1b0e319c6a659f002271b69db8a7df2f911c153e', 'GME on 4663');
eq(rh.find(t => t.symbol === 'cbBTC').address, '0xcec185eb182c47d1ba1efc84e6959e18cd620be4', 'cbBTC on 4663');
eq(rh.find(t => t.symbol === 'cbBTC').decimals, 8, 'cbBTC has 8 decimals, not 18');
eq(rh.find(t => t.symbol === 'SPY').address, '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', 'SPY on 4663');
eq(rh.find(t => t.symbol === 'SPCX').address, '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', 'SPCX on 4663');
eq(C.presetsFor('cbBTC').join(','), '0.001,0.01,0.1', 'cbBTC gets a bitcoin-scale ladder');
eq(C.presetsFor('SPY').join(','), C.presetsFor('NVDA').join(','), 'SPY ladders like a share');
eq(C.presetsFor('GME').join(','), C.presetsFor('NVDA').join(','), 'GME ladders like a share');
// Eight tiles side by side have to stay tellable apart. Hues are spread, and
// the one close pair is separated by value instead.
{
  const hue = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    const t = mx === r ? (g - b) / d % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((t * 60) + 360) % 360;
  };
  // EVERY tile, on EVERY chain — including native ETH, which an earlier version
  // of this loop skipped by filtering on the zero address. That exclusion is
  // how a shipped ETH/GME pair sat 20 degrees and 0.22 luminance apart unseen.
  for (const id of C.CHAIN_IDS) {
    const ts = C.CHAINS[id].tokens;
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const a = C.TOKEN_COLORS[ts[i].symbol], b = C.TOKEN_COLORS[ts[j].symbol];
        ok(a && b, `chain ${id}: ${ts[i].symbol} and ${ts[j].symbol} both have colours`);
        let dh = Math.abs(hue(a) - hue(b));
        if (dh > 180) dh = 360 - dh;
        const dl = Math.abs(C.luminance(a) - C.luminance(b));
        ok(dh > 25 || dl > 0.25,
          `chain ${id}: ${ts[i].symbol} ${a} and ${ts[j].symbol} ${b} differ in hue or value (${dh.toFixed(0)}deg, ${dl.toFixed(2)})`);
      }
    }
  }
}
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

// ─── Every styled class actually has a rule ────────────────────────────────
// The wallet picker shipped as raw browser buttons with unconstrained images
// because a stylesheet rewrite dropped `.wallet-opt` while the JS kept setting
// it. Nothing failed — it just looked broken. This is the check that would
// have caught it: every class the page assigns must resolve to a rule.
{
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const script = body;
  const declared = new Set();
  for (const m of style.matchAll(/\.([a-zA-Z][\w-]*)/g)) declared.add(m[1]);

  const assigned = new Set();
  // class="a b" in markup, outside the stylesheet
  const markup = html.slice(0, html.indexOf('<style>')) + html.slice(html.indexOf('</style>'));
  for (const m of markup.matchAll(/\bclass="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) assigned.add(c);
  }
  // className='a b' assigned in script
  for (const m of script.matchAll(/\.className\s*=\s*'([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.includes('$')) assigned.add(c);
  }
  const orphans = [...assigned].filter((c) => !declared.has(c)).sort();
  eq(orphans.join(','), '', `every assigned class has a CSS rule (orphans: ${orphans.join(', ') || 'none'})`);
}

// ─── The picker clamps whatever an extension hands it ──────────────────────
// EIP-6963 wallet icons are data URIs supplied by the extension: any size, any
// aspect. One unbounded PNG otherwise sets the row height, which is exactly
// what TronLink's did.
{
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/\.pick \.ico img\{[^}]*object-fit:contain/.test(style), 'picker images are object-fit clamped');
  ok(/\.pick \.ico img\{[^}]*width:24px[^}]*height:24px/.test(style), 'picker images are pinned to 24px');
  ok(/\.pick \.ico\{[^}]*overflow:hidden/.test(style), 'the icon cell clips anything that escapes');
  ok(/\.pick\{[^}]*grid-template-columns:24px 1fr auto/.test(style),
    'the picker row is a grid, so the icon cannot widen the label');
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`${pass} passed`);
