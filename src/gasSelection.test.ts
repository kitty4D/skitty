import { expect, it } from 'vitest';
import { selectCleanupGas } from './gasSelection';
import type { KeepTokensAction } from './types';

const action: KeepTokensAction = {
  kind: 'keep_tokens', coinType: '0x2::coin::Coin<0x2::sui::SUI>',
  objectIds: ['0xa', '0xb'], storageRebateTotal: '2000000', userRebateMist: 1980000,
  estimatedGasMist: 1000, netGainMist: 0, label: 'SUI',
};
const holdings = {
  coins: [
    { objectId: '0xa', version: '1', digest: 'x', balanceMist: 10000000 },
    { objectId: '0xb', version: '1', digest: 'y', balanceMist: 20000000 },
  ], coinTotalMist: 30000000, addressBalanceMist: 0,
};

it('reserves one SUI coin instead of making every selected coin gas', () => {
  const result = selectCleanupGas([action], holdings, 3000000);
  expect(result.source).toBe('gasCoin');
  expect(result.coins.map((coin) => coin.objectId)).toEqual(['0xb']);
  expect(result.availableMist).toBe(20000000);
});

it('prefers sufficient address balance so all selected SUI coins can be processed', () => {
  const result = selectCleanupGas([action], { ...holdings, addressBalanceMist: 5000000 }, 3000000);
  expect(result.source).toBe('addressBalance');
  expect(result.coins).toEqual([]);
});

it('reserves more coins only when one cannot cover the measured budget', () => {
  const result = selectCleanupGas([action], holdings, 25000000);
  expect(result.coins).toHaveLength(2);
  expect(result.availableMist).toBe(30000000);
});
