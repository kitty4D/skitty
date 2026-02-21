import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { motion } from 'framer-motion';

export function WarningsBlock() {
  return (
    <motion.div
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: 0.2 }}
    >
      <Alert className="border-3 border-black bg-yellow-400 text-black shadow-brutal rounded-none">
        <AlertTitle className="flex items-center gap-2 font-black uppercase tracking-tighter text-lg">
          <span aria-hidden>⚠️</span> IRREVERSIBLE DESTRUCTION PROTOCOL
        </AlertTitle>
        <AlertDescription className="font-bold text-xs uppercase tracking-tight">
          Closing a kiosk or burning NFTs can affect airdrop eligibility or status/progress in dApps.
          Proceed with extreme caution. These assets will be permanently deleted.
        </AlertDescription>
      </Alert>
    </motion.div>
  );
}
