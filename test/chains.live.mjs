/**
 * Live checks for the chain registry in dapp/page.html, against real nodes.
 *
 * Everything the page assumes about a chain is asserted here rather than
 * trusted: that its RPCs answer, that they answer with the chain id the
 * registry claims, that Multicall3 is at the canonical address and speaks
 * aggregate3 through the page's own encoder and decoder, and that every listed
 * token has code and reports the symbol and decimals the registry pins.
 *
 * It also asserts the fact that shapes the design: .eth does not resolve on
 * Robinhood Chain — the registry contract is there but empty — which is why
 * name resolution is pinned to mainnet.
 *
 *   node test/chains.live.mjs
 *
 * Needs network. Skips a chain cleanly if its RPCs are unreachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'dapp/page.html'), 'utf8');
const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cutAt = body.indexOf('   Wiring');
const logic = body.slice(body.indexOf('{') + 1, body.lastIndexOf('/*', cutAt));

// ─── Minimal DOM, same shape as page.test.mjs ──────────────────────────────
const noop = () => {};
const stubEl = () => ({
  textContent: '', className: '', style: {}, dataset: {}, hidden: false,
  classList: {add: noop, remove: noop, toggle: noop, contains: () => false},
  setAttribute: noop, appendChild: noop, append: noop, replaceChildren: noop,
  addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  focus: noop, getBoundingClientRect: () => ({top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0}),
});
globalThis.localStorage = {getItem: () => null, setItem: noop, removeItem: noop};
globalThis.matchMedia = () => ({matches: false, addEventListener: noop});
globalThis.document = {
  body: stubEl(), hidden: false, activeElement: null,
  querySelector: () => null, querySelectorAll: () => [],
  createElement: stubEl, addEventListener: noop,
};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.dispatchEvent = noop;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.innerWidth = 1024;

const captured = {};
globalThis.__capture = captured;
new Function(`${logic}\n;Object.assign(globalThis.__capture,{
  CHAINS, CHAIN_IDS, SLOW, ZERO, MC3, ENS_REG, WNS, SEL, MAINNET,
  TOPIC_GUARDIAN_SET, word,
  encAggregate3, decAggregate3, decode, cd, decodeStringLoose,
});`)();
const C = captured;

// ─── Runner ────────────────────────────────────────────────────────────────
let pass = 0, skipped = 0;
const failures = [];
const eq = (a, b, msg) => {
  if (a === b) pass++;
  else failures.push(`  ${msg}\n    got:    ${a}\n    expect: ${b}`);
};
const ok = (c, msg) => eq(!!c, true, msg);

const post = async (url, method, params) => {
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: ac.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } finally { clearTimeout(kill); }
};

const codeSize = (hex) => (!hex || hex === '0x') ? 0 : (hex.length - 2) / 2;

for (const id of C.CHAIN_IDS) {
  const c = C.CHAINS[id];
  console.log(`\n── ${c.name} (chain ${c.id}) ──`);

  // Find a reachable endpoint from the registry's own pool.
  let rpcUrl = null;
  for (const url of c.rpcs) {
    try { await post(url, 'eth_chainId', []); rpcUrl = url; break; } catch (e) { /* next */ }
  }
  if (!rpcUrl) {
    console.log(`  skip  no RPC in the registry answered`);
    skipped++;
    continue;
  }
  const call = (to, data) => post(rpcUrl, 'eth_call', [{to, data}, 'latest']);

  // The pool must be the chain it claims to be.
  const seen = await post(rpcUrl, 'eth_chainId', []);
  eq(parseInt(seen, 16), c.id, `${c.short}: RPC reports chain ${c.id}`);
  eq(seen.toLowerCase(), c.hex.toLowerCase(), `${c.short}: registry hex id matches the node`);

  // Multicall3 must be at the canonical address, or read batching silently
  // has nothing to talk to.
  const mcCode = await post(rpcUrl, 'eth_getCode', [C.MC3, 'latest']);
  ok(codeSize(mcCode) > 0, `${c.short}: Multicall3 is deployed at the canonical address`);

  // Batch every listed token's symbol() and decimals() through the page's own
  // aggregate3 encoder, and decode the result with its own decoder.
  const erc20 = c.tokens.filter((t) => t.address !== C.ZERO);
  const calls = erc20.flatMap((t) => [
    {to: t.address, data: C.SEL.symbol},
    {to: t.address, data: C.SEL.decimals},
  ]);
  const raw = await call(C.MC3, C.encAggregate3(calls));
  const out = C.decAggregate3(raw);
  eq(out.length, calls.length, `${c.short}: aggregate3 returned one entry per call`);
  erc20.forEach((t, i) => {
    const sym = out[i * 2] ? C.decodeStringLoose(out[i * 2]) : null;
    const dec = out[i * 2 + 1] ? Number(C.decode(['uint256'], out[i * 2 + 1])[0]) : null;
    eq(sym, t.symbol, `${c.short}: ${t.symbol} at ${t.address} reports its symbol`);
    eq(dec, t.decimals, `${c.short}: ${t.symbol} reports ${t.decimals} decimals`);
  });

  // A usable label and a ladder for every asset the chain offers.
  for (const t of c.tokens) {
    // Tiles carry no colour any more: identity is the symbol, so what has to
    // hold on chain is that the symbol we print is the symbol the token reports.
    ok(t.symbol.length > 0 && t.symbol.length <= 7, `${c.short}: ${t.symbol} is a usable tile label`);
  }

  // SLOW's address is canonical; the BUILD at it is not.
  //
  // Base is the reason this checks selectors rather than code length. Before it
  // was redeployed, the canonical address there held a genuine but older SLOW —
  // name() answered "SLOW", depositTo and guardians were present, and the
  // transfer enumeration the page depends on was not. Code length alone says
  // "deployed" and means nothing.
  const slowCode = await post(rpcUrl, 'eth_getCode', [C.SLOW, 'latest']);
  const size = codeSize(slowCode);
  const NEEDED = {
    depositTo: C.SEL.depositTo, getOutbound: C.SEL.getOut, getInbound: C.SEL.getIn,
    pendingTransfers: C.SEL.pendingTransfers, guardians: C.SEL.guardians,
  };
  const missing = Object.entries(NEEDED)
    .filter(([, sel]) => !slowCode.includes(sel.slice(2))).map(([n]) => n);
  console.log(`  info  SLOW at ${C.SLOW}: ${size ? `${size.toLocaleString()} B` : 'not deployed'}` +
    (size && missing.length ? ` — WRONG BUILD, missing ${missing.join(', ')}` : size ? ' — speaks this page\'s ABI' : ''));
  if (id === C.MAINNET) {
    ok(size > 0, 'mainnet: SLOW is deployed');
    eq(missing.join(','), '', 'mainnet: SLOW carries every selector the page calls');
  }

  // Can this chain's pool serve the ward-discovery log query at all?
  //
  // Not a pass/fail: the answer decides whether the interface can offer a scan,
  // and it is why user input is the primary mechanism rather than a fallback.
  // On the mainnet pool exactly one of five endpoints serves it — publicnode
  // refuses getLogs outright, 1rpc caps the range at fifty blocks, pokt rejects
  // 50k as too large.
  if (c.deployBlock !== undefined) {
    let served = 0;
    for (const url of c.rpcs) {
      try {
        const r = await post(url, 'eth_getLogs', [{
          address: C.SLOW,
          topics: [C.TOPIC_GUARDIAN_SET],
          fromBlock: '0x' + (c.deployBlock || 0).toString(16),
          toBlock: 'latest',
        }]);
        if (Array.isArray(r)) served++;
      } catch (e) { /* expected on most */ }
    }
    console.log(`  info  eth_getLogs over full history: ${served}/${c.rpcs.length} endpoints`);
    ok(true, `${c.short}: log availability measured, not assumed`);
  }

  // Name resolution is pinned to mainnet, and this is the check that says why.
  //
  // Presence of the registry CONTRACT is not the test. On Robinhood Chain the
  // ENS registry has been deterministic-deployed to its canonical address and
  // has real code — but it is empty: resolver(namehash('eth')) is the zero
  // address. A dapp that resolved against the active chain would therefore not
  // fail loudly on a .eth name there; it would report that a perfectly valid
  // name does not exist. That silent wrong answer is worse than an absent
  // contract, and it is the reason these reads go to chain 1 unconditionally.
  const ensCode = codeSize(await post(rpcUrl, 'eth_getCode', [C.ENS_REG, 'latest']));
  const wnsCode = codeSize(await post(rpcUrl, 'eth_getCode', [C.WNS, 'latest']));
  // namehash('eth')
  const ethNode = '93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';
  const resolverOf = async () => {
    if (!ensCode) return C.ZERO;
    try {
      const r = await call(C.ENS_REG, C.SEL.resolver + ethNode);
      return (!r || r === '0x') ? C.ZERO : '0x' + r.slice(-40);
    } catch (e) { return C.ZERO; }
  };
  const ethResolver = await resolverOf();
  if (id === C.MAINNET) {
    ok(ensCode > 0, 'mainnet: the ENS registry is present');
    ok(wnsCode > 0, 'mainnet: the WNS registry is present');
    ok(ethResolver !== C.ZERO, 'mainnet: the ENS registry resolves .eth');
  } else {
    console.log(`  info  ENS registry: ${ensCode ? `${ensCode.toLocaleString()} B but empty` : 'absent'}` +
      `; WNS: ${wnsCode ? `${wnsCode.toLocaleString()} B` : 'absent'}`);
    ok(ethResolver === C.ZERO,
      `${c.short}: .eth does not resolve here — names must be read on mainnet`);
    ok(wnsCode === 0, `${c.short}: no WNS registry`);
  }
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failing:\n${failures.join('\n')}\n`);
  console.error(`${pass} passed, ${failures.length} failed${skipped ? `, ${skipped} chain(s) skipped` : ''}`);
  process.exit(1);
}
console.log(`${pass} passed${skipped ? `, ${skipped} chain(s) skipped (unreachable)` : ''}`);
