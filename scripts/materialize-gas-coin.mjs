/**
 * turn part of the sponsor's address balance into a Coin<SUI> it can pay gas with.
 *
 * the server does this on its own now (api/sponsor.js, whenever the sponsor has no usable
 * coin and its address balance could make one), so this is for doing it by hand: a
 * specific amount, or checking what the conversion would do without submitting it. the
 * transaction itself lives in lib/sponsorGasCoin.js, along with why the sponsor needs a
 * coin object at all.
 *
 *   node scripts/materialize-gas-coin.mjs            # simulate only (default)
 *   node scripts/materialize-gas-coin.mjs --execute  # actually submit
 *   node scripts/materialize-gas-coin.mjs --amount 300000000 --execute
 *
 * needs SUI_SPONSOR_PRIV in the environment. it's a sensitive vercel variable and can't
 * be pulled with `vercel env pull`, so supply it from your own copy of the key.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  conversionTransaction,
  createdCoinRef,
  fetchExpirationContext,
} from '../lib/sponsorGasCoin.js';
import { SPONSOR_CONVERSION_GAS_BUDGET_MIST } from '../lib/constants.js';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const SUI = '0x2::sui::SUI';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const amountIdx = args.indexOf('--amount');
const amountMist = amountIdx !== -1 ? BigInt(args[amountIdx + 1]) : 300_000_000n;
const gasBudget = SPONSOR_CONVERSION_GAS_BUDGET_MIST;

const secret = process.env.SUI_SPONSOR_PRIV;
if (!secret) {
  console.error('SUI_SPONSOR_PRIV is not set. Export it or pass it via --env-file, then re-run.');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secret);
const address = keypair.getPublicKey().toSuiAddress();
const client = new SuiGraphQLClient({ url: GRAPHQL_URL, network: 'mainnet' });

const { balance } = await client.getBalance({ owner: address, coinType: SUI });
const addressBalance = BigInt(balance?.addressBalance ?? 0);
console.log(`sponsor        : ${address}`);
console.log(`address balance: ${addressBalance} mist`);
console.log(`coin balance   : ${balance?.coinBalance ?? 0} mist`);

if (addressBalance < amountMist + BigInt(gasBudget)) {
  console.error(
    `\nNot enough address balance: need ${amountMist + BigInt(gasBudget)} mist ` +
      `(${amountMist} to withdraw + ${gasBudget} gas budget), have ${addressBalance}.`
  );
  process.exit(1);
}

const tx = conversionTransaction({
  address,
  amountMist,
  gasBudgetMist: gasBudget,
  ...(await fetchExpirationContext(client)),
});
const bytes = await tx.build({ client });
const sim = await client.simulateTransaction({
  transaction: bytes,
  include: { effects: true, balanceChanges: true },
});
const result = sim.$kind === 'Transaction' ? sim.Transaction : sim.FailedTransaction;
console.log(`\nsimulation     : ${sim.$kind} success=${result?.status?.success}`);
if (sim.$kind !== 'Transaction' || !result?.status?.success) {
  console.error('error          :', JSON.stringify(result?.status?.error));
  process.exit(1);
}
console.log('gasUsed        :', JSON.stringify(result?.effects?.gasUsed));
console.log(`would create   : one Coin<SUI> of ${amountMist} mist owned by the sponsor`);

if (!execute) {
  console.log('\nSimulation only. Re-run with --execute to submit it.');
  process.exit(0);
}

const { signature } = await keypair.signTransaction(bytes);
const executed = await client.executeTransaction({
  transaction: bytes,
  signatures: [signature],
  include: { effects: true },
});
const done = executed.$kind === 'Transaction' ? executed.Transaction : executed.FailedTransaction;
if (executed.$kind !== 'Transaction' || !done?.status?.success) {
  console.error('\nexecution failed:', JSON.stringify(done?.status?.error));
  process.exit(1);
}
console.log(`\nexecuted       : ${done.digest}`);
console.log(`new coin       : ${createdCoinRef(done.effects, address)?.objectId ?? '(not found in effects)'}`);
await client.waitForTransaction({ digest: done.digest, timeout: 30_000 }).catch(() => {});
const after = await client.getBalance({ owner: address, coinType: SUI });
console.log(`coin balance   : ${after.balance?.coinBalance} mist`);
console.log('\nDone. /api/sponsor will now use this coin object for gas.');
