'use strict';

// ERC-8244 web gateway.
//
// A user visits  https://<0xADDRESS>.<yourdomain>/  and this server:
//   1. reads the contract address from the leftmost DNS label of the Host header,
//   2. makes ONE eth_call to that contract's  html()  (selector 0x33c34ac3),
//   3. ABI-decodes the returned string and serves it as the page.
//
// The on-chain document is fully self-contained (ERC-8244 requires no external
// resources), so the browser renders the real dapp with no other hosting.
//
// Zero npm dependencies — only Node's built-in http + global fetch (Node >= 18).

const http = require('http');

// --- config --------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Public mainnet RPCs that need NO API key and were verified to return the full
// html() payload. The gateway round-robins across these and fails over to the
// next on any transient (network / rate-limit / node) error, so it boots and
// works with zero configuration.
const PUBLIC_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
];

// Optional override. Set RPC_URL to your own endpoint (e.g. Alchemy/Infura) for
// higher rate limits; comma-separate to supply several. Your endpoints are tried
// first, with the public pool kept as automatic fallback.
const RPCS = [
  ...(process.env.RPC_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ...PUBLIC_RPCS,
];

// Fallback contract for hosts that are NOT an address (e.g. the bare apex, or a
// vanity host like slow.example). Optional. Defaults to the SLOW deployment.
const DEFAULT_CONTRACT =
  (process.env.DEFAULT_CONTRACT ||
    '0x000000000000888741b254d37e1b27128afeaabc').toLowerCase();

// bytes4(keccak256("html()")) — verified locally, matches ERC-8244 §Discovery.
const HTML_SELECTOR = '0x33c34ac3';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Round-robin cursor: each request starts at the next endpoint to spread load.
let rrCursor = 0;

// Error tags: `transient` errors trigger fail-over to the next RPC; everything
// else is a definitive answer from the chain (revert / no html()) and is not
// worth retrying against other nodes — they'd all say the same thing.
function transientErr(msg) {
  return Object.assign(new Error(msg), { transient: true });
}

// --- helpers -------------------------------------------------------------------

// Pull the target contract out of the Host header. The leftmost label wins if it
// looks like an address; otherwise we fall back to DEFAULT_CONTRACT.
function contractFromHost(hostHeader) {
  if (!hostHeader) return DEFAULT_CONTRACT;
  const host = hostHeader.split(':')[0]; // strip any :port
  const label = host.split('.')[0];
  return ADDR_RE.test(label) ? label.toLowerCase() : DEFAULT_CONTRACT;
}

// Decode a single `string` return value from an eth_call result.
// Layout: [32-byte offset][32-byte length][UTF-8 bytes, right-padded].
function decodeString(resultHex) {
  const hex = resultHex.startsWith('0x') ? resultHex.slice(2) : resultHex;
  if (hex.length < 128) throw new Error('short return data');
  const buf = Buffer.from(hex, 'hex');
  const offset = Number(BigInt('0x' + buf.subarray(0, 32).toString('hex')));
  const len = Number(
    BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'))
  );
  return buf.subarray(offset + 32, offset + 32 + len).toString('utf8');
}

// Minimal self-contained HTML shown when a subdomain points at an address that
// isn't a valid ERC-8244 host (no html(), reverts, or not a contract at all).
// Keeps the "every address resolves to *something*" promise instead of a raw 500.
function fallbackPage(contract, detail) {
  const safe = String(detail).replace(/[<>&]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not an ERC-8244 app</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
background:#000;color:#fff;text-align:center;padding:2rem}
.card{max-width:34rem}
h1{font-size:1.25rem;margin:0 0 .75rem}
code{background:#1a1a1a;padding:.15rem .4rem;border-radius:4px;word-break:break-all}
p{color:#aaa;margin:.75rem 0}
a{color:#fff}
</style></head><body><div class="card">
<h1>No on-chain app here</h1>
<p><code>${contract}</code></p>
<p>This address does not implement <a href="https://eips.ethereum.org/">ERC-8244</a>
<code>html()</code>, so there's no self-hosted dapp to render.</p>
<p style="font-size:.85rem;color:#666">${safe}</p>
</div></body></html>`;
}

// One eth_call against a single endpoint. Throws a `transient` error for
// anything worth retrying elsewhere (network, HTTP, rate limit, node hiccup) and
// a plain error for a definitive on-chain answer (revert / empty → not ERC-8244).
async function callHtml(url, contract) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contract, data: HTML_SELECTOR }, 'latest'],
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw transientErr('transport failure — ' + e.message);
  }

  if (!res.ok) throw transientErr('HTTP ' + res.status);

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw transientErr('malformed JSON response');
  }

  if (json.error) {
    const msg = (json.error.message || JSON.stringify(json.error)).toLowerCase();
    // A revert is deterministic across nodes → definitive "not ERC-8244".
    if (msg.includes('revert')) {
      throw new Error('contract reverted — no ERC-8244 html()');
    }
    // Rate limits / internal node errors are node-specific → try the next one.
    throw transientErr('node error — ' + (json.error.message || 'unknown'));
  }

  if (!json.result || json.result === '0x') {
    throw new Error('contract returned no data — does it implement html()?');
  }
  return decodeString(json.result);
}

// Round-robin across the RPC pool, failing over to the next endpoint on any
// transient error. Stops immediately on a definitive on-chain answer.
async function fetchHtml(contract) {
  const start = rrCursor;
  rrCursor = (rrCursor + 1) % RPCS.length;

  let lastTransient;
  for (let k = 0; k < RPCS.length; k++) {
    const url = RPCS[(start + k) % RPCS.length];
    try {
      return await callHtml(url, contract);
    } catch (e) {
      if (!e.transient) throw e; // definitive — every node will agree
      lastTransient = e;
    }
  }
  // Every endpoint failed transiently → this is a gateway/RPC outage.
  throw new Error(
    'RPC: all endpoints failed — ' + (lastTransient && lastTransient.message)
  );
}

// --- server --------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  const contract = contractFromHost(req.headers.host);

  try {
    const html = await fetchHtml(contract);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The document is immutable per block; let clients cache briefly.
      'cache-control': 'public, max-age=60',
      // Defense in depth — the on-chain doc is self-contained anyway.
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  } catch (err) {
    const msg = String(err.message || err);
    // Whole RPC pool down is *our* problem → 502 plaintext so it's obvious in
    // logs/monitoring. Anything else (revert, no html(), not a contract) is just
    // "this address isn't an ERC-8244 app" → render a clean 404 page so the
    // subdomain still resolves to something in a browser.
    if (msg.startsWith('RPC:')) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Gateway error for ${contract}\n${msg}\n`);
    } else {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fallbackPage(contract, msg));
    }
  }
});

server.listen(PORT, () => {
  console.log(`w4eth gateway listening on :${PORT}`);
  console.log(`  rpc pool (${RPCS.length}): ${RPCS.join(', ')}`);
  console.log(`  default contract: ${DEFAULT_CONTRACT}`);
});
