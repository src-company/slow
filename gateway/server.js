'use strict';

// ERC-8244 web gateway.
//
// A user visits  https://<0xADDRESS>.<yourdomain>/  and this server:
//   1. reads the contract address from the leftmost DNS label of the Host header,
//   2. asks TWO independent RPC endpoints for that contract's  html()
//      (selector 0x33c34ac3) and requires them to return identical bytes,
//   3. ABI-decodes the agreed string and serves it as the page.
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

// Checked, not trusted. Everything read off the Host header goes through
// ADDR_RE; this one came from the environment and used to go straight into an
// `eth_call` and into the fallback page's markup without either.
if (!/^0x[0-9a-f]{40}$/.test(DEFAULT_CONTRACT)) {
  console.error(`DEFAULT_CONTRACT is not an address: ${DEFAULT_CONTRACT}`);
  process.exit(1);
}

// bytes4(keccak256("html()")) — verified locally, matches ERC-8244 §Discovery.
const HTML_SELECTOR = '0x33c34ac3';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// How long one endpoint gets before it is treated as unreachable. Without this
// a single hung endpoint holds a request handler open forever: `fetch` has no
// default timeout, and the fail-over below never runs because the call it is
// waiting on never settles.
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 12000);

// The most this will read from an endpoint. `res.json()` buffers whatever it is
// sent, and the contract whose `html()` is being read is chosen by whoever
// crafts the link — so the size of the response is an attacker's parameter, not
// ours. ERC-170 caps a contract at 24,576 bytes and this document is assembled
// from SSTORE2 chunks, so a few megabytes is far past any honest answer.
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 8 * 1024 * 1024);

/* WHY TWO ENDPOINTS ANSWER EVERY REQUEST.

   This server takes bytes from a public JSON-RPC endpoint and serves them as
   `text/html` from a subdomain of whatever domain it runs on. The browser then
   executes them. So a single endpoint that lies — compromised, hijacked by DNS,
   or simply hostile — is not a wrong balance on a page. It IS the page, with
   full script access to its own origin, on a site people reached by typing your
   domain name.

   The document is immutable per block, so two independent endpoints must return
   identical bytes. Requiring that raises the bar from "any one of these
   endpoints" to "two of them agreeing", which no single compromise reaches. It
   costs one extra `eth_call` per cache miss.

   An operator who sets RPC_URL to exactly one endpoint has made a deliberate
   trust decision and gets one call; corroboration needs a pool to draw from. */
const CORROBORATE = RPCS.length > 1;

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
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) {
    throw new Error('return data is not hex');
  }
  const buf = Buffer.from(hex, 'hex');
  // EVERY FIELD HERE IS WRITTEN BY THE CONTRACT BEING READ, which is chosen by
  // whoever crafted the link. `offset` and `len` are full 256-bit words, so
  // both can name somewhere that is not in this buffer. `subarray` clamps
  // rather than throwing, so an out-of-range read used to come back as an empty
  // slice and then fail somewhere less obvious — `BigInt('0x')` throws
  // "Cannot convert", which is a confusing 404 rather than a stated reason.
  const offset = Number(BigInt('0x' + buf.subarray(0, 32).toString('hex')));
  if (!Number.isSafeInteger(offset) || offset + 32 > buf.length) {
    throw new Error('string offset is outside the return data');
  }
  const len = Number(
    BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'))
  );
  if (!Number.isSafeInteger(len) || offset + 32 + len > buf.length) {
    throw new Error('string length is outside the return data');
  }
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

// Read a response body with a hard ceiling, streaming so the cap is enforced
// BEFORE the bytes are held rather than after. `res.json()` and `res.text()`
// both buffer whatever arrives, which is the wrong shape when the size of the
// answer is chosen by someone else.
async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw transientErr(`response exceeded ${max} bytes`);
      parts.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      /* already closed */
    }
  }
  return Buffer.concat(parts, total).toString('utf8');
}

// One eth_call against a single endpoint. Throws a `transient` error for
// anything worth retrying elsewhere (network, HTTP, rate limit, node hiccup) and
// a plain error for a definitive on-chain answer (revert / empty → not ERC-8244).
// Returns the RAW result hex, so callers can compare two endpoints byte for byte
// before anything is decoded.
async function callHtml(url, contract) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: contract, data: HTML_SELECTOR }, 'latest'],
  };

  // An endpoint that accepts the connection and then says nothing would
  // otherwise hold this request open forever — `fetch` has no default timeout,
  // and the fail-over below cannot run while it is still waiting.
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);

  let res;
  try {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      throw transientErr(
        ac.signal.aborted
          ? `no answer within ${RPC_TIMEOUT_MS}ms`
          : 'transport failure — ' + e.message
      );
    }

    if (!res.ok) throw transientErr('HTTP ' + res.status);

    const text = await readCapped(res, MAX_RESPONSE_BYTES);

    let json;
    try {
      json = JSON.parse(text);
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
    return json.result;
  } finally {
    clearTimeout(kill);
  }
}

// Round-robin across the RPC pool, failing over to the next endpoint on any
// transient error. Stops immediately on a definitive on-chain answer. Returns
// `{url, result}` or `{url, definitive}` — never both.
async function oneAnswer(contract, skipUrl) {
  const start = rrCursor;
  rrCursor = (rrCursor + 1) % RPCS.length;

  let lastTransient;
  for (let k = 0; k < RPCS.length; k++) {
    const url = RPCS[(start + k) % RPCS.length];
    if (url === skipUrl) continue; // a second opinion has to come from elsewhere
    try {
      return { url, result: await callHtml(url, contract) };
    } catch (e) {
      if (!e.transient) return { url, definitive: e }; // every node will agree
      lastTransient = e;
    }
  }
  // Every endpoint failed transiently → this is a gateway/RPC outage.
  throw new Error(
    'RPC: all endpoints failed — ' + (lastTransient && lastTransient.message)
  );
}

// Two independent answers that have to agree before anything is served. See the
// note on CORROBORATE: the bytes this returns are executed by a browser as the
// page, so one endpoint's word is not enough to be worth that.
async function fetchHtml(contract) {
  const first = await oneAnswer(contract, null);
  if (!CORROBORATE) {
    if (first.definitive) throw first.definitive;
    return decodeString(first.result);
  }

  let second;
  try {
    second = await oneAnswer(contract, first.url);
  } catch (e) {
    // Nobody else could be reached. Serving the uncorroborated answer would
    // quietly drop the guarantee at exactly the moment it is hardest to notice,
    // so this fails loudly instead and the operator sees it in the logs.
    throw new Error(
      'RPC: could not corroborate the document with a second endpoint — ' + e.message
    );
  }

  // A revert at one node and a document at another is a disagreement about what
  // is deployed, not a fallback to whichever answered more usefully.
  if (!!first.definitive !== !!second.definitive) {
    throw new Error(
      `RPC: ${first.url} and ${second.url} disagree about whether ${contract} is an ERC-8244 app`
    );
  }
  if (first.definitive) throw first.definitive;

  if (first.result !== second.result) {
    throw new Error(
      `RPC: ${first.url} and ${second.url} returned different documents for ${contract} — ` +
        'refusing to serve either'
    );
  }
  return decodeString(first.result);
}

/* The headers a page assembled from somebody else's bytes has to carry.

   This host renders whatever `html()` returns, for whatever address is in the
   subdomain. That is the design — every address resolves to something — and it
   means an attacker can put a page of their choosing on a subdomain of your
   domain by deploying a contract. Origins keep it out of the real dapp's DOM;
   these keep it from doing the rest.

   ERC-8244 documents are self-contained by definition, so `script-src` and
   `style-src` allow inline and nothing else: no CDN, no remote import, and
   nothing a page could be talked into loading later. `connect-src https:` is
   the one opening a real dapp needs, for its own RPC reads.

   WHAT THIS DOES NOT FIX, so it is not mistaken for complete: a page here can
   still set a cookie scoped to `.yourdomain` and have the apex send it back.
   Nothing a response header does prevents that. Serve untrusted contracts from
   a domain that is not the one your own app or session cookies live on. */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: https:',
    'font-src data:',
    'connect-src https:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  // For user agents that predate frame-ancestors.
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

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
      ...SECURITY_HEADERS,
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
      res.writeHead(404, {
        'content-type': 'text/html; charset=utf-8',
        ...SECURITY_HEADERS,
      });
      res.end(fallbackPage(contract, msg));
    }
  }
});

server.listen(PORT, () => {
  console.log(`w4eth gateway listening on :${PORT}`);
  console.log(`  rpc pool (${RPCS.length}): ${RPCS.join(', ')}`);
  console.log(`  default contract: ${DEFAULT_CONTRACT}`);
  console.log(
    CORROBORATE
      ? '  documents are corroborated against a second endpoint before serving'
      : '  SINGLE ENDPOINT: documents are served on one node\'s word alone'
  );
});
