// skitty explain: max requests per minute (keep in sync with EXPLAIN_REQUESTS_PER_MINUTE in src/constants.ts)
export const EXPLAIN_REQUESTS_PER_MINUTE = 10;
// skitty explain: max requests per day (keep in sync with EXPLAIN_REQUESTS_PER_DAY in src/constants.ts)
export const EXPLAIN_REQUESTS_PER_DAY = 250;
// skitty explain: reject transaction JSON longer than this (keep in sync with EXPLAIN_MAX_JSON_LENGTH in src/constants.ts)
export const EXPLAIN_MAX_JSON_LENGTH = 900_000;

// skitty sponsor: per-IP request ceilings. Signing is what costs us, so the
// simulate-only path (no signature issued) is not counted against these.
export const SPONSOR_REQUESTS_PER_MINUTE = 12;
export const SPONSOR_REQUESTS_PER_DAY = 300;

// Ceiling on the gas budget the sponsor will front for one reclaim transaction. The
// signed budget is tightened to the simulated cost plus a margin, because an aborted
// transaction still bills the sponsor for computation up to whatever budget it carries.
export const SPONSOR_GAS_BUDGET_MIST = 50_000_000;
export const SPONSOR_MIN_GAS_BUDGET_MIST = 3_000_000;
export const SPONSOR_GAS_BUDGET_MARGIN = 1.5;

// how many of the sponsor's SUI coins we rotate through, and how long a signature over
// one coin version blocks a second signature over that same version. This has to outlast
// a user staring at their wallet prompt, or two live signatures can equivocate the coin.
// large enough that dust coins cannot crowd funded ones out of the page
export const SPONSOR_COIN_POOL_SIZE = 50;
export const SPONSOR_COIN_LOCK_SECONDS = 30 * 60;
// one caller may hold at most this many coins reserved at once, so nobody can collect
// signatures they never submit and pin the whole pool
export const SPONSOR_MAX_HELD_COINS_PER_CALLER = 2;

// turning an address-balance top-up into a gas coin (lib/sponsorGasCoin.js). the
// conversion pays its own gas out of that balance, measured at ~2,100,000 mist, so the
// budget is just headroom. a coin barely over the gas budget could pay gas but never pay
// anyone out, so a balance too small to make a useful coin is left alone.
export const SPONSOR_CONVERSION_GAS_BUDGET_MIST = 5_000_000;
export const SPONSOR_MIN_CONVERSION_MIST = SPONSOR_GAS_BUDGET_MIST + 10_000_000;
// one conversion at a time across every instance, and a long pause after one fails so a
// broken conversion can't keep billing the balance it's meant to rescue
export const SPONSOR_CONVERSION_LOCK_SECONDS = 90;
export const SPONSOR_CONVERSION_BACKOFF_SECONDS = 15 * 60;
