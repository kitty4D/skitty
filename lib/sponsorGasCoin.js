// the sponsor's gas coin: whether it has a usable one, and turning an address balance
// into one. shared by api/sponsor.js (automatic) and scripts/materialize-gas-coin.mjs
// (manual). lives outside api/ because every file in there gets deployed as an endpoint.
//
// why a coin at all: in a user-sent sponsored transaction the GasCoin argument is the
// only channel sponsor-owned value has to reach the user. storage rebates go to the gas
// payer, tx.withdrawal() only draws on the SENDER (the node rejects sponsor withdrawals),
// and a sponsor-owned coin can't be an ordinary input because owned inputs are checked
// against the sender. an address balance can't be that gas coin, and a top-up from a
// modern wallet lands as exactly that.

import { Transaction } from '@mysten/sui/transactions';
import {
  SPONSOR_GAS_BUDGET_MIST,
  SPONSOR_CONVERSION_GAS_BUDGET_MIST,
  SPONSOR_MIN_CONVERSION_MIST,
} from './constants.js';

const SUI = '0x2::sui::SUI';

// spendable through tx.gas is (balance - budget), not the balance: the budget is held
// back. filtering on balance alone hands out a coin that passes and then aborts with
// InsufficientCoinBalance when the payout split runs.
export function coinsCovering(coins, requiredSpendableMist) {
  const needed = BigInt(SPONSOR_GAS_BUDGET_MIST) + requiredSpendableMist;
  return coins.filter((coin) => coin.balanceMist >= needed);
}

/**
 * how much of the address balance to turn into a coin, or null when converting wouldn't
 * produce a coin that covers the gas budget plus `requiredSpendableMist`. everything but
 * the conversion's own gas budget goes in: a fragment left behind is just another
 * balance too small to use.
 */
export function conversionAmount(gas, requiredSpendableMist = 0n) {
  const amount = gas.addressBalanceMist - BigInt(SPONSOR_CONVERSION_GAS_BUDGET_MIST);
  const floor = BigInt(SPONSOR_MIN_CONVERSION_MIST);
  const needed = BigInt(SPONSOR_GAS_BUDGET_MIST) + requiredSpendableMist;
  return amount >= floor && amount >= needed ? amount : null;
}

/**
 * ok:              a coin can pay the budget with something left over to pay out
 * empty:           no SUI at all
 * address_balance: enough SUI, but as an address balance. the server converts it on
 *                  the next status check; seeing this for long means conversion failed
 * too_little:      holds SUI, but not enough to pay gas in either form
 * every reason but ok means users pay their own gas.
 */
export function fundingReason(gas) {
  if (gas.coins.some((coin) => coin.balanceMist > BigInt(SPONSOR_GAS_BUDGET_MIST))) return 'ok';
  if (gas.totalBalanceMist === 0n) return 'empty';
  if (conversionAmount(gas) !== null) return 'address_balance';
  return 'too_little';
}

/** epoch and chain id, which the conversion's expiration has to name */
export async function fetchExpirationContext(client) {
  const [{ systemState }, { chainIdentifier }] = await Promise.all([
    client.core.getCurrentSystemState(),
    client.core.getChainIdentifier(),
  ]);
  return { epoch: BigInt(systemState.epoch), chainIdentifier };
}

/**
 * withdraw from the sponsor's own address balance, redeem it as a Coin<SUI>, keep it.
 * the sponsor is the sender here, which is the only reason the withdrawal is allowed, and
 * the node checks the reservation against the real balance down to the mist.
 */
export function conversionTransaction({
  address,
  amountMist,
  epoch,
  chainIdentifier,
  gasBudgetMist = SPONSOR_CONVERSION_GAS_BUDGET_MIST,
}) {
  const tx = new Transaction();
  // a Withdrawal isn't a Balance (it's funds_accumulator::Withdrawal<Balance<T>>), so it
  // goes through coin::redeem_funds; coin::from_balance rejects it
  const withdrawal = tx.withdrawal({ amount: amountMist, type: SUI });
  const [coin] = tx.moveCall({
    target: '0x2::coin::redeem_funds',
    typeArguments: [SUI],
    arguments: [withdrawal],
  });
  tx.transferObjects([coin], tx.pure.address(address));
  tx.setSender(address);
  tx.setGasOwner(address);
  tx.setGasBudget(gasBudgetMist);
  // gas from the same address balance
  tx.setGasPayment([]);
  // no address-owned inputs, so the node demands a ValidDuring expiration of at most two
  // epochs. simulation doesn't check this; only a real submission does.
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(epoch),
      maxEpoch: String(epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: (Math.random() * 4294967296) >>> 0,
    },
  });
  return tx;
}

/**
 * the coin a conversion created, read straight from its effects. the indexer can lag the
 * effects by a few seconds, and a sponsor that converted and then reported "no coin"
 * would flip every user back to paying their own gas for nothing.
 */
export function createdCoinRef(effects, owner) {
  const normalizedOwner = owner.toLowerCase();
  const created = (effects?.changedObjects ?? []).find(
    (change) =>
      change.idOperation === 'Created' &&
      change.outputState === 'ObjectWrite' &&
      change.outputOwner?.AddressOwner?.toLowerCase() === normalizedOwner
  );
  if (!created?.outputVersion || !created?.outputDigest) return null;
  return {
    objectId: created.objectId,
    version: created.outputVersion,
    digest: created.outputDigest,
  };
}
