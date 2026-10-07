/**
 * Scheduled-job counts for navigation badges.
 *
 * This module owns the single backend subscription for `cron://jobs-changed`
 * (agent Cron tool calls, the scheduler, session cleanup). It re-reads the job
 * list, publishes per-workspace / per-session counts, and mirrors the hint onto
 * the existing browser event so every mounted scheduled-job view also reloads.
 * Nav rows read the counts through `useSyncExternalStore` without each row
 * owning a Tauri listener.
 */

import { cronAPI } from '@/infrastructure/api';
import { notifyScheduledJobsChanged, SCHEDULED_JOBS_CHANGED_EVENT } from './scheduledJobDraft';
import { createLogger } from '@/shared/utils/logger';
import type { CronJob } from '@/infrastructure/api';

const log = createLogger('CronJobCountsStore');

export interface CronJobCountsSnapshot {
  /** Enabled job count per workspace id. */
  byWorkspaceId: ReadonlyMap<string, number>;
  /** Enabled job count per session id (session-targeted jobs only). */
  bySessionId: ReadonlyMap<string, number>;
}

const EMPTY_SNAPSHOT: CronJobCountsSnapshot = {
  byWorkspaceId: new Map(),
  bySessionId: new Map(),
};

let snapshot: CronJobCountsSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let loadInFlight = false;
let reloadPending = false;
let listenerRegistered = false;

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

function countsEqual(
  left: CronJobCountsSnapshot,
  right: CronJobCountsSnapshot,
): boolean {
  if (left.byWorkspaceId.size !== right.byWorkspaceId.size) return false;
  if (left.bySessionId.size !== right.bySessionId.size) return false;
  for (const [key, value] of left.byWorkspaceId) {
    if (right.byWorkspaceId.get(key) !== value) return false;
  }
  for (const [key, value] of left.bySessionId) {
    if (right.bySessionId.get(key) !== value) return false;
  }
  return true;
}

/**
 * Navigation clocks indicate enabled schedules. Paused jobs remain available
 * in the scheduled-job views, but do not keep a workspace/session clock active.
 */
export function computeCronJobCounts(jobs: CronJob[]): CronJobCountsSnapshot {
  const byWorkspaceId = new Map<string, number>();
  const bySessionId = new Map<string, number>();
  for (const job of jobs) {
    if (!job.enabled) continue;
    const workspaceId = job.target.workspace.workspaceId;
    if (workspaceId) {
      byWorkspaceId.set(workspaceId, (byWorkspaceId.get(workspaceId) ?? 0) + 1);
    }
    if (job.target.kind === 'session') {
      bySessionId.set(job.target.sessionId, (bySessionId.get(job.target.sessionId) ?? 0) + 1);
    }
  }
  return { byWorkspaceId, bySessionId };
}

function applyJobs(jobs: CronJob[]): void {
  const next = computeCronJobCounts(jobs);
  if (countsEqual(snapshot, next)) return;
  snapshot = next;
  publish();
}

async function reload(): Promise<void> {
  reloadPending = true;
  if (loadInFlight) return;
  loadInFlight = true;
  try {
    do {
      reloadPending = false;
      try {
        const jobs = await cronAPI.listJobs({});
        // A change during this read may have made its result stale. Drain the
        // queued refresh before publishing counts instead of losing the hint.
        if (!reloadPending) applyJobs(jobs);
      } catch (error) {
        // Keep the previous counts and retry any change queued during the read.
        log.warn('Failed to load scheduled job counts', { error });
      }
    } while (reloadPending);
  } finally {
    loadInFlight = false;
  }
}

/** Subscribe the badge store; idempotent and safe to call from an effect. */
export function ensureCronJobCountsListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;

  // Local editor saves, plus the backend hints mirrored below.
  window.addEventListener(SCHEDULED_JOBS_CHANGED_EVENT, () => {
    void reload();
  });

  try {
    // Backend hints are only a signal; the payload carries no job state. The
    // source id matches no view instance, so every mounted view reloads.
    cronAPI.onJobsChanged(() => {
      notifyScheduledJobsChanged('backend');
    });
  } catch (error) {
    // Badges still track local edits and the initial load below.
    log.error('Failed to subscribe scheduled job changes', { error });
  }

  void reload();
}

/** useSyncExternalStore snapshot: stable between changes. */
export function getCronJobCountsSnapshot(): CronJobCountsSnapshot {
  return snapshot;
}

export function subscribeCronJobCounts(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
