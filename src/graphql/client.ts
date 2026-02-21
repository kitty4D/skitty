import { SuiGraphQLClient } from '@mysten/sui/graphql';

// init GraphQL client with the direct endpoint URL
const graphQLClient = new SuiGraphQLClient({
  url: 'https://graphql.mainnet.sui.io/graphql',
  network: 'mainnet',
});

export { graphQLClient };

// SuiNS domain resolution via GraphQL
export async function resolveSuiNSDomainViaGraphQL(domain: string): Promise<string | null> {
  if (!domain.endsWith('.sui')) {
    return null;
  }
  
  // strip .sui for the query
  const name = domain.toLowerCase().replace(/\.sui$/, '');
  
  try {
    const { data } = await graphQLClient.query({
      query: `
        query ResolveDomain($name: String!) {
          suinsRegistration(name: $name) {
            targetAddress
            ownerAddress
          }
        }
      `,
      variables: {
        name,
      },
    });
    
    console.log('GraphQL domain resolution result:', data);
    
    type SuinsReg = { targetAddress?: string; ownerAddress?: string };
    const reg = (data as { suinsRegistration?: SuinsReg })?.suinsRegistration;
    
    // try target address first
    if (reg?.targetAddress) {
      return reg.targetAddress;
    }
    
    // fall back to owner address
    if (reg?.ownerAddress) {
      return reg.ownerAddress;
    }
    
    return null;
  } catch (error) {
    console.error('Error resolving domain via GraphQL:', error);
    return null;
  }
}