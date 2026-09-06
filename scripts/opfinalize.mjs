#!/usr/bin/env node
/**
 * Finalise a proved OP Stack withdrawal — the third and last transaction.
 *
 * Run it whenever you like: if the withdrawal is not ready it says what is
 * still holding it and how long is left, rather than reverting with a selector.
 * That matters because the wait is days long and split across two independent
 * clocks, and "not yet" is the answer almost every time you ask.
 *
 *   node scripts/opfinalize.mjs <l2TxHash>
 *
 * Env: L1_RPC, L2_RPC, PORTAL, PRIVATE_KEY (omit the key for a dry check).
 */
import { readWithdrawal, encodeWithdrawalTx, rpc, call, sel, word, strip, L1_RPC, L2_RPC, PORTAL }
  from './opprove.mjs';

const txHash = process.argv[2];
if (!txHash) { console.error('usage: opfinalize.mjs <l2TxHash>'); process.exit(1); }

const ME = process.env.PROOF_SUBMITTER;
const { wd, withdrawalHash } = await readWithdrawal(L2_RPC, txHash);
console.log('withdrawal hash :', withdrawalHash);
console.log('target          :', wd.target, '  value', wd.value, 'wei');

const already = BigInt(await call(L1_RPC, PORTAL, sel('finalizedWithdrawals(bytes32)') + strip(withdrawalHash)));
if (already === 1n) {
  console.log('\nAlready finalised. Nothing to do.');
  process.exit(0);
}

if (!ME) {
  console.error('\nSet PROOF_SUBMITTER to the address that proved it (the portal keys the proof by submitter).');
  process.exit(1);
}

// provenWithdrawals(bytes32,address) -> (IDisputeGame game, uint64 timestamp)
const pw = strip(await call(L1_RPC, PORTAL,
  sel('provenWithdrawals(bytes32,address)') + strip(withdrawalHash) + word(ME)));
const game = '0x' + pw.slice(24, 64);
const provenAt = Number(BigInt('0x' + pw.slice(64, 128)));
if (provenAt === 0) {
  console.error('\nNot proved by ' + ME + ' — run scripts/opprove.mjs first.');
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const maturity = Number(BigInt(await call(L1_RPC, PORTAL, sel('proofMaturityDelaySeconds()'))));
const status = Number(BigInt(await call(L1_RPC, game, sel('status()'))));
const STATUS = ['IN_PROGRESS', 'CHALLENGER_WINS', 'DEFENDER_WINS'];
const resolvedAt = Number(BigInt(await call(L1_RPC, game, sel('resolvedAt()')).catch(() => '0x0')));
const finalityDelay = Number(BigInt(await call(L1_RPC, PORTAL, sel('disputeGameFinalityDelaySeconds()'))));

const left = (s) => s <= 0 ? 'elapsed' : `${(s / 3600).toFixed(1)}h left`;
console.log('game            :', game, STATUS[status] ?? status);
console.log('proof maturity  :', left(provenAt + maturity - now));
console.log('game resolution :', status === 2
  ? `resolved, finality ${left(resolvedAt + finalityDelay - now)}`
  : 'not resolved yet (Base games take ~5 days)');

const blocked = [];
if (now < provenAt + maturity) blocked.push('proof has not matured');
if (status !== 2) blocked.push(`game is ${STATUS[status] ?? status}, needs DEFENDER_WINS`);
else if (now < resolvedAt + finalityDelay) blocked.push('game finality delay has not elapsed');
if (blocked.length) {
  console.log('\nNOT READY — ' + blocked.join('; '));
  process.exit(3);
}

const calldata = sel('finalizeWithdrawalTransaction((uint256,address,address,uint256,uint256,bytes))')
  + word(0x20) + encodeWithdrawalTx(wd);
console.log('\nREADY. calldata bytes:', calldata.length / 2 - 1);

const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.log('Set PRIVATE_KEY to send, or use:');
  console.log(`  cast send --rpc-url ${L1_RPC} --private-key $PK ${PORTAL} ${calldata}`);
  process.exit(0);
}
const { execFileSync } = await import('node:child_process');
const out = execFileSync('cast', ['send', '--rpc-url', L1_RPC, '--private-key', PK,
  '--gas-limit', '400000', PORTAL, calldata], { encoding: 'utf8' });
console.log(out.split('\n').filter((l) => /^(transactionHash|status|gasUsed)/.test(l)).join('\n'));
