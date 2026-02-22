// POST /api/sponsor – sponsor gas for reclaim transactions
// body: { txBytes: string (base64 transaction kind bytes), userAddress: string }
// returns: { sponsoredTxBytes: string (base64), sponsorSignature: string }

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const GAS_BUDGET_MIST = 50_000_000;

function getHouseKeypair() {
  const secret = process.env.SUI_SPONSOR_PRIV;
  if (!secret) throw new Error('SUI_SPONSOR_PRIV is not set');
  // works with suiprivkey... or base64
  return Ed25519Keypair.fromSecretKey(secret);
}

// same shape as SDK getCoins: address.objects(filter: { type }) for SUI coins
const SUI_COIN_TYPE = '0x2::coin::Coin<0x2::sui::SUI>';

async function fetchSponsorCoinGQL(client, address) {
  const query = `
    query($address: SuiAddress!, $type: String!) {
      address(address: $address) {
        objects(first: 1, filter: { type: $type }) {
          nodes {
            ... on MoveObject {
              address
              version
              digest
            }
          }
        }
      }
    }
  `;

  const result = await client.query({
    query,
    variables: { address, type: SUI_COIN_TYPE },
  });

  const nodes = result.data?.address?.objects?.nodes ?? [];
  const coin = nodes[0];
  if (!coin?.address) {
    throw new Error(
      'Sponsor wallet has no SUI coins. Send some SUI to the sponsor (fee recipient) address so it can pay for gas.'
    );
  }

  return {
    objectId: coin.address,
    version: coin.version,
    digest: coin.digest,
  };
}

export default async function handler(req, res) {
    
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { txBytes, userAddress } = req.body ?? {};
    if (!txBytes || !userAddress) return res.status(400).json({ error: 'Missing params' });

    if (!process.env.SUI_SPONSOR_PRIV) {
      return res.status(503).json({
        error: 'Sponsor not configured. Add SUI_SPONSOR_PRIV to your deployment environment (e.g. Vercel project env vars).',
      });
    }

    const houseKeypair = getHouseKeypair();
    const sponsorAddress = houseKeypair.getPublicKey().toSuiAddress();

    // Fresh client per request to avoid shared-handle / libuv issues (e.g. double sponsor + dry run flow)
    const gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

    // 1. reconstruct from kind
    const kindBytes = typeof txBytes === 'string' ? Buffer.from(txBytes, 'base64') : txBytes;
    const tx = Transaction.fromKind(kindBytes);

    // 2. setup sponsorship
    tx.setSender(userAddress);
    tx.setGasOwner(sponsorAddress);
    tx.setGasBudget(GAS_BUDGET_MIST);

    // 3. get gas coin via GQL
    const gasCoin = await fetchSponsorCoinGQL(gqlClient, sponsorAddress);
    tx.setGasPayment([gasCoin]);

    // 4. build the transaction once
    const builtBytes = await tx.build({ client: gqlClient });

    // 5. sign the built bytes directly (signature for full transaction: data + gas + budget)
    const { signature } = await houseKeypair.signTransaction(builtBytes);

    // 6. Let handles/connections release before closing the response (avoids libuv UV_HANDLE_CLOSING on Windows)
    await new Promise((r) => setTimeout(r, 100));

    return res.status(200).json({
      sponsoredTxBytes: Buffer.from(builtBytes).toString('base64'),
      sponsorSignature: signature,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message ?? 'Sponsorship failed' });
  }
}
