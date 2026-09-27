import { Transaction } from '@mysten/sui/transactions';
import type { CleanupAction, MergeCoinsAction, DestroyZeroAction, CloseKioskAction, BurnAction } from './types';
import { MAX_MERGES_PER_BATCH, MAX_ACTIONS_PER_BATCH, FEE_RATE, FEE_RECIPIENT, REBATE_MULTIPLIER, SUI_COIN_TYPE_ARG } from './constants';

const KIOSK_CLOSE_TARGET = '0x2::kiosk::close_and_withdraw';
const COIN_DESTROY_ZERO_TARGET = '0x2::coin::destroy_zero' as `${string}::${string}::${string}`;
const COIN_SEND_FUNDS_TARGET = '0x2::coin::send_funds';
const BALANCE_REDEEM_FUNDS_TARGET = '0x2::balance::redeem_funds';
const BALANCE_SEND_FUNDS_TARGET = '0x2::balance::send_funds';

/**
 * where a self-paid transaction's gas comes from. it's one or the other, never both:
 * coin objects in the gas payment, or the address balance through an empty payment.
 */
export type SelfPaidGasSource = 'gasCoin' | 'addressBalance';

// fee (mist): 13.69% of total storage rebate
export function computeFeeMist(totalStorageRebateMist: number): number {
  if (totalStorageRebateMist <= 0) return 0;
  return Math.floor(totalStorageRebateMist * FEE_RATE);
}

export interface BuildBatchOptions {
  /** sponsor pays gas; rebates land in the sponsor's gas coin so the user share is transferred back explicitly */
  sponsoredGas?: boolean;
  /** required when sponsoredGas: where the user's share is sent */
  senderAddress?: string;
  /**
   * Gas (mist) the sponsor fronts and recoups from the rebate. Leave undefined to
   * estimate it from the actions that actually fit in the batch - passing a figure
   * summed over the whole selection charges the user for work the cap dropped.
   */
  estimatedGasMist?: number | null;
  /** user-owned coins that must not be consumed as merge/destroy inputs */
  gasCoinId?: string | null;
  feeCoinId?: string | null;
  /**
   * self-paid only: where the service fee is drawn from, and the most it may take.
   * the fee leaves the user's existing SUI mid-execution (rebates are only credited
   * once execution ends), so it's capped at what the source holds after the gas
   * budget. null or absent waives the fee.
   */
  selfPaidFee?: { source: SelfPaidGasSource; maxMist: number } | null;
}

export interface BuildBatchResult {
  tx: Transaction;
  /** the actions that fit under MAX_ACTIONS_PER_BATCH and made it into the PTB */
  includedActions: CleanupAction[];
  /** storage rebate (mist) the PTB will ACTUALLY realize - excludes surviving merge primaries and anything dropped by the cap */
  storageRebateMist: number;
  /** 99% of the realized rebate */
  userRebateMist: number;
  feeMist: number;
  /** SUI (mist) transferred back to the user in sponsored mode */
  userShareMist: number;
  /** actions the batch cap forced us to leave out */
  droppedActionCount: number;
  /** gas (mist) the build actually charged, derived from includedActions */
  gasMist: number;
}

// per-object gas estimate for the part of an action that made it into the batch
function gasForIncluded(action: CleanupAction, includedObjectCount: number): number {
  const total = action.objectIds.length || 1;
  if (action.kind === 'merge_coins' || action.kind === 'close_kiosk') {
    return action.estimatedGasMist;
  }
  return Math.ceil((action.estimatedGasMist / total) * includedObjectCount);
}

// per-object storage rebate; falls back to an even split when the scanner did not record them
function rebateForObject(action: CleanupAction, objectId: string): number {
  const index = action.objectIds.indexOf(objectId);
  const perObject = action.objectStorageRebates;
  if (perObject && index >= 0 && perObject[index] != null) {
    return Number(perObject[index]);
  }
  const count = action.objectIds.length || 1;
  return Number(action.storageRebateTotal) / count;
}

// build one transaction that batches up to MAX_ACTIONS_PER_BATCH; never include gas in merge/destroy_zero; fee split from gas coin at the end.
// when options.sponsoredGas is set, rebates go to the sponsor's gas coin so we also transfer the user share to options.senderAddress.
export function buildBatchTransaction(
  actions: CleanupAction[],
  options: BuildBatchOptions = {}
): BuildBatchResult {
  const tx = new Transaction();
  const sponsoredGas = Boolean(options.sponsoredGas && options.senderAddress);
  const estimatedGasMist = options.estimatedGasMist ?? null;
  const selfPaidFee = sponsoredGas ? null : options.selfPaidFee ?? null;

  const excludeFromCoins = new Set(
    [options.gasCoinId, options.feeCoinId].filter(Boolean) as string[]
  );

  // ---- pass 1: decide what actually fits, and what rebate that really realizes ----
  // The fee and the sponsored user share must be derived from the objects this PTB
  // destroys, not from everything the user selected: a merge keeps its primary coin
  // alive, and the batch cap silently drops the tail. Paying out on the full total
  // draws the difference from the sponsor's gas coin.
  type MergeGroup = { ids: string[]; rebateById: Map<string, number> };
  const mergeGroups = new Map<string, MergeGroup>();
  const destroyZero: { action: DestroyZeroAction; objectIds: string[] }[] = [];
  const closeKiosks: CloseKioskAction[] = [];
  const burns: { action: BurnAction; objectIds: string[] }[] = [];
  const includedActions: CleanupAction[] = [];

  let actionCount = 0;
  let droppedActionCount = 0;
  let realizedRebate = 0;
  let includedGasMist = 0;
  const cap = MAX_ACTIONS_PER_BATCH;

  for (const action of actions) {
    if (actionCount >= cap) {
      droppedActionCount += 1;
      continue;
    }
    switch (action.kind) {
      case 'merge_coins': {
        const a = action as MergeCoinsAction;
        const ids = a.objectIds.filter((id) => !excludeFromCoins.has(id));
        if (ids.length <= 1) continue;
        const group: MergeGroup = mergeGroups.get(a.coinType) ?? { ids: [], rebateById: new Map() };
        for (const id of ids) {
          if (!group.rebateById.has(id)) {
            group.ids.push(id);
            group.rebateById.set(id, rebateForObject(a, id));
          }
        }
        mergeGroups.set(a.coinType, group);
        includedActions.push(a);
        includedGasMist += a.estimatedGasMist;
        actionCount += 1;
        break;
      }
      case 'destroy_zero': {
        const a = action as DestroyZeroAction;
        const ids: string[] = [];
        for (const objectId of a.objectIds) {
          if (excludeFromCoins.has(objectId)) continue;
          if (actionCount >= cap) {
            droppedActionCount += 1;
            continue;
          }
          if (!a.coinType.match(/^(0x[a-fA-F0-9]+)::([^:]+)::([^<]+)/)) continue;
          ids.push(objectId);
          realizedRebate += rebateForObject(a, objectId);
          actionCount += 1;
        }
        if (ids.length === 0) continue;
        destroyZero.push({ action: a, objectIds: ids });
        includedActions.push(a);
        includedGasMist += gasForIncluded(a, ids.length);
        break;
      }
      case 'close_kiosk': {
        const a = action as CloseKioskAction;
        closeKiosks.push(a);
        includedActions.push(a);
        realizedRebate += Number(a.storageRebateTotal);
        includedGasMist += a.estimatedGasMist;
        actionCount += 1;
        break;
      }
      case 'burn': {
        const a = action as BurnAction;
        const ids: string[] = [];
        for (const objectId of a.objectIds) {
          if (actionCount >= cap) {
            droppedActionCount += 1;
            continue;
          }
          ids.push(objectId);
          realizedRebate += rebateForObject(a, objectId);
          actionCount += 1;
        }
        if (ids.length === 0) continue;
        burns.push({ action: a, objectIds: ids });
        includedActions.push(a);
        includedGasMist += gasForIncluded(a, ids.length);
        break;
      }
    }
  }

  // a merge of N coins deletes N-1: the primary survives and its rebate is never realized
  const mergePlans: { primary: string; rest: string[] }[] = [];
  for (const [, group] of mergeGroups) {
    const batch = group.ids.slice(0, MAX_MERGES_PER_BATCH);
    droppedActionCount += group.ids.length - batch.length;
    if (batch.length <= 1) continue;
    const [primary, ...rest] = batch;
    mergePlans.push({ primary: primary!, rest });
    for (const id of rest) realizedRebate += group.rebateById.get(id) ?? 0;
  }

  const storageRebateMist = Math.max(0, Math.floor(realizedRebate));
  const userRebateMist = Math.floor(storageRebateMist * REBATE_MULTIPLIER);
  // charge only for what this batch actually does; the caller's selection may be larger
  const gasMist = estimatedGasMist ?? includedGasMist;

  let feeMist = computeFeeMist(storageRebateMist);
  if (!sponsoredGas) {
    // a batch that doesn't cover its own gas already costs the user; charging on top
    // of that would be obscene
    if (userRebateMist - feeMist - gasMist <= 0) feeMist = 0;
    const feeCapMist = selfPaidFee ? Math.max(0, Math.floor(selfPaidFee.maxMist)) : 0;
    feeMist = Math.min(feeMist, feeCapMist);
  }

  // ---- pass 2: emit commands ----
  for (const { action, objectIds } of destroyZero) {
    const [pkg, mod, name] =
      action.coinType.match(/^(0x[a-fA-F0-9]+)::([^:]+)::([^<]+)/)?.slice(1) ?? [];
    if (!pkg || !mod || !name) continue;
    const typeArg = action.coinType.includes('<')
      ? action.coinType.slice(action.coinType.indexOf('<') + 1, -1)
      : undefined;
    for (const objectId of objectIds) {
      tx.moveCall({
        target: COIN_DESTROY_ZERO_TARGET,
        typeArguments: typeArg ? [typeArg] : [],
        arguments: [tx.object(objectId)],
      });
    }
  }

  for (const kiosk of closeKiosks) {
    // close_and_withdraw returns the kiosk's accumulated PROFITS as a Coin<SUI>, not a zero
    // coin. Merging it into tx.gas hands the user's sale earnings to whoever owns the gas
    // coin - the sponsor. It always belongs to the kiosk owner.
    if (!options.senderAddress) {
      throw new Error('senderAddress is required to close a kiosk (its profits are paid to the owner).');
    }
    const [withdrawnCoin] = tx.moveCall({
      target: KIOSK_CLOSE_TARGET,
      arguments: [tx.object(kiosk.kioskId), tx.object(kiosk.ownerCapId)],
    });
    if (kiosk.profitsMist === 0) {
      // A kiosk with no items cannot make new sales, so zero profits at scan time stay
      // zero. Destroying the empty coin avoids paying storage for a worthless object.
      tx.moveCall({
        target: COIN_DESTROY_ZERO_TARGET,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [withdrawnCoin],
      });
    } else {
      tx.transferObjects([withdrawnCoin], tx.pure.address(options.senderAddress));
    }
  }

  for (const { action, objectIds } of burns) {
    for (const objectId of objectIds) {
      tx.moveCall({
        target: action.moveTarget as `${string}::${string}::${string}`,
        arguments: [tx.object(objectId)],
      });
    }
  }

  for (const plan of mergePlans) {
    tx.mergeCoins(
      tx.object(plan.primary),
      plan.rest.map((id) => tx.object(id))
    );
  }

  // payouts go last. whatever leaves the gas coin here comes out of its existing balance:
  // storage rebates only land once execution ends, so they can't fund a split mid-PTB.
  let userShareMist = 0;
  if (sponsoredGas && options.senderAddress) {
    userShareMist = userRebateMist - gasMist - feeMist;
    if (userShareMist < 0) {
      throw new Error(
        'Rebate does not cover gas and fee; we do not sponsor transactions that lose money.'
      );
    }
    // Split out ONLY the user's share. The gas recoup and the fee are already sitting in
    // the gas coin, which the sponsor owns - splitting them off and transferring them to
    // FEE_RECIPIENT (the sponsor itself) was a round trip that created a second coin
    // object every run, costing ~988,000 mist of extra storage and steadily draining and
    // fragmenting the gas coin. Leaving them in place makes the gas coin self-funding:
    // its net change per batch becomes rebate - gross gas - userShare, i.e. the fee.
    if (userShareMist > 0) {
      const [userCoin] = tx.splitCoins(tx.gas, [userShareMist]);
      tx.transferObjects([userCoin], tx.pure.address(options.senderAddress));
    }
  } else if (feeMist > 0 && selfPaidFee) {
    // the fee lands in the recipient's address balance, not as a new coin object. a coin
    // would bill the USER ~988,000 mist of storage, which is more than the whole fee on
    // a small batch, and a pile of dust coins can't pay the sponsor's gas anyway.
    if (selfPaidFee.source === 'gasCoin') {
      const [feeCoin] = tx.splitCoins(tx.gas, [feeMist]);
      tx.moveCall({
        target: COIN_SEND_FUNDS_TARGET,
        typeArguments: [SUI_COIN_TYPE_ARG],
        arguments: [feeCoin!, tx.pure.address(FEE_RECIPIENT)],
      });
    } else {
      // address-balance gas pairs with a withdrawal, never tx.gas. the resolver (ours
      // and the wallet's) only picks the address balance when the PTB never touches
      // GasCoin, simulation doesn't check an empty payment against the payer at all,
      // and the protocol has a switch (address_balance_gas_reject_gas_coin_arg) waiting
      // to reject the combination outright. a withdrawal is checked against the real
      // balance.
      const [feeBalance] = tx.moveCall({
        target: BALANCE_REDEEM_FUNDS_TARGET,
        typeArguments: [SUI_COIN_TYPE_ARG],
        arguments: [tx.withdrawal({ amount: feeMist, type: SUI_COIN_TYPE_ARG })],
      });
      tx.moveCall({
        target: BALANCE_SEND_FUNDS_TARGET,
        typeArguments: [SUI_COIN_TYPE_ARG],
        arguments: [feeBalance!, tx.pure.address(FEE_RECIPIENT)],
      });
    }
  }

  return {
    tx,
    includedActions,
    storageRebateMist,
    userRebateMist,
    feeMist,
    userShareMist,
    droppedActionCount,
    gasMist,
  };
}
