import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

// shared RPC client for SuiNS resolution and burn discovery (getOwnedObjects, getNormalizedMoveModule)
export const rpcClient = new SuiJsonRpcClient({
  url: 'https://fullnode.mainnet.sui.io',
  network: 'mainnet',
});
