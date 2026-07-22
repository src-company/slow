// wagmi-react.jsx — dapp integration with wagmi + the SLOW React layer.
//
// Assumes a standard wagmi v2 + viem + @tanstack/react-query setup. This file
// shows the provider wiring and a tiny send + inbox UI using the SDK hooks.

import React from 'react';
import { WagmiProvider, createConfig, http, useAccount } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  SlowSendForm, PositionBadge, useInboundTransfers, usePendingTransfer, useUnlock,
} from '../src/react.jsx';

const config = createConfig({
  chains: [mainnet],
  connectors: [injected()],
  transports: { [mainnet.id]: http() },
});
const queryClient = new QueryClient();

function Inbox() {
  const { address } = useAccount();
  const { data: ids } = useInboundTransfers(address);
  return (
    <ul>
      {(ids || []).map(id => <InboxRow key={id.toString()} transferId={id} />)}
    </ul>
  );
}

function InboxRow({ transferId }) {
  const { data: pt } = usePendingTransfer(transferId);
  const { submit, isPending } = useUnlock();
  if (!pt) return null;
  return (
    <li>
      from {pt.from.slice(0, 8)}… —{' '}
      {pt.settleable
        ? <button disabled={isPending} onClick={() => submit(transferId)}>Unlock</button>
        : <span>{pt.secondsUntilExpiry}s until unlockable</span>}
    </li>
  );
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <h1>SLOW dapp</h1>
        <SlowSendForm onSent={hash => console.log('deposit tx', hash)} />
        <h2>Inbound</h2>
        <Inbox />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
