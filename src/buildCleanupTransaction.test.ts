import { describe, expect, it } from 'vitest';
import { buildBatchTransaction, computeFeeMist } from './buildCleanupTransaction';
import { isProtectedType, FEE_RATE, MAX_ACTIONS_PER_BATCH } from './constants';
import { actionKey } from './actionIdentity';
import type { CleanupAction, DestroyZeroAction, MergeCoinsAction } from './types';

const SENDER = '0x1111111111111111111111111111111111111111111111111111111111111111';

function mergeAction(ids: string[], rebates: number[]): MergeCoinsAction {
  // the scanner quotes only what a merge really destroys: everything but the primary
  const realized = rebates.slice(1).reduce((s, r) => s + r, 0);
  return {
    kind: 'merge_coins',
    coinType: '0xabc::foo::FOO',
    label: 'foo::FOO',
    objectIds: ids,
    objectStorageRebates: rebates.map(String),
    storageRebateTotal: String(realized),
    userRebateMist: Math.floor(realized * 0.99),
    estimatedGasMist: 500,
    netGainMist: 0,
  };
}

function destroyAction(id: string, rebate: number): DestroyZeroAction {
  return {
    kind: 'destroy_zero',
    coinType: '0xabc::foo::FOO',
    label: 'foo::FOO',
    objectIds: [id],
    objectStorageRebates: [String(rebate)],
    storageRebateTotal: String(rebate),
    userRebateMist: Math.floor(rebate * 0.99),
    estimatedGasMist: 300,
    netGainMist: 0,
  };
}

// omit estimatedGasMist to exercise the build's own per-action estimate
const build = (actions: CleanupAction[], estimatedGasMist?: number) =>
  buildBatchTransaction(actions, {
    sponsoredGas: true,
    senderAddress: SENDER,
    ...(estimatedGasMist == null ? {} : { estimatedGasMist }),
  });

describe('computeFeeMist', () => {
  it('takes FEE_RATE of the rebate, rounded down', () => {
    expect(computeFeeMist(1_000_000)).toBe(Math.floor(1_000_000 * FEE_RATE));
  });

  it('never charges on a zero or negative rebate', () => {
    expect(computeFeeMist(0)).toBe(0);
    expect(computeFeeMist(-5)).toBe(0);
  });
});

describe('buildBatchTransaction rebate accounting', () => {
  it('excludes the surviving merge primary from the realized rebate', () => {
    // 4 coins at 1000 each: the merge destroys 3, so only 3000 comes back
    const result = build([mergeAction(['0xa', '0xb', '0xc', '0xd'], [1000, 1000, 1000, 1000])]);
    expect(result.storageRebateMist).toBe(3000);
  });

  it('counts every object for destroy_zero, which keeps nothing alive', () => {
    const result = build([destroyAction('0xa', 1000), destroyAction('0xb', 2000)]);
    expect(result.storageRebateMist).toBe(3000);
  });

  it('only merges once across two actions of the same coin type', () => {
    // one primary survives for the type, not one per action
    const result = build([
      mergeAction(['0xa', '0xb'], [1000, 1000]),
      mergeAction(['0xc', '0xd'], [1000, 1000]),
    ]);
    expect(result.storageRebateMist).toBe(3000);
  });

  it('does not pay out on actions the batch cap drops', () => {
    const actions = Array.from({ length: MAX_ACTIONS_PER_BATCH + 10 }, (_, i) =>
      destroyAction(`0x${i.toString(16).padStart(64, '0')}`, 1000)
    );
    const result = build(actions);
    expect(result.droppedActionCount).toBe(10);
    expect(result.storageRebateMist).toBe(MAX_ACTIONS_PER_BATCH * 1000);
  });

  it('never pays out more than 99% of what it reclaims', () => {
    const result = build([destroyAction('0xa', 1_000_000)], 1000);
    // the 1% protocol burn means the gas coin only ever receives userRebateMist
    expect(result.userShareMist + result.feeMist + result.gasMist).toBeLessThanOrEqual(
      result.userRebateMist
    );
    expect(result.userShareMist).toBeGreaterThan(0);
  });

  it('refuses to build when the rebate cannot cover gas and fee', () => {
    expect(() => build([destroyAction('0xa', 1000)], 5_000_000)).toThrow(/does not cover/);
  });

  it('charges gas only for the objects that fit under the cap', () => {
    // 60 selected, 50 emitted: charging for all 60 would draw the difference from the
    // sponsor and could push an otherwise-profitable batch below zero
    const actions = Array.from({ length: MAX_ACTIONS_PER_BATCH + 10 }, (_, i) =>
      destroyAction(`0x${i.toString(16).padStart(64, '0')}`, 1_000_000)
    );
    const result = build(actions);
    const perObjectGas = actions[0]!.estimatedGasMist;
    expect(result.gasMist).toBe(MAX_ACTIONS_PER_BATCH * perObjectGas);
  });

  it('charges a merge once per group, not per coin', () => {
    const result = build([mergeAction(['0xa', '0xb', '0xc'], [1_000_000, 1_000_000, 1_000_000])]);
    expect(result.gasMist).toBe(500);
  });

  it('reports only the actions it actually emitted', () => {
    const actions = Array.from({ length: MAX_ACTIONS_PER_BATCH + 5 }, (_, i) =>
      destroyAction(`0x${i.toString(16).padStart(64, '0')}`, 1_000_000)
    );
    const result = build(actions);
    expect(result.includedActions.length).toBe(MAX_ACTIONS_PER_BATCH);
  });

  it('needs a sender to close a kiosk, since profits belong to the owner', () => {
    const kiosk: CleanupAction = {
      kind: 'close_kiosk',
      kioskId: '0xk',
      ownerCapId: '0xc',
      label: '0xk',
      objectIds: ['0xk'],
      storageRebateTotal: '1000000',
      userRebateMist: 990_000,
      estimatedGasMist: 2000,
      netGainMist: 0,
    };
    expect(() =>
      buildBatchTransaction([kiosk], { sponsoredGas: false, estimatedGasMist: 0 })
    ).toThrow(/senderAddress is required/);
  });
});

describe('buildBatchTransaction self-paid fee', () => {
  const selfPaid = (
    actions: CleanupAction[],
    selfPaidFee: { source: 'gasCoin' | 'addressBalance'; maxMist: number } | null
  ) =>
    buildBatchTransaction(actions, {
      sponsoredGas: false,
      senderAddress: SENDER,
      estimatedGasMist: 1000,
      selfPaidFee,
    });

  // every argument in the PTB, including the ones nested inside commands
  const usesGasCoin = (result: ReturnType<typeof selfPaid>) =>
    JSON.stringify(result.tx.getData().commands).includes('"GasCoin"');
  const moveCalls = (result: ReturnType<typeof selfPaid>) =>
    result.tx
      .getData()
      .commands.flatMap((command) =>
        command.MoveCall ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : []
      );
  const transfers = (result: ReturnType<typeof selfPaid>) =>
    result.tx.getData().commands.filter((command) => command.$kind === 'TransferObjects').length;

  it('splits the fee from tx.gas when coins pay the gas', () => {
    const result = selfPaid([destroyAction('0xa', 1_000_000)], { source: 'gasCoin', maxMist: 10_000_000 });
    expect(result.feeMist).toBe(computeFeeMist(1_000_000));
    expect(usesGasCoin(result)).toBe(true);
    expect(moveCalls(result)).toContain('coin::send_funds');
  });

  it('withdraws the fee and never touches tx.gas when the address balance pays', () => {
    // a GasCoin argument would force the resolver onto coin objects this wallet may not own
    const result = selfPaid([destroyAction('0xa', 1_000_000)], {
      source: 'addressBalance',
      maxMist: 10_000_000,
    });
    expect(result.feeMist).toBe(computeFeeMist(1_000_000));
    expect(usesGasCoin(result)).toBe(false);
    expect(result.tx.getData().inputs.some((input) => input.$kind === 'FundsWithdrawal')).toBe(true);
    expect(moveCalls(result)).toEqual(
      expect.arrayContaining(['balance::redeem_funds', 'balance::send_funds'])
    );
  });

  it('sends the fee to an address balance instead of minting a coin the user pays storage on', () => {
    for (const source of ['gasCoin', 'addressBalance'] as const) {
      const result = selfPaid([destroyAction('0xa', 1_000_000)], { source, maxMist: 10_000_000 });
      expect(transfers(result)).toBe(0);
    }
  });

  it('caps the fee at what the gas source can spare after the budget', () => {
    const result = selfPaid([destroyAction('0xa', 1_000_000)], { source: 'gasCoin', maxMist: 5000 });
    expect(result.feeMist).toBe(5000);
  });

  it('waives the fee when there is nothing to take it from', () => {
    for (const fee of [null, { source: 'gasCoin' as const, maxMist: 0 }, { source: 'addressBalance' as const, maxMist: -1 }]) {
      const result = selfPaid([destroyAction('0xa', 1_000_000)], fee);
      expect(result.feeMist).toBe(0);
      expect(usesGasCoin(result)).toBe(false);
      expect(result.tx.getData().inputs.some((input) => input.$kind === 'FundsWithdrawal')).toBe(false);
    }
  });

  it('waives the fee on a batch that does not cover its own gas', () => {
    const result = buildBatchTransaction([destroyAction('0xa', 1000)], {
      sponsoredGas: false,
      senderAddress: SENDER,
      estimatedGasMist: 5_000_000,
      selfPaidFee: { source: 'gasCoin', maxMist: 10_000_000 },
    });
    expect(result.feeMist).toBe(0);
  });

  it('ignores a self-paid fee when the sponsor pays', () => {
    // the sponsored path keeps the fee inside the sponsor's gas coin; a stray option
    // must never add a withdrawal from the user on top
    const result = buildBatchTransaction([destroyAction('0xa', 1_000_000)], {
      sponsoredGas: true,
      senderAddress: SENDER,
      estimatedGasMist: 1000,
      selfPaidFee: { source: 'addressBalance', maxMist: 10_000_000 },
    });
    expect(result.tx.getData().inputs.some((input) => input.$kind === 'FundsWithdrawal')).toBe(false);
  });
});

describe('isProtectedType', () => {
  it('matches staked SUI at its real package (0x3, not 0x2)', () => {
    expect(isProtectedType('0x3::staking_pool::StakedSui')).toBe(true);
  });

  it('matches regardless of address padding', () => {
    const padded = `0x${'0'.repeat(63)}3::staking_pool::StakedSui`;
    expect(isProtectedType(padded)).toBe(true);
  });

  it('protects kiosks and publisher/upgrade caps', () => {
    expect(isProtectedType('0x2::kiosk::KioskOwnerCap')).toBe(true);
    expect(isProtectedType('0x2::package::UpgradeCap')).toBe(true);
  });

  it('matches generic instantiations of a protected type', () => {
    expect(isProtectedType('0x2::coin::TreasuryCap<0xabc::foo::FOO>')).toBe(true);
  });

  it('leaves unrelated types alone', () => {
    expect(isProtectedType('0xdead::spam::Spam')).toBe(false);
  });
});

describe('actionKey', () => {
  it('is stable regardless of object ordering', () => {
    expect(actionKey(destroyAction('0xa', 1))).toBe(
      actionKey({ ...destroyAction('0xa', 1), objectIds: ['0xa'] })
    );
    const a = mergeAction(['0xa', '0xb'], [1, 1]);
    const b = mergeAction(['0xb', '0xa'], [1, 1]);
    expect(actionKey(a)).toBe(actionKey(b));
  });

  it('separates different kinds over the same object', () => {
    const destroy = destroyAction('0xa', 1);
    const burn: CleanupAction = {
      kind: 'burn',
      objectType: '0xdead::spam::Spam',
      moveTarget: '0xdead::spam::burn',
      objectIds: ['0xa'],
      storageRebateTotal: '1',
      userRebateMist: 1,
      estimatedGasMist: 1,
      netGainMist: 0,
      label: 'spam::Spam',
    };
    expect(actionKey(destroy)).not.toBe(actionKey(burn));
  });
});
