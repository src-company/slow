#!/usr/bin/env node
/**
 * Prove an OP Stack withdrawal, so it can be finalised a day later.
 *
 * An L2->L1 withdrawal is not one transaction but three, spread over a week:
 * initiate on L2, PROVE on L1 once a dispute game covers the block, and
 * finalise after the proof matures. The middle one is the awkward one — it
 * needs a storage proof against an output root nobody hands you — and it is the
 * step a sender is most likely to never get around to. This is that step.
 *
 * WHAT IT PROVES. `L2ToL1MessagePasser.sentMessages[withdrawalHash]` is true at
 * the L2 block a dispute game committed to. The portal recomputes the output
 * root from the four fields below, checks it against the game's claim, then
 * walks the storage proof to that slot. So the whole argument is: this game
 * says the L2 state root was X, and under X this withdrawal exists.
 *
 *   node scripts/opprove.mjs <l2TxHash>
 *
 * Env: L1_RPC, L2_RPC, PORTAL, and PRIVATE_KEY to actually send (otherwise it
 * builds and verifies the proof, prints the calldata, and stops).
 */
import { keccak256 } from './lib.mjs';

const L1_RPC = process.env.L1_RPC ?? 'https://ethereum-rpc.publicnode.com';
const L2_RPC = process.env.L2_RPC ?? 'https://mainnet.base.org';
const PORTAL = process.env.PORTAL ?? '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e';
const MESSAGE_PASSER = '0x4200000000000000000000000000000000000016';
const MESSAGE_PASSED =
  '0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054';

let rpcId = 0;
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const strip = (h) => h.replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const hexToBytes = (h) => Buffer.from(strip(h), 'hex');
const call = (url, to, data) => rpc(url, 'eth_call', [{ to, data }, 'latest']);
const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).slice(0, 10);

/**
 * The withdrawal, read from the receipt of the transaction that started it.
 * Exported because `opfinalize.mjs` needs exactly the same six fields, and two
 * parsers of one event is how the two steps end up disagreeing about a nonce.
 */
export async function readWithdrawal(l2Rpc, txHash) {
  const receipt = await rpc(l2Rpc, 'eth_getTransactionReceipt', [txHash]);
  if (!receipt) throw new Error('no receipt for ' + txHash);
  const mp = receipt.logs.find(
    (l) => l.address.toLowerCase() === MESSAGE_PASSER && l.topics[0] === MESSAGE_PASSED
  );
  if (!mp) throw new Error('that transaction did not initiate a withdrawal');

  const d = strip(mp.data);
  const at = (i) => '0x' + d.slice(i * 64, (i + 1) * 64);
  const dataOff = Number(BigInt(at(2))) * 2;
  const dataLen = Number(BigInt('0x' + d.slice(dataOff, dataOff + 64))) * 2;
  return {
    wd: {
      nonce: BigInt(mp.topics[1]),
      sender: '0x' + mp.topics[2].slice(26),
      target: '0x' + mp.topics[3].slice(26),
      value: BigInt(at(0)),
      gasLimit: BigInt(at(1)),
      data: '0x' + d.slice(dataOff + 64, dataOff + 64 + dataLen),
    },
    withdrawalHash: at(3),
    l2Block: BigInt(receipt.blockNumber),
  };
}

/** The `WithdrawalTransaction` struct, tail-encoded. Shared for the same reason. */
export function encodeWithdrawalTx(wd) {
  const dataBytes = strip(wd.data);
  const pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
  return word(wd.nonce) + word(wd.sender) + word(wd.target) + word(wd.value) +
         word(wd.gasLimit) + word(0xc0) + word(dataBytes.length / 2) + pad(dataBytes);
}

export { rpc, call, sel, word, strip, hexToBytes, L1_RPC, L2_RPC, PORTAL };

// ── cli ───────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('opprove.mjs');
if (!invokedDirectly) { /* imported for its helpers */ }
else {

const txHash = process.argv[2];
if (!txHash) { console.error('usage: opprove.mjs <l2TxHash>'); process.exit(1); }

const { wd, withdrawalHash, l2Block } = await readWithdrawal(L2_RPC, txHash);
console.log('withdrawal hash :', withdrawalHash);
console.log('l2 block        :', l2Block);
console.log('target          :', wd.target);
console.log('value           :', wd.value, 'wei');

// ── 2. a dispute game that committed to a block at or past it ─────────────
const factory = '0x' + (await call(L1_RPC, PORTAL, sel('disputeGameFactory()'))).slice(26);
const count = BigInt(await call(L1_RPC, factory, sel('gameCount()')));
const respected = Number(BigInt(await call(L1_RPC, PORTAL, sel('respectedGameType()'))));
console.log('factory         :', factory, ' games:', count, ' respected type:', respected);

let game = null;
for (let i = count - 1n; i >= 0n && i > count - 40n; i--) {
  const raw = await call(L1_RPC, factory, sel('gameAtIndex(uint256)') + word(i));
  const gt = Number(BigInt('0x' + strip(raw).slice(0, 64)));
  const addr = '0x' + strip(raw).slice(128 + 24, 192);
  if (gt !== respected) continue;
  const seq = BigInt(await call(L1_RPC, addr, sel('l2SequenceNumber()')));
  if (seq >= l2Block) { game = { index: i, addr, seq }; }
  else break;   // games only go backwards from here
}
if (!game) {
  console.error(`\nNo ${respected}-type game covers L2 block ${l2Block} yet.`);
  console.error('Base creates one roughly every 20 minutes. Try again shortly.');
  process.exit(2);
}
console.log('game            : index', game.index, game.addr, 'covers', game.seq);

// ── 3. the output root proof, and the storage proof under it ──────────────
const block = await rpc(L2_RPC, 'eth_getBlockByNumber', ['0x' + game.seq.toString(16), false]);
const slot = keccak256(Buffer.concat([hexToBytes(withdrawalHash), hexToBytes('0x' + word(0))]));
const proof = await rpc(L2_RPC, 'eth_getProof',
  [MESSAGE_PASSER, [slot], '0x' + game.seq.toString(16)]);

const orp = {
  version: '0x' + word(0),
  stateRoot: block.stateRoot,
  messagePasserStorageRoot: proof.storageHash,
  latestBlockhash: block.hash,
};
const outputRoot = keccak256(hexToBytes(
  '0x' + strip(orp.version) + strip(orp.stateRoot) +
  strip(orp.messagePasserStorageRoot) + strip(orp.latestBlockhash)
));
const claim = await call(L1_RPC, game.addr, sel('rootClaim()'));
console.log('computed root   :', outputRoot);
console.log('game rootClaim  :', claim);
if (outputRoot.toLowerCase() !== claim.toLowerCase()) {
  console.error('\nMISMATCH — the output root does not reproduce the game claim. Refusing to send.');
  process.exit(3);
}
const stored = proof.storageProof[0];
if (BigInt(stored.value || 0) !== 1n) {
  console.error(`\nsentMessages[${withdrawalHash}] is ${stored.value} at that block, not 1.`);
  process.exit(4);
}
console.log('output root MATCHES the game claim, and the message is present in storage.');
console.log('proof nodes     :', stored.proof.length);

// ── 4. calldata ───────────────────────────────────────────────────────────
// proveWithdrawalTransaction((uint256,address,address,uint256,uint256,bytes),uint256,(bytes32,bytes32,bytes32,bytes32),bytes[])
// Two dynamic members at the top level (the tx struct and the proof array), so
// the head is: tx offset, gameIndex, four inline root-proof words, proof offset.
const pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const txStruct = encodeWithdrawalTx(wd);
const proofArray =
  word(stored.proof.length) +
  stored.proof.map((_, k) => word(32 * stored.proof.length + 32 * k +
    stored.proof.slice(0, k).reduce((a, p) => a + 32 + Math.ceil(strip(p).length / 2 / 32) * 32, 0) -
    32 * k)).join('') +
  stored.proof.map((p) => word(strip(p).length / 2) + pad(strip(p))).join('');

const headWords = 7;                       // txOffset, gameIndex, 4 root words, proofOffset
const txOffset = headWords * 32;
const proofOffset = txOffset + txStruct.length / 2;
const calldata = sel('proveWithdrawalTransaction((uint256,address,address,uint256,uint256,bytes),uint256,(bytes32,bytes32,bytes32,bytes32),bytes[])')
  + word(txOffset) + word(game.index)
  + strip(orp.version) + strip(orp.stateRoot) + strip(orp.messagePasserStorageRoot) + strip(orp.latestBlockhash)
  + word(proofOffset) + txStruct + proofArray;

console.log('\ncalldata bytes  :', calldata.length / 2 - 1);
const out = process.env.OUT ?? '/tmp/prove-calldata.txt';
(await import('node:fs')).writeFileSync(out, calldata);
console.log('written to      :', out);
console.log('\nsend with:');
console.log(`  cast send --rpc-url $L1_RPC --private-key $PK ${PORTAL} $(cat ${out})`);

}
