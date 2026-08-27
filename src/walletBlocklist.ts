import { normalizeTypeAddress } from './constants';

// mysten labs wallet blocklist for coins; @see https://github.com/MystenLabs/wallet_blocklist/blob/main/blocklists/coin-list.json
const COIN_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/main/blocklists/coin-list.json';
// object (NFT/kiosk) blocklist: full Move type strings (e.g. "0x...::module::Type")
const OBJECT_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/refs/heads/main/blocklists/object-list.json';

let cachedCoinBlocklist: Set<string> | null = null;
let cachedObjectBlocklist: Set<string> | null = null;

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
// empty set — an empty set reads as "nothing is blocked" and removes the guard.
const BLOCKLIST_ERROR =
  'Could not load the Mysten wallet blocklist. Scanning is disabled without it, so nothing unsafe gets suggested. Try again shortly.';

// fetch coin blocklist once and cache; returns set of blocked coin type args (e.g. "0x...::module::TYPE")
export async function getWalletCoinBlocklist(): Promise<Set<string>> {
  if (cachedCoinBlocklist) return cachedCoinBlocklist;
  let res: Response;
  try {
    res = await fetch(COIN_BLOCKLIST_URL);
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
    res = await fetch(OBJECT_BLOCKLIST_URL);
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
