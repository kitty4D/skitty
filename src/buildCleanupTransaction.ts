import { Transaction } from '@mysten/sui/transactions';
import type { CleanupAction, MergeCoinsAction, DestroyZeroAction, CloseKioskAction, BurnAction } from './types';
import { MAX_MERGES_PER_BATCH, MAX_ACTIONS_PER_BATCH, FEE_RATE, FEE_RECIPIENT, REBATE_MULTIPLIER, GAS_RESERVE_FOR_FEE_MIST } from './constants';

const KIOSK_CLOSE_TARGET = '0x2::kiosk::close_and_withdraw';
const COIN_DESTROY_ZERO_TARGET = '0x2::coin::destroy_zero' as `${string}::${string}::${string}`;

// fee (mist): 13.69% of total storage rebate
export function computeFeeMist(totalStorageRebateMist: number): number {
  if (totalStorageRebateMist <= 0) return 0;
  return Math.floor(totalStorageRebateMist * FEE_RATE);
}

export interface SponsoredGasOptions {
  senderAddress: string;
}

// build one transaction that batches up to MAX_ACTIONS_PER_BATCH; never include gas in merge/destroy_zero; fee split from gas coin at the end.
// when options.sponsoredGas is set, rebates go to sponsor's gas coin so we also transfer user share to options.senderAddress.
export function buildBatchTransaction(
  actions: CleanupAction[],
  gasCoinId: string | null,
  totalStorageRebateMist: number = 0,
  feeCoinId: string | null = null,
  estimatedGasMist: number | null = null,
  gasCoinBalanceMist: number | null = null,
  options?: { sponsoredGas: true; senderAddress: string }
): Transaction {
  const tx = new Transaction();
  const sponsoredGas = Boolean(options?.sponsoredGas && options?.senderAddress);

  // fee only when user gets something back. always take it from tx.gas at the end (rebates are applied to gas coin; we peel off our fee).
  let feeMist = computeFeeMist(totalStorageRebateMist);
  if (estimatedGasMist != null && feeMist > 0 && !sponsoredGas) {
    const userRebateMist = Math.floor(totalStorageRebateMist * REBATE_MULTIPLIER);
    if (userRebateMist - feeMist - estimatedGasMist <= 0) feeMist = 0;
  }
  // cap so we don't split more than (gas coin balance − gas reserve) when user pays gas; skip cap when sponsor pays gas.
  if (!sponsoredGas && feeMist > 0 && gasCoinBalanceMist != null) {
    const gasReserve = estimatedGasMist != null ? estimatedGasMist : GAS_RESERVE_FOR_FEE_MIST;
    const maxFeeFromGas = Math.max(0, gasCoinBalanceMist - gasReserve);
    feeMist = Math.min(feeMist, maxFeeFromGas);
  } else if (!sponsoredGas && feeMist > 0 && gasCoinBalanceMist == null) {
    feeMist = 0;
  }

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
        // close_and_withdraw returns Coin<SUI> (no drop); merge into gas so it's not unused
        const [withdrawnCoin] = tx.moveCall({
          target: KIOSK_CLOSE_TARGET,
          arguments: [tx.object(a.kioskId), tx.object(a.ownerCapId)],
        });
        tx.mergeCoins(tx.gas, [withdrawnCoin]);
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

  // fee at the end: split from tx.gas (rebates already applied). when sponsored, recoup gas first then fee, then send user the rest.
  if (feeMist > 0 || sponsoredGas) {
    const userRebateMist = Math.floor(totalStorageRebateMist * REBATE_MULTIPLIER);
    if (sponsoredGas && options?.senderAddress) {
      const gasRecoupMist = estimatedGasMist ?? 0;
      const totalToHouseMist = gasRecoupMist + feeMist;
      const userShareMist = userRebateMist - totalToHouseMist;
      if (userShareMist < 0) {
        throw new Error(
          'Rebate does not cover gas and fee; we do not sponsor transactions that lose money.'
        );
      }
      if (totalToHouseMist > 0 || userShareMist > 0) {
        if (totalToHouseMist > 0 && userShareMist > 0) {
          const [houseCoin, userCoin] = tx.splitCoins(tx.gas, [totalToHouseMist, userShareMist]);
          tx.transferObjects([houseCoin], tx.pure.address(FEE_RECIPIENT));
          tx.transferObjects([userCoin], tx.pure.address(options.senderAddress));
        } else if (totalToHouseMist > 0) {
          const [houseCoin] = tx.splitCoins(tx.gas, [totalToHouseMist]);
          tx.transferObjects([houseCoin], tx.pure.address(FEE_RECIPIENT));
        } else {
          const [userCoin] = tx.splitCoins(tx.gas, [userShareMist]);
          tx.transferObjects([userCoin], tx.pure.address(options.senderAddress));
        }
      }
    } else if (feeMist > 0) {
      const [feeCoin] = tx.splitCoins(tx.gas, [feeMist]);
      tx.transferObjects([feeCoin], tx.pure.address(FEE_RECIPIENT));
    }
  }

  return tx;
}
