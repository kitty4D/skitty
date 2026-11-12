import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FloatingCart } from './components/FloatingCart';

function renderQuote(dryRunResult: Parameters<typeof FloatingCart>[0]['dryRunResult'], gasMode: 'sponsored' | 'self' = 'sponsored') {
  const noop = () => {};
  return renderToStaticMarkup(<FloatingCart
    selectedActionList={[]} gasMode={gasMode} storageRebateMist={3000000} burnedMist={30000}
    feeMist={0} estimatedGasMist={1000000} userShareMist={1000000}
    dryRunResult={dryRunResult} executeError={null} runDryRun={noop} execute={noop}
    onClearQueue={noop} onViewRawSimulation={noop} executing={false}
    accountConnected={false} isMinimized={false} onToggleMinimize={noop} onMinimize={noop}
  />);
}

it('replaces the rough queue headline with a successful queue simulation', () => {
  const html = renderQuote({ netGainMist: 2000000, gasCostMist: -2000000, forQueue: true });
  expect(html).toContain('SIMULATED');
  expect(html).toContain('0.002000');
  expect(html).toContain('rough breakdown before simulation');
});

it('does not substitute a single-card simulation for the whole queue', () => {
  const html = renderQuote({ netGainMist: 2000000, gasCostMist: -2000000, forQueue: false });
  expect(html).not.toContain('SIMULATED');
});

it('shows a simulated net cost when the queue loses SUI', () => {
  const html = renderQuote({ netGainMist: -2000000, gasCostMist: 2000000, forQueue: true });
  expect(html).toContain('NET COST');
  expect(html).toContain('SIMULATED');
});

it('does not promote failed simulation figures to the recovery headline', () => {
  const html = renderQuote({ netGainMist: 2000000, gasCostMist: -2000000, forQueue: true, error: 'failed' });
  expect(html).not.toContain('SIMULATED');
});

it.each([123000, 0, -123000])('shows a separate simulated sponsor net change of %s', (sponsorNetMist) => {
  const html = renderQuote({ netGainMist: 105000, gasCostMist: -1298000, sponsorNetMist, forQueue: true });
  expect(html).toContain('storage rebate minus gas');
  expect(html).toContain('your net recovery');
  expect(html).toContain('sponsor net balance change (simulated)');
  expect(html).toContain(`${sponsorNetMist > 0 ? '+' : ''}${(sponsorNetMist / 1e9).toFixed(6)} SUI`);
  expect(html).not.toContain('GAS PAYER NET COST');
});

it('shows unavailable rather than zero when sponsor balance changes are missing', () => {
  const html = renderQuote({ netGainMist: 105000, gasCostMist: -1298000, forQueue: true });
  expect(html).toContain('unavailable');
});

it('omits the sponsor balance row for a self-paid simulation', () => {
  const html = renderQuote({ netGainMist: 105000, gasCostMist: -1298000, sponsorNetMist: null, forQueue: true }, 'self');
  expect(html).not.toContain('sponsor net balance change (simulated)');
});
