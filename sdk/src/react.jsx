// react.jsx — wagmi hooks + drop-in React components for SLOW.
//
// Optional layer. Peer deps: react, wagmi, viem. Everything here is built on
// the typed configs in viem.js, so the ABI/id math stays consistent with the
// core SDK and the on-chain dapp.
//
//   import { useSlowPosition, useDeposit, SlowSendForm } from './sdk/src/react.jsx';
//
// Wrap your app in wagmi's <WagmiProvider> + <QueryClientProvider> as usual.

import React, { useState, useMemo } from 'react';
import {
  useReadContract, useReadContracts, useWriteContract, useAccount, useChainId,
  usePublicClient,
} from 'wagmi';
import {
  slowContract, depositArgs, withdrawArgs, reverseArgs, clawbackArgs, unlockArgs,
  setGuardianArgs, setApprovalForAllArgs, encodeIdViem, decodeIdViem, tokenInfo,
  delaySeconds, parseUnits, formatUnits, MAINNET_CHAIN_ID, DELAYS, TOKENS,
  resolveNameViem, reverseNameViem,
} from './viem.js';
import { isName } from './names.js';

// ---------------------------------------------------------------------------
// Read hooks
// ---------------------------------------------------------------------------

/** Full wrapper balance for an id (includes locked funds). */
export function useBalance(owner, id) {
  return useReadContract({ ...slowContract, functionName: 'balanceOf', args: [owner, id], query: { enabled: !!owner && id != null } });
}

/** Spendable balance for an id — what the user can actually move. */
export function useUnlockedBalance(owner, id) {
  return useReadContract({ ...slowContract, functionName: 'unlockedBalances', args: [owner, id], query: { enabled: !!owner && id != null } });
}

/**
 * A single position: total + unlocked + locked (derived), plus decoded id.
 * Returns { data: { total, unlocked, locked, token, delay }, isLoading }.
 */
export function useSlowPosition(owner, id) {
  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...slowContract, functionName: 'balanceOf', args: [owner, id] },
      { ...slowContract, functionName: 'unlockedBalances', args: [owner, id] },
    ],
    query: { enabled: !!owner && id != null },
  });
  const parsed = useMemo(() => {
    if (!data) return undefined;
    const total = data[0]?.result ?? 0n;
    const unlocked = data[1]?.result ?? 0n;
    const { token, delay } = decodeIdViem(id);
    return { total, unlocked, locked: total > unlocked ? total - unlocked : 0n, token, delay };
  }, [data, id]);
  return { data: parsed, isLoading, refetch };
}

/** The recipient's inbound pending-transfer ids. */
export function useInboundTransfers(user) {
  return useReadContract({ ...slowContract, functionName: 'getInboundTransfers', args: [user], query: { enabled: !!user } });
}

/** The sender's outbound pending-transfer ids. */
export function useOutboundTransfers(user) {
  return useReadContract({ ...slowContract, functionName: 'getOutboundTransfers', args: [user], query: { enabled: !!user } });
}

/** Decoded pending transfer + lifecycle flags for a transferId. */
export function usePendingTransfer(transferId, now = Math.floor(Date.now() / 1000)) {
  const { data, isLoading, refetch } = useReadContract({
    ...slowContract, functionName: 'pendingTransfers', args: [transferId],
    query: { enabled: transferId != null },
  });
  const parsed = useMemo(() => {
    if (!data) return undefined;
    const [timestamp, from, to, id, amount] = data;
    if (timestamp === 0n) return null;
    const { token, delay } = decodeIdViem(id);
    const created = Number(timestamp), expiry = created + delay, clawbackAt = expiry + 2592000;
    return {
      transferId, timestamp: created, from, to, id, amount, token, delay, expiry, clawbackAt,
      pending: now < expiry, reversible: now < expiry,
      settleable: now >= expiry, clawbackReady: now >= clawbackAt,
      secondsUntilExpiry: Math.max(0, expiry - now),
    };
  }, [data, transferId, now]);
  return { data: parsed, isLoading, refetch };
}

/** The active guardian for a user (zero address = none). */
export function useGuardian(user) {
  return useReadContract({ ...slowContract, functionName: 'guardians', args: [user], query: { enabled: !!user } });
}

/** The on-chain SVG data-URI for an id (wallet/marketplace art). */
export function useTokenUri(id) {
  return useReadContract({ ...slowContract, functionName: 'uri', args: [id], query: { enabled: id != null } });
}

/**
 * Resolve an ENS or `.wei` (WNS) name to an address. Unlike wagmi's `useEnsAddress`,
 * this also handles `.wei`. Returns { resolve, resolving, address, error }.
 */
export function useResolveName() {
  const publicClient = usePublicClient();
  const [state, setState] = useState({ resolving: false, address: null, error: null });
  const resolve = React.useCallback(async (name) => {
    if (!isName(name)) return name; // already an address
    setState({ resolving: true, address: null, error: null });
    try {
      const address = await resolveNameViem(publicClient, name);
      setState({ resolving: false, address, error: address ? null : new Error('Name did not resolve') });
      return address;
    } catch (error) {
      setState({ resolving: false, address: null, error });
      return null;
    }
  }, [publicClient]);
  return { resolve, ...state };
}

/** Reverse-resolve an address to a name (WNS `.wei` first, then ENS). Returns the name or null. */
export function useReverseName(addr) {
  const publicClient = usePublicClient();
  const [name, setName] = useState(null);
  React.useEffect(() => {
    let live = true;
    if (!addr || !publicClient) { setName(null); return; }
    reverseNameViem(publicClient, addr).then(n => { if (live) setName(n); }).catch(() => {});
    return () => { live = false; };
  }, [addr, publicClient]);
  return name;
}

// ---------------------------------------------------------------------------
// Write hooks — each returns wagmi's useWriteContract result + a typed action.
// ---------------------------------------------------------------------------

function useAction(build) {
  const w = useWriteContract();
  return { ...w, submit: (...args) => w.writeContract(build(...args)) };
}

export const useDeposit  = () => useAction(depositArgs);
export const useWithdraw = () => useAction(withdrawArgs);
export const useReverse  = () => useAction(reverseArgs);
export const useClawback = () => useAction(clawbackArgs);
export const useUnlock   = () => useAction(unlockArgs);
export const useSetGuardian = () => useAction(setGuardianArgs);
export const useSetApprovalForAll = () => useAction(setApprovalForAllArgs);

// ---------------------------------------------------------------------------
// Drop-in components
// ---------------------------------------------------------------------------

const WRONG_NET_MSG = 'Switch to Ethereum mainnet to use SLOW.';

/**
 * A minimal, unstyled send form: token + amount + recipient + timelock.
 * Bring your own CSS via `className`s or wrap it. Emits onSent(txHash).
 */
export function SlowSendForm({ onSent, tokens = TOKENS, className }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { submit, data: hash, isPending, error } = useDeposit();
  const { resolve, resolving } = useResolveName();
  const [tokenKey, setTokenKey] = useState('ETH');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [delayKey, setDelayKey] = useState('1d');
  const [resolveErr, setResolveErr] = useState(null);

  const wrongNet = isConnected && chainId !== MAINNET_CHAIN_ID;

  React.useEffect(() => { if (hash && onSent) onSent(hash); }, [hash]); // eslint-disable-line

  async function handleSubmit(e) {
    e.preventDefault();
    setResolveErr(null);
    const t = tokens[tokenKey];
    // Accepts 0x…, ENS (.eth), or WNS (.wei) — resolves names to an address first.
    const recipient = await resolve(to.trim());
    if (!recipient) { setResolveErr(`Could not resolve "${to.trim()}"`); return; }
    submit({
      to: recipient, token: t.address, delay: DELAYS[delayKey],
      amount: parseUnits(amount || '0', t.decimals),
    });
  }

  return (
    <form className={className} onSubmit={handleSubmit}>
      <select value={tokenKey} onChange={e => setTokenKey(e.target.value)}>
        {Object.keys(tokens).map(k => <option key={k} value={k}>{tokens[k].symbol}</option>)}
      </select>
      <input placeholder="Amount" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" />
      <input placeholder="Recipient — 0x…, name.eth, or name.wei" value={to} onChange={e => setTo(e.target.value)} />
      <select value={delayKey} onChange={e => setDelayKey(e.target.value)}>
        {Object.keys(DELAYS).map(k => <option key={k} value={k}>{k === 'none' ? 'No timelock' : k}</option>)}
      </select>
      <button type="submit" disabled={!isConnected || wrongNet || isPending || resolving}>
        {resolving ? 'Resolving name…' : isPending ? 'Confirm in wallet…' : 'Send with SLOW'}
      </button>
      {wrongNet && <p role="alert">{WRONG_NET_MSG}</p>}
      {resolveErr && <p role="alert">{resolveErr}</p>}
      {error && <p role="alert">{error.shortMessage || error.message}</p>}
    </form>
  );
}

/**
 * Shows spendable vs locked for one position, with unit formatting.
 * Pass `decimals` (18 for ETH); defaults to 18.
 */
export function PositionBadge({ owner, id, symbol = '', decimals = 18 }) {
  const { data, isLoading } = useSlowPosition(owner, id);
  if (isLoading || !data) return <span>…</span>;
  const spend = formatUnits(data.unlocked, decimals);
  const locked = formatUnits(data.locked, decimals);
  return (
    <span>
      <strong>{spend}</strong> {symbol} spendable
      {data.locked > 0n && <> · {locked} locked</>}
    </span>
  );
}

/**
 * Renders the on-chain SVG art for an id.
 */
export function PositionArt({ id, alt = 'SLOW position', ...img }) {
  const { data } = useTokenUri(id);
  if (!data) return null;
  return <img src={data} alt={alt} {...img} />;
}

export { encodeIdViem, decodeIdViem, tokenInfo, delaySeconds, DELAYS, TOKENS };
