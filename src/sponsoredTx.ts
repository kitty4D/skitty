import { Transaction } from '@mysten/sui/transactions';
import { buildBatchTransaction, type BuildBatchResult } from './buildCleanupTransaction';
import { graphQLClient } from './graphql/client';
import { bytesToBase64, base64ToBytes } from './utils/format';
import type { CleanupAction } from './types';

// The batch and single-action flows used to be four near-identical copies of this
// pipeline, which meant every fix had to be applied four times. They all live here now.

export interface SponsorResponse {
  sponsoredTxBytes: string;
  sponsorSignature?: string;
  sponsorAddress: string;
}

async function requestSponsorship(
  kindBytes: Uint8Array,
  userAddress: string,
  simulateOnly: boolean
): Promise<SponsorResponse> {
  const res = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txBytes: bytesToBase64(kindBytes),
      userAddress,
      simulateOnly,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error ?? `Sponsor API ${res.status}`);
  }
  if (!body?.sponsoredTxBytes) throw new Error('Invalid sponsor response');
  if (!simulateOnly && !body?.sponsorSignature) throw new Error('Invalid sponsor response');
  return body as SponsorResponse;
}

async function buildKindBytes(
  actions: CleanupAction[],
  senderAddress: string,
  /** null lets the build estimate gas from the actions that fit under the batch cap */
  gasMist: number | null
): Promise<{ build: BuildBatchResult; kindBytes: Uint8Array }> {
  const build = buildBatchTransaction(actions, {
    sponsoredGas: true,
    senderAddress,
    estimatedGasMist: gasMist,
  });
  build.tx.setSender(senderAddress);
  const bytes = await build.tx.build({ client: graphQLClient, onlyTransactionKind: true });
  return {
    build,
    kindBytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  };
}

interface GasUsedLike {
  computationCost?: string | number | bigint;
  storageCost?: string | number | bigint;
  storageRebate?: string | number | bigint;
}

/**
 * What the gas coin is charged before any rebate flows back into it.
 *
 * The rebate must NOT be netted off here: it is already being paid out to the user in
 * full via userRebateMist, so subtracting it again would have the sponsor recoup less
 * than it fronts. For a reclaim batch the rebate exceeds computation + storage, so the
 * netted figure is negative and the sponsor silently eats the difference.
 */
function grossGasCost(gasUsed: GasUsedLike | undefined | null): number {
  return Number(gasUsed?.computationCost ?? 0) + Number(gasUsed?.storageCost ?? 0);
}

/** what the transaction nets out at, for display */
function netGasCost(gasUsed: GasUsedLike | undefined | null): number {
  return grossGasCost(gasUsed) - Number(gasUsed?.storageRebate ?? 0);
}

// ExecutionError is a structured object; the UI wants one readable line
function executionErrorMessage(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Transaction would fail on-chain.';
}

const isSuiCoinType = (type: string | undefined | null) =>
  type != null && /^0x0*2::sui::sui$/i.test(type.replace(/^0x0+/, '0x'));

function netSuiFor(
  balanceChanges: { address?: string; coinType?: string; amount?: string }[] | undefined,
  address: string
): number | undefined {
  if (!balanceChanges) return undefined;
  const target = address.toLowerCase();
  let net: number | undefined;
  for (const change of balanceChanges) {
    if (change.address?.toLowerCase() !== target) continue;
    if (!isSuiCoinType(change.coinType)) continue;
    const amount = Number(change.amount);
    if (!Number.isNaN(amount)) net = (net ?? 0) + amount;
  }
  return net;
}

export interface SimulationOutcome {
  build: BuildBatchResult;
  gasCostMist: number;
  /** actual SUI the sender gains, straight from the simulated balance changes */
  netInflowMist?: number;
  /** rebate - gas - fee, used when balance changes are unavailable */
  netGainMist: number;
  success: boolean;
  executionError: string | null;
  rawJson: string;
}

/**
 * Build, sponsor (without a signature) and simulate — the read-only path behind the
 * SIMULATE buttons. Nothing here can move funds.
 */
export async function simulateActions(
  actions: CleanupAction[],
  senderAddress: string
): Promise<SimulationOutcome> {
  // gas comes from the build's own estimate over the actions that fit under the cap
  const { build, kindBytes } = await buildKindBytes(actions, senderAddress, null);
  const { sponsoredTxBytes } = await requestSponsorship(kindBytes, senderAddress, true);

  const result = await graphQLClient.simulateTransaction({
    transaction: base64ToBytes(sponsoredTxBytes),
    include: { effects: true, balanceChanges: true },
  });
  const rawJson = JSON.stringify(
    {
      request: {
        transactionBytesBase64: sponsoredTxBytes,
        include: { effects: true, balanceChanges: true },
      },
      response: result,
    },
    null,
    2
  );

  const txResult = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
  const effects = txResult?.effects;
  if (!effects) {
    throw new Error('No effects from dry run.');
  }
  // display uses the net figure (what the transaction costs after the rebate lands)
  const gasCostMist = netGasCost(effects.gasUsed);
  const netGainMist = build.userRebateMist - build.gasMist - build.feeMist;
  const netInflowMist = netSuiFor(txResult?.balanceChanges, senderAddress);

  return {
    build,
    gasCostMist,
    netInflowMist,
    netGainMist,
    success: result.$kind === 'Transaction' && Boolean(txResult?.status?.success),
    executionError: executionErrorMessage(txResult?.status?.error),
    rawJson,
  };
}

export interface ExecuteOutcome {
  digest: string;
  executedActions: CleanupAction[];
  sponsorAddress: string;
  sponsorNetMist: number | null;
  /** the transaction landed but we stopped waiting for finality */
  pending: boolean;
}

export type SignTransaction = (input: {
  transaction: Transaction;
}) => Promise<{ bytes: string; signature: string }>;

function friendlyBuildError(error: unknown): string {
  if (error instanceof Error && error.message.includes('does not cover')) {
    return "These actions don't cover gas and the service fee, so they won't be sponsored.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Simulate for real gas, rebuild so the sponsor recoups exactly what it spends, get
 * the sponsor signature, have the user sign, and submit.
 */
export async function executeActions(
  actions: CleanupAction[],
  senderAddress: string,
  signTransaction: SignTransaction
): Promise<ExecuteOutcome> {
  // 1) draft: sponsor without a signature purely to measure gas. The build derives its
  //    own estimate from the actions that fit under the batch cap.
  let draft;
  try {
    draft = await buildKindBytes(actions, senderAddress, null);
  } catch (error) {
    throw new Error(friendlyBuildError(error));
  }
  const { sponsoredTxBytes: draftBytes } = await requestSponsorship(
    draft.kindBytes,
    senderAddress,
    true
  );
  const simResult = await graphQLClient.simulateTransaction({
    transaction: base64ToBytes(draftBytes),
    include: { effects: true },
  });
  const simTx =
    simResult.$kind === 'Transaction' ? simResult.Transaction : simResult.FailedTransaction;
  if (!simTx?.effects?.gasUsed) throw new Error('Dry run failed or no gas data.');
  if (simResult.$kind !== 'Transaction' || !simTx.status?.success) {
    throw new Error(
      executionErrorMessage(simTx.status?.error) ?? 'Transaction would fail on-chain.'
    );
  }
  // Recoup the GROSS cost the gas coin fronts. The storage rebate is already returned
  // to the user through userRebateMist, so netting it off here would have the sponsor
  // pay for the transaction twice.
  const gasRecoupMist = Math.max(grossGasCost(simTx.effects.gasUsed), draft.build.gasMist);

  // 2) rebuild with the real gas figure. buildBatchTransaction throws when the
  //    rebate cannot cover gas plus fee, which is the check we want before signing.
  let final;
  try {
    final = await buildKindBytes(actions, senderAddress, gasRecoupMist);
  } catch (error) {
    throw new Error(friendlyBuildError(error));
  }

  const { sponsoredTxBytes, sponsorSignature, sponsorAddress } = await requestSponsorship(
    final.kindBytes,
    senderAddress,
    false
  );

  const txToSign = Transaction.from(sponsoredTxBytes);
  const { bytes: signedTxBytes, signature: userSignature } = await signTransaction({
    transaction: txToSign,
  });

  const result = await graphQLClient.executeTransaction({
    transaction: base64ToBytes(signedTxBytes),
    signatures: [sponsorSignature!, userSignature],
    include: { effects: true, balanceChanges: true },
  });
  const executed =
    result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;

  // An on-chain abort is a successful submission, not a rejected request, so without
  // this check a failed purge looks exactly like a successful one.
  if (result.$kind !== 'Transaction' || !executed?.status?.success) {
    throw new Error(
      executionErrorMessage(executed?.status?.error) ?? 'Transaction failed on-chain.'
    );
  }
  const digest = executed.digest;
  if (!digest) throw new Error('No transaction digest returned.');

  const sponsorNetMist = netSuiFor(executed.balanceChanges, sponsorAddress) ?? 0;

  let pending = false;
  try {
    await graphQLClient.waitForTransaction({ digest, timeout: 30_000 });
  } catch {
    // it was accepted; we just stopped waiting for finality
    pending = true;
  }

  return {
    digest,
    // only what the PTB actually contained — anything the batch cap dropped is still
    // in the user's wallet and must stay in the list
    executedActions: [...final.build.includedActions],
    sponsorAddress,
    sponsorNetMist,
    pending,
  };
}
