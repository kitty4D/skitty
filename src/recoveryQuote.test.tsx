import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FloatingCart } from './components/FloatingCart';

function renderQuote(dryRunResult: Parameters<typeof FloatingCart>[0]['dryRunResult']) {
  const noop = () => {};
  return renderToStaticMarkup(<FloatingCart
    selectedActionList={[]} storageRebateMist={3000000} burnedMist={30000}
    feeMist={0} estimatedGasMist={1000000} userShareMist={1000000}
    dryRunResult={dryRunResult} executeError={null} runDryRun={noop} execute={noop}
    onClearQueue={noop} onViewRawSimulation={noop} executing={false}
    accountConnected={false} isMinimized={false} onToggleMinimize={noop}
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
