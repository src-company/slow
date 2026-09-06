#!/usr/bin/env node
/**
 * Execute an Arbitrum L2->L1 message once its challenge period has run.
 *
 * The counterpart to `opfinalize.mjs`, and a simpler shape: Nitro needs one L1
 * transaction rather than two, and `Outbox.executeTransaction` reverts
 * atomically if anything is wrong — so unlike the OP leg, a failed attempt
 * costs gas and nothing else, and the message stays replayable.
 *
 * READINESS IS A SEPARATE QUESTION FROM THE PROOF, and conflating them is the
 * easy mistake here. `NodeInterface.constructOutboxProof` builds a proof against
 * the CURRENT send tree and answers happily seconds after the message is sent —
 * it says nothing about confirmation. The L1 check is whether the resulting root
 * has reached `Outbox.roots`, which only happens once the assertion covering it
 * is confirmed. Trusting the proof alone reports READY for six days and then
 * reverts with `UnknownRoot(bytes32)` (0x8730d7c8), which is exactly what this
 * did before the check below was added.
 *
 *   node scripts/arbexecute.mjs <l2TxHash>
 *
 * Env: L1_RPC, L2_RPC, OUTBOX, PRIVATE_KEY (omit the key for a dry check).
 */
const L1_RPC = process.env.L1_RPC ?? 'https://ethereum-rpc.publicnode.com';
const L2_RPC = process.env.L2_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const OUTBOX = process.env.OUTBOX ?? '0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9';
const ARB_SYS = '0x0000000000000000000000000000000000000064';
const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
const L2_TO_L1_TX =
  '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc';

import { keccak256 } from './lib.mjs';
let id = 0;
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const sel = (s) => keccak256(Buffer.from(s, 'utf8')).slice(0, 10);
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);

const txHash = process.argv[2];
if (!txHash) { console.error('usage: arbexecute.mjs <l2TxHash>'); process.exit(1); }

// ── the message, from its own receipt ─────────────────────────────────────
const receipt = await rpc(L2_RPC, 'eth_getTransactionReceipt', [txHash]);
if (!receipt) throw new Error('no receipt for ' + txHash);
const ev = receipt.logs.find(
  (l) => l.address.toLowerCase() === ARB_SYS && l.topics[0] === L2_TO_L1_TX
);
if (!ev) throw new Error('that transaction did not send an L2->L1 message');

const d = strip(ev.data);
const at = (i) => '0x' + d.slice(i * 64, (i + 1) * 64);
const dataOff = Number(BigInt(at(5))) * 2;
const msg = {
  caller: '0x' + strip(at(0)).slice(24),
  destination: '0x' + ev.topics[1].slice(26),
  position: BigInt(ev.topics[3]),
  arbBlockNum: BigInt(at(1)),
  ethBlockNum: BigInt(at(2)),
  timestamp: BigInt(at(3)),
  callvalue: BigInt(at(4)),
  data: '0x' + d.slice(dataOff + 64, dataOff + 64 + Number(BigInt('0x' + d.slice(dataOff, dataOff + 64))) * 2),
};
console.log('leaf (position) :', msg.position);
console.log('caller          :', msg.caller);
console.log('destination     :', msg.destination);
console.log('callvalue       :', msg.callvalue, 'wei');

const spent = BigInt(await call(L1_RPC, OUTBOX, sel('isSpent(uint256)') + word(msg.position)));
if (spent === 1n) { console.log('\nAlready executed. Nothing to do.'); process.exit(0); }

// ── the proof, which is also the readiness check ──────────────────────────
// `size` is the current send-tree size; the call answers only if the leaf sits
// under a root the L1 has already confirmed.
const state = strip(await call(L2_RPC, ARB_SYS, sel('sendMerkleTreeState()')));
const size = BigInt('0x' + state.slice(0, 64));
console.log('send tree size  :', size);

let proof, sendRoot;
try {
  const raw = strip(await call(L2_RPC, NODE_INTERFACE,
    sel('constructOutboxProof(uint64,uint64)') + word(size) + word(msg.position)));
  // (bytes32 send, bytes32 root, bytes32[] proof) — the array is the third head slot
  const off = Number(BigInt('0x' + raw.slice(128, 192))) * 2;
  const n = Number(BigInt('0x' + raw.slice(off, off + 64)));
  proof = Array.from({ length: n }, (_, k) => '0x' + raw.slice(off + 64 + k * 64, off + 128 + k * 64));
  sendRoot = '0x' + raw.slice(64, 128);
  console.log('proof nodes     :', n);
  console.log('send root       :', sendRoot);
} catch (e) {
  console.log('\nCannot build a proof —', e.message.slice(0, 160));
  process.exit(3);
}

// The only thing that says the message may actually be executed.
const known = await call(L1_RPC, OUTBOX, sel('roots(bytes32)') + strip(sendRoot));
if (BigInt(known) === 0n) {
  console.log('\nNOT READY — the send root is not in the Outbox yet, so the assertion');
  console.log('covering this message has not been confirmed on L1. The challenge period');
  console.log('on this chain is ~6.4 days (confirmPeriodBlocks 45,818). Executing now');
  console.log('would revert with UnknownRoot(bytes32).');
  process.exit(3);
}
console.log('send root is confirmed on L1.');

const calldata = sel('executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)')
  + word(0x120) + word(msg.position) + word(msg.caller) + word(msg.destination)
  + word(msg.arbBlockNum) + word(msg.ethBlockNum) + word(msg.timestamp) + word(msg.callvalue)
  + word(0x140 + 32 * proof.length)
  + word(proof.length) + proof.map((p) => strip(p)).join('')
  + word(strip(msg.data).length / 2)
  + strip(msg.data) + '0'.repeat((64 - (strip(msg.data).length % 64)) % 64);

console.log('\nREADY. calldata bytes:', calldata.length / 2 - 1);
const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.log('Set PRIVATE_KEY to send, or use:');
  console.log(`  cast send --rpc-url ${L1_RPC} --private-key $PK ${OUTBOX} ${calldata}`);
  process.exit(0);
}
const { execFileSync } = await import('node:child_process');
console.log(execFileSync('cast', ['send', '--rpc-url', L1_RPC, '--private-key', PK,
  '--gas-limit', '500000', OUTBOX, calldata], { encoding: 'utf8' })
  .split('\n').filter((l) => /^(transactionHash|status|gasUsed)/.test(l)).join('\n'));
