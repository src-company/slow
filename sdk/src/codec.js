// codec.js — zero-dependency ABI/keccak/id primitives for SLOW.
//
// These are the SAME helpers the on-chain dapp (SLOW.html) ships and tests
// against `cast keccak` / `cast sig` and a live anvil deployment. Extracted
// verbatim so the SDK, the dapp, and the contract agree bit-for-bit.
//
// Everything here is pure and runs in any modern JS runtime (browser, Node,
// Deno, Bun) — no crypto library, no bundler, no network.

// ---------------------------------------------------------------------------
// keccak-256 (the EVM hash — NOT SHA3-256)
// ---------------------------------------------------------------------------

const M64 = (1n << 64n) - 1n;
const RC = [1n, 32898n, 9223372036854808714n, 9223372039002292224n, 32907n, 2147483649n, 9223372039002292353n, 9223372036854808585n, 138n, 136n, 2147516425n, 2147483658n, 2147516555n, 9223372036854775947n, 9223372036854808713n, 9223372036854808579n, 9223372036854808578n, 9223372036854775936n, 32778n, 9223372039002259466n, 9223372039002292353n, 9223372036854808704n, 2147483649n, 9223372039002292232n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotL = (x, n) => ((x << n) | (x >> (64n - n))) & M64;

function kF(s) {
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
}

/**
 * keccak-256 of a byte string.
 * @param {string|Uint8Array} input - a `0x` hex string, a UTF-8 string, or raw bytes.
 * @returns {string} `0x`-prefixed 32-byte hash.
 */
export function keccak256(input) {
  let bytes;
  if (typeof input === 'string') {
    if (input.startsWith('0x')) {
      bytes = new Uint8Array((input.length - 2) / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(input.slice(2 + i * 2, 4 + i * 2), 16);
    } else bytes = new TextEncoder().encode(input);
  } else bytes = input;
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
}

/** 4-byte function selector for a signature like `depositTo(address,address,uint256,uint96,bytes)`. */
export function selector(signature) {
  return keccak256(signature).slice(0, 10);
}

// ---------------------------------------------------------------------------
// ABI encoding / decoding (the subset SLOW uses)
// ---------------------------------------------------------------------------

const strip = h => h && h.startsWith('0x') ? h.slice(2) : (h || '');
export const padL = h => strip(h).padStart(64, '0');
const padR = h => { const s = strip(h); return s.padEnd(Math.ceil(s.length / 64) * 64 || 64, '0'); };
const word = v => (typeof v === 'bigint' ? v : BigInt(v)).toString(16).padStart(64, '0');
const isDyn = t => t === 'bytes' || t === 'string' || t.endsWith('[]');
const encStatic = (t, v) => t === 'address' ? padL(v) : word(v);
function encBytes(b) { const d = strip(b), L = d.length / 2; return word(L) + (L ? padR(d) : ''); }
function encBytesArr(arr) {
  let h = '', t = '', c = arr.length * 32;
  for (const b of arr) { h += word(c); const e = encBytes(b); t += e; c += e.length / 2; }
  return word(arr.length) + h + t;
}
const encDyn = (t, v) => t === 'bytes[]' ? encBytesArr(v) : encBytes(v);

/** Encode a tuple of ABI values. `types` uses canonical names (`address`, `uint256`, `bytes`, `uint256[]`…). */
export function encode(types, values) {
  const heads = [], tails = [];
  for (let i = 0; i < types.length; i++) {
    if (isDyn(types[i])) { heads.push(null); tails.push(encDyn(types[i], values[i])); }
    else { heads.push(encStatic(types[i], values[i])); tails.push(''); }
  }
  let c = types.length * 32;
  for (let i = 0; i < types.length; i++) if (heads[i] === null) { heads[i] = word(c); c += tails[i].length / 2; }
  return heads.join('') + tails.join('');
}

/** Build full calldata: 4-byte selector + encoded args. */
export const encodeCall = (sel, types, vals) => sel + encode(types, vals);

/** Decode an `eth_call` return. Supports address/uintN/string/uint256[]. */
export function decode(types, hex) {
  const d = strip(hex), out = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i], w = d.slice(i * 64, i * 64 + 64);
    if (!isDyn(t)) { out.push(t === 'address' ? '0x' + w.slice(24) : BigInt('0x' + w)); continue; }
    const off = parseInt(w, 16) * 2, len = parseInt(d.slice(off, off + 64), 16);
    if (t === 'string') {
      const a = new Uint8Array(len);
      for (let j = 0; j < len; j++) a[j] = parseInt(d.slice(off + 64 + j * 2, off + 66 + j * 2), 16);
      out.push(new TextDecoder().decode(a));
    } else if (t === 'uint256[]') {
      const v = [];
      for (let j = 0; j < len; j++) v.push(BigInt('0x' + d.slice(off + 64 + j * 64, off + 128 + j * 64)));
      out.push(v);
    } else throw new Error('decode: unsupported type ' + t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixed-point <-> string
// ---------------------------------------------------------------------------

/** "1.5", 18 -> 1500000000000000000n */
export function parseUnits(amt, dec) {
  const [w = '0', f = ''] = String(amt).split('.');
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}

/** 1500000000000000000n, 18 -> "1.5" */
export function formatUnits(v, dec) {
  const big = typeof v === 'bigint' ? v : BigInt(v);
  const div = 10n ** BigInt(dec), w = big / div, f = big % div;
  if (!f) return w.toString();
  const fs = f.toString().padStart(dec, '0').replace(/0+$/, '');
  return w + (fs ? '.' + fs : '');
}

// ---------------------------------------------------------------------------
// SLOW token-id codec
//   | 96 bits delay (seconds) | 160 bits token address | = uint256 id
// ---------------------------------------------------------------------------

const ADDR_MASK = (1n << 160n) - 1n;

/** Pack `(token, delaySeconds)` into a SLOW ERC-1155 id. Mirrors `SLOW.encodeId`. */
export function encodeId(token, delay) {
  return (BigInt(token) & ADDR_MASK) | (BigInt(delay) << 160n);
}

/** Unpack a SLOW id. Mirrors `SLOW.decodeId`. `token` is lowercase, `delay` in seconds. */
export function decodeId(id) {
  const b = typeof id === 'bigint' ? id : BigInt(id);
  return {
    token: '0x' + (b & ADDR_MASK).toString(16).padStart(40, '0'),
    delay: Number(b >> 160n),
  };
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const isAddress = a => /^0x[a-fA-F0-9]{40}$/.test(a || '');
export const shortAddress = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';

/** Left-pad an address to a 32-byte ABI word (no 0x). Handy for topic filters. */
export const addressTopic = a => '0x' + padL(a);
