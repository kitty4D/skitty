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
    // try official SuiNS SDK first
    try {
      const nameRecord = await suinsClient.getNameRecord(`${name}.sui`) as { targetAddress?: string; ownerAddress?: string } | null | undefined;
      
      // check target address (forward resolution)
      if (nameRecord?.targetAddress) {
        const address = nameRecord.targetAddress;
        domainCache.set(domain, address);
        return address;
      }
      
      // fall back to owner address
      if (nameRecord?.ownerAddress) {
        const address = nameRecord.ownerAddress;
        domainCache.set(domain, address);
        return address;
      }
    } catch {
      // SDK failed; fall through to GraphQL
    }
    
    // fall back to GraphQL if SDK fails
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
      
      type SuinsRegistration = {
        targetAddress?: string;
        ownerAddress?: string;
        nft?: { owner?: { address?: string } };
      };
      const reg = (data as { suinsRegistration?: SuinsRegistration })?.suinsRegistration;

      // try target address first
      if (reg?.targetAddress) {
        const address = reg.targetAddress;
        domainCache.set(domain, address);
        return address;
      }
      
      // then owner address
      if (reg?.ownerAddress) {
        const address = reg.ownerAddress;
        domainCache.set(domain, address);
        return address;
      }
      
      // finally NFT owner address
      if (reg?.nft?.owner?.address) {
        const address = reg.nft.owner.address;
        domainCache.set(domain, address);
        return address;
      }
    } catch {
      // GraphQL resolution failed
    }
    
    // no resolution found
    domainCache.set(domain, null);
    return null;
  } catch {
    domainCache.set(domain, null);
    return null;
  }
}

// true if input looks like a SuiNS domain
export function isSuiNSDomain(input: string): boolean {
  return input?.toLowerCase?.().endsWith('.sui') ?? false;
}