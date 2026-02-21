import {
  EXPLAIN_MAX_JSON_LENGTH,
  EXPLAIN_REQUESTS_PER_MINUTE,
  EXPLAIN_REQUESTS_PER_DAY,
} from '../constants';

const EXPLAIN_STORAGE_KEY = 'skitty_explain_ts';

export function getExplainTimestamps(): number[] {
  try {
    const raw = localStorage.getItem(EXPLAIN_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as number[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function canRequestExplain(rawJsonLength: number): { allowed: boolean; reason?: string } {
  if (rawJsonLength > EXPLAIN_MAX_JSON_LENGTH) {
    return { allowed: false, reason: 'Transaction data is too large to explain.' };
  }
  const now = Date.now();
  const oneMin = 60 * 1000;
  const oneDay = 24 * 60 * 60 * 1000;
  const timestamps = getExplainTimestamps().filter((t) => now - t < oneDay);
  const inLastMin = timestamps.filter((t) => now - t < oneMin).length;
  const inLastDay = timestamps.length;
  if (inLastMin >= EXPLAIN_REQUESTS_PER_MINUTE) {
    return { allowed: false, reason: `Rate limit: max ${EXPLAIN_REQUESTS_PER_MINUTE} requests per minute. Try again shortly.` };
  }
  if (inLastDay >= EXPLAIN_REQUESTS_PER_DAY) {
    return { allowed: false, reason: `Rate limit: max ${EXPLAIN_REQUESTS_PER_DAY} requests per day.` };
  }
  return { allowed: true };
}

export function recordExplainRequest(): void {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const timestamps = getExplainTimestamps().filter((t) => now - t < oneDay);
  timestamps.push(now);
  try {
    localStorage.setItem(EXPLAIN_STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    // ignore
  }
}
