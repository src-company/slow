#!/usr/bin/env node
/**
 * The RPC pool, against a server that fails the way the real ones do.
 *
 * These are not hypothetical faults. Each mock below reproduces a refusal
 * observed from a public endpoint while building the relayer, and the point of
 * the pool is that none of them stops a scan:
 *
 *   "Internal error"                    cloudflare-eth, on every getLogs
 *   "limited to 0 - 50 blocks range"    1rpc, a range cap stated in the error
 *   "Too Many Requests"                 Robinhood, on a four-chunk scan
 *   HTTP 200 with an HTML body          llamarpc behind a challenge page
 *
 * The interesting property is that every one of these arrives as a successful
 * HTTP response. A failover that watches the transport sees four healthy
 * servers; this one has to read the answer.
 */
import http from 'node:http';
import { createPool } from '../relayer/rpc.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { c ? pass++ : (fail++, console.error('  FAIL  ' + what)); };
const eq = (a, b, what) => ok(a === b, `${what} (got ${a}, want ${b})`);

/** A mock endpoint. `mode` decides how it misbehaves. Counts what it was asked. */
function server(mode) {
  const state = { calls: 0, seen: 0, rateLeft: mode === 'ratelimit' ? 2 : 0, maxSpan: 50 };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.calls++;
      const { method, params } = JSON.parse(body);
      const send = (o, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...o }));
      };
      if (method === 'eth_blockNumber') return send({ result: '0x3e8' });
      if (mode === 'broken') return send({ error: { code: -32603, message: 'Internal error' } });
      // Fails its FIRST getLogs, then recovers — an endpoint that hiccups and
      // is put in cooldown while still being the pool's best remaining option.
      if (mode === 'failfirst' && ++state.seen === 1) return send({ error: { code: -1, message: 'Internal error' } });
      // Works once, then fails — so the pass that lands on it second has to
      // reach past the endpoints already cooling.
      if (mode === 'failsecond' && ++state.seen === 2) return send({ error: { code: -1, message: 'Internal error' } });
      if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html>nope'); }
      if (mode === 'ratelimit' && state.rateLeft-- > 0) {
        return send({ error: { code: -32005, message: 'Too Many Requests' } });
      }
      const from = BigInt(params[0].fromBlock), to = BigInt(params[0].toBlock);
      if (to - from + 1n > BigInt(state.maxSpan)) {
        return send({ error: { code: -32602, message: `eth_getLogs is limited to 0 - ${state.maxSpan} blocks range` } });
      }
      // One log per block, so the caller can prove nothing was skipped.
      const logs = [];
      for (let b = from; b <= to; b++) logs.push({ blockNumber: '0x' + b.toString(16), data: '0x', topics: [] });
      send({ result: logs });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, state, url: `http://127.0.0.1:${srv.address().port}` })));
}

const broken = await server('broken');
const html = await server('html');
const capped = await server('capped');
const limited = await server('ratelimit');

// ── 1. a pool routes around endpoints that answer with an error ───────────
{
  const pool = createPool([broken.url, html.url, capped.url], { maxSpan: 500, pacingMs: 0 });
  const logs = await pool.getLogs({ address: '0x0', topics: [], fromBlock: 1n, toBlock: 200n });
  eq(logs.length, 200, 'every block in the range is covered despite two bad endpoints');
  const seen = new Set(logs.map((l) => BigInt(l.blockNumber)));
  eq(seen.size, 200, 'no block is returned twice or skipped');
  const cap = pool.stats().find((s) => s.url === capped.url);
  ok(cap.span <= 50, `the capped endpoint learned its real span (now ${cap.span})`);
}

// ── 2. a rate limit is waited out, not written off ────────────────────────
{
  const pool = createPool([limited.url], { maxSpan: 50, pacingMs: 0 });
  const logs = await pool.getLogs({ address: '0x0', topics: [], fromBlock: 1n, toBlock: 40n });
  eq(logs.length, 40, 'a sole rate-limited endpoint still completes the scan');
  ok(limited.state.calls > 1, 'it was retried rather than abandoned after one 429');
}

// ── 3. a pool with nothing working reports, rather than returning silence ──
{
  const pool = createPool([broken.url, html.url], { maxSpan: 50, pacingMs: 0 });
  let threw = null;
  try { await pool.getLogs({ address: '0x0', topics: [], fromBlock: 1n, toBlock: 10n }); }
  catch (e) { threw = e; }
  ok(threw !== null, 'an unanswerable range throws instead of returning []');
  ok(threw && /Internal error/.test(threw.message), 'the failure names what each endpoint actually said');
}

// ── 4. send() fails over too ──────────────────────────────────────────────
{
  const pool = createPool([broken.url, capped.url], { pacingMs: 0 });
  eq(BigInt(await pool.send('eth_blockNumber', [])), 1000n, 'send() gets an answer past a broken endpoint');
}

// ── 5. cooldown must DEPRIORITISE, not exclude ────────────────────────────
// Two endpoints hiccup and go into cooldown; the third then fails on its own
// second call. If cooldown removed the first two from the pass, the only
// candidate left is the one that just failed and the scan dies with two
// recovered endpoints sitting unasked.
{
  const a = await server('failfirst');
  const b = await server('failfirst');
  const c = await server('failsecond');
  const pool = createPool([a.url, b.url, c.url], { maxSpan: 50, pacingMs: 0 });
  let threw = null, logs = [];
  try { logs = await pool.getLogs({ address: '0x0', topics: [], fromBlock: 1n, toBlock: 100n }); }
  catch (e) { threw = e; }
  ok(threw === null, 'a pass reaches past endpoints in cooldown' + (threw ? ` (threw: ${threw.message.slice(0,90)})` : ''));
  eq(logs.length, 100, 'and still covers the whole range');
  for (const s of [a, b, c]) s.srv.close();
}

for (const s of [broken, html, capped, limited]) s.srv.close();
console.log(`rpc pool: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
