import { Transaction } from '@mysten/sui/transactions';
import {
  buildBatchTransaction,
  type BuildBatchResult,
  type SelfPaidGasSource,
} from './buildCleanupTransaction';
import { graphQLClient } from './graphql/client';
import { bytesToBase64, base64ToBytes, formatSui } from './utils/format';
import {
  SUI_COIN_TYPE_ARG,
  SELF_PAY_MIN_GAS_BUDGET_MIST,
  SELF_PAY_GAS_BUDGET_MARGIN,
  SELF_PAY_DRAFT_GAS_BUDGET_MIST,
  SELF_PAY_MAX_GAS_COINS,
} from './constants';
import type { CleanupAction } from './types';

// every simulate and execute flow goes through here, sponsored or self-paid. there used
// to be four copies of this pipeline, and every fix had to land four times.

/**
 * who pays gas. the sponsor does by default; while it's out of SUI the user's own
 * wallet does, which is exactly what a wallet with no SUI can't do.
 */
export type GasMode = 'sponsored' | 'self';

export interface SponsorResponse {
  sponsoredTxBytes: string;
  sponsorSignature?: string;
  sponsorAddress: string;
}

/**
 * the sponsor refused for an operational reason, not because the transaction was bad.
 * `code` is what the API sent, and it decides whether the UI falls back to self-paid gas.
 */
export class SponsorUnavailableError extends Error {
  readonly code: string;
  readonly sponsorAddress: string | null;

  constructor(message: string, code: string, sponsorAddress: string | null) {
    super(message);
    this.name = 'SponsorUnavailableError';
    this.code = code;
    this.sponsorAddress = sponsorAddress;
  }
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
    if (res.status === 503 && typeof body?.code === 'string') {
      throw new SponsorUnavailableError(
        body?.error ?? 'The gas sponsor is unavailable.',
        body.code,
        typeof body?.sponsorAddress === 'string' ? body.sponsorAddress : null
      );
    }
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

// ---- self-paid gas ----

export interface SuiHoldings {
  /** the coins a self-paid transaction hands over as its gas payment */
  coins: { objectId: string; version: string; digest: string }[];
  /** what exactly those coins hold, which is what tx.gas starts with */
  coinTotalMist: number;
  addressBalanceMist: number;
}

export async function fetchSuiHoldings(owner: string): Promise<SuiHoldings> {
  const [coinPage, balance] = await Promise.all([
    graphQLClient.listCoins({ owner, coinType: SUI_COIN_TYPE_ARG, limit: SELF_PAY_MAX_GAS_COINS }),
    graphQLClient.getBalance({ owner, coinType: SUI_COIN_TYPE_ARG }),
  ]);
  const funded = coinPage.objects.filter((coin) => BigInt(coin.balance) > 0n);
  return {
    coins: funded.map(({ objectId, version, digest }) => ({ objectId, version, digest })),
    coinTotalMist: Number(funded.reduce((sum, coin) => sum + BigInt(coin.balance), 0n)),
    addressBalanceMist: Number(balance.balance.addressBalance ?? 0),
  };
}

/**
 * gas comes from one source, never both, so what a wallet can actually spend on a
 * transaction is whichever holds more. most wallets funded by a recent transfer hold
 * everything as an address balance and own no usable coins at all.
 */
export function selfPaidGasSource(holdings: SuiHoldings): {
  source: SelfPaidGasSource;
  availableMist: number;
} {
  return holdings.addressBalanceMist >= holdings.coinTotalMist
    ? { source: 'addressBalance', availableMist: holdings.addressBalanceMist }
    : { source: 'gasCoin', availableMist: holdings.coinTotalMist };
}

function notEnoughSuiForGas(availableMist: number, neededMist: number): string {
  if (availableMist <= 0) {
    return "This wallet has no SUI to pay gas, and the gas sponsor is out of SUI. It can't run anything until the sponsor is topped up.";
  }
  return `This wallet needs about ${formatSui(neededMist)} SUI for gas but only has ${formatSui(availableMist)}, and the gas sponsor is out of SUI.`;
}

interface SelfPaidPlan {
  build: BuildBatchResult;
  /** fully resolved: exactly what gets simulated, and exactly what the wallet signs */
  bytes: Uint8Array;
}

async function planSelfPaid(actions: CleanupAction[], sender: string): Promise<SelfPaidPlan> {
  const holdings = await fetchSuiHoldings(sender);
  const { source, availableMist } = selfPaidGasSource(holdings);
  if (availableMist < SELF_PAY_MIN_GAS_BUDGET_MIST) {
    throw new Error(notEnoughSuiForGas(availableMist, SELF_PAY_MIN_GAS_BUDGET_MIST));
  }

  // 1) measure. simulation never checks an empty payment against the payer, so this
  //    prices the batch before we've committed to a budget. the fee's already in at
  //    about its final size, so its commands get priced along with everything else.
  const draft = buildBatchTransaction(actions, {
    sponsoredGas: false,
    senderAddress: sender,
    selfPaidFee: { source, maxMist: availableMist - SELF_PAY_MIN_GAS_BUDGET_MIST },
  });
  draft.tx.setSender(sender);
  draft.tx.setGasBudget(SELF_PAY_DRAFT_GAS_BUDGET_MIST);
  draft.tx.setGasPayment([]);
  const draftResult = await graphQLClient.simulateTransaction({
    transaction: await draft.tx.build({ client: graphQLClient }),
    include: { effects: true },
  });
  const draftTx =
    draftResult.$kind === 'Transaction' ? draftResult.Transaction : draftResult.FailedTransaction;
  if (draftResult.$kind !== 'Transaction' || !draftTx?.status?.success || !draftTx.effects?.gasUsed) {
    throw new Error(
      executionErrorMessage(draftTx?.status?.error) ?? 'Transaction would fail on-chain.'
    );
  }
  const grossGasMist = grossGasCost(draftTx.effects.gasUsed);
  const budgetMist = Math.max(
    SELF_PAY_MIN_GAS_BUDGET_MIST,
    Math.ceil(grossGasMist * SELF_PAY_GAS_BUDGET_MARGIN)
  );
  if (availableMist < budgetMist) {
    throw new Error(notEnoughSuiForGas(availableMist, budgetMist));
  }

  // 2) the real one, with the fee capped at whatever's left after the budget
  const build = buildBatchTransaction(actions, {
    sponsoredGas: false,
    senderAddress: sender,
    estimatedGasMist: grossGasMist,
    selfPaidFee: { source, maxMist: availableMist - budgetMist },
  });
  build.tx.setSender(sender);
  build.tx.setGasBudget(budgetMist);
  // coins get pinned so the fee cap matches exactly what tx.gas holds. the address
  // balance route is left to the resolver, which checks budget + fee against the real
  // balance before it hands back an empty payment.
  if (source === 'gasCoin') build.tx.setGasPayment(holdings.coins);
  const bytes = await build.tx.build({ client: graphQLClient });
  return { build, bytes };
}

// ---- simulate ----

export interface SimulationOutcome {
  build: BuildBatchResult;
  gasMode: GasMode;
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
 * build, get it paid for (sponsor without a signature, or the user's own gas) and
 * simulate. the read-only path behind the simulate buttons; nothing here moves funds.
 */
export async function simulateActions(
  actions: CleanupAction[],
  senderAddress: string,
  gasMode: GasMode = 'sponsored'
): Promise<SimulationOutcome> {
  let build: BuildBatchResult;
  let txBytes: Uint8Array;
  if (gasMode === 'self') {
    ({ build, bytes: txBytes } = await planSelfPaid(actions, senderAddress));
  } else {
    // gas comes from the build's own estimate over the actions that fit under the cap
    const kind = await buildKindBytes(actions, senderAddress, null);
    build = kind.build;
    const { sponsoredTxBytes } = await requestSponsorship(kind.kindBytes, senderAddress, true);
    txBytes = base64ToBytes(sponsoredTxBytes);
  }

  const result = await graphQLClient.simulateTransaction({
    transaction: txBytes,
    include: { effects: true, balanceChanges: true },
  });
  const rawJson = JSON.stringify(
    {
      request: {
        gasMode,
        transactionBytesBase64: bytesToBase64(txBytes),
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
    gasMode,
    gasCostMist,
    netInflowMist,
    netGainMist,
    success: result.$kind === 'Transaction' && Boolean(txResult?.status?.success),
    executionError: executionErrorMessage(txResult?.status?.error),
    rawJson,
  };
}

// ---- execute ----

export interface ExecuteOutcome {
  digest: string;
  executedActions: CleanupAction[];
  /** null when the user paid their own gas */
  sponsorAddress: string | null;
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

/** submit, refuse to call an on-chain abort a success, and wait (briefly) for finality */
async function submitSigned(
  signedTxBytes: string,
  signatures: string[]
): Promise<{
  digest: string;
  balanceChanges: { address?: string; coinType?: string; amount?: string }[] | undefined;
  pending: boolean;
}> {
  const result = await graphQLClient.executeTransaction({
    transaction: base64ToBytes(signedTxBytes),
    signatures,
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

  let pending = false;
  try {
    await graphQLClient.waitForTransaction({ digest, timeout: 30_000 });
  } catch {
    // it was accepted; we just stopped waiting for finality
    pending = true;
  }
  return { digest, balanceChanges: executed.balanceChanges, pending };
}

async function executeSelfPaid(
  actions: CleanupAction[],
  senderAddress: string,
  signTransaction: SignTransaction
): Promise<ExecuteOutcome> {
  const { build, bytes } = await planSelfPaid(actions, senderAddress);

  // the same check the sponsor runs before it signs: don't put something in front of
  // the wallet that's going to abort and bill the user for it
  const preflight = await graphQLClient.simulateTransaction({
    transaction: bytes,
    include: { effects: true },
  });
  const preflightTx =
    preflight.$kind === 'Transaction' ? preflight.Transaction : preflight.FailedTransaction;
  if (preflight.$kind !== 'Transaction' || !preflightTx?.status?.success) {
    throw new Error(
      executionErrorMessage(preflightTx?.status?.error) ?? 'Transaction would fail on-chain.'
    );
  }

  const { bytes: signedTxBytes, signature } = await signTransaction({
    transaction: Transaction.from(bytes),
  });
  const { digest, pending } = await submitSigned(signedTxBytes, [signature]);
  return {
    digest,
    executedActions: [...build.includedActions],
    sponsorAddress: null,
    sponsorNetMist: null,
    pending,
  };
}

/**
 * sponsored: simulate for real gas, rebuild so the sponsor recoups exactly what it
 * spends, get the sponsor signature, have the user sign, and submit. self-paid: measure,
 * pin the budget, have the user sign, and submit.
 */
export async function executeActions(
  actions: CleanupAction[],
  senderAddress: string,
  signTransaction: SignTransaction,
  gasMode: GasMode = 'sponsored'
): Promise<ExecuteOutcome> {
  if (gasMode === 'self') return executeSelfPaid(actions, senderAddress, signTransaction);

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

  const { bytes: signedTxBytes, signature: userSignature } = await signTransaction({
    transaction: Transaction.from(sponsoredTxBytes),
  });
  const { digest, balanceChanges, pending } = await submitSigned(signedTxBytes, [
    sponsorSignature!,
    userSignature,
  ]);

  return {
    digest,
    // only what the PTB actually contained: anything the batch cap dropped is still
    // in the user's wallet and must stay in the list
    executedActions: [...final.build.includedActions],
    sponsorAddress,
    sponsorNetMist: netSuiFor(balanceChanges, sponsorAddress) ?? 0,
    pending,
  };
}
