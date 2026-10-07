import type { FileOperationDiffStats } from '../tool-cards/fileOperationDiffStats';
import { FlowChatResourceCache } from './resourceCache';

const cache = new FlowChatResourceCache<string, FileOperationDiffStats | null>(256 * 128, 256);
const pending = new Map<string, { promise: Promise<FileOperationDiffStats | null>; readers: Set<() => boolean> }>();
const waiting: Array<() => void> = [];
let running = 0;
let api: Promise<typeof import('../../infrastructure/api')> | undefined;

/** One bounded IO lane across headers and cards in all desktop panes. */
export function loadOperationSummary(session: string, operation: string, epoch: number, isCurrent: () => boolean) {
  if (!isCurrent()) return Promise.resolve(null);
  const key = JSON.stringify([epoch, session, operation]);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const existing = pending.get(key);
  if (existing) { existing.readers.add(isCurrent); return existing.promise; }
  const readers = new Set([isCurrent]);
  const needed = () => [...readers].some(current => current());
  const promise = new Promise<FileOperationDiffStats | null>((resolve, reject) => {
    const run = async () => {
      running++;
      try {
        if (!needed()) { resolve(null); return; }
        const { snapshotAPI } = await (api ??= import('../../infrastructure/api'));
        if (!needed()) { resolve(null); return; }
        const summary = await snapshotAPI.getOperationSummary(session, operation);
        const result = summary ? { additions: Number(summary.linesAdded ?? 0), deletions: Number(summary.linesRemoved ?? 0) } : null;
        // A snapshot may not have been persisted yet. Missing summaries must
        // remain retryable when the card re-enters the viewport.
        if (needed() && result) cache.set(key, result, key.length * 2 + 32);
        resolve(result);
      } catch (error) { reject(error); }
      finally { running--; pending.delete(key); waiting.shift()?.(); }
    };
    if (running < 4) void run(); else waiting.push(run);
  });
  pending.set(key, { promise, readers });
  return promise;
}
