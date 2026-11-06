import { expect, it } from 'vitest';
import { selectActionKeys, actionKey, bulkSelectableActions } from './actionIdentity';
import type { CleanupAction } from './types';

const merge: CleanupAction = {
  kind: 'merge_coins', coinType: '0x2::coin::Coin<0xabc::t::T>',
  label: 'T', objectIds: ['0xa', '0xb'], storageRebateTotal: '1000',
  userRebateMist: 990, estimatedGasMist: 1, netGainMist: 989,
};
const keep: CleanupAction = { ...merge, kind: 'keep_tokens', objectIds: ['0xb'] };

it('unhidden flagged actions stay outside bulk selection but remain individually selectable', () => {
  const flagged: CleanupAction = {...keep,objectIds:['0xc'],walletWarning:'reported blocked by Slush'};
  const actions=[keep,flagged];
  expect(bulkSelectableActions(actions)).toEqual([keep]);
  const bulk=selectActionKeys(actions,new Set(),bulkSelectableActions(actions));
  expect(bulk.has(actionKey(flagged))).toBe(false);
  expect(selectActionKeys(actions,bulk,[flagged])).toEqual(new Set([actionKey(keep),actionKey(flagged)]));
});

it('choosing keep tokens replaces an overlapping merge selection', () => {
  expect([...selectActionKeys([merge, keep], new Set([actionKey(merge)]), [keep])])
    .toEqual([actionKey(keep)]);
});

it('choosing merge replaces an overlapping keep selection', () => {
  expect([...selectActionKeys([merge, keep], new Set([actionKey(keep)]), [merge])])
    .toEqual([actionKey(merge)]);
});

it('keeps nonoverlapping selections during a bulk selection', () => {
  const other: CleanupAction = { ...keep, objectIds: ['0xc'] };
  expect(selectActionKeys([merge, keep, other], new Set([actionKey(other)]), [merge]))
    .toEqual(new Set([actionKey(other), actionKey(merge)]));
});
