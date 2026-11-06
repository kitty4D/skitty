import { ESTIMATED_GAS, MAX_MERGES_PER_BATCH, REBATE_MULTIPLIER, isSameMoveType, normalizeTypeAddress } from './constants';
import { computeFeeMist } from './buildCleanupTransaction';
import { getCoinTypeArg } from './walletBlocklist';
import type { CleanupAction, DestroyZeroAction, KeepTokensAction, MergeCoinsAction } from './types';
import { normalizeStructTag } from '@mysten/sui/utils';

export interface CoinNode {
  address: string;
  storageRebate?: string | number;
  contents?: { type?: { repr?: string }; json?: unknown };
}

export interface CoinMetadata {
  tokenSymbol?: string;
  tokenDecimals?: number;
}

export function parseCoinBalance(json: unknown): bigint | null {
  if (!json || typeof json !== 'object') return null;
  const balance = (json as Record<string, unknown>).balance;
  const value = balance && typeof balance === 'object'
    ? (balance as Record<string, unknown>).value : balance;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

export function generateCoinActions(
  coins: CoinNode[],
  blocklist: Set<string>,
  metadata: Map<string, CoinMetadata> = new Map(),
): (MergeCoinsAction | KeepTokensAction | DestroyZeroAction)[] {
  const blocked = new Set([...blocklist].map(normalizeTypeAddress));
  const groups = new Map<string, { coinType: string; ids: string[]; balances: string[]; rebates: string[] }>();
  const actions: (MergeCoinsAction | KeepTokensAction | DestroyZeroAction)[] = [];
  const seen = new Set<string>();
  const quote = (rebates: string[], estimatedGasMist: number) => {
    const total = rebates.reduce((sum, value) => sum + BigInt(value), 0n);
    const userRebateMist = Math.floor(Number(total) * REBATE_MULTIPLIER);
    return { storageRebateTotal: String(total), userRebateMist, estimatedGasMist,
      netGainMist: userRebateMist - estimatedGasMist - computeFeeMist(Number(total)) };
  };
  for (const coin of coins) {
    const coinType = coin.contents?.type?.repr;
    const balance = parseCoinBalance(coin.contents?.json);
    if (!coinType || balance === null || !coin.address || seen.has(coin.address)) continue;
    seen.add(coin.address);
    const inner = getCoinTypeArg(coinType);
    if (blocked.has(normalizeTypeAddress(inner))) continue;
    const rebate = String(coin.storageRebate ?? 0);
    if (!/^[0-9]+$/.test(rebate)) continue;
    const label = inner.includes('::') ? inner.slice(inner.indexOf('::') + 2) : inner;
    if (balance === 0n) {
      if (isSameMoveType(inner, '0x2::sui::SUI')) continue;
      const values = quote([rebate], ESTIMATED_GAS.destroyZero);
      if (values.netGainMist < 0) continue;
      actions.push({ kind: 'destroy_zero', coinType, label, objectIds: [coin.address], objectStorageRebates: [rebate], ...values });
      continue;
    }
    // package padding is cosmetic; module and struct case identify different assets.
    const key = normalizeStructTag(coinType);
    const group = groups.get(key) ?? { coinType, ids: [], balances: [], rebates: [] };
    group.ids.push(coin.address);
    group.balances.push(String(balance));
    group.rebates.push(rebate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { coinType } = group;
    const inner = getCoinTypeArg(coinType);
    const label = inner.includes('::') ? inner.slice(inner.indexOf('::') + 2) : inner;
    const tokenMetadata = isSameMoveType(inner, '0x2::sui::SUI')
      ? { tokenSymbol: 'SUI', tokenDecimals: 9 } : metadata.get(coinType) ?? {};
    for (let start = 0; start < group.ids.length; start += 50) {
      const objectIds = group.ids.slice(start, start + 50);
      const objectStorageRebates = group.rebates.slice(start, start + 50);
      actions.push({ kind: 'keep_tokens', coinType, label, ...tokenMetadata, objectIds,
        objectBalances: group.balances.slice(start, start + 50), objectStorageRebates,
        ...quote(objectStorageRebates, ESTIMATED_GAS.keepTokens) });
    }
    if (group.ids.length >= 2) {
      const objectIds = group.ids.slice(0, MAX_MERGES_PER_BATCH);
      const objectStorageRebates = group.rebates.slice(0, objectIds.length);
      const values = quote(objectStorageRebates.slice(1), ESTIMATED_GAS.mergeCoins);
      if (values.netGainMist >= 0) actions.push({ kind: 'merge_coins', coinType, label,
        ...tokenMetadata, objectIds, objectStorageRebates,
        objectBalances: group.balances.slice(0, objectIds.length), ...values });
    }
  }
  return actions;
}

export function totalUniqueUserRebateMist(actions: CleanupAction[]): number {
  // keep consumes every coin, so its quote subsumes the alternate merge quote.
  const keptIds = new Set(actions.filter(a => a.kind === 'keep_tokens').flatMap(a => a.objectIds));
  return actions.reduce((sum, action) => {
    if (action.kind !== 'merge_coins') return sum + action.userRebateMist;
    const rebates = action.objectStorageRebates;
    if (!rebates) return sum + (action.objectIds.some(id => keptIds.has(id)) ? 0 : action.userRebateMist);
    const extra = action.objectIds.slice(1).reduce((total, id, i) => total + (keptIds.has(id) ? 0 : Number(rebates[i + 1])), 0);
    return sum + Math.floor(extra * REBATE_MULTIPLIER);
  }, 0);
}

export function totalNonOverlappingNetGainMist(actions: CleanupAction[]): number {
  const keptIds = new Set(actions.filter(action => action.kind === 'keep_tokens').flatMap(action => action.objectIds));
  return actions.reduce((sum, action) => {
    if (action.kind === 'merge_coins' && action.objectIds.some(id => keptIds.has(id))) return sum;
    return sum + action.netGainMist;
  }, 0);
}
