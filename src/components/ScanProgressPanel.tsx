import { Card, CardContent } from './ui/card';
import { motion } from 'framer-motion';

export function ScanProgressPanel({
  progress,
  exiting,
}: {
  progress: { phase: string; current: number; total: number } | null;
  exiting: boolean;
}) {
  return (
    <Card
      className={
        'border-3 border-black shadow-[4px_4px_0_#9333ea] bg-black/40 ' +
        (exiting ? 'opacity-0 scale-95' : 'opacity-100 scale-100')
      }
    >
      <CardContent className="pt-6">
        <div
          role="status"
          aria-live="polite"
          aria-label={progress ? `Scanning: ${progress.phase}` : 'Scan complete'}
        >
          <h2 className="font-display font-black text-xl text-white uppercase tracking-tighter mb-4 flex items-center gap-3">
            <motion.span
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ repeat: Infinity, duration: 1 }}
              aria-hidden
            >
              🐱
            </motion.span>
            {exiting ? 'DECODING COMPLETE' : 'INFILTRATING BLOCKCHAIN...'}
          </h2>
          {!exiting && progress && (
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
                  <motion.div
                    className="h-full bg-skitty-accent"
                    initial={{ width: 0 }}
                    animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                    transition={{ duration: 0.3 }}
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
