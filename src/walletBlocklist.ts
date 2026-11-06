import { normalizeTypeAddress } from './constants';
import { normalizeSuiAddress } from '@mysten/sui/utils';

// mysten labs wallet blocklist for coins; @see https://github.com/MystenLabs/wallet_blocklist/blob/main/blocklists/coin-list.json
const COIN_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/main/blocklists/coin-list.json';
// object (NFT/kiosk) blocklist: full Move type strings (e.g. "0x...::module::Type")
const OBJECT_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/refs/heads/main/blocklists/object-list.json';
const PACKAGE_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/main/blocklists/package-list.json';

let cachedCoinBlocklist: Set<string> | null = null;
let cachedObjectBlocklist: Set<string> | null = null;
let cachedPackageBlocklist: Set<string> | null = null;

export function refreshWalletBlocklists() {
  cachedCoinBlocklist = null;
  cachedObjectBlocklist = null;
  cachedPackageBlocklist = null;
}

export interface CoinBlockReason {
  kind: 'coin' | 'package' | 'wallet';
  packageId?: string;
}

// confirmed Slush refusals reported by the user on 2026-11-06. these exact types
// aren't all in Mysten's public lists. a refusal doesn't establish token value or fraud.
const SLUSH_REPORTED_TYPES = new Set([
  '0xf76d5bdd1efad15a858103f9976ef3a0c8177ac90173d9f4ae5c017c137f47ee::tato::TATO',
  '0xd225dee9e2723b38d8162dbdb4c85a9958359d98069865f7527f9e6092c5d980::mmt::MMT',
  '0xce5fae2d360631ef80512ce0c10ac57282a25e01239d30a250040581db5e684f::tato::TATO',
].map(normalizeTypeAddress));

export async function getWalletPackageBlocklist(): Promise<Set<string>> {
  if (cachedPackageBlocklist) return cachedPackageBlocklist;
  try {
    const response = await fetch(PACKAGE_BLOCKLIST_URL, { cache:'no-cache', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('package list unavailable');
    const data: unknown = await response.json();
    const list = (data as CoinListResponse | null)?.blocklist;
    if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string')) {
      throw new Error('invalid package list');
    }
    // the public package feed also contains domain names. only Sui addresses belong
    // in this matcher; never interpret those strings as URLs to fetch.
    const addresses = list.map(entry => entry.trim()).filter(entry => /^0x[\da-fA-F]{1,64}$/.test(entry));
    if (list.length > 0 && addresses.length === 0) throw new Error('no usable package addresses');
    cachedPackageBlocklist = new Set(addresses.map(entry => normalizeSuiAddress(entry)));
    return cachedPackageBlocklist;
  } catch {
    throw new Error('Could not load the Mysten package blocklist. Scanning is paused. Try again shortly.');
  }
}

export function blockedCoinReason(coinType: string, coinTypes: Set<string>, packages: Set<string>): CoinBlockReason | null {
  const tokenType = getCoinTypeArg(coinType);
  if (coinTypes.has(normalizeTypeAddress(tokenType))) return { kind: 'coin' };
  // nested type arguments can reference a blocked package too.
  for (const match of tokenType.matchAll(/0x[\da-fA-F]{1,64}(?=::)/g)) {
    const packageId = normalizeSuiAddress(match[0]);
    if (packages.has(packageId)) return { kind: 'package', packageId };
  }
  if (SLUSH_REPORTED_TYPES.has(normalizeTypeAddress(tokenType))) return { kind: 'wallet' };
  return null;
}

export type CoinListResponse = {
  blocklist?: string[];
  allowlist?: string[];
};

export type ObjectListResponse = {
  blocklist?: string[];
  allowlist?: string[];
};

// The blocklist is the main thing standing between a scam object and a burn
// suggestion, so a failed fetch must abort the scan rather than quietly return an
// empty set - an empty set reads as "nothing is blocked" and removes the guard.
const BLOCKLIST_ERROR =
  'Could not load the Mysten wallet blocklist. Scanning is disabled without it, so nothing unsafe gets suggested. Try again shortly.';

// fetch coin blocklist once and cache; returns set of blocked coin type args (e.g. "0x...::module::TYPE")
export async function getWalletCoinBlocklist(): Promise<Set<string>> {
  if (cachedCoinBlocklist) return cachedCoinBlocklist;
  let res: Response;
  try {
    res = await fetch(COIN_BLOCKLIST_URL, { cache:'no-cache', signal:AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(BLOCKLIST_ERROR);
  }
  if (!res.ok) throw new Error(BLOCKLIST_ERROR);
  const json = (await res.json()) as CoinListResponse;
  const list = json.blocklist ?? [];
  cachedCoinBlocklist = new Set(list);
  return cachedCoinBlocklist;
}

// fetch object blocklist once and cache; returns set of blocked Move type strings (e.g. "0x...::module::Type")
export async function getWalletObjectBlocklist(): Promise<Set<string>> {
  if (cachedObjectBlocklist) return cachedObjectBlocklist;
  let res: Response;
  try {
    res = await fetch(OBJECT_BLOCKLIST_URL, { cache:'no-cache', signal:AbortSignal.timeout(20_000) });
  } catch {
    throw new Error(BLOCKLIST_ERROR);
  }
  if (!res.ok) throw new Error(BLOCKLIST_ERROR);
  const json = (await res.json()) as ObjectListResponse;
  const list = json.blocklist ?? [];
  // normalize so a short-form lookup key still matches the canonical padded entries
  cachedObjectBlocklist = new Set(list.map(normalizeTypeAddress));
  return cachedObjectBlocklist;
}

// true if this object type is on the blocklist, comparing on a normalized address
export function isObjectTypeBlockedIn(blocklist: Set<string>, objectType: string): boolean {
  return blocklist.has(normalizeTypeAddress(objectType));
}

// extract type arg from coin type (e.g. "0x2::coin::Coin<0x...::wal::WAL>" -> "0x...::wal::WAL")
export function getCoinTypeArg(coinType: string): string {
  if (coinType.includes('<') && coinType.endsWith('>')) {
    return coinType.slice(coinType.indexOf('<') + 1, -1);
  }
  return coinType;
}

// true if this coin type is on the blocklist (exclude from merge/destroy_zero)
export async function isCoinTypeBlocked(coinType: string): Promise<boolean> {
  const blocklist = await getWalletCoinBlocklist();
  const typeArg = getCoinTypeArg(coinType);
  return blocklist.has(typeArg);
}

// true if this object type is on the blocklist (exclude from burn / close kiosk)
export async function isObjectTypeBlocked(objectType: string): Promise<boolean> {
  const blocklist = await getWalletObjectBlocklist();
  return isObjectTypeBlockedIn(blocklist, objectType);
}
