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

// core protected types: never suggest burn/destroy for these, even if a burn exists
export const CORE_PROTECTED_TYPES: string[] = [
  '0x2::staking_pool::StakedSui',
  '0x2::staking_pool::StakedSuiV2',
  '0x2::kiosk::KioskOwnerCap',
  '0x2::kiosk::Kiosk',
  '0x2::suins::SuinsRegistration',
  '0x2::domain::Domain',
  '0x2::display::Display',
  '0x2::package::UpgradeCap',
  '0x2::package::Publisher',
];

export function isProtectedType(objectType: string): boolean {
  return CORE_PROTECTED_TYPES.some(
    (protectedType) =>
      objectType === protectedType || objectType.startsWith(protectedType + '<')
  );
}

// skitty explain: max requests per minute
export const EXPLAIN_REQUESTS_PER_MINUTE = 10;
// skitty explain: max requests per day
export const EXPLAIN_REQUESTS_PER_DAY = 250;
// skitty explain: hide button if raw JSON length exceeds this (Gemini ~1M token limit)
export const EXPLAIN_MAX_JSON_LENGTH = 900_000;
