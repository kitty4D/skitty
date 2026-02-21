// network helpers for Sui endpoints

// RPC endpoints
export const RPC_ENDPOINTS = {
  MAINNET: 'https://fullnode.mainnet.sui.io',
  TESTNET: 'https://fullnode.testnet.sui.io',
  DEVNET: 'https://fullnode.devnet.sui.io',
  LOCAL: 'http://localhost:9000',
};

// GraphQL endpoints
export const GRAPHQL_ENDPOINTS = {
  MAINNET: 'https://graphql.mainnet.sui.io/graphql',
  TESTNET: 'https://graphql.testnet.sui.io/graphql',
  DEVNET: 'https://graphql.devnet.sui.io/graphql',
};

// network types
export type Network = 'mainnet' | 'testnet' | 'devnet' | 'local' | string;

// get RPC endpoint URL for a Sui network
export function getRpcUrl(network: Network): string {
  switch (network) {
    case 'mainnet':
      return RPC_ENDPOINTS.MAINNET;
    case 'testnet':
      return RPC_ENDPOINTS.TESTNET;
    case 'devnet':
      return RPC_ENDPOINTS.DEVNET;
    case 'local':
      return RPC_ENDPOINTS.LOCAL;
    default:
      return network;
  }
}

// get GraphQL endpoint URL for a Sui network
export function getGraphQLUrl(network: Network): string {
  switch (network) {
    case 'mainnet':
      return GRAPHQL_ENDPOINTS.MAINNET;
    case 'testnet':
      return GRAPHQL_ENDPOINTS.TESTNET;
    case 'devnet':
      return GRAPHQL_ENDPOINTS.DEVNET;
    default:
      return GRAPHQL_ENDPOINTS.MAINNET; // default to mainnet for unknown networks
  }
}