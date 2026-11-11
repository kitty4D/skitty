import type { BlockedCoin, CleanupAction, CleanupActionKind, ScanProgress, ScanSection, ScanSectionId } from './types';

export interface ScanResults {
  actions: CleanupAction[];
  warnings?: string[];
  blockedCoins?: BlockedCoin[];
  flaggedActions?: CleanupAction[];
}
export interface ScanJob {
  id: ScanSectionId;
  label: string;
  run: (progress: (value: ScanProgress) => void, publish: (value: ScanResults) => void) => Promise<ScanResults>;
}
export interface ScanSnapshot extends ScanResults { scanSections: ScanSection[] }

export const sectionForKind: Record<CleanupActionKind, ScanSectionId> = {
  merge_coins: 'coins', keep_tokens: 'coins', destroy_zero: 'coins',
  close_kiosk: 'kiosks', withdraw_kiosk: 'kiosks', empty_container: 'containers',
  expired_walrus: 'receipts', revoke_allowance: 'receipts', burn: 'burn',
};

// two independent discovery jobs at a time. each publishes only verified results;
// optional metadata can enrich an existing result without hiding it again.
export async function runScanPipeline(
  jobs: ScanJob[], onChange: (snapshot: ScanSnapshot) => void, isStale: () => boolean,
): Promise<void> {
  const sections: ScanSection[] = jobs.map(job => ({
    id: job.id, label: job.label, status: 'waiting', phase: 'waiting', current: 0, total: 0, found: 0,
  }));
  const results = jobs.map((): ScanResults => ({ actions: [] }));
  let merged: ScanResults = { actions: [], blockedCoins: [], flaggedActions: [], warnings: [] };
  let dirty = false;
  const emit = () => {
    if (isStale()) return;
    if (dirty) {
      merged = {
      actions: results.flatMap(result => result.actions),
      blockedCoins: results.flatMap(result => result.blockedCoins ?? []),
      flaggedActions: results.flatMap(result => result.flaggedActions ?? []),
      warnings: results.flatMap(result => result.warnings ?? []),
      };
      dirty = false;
    }
    onChange({
      ...merged,
      scanSections: sections.map(section => ({ ...section })),
    });
  };
  emit();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !isStale()) {
      const index = next++;
      const job = jobs[index];
      sections[index].status = 'scanning';
      emit();
      const publish = (value: ScanResults) => {
        if (isStale()) return;
        results[index] = value;
        dirty = true;
        sections[index].found = value.actions.length;
        emit();
      };
      try {
        const result = await job.run(value => {
          if (isStale()) return;
          Object.assign(sections[index], value);
          emit();
        }, publish);
        if (isStale()) return;
        publish(result);
        sections[index].status = result.warnings?.length ? 'error' : 'complete';
      } catch (error) {
        if (isStale()) return;
        sections[index].status = 'error';
        results[index] = { ...results[index], warnings: [
          ...(results[index].warnings ?? []),
          `${job.label} scan incomplete: ${error instanceof Error ? error.message : String(error)}`,
        ] };
        dirty = true;
      }
      emit();
    }
  };
  await Promise.all([worker(), worker()]);
}

// ordered output, bounded requests, and no new work after another scan supersedes us.
export async function mapScanItems<T, R>(items: T[], work: (item: T, index: number) => Promise<R>, isStale: () => boolean = () => false): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed && !isStale()) {
      const index = next++;
      try { output[index] = await work(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  };
  // finish in-flight reads before rejecting, so a failed section cannot publish
  // another result after the pipeline has marked it settled.
  const outcomes = await Promise.allSettled([worker(), worker()]);
  for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
  return output;
}
