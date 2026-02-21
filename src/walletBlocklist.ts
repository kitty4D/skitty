// Mysten Labs wallet blocklist for coins; @see https://github.com/MystenLabs/wallet_blocklist/blob/main/blocklists/coin-list.json
const BLOCKLIST_URL =
  'https://raw.githubusercontent.com/MystenLabs/wallet_blocklist/main/blocklists/coin-list.json';

let cachedBlocklist: Set<string> | null = null;

export type CoinListResponse = {
  blocklist?: string[];
  allowlist?: string[];
};

// fetch blocklist once and cache; returns set of blocked coin type args (e.g. "0x...::module::TYPE")
export async function getWalletCoinBlocklist(): Promise<Set<string>> {
  if (cachedBlocklist) return cachedBlocklist;
  const res = await fetch(BLOCKLIST_URL);
  if (!res.ok) return new Set();
  const json = (await res.json()) as CoinListResponse;
  const list = json.blocklist ?? [];
  cachedBlocklist = new Set(list);
  return cachedBlocklist;
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
