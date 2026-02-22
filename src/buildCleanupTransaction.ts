import { Transaction } from '@mysten/sui/transactions';
import type { CleanupAction, MergeCoinsAction, DestroyZeroAction, CloseKioskAction, BurnAction } from './types';
import { MAX_MERGES_PER_BATCH, MAX_ACTIONS_PER_BATCH, FEE_RATE, FEE_RECIPIENT } from './constants';

const KIOSK_CLOSE_TARGET = '0x2::kiosk::close_and_withdraw';
const COIN_DESTROY_ZERO_TARGET = '0x2::coin::destroy_zero' as `${string}::${string}::${string}`;

// fee (mist): 13.69% of total storage rebate
export function computeFeeMist(totalStorageRebateMist: number): number {
  if (totalStorageRebateMist <= 0) return 0;
  return Math.floor(totalStorageRebateMist * FEE_RATE);
}

// build one transaction that batches up to MAX_ACTIONS_PER_BATCH; never include gas in merge/destroy_zero; fee from feeCoinId when different from gas, else from gas coin, to FEE_RECIPIENT
export function buildBatchTransaction(
  actions: CleanupAction[],
  gasCoinId: string | null,
  totalStorageRebateMist: number = 0,
  feeCoinId: string | null = null
): Transaction {
  const tx = new Transaction();
  const mergeCoinsByType = new Map<string, string[]>();
  let actionCount = 0;
  const cap = MAX_ACTIONS_PER_BATCH;

  const excludeFromCoins = new Set([gasCoinId, feeCoinId].filter(Boolean) as string[]);

  for (const action of actions) {
    if (actionCount >= cap) break;
    switch (action.kind) {
      case 'merge_coins': {
        const a = action as MergeCoinsAction;
        const ids = excludeFromCoins.size > 0 ? a.objectIds.filter((id) => !excludeFromCoins.has(id)) : [...a.objectIds];
        if (ids.length <= 1) continue;
        const existing = mergeCoinsByType.get(a.coinType) ?? [];
        mergeCoinsByType.set(a.coinType, [...existing, ...ids]);
        actionCount += 1;
        break;
      }
      case 'destroy_zero': {
        const a = action as DestroyZeroAction;
        const ids = excludeFromCoins.size > 0 ? a.objectIds.filter((id) => !excludeFromCoins.has(id)) : [...a.objectIds];
        for (const objectId of ids) {
          if (actionCount >= cap) break;
          const [pkg, mod, name] = a.coinType.match(/^(0x[a-fA-F0-9]+)::([^:]+)::([^<]+)/)?.slice(1) ?? [];
          if (pkg && mod && name) {
            const typeArg = a.coinType.includes('<') ? a.coinType.slice(a.coinType.indexOf('<') + 1, -1) : undefined;
            tx.moveCall({
              target: COIN_DESTROY_ZERO_TARGET,
              typeArguments: typeArg ? [typeArg] : [],
              arguments: [tx.object(objectId)],
            });
            actionCount += 1;
          }
        }
        break;
      }
      case 'close_kiosk': {
        const a = action as CloseKioskAction;
        if (actionCount >= cap) break;
        tx.moveCall({
          target: KIOSK_CLOSE_TARGET,
          arguments: [tx.object(a.kioskId), tx.object(a.ownerCapId)],
        });
        actionCount += 1;
        break;
      }
      case 'burn': {
        const a = action as BurnAction;
        for (const objectId of a.objectIds) {
          if (actionCount >= cap) break;
          tx.moveCall({
            target: a.moveTarget as `${string}::${string}::${string}`,
            arguments: [tx.object(objectId)],
          });
          actionCount += 1;
        }
        break;
      }
    }
  }

  for (const [, ids] of mergeCoinsByType) {
    const unique = [...new Set(ids)];
    const batch = unique.slice(0, MAX_MERGES_PER_BATCH);
    if (batch.length <= 1) continue;
    const [primary, ...rest] = batch;
    tx.mergeCoins(tx.object(primary!), rest.map((id) => tx.object(id)));
  }

  // fee: split from a separate coin when available, otherwise from the gas coin (so fees are always collected)
  const feeMist = computeFeeMist(totalStorageRebateMist);
  const coinForFee =
    feeCoinId && feeCoinId !== gasCoinId ? feeCoinId : gasCoinId;
  if (feeMist > 0 && coinForFee) {
    const [feeCoin] = tx.splitCoins(tx.object(coinForFee), [feeMist]);
    tx.transferObjects([feeCoin], tx.pure.address(FEE_RECIPIENT));
  }

  return tx;
}
