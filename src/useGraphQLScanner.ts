import * as React from 'react';
import { graphQLClient } from './graphql/client';
import {
  REBATE_MULTIPLIER,
  ESTIMATED_GAS,
  MAX_MERGES_PER_BATCH,
  isProtectedType,
  isSameMoveType,
  normalizeTypeAddress,
} from './constants';
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
import { KNOWN_BURNABLE, SUI_COIN_TYPE_ARG, SUI_COIN_TYPE_ARG_LONG } from './constants';
import {
  getCoinTypeArg,
  getWalletCoinBlocklist,
  getWalletObjectBlocklist,
  isObjectTypeBlockedIn,
} from './walletBlocklist';
import { actionKey } from './actionIdentity';

const COIN_TYPE_PREFIX = '0x2::coin::coin<';

// The SDK resolves GraphQL errors rather than throwing, so a rate-limited or failed
// query arrives as { data: undefined, errors: [...] } and reads as "nothing found".
// Every query goes through here so a failure becomes a scan error, not an empty vault.
async function runQuery(options: {
  query: string;
  variables: Record<string, unknown>;
}): Promise<{ data: unknown }> {
  const { data, errors } = await graphQLClient.query(options);
  if (errors?.length) {
    throw new Error(`Sui GraphQL error: ${errors[0]!.message}`);
  }
  if (data == null) throw new Error('Sui GraphQL returned no data.');
  return { data };
}
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

  // bumped whenever a scan starts or the address changes, so a slow scan that has
  // been superseded cannot write its results over the newer address's state
  const scanEpochRef = React.useRef(0);

  const scan = React.useCallback(async () => {
    if (!address) {
      setState(prev => ({ ...prev, error: 'No address provided', loading: false }));
      return;
    }

    const epoch = ++scanEpochRef.current;
    const isStale = () => scanEpochRef.current !== epoch;

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
        if (isStale()) return;
        setState(prev => ({ ...prev, scanProgress: progress }));
      };

      updateProgress({ phase: 'fetching coins', current: 0, total: 1 });
      const coinResults = await findCoinActionsByGraphQL(address, updateProgress);

      updateProgress({ phase: 'fetching kiosks', current: 0, total: 1 });
      const kioskResult = await findEmptyKiosksByGraphQL(address, updateProgress);

      updateProgress({ phase: 'fetching NFTs', current: 0, total: 1 });
      const burnableResult = await findBurnableObjects(address, updateProgress);

      if (isStale()) return;

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
      if (isStale()) return;
      setState(prev => ({
        ...prev,
        loading: false,
        scanProgress: null,
        actions: [],
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [address]);

  const refreshAfterExecute = React.useCallback(async (executedActions: CleanupAction[]) => {
    if (executedActions.length === 0) return;
    const allIds = [...new Set(executedActions.flatMap((a) => a.objectIds))];
    if (allIds.length === 0) return;
    try {
      const { objects } = await graphQLClient.getObjects({ objectIds: allIds });
      const existingIds = new Set<string>();
      objects.forEach((obj, i) => {
        // a deleted object comes back as an Error entry rather than throwing
        if (!(obj instanceof Error) && obj?.objectId && allIds[i]) existingIds.add(allIds[i]);
      });
      const keysToRemove = new Set<string>();
      for (const a of executedActions) {
        const remaining = a.objectIds.filter((id) => existingIds.has(id));
        // a merge keeps its primary coin alive by design, so "every id gone" never
        // holds for it - an action is spent once it can no longer be performed
        const spent = a.kind === 'merge_coins' ? remaining.length <= 1 : remaining.length === 0;
        if (spent) keysToRemove.add(actionKey(a));
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
    } catch {
      // refresh after execute failed; state unchanged
    }
  }, []);

  React.useEffect(() => {
    // abandon any in-flight scan for the previous address
    scanEpochRef.current += 1;
    setState(prev => ({
      ...prev,
      loading: false,
      scanProgress: null,
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

  {
    let pageCount = 0;
    while (true) {
      const variables: { owner: string; after?: string } = { owner: address };
      if (after != null) variables.after = after;

      const { data } = await runQuery({
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
      const connection = (data as { address?: { objects?: { nodes?: CoinNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } })?.address?.objects;
      const nodes = connection?.nodes ?? [];
      coins.push(...nodes);
      pageCount += 1;
      updateProgress({ phase: 'fetching coins', current: pageCount, total: pageCount + 1 });

      // a connection may legally return fewer than `first` nodes and still have more
      // pages, so drive the loop off hasNextPage rather than the node count
      const endCursor = connection?.pageInfo?.endCursor ?? null;
      if (!connection?.pageInfo?.hasNextPage || !endCursor) break;
      after = endCursor;
    }
    updateProgress({ phase: 'analyzing coins', current: 0, total: coins.length });

    const coinsByType = new Map<string, { objectIds: string[]; balances: string[]; rebates: string[]; storageRebateTotal: number }>();
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
        const group = coinsByType.get(coinType) ?? { objectIds: [], balances: [], rebates: [], storageRebateTotal: 0 };
        group.objectIds.push(coin.address);
        group.balances.push(String(balance));
        group.rebates.push(String(storageRebate));
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
      if (typeArg === SUI_COIN_TYPE_ARG || typeArg === SUI_COIN_TYPE_ARG_LONG) continue;
      // merging N coins destroys N-1: the first coin survives as the merge target and
      // its rebate is never reclaimed, and anything past MAX_MERGES_PER_BATCH is left
      // for a later run. Quoting the full sum would overstate what the user gets back
      // and, in sponsored mode, overdraw the sponsor.
      const mergedIds = group.objectIds.slice(0, MAX_MERGES_PER_BATCH);
      const realizedRebate = group.rebates
        .slice(1, mergedIds.length)
        .reduce((sum, r) => sum + Number(r), 0);
      const userRebateMist = Math.floor(realizedRebate * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(realizedRebate);
      if (userRebateMist < estMerge + feeMist) continue;
      const label = typeArg.indexOf('::') !== -1 ? typeArg.slice(typeArg.indexOf('::') + 2) : typeArg;
      mergeActions.push({
        kind: 'merge_coins',
        coinType,
        label,
        objectIds: mergedIds,
        objectBalances: group.balances.slice(0, mergedIds.length),
        objectStorageRebates: group.rebates.slice(0, mergedIds.length),
        storageRebateTotal: String(realizedRebate),
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
      if (typeArg === SUI_COIN_TYPE_ARG || typeArg === SUI_COIN_TYPE_ARG_LONG) continue;
      const userRebateMist = Math.floor(z.storageRebate * REBATE_MULTIPLIER);
      const feeMist = computeFeeMist(z.storageRebate);
      if (userRebateMist < estZero + feeMist) continue;
      const label = typeArg.indexOf('::') !== -1 ? typeArg.slice(typeArg.indexOf('::') + 2) : typeArg;
      destroyZeroActions.push({
        kind: 'destroy_zero',
        coinType: z.coinType,
        objectIds: [z.address],
        objectStorageRebates: [String(z.storageRebate)],
        storageRebateTotal: String(z.storageRebate),
        userRebateMist,
        estimatedGasMist: estZero,
        netGainMist: userRebateMist - estZero - feeMist,
        label,
      });
    }

    return [...mergeActions, ...destroyZeroActions];
  }
}

// find empty kiosks via GraphQL; only suggest "close kiosk" when we have an owned KioskOwnerCap whose "for" = kiosk id (never suggest closing one we don't own the cap for)
async function findEmptyKiosksByGraphQL(
  address: string,
  updateProgress: (progress: ScanProgress) => void
): Promise<CloseKioskAction[]> {
  updateProgress({ phase: 'fetching kiosk caps', current: 0, total: 1 });

  type KioskCapNode = { address: string; storageRebate?: string | number; contents?: { json?: { for?: string } } };
  type AddressObjects = {
    address?: { objects?: { nodes?: KioskCapNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
  };

  const PAGE_SIZE = 50;
  const kioskCaps: KioskCapNode[] = [];
  let after: string | null = null;

  // paginate: a wallet with more than one page of caps would otherwise have the rest
  // of its closeable kiosks silently ignored
  while (true) {
    const variables: { owner: string; after?: string } = { owner: address };
    if (after != null) variables.after = after;

    const { data: capsData } = await runQuery({
      query: `
        query GetKioskOwnerCaps($owner: SuiAddress!, $after: String) {
          address(address: $owner) {
            objects(
              filter: { type: "0x2::kiosk::KioskOwnerCap" }
              first: ${PAGE_SIZE}, after: $after
            ) {
              pageInfo { hasNextPage endCursor }
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
      variables,
    });

    const connection = (capsData as AddressObjects)?.address?.objects;
    kioskCaps.push(...(connection?.nodes ?? []));
    const endCursor = connection?.pageInfo?.endCursor ?? null;
    if (!connection?.pageInfo?.hasNextPage || !endCursor) break;
    after = endCursor;
  }

  updateProgress({ phase: 'checking kiosks', current: 0, total: kioskCaps.length });
  const est = ESTIMATED_GAS.closeKiosk;
  const closeActions: CloseKioskAction[] = [];
  const objectBlocklist = await getWalletObjectBlocklist();
  if (isObjectTypeBlockedIn(objectBlocklist, KIOSK_TYPE)) return closeActions;
  let current = 0;

  for (const cap of kioskCaps) {
    current++;
    updateProgress({ phase: 'checking kiosks', current, total: kioskCaps.length });
    const json = cap.contents?.json;
    const kioskId = json?.for ?? null;
    if (!kioskId) continue;
    const kiosk = await inspectKiosk(kioskId);
    if (!kiosk || !kiosk.empty) continue;
    // closing deletes BOTH the kiosk and its owner cap, so both rebates come back
    const capRebate = Number(cap.storageRebate ?? 0);
    const storageRebateTotal = capRebate + kiosk.storageRebateMist;
    const userRebateMist = Math.floor(storageRebateTotal * REBATE_MULTIPLIER);
    const feeMist = computeFeeMist(storageRebateTotal);
    if (userRebateMist < est + feeMist) continue;
    closeActions.push({
      kind: 'close_kiosk',
      kioskId,
      ownerCapId: cap.address,
      label: kioskId,
      objectIds: [kioskId],
      objectStorageRebates: [String(storageRebateTotal)],
      storageRebateTotal: String(storageRebateTotal),
      profitsMist: kiosk.profitsMist,
      userRebateMist,
      estimatedGasMist: est,
      netGainMist: userRebateMist - est - feeMist,
    });
  }
  return closeActions;
}

/**
 * Read a kiosk's own storage rebate, profits, and item count from the fullnode.
 * `close_and_withdraw` aborts unless item_count is 0, and it pays out `profits`,
 * so both matter before we offer to close it.
 */
async function inspectKiosk(
  kioskId: string
): Promise<{ empty: boolean; storageRebateMist: number; profitsMist: number } | null> {
  try {
    const { data } = await runQuery({
      query: `
        query GetKiosk($id: SuiAddress!) {
          object(address: $id) {
            storageRebate
            asMoveObject { contents { json } }
          }
          address(address: $id) {
            dynamicFields(first: 1) { nodes { name { type { repr } } } }
          }
        }
      `,
      variables: { id: kioskId },
    });
    type KioskObject = {
      object?: {
        storageRebate?: string | number;
        asMoveObject?: { contents?: { json?: Record<string, unknown> } };
      };
      address?: { dynamicFields?: { nodes?: unknown[] } };
    };
    const object = (data as KioskObject)?.object;
    const fields = object?.asMoveObject?.contents?.json;
    if (!fields) return null;
    const itemCount = Number(fields.item_count ?? 0);
    if (!Number.isFinite(itemCount)) return null;
    // item_count only covers items. Kiosk extensions live as dynamic fields on the
    // kiosk's UID and never touch it, and close_and_withdraw deletes the UID outright - // orphaning that extension's storage. Require the kiosk to be empty both ways.
    const dynamicFieldCount = (data as KioskObject)?.address?.dynamicFields?.nodes?.length ?? 0;
    // profits is a Balance<SUI>, which serializes either as a bare u64 string or as { value }
    const profits = fields.profits;
    const profitsMist = Number(
      typeof profits === 'object' && profits !== null
        ? (profits as { value?: string }).value ?? 0
        : profits ?? 0
    );
    return {
      empty: itemCount === 0 && dynamicFieldCount === 0,
      storageRebateMist: Number(object?.storageRebate ?? 0),
      profitsMist: Number.isFinite(profitsMist) ? profitsMist : 0,
    };
  } catch {
    return null;
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

// GraphQL exposes Move functions one at a time (there is no normalized-module call),
// so we look up each candidate burn name directly and cache the answer per module.
type MoveFunction = {
  typeParameters?: unknown[];
  parameters?: OpenSignature[];
};

type OpenSignature = {
  reference?: string | null;
  body?: OpenSignatureBody;
};

type OpenSignatureBody =
  | { $kind: 'datatype'; datatype?: { typeName?: string; typeParameters?: unknown[] } }
  | { $kind: string; [key: string]: unknown };

// the parameter's underlying datatype name, e.g. "0x2::kiosk::Kiosk"
function datatypeNameOf(param: OpenSignature | undefined): string | null {
  const body = param?.body;
  if (!body || body.$kind !== 'datatype') return null;
  const typeName = (body as { datatype?: { typeName?: string } }).datatype?.typeName;
  return typeName ?? null;
}

function isTxContextParam(param: OpenSignature): boolean {
  return datatypeNameOf(param)?.endsWith('::tx_context::TxContext') ?? false;
}

function sameMoveType(a: string, b: string): boolean {
  return normalizeTypeAddress(a) === normalizeTypeAddress(b);
}

// A "burn" is only usable if we can actually call it: buildBatchTransaction emits a
// single object argument and no type arguments, so anything generic or needing extra
// arguments (a registry, a cap, a witness) would just fail at build time. Being strict
// here also shrinks the set of objects we are willing to call destructible at all.
function burnFunctionMatches(fn: MoveFunction, objectType: string): boolean {
  if ((fn.typeParameters?.length ?? 0) > 0) return false;
  const parsed = parseMoveType(objectType);
  // a generic object would need type arguments we never pass
  if (!parsed || parsed.typeArgs?.length) return false;
  const params = (fn.parameters ?? []).filter((p) => !isTxContextParam(p));
  if (params.length !== 1) return false;
  // by-reference means the function borrows the object rather than consuming it, so it
  // cannot be destroying anything - the call would succeed, the object would survive,
  // and we would have charged a fee against a storage rebate that never materialized
  if (params[0].reference != null) return false;
  const only = datatypeNameOf(params[0]);
  if (!only) return false;
  return sameMoveType(only, `${parsed.package}::${parsed.module}::${parsed.name}`);
}

const burnFunctionCache = new Map<string, MoveFunction | null>();

async function getMoveFunctionCached(
  packageId: string,
  moduleName: string,
  name: string
): Promise<MoveFunction | null> {
  const key = `${packageId}::${moduleName}::${name}`;
  const cached = burnFunctionCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await graphQLClient.getMoveFunction({ packageId, moduleName, name });
    const result = (res?.function as MoveFunction) ?? null;
    burnFunctionCache.set(key, result);
    return result;
  } catch {
    // The SDK throws the same way for "no such function" and for a network/rate-limit
    // failure, so this is not cached - caching a transient failure would permanently
    // mark a real burn entry point as nonexistent for the rest of the session.
    return null;
  }
}

async function findBurnFunction(objectType: string): Promise<string | null> {
  const parsed = parseMoveType(objectType);
  if (!parsed) return null;
  for (const name of BURN_FUNCTION_NAMES) {
    const fn = await getMoveFunctionCached(parsed.package, parsed.module, name);
    if (fn && burnFunctionMatches(fn, objectType)) return name;
  }
  return null;
}

// find burnable objects: page through owned objects, group by type, look for a burn entry point
async function findBurnableObjects(
  address: string,
  updateProgress: (progress: ScanProgress) => void
): Promise<BurnAction[]> {
  updateProgress({ phase: 'fetching NFTs', current: 0, total: 1 });

  {
    type OwnedObjectNode = {
      address: string;
      storageRebate?: string | number;
      contents?: { type?: { repr?: string } };
    };
    const PAGE_SIZE = 50;
    const objects: { objectId: string; type: string; storageRebate: number }[] = [];
    let after: string | null = null;
    let pageCount = 0;

    while (true) {
      const variables: { owner: string; after?: string } = { owner: address };
      if (after != null) variables.after = after;

      const { data } = await runQuery({
        query: `
          query GetOwnedObjects($owner: SuiAddress!, $after: String) {
            address(address: $owner) {
              objects(first: ${PAGE_SIZE}, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on MoveObject {
                    address
                    storageRebate
                    contents { type { repr } }
                  }
                }
              }
            }
          }
        `,
        variables,
      });

      const connection = (
        data as {
          address?: {
            objects?: {
              nodes?: OwnedObjectNode[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          };
        }
      )?.address?.objects;
      for (const node of connection?.nodes ?? []) {
        const type = node.contents?.type?.repr;
        if (!type || !node.address) continue;
        objects.push({
          objectId: node.address,
          type,
          storageRebate: Number(node.storageRebate ?? 0),
        });
      }
      pageCount += 1;
      updateProgress({ phase: 'fetching NFTs', current: pageCount, total: pageCount + 1 });

      const endCursor = connection?.pageInfo?.endCursor ?? null;
      if (!connection?.pageInfo?.hasNextPage || !endCursor) break;
      after = endCursor;
    }

    const byType = new Map<string, typeof objects>();
    for (const obj of objects) {
      const type = obj.type;
      // the node reports padded addresses, so this has to be a normalized comparison
      if (
        normalizeTypeAddress(type).startsWith(COIN_TYPE_PREFIX) ||
        isSameMoveType(type, KIOSK_TYPE) ||
        isSameMoveType(type, KIOSK_OWNER_CAP_TYPE)
      )
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
      if (isObjectTypeBlockedIn(objectBlocklist, objectType)) continue;
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
        const fnName = parsed ? await findBurnFunction(objectType) : null;
        if (parsed && fnName) {
          moveTarget = `${parsed.package}::${parsed.module}::${fnName}`;
          discovered = true;
        }
      }

      if (!moveTarget) continue;
      const objectIds = list.map((o) => o.objectId);
      const objectStorageRebates = list.map((o) => String(Number(o.storageRebate ?? 0)));
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
        objectStorageRebates,
        storageRebateTotal: String(storageRebateTotal),
        userRebateMist,
        estimatedGasMist: gasEst,
        netGainMist: userRebateMist - gasEst - feeMist,
        label: shortType,
      });
    }
    return burnActions;
  }
}
