/**
 * Turn part of the sponsor's ADDRESS BALANCE into a Coin<SUI> OBJECT.
 *
 * Why this is needed: gas can be paid from an address balance (via an empty gas payment),
 * and the node accepts it — but wallets do not. A wallet sees an empty gas payment as
 * "no gas selected", re-resolves gas against the connected user, and rejects the
 * transaction with "Gas object is not an owned object with owner: <user>". Sponsorship
 * therefore needs a real coin object, which this creates.
 *
 * How: the transaction pays its own gas from the address balance, splits a coin off the
 * gas coin, and transfers that coin to the sponsor itself.
 *
 *   node scripts/materialize-gas-coin.mjs            # simulate only (default)
 *   node scripts/materialize-gas-coin.mjs --execute  # actually submit
 *   node scripts/materialize-gas-coin.mjs --amount 200000000 --execute
 *
 * Requires SUI_SPONSOR_PRIV in the environment (the same key /api/sponsor uses).
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
const SUI = '0x2::sui::SUI';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const amountIdx = args.indexOf('--amount');
const amountMist = amountIdx !== -1 ? BigInt(args[amountIdx + 1]) : 100_000_000n; // 0.1 SUI
const gasBudget = 20_000_000;

const secret = process.env.SUI_SPONSOR_PRIV;
if (!secret) {
  console.error('SUI_SPONSOR_PRIV is not set. Pull it from Vercel or export it, then re-run.');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secret);
const address = keypair.getPublicKey().toSuiAddress();
const client = new SuiGraphQLClient({ url: GRAPHQL_URL, network: 'mainnet' });

const { balance } = await client.getBalance({ owner: address, coinType: SUI });
const addressBalance = BigInt(balance?.addressBalance ?? 0);
const coinBalance = BigInt(balance?.coinBalance ?? 0);
console.log(`sponsor        : ${address}`);
console.log(`address balance: ${addressBalance} mist`);
console.log(`coin balance   : ${coinBalance} mist`);

if (addressBalance < amountMist + BigInt(gasBudget)) {
  console.error(
    `\nNot enough address balance: need ${amountMist + BigInt(gasBudget)} mist ` +
      `(${amountMist} to split + ${gasBudget} gas budget), have ${addressBalance}.`
  );
  process.exit(1);
}

const { data } = await client.query({ query: 'query { epoch { epochId } }', variables: {} });
const epoch = Number(data.epoch.epochId);

const tx = new Transaction();
const [coin] = tx.splitCoins(tx.gas, [amountMist]);
tx.transferObjects([coin], tx.pure.address(address));
tx.setSender(address);
tx.setGasOwner(address);
tx.setGasBudget(gasBudget);
tx.setGasPayment([]); // draw gas from the address balance
tx.setExpiration({ Epoch: epoch });

const bytes = await tx.build({ client });
const sim = await client.simulateTransaction({
  transaction: bytes,
  include: { effects: true, balanceChanges: true },
});
const result = sim.$kind === 'Transaction' ? sim.Transaction : sim.FailedTransaction;
console.log(`\nsimulation     : ${sim.$kind} success=${result?.status?.success}`);
if (result?.status?.error) {
  console.error('error          :', JSON.stringify(result.status.error));
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
await client.waitForTransaction({ digest: done.digest, timeout: 30_000 }).catch(() => {});
const after = await client.getBalance({ owner: address, coinType: SUI });
console.log(`coin balance   : ${after.balance?.coinBalance} mist (was ${coinBalance})`);
console.log('\nDone. /api/sponsor will now prefer this coin object for gas.');
