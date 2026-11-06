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
