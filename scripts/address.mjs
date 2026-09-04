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
 * TWO TRAPS IF THE DEPLOYER IS CreateX, WHICH IS WHAT IS PRESENT ON ALL THREE
 * CHAINS (0xba5Ed0…ba5Ed, 11,838 bytes on 1, 8453 and 4663 alike).
 *
 *   1. CreateX DOES NOT USE YOUR SALT DIRECTLY. `deployCreate3` runs it through
 *      `_guard()` first, so the derivation below is correct only when fed the
 *      GUARDED salt. Verified against the live contract: deployer CreateX with
 *      salt 0x00…01 derives 0x038aC3b9… here and actually deploys to
 *      0x72B1B286…, which are not the same address. Mine a vanity salt with
 *      this script, hand that salt to CreateX, and you land somewhere else.
 *
 *   2. BYTE 20 OF THE SALT IS CreateX'S REDEPLOY-PROTECTION FLAG, and turning
 *      it on mixes `block.chainid` into the guarded salt. It must be 0x00 for a
 *      deployment that wants one address everywhere. Verified by simulating
 *      `deployCreate3` on all three chains with the same salt:
 *
 *        byte20 = 0x00  ->  0x72B1B286…  on 1, 8453 and 4663 alike
 *        byte20 = 0x01  ->  0x8ee45838… on 1, 0xfA7E5660… on 8453,
 *                           0x2DcD713A… on 4663
 *
 *      The protected form is the one that sounds safer and is the one that
 *      silently breaks the premise the whole portal rests on.
 *
 * Usage:
 *   node scripts/address.mjs <deployer> <salt>          # derive one address
 *   node scripts/address.mjs <deployer> --mine 0x000000 # search for a prefix
 */
import {keccak256} from './lib.mjs';

const hexToBytes = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

/** CreateX, at one address on every chain it is on. */
export const CREATEX = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';

const b32 = (n) => { const b = Buffer.alloc(32); b.writeBigUInt64BE(BigInt(n), 24); return b; };
const addr32 = (a) => Buffer.concat([Buffer.alloc(12), hexToBytes(a)]);

/**
 * CreateX's `_guard`, which is what `deployCreate3` actually derives from.
 *
 * Every branch below was confirmed against the live contract by simulating
 * `deployCreate3` rather than read off the source, because getting this wrong
 * bakes an address into an immutable page that the deployer will never reach:
 *
 *   prefix != sender, != 0        keccak256(salt)                     same everywhere
 *   prefix == sender, byte20 00   keccak256(sender ++ salt)           same everywhere
 *   prefix == sender, byte20 01   keccak256(sender ++ chainid ++ salt)  PER CHAIN
 *   prefix == 0,      byte20 01   keccak256(chainid ++ salt)            PER CHAIN
 *   prefix == 0,      byte20 00   rejected
 *
 * `sender` matters: it is compared against the salt's first 20 bytes, so the
 * same salt guards differently for different deployers. Pass the account that
 * will actually send the transaction.
 */
export const createxGuard = (salt, sender = '0x' + '00'.repeat(20), chainId = 1) => {
  const raw = hexToBytes(salt);
  if (raw.length !== 32) throw new Error('salt must be 32 bytes');
  const prefix = '0x' + raw.subarray(0, 20).toString('hex');
  const flag = raw[20];
  const isSender = prefix.toLowerCase() === sender.toLowerCase();
  const isZero = /^0x0{40}$/.test(prefix);

  if (isSender && flag === 0x01) return keccak256(Buffer.concat([addr32(sender), b32(chainId), raw]));
  if (isSender && flag === 0x00) return keccak256(Buffer.concat([addr32(sender), raw]));
  if (isSender) throw new Error('byte 20 must be 0x00 or 0x01');
  if (isZero && flag === 0x01) return keccak256(Buffer.concat([b32(chainId), raw]));
  // A zero prefix with byte 20 = 0x00 is NOT rejected: CreateX guards it with
  // keccak256(salt), the same as any unrecognised prefix. Verified on chain —
  // sender 0x…dEaD, salt 0x00*20 ++ 00 ++ 009e37a1b4c5d6e7f8091a2b lands at
  // 0xfDD918150D8F771c3047c4eC53F6CD0edAC3595b. (A bare 0x…01 tail reverts, but
  // as a collision with something already deployed there, not as a rejection.)
  if (isZero && flag !== 0x00) throw new Error('byte 20 must be 0x00 or 0x01');
  return keccak256(raw);
};

/** Where `deployCreate3(salt, …)` sent by `sender` actually lands. */
export const createxAddress = (salt, sender, chainId) =>
  create3Address(CREATEX, createxGuard(salt, sender, chainId));

/**
 * A salt that is permissioned AND the same address on every chain: the sender
 * in the first 20 bytes, 0x00 in byte 20 so `block.chainid` stays out of it,
 * and the counter in the tail. Only `sender` can use it, and it lands at one
 * address everywhere — which is the whole point of the portal.
 */
export const createxSalt = (sender, n) => {
  const b = Buffer.alloc(32);
  hexToBytes(sender).copy(b, 0);
  b[20] = 0x00;
  b.writeBigUInt64BE(BigInt(n), 24);
  return '0x' + b.toString('hex');
};


/** The CREATE3 proxy: its runtime is 0x363d3d37363d34f0, a bare CREATE forwarder. */
export const PROXY_INITCODE = '0x67363d3d37363d34f03d5260086018f3';
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
if (!invokedDirectly) { /* imported as a library */ } else {
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const has = (name) => argv.includes(name);
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && ['--mine', '--sender'].includes(argv[i - 1])));

const USAGE = `usage:
  node scripts/address.mjs <deployer> <salt>              raw CREATE3
  node scripts/address.mjs <deployer> --mine <prefix>     mine a raw CREATE3 salt

  node scripts/address.mjs --createx --sender <eoa> <salt>
  node scripts/address.mjs --createx --sender <eoa> --mine <prefix>

CreateX guards the salt before deriving, so a salt mined with the raw form
lands somewhere else. The --createx form mines the permissioned, chain
independent shape: <sender>00<counter>, which only <sender> can use and which
resolves to one address on every chain.`;

if (has('--createx')) {
  const sender = flag('--sender');
  if (!sender || !/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    console.error('--createx needs --sender <the account that will send the deploy>\n\n' + USAGE);
    process.exit(1);
  }
  if (has('--mine')) {
    const prefix = (flag('--mine') || '0x0000').toLowerCase();
    if (!/^0x[0-9a-f]*$/.test(prefix)) { console.error('prefix must be hex, e.g. 0x000000'); process.exit(1); }
    console.error(`mining ${prefix}… via CreateX for ${sender}`);
    const started = Date.now();
    for (let i = 0n; ; i++) {
      const salt = createxSalt(sender, i);
      const addr = createxAddress(salt, sender, 1);
      if (addr.startsWith(prefix)) {
        console.log(`salt    ${salt}`);
        console.log(`address ${addr}`);
        console.error(`(${i} tries, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        console.error('same on every chain: byte 20 is 0x00, so block.chainid is not mixed in');
        break;
      }
      if (i % 50000n === 0n && i > 0n) console.error(`  ${i} tried…`);
    }
  } else {
    const salt = positional[0];
    if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) { console.error('salt must be 32 bytes of hex\n\n' + USAGE); process.exit(1); }
    // Derive on each chain the portal covers, so a salt that is not actually
    // chain independent cannot be adopted without the difference being visible.
    for (const id of [1, 8453, 4663]) {
      console.log(`${String(id).padStart(4)}  ${createxAddress(salt, sender, id)}`);
    }
  }
} else {
  const [deployer, arg] = positional;
  if (!deployer || !/^0x[0-9a-fA-F]{40}$/.test(deployer)) { console.error(USAGE); process.exit(1); }
  if (has('--mine')) {
    const prefix = (flag('--mine') || '0x0000').toLowerCase();
    if (!/^0x[0-9a-f]*$/.test(prefix)) { console.error('prefix must be hex, e.g. 0x000000'); process.exit(1); }
    console.error(`mining ${prefix}… from ${deployer} (raw CREATE3 — NOT what CreateX derives)`);
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
    if (!arg || !/^0x[0-9a-fA-F]{64}$/.test(arg)) { console.error('salt must be 32 bytes of hex\n\n' + USAGE); process.exit(1); }
    console.log(create3Address(deployer, arg));
  }
}
}
