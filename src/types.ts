export type CleanupActionKind = 'merge_coins' | 'destroy_zero' | 'close_kiosk' | 'burn';

export interface CleanupActionBase {
  kind: CleanupActionKind;
  objectIds: string[];
  /** sum of storage rebates (raw) for involved objects */
  storageRebateTotal: string;
  /** user rebate = storageRebateTotal * 0.99 (mist) */
  userRebateMist: number;
  /** estimated gas (mist) for this action */
  estimatedGasMist: number;
  /** net gain (mist) = userRebateMist - estimatedGasMist; negative = not worth it */
  netGainMist: number;
  /** optional label (e.g. coin type for merges, kiosk id for kiosks) */
  label?: string;
}

export interface MergeCoinsAction extends CleanupActionBase {
  kind: 'merge_coins';
  coinType: string;
  label: string;
  /** per-object balance (mist) for display; order matches objectIds */
  objectBalances?: string[];
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

export type CleanupAction = MergeCoinsAction | DestroyZeroAction | CloseKioskAction | BurnAction;

export interface ScanProgress {
  phase: string;
  current: number;
  total: number;
}

export interface ScannerState {
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
