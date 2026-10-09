import { expect, it, vi } from 'vitest';
import { loadOperationSummary } from './operationSummaryResource';

const api = vi.hoisted(() => ({ getOperationSummary: vi.fn() }));
vi.mock('../../infrastructure/api', () => ({ snapshotAPI: api }));

it('bounds IO, drops obsolete queued readers, and retains work needed by another pane', async () => {
  const complete = new Map<string, (value: unknown) => void>();
  api.getOperationSummary.mockImplementation((_session: string, operation: string) => new Promise(resolve => complete.set(operation, resolve)));
  const active = Array.from({ length: 4 }, (_, index) => loadOperationSummary('s', `active-${index}`, 1, () => true));
  let firstReader = true;
  const stale = loadOperationSummary('s', 'stale', 1, () => firstReader);
  const shared = loadOperationSummary('s', 'shared', 1, () => firstReader);
  const secondPane = loadOperationSummary('s', 'shared', 1, () => true);
  expect(secondPane).toBe(shared);
  firstReader = false;
  await vi.waitFor(() => expect(api.getOperationSummary).toHaveBeenCalledTimes(4));
  for (let index = 0; index < 4; index++) complete.get(`active-${index}`)!(null);
  await vi.waitFor(() => expect(api.getOperationSummary).toHaveBeenCalledTimes(5));
  expect(api.getOperationSummary).not.toHaveBeenCalledWith('s', 'stale');
  complete.get('shared')!({ linesAdded: 5, linesRemoved: 2 });
  await Promise.all(active);
  expect(await stale).toBeNull();
  expect(await secondPane).toEqual({ additions: 5, deletions: 2 });
  expect(await loadOperationSummary('s', 'shared', 1, () => true)).toEqual({ additions: 5, deletions: 2 });
  expect(api.getOperationSummary).toHaveBeenCalledTimes(5);
  // A missing snapshot can arrive later; its earlier null is not a cache entry.
  const retry = loadOperationSummary('s', 'active-0', 1, () => true);
  await vi.waitFor(() => expect(api.getOperationSummary).toHaveBeenCalledTimes(6));
  complete.get('active-0')!({ linesAdded: 1, linesRemoved: 0 });
  expect(await retry).toEqual({ additions: 1, deletions: 0 });
});
