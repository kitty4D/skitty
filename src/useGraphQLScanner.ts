import * as React from 'react';
import { graphQLClient } from './graphql/client';
import { rpcClient } from './rpcClient';
import { REBATE_MULTIPLIER, ESTIMATED_GAS, isProtectedType } from './constants';
import { computeFeeMist } from './buildCleanupTransaction';
import type {
  CleanupAction,
  MergeCoinsAction,
  DestroyZeroAction,
  CloseKioskAction,
  BurnAction,
  ScannerState,
  ScanProgress,
} from './types';
import { KNOWN_BURNABLE } from './constants';
import { getCoinTypeArg, getWalletCoinBlocklist, getWalletObjectBlocklist } from './walletBlocklist';
import type { SuiMoveNormalizedModule, SuiObjectData } from '@mysten/sui/jsonRpc';

const COIN_TYPE_PREFIX = '0x2::coin::Coin<';
const KIOSK_TYPE = '0x2::kiosk::Kiosk';
const KIOSK_OWNER_CAP_TYPE = '0x2::kiosk::KioskOwnerCap';
const BURN_FUNCTION_NAMES = ['burn', 'delete', 'destroy'];

// scanner hook: GraphQL API finds reclaimable SUI objects; returns state (loading, error, actions, totalUserRebateMist, scannedAddress, scanProgress)
export function useGraphQLScanner(address: string | null) {
  const [state, setState] = React.useState<ScannerState>({
    loading: false,
    error: null,
    actions: [],
    totalUserRebateMist: 0,
    scannedAddress: null,
    scanProgress: null,
  });

  const scan = React.useCallback(async () => {
    if (!address) {
      setState(prev => ({ ...prev, error: 'No address provided', loading: false }));
      return;
    }

    setState(prev => ({
      ...prev,
      loading: true,
      scanProgress: { phase: 'starting', current: 0, total: 1 },
      error: null,
      actions: [],
      scannedAddress: address,
    }));

    try {
      const updateProgress = (progress: ScanProgress) => {
        setState(prev => ({ ...prev, scanProgress: progress }));
      };

      updateProgress({ phase: 'fetching coins', current: 0, total: 1 });
      const coinResults = await findCoinActionsByGraphQL(address, updateProgress);

      updateProgress({ phase: 'fetching kiosks', current: 0, total: 1 });
      const kioskResult = await findEmptyKiosksByGraphQL(address, updateProgress);

      updateProgress({ phase: 'fetching NFTs', current: 0, total: 1 });
      const burnableResult = await findBurnableObjectsByRPC(address, updateProgress);

      const actions: CleanupAction[] = [
        ...coinResults,
        ...kioskResult,
        ...burnableResult,
      ];
      const totalUserRebateMist = actions.reduce((s, a) => s + a.userRebateMist, 0);

      setState(prev => ({
        ...prev,
        loading: false,
        scanProgress: null,
        actions,
        totalUserRebateMist,
        scannedAddress: address,
      }));
    } catch (error) {
      console.error('Scan error:', error);
      setState(prev => ({
        ...prev,
        loading: false,
        scanProgress: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [address]);

  const refreshAfterExecute = React.useCallback(async (executedActions: CleanupAction[]) => {
    if (executedActions.length === 0) return;
    const allIds = [...new Set(executedActions.flatMap((a) => a.objectIds))];
    if (allIds.length === 0) return;
    try {
      const responses = await rpcClient.multiGetObjects({
        ids: allIds,
        options: {},
      });
      const existingIds = new Set<string>();
      responses.forEach((res, i) => {
        if (res.data && allIds[i]) existingIds.add(allIds[i]);
      });
      const actionKey = (a: CleanupAction) =>
        `${a.kind}:${a.objectIds.slice().sort().join(',')}`;
      const keysToRemove = new Set<string>();
      for (const a of executedActions) {
        const allGone = a.objectIds.every((id) => !existingIds.has(id));
        if (allGone) keysToRemove.add(actionKey(a));
      }
      if (keysToRemove.size === 0) return;
      setState((prev) => {
        const nextActions = prev.actions.filter((a) => !keysToRemove.has(actionKey(a)));
        const totalUserRebateMist = nextActions.reduce((s, x) => s + x.userRebateMist, 0);
        return {
          ...prev,
          actions: nextActions,
          totalUserRebateMist,
        };
      });
    } catch (err) {
      console.error('Refresh after execute failed:', err);
    }
  }, []);

  React.useEffect(() => {
    setState(prev => ({
      ...prev,
      error: null,
      actions: [],
      totalUserRebateMist: 0,
      scannedAddress: null,
    }));
  }, [address]);

  return { state, scan, refreshAfterExecute };
}

// get coin balance from GraphQL contents.json (balance string or { value: string }); return 0n only when explicitly 0, else 1n so we don't destroy coins by mistake
function getCoinBalanceFromJson(json: unknown): bigint {
  if (json == null || typeof json !== 'object') return 1n;
  const balance = (json as Record<string, unknown>)['balance'];
  if (balance === undefined || balance === null) return 1n;
  let value: string | undefined;
  if (typeof balance === 'object' && balance !== null && 'value' in balance) {
    value = (balance as { value?: string }).value;
  } else if (typeof balance === 'string') {
    value = balance;
  } else {
    return 1n;
  }
  if (value === undefined || value === null) return 1n;
  try {
    return BigInt(value);
  } catch {
    return 1n;
  }
}

// find mergeable coins and zero-balance (destroy_zero) via GraphQL; returns both as CleanupAction[]
async function findCoinActionsByGraphQL(
  address: string,
  updateProgress: (progress: ScanProgress) => void
): Promise<CleanupAction[]> {
  updateProgress({ phase: 'fetching coins', current: 0, total: 1 });

  const PAGE_SIZE = 50;
  type CoinNode = {
    address: string;
    storageRebate?: string | number;
    contents?: { type?: { repr?: string }; json?: unknown };
  };
  const coins: CoinNode[] = [];
  let after: string | null = null;

  try {
    let pageCount = 0;
    while (true) {
      const variables: { owner: string; after?: string } = { owner: address };
      if (after != null) variables.after = after;

      const { data } = await graphQLClient.query({
        query: `
          query GetOwnedCoins($owner: SuiAddress!, $after: String) {
            address(address: $owner) {
              objects(filter: { type: "0x2::coin::Coin" } first: ${PAGE_SIZE}, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on MoveObject {
                    address
                    storageRebate
                    contents { type { repr } json }
                  }
                }
              }
            }
          }
        `,
        variables,
      });
      const connection = (data as { address?: { objects?: { nodes?: CoinNode[]; pageInfo?: { endCursor?: string } } } })?.address?.objects;
      const nodes = connection?.nodes ?? [];
      coins.push(...nodes);
      pageCount += 1;
      updateProgress({ phase: 'fetching coins', current: pageCount, total: pageCount + 1 });

      const endCursor = connection?.pageInfo?.endCursor ?? null;
      if (nodes.length < PAGE_SIZE || !endCursor) break;
      after = endCursor;
    }
    updateProgress({ phase: 'analyzing coins', current: 0, total: coins.length });

    const coinsByType = new Map<string, { objectIds: string[]; balances: string[]; storageRebateTotal: number }>();
    const zeroBalanceCoins: { address: string; coinType: string; storageRebate: number }[] = [];
    let current = 0;

    for (const coin of coins) {
      current++;
      if (current % 10 === 0) {
        updateProgress({ phase: 'analyzing coins', current, total: coins.length });
      }
      const coinType = coin.contents?.type?.repr;
      if (!coinType) continue;
      const storageRebate = Number(coin.storageRebate ?? 0);
      const balance = getCoinBalanceFromJson(coin.contents?.json);
      if (balance === 0n) {
        zeroBalanceCoins.push({ address: coin.address, coinType, storageRebate });
      } else {
        const group = coinsByType.get(coinType) ?? { objectIds: [], balances: [], storageRebateTotal: 0 };
        group.objectIds.push(coin.address);
        group.balances.push(String(balance));
        group.storageRebateTotal += storageRebate;
        coinsByType.set(coinType, group);
      }
    }

    const blocklist = await getWalletCoinBlocklist();

    const mergeActions: MergeCoinsAction[] = [];
    const estMerge = ESTIMATED_GAS.mergeCoins;
    for (const [coinType, group] of coinsByType.entries()) {
      if (group.objectIds.length <= 1) continue;
      const typeArg = getCoinTypeArg(coinType);
      if (blocklist.has(typeArg)) continue;
      const userRebateMist = Math.floor(group.storageRebateTotal * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(group.storageRebateTotal);
      if (userRebateMist < estMerge + feeMist) continue;
      const label = typeArg.indexOf('::') !== -1 ? typeArg.slice(typeArg.indexOf('::') + 2) : typeArg;
      mergeActions.push({
        kind: 'merge_coins',
        coinType,
        label,
        objectIds: group.objectIds,
        objectBalances: group.balances,
        storageRebateTotal: String(group.storageRebateTotal),
        userRebateMist,
        estimatedGasMist: estMerge,
        netGainMist: userRebateMist - estMerge - feeMist,
      });
    }

    const destroyZeroActions: DestroyZeroAction[] = [];
    const estZero = ESTIMATED_GAS.destroyZero;
    for (const z of zeroBalanceCoins) {
      const typeArg = getCoinTypeArg(z.coinType);
      if (blocklist.has(typeArg)) continue;
      const userRebateMist = Math.floor(z.storageRebate * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(z.storageRebate);
      if (userRebateMist < estZero + feeMist) continue;
      const label = typeArg.indexOf('::') !== -1 ? typeArg.slice(typeArg.indexOf('::') + 2) : typeArg;
      destroyZeroActions.push({
        kind: 'destroy_zero',
        coinType: z.coinType,
        objectIds: [z.address],
        storageRebateTotal: String(z.storageRebate),
        userRebateMist,
        estimatedGasMist: estZero,
        netGainMist: userRebateMist - estZero - feeMist,
        label,
      });
    }

    return [...mergeActions, ...destroyZeroActions];
  } catch (error) {
    console.error('Error finding coin actions:', error);
    return [];
  }
}

// find empty kiosks via GraphQL; only suggest "close kiosk" when we have an owned KioskOwnerCap whose "for" = kiosk id (never suggest closing one we don't own the cap for)
async function findEmptyKiosksByGraphQL(
  address: string,
  updateProgress: (progress: ScanProgress) => void
): Promise<CloseKioskAction[]> {
  updateProgress({ phase: 'fetching kiosk caps', current: 0, total: 1 });

  try {
    const { data: capsData } = await graphQLClient.query({
      query: `
        query GetKioskOwnerCaps($owner: SuiAddress!) {
          address(address: $owner) {
            objects(
              filter: { type: "0x2::kiosk::KioskOwnerCap" }
              first: 50
            ) {
              nodes {
                ... on MoveObject {
                  address
                  storageRebate
                  contents {
                    type { repr }
                    json
                  }
                }
              }
            }
          }
        }
      `,
      variables: { owner: address },
    });

    type KioskCapNode = { address: string; storageRebate?: string | number; contents?: { json?: { for?: string } } };
    type AddressObjects = { address?: { objects?: { nodes?: KioskCapNode[] } } };
    const kioskCaps = (capsData as AddressObjects)?.address?.objects?.nodes || [];
    updateProgress({ phase: 'checking kiosks', current: 0, total: kioskCaps.length });
    const est = ESTIMATED_GAS.closeKiosk;
    const closeActions: CloseKioskAction[] = [];
    const objectBlocklist = await getWalletObjectBlocklist();
    if (objectBlocklist.has(KIOSK_TYPE)) return closeActions;
    let current = 0;

    for (const cap of kioskCaps) {
      current++;
      updateProgress({ phase: 'checking kiosks', current, total: kioskCaps.length });
      const json = cap.contents?.json;
      const kioskId = json?.for ?? null;
      if (!kioskId) continue;
      if (!(await isKioskEmptyByGraphQL(kioskId))) continue;
      const storageRebateTotal = Number(cap.storageRebate ?? 0);
      const userRebateMist = Math.floor(storageRebateTotal * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(storageRebateTotal);
      if (userRebateMist < est + feeMist) continue;
      closeActions.push({
        kind: 'close_kiosk',
        kioskId,
        ownerCapId: cap.address,
        label: kioskId,
        objectIds: [kioskId],
        storageRebateTotal: String(storageRebateTotal),
        userRebateMist,
        estimatedGasMist: est,
        netGainMist: userRebateMist - est - feeMist,
      });
    }
    return closeActions;
  } catch (error) {
    console.error('Error finding empty kiosks:', error);
    return [];
  }
}

// check if kiosk is empty via GraphQL
async function isKioskEmptyByGraphQL(kioskId: string): Promise<boolean> {
  try {
    const { data } = await graphQLClient.query({
      query: `
        query GetKioskDynamicFields($id: SuiAddress!) {
          address(address: $id) {
            dynamicFields(first: 1) {
              nodes {
                name { type { repr } }
              }
            }
          }
        }
      `,
      variables: { id: kioskId },
    });
    type AddressDynamicFields = { address?: { dynamicFields?: { nodes?: unknown[] } } };
    const nodes = (data as AddressDynamicFields)?.address?.dynamicFields?.nodes ?? [];
    return nodes.length === 0;
  } catch (error) {
    console.error(`Error checking if kiosk ${kioskId} is empty:`, error);
    return false;
  }
}

// RPC-based burn discovery helpers
function parseMoveType(
  typeStr: string
): { package: string; module: string; name: string; typeArgs?: string[] } | null {
  const match = typeStr.match(/^(0x[a-fA-F0-9]+)::([^:]+)::([^<]+)(?:<(.+)>)?$/);
  if (!match) return null;
  const [, pkg, mod, name, typeArgsStr] = match;
  const typeArgs = typeArgsStr ? typeArgsStr.split(',').map((s) => s.trim()) : undefined;
  return { package: pkg!, module: mod!, name: name!, typeArgs };
}

function getStructFromNormalizedType(t: unknown): { address: string; module: string; name: string } | null {
  if (typeof t !== 'object' || t === null) return null;
  const o = t as Record<string, unknown>;
  if (o.Struct && typeof o.Struct === 'object')
    return (o.Struct as { address: string; module: string; name: string });
  if (o.Reference) return getStructFromNormalizedType(o.Reference);
  if (o.MutableReference) return getStructFromNormalizedType(o.MutableReference);
  return null;
}

function structMatchesObjectType(
  struct: { address: string; module: string; name: string },
  objectType: string
): boolean {
  const parsed = parseMoveType(objectType);
  if (!parsed) return false;
  return (
    struct.address === parsed.package &&
    struct.module === parsed.module &&
    struct.name === parsed.name
  );
}

function findBurnFunction(
  normalizedModule: SuiMoveNormalizedModule,
  objectType: string
): string | null {
  const funcs = normalizedModule?.exposedFunctions ?? {};
  for (const name of BURN_FUNCTION_NAMES) {
    const fn = funcs[name];
    if (!fn) continue;
    const params = fn.parameters;
    if (params.length === 0) continue;
    const firstParam = getStructFromNormalizedType(params[0]);
    if (firstParam && structMatchesObjectType(firstParam, objectType)) return name;
  }
  return null;
}

const burnModuleCache = new Map<string, SuiMoveNormalizedModule | null>();
let burnModuleQueue: Array<{ key: string; resolve: (m: SuiMoveNormalizedModule | null) => void }> = [];
let burnModuleTimer: ReturnType<typeof setTimeout> | null = null;
const BURN_MODULE_DEBOUNCE_MS = 100;

async function getBurnModuleCached(
  packageId: string,
  moduleName: string
): Promise<SuiMoveNormalizedModule | null> {
  const key = `${packageId}::${moduleName}`;
  const cached = burnModuleCache.get(key);
  if (cached !== undefined) return cached;
  return new Promise((resolve) => {
    burnModuleQueue.push({ key, resolve });
    if (!burnModuleTimer) {
      burnModuleTimer = setTimeout(async () => {
        burnModuleTimer = null;
        const queue = burnModuleQueue;
        burnModuleQueue = [];
        const keys = [...new Set(queue.map((q) => q.key))];
        const results = new Map<string, SuiMoveNormalizedModule | null>();
        for (const k of keys) {
          if (burnModuleCache.has(k)) {
            results.set(k, burnModuleCache.get(k)!);
            continue;
          }
          const [pkg, mod] = k.split('::');
          try {
            const modResult = await rpcClient.getNormalizedMoveModule({ package: pkg!, module: mod! });
            burnModuleCache.set(k, modResult);
            results.set(k, modResult);
          } catch {
            burnModuleCache.set(k, null);
            results.set(k, null);
          }
        }
        queue.forEach(({ key: qKey, resolve: r }) => r(results.get(qKey) ?? null));
      }, BURN_MODULE_DEBOUNCE_MS);
    }
  });
}

// find burnable objects via RPC: fetch owned objects, group by type, discover burn via getNormalizedMoveModule
async function findBurnableObjectsByRPC(
  address: string,
  updateProgress: (progress: ScanProgress) => void
): Promise<BurnAction[]> {
  updateProgress({ phase: 'fetching NFTs', current: 0, total: 1 });

  try {
    const objects: SuiObjectData[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    while (true) {
      const page = await rpcClient.getOwnedObjects({
        owner: address,
        options: { showType: true, showStorageRebate: true, showContent: true },
        cursor: cursor ?? undefined,
        limit: 50,
      });
      for (const item of page.data) {
        const obj = item.data;
        if (obj?.type) objects.push(obj);
      }
      pageCount += 1;
      updateProgress({ phase: 'fetching NFTs', current: pageCount, total: pageCount + 1 });
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const byType = new Map<string, SuiObjectData[]>();
    for (const obj of objects) {
      const type = obj.type!;
      if (type.startsWith(COIN_TYPE_PREFIX) || type === KIOSK_TYPE || type === KIOSK_OWNER_CAP_TYPE)
        continue;
      if (isProtectedType(type)) continue;
      const list = byType.get(type) ?? [];
      list.push(obj);
      byType.set(type, list);
    }

    const burnActions: BurnAction[] = [];
    const est = ESTIMATED_GAS.burn;
    const types = [...byType.keys()];
    const objectBlocklist = await getWalletObjectBlocklist();
    updateProgress({ phase: 'discovering burn', current: 0, total: types.length });

    for (let i = 0; i < types.length; i++) {
      updateProgress({ phase: 'discovering burn', current: i + 1, total: types.length });
      const objectType = types[i];
      if (objectBlocklist.has(objectType)) continue;
      const list = byType.get(objectType)!;
      let moveTarget: string | null = null;
      let discovered = false;

      const known = KNOWN_BURNABLE.find(
        (e) => objectType.startsWith(e.typePattern) || objectType === e.typePattern
      );
      if (known) {
        moveTarget = known.target;
      } else {
        const parsed = parseMoveType(objectType);
        if (parsed) {
          const mod = await getBurnModuleCached(parsed.package, parsed.module);
          if (mod) {
            const fnName = findBurnFunction(mod, objectType);
            if (fnName) {
              moveTarget = `${parsed.package}::${parsed.module}::${fnName}`;
              discovered = true;
            }
          }
        }
      }

      if (!moveTarget) continue;
      const objectIds = list.map((o) => o.objectId);
      const storageRebateTotal = list.reduce(
        (sum, o) => sum + Number(o.storageRebate ?? 0),
        0
      );
      const userRebateMist = Math.floor(storageRebateTotal * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(storageRebateTotal);
      const gasEst = est * list.length;
      if (userRebateMist < gasEst + feeMist) continue;
      const shortType = objectType.slice(objectType.indexOf('::') + 2) || objectType;
      burnActions.push({
        kind: 'burn',
        objectType,
        moveTarget,
        discovered,
        objectIds,
        storageRebateTotal: String(storageRebateTotal),
        userRebateMist,
        estimatedGasMist: gasEst,
        netGainMist: userRebateMist - gasEst - feeMist,
        label: shortType,
      });
    }
    return burnActions;
  } catch (error) {
    console.error('Error finding burnable objects:', error);
    return [];
  }
}