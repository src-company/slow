// viem.js — typed viem / wagmi adapter for SLOW.
//
// Thin, optional layer on top of the zero-dep core. Requires `viem` as a peer
// dependency (and `wagmi` if you use the React hooks in react.jsx). It parses
// the human-readable ABI from abi.js into a typed viem ABI and exposes ready
// contract configs plus a few typed action helpers.
//
//   import { slowContract, gateContract, encodeIdViem } from './sdk/src/viem.js';
//   import { readContract } from 'viem/actions';
//   const bal = await readContract(client, { ...slowContract, functionName: 'unlockedBalances', args: [user, id] });

import { parseAbi } from 'viem';
import {
  SLOW_ADDRESS, SLOW_ABI, GATE_ABI, ERC20_ABI, ETH, TOKENS, DELAYS,
  MAINNET_CHAIN_ID,
} from './abi.js';
// Reuse the exact codec for id math so viem consumers agree with the core/dapp.
import { encodeId as _encodeId, decodeId as _decodeId, parseUnits, formatUnits } from './codec.js';
import { resolveName as _resolveName, reverseName as _reverseName } from './names.js';

/** Typed viem ABIs (parsed from the human-readable forms). */
export const slowAbi = parseAbi(SLOW_ABI);
export const gateAbi = parseAbi(GATE_ABI);
export const erc20Abi = parseAbi(ERC20_ABI);

/** Spread into viem `readContract` / `writeContract` / `simulateContract` calls. */
export const slowContract = { address: SLOW_ADDRESS, abi: slowAbi };
export const gateContract = { abi: gateAbi }; // address discovered via slow.gate()

export { SLOW_ADDRESS, ETH, TOKENS, DELAYS, MAINNET_CHAIN_ID };

// -- id + unit helpers (typed passthroughs) ---------------------------------

/** @returns {bigint} */
export const encodeIdViem = (token, delaySeconds) => _encodeId(token, delaySeconds);
/** @returns {{token: `0x${string}`, delay: number}} */
export const decodeIdViem = (id) => _decodeId(id);

/** Resolve "ETH"|symbol|address to a viem address + decimals. */
export function tokenInfo(token) {
  if (token == null || token === 'ETH') return { address: ETH, decimals: 18 };
  if (typeof token === 'string' && TOKENS[token]) return TOKENS[token];
  if (typeof token === 'string' && token.startsWith('0x')) return { address: token, decimals: undefined };
  return token;
}

/** Delay shorthand ("1d") or seconds -> number. */
export const delaySeconds = (d) => (typeof d === 'string' && d in DELAYS ? DELAYS[d] : Number(d ?? 0));

// -- name resolution (ENS + WNS .wei) over a viem client --------------------
//
// wagmi/viem resolve ENS natively but NOT `.wei` (WNS). These adapt a viem
// public client to the core resolver so both name services work uniformly.

/** Wrap a viem public client in the `{ call(data, to) }` shape the core resolver expects. */
export const viemCallAdapter = (publicClient) => ({
  call: async (data, to) => {
    const { data: ret } = await publicClient.call({ to, data });
    return ret ?? '0x';
  },
});

/** Resolve an ENS or `.wei` name to an address using a viem public client. */
export const resolveNameViem = (publicClient, name) => _resolveName(viemCallAdapter(publicClient), name);

/** Reverse-resolve an address (WNS `.wei` first, then ENS) using a viem public client. */
export const reverseNameViem = (publicClient, addr) => _reverseName(viemCallAdapter(publicClient), addr);

// -- write-args builders (return viem `simulate/writeContract` params) ------
//
// Each returns an object you can spread with a `walletClient.writeContract`.
// They keep the ETH/ERC-20/tip branching in one tested place.

/**
 * Build args for a deposit. For ETH the returned object includes `value`.
 * @param {{to:`0x${string}`, amount:bigint, token?:any, delay?:string|number, tip?:bigint, data?:`0x${string}`}} o
 */
export function depositArgs({ to, amount, token = 'ETH', delay = 0, tip = 0n, data = '0x' }) {
  const t = tokenInfo(token);
  const del = delaySeconds(delay);
  const isEth = t.address === ETH;
  if (tip && tip > 0n) {
    if (!del) throw new Error('deposit: tip requires delay > 0');
    return {
      ...slowContract,
      functionName: 'depositToWithTip',
      args: [isEth ? ETH : t.address, to, amount, del, tip, data],
      value: isEth ? amount + tip : tip,
    };
  }
  return {
    ...slowContract,
    functionName: 'depositTo',
    args: [isEth ? ETH : t.address, to, isEth ? 0n : amount, del, data],
    value: isEth ? amount : 0n,
  };
}

export const withdrawArgs = ({ from, to, id, amount }) => ({
  ...slowContract, functionName: 'withdrawFrom', args: [from, to, id, amount],
});
export const transferArgs = ({ from, to, id, amount, data = '0x' }) => ({
  ...slowContract, functionName: 'safeTransferFrom', args: [from, to, id, amount, data],
});
export const reverseArgs = (transferId) => ({ ...slowContract, functionName: 'reverse', args: [transferId] });
export const clawbackArgs = (transferId) => ({ ...slowContract, functionName: 'clawback', args: [transferId] });
export const unlockArgs = (transferId) => ({ ...slowContract, functionName: 'unlock', args: [transferId] });
export const claimArgs = (transferId) => ({ ...slowContract, functionName: 'claim', args: [transferId] });
export const setGuardianArgs = (g) => ({ ...slowContract, functionName: 'setGuardian', args: [g] });
export const approveTransferArgs = (from, transferId) => ({ ...slowContract, functionName: 'approveTransfer', args: [from, transferId] });
export const setApprovalForAllArgs = (operator, approved = true) => ({ ...slowContract, functionName: 'setApprovalForAll', args: [operator, approved] });

export { parseUnits, formatUnits };
