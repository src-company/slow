/**
 * The gateway, against fake RPC endpoints.
 *
 * It had no tests, and the properties worth having are ones you cannot see by
 * reading it: that a hung endpoint does not hang the request, that a lying
 * endpoint cannot put a page on your domain by itself, and that a document
 * nobody disputes still gets served.
 *
 *   node --test test/gateway.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'gateway/server.js');
const ADDR = '0x000000000000888741b254d37e1b27128afeaabc';

/** ABI-encode one string exactly as `html()` returns it. */
function encodeString(s) {
  const body = Buffer.from(s, 'utf8');
  const pad = (body.length + 31) & ~31;
  const w = (n) => n.toString(16).padStart(64, '0');
  return '0x' + w(32) + w(body.length) + Buffer.concat([body, Buffer.alloc(pad - body.length)]).toString('hex');
}

/** A fake JSON-RPC node. `behave` decides what it answers. */
async function fakeNode(behave) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => behave(res, raw));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close()};
}

const answers = (doc) => (res) => {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({jsonrpc: '2.0', id: 1, result: encodeString(doc)}));
};
const hangs = () => () => {}; // accepts, never replies

/** Boot the gateway against a specific pool and make one request. */
async function serve(pool, {timeout = '2000'} = {}) {
  const port = 3000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: {...process.env, PORT: String(port), RPC_URL: pool.join(','), RPC_TIMEOUT_MS: timeout},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('listening') && resolve());
      child.on('error', reject);
      setTimeout(() => reject(new Error('gateway did not start')), 8000);
    });
    const r = await fetch(`http://127.0.0.1:${port}/`, {headers: {host: `${ADDR}.example.test`}});
    return {status: r.status, body: await r.text(), headers: r.headers};
  } finally {
    child.kill('SIGKILL');
  }
}

test('serves a document two endpoints agree on', async () => {
  const a = await fakeNode(answers('<h1>hello</h1>'));
  const b = await fakeNode(answers('<h1>hello</h1>'));
  try {
    const r = await serve([a.url, b.url]);
    assert.equal(r.status, 200);
    assert.match(r.body, /<h1>hello<\/h1>/);
  } finally { a.close(); b.close(); }
});

test('refuses to serve a document only one endpoint claims', async () => {
  // The whole point. One compromised endpoint would otherwise put this page on
  // a subdomain of the operator's domain, with script access to that origin.
  const honest = await fakeNode(answers('<h1>the real dapp</h1>'));
  const liar = await fakeNode(answers('<script>steal()</script>'));
  try {
    const r = await serve([liar.url, honest.url]);
    assert.equal(r.status, 502, 'a disagreement is a gateway error, not a page');
    assert.match(r.body, /different documents/);
    assert.doesNotMatch(r.body, /steal\(\)/, 'and neither version is served');
  } finally { honest.close(); liar.close(); }
});

test('a hung endpoint fails over instead of hanging the request', async () => {
  const dead = await fakeNode(hangs());
  const a = await fakeNode(answers('<h1>ok</h1>'));
  const b = await fakeNode(answers('<h1>ok</h1>'));
  try {
    const t0 = Date.now();
    const r = await serve([dead.url, a.url, b.url], {timeout: '600'});
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.ok(Date.now() - t0 < 20000, 'and did not wait on the dead one forever');
  } finally { dead.close(); a.close(); b.close(); }
});

test('the served page carries the headers that contain it', async () => {
  const a = await fakeNode(answers('<h1>hi</h1>'));
  const b = await fakeNode(answers('<h1>hi</h1>'));
  try {
    const r = await serve([a.url, b.url]);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*https:/, 'no remote scripts, ever');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  } finally { a.close(); b.close(); }
});

test('a contract with no html() renders the fallback, not a crash', async () => {
  const revert = () => (res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({jsonrpc: '2.0', id: 1, error: {code: 3, message: 'execution reverted'}}));
  };
  const a = await fakeNode(revert());
  const b = await fakeNode(revert());
  try {
    const r = await serve([a.url, b.url]);
    assert.equal(r.status, 404);
    assert.match(r.body, /No on-chain app here/);
  } finally { a.close(); b.close(); }
});

test('malformed return data is refused rather than half-decoded', async () => {
  // An offset pointing outside the buffer used to come back as an empty slice
  // and fail later with "Cannot convert 0x to a BigInt".
  const bad = () => (res) => {
    const w = (n) => n.toString(16).padStart(64, '0');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({jsonrpc: '2.0', id: 1, result: '0x' + w(2 ** 40) + w(4) + w(0)}));
  };
  const a = await fakeNode(bad());
  const b = await fakeNode(bad());
  try {
    const r = await serve([a.url, b.url]);
    assert.equal(r.status, 404);
    assert.match(r.body, /outside the return data/);
  } finally { a.close(); b.close(); }
});

/* ── index.html, the client-only twin ──────────────────────────────────────
   Same trust question, higher stakes: the gateway SERVES the bytes, this one
   EXECUTES them on the reader's origin. The loader is extracted and run against
   fake endpoints, with just enough DOM to reach the decision. */

async function runLoader(results) {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const outer = src.slice(src.indexOf('<script>') + 8, src.lastIndexOf('</script>'));
  // The BODY of the loader's IIFE, not the IIFE. Wrapping the whole statement
  // in another async function returns before the inner one has run, so the
  // assertions raced it — two of these three passed on microtask ordering
  // rather than on anything the loader did.
  const open = '(async()=>{';
  const script = outer.slice(outer.indexOf(open) + open.length, outer.lastIndexOf('})()'));

  let shown = '';
  let executed = false;
  const doc = {
    body: {set textContent(v) { shown = v; }, get textContent() { return shown; }},
    documentElement: {replaceWith: () => { executed = true; }},
    adoptNode: (x) => x,
    querySelectorAll: () => [],
    createElement: () => ({setAttribute: () => {}, attributes: [], replaceWith: () => {}}),
  };
  const calls = [];
  const fakeFetch = (url) => {
    const answer = results[calls.length];
    calls.push(url);
    if (answer === null) return Promise.reject(new Error('down'));
    return Promise.resolve({ok: true, json: () => Promise.resolve({result: answer})});
  };
  const fn = new Function('document', 'fetch', 'DOMParser', 'TextDecoder', 'AbortController',
    'setTimeout', 'clearTimeout',
    `return (async()=>{ ${script} })()`);
  await fn(doc, fakeFetch, class { parseFromString() { return {documentElement: {}}; } },
    TextDecoder, AbortController, setTimeout, clearTimeout);
  return {shown, executed};
}

test('index.html executes a document two nodes agree on', async () => {
  const doc = encodeString('<html><body>real</body></html>');
  const r = await runLoader([doc, doc, doc, doc]);
  assert.equal(r.executed, true, r.shown);
});

test('index.html executes NOTHING when one node disagrees', async () => {
  const real = encodeString('<html><body>real</body></html>');
  const evil = encodeString('<html><body>evil</body></html>');
  // One liar, one honest, two down: no pair agrees.
  const r = await runLoader([evil, real, null, null]);
  assert.equal(r.executed, false, 'the page must not be replaced');
  assert.match(r.shown, /disagree|Only 2 of/);
});

test('index.html refuses when only one node answers', async () => {
  const doc = encodeString('<html><body>real</body></html>');
  const r = await runLoader([doc, null, null, null]);
  assert.equal(r.executed, false);
  assert.match(r.shown, /Only 1 of 4/);
});
