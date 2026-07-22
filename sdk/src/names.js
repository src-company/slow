// names.js — ENS (.eth …) and WNS (.wei) name resolution for SLOW.
//
// Same resolution paths the on-chain dapp uses, extracted so apps get identical
// behavior. Zero-dependency: needs only an `eth_call` transport, which any
// SlowClient already provides (`client.call(data, to)`).
//
//   import { resolveName, reverseName } from './names.js';
//   const addr = await resolveName(client, 'vitalik.eth');   // → 0x… or null
//   const addr = await resolveName(client, 'alice.wei');      // → routes to WNS
//   const name = await reverseName(client, addr);             // WNS first, then ENS
//
// A name that does not resolve returns `null` (never throws for "not found").

import { keccak256, decode, padL, ZERO_ADDRESS } from './codec.js';
import { ENS_REGISTRY, WNS_REGISTRY, NAME_SEL } from './abi.js';

/** ENS namehash (EIP-137). Works for both ENS and WNS (WNS reuses the algorithm). */
export function namehash(name) {
  let node = '0x' + '0'.repeat(64);
  if (!name) return node;
  const enc = new TextEncoder();
  for (const label of name.toLowerCase().split('.').reverse()) {
    const labelHash = keccak256(enc.encode(label));
    node = keccak256(node + labelHash.slice(2));
  }
  return node;
}

// Call helper mirroring the dapp's `callOk`: null on empty/revert instead of throwing.
async function callOk(client, to, data) {
  try {
    const r = await client.call(data, to);
    return r && r !== '0x' ? r : null;
  } catch {
    return null;
  }
}

const addrFromWord = h => '0x' + h.slice(-40);

// ---------------------------------------------------------------------------
// ENS
// ---------------------------------------------------------------------------

/** Forward-resolve an ENS name to an address (via its resolver's `addr`). */
export async function ensResolve(client, name) {
  if (!name) return null;
  const node = namehash(name);
  const rh = await callOk(client, ENS_REGISTRY, NAME_SEL.resolver + node.slice(2));
  if (!rh) return null;
  const resolver = addrFromWord(rh);
  if (resolver.toLowerCase() === ZERO_ADDRESS) return null;
  const ah = await callOk(client, resolver, NAME_SEL.addr + node.slice(2));
  if (!ah) return null;
  const a = addrFromWord(ah);
  return a.toLowerCase() === ZERO_ADDRESS ? null : a;
}

/** Reverse-resolve an address to its ENS name, verifying the forward record matches. */
export async function ensReverse(client, addr) {
  const node = namehash(addr.toLowerCase().slice(2) + '.addr.reverse');
  const rh = await callOk(client, ENS_REGISTRY, NAME_SEL.resolver + node.slice(2));
  if (!rh) return null;
  const resolver = addrFromWord(rh);
  if (resolver.toLowerCase() === ZERO_ADDRESS) return null;
  const nh = await callOk(client, resolver, NAME_SEL.name + node.slice(2));
  if (!nh) return null;
  const [name] = decode(['string'], nh);
  if (!name) return null;
  // Forward-confirm (guards against spoofed reverse records).
  const fwd = await ensResolve(client, name);
  return fwd && fwd.toLowerCase() === addr.toLowerCase() ? name : null;
}

// ---------------------------------------------------------------------------
// WNS (.wei) — single-registry resolver
// ---------------------------------------------------------------------------

/** Forward-resolve a WNS (.wei) name to an address. */
export async function wnsResolve(client, name) {
  if (!name) return null;
  const node = namehash(name);
  const ah = await callOk(client, WNS_REGISTRY, NAME_SEL.addr + node.slice(2));
  if (!ah) return null;
  const a = addrFromWord(ah);
  return a.toLowerCase() === ZERO_ADDRESS ? null : a;
}

/** Reverse-resolve an address to its WNS (.wei) name. */
export async function wnsReverse(client, addr) {
  const ah = await callOk(client, WNS_REGISTRY, NAME_SEL.wnsReverse + padL(addr));
  if (!ah) return null;
  const [name] = decode(['string'], ah);
  return name || null;
}

// ---------------------------------------------------------------------------
// Unified
// ---------------------------------------------------------------------------

/** Whether `s` looks like a resolvable name (contains a dot, not a 0x address). */
export const isName = s => typeof s === 'string' && s.includes('.') && !s.startsWith('0x');

/**
 * Resolve any supported name to an address. `.wei` routes to WNS; everything
 * else (`.eth`, DNS-imported names) routes to ENS. Returns null if unresolved.
 */
export function resolveName(client, name) {
  if (!name) return Promise.resolve(null);
  return name.toLowerCase().endsWith('.wei') ? wnsResolve(client, name) : ensResolve(client, name);
}

/** Reverse-resolve an address, preferring a WNS (.wei) name, falling back to ENS. */
export async function reverseName(client, addr) {
  return (await wnsReverse(client, addr)) || (await ensReverse(client, addr));
}
