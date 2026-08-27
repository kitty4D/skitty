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
