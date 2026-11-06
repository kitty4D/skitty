export type CleanupActionKind = 'merge_coins' | 'keep_tokens' | 'destroy_zero' | 'close_kiosk' | 'burn' | 'empty_container' | 'expired_walrus' | 'withdraw_kiosk' | 'revoke_allowance';

export interface CleanupActionBase {
  kind: CleanupActionKind;
  objectIds: string[];
  /** sum of storage rebates (raw) for involved objects */
  storageRebateTotal: string;
  /** per-object storage rebate; order matches objectIds. Needed to work out what a
   * partially-included action actually realizes (merges keep their primary alive). */
  objectStorageRebates?: string[];
  /** user rebate = storageRebateTotal * 0.99 (mist) */
  userRebateMist: number;
  /** estimated gas (mist) for this action */
  estimatedGasMist: number;
  /** net gain (mist) = userRebateMist - estimatedGasMist; negative = not worth it */
  netGainMist: number;
  /** optional label (e.g. coin type for merges, kiosk id for kiosks) */
  label?: string;
  /** withdrawals don't earn a storage rebate and must pay their own gas */
  selfPaidOnly?: boolean;
}

export interface MergeCoinsAction extends CleanupActionBase {
  kind: 'merge_coins';
  coinType: string;
  label: string;
  /** per-object balance (mist) for display; order matches objectIds */
  objectBalances?: string[];
  tokenSymbol?: string;
  tokenDecimals?: number;
}

export interface KeepTokensAction extends CleanupActionBase {
  kind: 'keep_tokens';
  coinType: string;
  label: string;
  objectBalances?: string[];
  tokenSymbol?: string;
  tokenDecimals?: number;
}

export interface DestroyZeroAction extends CleanupActionBase {
  kind: 'destroy_zero';
  coinType: string;
  label: string;
}

export interface CloseKioskAction extends CleanupActionBase {
  kind: 'close_kiosk';
  kioskId: string;
  ownerCapId: string;
  /** SUI (mist) the kiosk has accrued from sales; paid out to the owner on close */
  profitsMist?: number;
  label: string;
}

export interface BurnAction extends CleanupActionBase {
  kind: 'burn';
  objectType: string;
  /** moveCall target for burn/delete */
  moveTarget: string;
  /** true if we found it via getNormalizedMoveModule (not KNOWN_BURNABLE) */
  discovered?: boolean;
  label: string;
}

export interface ContainerAction extends CleanupActionBase {
  kind: 'empty_container';
  objectType: string;
  moveTarget: string;
  typeArguments: string[];
  details: string[];
}

export interface WithdrawKioskAction extends CleanupActionBase {
  kind: 'withdraw_kiosk';
  kioskId: string;
  ownerCapId: string;
  proceedsMist: string;
  details: string[];
}

export type CleanupAction = MergeCoinsAction | KeepTokensAction | DestroyZeroAction | CloseKioskAction | BurnAction | ContainerAction | WithdrawKioskAction | import('./receiptDiscovery').ReceiptAction;

export interface ScanProgress {
  phase: string;
  current: number;
  total: number;
}

export interface ScannerState {
  warnings?: string[];
  loading: boolean;
  error: string | null;
  actions: CleanupAction[];
  /** total estimated user rebate (mist) across all actions */
  totalUserRebateMist: number;
  /** address that was scanned */
  scannedAddress: string | null;
  /** set while scan in progress; null when idle or done */
  scanProgress: ScanProgress | null;
}
