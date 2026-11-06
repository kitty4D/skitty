import { describe, expect, it } from 'vitest';
import { buildBatchTransaction } from './buildCleanupTransaction';
import type { KeepTokensAction, MergeCoinsAction } from './types';

const SENDER = `0x${'1'.repeat(64)}`;
const ids = ['0xa', '0xb', '0xc'];
const action: KeepTokensAction = {
  kind: 'keep_tokens', coinType: '0x2::coin::Coin<0xabc::token::TOKEN>',
  objectIds: ids, objectBalances: ['100', '200', '300'],
  objectStorageRebates: ['1000000', '2000000', '3000000'],
  storageRebateTotal: '6000000', userRebateMist: 5940000,
  estimatedGasMist: 900, netGainMist: 0, label: 'TOKEN',
};

describe('keep tokens', () => {
  it('consumes coins into the sender balance and reclaims all their storage', () => {
    const built = buildBatchTransaction([action], { senderAddress: SENDER });
    expect(built.storageRebateMist).toBe(6000000);
    const commands = built.tx.getData().commands;
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.MoveCall?.function).toBe('send_funds');
      expect(command.MoveCall?.typeArguments).toEqual(['0xabc::token::TOKEN']);
    }
    const pure = built.tx.getData().inputs.filter((input) => input.$kind === 'Pure');
    expect(pure).toHaveLength(3);
    for (const input of pure) {
      expect([...atob(input.Pure!.bytes)].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')).toBe('1'.repeat(64));
    }
  });

  it('requires the destination to be the sender', () => {
    expect(() => buildBatchTransaction([action])).toThrow(/senderAddress/);
  });

  it('excludes every gas-payment coin from deposits and rebate accounting', () => {
    const built = buildBatchTransaction([action], {
      senderAddress: SENDER, gasCoinIds: ['0xa', '0xb'],
    });
    expect(built.storageRebateMist).toBe(3000000);
    expect(built.includedActions[0].objectIds).toEqual(['0xc']);
    expect(built.tx.getData().commands).toHaveLength(1);
  });

  it('rejects overlapping merge and deposit selections', () => {
    const merge: MergeCoinsAction = { ...action, kind: 'merge_coins' };
    expect(() => buildBatchTransaction([merge, action], { senderAddress: SENDER })).toThrow(/overlap/i);
  });

  it('respects the per-object batch cap', () => {
    const many: KeepTokensAction = {
      ...action, objectIds: Array.from({ length: 55 }, (_, i) => `0x${(i + 1).toString(16)}`),
      objectStorageRebates: Array(55).fill('1000000'),
    };
    const built = buildBatchTransaction([many], { senderAddress: SENDER });
    expect(built.tx.getData().commands).toHaveLength(50);
    expect(built.storageRebateMist).toBe(50000000);
    expect(built.includedActions[0].objectIds).toHaveLength(50);
  });

  it('consolidates other selected SUI coins into the reserved gas coin', () => {
    const sui: MergeCoinsAction = {
      ...action, kind: 'merge_coins', coinType: '0x2::coin::Coin<0x2::sui::SUI>',
    };
    const built = buildBatchTransaction([sui], {
      senderAddress: SENDER, gasCoinIds: ['0xa'], mergeSuiIntoGas: true,
    });
    expect(built.storageRebateMist).toBe(5000000);
    const merge = built.tx.getData().commands[0].MergeCoins;
    expect(merge?.destination.$kind).toBe('GasCoin');
    expect(merge?.sources).toHaveLength(2);
    expect(built.includedActions[0].objectIds).toEqual(['0xb', '0xc']);
  });

  it('counts gas smashing as consolidation when all selected coins pay gas', () => {
    const sui: MergeCoinsAction = {
      ...action, kind: 'merge_coins', coinType: '0x2::coin::Coin<0x2::sui::SUI>',
      objectIds: ['0xa', '0xb'], objectStorageRebates: ['1000000', '2000000'],
    };
    const built = buildBatchTransaction([sui], {
      senderAddress: SENDER, gasCoinIds: ['0xa', '0xb'], mergeSuiIntoGas: true,
    });
    expect(built.includedActions[0].objectIds).toEqual(['0xb']);
    expect(built.storageRebateMist).toBe(2000000);
    expect(built.tx.getData().commands).toHaveLength(0);
  });
});
