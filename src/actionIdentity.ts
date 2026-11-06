import type { CleanupAction } from './types';
import { normalizeSuiObjectId } from '@mysten/sui/utils';

export function bulkSelectableActions(actions: CleanupAction[]): CleanupAction[] {
  return actions.filter(action => !action.walletWarning);
}

// alternative actions consume the same objects. a new choice replaces conflicting
// selections so the queue never promises two rebates for deleting one coin.
export function selectActionKeys(
  actions: CleanupAction[], selected: Set<string>, additions: CleanupAction[]
): Set<string> {
  const consumed = new Set(additions.flatMap((action) => action.objectIds.map((id) => normalizeSuiObjectId(id))));
  const conflicts = new Set(actions.filter((action) =>
    action.objectIds.some((id) => consumed.has(normalizeSuiObjectId(id)))
  ).map(actionKey));
  return new Set([...selected].filter((key) => !conflicts.has(key)).concat(additions.map(actionKey)));
}

// Actions were previously tracked by their position in the scan results. A re-scan
// replaces that array wholesale, so index 2 could silently become a different action
// while it was still sitting selected in the cart - including an irreversible burn the
// user never chose. Identity has to come from the objects the action touches.
export function actionKey(action: CleanupAction): string {
  return `${action.kind}:${action.objectIds.slice().sort().join(',')}`;
}

// keys can be long (a merge names every coin), so hash for DOM ids
export function actionDomId(action: CleanupAction): string {
  const key = actionKey(action);
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return `action-${action.kind}-${(hash >>> 0).toString(36)}`;
}
