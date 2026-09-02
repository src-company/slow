#!/usr/bin/env node
/**
 * CREATE3 address derivation, and a vanity miner for the salt.
 *
 * Under CREATE2 the address depends on the initcode, the initcode carries the
 * chunk addresses, the chunk addresses depend on the page, and the page has to
 * contain the address — a loop with no entry point. CREATE3 derives the address
 * from the deployer and the salt alone:
 *
 *   proxy = CREATE2(deployer, salt, keccak256(PROXY_INITCODE))
 *   child = keccak256(0xd694 ++ proxy ++ 0x01)[12:]
 *
 * So the salt is mined once, before any content exists, and the page is written
 * around an address that is already known.
 *
 * Usage:
 *   node scripts/address.mjs <deployer> <salt>          # derive one address
 *   node scripts/address.mjs <deployer> --mine 0x000000 # search for a prefix
 */
import {keccak256} from './lib.mjs';

/** The CREATE3 proxy: its runtime is 0x363d3d37363d34f0, a bare CREATE forwarder. */
export const PROXY_INITCODE = '0x67363d3d37363d34f03d5260086018f3';
const hexToBytes = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
export const PROXY_INITCODE_HASH = keccak256(hexToBytes(PROXY_INITCODE));

export const create3Address = (deployer, salt) => {
  const proxy = '0x' + keccak256(Buffer.concat([
    Buffer.from([0xff]),
    hexToBytes(deployer),
    hexToBytes(salt),
    hexToBytes(PROXY_INITCODE_HASH),
  ])).slice(26);
  // rlp([proxy, 1]) == 0xd6 0x94 <20-byte address> 0x01
  return '0x' + keccak256(Buffer.concat([
    Buffer.from([0xd6, 0x94]), hexToBytes(proxy), Buffer.from([0x01]),
  ])).slice(26);
};

// Only run the CLI when invoked directly, so the derivation can be imported.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('address.mjs');
const [, , deployer, arg, prefixArg] = process.argv;
if (!invokedDirectly) { /* imported as a library */ } else {
if (!deployer || !/^0x[0-9a-fA-F]{40}$/.test(deployer)) {
  console.error('usage: node scripts/address.mjs <deployer> <salt|--mine <prefix>>');
  process.exit(1);
}
if (arg === '--mine') {
  const prefix = (prefixArg || '0x0000').toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(prefix)) { console.error('prefix must be hex, e.g. 0x000000'); process.exit(1); }
  console.error(`mining ${prefix}… from ${deployer}`);
  const buf = Buffer.alloc(32);
  const started = Date.now();
  for (let i = 0n; ; i++) {
    buf.writeBigUInt64BE(i, 24);
    const salt = '0x' + buf.toString('hex');
    const addr = create3Address(deployer, salt);
    if (addr.startsWith(prefix)) {
      console.log(`salt    ${salt}`);
      console.log(`address ${addr}`);
      console.error(`(${i} tries, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
      break;
    }
    if (i % 50000n === 0n && i > 0n) console.error(`  ${i} tried…`);
  }
} else {
  if (!arg || !/^0x[0-9a-fA-F]{64}$/.test(arg)) { console.error('salt must be 32 bytes of hex'); process.exit(1); }
  console.log(create3Address(deployer, arg));
}
}
