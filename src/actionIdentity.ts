import type { CleanupAction } from './types';

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
