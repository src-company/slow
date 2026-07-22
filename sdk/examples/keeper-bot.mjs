// keeper-bot.mjs — a minimal SLOW settlement keeper (Node, zero-dep).
//
// Watches a set of users' inbound transfers, settles matured + eligible ones
// through the gate, and collects any attached tips. Uses a plain JSON-RPC
// provider shim so it needs no wallet library — sign with a raw key via your
// RPC's `eth_sendTransaction` if it's an unlocked node, or swap `send` for a
// viem/ethers signer.
//
//   RPC_URL=https://… KEEPER=0x… USERS=0xabc,0xdef node keeper-bot.mjs
//
// NOTE: `eth_sendTransaction` requires the RPC to hold the keeper key (e.g. a
// local node / Anvil). For a hosted RPC, replace `provider.request` for
// eth_sendTransaction with a viem WalletClient — see examples/keeper-viem.mjs
// in the README.

import { SlowClient } from '../src/client.js';
import { runOnce } from '../src/keeper.js';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const KEEPER = process.env.KEEPER;               // keeper account (must be signable by RPC)
const USERS = (process.env.USERS || '').split(',').filter(Boolean);
const MIN_TIP = BigInt(process.env.MIN_TIP || '0');

// Bare EIP-1193 shim over HTTP JSON-RPC.
let idc = 1;
const provider = {
  async request({ method, params = [] }) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: idc++, method, params }),
    });
    const { result, error } = await res.json();
    if (error) throw new Error(error.message);
    return result;
  },
};

const client = new SlowClient(provider, { account: KEEPER });

async function tick() {
  const seen = new Set();
  const ids = [];
  for (const u of USERS) {
    for (const id of await client.getInboundTransfers(u)) {
      const k = id.toString();
      if (!seen.has(k)) { seen.add(k); ids.push(id); }
    }
  }
  const report = await runOnce(client, ids, { minTip: MIN_TIP });
  if (report.settled) {
    console.log(`settled ${report.settled} transfer(s):`, report.txHashes.join(', '));
    for (const e of report.eligible) console.log(`  #${e.transferId} tip=${e.tip}`);
  } else {
    console.log('nothing eligible this tick');
  }
}

console.log(`SLOW keeper on ${RPC_URL} — watching ${USERS.length} user(s), min tip ${MIN_TIP}`);
await tick();
setInterval(() => tick().catch(e => console.error('tick error:', e.message)), 30_000);
