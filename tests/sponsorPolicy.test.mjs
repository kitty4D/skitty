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
} from '../lib/sponsorPolicy.js';

const USER = '0x1111111111111111111111111111111111111111111111111111111111111111';
const ATTACKER = '0x9999999999999999999999999999999999999999999999999999999999999999';
const SPONSOR = '0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1';
const OBJ_A = '0x2222222222222222222222222222222222222222222222222222222222222222';
const OBJ_B = '0x3333333333333333333333333333333333333333333333333333333333333333';
const DIGEST = '11111111111111111111111111111111';

const ref = (id) => ({ objectId: id, version: '1', digest: DIGEST });

test('Walrus receipt burns use the existing pinned-owned burn policy', async () => {
  const target = '0xa9ac4281c72b0ed3277c08e821ab77eccea7b187f2b402ffa3b33f548d4bbf1e::blob::burn';
  const data = await dataFor(tx => tx.moveCall({target,arguments:[tx.objectRef(ref(OBJ_A))]}));
  expect(check(data)).toEqual({totalSplitFromGas:0n,splitToSenderMist:0n});
  data.inputs[0].Object = {$kind:'SharedObject',SharedObject:{objectId:OBJ_A,initialSharedVersion:'1',mutable:true}};
  expect(()=>check(data)).toThrow(/owned, version-pinned/);
});

async function dataFor(build) {
  const tx = new Transaction();
  build(tx);
  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return Transaction.fromKind(kindBytes).getData();
}

const check = (data, sender = USER) =>
  validateReclaimTransactionKind(data, { sender, feeRecipient: SPONSOR });

const containers = [['bag', 0], ['object_bag', 0], ['table', 2], ['object_table', 2]];
const cleanupData = (module, count) => dataFor((tx) => {
  tx.moveCall({
    target: `0x2::${module}::destroy_empty`,
    typeArguments: Array(count).fill('u64'),
    arguments: [tx.objectRef(ref(OBJ_A))],
  });
});
const revokeData = (shared = true) => dataFor((tx) => {
  tx.moveCall({
    target: '0x2::allowance::revoke',
    typeArguments: ['0x2::balance::Balance<0x2::sui::SUI>'],
    arguments: [tx.objectRef(ref(OBJ_A)), shared
      ? tx.sharedObjectRef({ objectId: OBJ_B, initialSharedVersion: '1', mutable: true })
      : tx.objectRef(ref(OBJ_B))],
  });
});
const unsafeRefs = [
  { $kind: 'GasCoin', GasCoin: true },
  { $kind: 'Result', Result: 0 },
  { $kind: 'NestedResult', NestedResult: [0, 0] },
  { $kind: 'Input', Input: 99 },
];

test.each(containers)('accepts owned %s cleanup with %i type arguments', async (module, count) => {
  expect(check(await cleanupData(module, count))).toEqual({ totalSplitFromGas: 0n, splitToSenderMist: 0n });
});

test.each(containers)('rejects malformed and drain-shaped %s cleanup', async (module, count) => {
  for (const types of [Array(count + 1).fill('u64'), ...(count ? [[], ['u64']] : [])]) {
    const data = await cleanupData(module, count);
    data.commands[0].MoveCall.typeArguments = types;
    expect(() => check(data)).toThrow(/type arguments/);
  }
  for (const arg of unsafeRefs) {
    const data = await cleanupData(module, count);
    data.commands[0].MoveCall.arguments = [arg];
    expect(() => check(data)).toThrow(/gas coin|owned, version-pinned/);
  }
  for (const length of [0, 2]) {
    const data = await cleanupData(module, count);
    data.commands[0].MoveCall.arguments = Array(length).fill({ $kind: 'Input', Input: 0 });
    expect(() => check(data)).toThrow(/exactly 1 argument/);
  }
  for (const kind of ['SharedObject', 'Receiving']) {
    const data = await cleanupData(module, count);
    data.inputs[0].Object = { $kind: kind, [kind]: ref(OBJ_A) };
    expect(() => check(data)).toThrow(/owned, version-pinned|receiving inputs/);
  }
});

test.each([true, false])('accepts revoke with shared allowance %s', async (shared) => {
  expect(check(await revokeData(shared))).toEqual({ totalSplitFromGas: 0n, splitToSenderMist: 0n });
});

test.each(['bag', 'object_bag', 'table', 'object_table'])(
  'rejects pure %s containers and framework target lookalikes', async (module) => {
    const count = module.includes('table') ? 2 : 0;
    const pure = await cleanupData(module, count);
    pure.inputs[0] = { $kind: 'Pure', Pure: { bytes: '' } };
    expect(() => check(pure)).toThrow(/owned, version-pinned/);
    const lookalike = await cleanupData(module, count);
    lookalike.commands[0].MoveCall.package = '0x3';
    expect(() => check(lookalike)).toThrow(/not an allowed framework call/);
  }
);

test('keeps kiosk withdraw outside the allowlist', async () => {
  const data = await revokeData();
  data.commands[0].MoveCall.module = 'kiosk';
  data.commands[0].MoveCall.function = 'withdraw';
  expect(() => check(data)).toThrow(/not an allowed framework call/);
});

test('rejects malformed revoke arity and unsafe cap or allowance references', async () => {
  for (const types of [[], ['u64', 'u64']]) {
    const data = await revokeData();
    data.commands[0].MoveCall.typeArguments = types;
    expect(() => check(data)).toThrow(/exactly 1 type argument/);
  }
  for (const length of [0, 1, 3]) {
    const data = await revokeData();
    data.commands[0].MoveCall.arguments = Array(length).fill({ $kind: 'Input', Input: 0 });
    expect(() => check(data)).toThrow(/exactly 2 arguments/);
  }
  for (const slot of [0, 1]) {
    for (const arg of [...unsafeRefs, { $kind: 'Input', Input: 2 }]) {
      const data = await revokeData();
      data.inputs.push({ $kind: 'Pure', Pure: { bytes: '' } });
      data.commands[0].MoveCall.arguments[slot] = arg;
      expect(() => check(data)).toThrow(/gas coin|cap input|allowance object input/);
    }
  }
  for (const [slot, kind] of [[0, 'SharedObject'], [0, 'Receiving'], [1, 'Receiving']]) {
    const data = await revokeData();
    data.inputs[slot].Object = { $kind: kind, [kind]: ref(OBJ_A) };
    expect(() => check(data)).toThrow(/cap input|receiving inputs/);
  }
});

test('revoke cannot launder gas splits or manufacture sponsor income', async () => {
  const data = await revokeData();
  data.commands.push({ $kind: 'TransferObjects', TransferObjects: {
    objects: [{ $kind: 'Result', Result: 0 }], address: { $kind: 'Input', Input: 2 },
  } });
  data.inputs.push({ $kind: 'Pure', Pure: { bytes: Buffer.from(SPONSOR.slice(2), 'hex').toString('base64') } });
  expect(() => check(data)).toThrow(/fee recipient may only receive/);

  const drain = await dataFor((tx) => {
    const [coin] = tx.splitCoins(tx.gas, [1_000_000]);
    tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: ['u64'],
      arguments: [coin, tx.objectRef(ref(OBJ_B))] });
  });
  expect(() => check(drain)).toThrow(/cap input/);
});

test('shared allowance cleanup payouts remain bounded by actual gas rebates', async () => {
  const data = await revokeData();
  const payout = await dataFor((tx) => {
    const [coin] = tx.splitCoins(tx.gas, [7_000_000]);
    tx.transferObjects([coin], tx.pure.address(USER));
  });
  // offset the appended input and result references to preserve the serialized shape
  payout.commands[0].SplitCoins.amounts[0].Input += data.inputs.length;
  payout.commands[1].TransferObjects.address.Input += data.inputs.length;
  payout.commands[1].TransferObjects.objects[0].NestedResult[0] += data.commands.length;
  data.inputs.push(...payout.inputs);
  data.commands.push(...payout.commands);
  const { splitToSenderMist } = check(data);
  expect(splitToSenderMist).toBe(7_000_000n);
  expect(gasCoinNetMist({ computationCost: '1000000', storageCost: '3000000', storageRebate: '10000000' }, splitToSenderMist)).toBe(-1_000_000n);
});

const keepTokensData = (recipient = USER, typeArguments = ['0xabc::foo::FOO']) =>
  dataFor((tx) => {
    tx.moveCall({
      target: '0x2::coin::send_funds',
      typeArguments,
      arguments: [tx.objectRef(ref(OBJ_A)), tx.pure.address(recipient)],
    });
  });

test.each(['0xabc::foo::FOO', '0x2::sui::SUI'])(
  'accepts keep_tokens sending an owned %s coin to the declared sender',
  async (coinType) => {
    expect(check(await keepTokensData(USER, [coinType]))).toEqual({
      totalSplitFromGas: 0n,
      splitToSenderMist: 0n,
    });
  }
);

test.each([SPONSOR, ATTACKER])('rejects keep_tokens recipient %s', async (recipient) => {
  const data = await keepTokensData(recipient);
  expect(() => check(data)).toThrow(/send_funds.*sender/);
});

test.each([{ types: [] }, { types: ['0x2::sui::SUI', '0xabc::foo::FOO'] }])(
  'rejects send_funds with type arguments %j',
  async ({ types }) => {
    const data = await keepTokensData(USER, types);
    expect(() => check(data)).toThrow(/exactly 1 type argument/);
  }
);

test.each([0, 1, 3])('rejects send_funds with %i arguments', async (count) => {
  const data = await keepTokensData();
  const args = data.commands[0].MoveCall.arguments;
  data.commands[0].MoveCall.arguments = count === 3 ? [...args, args[0]] : args.slice(0, count);
  expect(() => check(data)).toThrow(/exactly 2 arguments/);
});

test.each([
  { $kind: 'GasCoin', GasCoin: true },
  { $kind: 'Result', Result: 0 },
  { $kind: 'NestedResult', NestedResult: [0, 0] },
  { $kind: 'Input', Input: 1 },
])('rejects send_funds coin argument %j', async (arg) => {
  const data = await keepTokensData();
  data.commands[0].MoveCall.arguments[0] = arg;
  expect(() => check(data)).toThrow(
    arg.$kind === 'GasCoin' ? /references the gas coin/ : /owned, version-pinned/
  );
});

test.each(['SharedObject', 'Receiving'])(
  'rejects send_funds with a %s coin input',
  async (kind) => {
    const data = await keepTokensData();
    data.inputs[0].Object = { $kind: kind, [kind]: ref(OBJ_A) };
    expect(() => check(data)).toThrow(/owned, version-pinned|receiving inputs/);
  }
);

test.each([
  { $kind: 'GasCoin', GasCoin: true },
  { $kind: 'Result', Result: 0, Input: 1 },
  { $kind: 'NestedResult', NestedResult: [0, 0], Input: 1 },
  { $kind: 'Input', Input: 0 },
])('rejects send_funds recipient argument %j', async (arg) => {
  const data = await keepTokensData();
  data.commands[0].MoveCall.arguments[1] = arg;
  expect(() => check(data)).toThrow(
    arg.$kind === 'GasCoin' ? /references the gas coin/ : /literal.*sender/
  );
});

test('counts sponsor gas splits paid into the sender address balance', async () => {
  const data = await dataFor((tx) => {
    const [coin] = tx.splitCoins(tx.gas, [1_000_000]);
    tx.moveCall({
      target: '0x2::coin::send_funds',
      typeArguments: ['0x2::sui::SUI'],
      arguments: [coin, tx.pure.address(USER)],
    });
  });
  expect(check(data)).toEqual({totalSplitFromGas:1_000_000n,splitToSenderMist:1_000_000n});
  expect(gasCoinNetMist({storageRebate:'1500000',computationCost:'1000000',storageCost:'0'},check(data).splitToSenderMist)).toBe(-500000n);
});

test.each([SPONSOR,ATTACKER])('rejects routing a gas-split address payout to %s',async recipient=>{
  const data=await dataFor(tx=>{
    const [coin]=tx.splitCoins(tx.gas,[1000000]);
    tx.moveCall({target:'0x2::coin::send_funds',typeArguments:['0x2::sui::SUI'],arguments:[coin,tx.pure.address(recipient)]});
  });
  expect(()=>check(data)).toThrow(/literal.*sender/);
});

test('rejects unsupported result origins, type substitution, and bare multi-split results for address payouts',async()=>{
  const make=()=>dataFor(tx=>{
    const [a,b]=tx.splitCoins(tx.gas,[1000,2000]);
    tx.moveCall({target:'0x2::coin::send_funds',typeArguments:['0x2::sui::SUI'],arguments:[a,tx.pure.address(USER)]});
    tx.moveCall({target:'0x2::coin::send_funds',typeArguments:['0x2::sui::SUI'],arguments:[b,tx.pure.address(USER)]});
  });
  const good=await make();
  expect(check(good).splitToSenderMist).toBe(3000n);
  const bare=await make();
  bare.commands[1].MoveCall.arguments[0]={$kind:'Result',Result:0};
  expect(()=>check(bare)).toThrow(/multi-value split/);
  const changed=await make();
  changed.commands[1].MoveCall.typeArguments=['0xabc::t::T'];
  expect(()=>check(changed)).toThrow(/SUI type/);
  const future=await make();
  future.commands[1].MoveCall.arguments[0]={$kind:'NestedResult',NestedResult:[2,0]};
  expect(()=>check(future)).toThrow(/tracked gas split/);
  const fake=await make();
  fake.commands[0]={$kind:'MoveCall',MoveCall:{package:'0xdead',module:'nft',function:'burn',arguments:[{$kind:'Input',Input:0}],typeArguments:[]}};
  fake.inputs[0]={$kind:'Object',Object:{$kind:'ImmOrOwnedObject',ImmOrOwnedObject:ref(OBJ_A)}};
  expect(()=>check(fake)).toThrow(/tracked gas split/);
});

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
  // Structurally a sender may be paid from the gas coin - that is how the user gets
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

test('corrected mainnet payout retains the fee and allowance without weakening the gas gate', () => {
  const gas = { computationCost: '100000', storageCost: '988000', storageRebate: '3602040' };
  expect(gasCoinNetMist(gas, 2_129_985n)).toBe(384_055n);
  expect(gasCoinNetMist(gas, 2_514_041n)).toBe(-1n);
});

test('gasCoinNetMist refuses to guess when the gas figures are missing', () => {
  // absent fields are absent evidence - defaulting them to zero would pass the gate on
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
  // the sponsor always pays gas, so no row means missing data, not a zero net - // returning 0n here would let the only value gate pass on no evidence
  expect(netSuiChangeForAddress([], SPONSOR)).toBe(null);
  expect(netSuiChangeForAddress(undefined, SPONSOR)).toBe(null);
  expect(
    netSuiChangeForAddress([{ address: USER, coinType: '0x2::sui::SUI', amount: '5' }], SPONSOR)
  ).toBe(null);
});
