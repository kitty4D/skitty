import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createNetworkConfig, SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import '@mysten/dapp-kit/dist/index.css';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import App from './App';
import { graphQLClient } from './graphql/client';
import './index.css';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

const { networkConfig } = createNetworkConfig({
  mainnet: { url: GRAPHQL_URL, network: 'mainnet' },
});

// dapp-kit would build a SuiJsonRpcClient from the url, but Sui's public fullnodes no
// longer answer JSON-RPC at all. Hand it the GraphQL client the rest of the app uses;
// the cast is only needed because dapp-kit still types this as the JSON-RPC client.
const createClient = () => graphQLClient as unknown as SuiJsonRpcClient;

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={networkConfig}
        defaultNetwork="mainnet"
        createClient={createClient}
      >
        <WalletProvider>
          <App />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </StrictMode>
);
