import * as React from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, ExternalLink, Fuel } from 'lucide-react';
import type { SponsorAvailability } from '../useSponsorStatus';

const SUIVISION_ACCOUNT_URL = 'https://suivision.xyz/account';

// shown whenever users are paying their own gas. the one thing it has to get across:
// a wallet with no SUI can't do anything until the sponsor gets topped up.
export function SponsorStatusBanner({
  availability,
  reason,
  sponsorAddress,
  walletHasNoGas,
}: {
  availability: SponsorAvailability;
  reason: string | null;
  sponsorAddress: string;
  /** the connected wallet can't cover even the minimum gas budget */
  walletHasNoGas: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (availability === 'funded' || availability === 'checking') return null;

  const unfunded = availability === 'unfunded';
  // the SUI is there, it just landed somewhere gas can't be paid from. the server
  // converts it on the next status check, so this only sticks if that keeps failing.
  // the address stays on screen either way.
  const title = !unfunded
    ? 'Gas sponsorship is offline'
    : reason === 'address_balance'
      ? "The gas sponsor can't pay gas right now"
      : 'The gas sponsor is out of SUI';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sponsorAddress);
      setCopied(true);
    } catch {
      // clipboard blocked; the address is selectable anyway
    }
  };

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      role="status"
      aria-live="polite"
      className="border-3 border-black bg-amber-400 text-black shadow-brutal p-5 space-y-3"
    >
      <p className="font-display font-black text-xl uppercase tracking-tighter flex items-center gap-2">
        <Fuel className="w-6 h-6 shrink-0" aria-hidden />
        {title}
      </p>
      <p className="text-sm font-medium leading-relaxed">
        Until it&apos;s {unfunded ? 'topped up' : 'back'}, your own wallet pays the gas for every
        cleanup. A wallet with no SUI can&apos;t run anything until then.
      </p>
      {walletHasNoGas && (
        <p className="text-sm font-black bg-black text-amber-300 px-3 py-2 inline-block">
          Your connected wallet has no SUI for gas, so it can&apos;t run cleanups right now.
        </p>
      )}
      {/* shown in every state. offline usually just means the status check failed, and
          the sponsor may well be empty behind it, but only a confirmed shortage gets the
          "send SUI here" pitch: when it's the key that's missing, a top-up fixes nothing */}
      <div className="space-y-1">
        <p className="text-[10px] font-black uppercase tracking-widest">
          {unfunded ? 'Sponsor wallet: send SUI here to turn sponsorship back on' : 'Sponsor wallet'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-black text-amber-300 px-2 py-1 text-xs font-bold break-all select-all">
            {sponsorAddress}
          </code>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 px-2 py-1 border-2 border-black bg-white text-[10px] font-black uppercase tracking-widest hover:bg-black hover:text-amber-300 transition-colors"
            aria-label="Copy sponsor wallet address"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            href={`${SUIVISION_ACCOUNT_URL}/${sponsorAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1 border-2 border-black bg-white text-[10px] font-black uppercase tracking-widest hover:bg-black hover:text-amber-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            View
          </a>
        </div>
      </div>
    </motion.div>
  );
}
