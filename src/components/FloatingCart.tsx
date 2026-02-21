import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, ChevronDown, ChevronUp, PartyPopper } from 'lucide-react';
import { Button } from './ui/button';
import { formatSui, shortLabelFromType } from '../utils/format';
import type { CleanupAction } from '../types';

export function FloatingCart({
  selectedActionList,
  totalSelectedRebateMist,
  burnedMist,
  dryRunResult,
  executeError,
  runDryRun,
  execute,
  onClearQueue,
  onViewRawSimulation,
  executing,
  accountConnected,
  isMinimized,
  onToggleMinimize,
}: {
  selectedActionList: CleanupAction[];
  totalSelectedRebateMist: number;
  burnedMist: number;
  feeMist: number;
  dryRunResult: { netGainMist: number; gasCostMist: number; error?: string } | null;
  executeError: string | null;
  runDryRun: () => void;
  execute: () => void;
  onClearQueue: () => void;
  onViewRawSimulation: () => void;
  executing: boolean;
  accountConnected: boolean;
  isMinimized: boolean;
  onToggleMinimize: () => void;
}) {
  return (
    <div className="relative pointer-events-auto w-full max-w-lg">
      <AnimatePresence mode="wait">
        {isMinimized ? (
          <motion.button
            key="minimized-trigger"
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            onClick={onToggleMinimize}
            className="flex items-center gap-3 px-8 py-4 bg-black border-3 border-skitty-accent shadow-brutal text-white font-black uppercase tracking-tighter hover:bg-skitty-accent transition-all group pointer-events-auto mx-auto"
          >
            <Trash2 className="w-5 h-5 text-skitty-accent group-hover:text-white transition-colors" />
            VIEW QUEUE ({selectedActionList.length})
            <ChevronUp className="w-5 h-5 ml-2" />
          </motion.button>
        ) : (
          <motion.div
            key="expanded-cart"
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="bg-black border-3 border-skitty-accent shadow-[12px_12px_0_#000] p-6 w-full relative"
          >
            <button
              onClick={onToggleMinimize}
              className="absolute -top-3 -right-3 p-2 bg-black border-2 border-skitty-accent text-skitty-accent hover:text-white hover:bg-skitty-accent transition-all z-10"
              title="HIDE QUEUE"
            >
              <ChevronDown className="w-5 h-5" />
            </button>

            <div className="flex justify-between items-center mb-6 border-b-2 border-skitty-accent/30 pb-4">
              <h3 className="font-display font-black text-2xl uppercase tracking-tighter text-white flex items-center gap-3">
                <Trash2 className="w-8 h-8 text-skitty-accent shrink-0" />
                QUEUE: {selectedActionList.length}
              </h3>
              <span className="bg-skitty-accent text-white text-[10px] font-black px-2 py-1 uppercase tracking-widest">READY FOR PURGE</span>
            </div>

            <div className="action-panel-scroll overflow-y-auto max-h-[180px] mb-6 space-y-2 pr-2">
              {selectedActionList.map((action, i) => (
                <motion.div
                  initial={{ x: -10, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  key={i}
                  className="text-[10px] font-black uppercase tracking-widest text-skitty-secondary flex justify-between gap-4 py-1 border-b border-white/5"
                >
                  <span className="truncate max-w-[200px]" title={action.label ?? action.objectIds[0]}>
                    {shortLabelFromType(action.label ?? action.objectIds[0] ?? '')}
                  </span>
                  <span className="shrink-0 text-white">+{formatSui(action.userRebateMist)} SUI</span>
                </motion.div>
              ))}
            </div>

            <div className="space-y-4 pt-2">
              <div className="border-t-2 border-skitty-accent pt-4 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-[10px] font-black text-skitty-secondary uppercase tracking-widest">TOTAL REBATE (99%)</p>
                    <p className="text-4xl font-black text-white tracking-tighter leading-none mt-1">{formatSui(totalSelectedRebateMist)} SUI</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-black text-red-500 uppercase tracking-widest">PROTOCOL BURN (1%)</p>
                    <p className="text-sm font-black text-red-500/80 tracking-tighter mt-0">-{formatSui(burnedMist)} SUI</p>
                  </div>
                </div>
              </div>

              {dryRunResult && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-skitty-accent/10 border-2 border-skitty-accent p-3"
                >
                  {dryRunResult.error ? (
                    <div className="space-y-1">
                      <p className="text-[10px] font-black uppercase tracking-widest text-red-500">ERROR SIMULATING</p>
                      <p className="text-[10px] text-red-400/90 break-words">{dryRunResult.error}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-[8px] font-black text-skitty-accent uppercase tracking-widest">EST. GAS</p>
                        <p className="text-sm font-black text-white tracking-tighter">{dryRunResult.gasCostMist >= 0 ? '-' : '+'}{formatSui(Math.abs(dryRunResult.gasCostMist))} SUI</p>
                      </div>
                      <div>
                        <p className="text-[8px] font-black text-skitty-accent uppercase tracking-widest">NET YIELD</p>
                        <p className="text-sm font-black text-white tracking-tighter">{formatSui(dryRunResult.netGainMist)} SUI</p>
                      </div>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full text-[10px] font-black uppercase tracking-widest text-skitty-accent hover:bg-skitty-accent hover:text-black"
                    onClick={onViewRawSimulation}
                  >
                    View Raw Simulation
                  </Button>
                </motion.div>
              )}

              {executeError && (
                <div className="bg-red-500 border-2 border-black p-3 shadow-[4px_4px_0_#000]">
                  <p className="text-[10px] font-black text-black uppercase tracking-widest">EXECUTION FAILED: {executeError}</p>
                </div>
              )}

              <div className="flex flex-col gap-3 pt-2">
                <p className="text-[9px] font-mono text-skitty-secondary/80 leading-snug">
                  Actual rebates and gas are set by the network at execution. Review the transaction in your wallet before approving.
                </p>
                <Button
                  variant="outline"
                  onClick={onClearQueue}
                  className="w-full h-12 border-2 border-green-500/60 text-green-400 hover:bg-green-500/20 hover:text-green-300"
                >
                  <PartyPopper className="w-5 h-5 mr-2 shrink-0" />
                  Save the Objects!
                </Button>
                <div className="flex gap-4">
                  <Button variant="outline" onClick={runDryRun} className="flex-1 h-14">
                    SIMULATE
                  </Button>
                  <Button
                    onClick={execute}
                    disabled={executing || !accountConnected}
                    className="flex-1 h-14 bg-white text-black hover:bg-skitty-accent hover:text-white"
                  >
                    {executing ? 'PURGING...' : 'EXECUTE PURGE'}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
