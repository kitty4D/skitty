import { normalizeSuiObjectId } from '@mysten/sui/utils';
import { isSameMoveType, SUI_COIN_TYPE_ARG } from './constants';
import { getCoinTypeArg } from './walletBlocklist';
import type { CleanupAction } from './types';

export interface GasHoldings {
  coins: { objectId: string; version: string; digest: string; balanceMist: number }[];
  coinTotalMist: number;
  addressBalanceMist: number;
}

export function selectCleanupGas(actions: CleanupAction[], holdings: GasHoldings, budgetMist: number) {
  const touchesSui = actions.some((action) =>
    'coinType' in action && isSameMoveType(getCoinTypeArg(action.coinType), SUI_COIN_TYPE_ARG)
  );
  const useBalance = holdings.addressBalanceMist >= budgetMist &&
    (touchesSui || holdings.addressBalanceMist >= holdings.coinTotalMist);
  if (useBalance) {
    return { source: 'addressBalance' as const, availableMist: holdings.addressBalanceMist, coins: [] };
  }
  if (!touchesSui) {
    return { source: 'gasCoin' as const, availableMist: holdings.coinTotalMist, coins: holdings.coins };
  }

  // keep as many selected SUI objects out of the payment as possible. smaller coins
  // can still be consolidated into the payment coin, or deposited into the address balance.
  const selected = new Set(actions.flatMap((action) => action.objectIds.map((id) => normalizeSuiObjectId(id))));
  const sorted = [...holdings.coins].sort((a, b) => {
    const aSelected = selected.has(normalizeSuiObjectId(a.objectId));
    const bSelected = selected.has(normalizeSuiObjectId(b.objectId));
    if (aSelected !== bSelected) return aSelected ? 1 : -1;
    return b.balanceMist - a.balanceMist;
  });
  const coins: GasHoldings['coins'] = [];
  let availableMist = 0;
  for (const coin of sorted) {
    coins.push(coin);
    availableMist += coin.balanceMist;
    if (availableMist >= budgetMist) break;
  }
  return { source: 'gasCoin' as const, availableMist, coins };
}
