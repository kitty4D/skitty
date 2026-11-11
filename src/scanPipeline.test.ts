import { expect, it, vi } from 'vitest';
import { mapScanItems, runScanPipeline, type ScanJob, type ScanSnapshot } from './scanPipeline';
import type { CleanupAction } from './types';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const action = { kind: 'destroy_zero', objectIds: ['0x1'], storageRebateTotal: '1' } as CleanupAction;

it('publishes checked coins while metadata and a slow kiosk scan are still pending', async () => {
  const metadata = deferred();
  const kiosks = deferred();
  const snapshots: ScanSnapshot[] = [];
  const running = runScanPipeline([
    { id: 'coins', label: 'coins', run: async (progress, publish) => {
      publish({ actions: [action] });
      progress({ phase: 'metadata', current: 0, total: 20 });
      await metadata.promise;
      return { actions: [action] };
    } },
    { id: 'kiosks', label: 'kiosks', run: async () => { await kiosks.promise; return { actions: [] }; } },
  ], snapshot => snapshots.push(snapshot), () => false);
  expect(snapshots[snapshots.length - 1]?.actions).toEqual([action]);
  expect(snapshots[snapshots.length - 1]?.scanSections.every(section => section.status === 'scanning')).toBe(true);
  metadata.resolve();
  await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.scanSections[0].status).toBe('complete'));
  expect(snapshots[snapshots.length - 1]?.scanSections[1].status).toBe('scanning');
  kiosks.resolve();
  await running;
});

it('keeps verified partial results and runs later jobs when another check fails', async () => {
  const snapshots: ScanSnapshot[] = [];
  await runScanPipeline([
    { id: 'coins', label: 'coins', run: async (_progress, publish) => {
      publish({ actions: [action] }); throw new Error('metadata unavailable');
    } },
    { id: 'containers', label: 'containers', run: async () => ({ actions: [] }) },
  ], snapshot => snapshots.push(snapshot), () => false);
  const final = snapshots[snapshots.length - 1];
  expect(final.actions).toEqual([action]);
  expect(final.scanSections.map(section => section.status)).toEqual(['error', 'complete']);
  expect(final.warnings?.[0]).toContain('scan incomplete');
});

it('discards late results and never starts queued jobs after the address changes', async () => {
  const gate = deferred();
  let stale = false;
  const onChange = vi.fn();
  const later = vi.fn(async () => ({ actions: [] }));
  const jobs: ScanJob[] = [
    { id: 'coins', label: 'coins', run: async () => { await gate.promise; return { actions: [action] }; } },
    { id: 'kiosks', label: 'kiosks', run: async () => { await gate.promise; return { actions: [] }; } },
    { id: 'burn', label: 'burn', run: later },
  ];
  const running = runScanPipeline(jobs, onChange, () => stale);
  const calls = onChange.mock.calls.length;
  stale = true;
  gate.resolve();
  await running;
  expect(onChange).toHaveBeenCalledTimes(calls);
  expect(later).not.toHaveBeenCalled();
});

it('marks returned discovery warnings as incomplete rather than a successful empty scan', async () => {
  const changed = vi.fn();
  await runScanPipeline([{ id: 'receipts', label: 'receipts', run: async () => ({
    actions: [], warnings: ['Walrus epoch could not be verified'],
  }) }], changed, () => false);
  const last = changed.mock.calls[changed.mock.calls.length - 1][0] as ScanSnapshot;
  expect(last.scanSections[0].status).toBe('error');
  expect(last.warnings).toEqual(['Walrus epoch could not be verified']);
});

it('keeps two item requests in flight and preserves input order', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  const running = mapScanItems([0, 1, 2], async item => {
    started.push(item); await gates[item].promise; return item;
  });
  expect(started).toEqual([0, 1]);
  gates[1].resolve();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  gates[2].resolve(); gates[0].resolve();
  expect(await running).toEqual([0, 1, 2]);
});
