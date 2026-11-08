import { describe, expect, it } from 'vitest';
import { generateCoinActions, parseCoinBalance, totalUniqueUserRebateMist, totalNonOverlappingNetGainMist } from './coinActions';

const type = '0x2::coin::Coin<0xa::token::TOKEN>';
const sui = '0x2::coin::Coin<0x2::sui::SUI>';
const coin = (id: number, coinType = type, balance: unknown = '7', rebate = '10000') => ({
  address: `id${id}`, storageRebate: rebate,
  contents: { type: { repr: coinType }, json: { balance } },
});

describe('coin actions', () => {
  it('quotes effective keep-token cost after crediting the gas-object rebate', () => {
    const [action] = generateCoinActions([coin(1, type, '1', '1398400')], new Set());
    // the old 500-mist allowance produced 1,192,476 mist for this same rebate.
    expect(action.estimatedGasMist).toBe(100000);
    expect(action.netGainMist).toBe(1092976);
  });
  it('never groups distinct case-sensitive Move token types together', () => {
    const actions = generateCoinActions([coin(1, type), coin(2, '0x2::coin::Coin<0xa::token::Token>')], new Set());
    expect(actions.filter((a) => a.kind === 'keep_tokens')).toHaveLength(2);
    expect(actions.some((a) => a.kind === 'merge_coins')).toBe(false);
  });
  it('counts keep potentials and only disjoint merge potentials for the header', () => {
    const actions = generateCoinActions([coin(1), coin(2), coin(3, type, '0')], new Set());
    const keep = actions.find(a => a.kind === 'keep_tokens')!;
    const zero = actions.find(a => a.kind === 'destroy_zero')!;
    const merge = actions.find(a => a.kind === 'merge_coins')!;
    const disjoint = { ...merge, objectIds: ['other1', 'other2'] };
    expect(totalNonOverlappingNetGainMist([...actions, disjoint])).toBe(keep.netGainMist + zero.netGainMist + disjoint.netGainMist);
  });
  it('strictly parses balances without inventing tokens', () => {
    for (const balance of [undefined, null, '', ' ', '-1', '+1', '0x10', '1.2', 1, {}, { value: '' }]) {
      expect(parseCoinBalance({ balance })).toBeNull();
    }
    expect(parseCoinBalance({ balance: { value: '12345678901234567890' } })).toBe(12345678901234567890n);
    expect(parseCoinBalance({ balance: '0' })).toBe(0n);
  });
  it('quotes N-1 rebates for merge and all rebates for keep without inflating the total', () => {
    const actions = generateCoinActions([coin(1), coin(2, type, '8', '20000'), coin(3, type, '9', '30000')], new Set());
    expect(actions.find(a => a.kind === 'merge_coins')?.storageRebateTotal).toBe('50000');
    const keep = actions.find(a => a.kind === 'keep_tokens');
    expect(keep?.storageRebateTotal).toBe('60000');
    expect(keep?.objectStorageRebates).toEqual(['10000', '20000', '30000']);
    expect(totalUniqueUserRebateMist(actions)).toBe(59400);
  });
  it('keeps singleton dust without economic filtering and skips unknown balances', () => {
    const actions = generateCoinActions([coin(1, type, '1', '1'), coin(2, type, null)], new Set());
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('keep_tokens');
    expect(actions[0].objectIds).toEqual(['id1']);
  });
  it('chunks every keep object at 50 with aligned balances and rebates', () => {
    const actions = generateCoinActions(Array.from({ length: 101 }, (_, i) => coin(i, type, String(i + 1))), new Set());
    const keep = actions.filter(a => a.kind === 'keep_tokens');
    expect(keep.map(a => a.objectIds.length)).toEqual([50, 50, 1]);
    expect(keep.flatMap(a => a.objectIds)).toHaveLength(101);
    expect(keep[2].objectBalances).toEqual(['101']);
    expect(totalUniqueUserRebateMist(actions)).toBe(999900);
  });
  it('offers SUI merge and keep with known metadata but never destroys zero SUI', () => {
    const actions = generateCoinActions([coin(1, sui), coin(2, sui), coin(3, sui, '0')], new Set());
    expect(actions.map(a => a.kind).sort()).toEqual(['keep_tokens', 'merge_coins']);
    expect(actions.filter(a => a.kind !== 'destroy_zero').every(a => a.tokenSymbol === 'SUI' && a.tokenDecimals === 9)).toBe(true);
  });
  it('blocks normalized coin types and preserves zero-token destruction', () => {
    expect(generateCoinActions([coin(1), coin(2, type, '0')], new Set(['0x000a::token::TOKEN']))).toEqual([]);
    expect(generateCoinActions([coin(1, type, '0')], new Set())[0].kind).toBe('destroy_zero');
  });
  it('attaches optional metadata to both alternatives', () => {
    const actions = generateCoinActions([coin(1), coin(2)], new Set(), new Map([[type, { tokenSymbol: 'TOK', tokenDecimals: 6 }]]));
    expect(actions.every(a => a.kind !== 'destroy_zero' && a.tokenSymbol === 'TOK' && a.tokenDecimals === 6)).toBe(true);
  });
  it('deduplicates repeated page objects before quoting rebates', () => {
    const actions = generateCoinActions([coin(1), coin(1)], new Set());
    expect(actions).toHaveLength(1);
    expect(actions[0].objectIds).toEqual(['id1']);
    expect(totalUniqueUserRebateMist(actions)).toBe(9900);
  });
  it('keeps singleton padded SUI and attaches built-in metadata', () => {
    const actions = generateCoinActions([coin(1, '0x2::coin::Coin<0x0002::sui::SUI>')], new Set());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'keep_tokens', tokenSymbol: 'SUI', tokenDecimals: 9 });
  });
});
