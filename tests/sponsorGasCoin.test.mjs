// run with: npm test
//
// the server converts the sponsor's address balance into a gas coin on its own, off a
// public request. these pin down when it's allowed to, and what it signs when it does.

import { describe, test, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import {
  coinsCovering,
  conversionAmount,
  conversionTransaction,
  createdCoinRef,
  fundingReason,
} from '../lib/sponsorGasCoin.js';
import {
  SPONSOR_GAS_BUDGET_MIST,
  SPONSOR_CONVERSION_GAS_BUDGET_MIST,
  SPONSOR_MIN_CONVERSION_MIST,
} from '../lib/constants.js';

const SPONSOR = '0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1';
const OTHER = '0x9999999999999999999999999999999999999999999999999999999999999999';
const BUDGET = BigInt(SPONSOR_GAS_BUDGET_MIST);
const CONVERSION_GAS = BigInt(SPONSOR_CONVERSION_GAS_BUDGET_MIST);
const MIN = BigInt(SPONSOR_MIN_CONVERSION_MIST);

const coin = (balanceMist) => ({ objectId: OTHER, version: '1', digest: 'd', balanceMist });
const gas = ({ coins = [], addressBalanceMist = 0n }) => ({
  coins,
  addressBalanceMist,
  totalBalanceMist: coins.reduce((s, c) => s + c.balanceMist, 0n) + addressBalanceMist,
});

describe('fundingReason', () => {
  test('a coin strictly over the budget is funded', () => {
    expect(fundingReason(gas({ coins: [coin(BUDGET + 1n)] }))).toBe('ok');
  });

  test('a coin of exactly the budget is not: it can pay gas but never pay anyone out', () => {
    expect(fundingReason(gas({ coins: [coin(BUDGET)] }))).not.toBe('ok');
  });

  test('nothing at all is empty', () => {
    expect(fundingReason(gas({}))).toBe('empty');
  });

  test('a convertible address balance is reported as such, so the server converts it', () => {
    expect(fundingReason(gas({ addressBalanceMist: MIN + CONVERSION_GAS }))).toBe('address_balance');
  });

  test('an address balance too small to make a useful coin is just too little', () => {
    expect(fundingReason(gas({ addressBalanceMist: MIN + CONVERSION_GAS - 1n }))).toBe('too_little');
    expect(fundingReason(gas({ coins: [coin(1000n)] }))).toBe('too_little');
  });
});

describe('conversionAmount', () => {
  test('converts everything but its own gas budget', () => {
    const balance = 300_000_000n;
    expect(conversionAmount(gas({ addressBalanceMist: balance }))).toBe(balance - CONVERSION_GAS);
  });

  test('refuses when the resulting coin would be under the minimum', () => {
    expect(conversionAmount(gas({ addressBalanceMist: MIN + CONVERSION_GAS - 1n }))).toBeNull();
  });

  test('refuses when the coin could not cover the payout it is being made for', () => {
    // converting 0.3 SUI for a batch paying out 0.3 SUI would still leave no usable coin
    const balance = 300_000_000n;
    expect(conversionAmount(gas({ addressBalanceMist: balance }), balance)).toBeNull();
    expect(conversionAmount(gas({ addressBalanceMist: balance }), 1_000_000n)).toBe(balance - CONVERSION_GAS);
  });

  test('a freshly converted coin actually covers what it was made for', () => {
    const balance = 300_000_000n;
    const payout = 5_000_000n;
    const amount = conversionAmount(gas({ addressBalanceMist: balance }), payout);
    expect(coinsCovering([coin(amount)], payout)).toHaveLength(1);
  });
});

describe('conversionTransaction', () => {
  const tx = conversionTransaction({
    address: SPONSOR,
    amountMist: 123_000_000n,
    epoch: 1232n,
    chainIdentifier: '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S',
  });
  const data = tx.getData();

  test('is sent and paid for by the sponsor itself, from its address balance', () => {
    expect(data.sender).toBe(SPONSOR);
    expect(data.gasData.owner).toBe(SPONSOR);
    expect(data.gasData.payment).toEqual([]);
    expect(String(data.gasData.budget)).toBe(String(SPONSOR_CONVERSION_GAS_BUDGET_MIST));
  });

  test('carries the two-epoch ValidDuring expiration the node demands', () => {
    expect(data.expiration.ValidDuring.minEpoch).toBe('1232');
    expect(data.expiration.ValidDuring.maxEpoch).toBe('1233');
  });

  test('withdraws, redeems as a coin, and sends the coin nowhere but back to the sponsor', async () => {
    const withdrawals = data.inputs.filter((input) => input.$kind === 'FundsWithdrawal');
    expect(withdrawals).toHaveLength(1);
    expect(String(withdrawals[0].FundsWithdrawal.reservation.MaxAmountU64)).toBe('123000000');

    const kinds = data.commands.map((command) => command.$kind);
    expect(kinds).toEqual(['MoveCall', 'TransferObjects']);
    expect(data.commands[0].MoveCall.function).toBe('redeem_funds');

    // the only address the value can go to is the sponsor's own
    const kind = await tx.build({ onlyTransactionKind: true });
    const rebuilt = Transaction.fromKind(kind).getData();
    const recipientInput = rebuilt.inputs[rebuilt.commands[1].TransferObjects.address.Input];
    expect(Buffer.from(recipientInput.Pure.bytes, 'base64').toString('hex')).toBe(SPONSOR.slice(2));
  });
});

describe('createdCoinRef', () => {
  const change = (overrides) => ({
    objectId: '0xnew',
    idOperation: 'Created',
    outputState: 'ObjectWrite',
    outputVersion: '7',
    outputDigest: 'abc',
    outputOwner: { $kind: 'AddressOwner', AddressOwner: SPONSOR },
    ...overrides,
  });

  test('finds the coin the conversion created for the sponsor', () => {
    const effects = {
      changedObjects: [
        change({ objectId: '0xacc', outputState: 'AccumulatorWriteV1', idOperation: 'None' }),
        change({}),
      ],
    };
    expect(createdCoinRef(effects, SPONSOR)).toEqual({ objectId: '0xnew', version: '7', digest: 'abc' });
  });

  test('ignores objects created for anyone else', () => {
    const effects = {
      changedObjects: [change({ outputOwner: { $kind: 'AddressOwner', AddressOwner: OTHER } })],
    };
    expect(createdCoinRef(effects, SPONSOR)).toBeNull();
  });

  test('is null when effects are missing, rather than guessing', () => {
    expect(createdCoinRef(undefined, SPONSOR)).toBeNull();
  });
});
