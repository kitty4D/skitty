import { useEffect, useState } from 'react';
import { Card, CardContent } from './ui/card';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import type { ScanProgress, ScanSection } from '../types';

export function ScanProgressPanel({
  progress,
  exiting,
  sections = [],
}: {
  progress: ScanProgress | null;
  exiting: boolean;
  sections?: ScanSection[];
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const completed = sections.filter(section => section.status === 'complete').length;
  return (
    <Card
      className={
        'border-3 border-black shadow-[4px_4px_0_#9333ea] bg-black/40 ' +
        (exiting ? 'opacity-0 scale-95' : 'opacity-100 scale-100')
      }
    >
      <CardContent className="pt-6">
        <div
          role="region"
          aria-label="wallet scan progress"
        >
          <h2 className="font-display font-black text-xl text-white uppercase tracking-tighter mb-4 flex items-center gap-3">
            <Loader2 aria-hidden className="h-5 w-5 animate-spin motion-reduce:animate-none" />
            {exiting ? 'scan finished' : 'scanning wallet'}
          </h2>
          <p className="text-sm text-skitty-secondary mb-3">verified results appear below as they're ready. large wallets take longer; browse while the remaining checks continue.</p>
          <p className="text-xs text-white tabular-nums mb-2">{seconds}s elapsed</p>
          <p role="status" aria-live="polite" className="text-xs text-white mb-3">{sections.length > 0 ? `${completed} of ${sections.length} checks complete` : progress?.phase ?? 'starting checks'}</p>
          <ul className="divide-y divide-white/10">
            {sections.map(section => <li key={section.id} className="py-3 flex items-start gap-3">
              {section.status === 'complete' ? <Check aria-hidden className="w-4 h-4 shrink-0 mt-0.5 text-green-300" /> :
                section.status === 'error' ? <AlertTriangle aria-hidden className="w-4 h-4 shrink-0 mt-0.5 text-amber-300" /> :
                <Loader2 aria-hidden className={`w-4 h-4 shrink-0 mt-0.5 text-skitty-accent ${section.status === 'scanning' ? 'animate-spin motion-reduce:animate-none' : 'opacity-40'}`} />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
                  <span className="font-bold text-white">{section.label}</span>
                  <span className={section.status === 'error' ? 'text-amber-300' : 'text-skitty-secondary'}>{section.status === 'complete' ? `${section.found} cleanup options found` : section.status === 'error' ? 'incomplete: see warning' : section.status === 'waiting' ? 'waiting' : 'scanning'}</span>
                </div>
                {section.status === 'scanning' && <p className="mt-1 text-xs text-skitty-secondary break-words">{section.phase === 'waiting' ? 'starting checks' : section.phase}{section.total > 0 ? ` (${section.current} / ${section.total})` : section.current > 0 && !section.phase.includes('page') && !section.phase.includes('found') ? ` (${section.current} batches checked)` : ''}</p>}
              </div>
            </li>)}
          </ul>
          <p className="text-xs text-skitty-secondary mt-3">nothing is signed or moved by this scan. transaction controls unlock when scanning finishes.</p>
          {!sections.length && !exiting && progress && (
            <div className="space-y-4">
              <div className="flex justify-between items-end">
                <p className="text-skitty-accent font-black uppercase tracking-widest text-[10px]">{progress.phase}</p>
                <p className="text-[10px] font-black uppercase text-skitty-secondary">
                  {progress.total > 0
                    ? `${progress.current} / ${progress.total}`
                    : progress.current > 0
                      ? `${progress.current} OBJECTS`
                      : 'WAITING...'}
                </p>
              </div>
              {progress.total > 0 && (
                <div className="h-4 w-full bg-black border-2 border-black relative overflow-hidden">
                  <div
                    className="h-full bg-skitty-accent"
                    style={{ width: `${(progress.current / progress.total) * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
