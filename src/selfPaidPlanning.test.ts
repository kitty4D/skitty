import { afterEach, expect, it, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { graphQLClient } from './graphql/client';
import { simulateActions, executeActions } from './sponsoredTx';
import type { CleanupAction, KeepTokensAction } from './types';

afterEach(() => vi.restoreAllMocks());
const SENDER = `0x${'1'.repeat(64)}`;
const DIGEST = '11111111111111111111111111111111';
const deposit = (id: string, type = '0xabc::t::T'): KeepTokensAction => ({
  kind: 'keep_tokens', coinType: `0x2::coin::Coin<${type}>`, objectIds: [id],
  objectStorageRebates: ['1000000'], storageRebateTotal: '1000000',
  userRebateMist: 990000, estimatedGasMist: 500, netGainMist: 0, label: 'T',
});
const simulation = (gross: number) => ({
  $kind: 'Transaction', Transaction: {
    status: { success: true, error: null }, balanceChanges: [],
    effects: { gasUsed: { computationCost: String(gross), storageCost: '0', storageRebate: '50000000' } },
  },
}) as never;

it('reprices newly included work when the measured budget switches gas sources', async () => {
  vi.spyOn(graphQLClient, 'listCoins').mockResolvedValue({ objects: [
    { objectId: '0xaaa', version: '1', digest: DIGEST, balance: '100000000' },
  ] } as never);
  vi.spyOn(graphQLClient, 'getBalance').mockResolvedValue({ balance: { addressBalance: '3000000' } } as never);
  const snapshots: ReturnType<Transaction['getData']>[] = [];
  vi.spyOn(Transaction.prototype, 'build').mockImplementation(async function(this: Transaction) {
    snapshots.push(this.getData());
    return new Uint8Array([snapshots.length]);
  });
  vi.spyOn(graphQLClient, 'simulateTransaction')
    .mockResolvedValueOnce(simulation(3000000))
    .mockResolvedValueOnce(simulation(12000000))
    .mockResolvedValue(simulation(12000000));
  const burn: CleanupAction = {
    ...deposit('0xff'), kind: 'burn', objectType: '0xabc::nft::Nft', moveTarget: '0xabc::nft::burn',
  };
  const actions = [deposit('0xaaa', '0x2::sui::SUI'),
    ...Array.from({ length: 49 }, (_, i) => deposit(`0x${(i + 1).toString(16)}`)), burn];
  const result = await simulateActions(actions, SENDER, 'self');
  expect(snapshots).toHaveLength(3);
  expect(snapshots[0].commands.some((c) => c.MoveCall?.function === 'burn')).toBe(false);
  expect(snapshots[1].commands.some((c) => c.MoveCall?.function === 'burn')).toBe(true);
  expect(snapshots[2].gasData.budget).toBe('18000000');
  expect(result.build.gasMist).toBe(12000000);
  expect(result.build.includedActions.some((a) => a.kind === 'burn')).toBe(true);
});

it('allows consolidation performed entirely by gas smashing', async () => {
  vi.spyOn(graphQLClient, 'listCoins').mockResolvedValue({ objects: ['0xa', '0xb'].map((objectId) => ({
    objectId, version: '1', digest: DIGEST, balance: '2000000',
  })) } as never);
  vi.spyOn(graphQLClient, 'getBalance').mockResolvedValue({ balance: { addressBalance: '0' } } as never);
  const snapshots: ReturnType<Transaction['getData']>[] = [];
  vi.spyOn(Transaction.prototype, 'build').mockImplementation(async function(this: Transaction) {
    snapshots.push(this.getData());
    return new Uint8Array([snapshots.length]);
  });
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue(simulation(1000000));
  const merge: CleanupAction = {
    ...deposit('0xa', '0x2::sui::SUI'), kind: 'merge_coins', objectIds: ['0xa', '0xb'],
    objectStorageRebates: ['1000000', '1000000'],
  };
  const result = await simulateActions([merge], SENDER, 'self');
  expect(result.success).toBe(true);
  expect(result.build.includedActions).toHaveLength(1);
  expect(result.build.storageRebateMist).toBe(1000000);
  expect(snapshots[1].gasData.payment).toHaveLength(2);
  expect(snapshots[1].commands).toHaveLength(0);
});

it('uses final gas effects after a draft fee is waived, rather than the draft gas estimate', async () => {
  vi.spyOn(graphQLClient, 'listCoins').mockResolvedValue({ objects: [] } as never);
  vi.spyOn(graphQLClient, 'getBalance').mockResolvedValue({ balance: { addressBalance: '100000000' } } as never);
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(graphQLClient, 'simulateTransaction')
    .mockResolvedValueOnce(simulation(2000000))
    .mockResolvedValueOnce({
      $kind: 'Transaction', Transaction: {
        status: { success: true }, balanceChanges: [],
        effects: { gasUsed: { computationCost: '100000', storageCost: '0', storageRebate: '987901' } },
      },
    } as never);
  const result = await simulateActions([deposit('0xa')], SENDER, 'self');
  expect(result.build.feeMist).toBe(0);
  expect(result.build.gasMist).toBe(2000000);
  expect(result.netGainMist).toBe(887901);
});

it('prefers the sender balance change, including zero, over any calculated recovery', async () => {
  vi.spyOn(graphQLClient, 'listCoins').mockResolvedValue({ objects: [] } as never);
  vi.spyOn(graphQLClient, 'getBalance').mockResolvedValue({ balance: { addressBalance: '100000000' } } as never);
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  const response = simulation(100000) as unknown as { Transaction: { balanceChanges: unknown[] } };
  response.Transaction.balanceChanges = [{ address: SENDER, coinType: '0x2::sui::SUI', amount: '0' }];
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue(response as never);
  const result = await simulateActions([deposit('0xa')], SENDER, 'self');
  expect(result.netGainMist).toBe(0);
  expect(result.sponsorNetMist).toBeNull();
});

it('measures sponsored gas before quoting the sender payout and retains only fee plus allowance', async () => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: '0x2' }),
  } as Response);
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue({
    $kind: 'Transaction', Transaction: { status: { success: true },
      effects: { gasUsed: { computationCost: '200000', storageCost: '0', storageRebate: '1000000' } },
      balanceChanges: [{ address: '0x2', coinType: '0x2::sui::SUI', amount: '146900' }],
    },
  } as never);
  const result = await simulateActions([deposit('0xa')], SENDER, 'sponsored');
  expect(result.build.gasMist).toBe(200000);
  expect(result.netGainMist).toBe(990000 - 200000 - 136900);
  expect(result.netGainMist).toBe(result.build.userShareMist);
  expect(result.sponsorNetMist).toBe(146900);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  for (const [, options] of fetchMock.mock.calls) {
    expect(JSON.parse(String(options?.body)).simulateOnly).toBe(true);
  }
});

it.each([123456, 0, -123456, 146901, undefined])('rejects undisclosed or unverified sponsor retention of %s', async (net) => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  const sponsor = `0x${'2'.repeat(64)}`;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: sponsor }),
  } as Response);
  const response = { $kind: 'Transaction', Transaction: {
    status: { success: true }, balanceChanges: [] as unknown[],
    effects: { gasUsed: { computationCost: '200000', storageCost: '0', storageRebate: '1000000' } },
  } };
  response.Transaction.balanceChanges = [
    { address: sponsor, coinType: '0x2::sui::SUI', amount: String(net) },
    { address: SENDER, coinType: '0x2::sui::SUI', amount: '653100' },
    { address: sponsor, coinType: '0xabc::other::TOKEN', amount: '999999' },
  ];
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue(response as never);
  await expect(simulateActions([deposit('0xa')], SENDER, 'sponsored')).rejects.toThrow(/could not be verified/);
});

it('credits the gas-object rebate from the reported mainnet transaction to the user payout', async () => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: '0x2' }),
  } as Response);
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue({
    $kind: 'Transaction', Transaction: { status: { success: true },
      effects: { gasUsed: { computationCost: '100000', storageCost: '988000', storageRebate: '3602040' } },
      balanceChanges: [{ address: '0x2', coinType: '0x2::sui::SUI', amount: '384055' }],
    },
  } as never);
  const action = { ...deposit('0xa'), storageRebateTotal: '2614400', objectStorageRebates: ['2614400'] };
  const result = await simulateActions([action], SENDER, 'sponsored');
  expect(result.build.gasMist).toBe(100360);
  expect(result.build.userShareMist).toBe(2129985);
  expect(result.sponsorNetMist).toBe(384055);
});

it('does not ask the wallet to sign when the reserved sponsor coin changes the retained amount', async () => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: '0x2', sponsorSignature: 'dummy' }),
  } as Response);
  vi.spyOn(graphQLClient, 'simulateTransaction').mockResolvedValue({
    $kind: 'Transaction', Transaction: { status: { success: true },
      effects: { gasUsed: { computationCost: '200000', storageCost: '0', storageRebate: '1000000' } },
      balanceChanges: [{ address: '0x2', coinType: '0x2::sui::SUI', amount: '146901' }],
    },
  } as never);
  const sign = vi.fn();
  const submit = vi.spyOn(graphQLClient, 'executeTransaction');
  await expect(executeActions([deposit('0xa')], SENDER, sign, 'sponsored')).rejects.toThrow(/could not be verified/);
  expect(sign).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it('remeasures when adding the payout changes storage costs', async () => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: '0x2' }),
  } as Response);
  const quote = (cost: string) => ({
    $kind: 'Transaction', Transaction: { status: { success: true },
      effects: { gasUsed: { computationCost: cost, storageCost: '0', storageRebate: '1000000' } },
      balanceChanges: [{ address: '0x2', coinType: '0x2::sui::SUI', amount: '146900' }],
    },
  }) as never;
  const simulate = vi.spyOn(graphQLClient, 'simulateTransaction')
    .mockResolvedValueOnce(quote('200000')).mockResolvedValue(quote('300000'));
  const result = await simulateActions([deposit('0xa')], SENDER, 'sponsored');
  expect(simulate).toHaveBeenCalledTimes(4);
  expect(result.build.userShareMist).toBe(553100);
  expect(result.sponsorNetMist).toBe(146900);
});

it('rejects an apparently correct sponsor balance when gas arithmetic disagrees', async () => {
  vi.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ sponsoredTxBytes: 'AQ==', sponsorAddress: '0x2' }),
  } as Response);
  const quote = (rebate: string) => ({
    $kind: 'Transaction', Transaction: { status: { success: true },
      effects: { gasUsed: { computationCost: '200000', storageCost: '0', storageRebate: rebate } },
      balanceChanges: [{ address: '0x2', coinType: '0x2::sui::SUI', amount: '146900' }],
    },
  }) as never;
  vi.spyOn(graphQLClient, 'simulateTransaction')
    .mockResolvedValueOnce(quote('1000000')).mockResolvedValueOnce(quote('1000000'))
    .mockResolvedValue(quote('900000'));
  await expect(simulateActions([deposit('0xa')], SENDER, 'sponsored')).rejects.toThrow(/could not be verified/);
});

it('checks real funding for forced-self kiosk withdrawal even with a funded sponsor requested', async () => {
  vi.spyOn(graphQLClient, 'listCoins').mockResolvedValue({objects:[]} as never);
  vi.spyOn(graphQLClient, 'getBalance').mockResolvedValue({balance:{addressBalance:'0'}} as never);
  const simulate = vi.spyOn(graphQLClient, 'simulateTransaction');
  const sign = vi.fn();
  const action: CleanupAction = {
    kind:'withdraw_kiosk',objectIds:['0xb','0xc'],kioskId:'0xb',ownerCapId:'0xc',
    proceedsMist:'1000000000',selfPaidOnly:true,details:[],storageRebateTotal:'0',
    userRebateMist:0,estimatedGasMist:1000000,netGainMist:999000000,
  };
  await expect(simulateActions([action],SENDER,'sponsored')).rejects.toThrow(/no SUI/);
  await expect(executeActions([action],SENDER,sign,'sponsored')).rejects.toThrow(/no SUI/);
  expect(simulate).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});
