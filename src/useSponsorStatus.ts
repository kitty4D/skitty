import * as React from 'react';
import { FEE_RECIPIENT } from './constants';

/**
 * checking: haven't heard back yet (treated as funded; a refusal flips it anyway)
 * funded:   the sponsor pays gas
 * unfunded: it's out of usable SUI, so users pay their own gas until it's topped up
 * offline:  not configured or unreachable, same consequence, but a top-up won't fix it
 */
export type SponsorAvailability = 'checking' | 'funded' | 'unfunded' | 'offline';

export interface SponsorStatus {
  availability: SponsorAvailability;
  /** why it isn't funded, as the API reports it (empty, address_balance, too_little, ...) */
  reason: string | null;
  /** where SUI has to go to turn sponsorship back on */
  sponsorAddress: string;
  refresh: () => void;
  /** the sponsor just refused mid-flow; believe that over whatever the last poll said */
  markUnavailable: (code: string, sponsorAddress?: string | null) => void;
}

const FUNDING_REASONS = new Set(['empty', 'address_balance', 'too_little']);
const POLL_MS = 60_000;

export function useSponsorStatus(): SponsorStatus {
  const [availability, setAvailability] = React.useState<SponsorAvailability>('checking');
  const [reason, setReason] = React.useState<string | null>(null);
  // FEE_RECIPIENT is required to be the sponsor, so it's a sane answer before the API is
  const [sponsorAddress, setSponsorAddress] = React.useState(FEE_RECIPIENT);
  // a refusal can land while a poll is in flight; the stale poll must not undo it
  const generationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++generationRef.current;
    let next: SponsorAvailability = 'offline';
    let nextReason: string | null = 'unreachable';
    let address: string | null = null;
    try {
      const res = await fetch('/api/sponsor', { headers: { Accept: 'application/json' } });
      const body = await res.json();
      address = typeof body?.sponsorAddress === 'string' ? body.sponsorAddress : null;
      nextReason = typeof body?.reason === 'string' ? body.reason : null;
      if (body?.funded === true) next = 'funded';
      else if (FUNDING_REASONS.has(nextReason ?? '')) next = 'unfunded';
    } catch {
      // no API behind plain `vite dev`, or the network ate it. nobody's sponsoring anything.
    }
    if (generation !== generationRef.current) return;
    setAvailability(next);
    setReason(next === 'funded' ? null : nextReason);
    if (address) setSponsorAddress(address);
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const markUnavailable = React.useCallback((code: string, address?: string | null) => {
    generationRef.current += 1;
    setAvailability(code === 'sponsor_unfunded' ? 'unfunded' : 'offline');
    setReason(code);
    if (address) setSponsorAddress(address);
  }, []);

  const refreshNow = React.useCallback(() => void refresh(), [refresh]);

  return { availability, reason, sponsorAddress, refresh: refreshNow, markUnavailable };
}
