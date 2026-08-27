// Run with: npm test
//
// The sponsor signs whatever passes this policy, so the drain case below is the one
// that matters: it is the exact shape an attacker uses to peel value off the gas coin.

import { test, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
// lives outside api/ so Vercel does not compile it into a deployed function
import {
  validateReclaimTransactionKind,
  netSuiChangeForAddress,
  gasCoinNetMist,
} from '../api/sponsorPolicy.js';

const USER = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ATTACKER = '0x9999999999999999999999999999999999999999999999999999999999999999';
const SPONSOR = '0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1';
const OBJ_A = '0x2222222222222222222222222222222222222222222222222222222222222222';
const OBJ_B = '0x3333333333333333333333333333333333333333333333333333333333333333';
const DIGEST = '11111111111111111111111111111111';

const ref = (id) => ({ objectId: id, version: '1', digest: DIGEST });

async function dataFor(build) {
  const tx = new Transaction();
  build(tx);
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return Transaction.fromKind(kindBytes).getData();
}

const check = (data, sender = USER) =>
  validateReclaimTransactionKind(data, { sender, feeRecipient: SPONSOR });

test('accepts a normal reclaim batch', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({
      target: '0x2::coin::destroy_zero',
      typeArguments: ['0xabc::foo::FOO'],
      arguments: [tx.objectRef(ref(OBJ_A))],
    });
    tx.mergeCoins(tx.objectRef(ref(OBJ_A)), [tx.objectRef(ref(OBJ_B))]);
    const [house, user] = tx.splitCoins(tx.gas, [1000, 2000]);
    tx.transferObjects([house], tx.pure.address(SPONSOR));
    tx.transferObjects([user], tx.pure.address(USER));
  });
  expect(() => check(data)).not.toThrow();
});

test('accepts closing a kiosk and paying profits to the owner', async () => {
  const data = await dataFor((tx) => {
    const [coin] = tx.moveCall({
      target: '0x2::kiosk::close_and_withdraw',
      arguments: [tx.objectRef(ref(OBJ_A)), tx.objectRef(ref(OBJ_B))],
    });
    tx.transferObjects([coin], tx.pure.address(USER));
  });
  expect(() => check(data)).not.toThrow();
});

test('accepts a third-party single-argument burn', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({ target: '0xdead::spam::burn', arguments: [tx.objectRef(ref(OBJ_A))] });
  });
  expect(() => check(data)).not.toThrow();
});

test('rejects draining the gas coin to a third party', async () => {
  const data = await dataFor((tx) => {
    const [stolen] = tx.splitCoins(tx.gas, [100_000_000_000]);
    tx.transferObjects([stolen], tx.pure.address(ATTACKER));
  });
  expect(() => check(data)).toThrow(/transfer to the sender or the fee recipient/);
});

test('rejects transferring the whole gas coin away', async () => {
  const data = await dataFor((tx) => {
    tx.transferObjects([tx.gas], tx.pure.address(USER));
  });
  expect(() => check(data)).toThrow(/references the gas coin/);
});

test('rejects merging the gas coin into an attacker-controlled coin', async () => {
  const data = await dataFor((tx) => {
    tx.mergeCoins(tx.objectRef(ref(OBJ_A)), [tx.gas]);
  });
  expect(() => check(data)).toThrow(/references the gas coin/);
});

test('rejects arbitrary framework calls', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({
      target: '0x2::pay::split',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [tx.objectRef(ref(OBJ_A)), tx.pure.u64(1)],
    });
  });
  expect(() => check(data)).toThrow(/not an allowed framework call/);
});

test('rejects a non-burn third-party call', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({ target: '0xdead::vault::withdraw', arguments: [tx.objectRef(ref(OBJ_A))] });
  });
  expect(() => check(data)).toThrow(/not a burn\/delete\/destroy entry point/);
});

test('rejects a burn taking extra arguments', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({
      target: '0xdead::spam::burn',
      arguments: [tx.objectRef(ref(OBJ_A)), tx.objectRef(ref(OBJ_B))],
    });
  });
  expect(() => check(data)).toThrow(/exactly 1 argument/);
});

test('rejects transferring objects the user already owns', async () => {
  const data = await dataFor((tx) => {
    tx.transferObjects([tx.objectRef(ref(OBJ_A))], tx.pure.address(USER));
  });
  expect(() => check(data)).toThrow(/objects produced by this transaction/);
});

test('rejects an empty transaction', async () => {
  const data = await dataFor(() => {});
  expect(() => check(data)).toThrow(/no commands/);
});

test('an attacker as the declared sender is still capped by the split ceiling', async () => {
  // Structurally a sender may be paid from the gas coin — that is how the user gets
  // their rebate. Two things bound it: the absolute split ceiling here, and the
  // handler's refusal to sign when the simulated sponsor balance goes negative.
  const data = await dataFor((tx) => {
    const [stolen] = tx.splitCoins(tx.gas, [100_000_000_000]);
    tx.transferObjects([stolen], tx.pure.address(ATTACKER));
  });
  expect(() => check(data, ATTACKER)).toThrow(/ceiling/);

  const drained = netSuiChangeForAddress(
    [{ address: SPONSOR, coinType: '0x2::sui::SUI', amount: '-100000000000' }],
    SPONSOR
  );
  expect(drained < 0n).toBe(true);
});

test('rejects a burn on a shared object, whose state can change after we sign', async () => {
  // The simulation gate predicts the outcome; a shared input lets the caller change
  // that outcome between our simulation and their submission.
  const data = await dataFor((tx) => {
    tx.moveCall({
      target: '0xdead::spam::burn',
      arguments: [tx.sharedObjectRef({ objectId: OBJ_A, initialSharedVersion: '1', mutable: true })],
    });
  });
  expect(() => check(data)).toThrow(/owned, version-pinned/);
});

test('rejects the Clock as a burn argument', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({
      target: '0xdead::spam::burn',
      arguments: [tx.object.clock()],
    });
  });
  expect(() => check(data)).toThrow(/owned, version-pinned/);
});

test('rejects merging a shared coin', async () => {
  const data = await dataFor((tx) => {
    tx.mergeCoins(tx.objectRef(ref(OBJ_A)), [
      tx.sharedObjectRef({ objectId: OBJ_B, initialSharedVersion: '1', mutable: true }),
    ]);
  });
  expect(() => check(data)).toThrow(/owned coins/);
});

test('rejects the sponsor sponsoring itself', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({ target: '0xdead::spam::burn', arguments: [tx.objectRef(ref(OBJ_A))] });
  });
  expect(() => check(data, SPONSOR)).toThrow(/cannot be the sender/);
});

test('allows destroying a zero coin produced by closing a kiosk', async () => {
  const data = await dataFor((tx) => {
    const [coin] = tx.moveCall({
      target: '0x2::kiosk::close_and_withdraw',
      arguments: [tx.objectRef(ref(OBJ_A)), tx.objectRef(ref(OBJ_B))],
    });
    tx.moveCall({
      target: '0x2::coin::destroy_zero',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [coin],
    });
  });
  expect(() => check(data)).not.toThrow();
});

test('allows a split up to the ceiling', async () => {
  const data = await dataFor((tx) => {
    const [coin] = tx.splitCoins(tx.gas, [1_999_999_999]);
    tx.transferObjects([coin], tx.pure.address(USER));
  });
  expect(() => check(data)).not.toThrow();
});

test('sums split amounts across commands when applying the ceiling', async () => {
  const data = await dataFor((tx) => {
    const [a] = tx.splitCoins(tx.gas, [1_500_000_000]);
    tx.transferObjects([a], tx.pure.address(USER));
    const [b] = tx.splitCoins(tx.gas, [1_500_000_000]);
    tx.transferObjects([b], tx.pure.address(USER));
  });
  expect(() => check(data)).toThrow(/ceiling/);
});

test('rejects routing a kiosk payout to the sponsor to fake sponsor income', () => {
  // The attack this closes: seed an attacker-owned SHARED kiosk with profits, send that
  // payout to the sponsor so the simulated sponsor balance looks positive, split the
  // ceiling out to yourself, then drain the kiosk before submitting the signature. The
  // sponsor may only ever receive value that came out of its own gas coin.
  return dataFor((tx) => {
    const [profit] = tx.moveCall({
      target: '0x2::kiosk::close_and_withdraw',
      arguments: [
        tx.sharedObjectRef({ objectId: OBJ_A, initialSharedVersion: '1', mutable: true }),
        tx.objectRef(ref(OBJ_B)),
      ],
    });
    tx.transferObjects([profit], tx.pure.address(SPONSOR));
    const [stolen] = tx.splitCoins(tx.gas, [2_000_000_000]);
    tx.transferObjects([stolen], tx.pure.address(ATTACKER));
  }).then((data) => {
    expect(() => check(data, ATTACKER)).toThrow(/fee recipient may only receive/);
  });
});

test('rejects an unreferenced funds-withdrawal input', async () => {
  const data = await dataFor((tx) => {
    tx.moveCall({ target: '0xdead::spam::burn', arguments: [tx.objectRef(ref(OBJ_A))] });
  });
  // splice in an input kind the allow-list does not model
  data.inputs.push({ $kind: 'FundsWithdrawal', FundsWithdrawal: { withdrawFrom: 'Sponsor' } });
  expect(() => check(data)).toThrow(/inputs are not allowed/);
});

test('reports what the sender is paid so the handler can bound it', async () => {
  const data = await dataFor((tx) => {
    const [house, user] = tx.splitCoins(tx.gas, [1000, 2000]);
    tx.transferObjects([house], tx.pure.address(SPONSOR));
    tx.transferObjects([user], tx.pure.address(USER));
  });
  const result = check(data);
  expect(result.totalSplitFromGas).toBe(3000n);
  // only the user's share actually leaves the sponsor
  expect(result.splitToSenderMist).toBe(2000n);
});

test('gasCoinNetMist refuses to sign when the payout exceeds the real rebate', () => {
  const gasUsed = { computationCost: '1000000', storageCost: '3000000', storageRebate: '10000000' };
  // rebate 10M - gas 4M = 6M available
  expect(gasCoinNetMist(gasUsed, 5_000_000n)).toBe(1_000_000n);
  expect(gasCoinNetMist(gasUsed, 7_000_000n) < 0n).toBe(true);
});

test('gasCoinNetMist refuses to guess when the gas figures are missing', () => {
  // absent fields are absent evidence — defaulting them to zero would pass the gate on
  // no data, and would do so precisely for the zero-payout griefing shapes
  expect(gasCoinNetMist(undefined, 0n)).toBe(null);
  expect(gasCoinNetMist({}, 0n)).toBe(null);
  expect(gasCoinNetMist({ computationCost: '1', storageCost: '1' }, 0n)).toBe(null);
  expect(gasCoinNetMist({ computationCost: 'nope', storageCost: '1', storageRebate: '1' }, 0n)).toBe(
    null
  );
  // snake_case (a shape drift) must not silently read as zeros
  expect(gasCoinNetMist({ computation_cost: '1', storage_cost: '1', storage_rebate: '9' }, 0n)).toBe(
    null
  );
});

test('rejects a single Result reference into a multi-amount gas split', async () => {
  const data = await dataFor((tx) => {
    const [a] = tx.splitCoins(tx.gas, [1, 999_000_000]);
    tx.transferObjects([a], tx.pure.address(USER));
  });
  // rewrite the NestedResult the SDK emits into a bare Result, the under-counting shape
  data.commands[1].TransferObjects.objects = [{ $kind: 'Result', Result: 0 }];
  expect(() => check(data)).toThrow(/multi-value split/);
});

test('netSuiChangeForAddress sums only the sponsor SUI rows', () => {
  const net = netSuiChangeForAddress(
    [
      { address: SPONSOR, coinType: '0x2::sui::SUI', amount: '500' },
      { address: SPONSOR, coinType: '0xabc::foo::FOO', amount: '-9999' },
      { address: USER, coinType: '0x2::sui::SUI', amount: '-500' },
      {
        address: SPONSOR,
        coinType:
          '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
        amount: '100',
      },
    ],
    SPONSOR
  );
  expect(net).toBe(600n);
});

test('netSuiChangeForAddress refuses to guess when the sponsor has no row', () => {
  // the sponsor always pays gas, so no row means missing data, not a zero net —
  // returning 0n here would let the only value gate pass on no evidence
  expect(netSuiChangeForAddress([], SPONSOR)).toBe(null);
  expect(netSuiChangeForAddress(undefined, SPONSOR)).toBe(null);
  expect(
    netSuiChangeForAddress([{ address: USER, coinType: '0x2::sui::SUI', amount: '5' }], SPONSOR)
  ).toBe(null);
});
