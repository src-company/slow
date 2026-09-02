/**
 * Shared plumbing for the dapp build. Modelled on the ERC-8244 reference dapps
 * at github.com/ERC8244/dapps: the manifest is the release gate, and every
 * command re-reads the page and refuses to run if it has drifted from the pin.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** EIP-170 runtime code limit. One byte of it is the STOP prefix. */
export const EIP170 = 24576;
export const MAX_PAYLOAD = EIP170 - 1;

export const loadManifest = () => {
  const file = path.join(ROOT, 'manifest.json');
  if (!fs.existsSync(file)) {
    console.error('no manifest.json at the repo root');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

/**
 * The page, checked against what the manifest says it is.
 *
 * Editing the page without editing the manifest fails every command on purpose:
 * a chunk set built from a page nobody pinned is how a deployment stops
 * matching its repo. Changing the page is a two-line manifest change in the
 * same commit, and it shows up in review as one.
 */
export const readPage = (m) => {
  const file = path.join(ROOT, m.page);
  if (!fs.existsSync(file)) {
    console.error(`page not found: ${m.page}`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== m.bytes || sha256 !== m.sha256) {
    console.error(
      `${m.page} is ${bytes.length} B / sha256 ${sha256}\n` +
      `manifest pins  ${m.bytes} B / sha256 ${m.sha256}\n` +
      `\nIf this is the new release, update manifest.json deliberately:\n` +
      `  "bytes": ${bytes.length},\n  "sha256": "${sha256}",`
    );
    process.exit(1);
  }
  return {bytes, sha256};
};

/**
 * PUSH2 <len> DUP1 PUSH1 0x0a PUSH0 CODECOPY PUSH0 RETURN | <runtime>
 * The classic data-contract stub: it returns the payload as runtime code, with
 * no Solidity constructor ABI overhead.
 */
const stub = (len) => Buffer.from(`61${len.toString(16).padStart(4, '0')}80600a5f395ff3`, 'hex');

/**
 * Split the page into chunk runtimes and their deployable initcode.
 *
 * Byte zero of every runtime is STOP, so a chunk address can never be mistaken
 * for a callable contract. It is not part of the page and reassembly skips it.
 */
export const split = (bytes, maxPayload = MAX_PAYLOAD) => {
  const count = Math.ceil(bytes.length / maxPayload);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const payload = bytes.subarray(i * maxPayload, Math.min((i + 1) * maxPayload, bytes.length));
    if (!payload.length) continue;
    const runtime = Buffer.concat([Buffer.from([0x00]), payload]);
    if (runtime.length > EIP170) {
      console.error(`chunk ${i + 1} is ${runtime.length} B, over EIP-170 (${EIP170})`);
      process.exit(1);
    }
    parts.push({n: i + 1, payload, runtime, initcode: Buffer.concat([stub(runtime.length), runtime])});
  }
  // A missing or duplicated chunk would serve broken HTML forever, and the
  // wrapper's constructor rejects both. Catch it here rather than at a deploy.
  if (parts.length !== count) {
    console.error(`produced ${parts.length} non-empty chunks, not ${count}`);
    process.exit(1);
  }
  if (new Set(parts.map((p) => p.runtime.toString('hex'))).size !== count) {
    console.error('two chunks are byte-identical — the wrapper would reject this set');
    process.exit(1);
  }
  if (!Buffer.concat(parts.map((p) => p.payload)).equals(bytes)) {
    console.error('chunks do not reassemble to the page');
    process.exit(1);
  }
  return parts;
};

// ─── keccak256, for the page commitment the wrapper checks ─────────────────
const M64 = (1n << 64n) - 1n;
const RC = [1n, 32898n, 9223372036854808714n, 9223372039002292224n, 32907n, 2147483649n,
  9223372039002292353n, 9223372036854808585n, 138n, 136n, 2147516425n, 2147483658n, 2147516555n,
  9223372036854775947n, 9223372036854808713n, 9223372036854808579n, 9223372036854808578n,
  9223372036854775936n, 32778n, 9223372039002259466n, 9223372039002292353n, 9223372036854808704n,
  2147483649n, 9223372039002292232n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotL = (x, n) => ((x << n) | (x >> (64n - n))) & M64;
const kF = (s) => {
  for (let r = 0; r < 24; r++) {
    const C = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    const D = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotL(C[(x + 1) % 5], 1n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D[x];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotL(s[x + 5 * y], BigInt(ROT[x + 5 * y]));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = (B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y]) & B[((x + 2) % 5) + 5 * y])) & M64;
    s[0] ^= RC[r];
  }
};
export const keccak256 = (bytes) => {
  const R = 136, s = new Array(25).fill(0n);
  let p = 0;
  while (p + R <= bytes.length) {
    for (let i = 0; i < R; i++) { const l = i >> 3; s[l] = (s[l] ^ (BigInt(bytes[p + i]) << BigInt((i & 7) * 8))) & M64; }
    kF(s); p += R;
  }
  const buf = new Uint8Array(R);
  for (let i = p; i < bytes.length; i++) buf[i - p] = bytes[i];
  buf[bytes.length - p] = 1; buf[R - 1] |= 0x80;
  for (let i = 0; i < R; i++) { const l = i >> 3; s[l] = (s[l] ^ (BigInt(buf[i]) << BigInt((i & 7) * 8))) & M64; }
  kF(s);
  let o = '0x';
  for (let i = 0; i < 32; i++) o += Number((s[i >> 3] >> BigInt((i & 7) * 8)) & 0xffn).toString(16).padStart(2, '0');
  return o;
};

// ─── RPC ───────────────────────────────────────────────────────────────────
export const RPCS = (process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://1rpc.io/eth')
  .split(',').map((s) => s.trim()).filter(Boolean);

export const rpc = async (method, params) => {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Error(`${method}: ${last?.message || 'no RPC reachable'}`);
};

/** keccak256("html()")[0:4] — the ERC-8244 entry point. */
export const HTML_SELECTOR = '0x33c34ac3';
/** keccak256("resolveMode()")[0:4] — ERC-4804 resolution mode. */
export const RESOLVE_MODE_SELECTOR = '0xdd473fae';

/** Decode an abi.encode(string) return into raw bytes. */
export const decodeString = (hex) => {
  const data = Buffer.from(hex.slice(2), 'hex');
  const offset = Number(BigInt('0x' + data.subarray(0, 32).toString('hex')));
  const length = Number(BigInt('0x' + data.subarray(offset, offset + 32).toString('hex')));
  return data.subarray(offset + 32, offset + 32 + length);
};
