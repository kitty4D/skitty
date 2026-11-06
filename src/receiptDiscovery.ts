import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { bcs } from '@mysten/sui/bcs';
import { isValidStructTag, normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils';
import type { CleanupActionBase } from './types';
import { ESTIMATED_GAS, FEE_RATE } from './constants';

export interface ReceiptAction extends CleanupActionBase {
  kind: 'expired_walrus' | 'revoke_allowance';
  objectType: string;
  moveTarget: string;
  typeArguments: string[];
  callObjectIds: string[];
  details: string[];
}

// original ids identify types; published ids identify callable implementations.
// verified against mainnet graphql on 2026-11-06; published.toml still lists v3.
// https://github.com/MystenLabs/walrus/blob/mainnet/mainnet-contracts/walrus/Published.toml
// https://github.com/MystenLabs/walrus/blob/mainnet/contracts/walrus/sources/system/blob.move
const WALRUS_ORIGINAL = '0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77';
const WALRUS_LATEST = '0xa9ac4281c72b0ed3277c08e821ab77eccea7b187f2b402ffa3b33f548d4bbf1e';
const WALRUS_SYSTEM = '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2';
const BLOB_TYPE = `${WALRUS_ORIGINAL}::blob::Blob`;
const CAP_PREFIX = `${normalizeSuiAddress('0x2')}::allowance::AllowanceCap`;
type RecordValue = Record<string, unknown>;
type Node = { address?: string; storageRebate?: unknown; owner?: {
  __typename?: string; address?: { address?: string };
}; contents?: { type?: { repr?: string }; json?: unknown } };

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function id(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{1,64}$/.test(value)) return null;
  return normalizeSuiAddress(value);
}

function uint(value: unknown, bits = 64): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 78) return null;
  const result = BigInt(value);
  return result < (1n << BigInt(bits)) ? result : null;
}

function canonical(type: string): string | null {
  try {
    if (!/^0x[\da-fA-F]{1,64}::[A-Za-z_][\w]*::[A-Za-z_][\w]*(?:<.*>)?$/.test(type)) return null;
    let depth = 0;
    for (const character of type) {
      if (character === '<') depth++;
      if (character === '>' && --depth < 0) return null;
    }
    if (depth !== 0 || !isValidStructTag(type)) return null;
    return normalizeStructTag(type);
  } catch { return null; }
}

function receiptType(type: string): { kind: ReceiptAction['kind']; args: string[] } | null {
  const normalized = canonical(type);
  if (normalized === BLOB_TYPE) return { kind: 'expired_walrus', args: [] };
  if (!normalized?.startsWith(`${CAP_PREFIX}<`)) return null;
  try {
    const tag = parseStructTag(normalized);
    if (tag.typeParams.length !== 1) return null;
    const arg = tag.typeParams[0];
    return { kind: 'revoke_allowance', args: [typeof arg === 'string' ? arg : normalizeStructTag(arg)] };
  } catch { return null; }
}

// use this before generic burn discovery, including for live or malformed receipts.
export function isReceiptType(type: string): boolean {
  return receiptType(type) !== null;
}

async function query(client: SuiGraphQLClient, text: string, variables: Record<string, unknown>): Promise<RecordValue> {
  const result = await client.query({ query: text, variables, signal: AbortSignal.timeout(20_000) });
  if (result.errors?.length || !result.data) throw new Error('graphql returned errors or missing data');
  return record(result.data);
}

async function walrusEpoch(client: SuiGraphQLClient): Promise<bigint> {
  const data = await query(client, `query ReceiptWalrusSystem($id:SuiAddress!) {
    object(address:$id) { asMoveObject { contents { type { repr } json } } }
  }`, { id: WALRUS_SYSTEM });
  const contents = record(record(record(data.object).asMoveObject).contents);
  const system = record(contents.json);
  const version = uint(system.version);
  if (canonical(String(record(contents.type).repr)) !== `${WALRUS_ORIGINAL}::system::System` ||
    id(system.package_id) !== WALRUS_LATEST || version !== 4n) {
    throw new Error('unverified Walrus system package or version');
  }
  // the version-keyed inner committee is Walrus time. sui epoch is irrelevant.
  const inner = await query(client, `query ReceiptWalrusEpoch($id:SuiAddress!, $name:DynamicFieldName!) {
    address(address:$id) { dynamicField(name:$name) { value {
      ... on MoveValue { type { repr } json }
    } } }
  }`, { id: WALRUS_SYSTEM, name: { type: 'u64', bcs: bcs.u64().serialize(String(version)).toBase64() } });
  const value = record(record(record(inner.address).dynamicField).value);
  const epoch = uint(record(record(value.json).committee).epoch, 32);
  if (canonical(String(record(value.type).repr)) !== `${WALRUS_ORIGINAL}::system_state_inner::SystemStateInnerV1` || epoch === null) {
    throw new Error('missing verified Walrus committee epoch');
  }
  return epoch;
}

function quote(rebates: bigint[]) {
  const total = rebates.reduce((sum, value) => sum + value, 0n);
  // base display fields are numbers, so refuse quotes they cannot represent safely.
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('storage rebate exceeds safe display range');
  const userRebateMist = Number(total * 99n / 100n);
  const estimatedGasMist = ESTIMATED_GAS.burn;
  return { objectStorageRebates: rebates.map(String), storageRebateTotal: String(total), userRebateMist,
    estimatedGasMist, netGainMist: userRebateMist - estimatedGasMist - Math.floor(Number(total) * FEE_RATE) };
}

// graphql represents Move options as null or their unwrapped value.
function optionUint(value: unknown, bits: number): string {
  if (value === null) return 'none';
  const parsed = uint(value, bits);
  if (parsed === null) throw new Error('malformed allowance limit or timestamp');
  return String(parsed);
}

function timestampLabel(value: string): string {
  if (value === 'none') return 'none';
  const timestamp = BigInt(value);
  if (timestamp > 8_640_000_000_000_000n) return `${value} (outside supported date range)`;
  return `${new Date(Number(timestamp)).toISOString()} (${value} ms)`;
}

function allowanceDetails(json: RecordValue, owner: string, asset: string): string[] {
  const settings = record(json.settings);
  const funder = id(settings.funder);
  const spender = settings.spender === null ? 'none' : id(settings.spender);
  if (funder !== id(owner) || !spender) throw new Error('allowance funder or spender mismatch');
  const app = settings.app === null ? 'none' : record(settings.app).name;
  if (typeof app !== 'string' || typeof settings.name !== 'string') throw new Error('malformed allowance app or name');
  const spend = uint(json.current_spend, 256);
  if (spend === null) throw new Error('malformed allowance cumulative spend');
  const lifetime = optionUint(settings.lifetime_cap, 256);
  const start = optionUint(settings.start_timestamp_ms, 64);
  const expiry = optionUint(settings.expiration_timestamp_ms, 64);
  let rate = 'none';
  if (settings.rate_limit !== null) {
    const limit = record(settings.rate_limit);
    if (limit['$variant'] !== 'Windowed') throw new Error('unsupported allowance rate limit');
    const window = record(limit.window);
    const variant = window['$variant'];
    const period = uint(window.pos0, variant === 'CalendarMonths' ? 8 : 64);
    if ((variant !== 'PeriodicMs' && variant !== 'CalendarMonths') || period === null || period === 0n) {
      throw new Error('malformed allowance rate window');
    }
    rate = `${optionUint(limit.limit, 256)} per ${period} ${variant === 'PeriodicMs' ? 'ms' : 'calendar months'}, spent ${optionUint(limit.spent, 256)}, anchor ms ${optionUint(limit.anchor_ms, 64)}, index ${optionUint(limit.index, 64)}`;
  }
  const now = BigInt(Date.now());
  const status = expiry !== 'none' && BigInt(expiry) <= now ? 'expired' :
    start !== 'none' && BigInt(start) > now ? 'not started' : 'active';
  return [`asset/type: ${asset}`, `funder: ${funder}`, `spender: ${spender}`, `app: ${app}`, `name: ${settings.name}`,
    `lifetime cap (raw units): ${lifetime}`, `current spend (raw units): ${spend}`, `rate limit (raw units): ${rate}`,
    `start (inclusive): ${timestampLabel(start)}`, `expiry (exclusive): ${timestampLabel(expiry)}`,
    `time status: ${status} (based on this device's clock; spending limits may also apply)`,
    'revoking permanently removes this spending permission and deletes the cap and shared allowance; funds stay with the funder'];
}

export async function discoverReceipts(client: SuiGraphQLClient, address: string, onPage?: () => void): Promise<{ actions: ReceiptAction[]; warnings: string[] }> {
  const actions: ReceiptAction[] = [];
  const warnings: string[] = [];
  if (!id(address)) return { actions, warnings: ['receipt discovery: invalid owner address'] };
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let epoch: Promise<bigint> | undefined;
  try {
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error('receipt pagination limit reached');
      const data = await query(client, `query ReceiptOwnedObjects($owner:SuiAddress!, $after:String) {
        address(address:$owner) { objects(first:50,after:$after) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on MoveObject { address storageRebate
            owner { __typename ... on AddressOwner { address { address } } }
            contents { type { repr } json }
          } }
        } }
      }`, { owner: address, after });
      const connection = record(record(data.address).objects);
      const info = record(connection.pageInfo);
      if (!Array.isArray(connection.nodes) || typeof info.hasNextPage !== 'boolean') throw new Error('missing receipt page');
      onPage?.();
      for (const node of connection.nodes as Node[]) {
        const objectType = node?.contents?.type?.repr;
        const type = objectType ? receiptType(objectType) : null;
        if (!type || !objectType) continue;
        try {
          const objectId = id(node.address);
          if (!objectId) throw new Error('invalid receipt object id');
          if (seen.has(objectId)) continue;
          seen.add(objectId);
          if (node.owner?.__typename !== 'AddressOwner' || id(node.owner.address?.address) !== id(address)) throw new Error('receipt is not address-owned by the scanned account');
          const rebate = uint(node.storageRebate);
          if (rebate === null) throw new Error('missing or malformed receipt storage rebate');
          const json = record(node.contents?.json);
          if (type.kind === 'expired_walrus') {
            const end = uint(record(json.storage).end_epoch, 32);
            if (end === null) throw new Error('missing or malformed Walrus end epoch');
            epoch ??= walrusEpoch(client);
            const current = await epoch;
            if (end > current) continue;
            actions.push({ kind: type.kind, objectType, moveTarget: `${WALRUS_LATEST}::blob::burn`,
              typeArguments: [], callObjectIds: [node.address!], objectIds: [node.address!], ...quote([rebate]),
              label: 'expired Walrus blob receipt', details: [`Walrus end epoch: ${end}`, `Walrus committee epoch: ${current}`,
                'burn permanently destroys the owned blob receipt, its storage resource and any Walrus metadata',
                'expiry was checked against Walrus time; the burn function itself does not enforce expiry'] });
          } else {
            // live mainnet layout uses allowance, not the unverified allowance_id spelling.
            // https://github.com/MystenLabs/sui/blob/mainnet/crates/sui-framework/packages/sui-framework/sources/allowance.move
            const allowanceId = id(json.allowance);
            if (!allowanceId || allowanceId === objectId) throw new Error('missing or malformed cap allowance link');
            const data = await query(client, `query ReceiptAllowance($id:SuiAddress!) {
              object(address:$id) { address storageRebate owner { __typename }
                asMoveObject { contents { type { repr } json } }
              }
            }`, { id: allowanceId });
            const shared = record(data.object);
            const contents = record(record(shared.asMoveObject).contents);
            const sharedRebate = uint(shared.storageRebate);
            const expected = canonical(`0x2::allowance::Allowance<${type.args[0]}>`);
            if (id(shared.address) !== allowanceId || record(shared.owner).__typename !== 'Shared' ||
              canonical(String(record(contents.type).repr)) !== expected || sharedRebate === null) {
              throw new Error('allowance object, shared owner, type or rebate mismatch');
            }
            const details = allowanceDetails(record(contents.json), address, type.args[0]);
            actions.push({ kind: type.kind, objectType, moveTarget: '0x2::allowance::revoke',
              typeArguments: type.args, callObjectIds: [node.address!, allowanceId], objectIds: [node.address!, allowanceId],
              ...quote([rebate, sharedRebate]), label: 'revoke native allowance', details });
          }
        } catch (error) {
          warnings.push(`receipt ${node.address ?? 'unknown'} skipped: ${error instanceof Error ? error.message : 'verification failed'}`);
        }
      }
      if (!info.hasNextPage) break;
      if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) throw new Error('incomplete or repeated receipt cursor');
      cursors.add(info.endCursor);
      after = info.endCursor;
    }
  } catch (error) {
    warnings.push(`receipt discovery incomplete: ${error instanceof Error ? error.message : 'query failed'}`);
  }
  return { actions, warnings };
}
