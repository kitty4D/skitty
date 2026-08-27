// POST /api/sponsor – sponsor gas for reclaim transactions
// body: { txBytes: string (base64 transaction kind bytes), userAddress: string, simulateOnly?: boolean }
// returns: { sponsoredTxBytes: string (base64), sponsorSignature?: string, sponsorAddress: string }
//
// The sponsor signature authorizes the ENTIRE TransactionData, including the
// gas coin, so this endpoint must never blind-sign. Three gates stand between a
// caller and the house keypair:
//   1. per-IP rate limiting + origin check (below)
//   2. validateReclaimTransactionKind - structural allow-list
//   3. simulation: the sponsor's own SUI balance change must not be negative
// Gate 3 is the one that actually bounds value leaving the gas coin; gates 1-2
// keep this from being a free general-purpose signing/simulation service.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import {
  SPONSOR_REQUESTS_PER_MINUTE,
  SPONSOR_REQUESTS_PER_DAY,
  SPONSOR_GAS_BUDGET_MIST,
  SPONSOR_MIN_GAS_BUDGET_MIST,
  SPONSOR_GAS_BUDGET_MARGIN,
  SPONSOR_COIN_POOL_SIZE,
  SPONSOR_COIN_LOCK_SECONDS,
  SPONSOR_MAX_HELD_COINS_PER_CALLER,
} from './constants.js';
import {
  validateReclaimTransactionKind,
  netSuiChangeForAddress,
  gasCoinNetMist,
  SponsorPolicyError,
} from './sponsorPolicy.js';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const SUI_COIN_TYPE = '0x2::sui::SUI';

// max base64 payload we will even attempt to decode (~1MB of transaction kind)
const MAX_TX_BYTES_BASE64 = 1_400_000;

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

const rpmLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(SPONSOR_REQUESTS_PER_MINUTE, '1 m'),
      prefix: 'sponsor_rpm',
      analytics: true,
    })
  : null;

const rpdLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(SPONSOR_REQUESTS_PER_DAY, '1440 m'),
      prefix: 'sponsor_rpd',
      analytics: true,
    })
  : null;

function getHouseKeypair() {
  const secret = process.env.SUI_SPONSOR_PRIV;
  if (!secret) throw new Error('SUI_SPONSOR_PRIV is not set');
  // works with suiprivkey... or base64
  return Ed25519Keypair.fromSecretKey(secret);
}

// Rate limiting is only as good as the identity it keys on. Every forwarding header is
// client-settable unless a trusted proxy overwrites it, so we only believe them when we
// know we are behind one; otherwise everyone shares a single bucket, which throttles
// aggressively rather than handing out unlimited fresh identities.
const BEHIND_TRUSTED_PROXY = Boolean(process.env.VERCEL);

function clientIp(req) {
  if (!BEHIND_TRUSTED_PROXY) return 'untrusted-shared';
  const trusted = req.headers['x-vercel-forwarded-for'] ?? req.headers['x-real-ip'];
  if (typeof trusted === 'string' && trusted.length > 0) {
    return trusted.split(',')[0].trim();
  }
  return 'untrusted-shared';
}

// Only blocks other sites from driving this endpoint with a user's browser; a
// scripted caller can omit Origin entirely, which is what rate limiting is for.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.headers.host) return true;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true;
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return allowed.some((entry) => {
    try {
      return new URL(entry).host === host;
    } catch {
      return entry === host;
    }
  });
}

// A pool rather than a single coin: each issued signature reserves its own coin so two
// concurrent requests cannot sign conflicting transactions over the same coin version.
async function fetchSponsorCoins(client, address) {
  const { objects } = await client.listCoins({
    owner: address,
    coinType: SUI_COIN_TYPE,
    limit: SPONSOR_COIN_POOL_SIZE,
  });
  if (!objects?.length) {
    throw new Error(
      'Sponsor wallet has no SUI coins. Send some SUI to the sponsor address so it can pay for gas.'
    );
  }
  // listCoins has no balance ordering, so dust coins sent to the sponsor could otherwise
  // fill the page and crowd out every coin that can actually cover the gas budget
  return objects
    .map((coin) => ({
      objectId: coin.objectId,
      version: coin.version,
      digest: coin.digest,
      balanceMist: BigInt(coin.balance ?? 0),
    }))
    .sort((a, b) => (b.balanceMist > a.balanceMist ? 1 : b.balanceMist < a.balanceMist ? -1 : 0));
}

async function fetchCurrentEpoch(client) {
  try {
    const { data } = await client.query({ query: 'query { epoch { epochId } }', variables: {} });
    const epochId = Number(data?.epoch?.epochId);
    return Number.isFinite(epochId) ? epochId : null;
  } catch {
    return null;
  }
}

// Two signatures over the same coin VERSION are an equivocation risk: submit both and
// the coin is locked until end of epoch. The lock is therefore keyed on the version, not
// just the coin — a signature stays valid until the coin actually moves, which is far
// longer than any wall-clock TTL we could pick (the user has to approve in their wallet).
// Once the coin is spent its version changes, so the old key simply stops matching.
function coinLockKey(coin) {
  return `sponsor_coin_signed:${coin.objectId}:${coin.version}`;
}

async function reserveCoin(coins, identifier) {
  // only coins that can actually cover the budget we are about to set
  const usable = coins.filter((coin) => coin.balanceMist >= BigInt(SPONSOR_GAS_BUDGET_MIST));
  if (usable.length === 0) return null;
  if (!redis) {
    // no lock store: spread load across the pool so collisions are at least unlikely
    return usable[Math.floor(Math.random() * usable.length)];
  }
  // A signature is held until the coin moves, so one caller collecting signatures it
  // never submits could otherwise pin the whole pool and lock everyone else out.
  const holdsKey = `sponsor_holds:${identifier}`;
  // Create the key WITH its expiry first, then increment. Doing incr-then-expire leaves
  // a window where the expire never lands, and because the success path deliberately
  // never decrements, such a key would pin that caller at the cap forever.
  await redis.set(holdsKey, 0, { nx: true, ex: SPONSOR_COIN_LOCK_SECONDS });
  const holds = await redis.incr(holdsKey);
  if (holds > SPONSOR_MAX_HELD_COINS_PER_CALLER) {
    await redis.decr(holdsKey);
    return null;
  }
  for (const coin of usable) {
    const acquired = await redis.set(coinLockKey(coin), identifier, {
      nx: true,
      ex: SPONSOR_COIN_LOCK_SECONDS,
    });
    if (acquired) return { ...coin, identifier };
  }
  await redis.decr(holdsKey);
  return null;
}

async function releaseCoin(coin) {
  if (!redis || !coin) return;
  try {
    await redis.del(coinLockKey(coin));
    if (coin.identifier) {
      const holdsKey = `sponsor_holds:${coin.identifier}`;
      // if the counter already expired, decrementing would leave a permanent negative
      // that quietly hands this caller extra capacity
      const remaining = await redis.decr(holdsKey);
      if (remaining < 0) await redis.del(holdsKey);
    }
  } catch {
    // both keys expire on their own
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!originAllowed(req)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }

  let reservedCoin = null;
  try {
    const { txBytes, userAddress, simulateOnly } = req.body ?? {};
    if (typeof txBytes !== 'string' || !txBytes) {
      return res.status(400).json({ error: 'txBytes must be a base64 string.' });
    }
    if (txBytes.length > MAX_TX_BYTES_BASE64) {
      return res.status(413).json({ error: 'Transaction is too large to sponsor.' });
    }
    if (typeof userAddress !== 'string' || !isValidSuiAddress(userAddress)) {
      return res.status(400).json({ error: 'userAddress must be a valid Sui address.' });
    }
    const isSimulateOnly = simulateOnly === true;

    if (!process.env.SUI_SPONSOR_PRIV) {
      return res.status(503).json({
        error:
          'Sponsor not configured. Add SUI_SPONSOR_PRIV to your deployment environment (e.g. Vercel project env vars).',
      });
    }

    const identifier = clientIp(req);

    // Only signing costs us anything, so simulate-only calls skip the quota.
    if (!isSimulateOnly && rpmLimit && rpdLimit) {
      let result = await rpmLimit.limit(identifier);
      if (result.success) result = await rpdLimit.limit(identifier);
      if (!result.success) {
        const retryAfter = Math.max(0, Math.floor((result.reset - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'Too many sponsorship requests. Slow down! 🐾',
          retryAfterSeconds: retryAfter,
        });
      }
    }

    const houseKeypair = getHouseKeypair();
    const sponsorAddress = houseKeypair.getPublicKey().toSuiAddress();

    // If the sender were the sponsor, sender and gas owner would collapse to one signer
    // and the signature we return would be a complete, submittable transaction by itself.
    if (userAddress.toLowerCase() === sponsorAddress.toLowerCase()) {
      return res.status(400).json({ error: 'The sponsor cannot sponsor its own transactions.' });
    }

    // Fresh client per request to avoid shared-handle / libuv issues (e.g. double sponsor + dry run flow)
    const gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL, network: 'mainnet' });

    // 1. reconstruct from kind and check it is a reclaim batch, not an arbitrary PTB.
    //    Value may only reach the sender or the sponsor itself.
    const kindBytes = Buffer.from(txBytes, 'base64');
    let tx;
    try {
      tx = Transaction.fromKind(kindBytes);
    } catch {
      return res.status(400).json({ error: 'txBytes is not a valid transaction kind.' });
    }
    const { splitToSenderMist } = validateReclaimTransactionKind(tx.getData(), {
      sender: userAddress,
      feeRecipient: sponsorAddress,
    });

    // 2. setup sponsorship
    tx.setSender(userAddress);
    tx.setGasOwner(sponsorAddress);
    tx.setGasBudget(SPONSOR_GAS_BUDGET_MIST);

    // Expire at the end of the current epoch. Our gates reason about a simulation, and a
    // signature that stays valid indefinitely gives a caller unlimited time to arrange
    // for execution to diverge from it — including across an epoch boundary, which Move
    // code can read through TxContext even when every object input is version-pinned.
    const currentEpoch = await fetchCurrentEpoch(gqlClient);
    if (currentEpoch != null) tx.setExpiration({ Epoch: currentEpoch });

    const coins = await fetchSponsorCoins(gqlClient, sponsorAddress);
    if (isSimulateOnly) {
      // never submitted, so it needs no reservation and gets no signature
      tx.setGasPayment([coins[0]]);
      const builtBytes = await tx.build({ client: gqlClient });
      return res.status(200).json({
        sponsoredTxBytes: Buffer.from(builtBytes).toString('base64'),
        sponsorAddress,
      });
    }

    reservedCoin = await reserveCoin(coins, identifier);
    if (!reservedCoin) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error:
          'Sponsor is busy or low on funded gas coins. Try again in a moment. 🐾',
      });
    }
    tx.setGasPayment([reservedCoin]);

    const builtBytes = await tx.build({ client: gqlClient });

    // 3. the gate that actually bounds our exposure: simulate and refuse to sign
    //    anything that would leave the sponsor out of pocket.
    const simulation = await gqlClient.simulateTransaction({
      transaction: builtBytes,
      include: { effects: true, balanceChanges: true },
    });
    const simulated =
      simulation?.$kind === 'Transaction' ? simulation.Transaction : simulation?.FailedTransaction;
    if (simulation?.$kind !== 'Transaction' || !simulated?.status?.success) {
      await releaseCoin(reservedCoin);
      reservedCoin = null;
      return res.status(400).json({
        error: 'Transaction fails on-chain, so it will not be sponsored.',
        executionError: simulated?.status?.error ?? null,
      });
    }
    // Primary bound: the gas coin's own arithmetic. This uses only the storage rebate
    // and gas the simulation reports (both fixed by which objects are actually deleted)
    // and the split amounts we decoded ourselves, so a caller cannot inflate it by
    // arranging to pay the sponsor from somewhere else in the transaction.
    const gasCoinNet = gasCoinNetMist(simulated.effects?.gasUsed, splitToSenderMist);
    // Secondary bound: whole-address balance change, which also catches anything the
    // gas-coin arithmetic does not model.
    const sponsorNetMist = netSuiChangeForAddress(simulated.balanceChanges, sponsorAddress);
    if (gasCoinNet === null || sponsorNetMist === null) {
      await releaseCoin(reservedCoin);
      reservedCoin = null;
      return res.status(502).json({ error: 'Could not verify the sponsor balance impact.' });
    }
    if (gasCoinNet < 0n || sponsorNetMist < 0n) {
      await releaseCoin(reservedCoin);
      reservedCoin = null;
      return res.status(400).json({
        error: 'This transaction would cost the sponsor more than it returns, so it will not be sponsored.',
      });
    }

    // 4. Tighten the gas budget to what this batch actually needs. No gate can tell
    //    "will succeed" from "will abort", and an aborted transaction still bills the
    //    sponsor for computation — the budget is the ceiling on that loss, so keeping it
    //    at the generous default would let a caller burn the full amount on purpose.
    //    The budget is a ceiling, not a charge, so raising the headroom does not change
    //    the effects the simulation just verified.
    const grossGas =
      Number(simulated.effects?.gasUsed?.computationCost ?? 0) +
      Number(simulated.effects?.gasUsed?.storageCost ?? 0);
    const tightBudget = Math.min(
      SPONSOR_GAS_BUDGET_MIST,
      Math.max(SPONSOR_MIN_GAS_BUDGET_MIST, Math.ceil(grossGas * SPONSOR_GAS_BUDGET_MARGIN))
    );
    tx.setGasBudget(tightBudget);
    const finalBytes = await tx.build({ client: gqlClient });

    // 5. sign the built bytes (signature covers data + gas + budget)
    const { signature } = await houseKeypair.signTransaction(finalBytes);

    return res.status(200).json({
      sponsoredTxBytes: Buffer.from(finalBytes).toString('base64'),
      sponsorSignature: signature,
      sponsorAddress,
    });
  } catch (error) {
    await releaseCoin(reservedCoin);
    if (error instanceof SponsorPolicyError) {
      // describes the caller's own transaction, so it is safe (and useful) to return
      return res.status(400).json({ error: `Rejected: ${error.message}` });
    }
    console.error('[api/sponsor]', error);
    return res.status(500).json({ error: 'Sponsorship failed.' });
  }
}
