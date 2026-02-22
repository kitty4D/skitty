import { motion } from 'framer-motion';
import { FlaskConical, Trash2 } from 'lucide-react';
import { Checkbox } from './ui/checkbox';
import { cn } from '../utils/cn';
import {
  formatSui,
  shortenAddress,
  shortenAddressesInType,
} from '../utils/format';
import type {
  CleanupAction,
  MergeCoinsAction,
  DestroyZeroAction,
  BurnAction,
} from '../types';

const SUIVISION_OBJECT_URL = 'https://suivision.xyz/object';
const SUIVISION_COIN_URL = 'https://suivision.xyz/coin';

const itemVariants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      type: 'spring' as const,
      stiffness: 300,
      damping: 24,
    },
  },
};

export function ActionCard({
  action,
  index,
  selected,
  onToggle,
  shortLabel,
  notEconomical = false,
  interactive = true,
  showSimulate = false,
  simulatedNetInflowMist,
  onDryRun,
  onExecute,
  executing,
}: {
  action: CleanupAction;
  index: number;
  selected: boolean;
  onToggle: () => void;
  shortLabel: string;
  notEconomical?: boolean;
  interactive?: boolean;
  showSimulate?: boolean;
  /** From simulation balance changes; when set, card shows this (matches wallet "you will receive") */
  simulatedNetInflowMist?: number;
  onDryRun: () => void;
  onExecute: () => void;
  executing: boolean;
}) {
  const isDiscovered = action.kind === 'burn' && (action as BurnAction).discovered;
  const isCoin = action.kind === 'merge_coins' || action.kind === 'destroy_zero';
  const coinType = isCoin ? (action as MergeCoinsAction | DestroyZeroAction).coinType : '';
  const coinTypeArg = coinType.includes('<') ? coinType.slice(coinType.indexOf('<') + 1, -1) : '';
  const coinParensText = coinTypeArg ? `COIN<${shortenAddressesInType(coinTypeArg, shortenAddress)}>` : '';
  const coinLinkHref = coinTypeArg ? `${SUIVISION_COIN_URL}/${coinTypeArg}` : null;

  const displayLabel =
    action.kind === 'burn'
      ? shortenAddressesInType(action.label ?? shortLabel, shortenAddress)
      : action.kind === 'close_kiosk'
        ? shortenAddress(action.label ?? '')
        : action.label ?? shortLabel;

  const labelContent = (
    <div className="min-w-0 flex flex-col gap-0.5">
      <div className="label-scroll min-w-0 w-full" title={action.label ?? ''}>
        <span className="font-black text-white uppercase tracking-tighter text-sm whitespace-nowrap block leading-tight">
          {displayLabel}
        </span>
      </div>
      {isCoin && coinParensText && coinLinkHref && (
        <div className="label-scroll min-w-0 w-full" title={coinParensText}>
          <a
            href={coinLinkHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-skitty-accent hover:underline text-[10px] font-black tracking-widest whitespace-nowrap block leading-tight"
            aria-label="View coin type on SuiVision"
          >
            {coinParensText}
          </a>
        </div>
      )}
    </div>
  );

  return (
    <motion.li
      variants={itemVariants}
      whileHover={{ x: 4 }}
      className={cn(
        'group border-2 border-black/40 bg-white/5 transition-colors hover:bg-white/10 overflow-hidden',
        notEconomical && 'border-amber-500/30 bg-amber-500/5',
        selected && 'border-skitty-accent bg-skitty-accent/10'
      )}
    >
      <div className={`p-4 flex items-start gap-4 ${interactive ? 'cursor-pointer' : ''}`}>
        <div className="flex-1 min-w-0">
          {interactive ? (
            <Checkbox
              id={`action-${index}`}
              checked={selected}
              onChange={() => onToggle()}
              aria-label={`${selected ? 'Unselect' : 'Select'} action ${shortLabel}`}
              label={labelContent}
            />
          ) : (
            <div className="py-0.5">{labelContent}</div>
          )}

          <div className="w-full mt-2 ml-9 space-y-1 text-[10px] font-bold uppercase tracking-wider text-skitty-secondary/60">
            {action.kind === 'merge_coins' && (
              <div className="space-y-1">
                {(action as MergeCoinsAction).objectIds.map((id, i) => {
                  const balanceMist = (action as MergeCoinsAction).objectBalances?.[i];
                  const balanceStr = balanceMist != null ? formatSui(Number(balanceMist)) : '—';
                  return (
                    <div key={id} className="flex gap-4 items-center">
                      <a
                        href={`${SUIVISION_OBJECT_URL}/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-skitty-secondary hover:text-skitty-accent transition-colors underline decoration-black/40 underline-offset-2 shrink-0"
                      >
                        {shortenAddress(id)}
                      </a>
                      <span className="text-[10px]">BALANCE: {balanceStr} SUI</span>
                    </div>
                  );
                })}
              </div>
            )}
            {(action.kind === 'destroy_zero' || action.kind === 'close_kiosk' || action.kind === 'burn') && (
              <div className="space-y-1">
                {isDiscovered && (
                  <span className="inline-block px-1.5 py-0.5 bg-skitty-accent text-white text-[8px] font-black tracking-widest mb-1">
                    NEW DISCOVERY
                  </span>
                )}
                {action.objectIds.map((id) => (
                  <a
                    key={id}
                    href={`${SUIVISION_OBJECT_URL}/${id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-skitty-secondary hover:text-skitty-accent transition-colors block truncate underline decoration-black/40 underline-offset-2"
                  >
                    {shortenAddress(id)}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex flex-col gap-2 items-end min-w-[7rem]">
          <div className="text-right space-y-0.5">
            <p className="text-[10px] font-black text-skitty-secondary/40 tracking-widest">
              {simulatedNetInflowMist !== undefined ? 'EST. NET YIELD' : 'RUN SIMULATE'}
            </p>
            <p className="text-sm font-black text-white leading-none tracking-tighter">
              {simulatedNetInflowMist !== undefined
                ? (simulatedNetInflowMist >= 0 ? '+' : '') + formatSui(simulatedNetInflowMist)
                : '—'}
            </p>
          </div>

          {(interactive || showSimulate) && (
            <div className="flex items-center gap-1.5 pt-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDryRun();
                }}
                className="p-1.5 bg-black border border-white/10 hover:border-skitty-accent hover:text-skitty-accent transition-all group/btn shadow-[2px_2px_0_#000]"
                title="RUN SIMULATION"
              >
                <FlaskConical className="h-3.5 w-3.5" />
              </button>
              {interactive && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExecute();
                  }}
                  disabled={executing}
                  className="p-1.5 bg-black border border-white/10 hover:border-green-500 hover:text-green-500 transition-all disabled:opacity-20 shadow-[2px_2px_0_#000]"
                  title={
                    action.kind === 'merge_coins'
                      ? 'MERGE COIN'
                      : action.kind === 'destroy_zero'
                        ? 'DESTROY COIN'
                        : action.kind === 'close_kiosk'
                          ? 'CLOSE KIOSK'
                          : 'ATTEMPT BURN'
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}
