import * as React from 'react';
import { fetchSuiHoldings, type SuiHoldings } from './sponsoredTx';

/**
 * the connected wallet's own SUI, which only matters while it has to pay its own gas.
 * null means unknown (loading or failed), and unknown never blocks anything: the
 * transaction planner re-reads it and says precisely what's missing.
 */
export function useSuiHoldings(address: string | null | undefined): {
  holdings: SuiHoldings | null;
  refresh: () => void;
} {
  // tagged with the address it was read for, so switching wallets can't show the last
  // wallet's balance for a frame, and a refresh doesn't blank what's already known
  const [loaded, setLoaded] = React.useState<{ address: string; holdings: SuiHoldings } | null>(
    null
  );
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchSuiHoldings(address)
      .then((holdings) => {
        if (!cancelled) setLoaded({ address, holdings });
      })
      .catch(() => {
        // stays unknown
      });
    return () => {
      cancelled = true;
    };
  }, [address, generation]);

  const refresh = React.useCallback(() => setGeneration((g) => g + 1), []);
  const holdings = address && loaded?.address === address ? loaded.holdings : null;
  return { holdings, refresh };
}
