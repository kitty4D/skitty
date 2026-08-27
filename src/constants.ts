// 1 SUI = 10^9 MIST, use for display conversion
export const MIST_PER_SUI = 1_000_000_000;

// user gets 99% of storage rebate; 1% burned by protocol
export const REBATE_MULTIPLIER = 0.99;

// max coin merges per batch to stay under protocol limits
export const MAX_MERGES_PER_BATCH = 100;

// max cleanup actions (merge groups, destroy_zero, kiosk, burn) in one PTB
export const MAX_ACTIONS_PER_BATCH = 50;

// fee: 13.69% of actual storage rebate, goes to skitty fee recipient
export const FEE_RATE = 0.1369;
export const FEE_RECIPIENT = '0x0154543c5e9d2db3b12d5b761b204b06620f35561b6065f5a793889fcd148eb1';

// gas budget for dry-run build; pre-set so GraphQL resolver skips gas selection (fails when balance low)
export const DRY_RUN_GAS_BUDGET = 50_000_000;
// when taking fee from gas coin, leave at least this much (mist) for gas so split doesn't fail
export const GAS_RESERVE_FOR_FEE_MIST = 1_000_000;

// estimated gas (mist) per action type for net-gain before dry run
export const ESTIMATED_GAS = {
  mergeCoins: 500,
  destroyZero: 300,
  closeKiosk: 2000,
  burn: 1_200_000,
} as const;

// when dry run returns gas cost <= 0, recoup up to this much so we don't lose (cap by user rebate - fee in code)
export const RECOUP_FALLBACK_GAS_MIST = 1_500_000;

// known burn/delete entry points: package::module::function
export const KNOWN_BURNABLE: { typePattern: string; target: string }[] = [
  // ex. { typePattern: '0x...::token::Token', target: '0x...::token::burn' },
];

// native SUI coin type arg: never suggest merge or destroy_zero for SUI (gas coin)
export const SUI_COIN_TYPE_ARG = '0x2::sui::SUI';
export const SUI_COIN_TYPE_ARG_LONG = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// core protected types: never suggest burn/destroy for these, even if a burn exists.
// Package addresses must match what the node actually reports or the guard silently
// never fires — staking lives in the sui_system package (0x3), and SuiNS types live
// in the SuiNS package, not the framework.
export const CORE_PROTECTED_TYPES: string[] = [
  '0x3::staking_pool::StakedSui',
  '0x3::staking_pool::FungibleStakedSui',
  '0x2::kiosk::KioskOwnerCap',
  '0x2::kiosk::Kiosk',
  '0x2::display::Display',
  '0x2::package::UpgradeCap',
  '0x2::package::Publisher',
  '0x2::coin::TreasuryCap',
  '0x2::coin::CoinMetadata',
  // SuiNS mainnet. Addresses here must be the package that DEFINED the type, which is
  // what object types report — subdomains arrived in a later upgrade, so they carry a
  // different address than the original package.
  '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration',
  '0x00c2f85e07181b90c140b15c5ce27d863f93c4d9159d2a4e7bdaeb40e286d6f5::subdomain_registration::SubDomainRegistration',
];

// The node reports framework addresses in short form (0x2) in some places and fully
// padded (0x000…002) in others, so every Move-type comparison has to normalize first.
export function normalizeTypeAddress(type: string): string {
  return type.replace(/^0x0*([0-9a-fA-F])/, '0x$1').toLowerCase();
}

export function isSameMoveType(a: string, b: string): boolean {
  return normalizeTypeAddress(a) === normalizeTypeAddress(b);
}

export function isProtectedType(objectType: string): boolean {
  const normalized = normalizeTypeAddress(objectType);
  return CORE_PROTECTED_TYPES.some((protectedType) => {
    const target = normalizeTypeAddress(protectedType);
    return normalized === target || normalized.startsWith(target + '<');
  });
}

// skitty explain: max requests per minute
export const EXPLAIN_REQUESTS_PER_MINUTE = 10;
// skitty explain: max requests per day
export const EXPLAIN_REQUESTS_PER_DAY = 250;
// skitty explain: hide button if raw JSON length exceeds this (Gemini ~1M token limit)
export const EXPLAIN_MAX_JSON_LENGTH = 900_000;
