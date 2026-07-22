// wallet.js — wallet-display helpers for SLOW positions.
//
// The critical subtlety: an ERC-1155 wallet shows `balanceOf(id)` — the FULL
// wrapper balance, INCLUDING amounts still locked in pending transfers. The
// spendable amount is `unlockedBalances(user, id)`. Any wallet or dapp surface
// that lets a user act on funds MUST show the unlocked figure, or it will
// promise funds the user cannot yet move.
//
// This module builds a portfolio view that separates the two, and provides the
// EIP-747 `wallet_watchAsset` payload so a token id shows up in the wallet.

import { decodeId, formatUnits } from './codec.js';
import { SLOW_ADDRESS, ETH } from './abi.js';

/**
 * Suggest a SLOW position id to the connected wallet (EIP-747 / MetaMask
 * `wallet_watchAsset`, ERC-1155 form). Not all wallets support ERC-1155 here;
 * callers should treat a rejection/lack of support as non-fatal.
 *
 * @param {{request: Function}} provider
 * @param {bigint|string} id - the SLOW token id.
 * @param {object} [opts] - { address } to override the contract.
 * @returns {Promise<boolean>} whether the wallet accepted.
 */
export async function watchAsset(provider, id, opts = {}) {
  const address = opts.address || SLOW_ADDRESS;
  try {
    return await provider.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC1155',
        options: { address, tokenId: (typeof id === 'bigint' ? id : BigInt(id)).toString() },
      },
    });
  } catch {
    return false;
  }
}

/**
 * Build a spendable-vs-locked view for a set of ids the user holds.
 * Pass a SlowClient and the ids (e.g. from inbound/outbound enumeration or an
 * indexer). For each id it reads full + unlocked balance and labels the split.
 *
 * @param {import('./client.js').SlowClient} client
 * @param {string} owner
 * @param {Array<bigint|string>} ids
 * @returns {Promise<Array<{id, token, delay, total, unlocked, locked, display}>>}
 */
export async function portfolio(client, owner, ids) {
  const out = [];
  for (const rawId of ids) {
    const id = typeof rawId === 'bigint' ? rawId : BigInt(rawId);
    const { token, delay } = decodeId(id);
    const [total, unlocked] = await Promise.all([
      client.balanceOf(owner, id),
      client.unlockedBalanceOf(owner, id),
    ]);
    if (total === 0n && unlocked === 0n) continue;
    const dec = await client.decimalsOf(token === ETH ? 'ETH' : token);
    const locked = total > unlocked ? total - unlocked : 0n;
    out.push({
      id, token, delay, total, unlocked, locked,
      display: {
        total: formatUnits(total, dec),
        unlocked: formatUnits(unlocked, dec),
        locked: formatUnits(locked, dec),
        decimals: dec,
      },
    });
  }
  return out;
}

/**
 * Decode the on-chain SVG data-URI into its raw markup, for embedding in a UI
 * that would rather inline the SVG than use an <img src="data:…"> tag.
 * @param {string} dataUri - the `data:image/svg+xml;base64,…` string from uri().
 * @returns {string} the decoded SVG document.
 */
export function svgFromDataUri(dataUri) {
  const marker = 'base64,';
  const i = dataUri.indexOf(marker);
  if (i === -1) return dataUri;
  const b64 = dataUri.slice(i + marker.length);
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('utf8'); // Node fallback
}

/**
 * One-liner for a wallet row: "0.5 ETH spendable · 1.0 locked (2d timelock)".
 * @param {object} entry - an item from portfolio().
 */
export function describePosition(entry) {
  const { display, delay } = entry;
  const sym = entry.token === ETH ? 'ETH' : entry.token.slice(0, 6) + '…';
  const lockPart = entry.locked > 0n
    ? ` · ${display.locked} locked (${fmtDelay(delay)} timelock)`
    : '';
  return `${display.unlocked} ${sym} spendable${lockPart}`;
}

function fmtDelay(s) {
  if (s <= 0) return 'instant';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd';
  if (h) return h + 'h';
  if (m) return m + 'm';
  return s + 's';
}
