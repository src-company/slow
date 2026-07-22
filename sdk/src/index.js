// index.js — zero-dependency entry point for the SLOW SDK.
//
// This barrel re-exports the framework-agnostic core only (codec + abi +
// client + wallet + keeper). It pulls in NO third-party packages, so it is
// safe to import in any environment.
//
// The optional viem/wagmi layers live in ./viem.js and ./react.jsx and are
// imported explicitly (they carry peer deps) — they are deliberately NOT
// re-exported here so this file stays dependency-free.

export * from './codec.js';
export * from './abi.js';
export { SlowClient, resolveToken, resolveDelay } from './client.js';
export {
  namehash, resolveName, reverseName, isName,
  ensResolve, ensReverse, wnsResolve, wnsReverse,
} from './names.js';
export * as wallet from './wallet.js';
export * as keeper from './keeper.js';
