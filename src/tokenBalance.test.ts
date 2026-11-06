import { expect, it } from 'vitest';
import { formatTokenBalance } from './utils/format';

it('shows dust exactly instead of rounding a nonzero token to zero', () => {
  expect(formatTokenBalance('1', 18, 'T')).toBe('0.000000000000000001 T');
});

it('does not lose precision on large token holdings', () => {
  expect(formatTokenBalance('1234567890123456789012345', 6, 'USDC')).toBe('1234567890123456789.012345 USDC');
});

it('labels unknown units without assuming SUI decimals', () => {
  expect(formatTokenBalance('42')).toBe('42 raw units');
});
