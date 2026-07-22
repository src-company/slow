#!/usr/bin/env node
// slow.mjs — agent-facing CLI for the SLOW protocol on Ethereum mainnet.
//
// Design goals (for autonomous agents):
//   • JSON in, JSON out — every command prints a single JSON object to stdout.
//   • Safe by default — write commands PREPARE an unsigned tx and print it.
//     Nothing is submitted unless you pass --send.
//   • Zero-dependency for reads + prepare. Signing with --send + a key needs
//     `viem` (loaded lazily, only then).
//   • Names: --to accepts 0x…, name.eth, or name.wei (resolved and echoed).
//
// Reads need only an RPC. Set RPC_URL (comma-separated for a fallback pool);
// otherwise a keyless public mainnet pool is used.
//
// Usage:
//   node slow.mjs help
//   node slow.mjs id <token> <delay>
//   node slow.mjs resolve <name>
//   node slow.mjs balance <owner> <token> <delay>
//   node slow.mjs inbox <address|name>
//   node slow.mjs outbox <address|name>
//   node slow.mjs status <transferId>
//   node slow.mjs send --to <addr|name> --amount <n> [--token ETH] [--delay 1d] [--tip <wei>] [--send]
//   node slow.mjs unlock   <transferId> [--send]
//   node slow.mjs reverse  <transferId> [--send]
//   node slow.mjs clawback <transferId> [--send]
//   node slow.mjs withdraw --from <addr> --to <addr|name> --id <id> --amount <base> [--send]
//   node slow.mjs guardian set <addr> [--send]
//   node slow.mjs guardian approve <from> <transferId> [--send]
//
// Signing modes for --send:
//   • SLOW_PRIVATE_KEY set  → signs locally via viem (recommended for agents).
//   • otherwise             → eth_sendTransaction via RPC (unlocked/keystore node).
//     Provide the sender with --from or SLOW_ACCOUNT.
//
// NOTE: mainnet moves real funds. Prefer sending WITH a --delay: the recipient
// must wait, and you (the sender) can `reverse` before expiry if you erred —
// this makes SLOW an unusually safe rail for agent-initiated payments.

import { SlowClient } from '../../src/client.js';
import { decodeId, formatUnits } from '../../src/codec.js';
import * as keeper from '../../src/keeper.js';
import { TOKENS, ETH } from '../../src/abi.js';

const RPCS = (process.env.RPC_URL ||
  'https://eth.llamarpc.com,https://rpc.ankr.com/eth,https://cloudflare-eth.com,https://ethereum-rpc.publicnode.com'
).split(',').map(s => s.trim()).filter(Boolean);

// -- fetch-based EIP-1193 provider with RPC failover -------------------------
let rpcIdx = 0, callId = 1;
const provider = {
  async request({ method, params = [] }) {
    let lastErr;
    for (let i = 0; i < RPCS.length; i++) {
      const url = RPCS[(rpcIdx + i) % RPCS.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: callId++, method, params }),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        rpcIdx = (rpcIdx + i) % RPCS.length; // stick to the one that worked
        return j.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all RPCs failed');
  },
};

// -- tiny arg parser ---------------------------------------------------------
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = obj => { console.log(JSON.stringify(obj, replacer, 2)); };
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const fail = (msg, extra = {}) => { console.log(JSON.stringify({ ok: false, error: msg, ...extra }, replacer, 2)); process.exit(1); };

function tokenMeta(tokenArg) {
  if (!tokenArg || tokenArg === 'ETH') return { address: ETH, symbol: 'ETH', decimals: 18 };
  if (TOKENS[tokenArg]) return TOKENS[tokenArg];
  return { address: tokenArg, symbol: tokenArg.slice(0, 8), decimals: null };
}

// -- signing for --send ------------------------------------------------------
async function submit(txReq) {
  const key = process.env.SLOW_PRIVATE_KEY;
  if (key) {
    let viem;
    try { viem = await import('viem'); }
    catch { fail('viem is required to sign locally with SLOW_PRIVATE_KEY. `npm i viem`, or drop --send to just prepare the tx.'); }
    const { createWalletClient, http } = viem;
    const { privateKeyToAccount } = await import('viem/accounts');
    const { mainnet } = await import('viem/chains');
    const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);
    const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPCS[0]) });
    const hash = await wallet.sendTransaction({
      to: txReq.to, data: txReq.data,
      value: txReq.value ? BigInt(txReq.value) : 0n,
    });
    return { txHash: hash, signer: account.address, via: 'viem' };
  }
  // Unlocked / keystore node path.
  const from = txReq.from;
  if (!from) fail('No signer. Set SLOW_PRIVATE_KEY (local signing via viem) or pass --from / SLOW_ACCOUNT for an unlocked-node eth_sendTransaction.');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [txReq] });
  return { txHash: hash, signer: from, via: 'eth_sendTransaction' };
}

// Prepare a write; either print the unsigned tx (default) or --send it.
async function doWrite(action, prepared, flags) {
  const wantSend = flags.send === true;
  if (!wantSend) {
    return out({ ok: true, action, mode: 'prepared', tx: prepared,
      hint: 'Unsigned. Re-run with --send to submit, or hand this tx to your signer/wallet.' });
  }
  const result = await submit(prepared);
  out({ ok: true, action, mode: 'sent', ...result, tx: prepared });
}

// -- status enrichment -------------------------------------------------------
async function enrich(client, transferId) {
  const s = await client.pendingStatus(transferId);
  if (!s) return { transferId: String(transferId), exists: false };
  const { symbol, decimals } = tokenMeta(s.token === ETH ? 'ETH' : s.token);
  const dec = decimals ?? await client.decimalsOf(s.token === ETH ? 'ETH' : s.token);
  return {
    transferId: String(transferId), exists: true,
    from: s.from, to: s.to,
    token: s.token, symbol, amount: formatUnits(s.amount, dec), amountBase: s.amount,
    delaySeconds: s.delay,
    state: s.reversible ? 'pending' : s.clawbackReady ? 'clawback-ready' : 'settleable',
    reversible: s.reversible, settleable: s.settleable, clawbackReady: s.clawbackReady,
    secondsUntilExpiry: s.secondsUntilExpiry,
    expiry: s.expiry, clawbackAt: s.clawbackAt,
  };
}

// -- main --------------------------------------------------------------------
const HELP = {
  ok: true,
  tool: 'slow',
  what: 'CLI for SLOW — a timelock + guardian ERC-1155 wrapper for ETH/ERC-20 on Ethereum mainnet.',
  contract: '0x000000000000888741B254d37e1b27128AfEAaBC',
  safety: 'Writes PREPARE an unsigned tx by default. Pass --send to submit. Prefer --delay so mistakes can be reversed before expiry.',
  reads: {
    'id <token> <delaySpec>': 'compute the ERC-1155 id',
    'resolve <name>': 'resolve ENS/.wei name to an address',
    'balance <owner> <token> <delaySpec>': 'total (wrapper) vs unlocked (spendable) balance',
    'inbox <addr|name>': 'pending transfers owed TO a user, with lifecycle state',
    'outbox <addr|name>': 'pending transfers FROM a user',
    'status <transferId>': 'full lifecycle status of one transfer',
  },
  writes: {
    'send --to <addr|name> --amount <n> [--token ETH] [--delay 1d] [--tip <wei>]': 'wrap + send',
    'unlock <transferId>': 'recipient settles a matured transfer',
    'reverse <transferId>': 'sender cancels before expiry (undo a mistake)',
    'clawback <transferId>': 'sender recovers 30d after expiry',
    'withdraw --from <addr> --to <addr|name> --id <id> --amount <base>': 'unwrap to the underlying',
    'guardian set <addr> | guardian approve <from> <transferId>': 'guardian co-sign controls',
  },
  delaySpecs: ['none', '1h', '1d', '3d', '7d', '30d', 'or raw seconds'],
  tokens: Object.keys(TOKENS),
  send: 'SLOW_PRIVATE_KEY → local viem signing; else --from/SLOW_ACCOUNT → eth_sendTransaction (unlocked node).',
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { pos, flags } = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help') return out(HELP);

  const account = flags.from || process.env.SLOW_ACCOUNT || null;
  const client = new SlowClient(provider, { account, mode: 'prepare' });

  switch (cmd) {
    case 'id': {
      const [token, delay] = pos;
      const id = client.encodeId(token || 'ETH', delay ?? 0);
      return out({ ok: true, token: tokenMeta(token).address, delaySeconds: client.decodeId(id).delay, id: id.toString() });
    }
    case 'resolve': {
      const name = pos[0];
      const address = await client.resolveName(name);
      return address ? out({ ok: true, name, address }) : fail('name did not resolve', { name });
    }
    case 'balance': {
      const [owner, token, delay] = pos;
      const ownerAddr = await client.resolveRecipient(owner);
      const id = client.encodeId(token || 'ETH', delay ?? 0);
      const [total, unlocked] = await Promise.all([client.balanceOf(ownerAddr, id), client.unlockedBalanceOf(ownerAddr, id)]);
      const { symbol, decimals } = tokenMeta(token);
      const dec = decimals ?? await client.decimalsOf(token || 'ETH');
      return out({ ok: true, owner: ownerAddr, id: id.toString(), symbol,
        total: formatUnits(total, dec), unlocked: formatUnits(unlocked, dec),
        locked: formatUnits(total > unlocked ? total - unlocked : 0n, dec),
        note: 'unlocked = spendable; total includes funds still in pending transfers.' });
    }
    case 'inbox':
    case 'outbox': {
      const user = await client.resolveRecipient(pos[0]);
      const ids = cmd === 'inbox' ? await client.getInboundTransfers(user) : await client.getOutboundTransfers(user);
      const transfers = await Promise.all(ids.map(id => enrich(client, id)));
      return out({ ok: true, user, direction: cmd, count: transfers.length, transfers });
    }
    case 'status': {
      return out({ ok: true, ...(await enrich(client, BigInt(pos[0]))) });
    }
    case 'send': {
      if (!flags.to || flags.amount === undefined) return fail('send needs --to and --amount');
      const to = await client.resolveRecipient(flags.to);
      const prepared = await client.deposit({
        to, amount: String(flags.amount), token: flags.token || 'ETH',
        delay: flags.delay ?? 0, tip: flags.tip ? BigInt(flags.tip) : 0n,
      });
      prepared.resolvedRecipient = to;
      return doWrite('send', prepared, flags);
    }
    case 'unlock':
    case 'reverse':
    case 'clawback': {
      const id = BigInt(pos[0]);
      const prepared = await client[cmd](id);
      return doWrite(cmd, prepared, flags);
    }
    case 'withdraw': {
      const to = await client.resolveRecipient(flags.to);
      const prepared = await client.withdraw({ from: flags.from || account, to, id: BigInt(flags.id), amount: BigInt(flags.amount) });
      return doWrite('withdraw', prepared, flags);
    }
    case 'guardian': {
      const sub = pos[0];
      if (sub === 'set') return doWrite('guardian.set', await client.setGuardian(pos[1]), flags);
      if (sub === 'approve') return doWrite('guardian.approve', await client.approveTransfer(pos[1], BigInt(pos[2])), flags);
      return fail('guardian subcommand must be `set` or `approve`');
    }
    case 'gate': {
      return out({ ok: true, gate: await client.gate(), note: 'Approve this operator (setApprovalForAll) to let keepers settle your inbound transfers.' });
    }
    default:
      return fail('unknown command: ' + cmd, { try: 'node slow.mjs help' });
  }
}

main().catch(e => fail(e.message));
