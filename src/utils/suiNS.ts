import { SuinsClient } from '@mysten/suins';
import { graphQLClient } from '../graphql/client';
import { rpcClient } from '../rpcClient';

const suinsClient = new SuinsClient({ client: rpcClient });

// cache resolved domains so we don't look up again
const domainCache = new Map<string, string | null>();

// resolve SuiNS domain to address via official SuiNS SDK; fall back to GraphQL if SDK fails
export async function resolveSuiNSDomain(
  domain: string
): Promise<string | null> {
  if (!domain.endsWith('.sui')) {
    return null;
  }
  
  // check cache first
  if (domainCache.has(domain)) {
    return domainCache.get(domain) || null;
  }
  
  // strip .sui for SuiNS SDK
  const name = domain.toLowerCase().replace(/\.sui$/, '');
  
  try {
    console.log(`Resolving ${domain} using SuiNS SDK...`);
    
    // try official SuiNS SDK first
    try {
      const nameRecord = await suinsClient.getNameRecord(`${name}.sui`) as { targetAddress?: string; ownerAddress?: string } | null | undefined;
      console.log('SuiNS SDK resolution result:', nameRecord);
      
      // check target address (forward resolution)
      if (nameRecord?.targetAddress) {
        const address = nameRecord.targetAddress;
        console.log(`Resolved ${domain} to ${address} via SuiNS SDK targetAddress`);
        domainCache.set(domain, address);
        return address;
      }
      
      // fall back to owner address
      if (nameRecord?.ownerAddress) {
        const address = nameRecord.ownerAddress;
        console.log(`Resolved ${domain} to ${address} via SuiNS SDK ownerAddress`);
        domainCache.set(domain, address);
        return address;
      }
    } catch (sdkError) {
      console.error('SuiNS SDK resolution error:', sdkError);
    }
    
    // fall back to GraphQL if SDK fails
    console.log(`Falling back to GraphQL resolution for ${domain}...`);
    try {
      const { data } = await graphQLClient.query({
        query: `
          query ResolveDomain($name: String!) {
            suinsRegistration(name: $name) {
              targetAddress
              ownerAddress
              nft {
                owner {
                  address
                }
              }
            }
          }
        `,
        variables: {
          name,
        },
      });
      
      console.log('GraphQL domain resolution result:', data);
      
      type SuinsRegistration = {
        targetAddress?: string;
        ownerAddress?: string;
        nft?: { owner?: { address?: string } };
      };
      const reg = (data as { suinsRegistration?: SuinsRegistration })?.suinsRegistration;
      
      // try target address first
      if (reg?.targetAddress) {
        const address = reg.targetAddress;
        console.log(`Resolved ${domain} to ${address} via GraphQL targetAddress`);
        domainCache.set(domain, address);
        return address;
      }
      
      // then owner address
      if (reg?.ownerAddress) {
        const address = reg.ownerAddress;
        console.log(`Resolved ${domain} to ${address} via GraphQL ownerAddress`);
        domainCache.set(domain, address);
        return address;
      }
      
      // finally NFT owner address
      if (reg?.nft?.owner?.address) {
        const address = reg.nft.owner.address;
        console.log(`Resolved ${domain} to ${address} via GraphQL NFT owner`);
        domainCache.set(domain, address);
        return address;
      }
    } catch (graphqlError) {
      console.error('GraphQL resolution failed:', graphqlError);
    }
    
    // no resolution found
    console.log(`Could not resolve ${domain} via any method`);
    domainCache.set(domain, null);
    return null;
  } catch (error) {
    console.error('Error resolving SuiNS domain:', error);
    domainCache.set(domain, null);
    return null;
  }
}

// true if input looks like a SuiNS domain
export function isSuiNSDomain(input: string): boolean {
  return input?.toLowerCase?.().endsWith('.sui') ?? false;
}