import * as React from 'react';
import {
  useCurrentAccount,
  useSignTransaction,
  ConnectButton as KitConnectButton,
} from '@mysten/dapp-kit';
import { useGraphQLScanner } from './useGraphQLScanner';
import { buildBatchTransaction } from './buildCleanupTransaction';
import { REBATE_MULTIPLIER, FEE_RECIPIENT } from './constants';
import { computeFeeMist } from './buildCleanupTransaction';
import { rpcClient } from './rpcClient';
import type { CleanupAction } from './types';

// ui components
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/ui/card';
import { Alert, AlertDescription } from './components/ui/alert';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from './utils/cn';
import { X } from 'lucide-react';
import { formatSui, bytesToBase64, base64ToBytes, shortLabelFromType, shortenAddress } from './utils/format';
import { canRequestExplain, recordExplainRequest } from './utils/explain';
import { ScanProgressPanel } from './components/ScanProgressPanel';
import { WarningsBlock } from './components/WarningsBlock';
import { ActionCard } from './components/ActionCard';
import { FloatingCart } from './components/FloatingCart';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

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

import { Transaction } from '@mysten/sui/transactions';
import { graphQLClient } from './graphql/client';
import { isSuiNSDomain, resolveSuiNSDomain } from './utils/suiNS';

export function ReclaimDashboard() {
  const account = useCurrentAccount();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const [manualAddress, setManualAddress] = React.useState('');
  const [resolvedAddress, setResolvedAddress] = React.useState<string | null>(null);
  const [resolvingSuiNS, setResolvingSuiNS] = React.useState(false);
  const [suiNSError, setSuiNSError] = React.useState<string | null>(null);
  const scanAfterResolveRef = React.useRef(false);

  // address we actually use for scanning (SuiNS domains get resolved first)
  const rawInput = manualAddress.trim() || (account?.address ?? '');
  const addressToUse = resolvedAddress ?? (isSuiNSDomain(rawInput) ? null : rawInput || null);

  // resolve SuiNS domain when user types a .sui name
  React.useEffect(() => {
    if (!rawInput || !isSuiNSDomain(rawInput)) {
      setResolvedAddress(null);
      setSuiNSError(null);
      return;
    }
    let cancelled = false;
    setResolvingSuiNS(true);
    setSuiNSError(null);
    resolveSuiNSDomain(rawInput)
      .then((addr) => {
        if (cancelled) return;
        setResolvedAddress(addr);
        if (!addr) setSuiNSError(`Could not resolve ${rawInput}`);
      })
      .catch((err) => {
        if (!cancelled) {
          setSuiNSError(err?.message ?? 'Failed to resolve SuiNS domain');
          setResolvedAddress(null);
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingSuiNS(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rawInput]);

  const [executeError, setExecuteError] = React.useState<string | null>(null);
  const [lastSponsorImpact, setLastSponsorImpact] = React.useState<{
    digest: string;
    netMist: number;
  } | null>(null);

  // cart minimized state
  const [isCartMinimized, setIsCartMinimized] = React.useState(false);

  const { state, scan, refreshAfterExecute } = useGraphQLScanner(addressToUse);

  // when user hit submit with SuiNS before resolve finished, run scan once address is ready
  React.useEffect(() => {
    if (scanAfterResolveRef.current && addressToUse && !state.loading) {
      scanAfterResolveRef.current = false;
      scan();
    }
  }, [addressToUse, state.loading, scan]);

  // start that scan immediately when user connects wallet!
  const prevAccountAddress = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const hadAccount = prevAccountAddress.current;
    const hasAccount = account?.address;
    prevAccountAddress.current = hasAccount;
    if (!hadAccount && hasAccount && addressToUse === hasAccount && !state.loading) {
      scan();
    }
  }, [account?.address, addressToUse, state.loading, scan]);

  const [dryRunResult, setDryRunResult] = React.useState<{
    netGainMist: number;
    gasCostMist: number;
    error?: string;
  } | null>(null);
  const [simulationModal, setSimulationModal] = React.useState<{
    /** net gain from formula (rebate - gas - fee); used when balance changes unavailable */
    netGainMist?: number;
    /** actual SUI balance change for sender from simulation (preferred for display) */
    netInflowMist?: number;
    gasCostMist?: number;
    error?: string;
  } | null>(null);
  /** per-action simulated net inflow (from balance changes); card shows this when set so it matches wallet */
  const [simulatedNetInflowByIndex, setSimulatedNetInflowByIndex] = React.useState<Record<number, number>>({});
  const [lastDryRunRawJson, setLastDryRunRawJson] = React.useState<string | null>(null);
  const [showRawSimulation, setShowRawSimulation] = React.useState(false);
  const [geminiExplanation, setGeminiExplanation] = React.useState<string | null>(null);
  const [geminiLoading, setGeminiLoading] = React.useState(false);
  const [geminiError, setGeminiError] = React.useState<string | null>(null);
  const [executing, setExecuting] = React.useState(false);
  const [selectedActions, setSelectedActions] = React.useState<Set<number>>(new Set());
  const toggleAction = (index: number) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectedActionList = state.actions.filter((_, i) => selectedActions.has(i));
  const totalSelectedRebateMist = selectedActionList.reduce((s, a) => s + a.userRebateMist, 0);
  const totalStorageRebateMist = selectedActionList.reduce(
    (s, a) => s + Number(a.storageRebateTotal),
    0
  );
  const totalEstimatedGasMist = selectedActionList.reduce((s, a) => s + a.estimatedGasMist, 0);
  const burnedMist = Math.floor(totalStorageRebateMist * (1 - REBATE_MULTIPLIER));
  const feeMist = computeFeeMist(totalStorageRebateMist);
  const canSponsorBatch = totalSelectedRebateMist >= totalEstimatedGasMist + feeMist;

  const runDryRun = React.useCallback(async () => {
    if (selectedActionList.length === 0) {
      setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: 'Select at least one action.' });
      return;
    }
    if (!account?.address) {
      setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: 'Connect wallet to dry run.' });
      return;
    }
    setDryRunResult(null);
    try {
      const estimatedGasMist = selectedActionList.reduce((s, a) => s + a.estimatedGasMist, 0);
      const tx = buildBatchTransaction(
        selectedActionList,
        null,
        totalStorageRebateMist,
        null,
        estimatedGasMist,
        null,
        { sponsoredGas: true, senderAddress: account.address }
      );
      tx.setSender(account.address);
      tx.setGasOwner(FEE_RECIPIENT);
      const kindBytes = await tx.build({ client: graphQLClient, onlyTransactionKind: true });
      const txBytesBase64 = bytesToBase64(kindBytes instanceof Uint8Array ? kindBytes : new Uint8Array(kindBytes));

      const sponsorRes = await fetch('/api/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txBytes: txBytesBase64, userAddress: account.address }),
      });
      if (!sponsorRes.ok) {
        const err = await sponsorRes.json().catch(() => ({}));
        throw new Error(err?.error ?? `Sponsor API ${sponsorRes.status}`);
      }
      const { sponsoredTxBytes } = await sponsorRes.json();
      if (!sponsoredTxBytes) throw new Error('Invalid sponsor response');

      const sponsoredBytes = base64ToBytes(sponsoredTxBytes);
      const result = await graphQLClient.simulateTransaction({
        transaction: sponsoredBytes,
        include: { effects: true },
      });
      setGeminiExplanation(null);
      setGeminiError(null);
      setLastDryRunRawJson(
        JSON.stringify(
          {
            request: { transactionBytesBase64: sponsoredTxBytes, include: { effects: true } },
            response: result,
          },
          null,
          2
        )
      );
      const effects =
        result.$kind === 'Transaction' ? result.Transaction.effects : result.FailedTransaction?.effects;
      if (!effects) {
        setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: 'No effects from dry run.' });
        return;
      }
      const gasUsed = effects.gasUsed;
      const gasCostMist =
        Number(gasUsed?.computationCost ?? 0) +
        Number(gasUsed?.storageCost ?? 0) -
        Number(gasUsed?.storageRebate ?? 0);
      const netGainMist = totalSelectedRebateMist - Math.max(0, gasCostMist) - feeMist;
      setDryRunResult({ netGainMist, gasCostMist, error: undefined });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setGeminiExplanation(null);
      setGeminiError(null);
      setLastDryRunRawJson(JSON.stringify({ request: null, response: { error: errMsg } }, null, 2));
      setDryRunResult({
        netGainMist: 0,
        gasCostMist: 0,
        error: errMsg,
      });
    }
  }, [account?.address, selectedActionList, totalSelectedRebateMist, totalStorageRebateMist, feeMist]);

  const execute = React.useCallback(async () => {
    if (selectedActionList.length === 0 || !account?.address) return;
    setExecuting(true);
    setExecuteError(null);
    setLastSponsorImpact(null);
    const clearExecuting = () => setExecuting(false);
    const safetyTimeoutId = setTimeout(clearExecuting, 120_000);
    try {
      const estimatedGasMist = selectedActionList.reduce((s, a) => s + a.estimatedGasMist, 0);
      // 1) Build with estimated gas, sponsor, dry run to get actual gas cost
      const txDraft = buildBatchTransaction(
        selectedActionList,
        null,
        totalStorageRebateMist,
        null,
        estimatedGasMist,
        null,
        { sponsoredGas: true, senderAddress: account.address }
      );
      txDraft.setSender(account.address);
      txDraft.setGasOwner(FEE_RECIPIENT);
      const kindBytesDraft = await txDraft.build({ client: graphQLClient, onlyTransactionKind: true });
      const txBytesBase64Draft = bytesToBase64(kindBytesDraft instanceof Uint8Array ? kindBytesDraft : new Uint8Array(kindBytesDraft));

      const sponsorRes1 = await fetch('/api/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txBytes: txBytesBase64Draft, userAddress: account.address }),
      });
      if (!sponsorRes1.ok) {
        const err = await sponsorRes1.json().catch(() => ({}));
        throw new Error(err?.error ?? `Sponsor API ${sponsorRes1.status}`);
      }
      const { sponsoredTxBytes: sponsoredDraft } = await sponsorRes1.json();
      if (!sponsoredDraft) throw new Error('Invalid sponsor response');

      const simResult = await graphQLClient.simulateTransaction({
        transaction: base64ToBytes(sponsoredDraft),
        include: { effects: true },
      });
      const simEffects = (simResult.$kind === 'Transaction' ? simResult.Transaction : simResult.FailedTransaction)?.effects;
      if (!simEffects?.gasUsed) throw new Error('Dry run failed or no gas data');
      const gasCostMist =
        Number(simEffects.gasUsed?.computationCost ?? 0) +
        Number(simEffects.gasUsed?.storageCost ?? 0) -
        Number(simEffects.gasUsed?.storageRebate ?? 0);
      const gasRecoupMist =
        gasCostMist > 0 ? gasCostMist : estimatedGasMist;
      if (totalSelectedRebateMist < gasRecoupMist + feeMist) {
        setExecuteError(
          'Selected actions don\'t cover gas and fee (simulation showed gas cost higher than rebate). We don\'t sponsor losing transactions.'
        );
        return;
      }

      // 2) Rebuild with actual gas so we recoup what we spend (fallback to estimate when sim says <= 0)
      const tx = buildBatchTransaction(
        selectedActionList,
        null,
        totalStorageRebateMist,
        null,
        gasRecoupMist,
        null,
        { sponsoredGas: true, senderAddress: account.address }
      );
      tx.setSender(account.address);
      tx.setGasOwner(FEE_RECIPIENT);
      const kindBytes = await tx.build({ client: graphQLClient, onlyTransactionKind: true });
      const txBytesBase64 = bytesToBase64(kindBytes instanceof Uint8Array ? kindBytes : new Uint8Array(kindBytes));

      const sponsorRes = await fetch('/api/sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txBytes: txBytesBase64, userAddress: account.address }),
      });
      if (!sponsorRes.ok) {
        const err = await sponsorRes.json().catch(() => ({}));
        throw new Error(err?.error ?? `Sponsor API ${sponsorRes.status}`);
      }
      const { sponsoredTxBytes, sponsorSignature } = await sponsorRes.json();
      if (!sponsoredTxBytes || !sponsorSignature) throw new Error('Invalid sponsor response');

      const txToSign = Transaction.from(sponsoredTxBytes);
      const { bytes: signedTxBytes, signature: userSignature } = await signTransaction({
        transaction: txToSign,
      });

      const result = await rpcClient.executeTransactionBlock({
        transactionBlock: signedTxBytes,
        signature: [sponsorSignature, userSignature],
        options: { showEffects: true },
      });
      setDryRunResult(null);
      const executedActions = [...selectedActionList];
      setSelectedActions(new Set());
      if (result.digest) {
        await rpcClient.waitForTransaction({
          digest: result.digest,
          timeout: 30_000,
          pollInterval: 500,
        });
        try {
          const txResp = await rpcClient.getTransactionBlock({
            digest: result.digest,
            options: { showBalanceChanges: true },
          });
          const changes = txResp.balanceChanges ?? [];
          const sponsorNorm = FEE_RECIPIENT.toLowerCase();
          const ownerAddr = (o: typeof changes[0]['owner']) =>
            o && typeof o === 'object' && 'AddressOwner' in o ? (o as { AddressOwner: string }).AddressOwner : null;
          const isSui = (t: string) => t != null && /^0x0*2::sui::sui$/i.test(t.replace(/^0x0+/, '0x'));
          let netMist = 0;
          for (const ch of changes) {
            const addr = ownerAddr(ch.owner);
            if (addr?.toLowerCase() === sponsorNorm && isSui(ch.coinType)) {
              const amt = Number(ch.amount);
              if (!Number.isNaN(amt)) netMist += amt;
            }
          }
          setLastSponsorImpact({ digest: result.digest, netMist });
        } catch {
          setLastSponsorImpact(null);
        }
      }
      await refreshAfterExecute(executedActions);
      setSimulatedNetInflowByIndex({});
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(safetyTimeoutId);
      clearExecuting();
    }
  }, [account?.address, selectedActionList, signTransaction, refreshAfterExecute, totalStorageRebateMist]);

  const runDryRunOne = React.useCallback(
    async (action: CleanupAction, actionIndex: number) => {
      const senderAddress = account?.address ?? state.scannedAddress ?? null;
      if (!senderAddress) {
        setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: 'Scan an address or connect wallet to run simulation.' });
        return;
      }
      setDryRunResult(null);
      try {
        const singleStorageRebate = Number(action.storageRebateTotal);
        const tx = buildBatchTransaction(
          [action],
          null,
          singleStorageRebate,
          null,
          action.estimatedGasMist,
          null,
          { sponsoredGas: true, senderAddress }
        );
        tx.setSender(senderAddress);
        tx.setGasOwner(FEE_RECIPIENT);
        const kindBytes = await tx.build({ client: graphQLClient, onlyTransactionKind: true });
        const txBytesBase64 = bytesToBase64(kindBytes instanceof Uint8Array ? kindBytes : new Uint8Array(kindBytes));

        const sponsorRes = await fetch('/api/sponsor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txBytes: txBytesBase64, userAddress: senderAddress }),
        });
        if (!sponsorRes.ok) {
          const err = await sponsorRes.json().catch(() => ({}));
          throw new Error(err?.error ?? `Sponsor API ${sponsorRes.status}`);
        }
        const { sponsoredTxBytes } = await sponsorRes.json();
        if (!sponsoredTxBytes) throw new Error('Invalid sponsor response');

        const sponsoredBytes = base64ToBytes(sponsoredTxBytes);
        const result = await graphQLClient.simulateTransaction({
          transaction: sponsoredBytes,
          include: { effects: true, balanceChanges: true },
        });
        setGeminiExplanation(null);
        setGeminiError(null);
        setLastDryRunRawJson(
          JSON.stringify(
            {
              request: { transactionBytesBase64: sponsoredTxBytes, include: { effects: true, balanceChanges: true } },
              response: result,
            },
            null,
            2
          )
        );
        const txResult = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
        const effects = txResult?.effects;
        if (!effects) {
          setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: 'No effects from dry run.' });
          setSimulationModal({ error: 'No effects from dry run.' });
          return;
        }
        const gasUsed = effects.gasUsed;
        const gasCostMist =
          Number(gasUsed?.computationCost ?? 0) +
          Number(gasUsed?.storageCost ?? 0) -
          Number(gasUsed?.storageRebate ?? 0);
        const singleFeeMist = computeFeeMist(singleStorageRebate);
        const netGainMist = action.userRebateMist - Math.max(0, gasCostMist) - singleFeeMist;
        let netInflowMist: number | undefined;
        const balanceChanges = txResult.balanceChanges;
        if (balanceChanges && senderAddress) {
          const senderNorm = senderAddress.toLowerCase();
          // SUI type can be 0x2::sui::SUI or long form 0x0...02::sui::SUI
          const isSuiCoinType = (t: string | undefined) =>
            t != null && /^0x0*2::sui::sui$/i.test(t.replace(/^0x0+/, '0x'));
          for (const ch of balanceChanges) {
            if (ch.address?.toLowerCase() === senderNorm && isSuiCoinType(ch.coinType)) {
              const amount = Number(ch.amount);
              if (!Number.isNaN(amount)) netInflowMist = (netInflowMist ?? 0) + amount;
            }
          }
        }
        const expectedInflowMist =
          netInflowMist ?? (gasCostMist <= 0 ? -gasCostMist : undefined) ?? netGainMist;
        setDryRunResult({ netGainMist, gasCostMist, error: undefined });
        setSimulationModal({
          netGainMist,
          netInflowMist: expectedInflowMist,
          gasCostMist,
          error: undefined,
        });
        setSimulatedNetInflowByIndex((prev) => ({ ...prev, [actionIndex]: expectedInflowMist }));
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        setGeminiExplanation(null);
        setGeminiError(null);
        setLastDryRunRawJson(JSON.stringify({ request: null, response: { error: errMsg } }, null, 2));
        setDryRunResult({ netGainMist: 0, gasCostMist: 0, error: errMsg });
        setSimulationModal({ error: errMsg });
      }
    },
    [account?.address, state.scannedAddress]
  );

  // clear simulated yields when scan results change so we don't show stale numbers
  React.useEffect(() => {
    setSimulatedNetInflowByIndex({});
  }, [state.scannedAddress, state.actions.length]);

  const executeOne = React.useCallback(
    async (action: CleanupAction) => {
      if (!account?.address) return;
      setExecuting(true);
      setExecuteError(null);
      setLastSponsorImpact(null);
      const clearExecuting = () => setExecuting(false);
      const safetyTimeoutId = setTimeout(clearExecuting, 120_000);
      try {
        const singleStorageRebate = Number(action.storageRebateTotal);
        // 1) Build with estimated gas, sponsor, dry run to get actual gas cost
        const txDraft = buildBatchTransaction(
          [action],
          null,
          singleStorageRebate,
          null,
          action.estimatedGasMist,
          null,
          { sponsoredGas: true, senderAddress: account.address }
        );
        txDraft.setSender(account.address);
        txDraft.setGasOwner(FEE_RECIPIENT);
        const kindBytesDraft = await txDraft.build({ client: graphQLClient, onlyTransactionKind: true });
        const txBytesBase64Draft = bytesToBase64(kindBytesDraft instanceof Uint8Array ? kindBytesDraft : new Uint8Array(kindBytesDraft));

        const sponsorRes1 = await fetch('/api/sponsor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txBytes: txBytesBase64Draft, userAddress: account.address }),
        });
        if (!sponsorRes1.ok) {
          const err = await sponsorRes1.json().catch(() => ({}));
          throw new Error(err?.error ?? `Sponsor API ${sponsorRes1.status}`);
        }
        const { sponsoredTxBytes: sponsoredDraft } = await sponsorRes1.json();
        if (!sponsoredDraft) throw new Error('Invalid sponsor response');

        const simResult = await graphQLClient.simulateTransaction({
          transaction: base64ToBytes(sponsoredDraft),
          include: { effects: true },
        });
        const simEffects = (simResult.$kind === 'Transaction' ? simResult.Transaction : simResult.FailedTransaction)?.effects;
        if (!simEffects?.gasUsed) throw new Error('Dry run failed or no gas data');
        const gasCostMist =
          Number(simEffects.gasUsed?.computationCost ?? 0) +
          Number(simEffects.gasUsed?.storageCost ?? 0) -
          Number(simEffects.gasUsed?.storageRebate ?? 0);
        const gasRecoupMist =
          gasCostMist > 0 ? gasCostMist : action.estimatedGasMist;
        const singleFeeMist = computeFeeMist(singleStorageRebate);
        if (action.userRebateMist < gasRecoupMist + singleFeeMist) {
          setExecuteError(
            'This action doesn\'t cover gas and fee (simulation showed gas cost higher than rebate). We don\'t sponsor losing transactions.'
          );
          return;
        }

        // 2) Rebuild with actual gas so we recoup what we spend (fallback to estimate when sim says <= 0)
        const tx = buildBatchTransaction(
          [action],
          null,
          singleStorageRebate,
          null,
          gasRecoupMist,
          null,
          { sponsoredGas: true, senderAddress: account.address }
        );
        tx.setSender(account.address);
        tx.setGasOwner(FEE_RECIPIENT);
        const kindBytes = await tx.build({ client: graphQLClient, onlyTransactionKind: true });
        const txBytesBase64 = bytesToBase64(kindBytes instanceof Uint8Array ? kindBytes : new Uint8Array(kindBytes));

        const sponsorRes = await fetch('/api/sponsor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txBytes: txBytesBase64, userAddress: account.address }),
        });
        if (!sponsorRes.ok) {
          const err = await sponsorRes.json().catch(() => ({}));
          throw new Error(err?.error ?? `Sponsor API ${sponsorRes.status}`);
        }
        const { sponsoredTxBytes, sponsorSignature } = await sponsorRes.json();
        if (!sponsoredTxBytes || !sponsorSignature) throw new Error('Invalid sponsor response');

        const txToSign = Transaction.from(sponsoredTxBytes);
        const { bytes: signedTxBytes, signature: userSignature } = await signTransaction({
          transaction: txToSign,
        });

        const result = await rpcClient.executeTransactionBlock({
          transactionBlock: signedTxBytes,
          signature: [sponsorSignature, userSignature],
          options: { showEffects: true },
        });
        setDryRunResult(null);
        const executedActions = [action];
        setSelectedActions(new Set());
        if (result.digest) {
          await rpcClient.waitForTransaction({
            digest: result.digest,
            timeout: 30_000,
            pollInterval: 500,
          });
          try {
            const txResp = await rpcClient.getTransactionBlock({
              digest: result.digest,
              options: { showBalanceChanges: true },
            });
            const changes = txResp.balanceChanges ?? [];
            const sponsorNorm = FEE_RECIPIENT.toLowerCase();
            const ownerAddr = (o: typeof changes[0]['owner']) =>
              o && typeof o === 'object' && 'AddressOwner' in o ? (o as { AddressOwner: string }).AddressOwner : null;
            const isSui = (t: string) => t != null && /^0x0*2::sui::sui$/i.test(t.replace(/^0x0+/, '0x'));
            let netMist = 0;
            for (const ch of changes) {
              const addr = ownerAddr(ch.owner);
              if (addr?.toLowerCase() === sponsorNorm && isSui(ch.coinType)) {
                const amt = Number(ch.amount);
                if (!Number.isNaN(amt)) netMist += amt;
              }
            }
            setLastSponsorImpact({ digest: result.digest, netMist });
          } catch {
            setLastSponsorImpact(null);
          }
        }
        await refreshAfterExecute(executedActions);
        setSimulatedNetInflowByIndex({});
      } catch (e) {
        setExecuteError(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(safetyTimeoutId);
        clearExecuting();
      }
    },
    [account?.address, signTransaction, refreshAfterExecute]
  );

  const feedSkitty = React.useCallback(async () => {
    const raw = lastDryRunRawJson ?? '';
    const len = raw.length;
    const check = canRequestExplain(len);
    if (!check.allowed) {
      setGeminiError(check.reason ?? 'Cannot request explanation.');
      return;
    }
    setGeminiError(null);
    setGeminiLoading(true);
    try {
      let transactionData: unknown;
      try {
        transactionData = JSON.parse(raw);
      } catch {
        setGeminiError('Invalid JSON in simulation data.');
        return;
      }
      recordExplainRequest();
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionData }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error ?? `Request failed (${res.status})`;
        const retry = data?.retryAfterSeconds;
        setGeminiError(retry != null && retry > 0 ? `${msg} Try again in ${retry} seconds.` : msg);
        return;
      }
      setGeminiExplanation(data?.explanation ?? 'No explanation returned.');
    } catch (e) {
      setGeminiError(e instanceof Error ? e.message : 'Failed to get explanation');
    } finally {
      setGeminiLoading(false);
    }
  }, [lastDryRunRawJson]);

  const actionsByKind = React.useMemo(() => {
    const map = new Map<CleanupAction['kind'], { action: CleanupAction; index: number }[]>();
    state.actions.forEach((action, index) => {
      const list = map.get(action.kind) ?? [];
      list.push({ action, index });
      map.set(action.kind, list);
    });
    return map;
  }, [state.actions]);

  const kindOrder: CleanupAction['kind'][] = ['merge_coins', 'destroy_zero', 'close_kiosk', 'burn'];
  const kindTitles: Record<CleanupAction['kind'], string> = {
    merge_coins: 'Merge Coins',
    destroy_zero: 'Destroy Coins',
    close_kiosk: 'Close Kiosk',
    burn: 'Attempt Burn',
  };

  const kindDescriptions: Record<CleanupAction['kind'], string> = {
    merge_coins:
      'You have multiple coin objects of the same type. Merging combines them into one object, reducing on-chain storage.',
    destroy_zero:
      'These coin objects have zero balance. Destroying them reclaims the storage they occupy.',
    close_kiosk:
      'These kiosks have no listed items or place listings. Closing it returns the storage deposit. Only close if you are sure you no longer need the kiosk.',
    burn:
      'These objects have been detected to have some type of burn functionality. If successful, it permanently destroys the object and returns storage rebate. Only burn if you are sure.',
  };

  const showSelectAllForKind = (kind: CleanupAction['kind']) =>
    kind === 'merge_coins' || kind === 'destroy_zero';

  const selectAllForKind = (kind: CleanupAction['kind']) => {
    const items = actionsByKind.get(kind) ?? [];
    const indices = new Set(items.map(({ index }) => index));
    setSelectedActions((prev) => {
      const allSelected = indices.size > 0 && [...indices].every((i: number) => prev.has(i));
      if (allSelected) {
        const next = new Set(prev);
        indices.forEach((i) => next.delete(i));
        return next;
      }
      return new Set([...prev, ...indices]);
    });
  };

  const scannedAddressIsConnectedWallet = Boolean(
    account?.address &&
    state.scannedAddress &&
    account.address.toLowerCase() === state.scannedAddress.toLowerCase()
  );

  React.useEffect(() => {
    if (!scannedAddressIsConnectedWallet) setSelectedActions(new Set());
  }, [scannedAddressIsConnectedWallet]);

  return (
    <div className="min-h-screen flex flex-col bg-black font-body text-white selection:bg-skitty-accent selection:text-white">
      <header className="sticky top-0 z-40 border-b-3 border-black bg-skitty-accent/90 backdrop-blur-md shadow-[0_4px_0_#000]">
        <div className="mx-auto max-w-5xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <motion.div 
              initial={{ rotate: -10 }}
              animate={{ rotate: 10 }}
              transition={{ repeat: Infinity, repeatType: 'reverse', duration: 2 }}
              className="text-4xl filter drop-shadow-[2px_2px_0_#000]" 
              role="img" 
              aria-label="Skitty cat logo"
            >
              🐱
            </motion.div>
            <div className="flex flex-col">
              <h1 className="font-display font-black text-3xl text-black uppercase tracking-tighter leading-none text-white">SKITTY</h1>
              <span className="text-[10px] font-black uppercase tracking-[0.3em] text-white/60">Sui Reclaimer</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="[&_.btn]:!rounded-none [&_.btn]:!border-2 [&_.btn]:!border-black [&_.btn]:!bg-white [&_.btn]:!text-black [&_.btn]:!font-black [&_.btn]:!uppercase [&_.btn]:!shadow-brutal hover:[&_.btn]:!translate-x-[1px] hover:[&_.btn]:!translate-y-[1px] hover:[&_.btn]:!shadow-none transition-all">
              <KitConnectButton />
            </div>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {lastSponsorImpact != null && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mx-auto max-w-5xl px-6 py-2"
          >
            <div className="bg-white/10 border border-white/20 rounded-none p-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] font-black text-skitty-secondary uppercase tracking-widest">
                Sponsor net last tx:{' '}
                <span className={lastSponsorImpact.netMist >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {(lastSponsorImpact.netMist >= 0 ? '+' : '') + formatSui(lastSponsorImpact.netMist)} SUI
                </span>
              </span>
              <a
                href={`https://suivision.xyz/txblock/${lastSponsorImpact.digest}?tab=Changes`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-black text-skitty-accent hover:underline uppercase tracking-widest"
              >
                View changes →
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="mx-auto max-w-5xl px-6 py-12 space-y-12 pb-48">
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <Card className="bg-white/5 border-3 border-black shadow-[8px_8px_0_#9333ea]">
            <CardHeader>
              <CardTitle className="text-3xl">Scan Inventory</CardTitle>
              <CardDescription className="text-skitty-accent">
                Reclaim Your Sui. Recover storage rebates from objects and coins.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-wrap gap-4 items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (state.loading) return;
                  if (addressToUse) {
                    scan();
                  } else if (isSuiNSDomain(rawInput)) {
                    scanAfterResolveRef.current = true;
                  }
                }}
              >
                <div className="flex-1 min-w-[280px]">
                  <Input
                    label="Wallet Address or SuiNS domain"
                    placeholder={account?.address ?? '0x... or name.sui'}
                    value={manualAddress}
                    onChange={(e) => setManualAddress(e.target.value)}
                    aria-label="Enter Sui address or SuiNS domain"
                    className="bg-black/40 border-black"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={state.loading || !(addressToUse || isSuiNSDomain(rawInput))}
                >
                  {state.loading ? 'Scanning...' : resolvingSuiNS ? 'Resolving...' : 'Initiate Scan'}
                </Button>
              </form>
              
              <AnimatePresence>
                {suiNSError && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    key="suins-error"
                  >
                    <Alert variant="destructive" className="mt-4 border-2 border-black rounded-none bg-red-500/10">
                      <AlertDescription>{suiNSError}</AlertDescription>
                    </Alert>
                  </motion.div>
                )}
                {state.error && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    key="scan-error"
                  >
                    <Alert variant="destructive" className="mt-4 border-2 border-black rounded-none bg-red-500/10">
                      <AlertDescription>{state.error}</AlertDescription>
                    </Alert>
                  </motion.div>
                )}
              </AnimatePresence>

              {state.scannedAddress && !state.loading && (
                <div className="mt-6 flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase text-skitty-secondary">Current Target:</span>
                  <code className="bg-skitty-accent/20 text-skitty-accent px-2 py-1 text-xs font-bold border border-skitty-accent/30 uppercase tracking-wider">
                    {shortenAddress(state.scannedAddress, 12, 10)}
                  </code>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <WarningsBlock />

        {(state.loading || state.scanProgress != null) && (
          <ScanProgressPanel
            progress={state.scanProgress}
            exiting={false}
          />
        )}

        {!state.loading && state.scannedAddress && state.actions.length > 0 && (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="space-y-6"
          >
            <div className="flex flex-wrap items-end justify-between gap-4 border-b-3 border-black pb-4">
              <div>
                <h2 className="font-display font-black text-4xl uppercase tracking-tighter leading-none">Recoverable Assets</h2>
                <p className="text-xs font-black uppercase tracking-widest text-skitty-accent mt-2">
                  Est. net potential: {formatSui(state.actions.reduce((s, a) => s + Math.max(0, a.userRebateMist - computeFeeMist(Number(a.storageRebateTotal)) - a.estimatedGasMist), 0))} SUI
                </p>
                <p className="text-[9px] font-mono text-skitty-secondary/70 mt-0.5">
                  Based on current state; actual amounts at execution may differ.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {kindOrder.map((kind) => {
                const items = actionsByKind.get(kind) ?? [];
                if (items.length === 0) return null;
                return (
                  <motion.div
                    key={kind}
                    variants={itemVariants}
                    className="flex flex-col border-3 border-black bg-white/5 shadow-brutal min-h-0"
                  >
                    <div className="bg-black p-4 border-b-3 border-black flex flex-wrap justify-between items-center gap-2 shrink-0">
                      <h3 className="font-display font-black text-xl uppercase tracking-tighter text-white">
                        {kindTitles[kind]}
                      </h3>
                      <div className="flex items-center gap-2">
                        {scannedAddressIsConnectedWallet && showSelectAllForKind(kind) && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => selectAllForKind(kind)}
                            className="text-[10px] h-8 px-3"
                          >
                            Select All
                          </Button>
                        )}
                        <span className="bg-skitty-accent text-white text-[10px] font-black px-2 py-1 uppercase border border-black shadow-[2px_2px_0_#000]">
                          {items.length} Items
                        </span>
                      </div>
                    </div>
                    <ul className="action-panel-scroll overflow-y-auto flex-1 min-h-0 p-4 space-y-4 max-h-[450px]">
                      {items.map(({ action, index }) => (
                        <ActionCard
                          key={index}
                          action={action}
                          index={index}
                          selected={selectedActions.has(index)}
                          onToggle={() => toggleAction(index)}
                          shortLabel={shortLabelFromType(action.label ?? action.objectIds[0] ?? '')}
                          notEconomical={action.netGainMist < 0}
                          interactive={scannedAddressIsConnectedWallet}
                          showSimulate
                          simulatedNetInflowMist={simulatedNetInflowByIndex[index]}
                          onDryRun={() => runDryRunOne(action, index)}
                          onExecute={() => executeOne(action)}
                          executing={executing}
                          canSponsor={
                            action.userRebateMist >=
                            action.estimatedGasMist + computeFeeMist(Number(action.storageRebateTotal))
                          }
                        />
                      ))}
                    </ul>
                    <div className="shrink-0 border-t border-black/30 px-4 py-4 bg-black/20">
                      <p className="text-xs text-skitty-secondary/80 leading-relaxed">
                        {kindDescriptions[kind]}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}

        {!state.loading && state.scannedAddress && state.actions.length === 0 && state.error === null && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="p-16 border-3 border-black border-dashed text-center bg-white/5"
          >
            <p className="text-3xl font-black uppercase tracking-tighter text-skitty-secondary/40">
              Vault is Empty. No reclaimable objects found.
            </p>
          </motion.div>
        )}
      </main>

      <AnimatePresence>
        {scannedAddressIsConnectedWallet && selectedActions.size > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-0 right-0 z-50 px-6 flex justify-center pointer-events-none"
          >
            <FloatingCart
              selectedActionList={selectedActionList}
              totalSelectedRebateMist={totalSelectedRebateMist}
              burnedMist={burnedMist}
              feeMist={feeMist}
              dryRunResult={dryRunResult}
              executeError={executeError}
              runDryRun={runDryRun}
              execute={execute}
              onClearQueue={() => setSelectedActions(new Set())}
              onViewRawSimulation={() => setShowRawSimulation(true)}
              executing={executing}
              accountConnected={!!account?.address}
              canSponsor={canSponsorBatch}
              lastSponsorImpact={lastSponsorImpact}
              isMinimized={isCartMinimized}
              onToggleMinimize={() => setIsCartMinimized(!isCartMinimized)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="static md:fixed md:bottom-0 md:left-0 md:right-0 z-30 border-t-[1px] border-skitty-accent/95 bg-white/15 backdrop-blur-sm">
        <div className="mx-auto max-w-5xl px-6 pt-2 pb-1 flex flex-wrap items-center justify-between gap-4">
          <a
            href="https://x.com/kitty4dhd"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 hover:opacity-90 transition-opacity"
          >
            <span className="relative inline-block h-[60px] overflow-hidden">
              <img
                src="/kitty4dlogo.png"
                alt="kitty4d"
                className="h-[60px] w-auto object-contain block"
              />
              <motion.div
                className="absolute inset-0 z-10 pointer-events-none"
                style={{
                  maskImage: 'url(/kitty4dlogo.png)',
                  maskSize: 'contain',
                  maskPosition: 'center',
                  maskRepeat: 'no-repeat',
                  WebkitMaskImage: 'url(/kitty4dlogo.png)',
                  WebkitMaskSize: 'contain',
                  WebkitMaskPosition: 'center',
                  WebkitMaskRepeat: 'no-repeat',
                }}
                initial={false}
                aria-hidden
              >
                <motion.div
                  className="absolute inset-y-0 w-[70%]"
                  style={{
                    background: 'linear-gradient(90deg, transparent 0%, rgba(180, 195, 255, 0.4) 20%, rgba(208, 120, 255, 0.64) 50%, rgba(180, 255, 254, 0.4) 80%, transparent 100%)',
                    boxShadow: '0 0 30px 15px rgba(90, 109, 255, 0.2)',
                  }}
                  animate={{ x: ['-120%', '220%'] }}
                  transition={{
                    duration: 5,
                    repeat: Infinity,
                    repeatDelay: 1.5,
                    ease: 'easeInOut',
                  }}
                />
              </motion.div>
            </span>
          </a>
          <div className="flex flex-row items-center gap-4">
            <div className="flex items-center gap-3 shrink-0" aria-label="Social links">
              <a
                href="https://github.com/kitty4D/skitty"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/80 hover:text-skitty-accent transition-colors"
                aria-label="GitHub"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
              <a
                href="https://x.com/kitty4dhd"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/80 hover:text-skitty-accent transition-colors"
                aria-label="X (Twitter)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </div>
            <div className="flex flex-col items-end text-right">
              <p className="text-sm font-medium text-white">
                made w love by{' '}
                <a
                  href="https://x.com/kitty4dhd"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-skitty-accent hover:underline"
                >
                  kitty4d
                </a>
                {' '}& robot frens
              </p>
              <p className="text-xs text-white/50 text-right">ty robot frens &lt;3</p>
            </div>
          </div>
        </div>
      </footer>

      <AnimatePresence>
        {simulationModal !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70"
            onClick={() => setSimulationModal(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="bg-black border-3 border-skitty-accent shadow-[8px_8px_0_#000] p-6 max-w-sm w-full"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-display font-black text-xl uppercase tracking-tighter text-white mb-4">
                Simulation result
              </h3>
              {simulationModal.error ? (
                <div className="space-y-1 mb-4">
                  <p className="text-sm font-black uppercase tracking-widest text-red-500">ERROR SIMULATING</p>
                  <p className="text-sm text-red-400 font-medium break-words">{simulationModal.error}</p>
                </div>
              ) : (
                <div className="space-y-2 mb-4">
                  <p className="text-xs font-black text-skitty-accent uppercase tracking-widest">
                    Est. net inflow
                  </p>
                  <p className="text-skitty-accent font-black text-lg">
                    {simulationModal.netInflowMist !== undefined
                      ? (simulationModal.netInflowMist >= 0 ? '+' : '') + formatSui(simulationModal.netInflowMist) + ' SUI'
                      : formatSui(simulationModal.netGainMist ?? 0) + ' SUI'}
                  </p>
                  <p className="text-xs font-black text-skitty-secondary uppercase tracking-widest mt-3">
                    Gas cost (est.)
                  </p>
                  <p className="text-white font-black">{(simulationModal.gasCostMist ?? 0) >= 0 ? '-' : '+'}{formatSui(Math.abs(simulationModal.gasCostMist ?? 0))} SUI</p>
                  <p className="text-[9px] font-mono text-skitty-secondary/80 mt-2">
                    Actual amounts at execution may differ. Review in your wallet before approving.
                  </p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs font-black uppercase tracking-widest text-skitty-accent hover:bg-skitty-accent hover:text-black"
                  onClick={() => setShowRawSimulation(true)}
                >
                  View Raw Simulation
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setSimulationModal(null)}
                >
                  Close
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRawSimulation && (() => {
          const rawLen = (lastDryRunRawJson ?? '').length;
          const explainCheck = canRequestExplain(rawLen);
          const explainDisabled = geminiLoading || geminiExplanation != null || !explainCheck.allowed;
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/80"
              onClick={() => setShowRawSimulation(false)}
            >
              <motion.div
                initial={{ scale: 0.95 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.95 }}
                className="bg-black border-3 border-skitty-accent shadow-[8px_8px_0_#000] w-full max-w-2xl max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 p-3 border-b-2 border-skitty-accent/30">
                  <span className="font-display font-black text-sm uppercase tracking-tighter text-white">
                    Raw simulation
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => !explainDisabled && feedSkitty()}
                      disabled={explainDisabled}
                      title={explainDisabled && explainCheck.allowed === false ? explainCheck.reason : undefined}
                      className={cn(
                        'flex items-center gap-2 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest border-2 transition-colors rounded',
                        explainDisabled
                          ? 'border-white/20 text-white/40 cursor-not-allowed'
                          : 'border-skitty-accent text-skitty-accent hover:bg-skitty-accent hover:text-black'
                      )}
                    >
                      <img src="/Google_Gemini.svg" alt="" className="h-4 w-4 object-contain" />
                      FEED SKITTY FOR AN EASIER TRANSLATION
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRawSimulation(false)}
                      className="p-2 text-skitty-accent hover:text-white hover:bg-skitty-accent transition-colors rounded"
                      title="Close"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-auto flex flex-col">
                  {geminiLoading && (
                    <div className="p-4 text-skitty-accent text-sm font-medium border-b border-skitty-accent/30">
                      Feeding Skitty… one moment 😺
                    </div>
                  )}
                  {geminiError && !geminiLoading && (
                    <div className="p-4 text-red-400 text-sm border-b border-skitty-accent/30">
                      {geminiError}
                    </div>
                  )}
                  {geminiExplanation && !geminiLoading && (
                    <>
                      <div className="p-3 border-b border-skitty-accent/20 bg-black/40 text-[10px] text-skitty-secondary/90 font-mono leading-relaxed tracking-wide">
                        AI-Assisted Info: Estimates and info provided by Gemini are for convenience only and are based on a transaction simulation (dry run). Actual rebates are determined by the Sui Network at time of execution. Always review the transaction summary in your wallet before approving.
                      </div>
                      <div className="p-4 border-b-2 border-skitty-accent/30 bg-white/5 text-sm text-white whitespace-pre-wrap font-sans">
                        {geminiExplanation}
                      </div>
                    </>
                  )}
                  <textarea
                    readOnly
                    value={lastDryRunRawJson ?? ''}
                    className="flex-1 min-h-[200px] w-full p-4 font-mono text-xs text-skitty-secondary bg-black border-0 resize-none focus:outline-none focus:ring-0 overflow-auto"
                  />
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
