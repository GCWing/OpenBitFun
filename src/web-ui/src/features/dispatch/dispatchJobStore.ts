import { create } from 'zustand';
import {
  createJSONStorage,
  persist,
} from 'zustand/middleware';
import type {
  DispatchApprovalPolicy,
  DispatchJobState,
  DispatchReachability,
  DispatchTarget,
  DispatchTargetRequest,
  OutboundDispatchRecord,
} from './types';
import { isDispatchJobTerminal } from './types';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('DispatchJobStore');
const MAX_APPLIED_EVENT_IDS = 2048;
const MAX_DISMISSED_JOB_IDS = 2048;
const MAX_DISMISSED_SESSION_IDS = 2048;
const DISPATCH_JOB_STORAGE_KEY = 'openbitfun-dispatch-jobs-v1';
// Keep deletion authority outside the general Zustand snapshot. A stale HMR
// renderer may still persist its old job cache, but it must never erase a
// dismissal recorded by the current renderer.
const DISPATCH_DISMISSAL_LEDGER_KEY = 'openbitfun-dispatch-dismissals-v1';
const reportedSuppressedProjectionKeys = new Set<string>();
const fallbackStorageValues = new Map<string, string>();

interface SyncStringStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
}

interface DispatchDismissalLedger {
  dismissedJobIds: string[];
  dismissedSessionIds: string[];
}

const fallbackStorage: SyncStringStorage = {
  getItem: (name) => fallbackStorageValues.get(name) ?? null,
  setItem: (name, value) => {
    fallbackStorageValues.set(name, value);
  },
  removeItem: (name) => {
    fallbackStorageValues.delete(name);
  },
};

function getDispatchStorage(): SyncStringStorage {
  return typeof localStorage === 'undefined' ? fallbackStorage : localStorage;
}

function mergeDismissedIds(
  current: unknown[],
  additions: unknown[],
  limit: number,
): string[] {
  return Array.from(new Set(
    [...current, ...additions]
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  )).slice(-limit);
}

function readDismissalLedger(): DispatchDismissalLedger {
  try {
    const raw = getDispatchStorage().getItem(DISPATCH_DISMISSAL_LEDGER_KEY);
    if (!raw) {
      return { dismissedJobIds: [], dismissedSessionIds: [] };
    }
    const parsed = JSON.parse(raw) as Partial<DispatchDismissalLedger>;
    return {
      dismissedJobIds: mergeDismissedIds(
        [],
        Array.isArray(parsed.dismissedJobIds) ? parsed.dismissedJobIds : [],
        MAX_DISMISSED_JOB_IDS,
      ),
      dismissedSessionIds: mergeDismissedIds(
        [],
        Array.isArray(parsed.dismissedSessionIds) ? parsed.dismissedSessionIds : [],
        MAX_DISMISSED_SESSION_IDS,
      ),
    };
  } catch (error) {
    log.warn('Failed to read dispatch dismissal ledger', { error });
    return { dismissedJobIds: [], dismissedSessionIds: [] };
  }
}

function recordDismissals(
  jobIds: string[],
  sessionIds: string[],
): DispatchDismissalLedger {
  const current = readDismissalLedger();
  const next = {
    dismissedJobIds: mergeDismissedIds(
      current.dismissedJobIds,
      jobIds,
      MAX_DISMISSED_JOB_IDS,
    ),
    dismissedSessionIds: mergeDismissedIds(
      current.dismissedSessionIds,
      sessionIds,
      MAX_DISMISSED_SESSION_IDS,
    ),
  };
  try {
    getDispatchStorage().setItem(
      DISPATCH_DISMISSAL_LEDGER_KEY,
      JSON.stringify(next),
    );
  } catch (error) {
    log.error('Failed to persist dispatch dismissal ledger', { error });
  }
  return next;
}

function clearDismissalLedger(): void {
  try {
    getDispatchStorage().removeItem(DISPATCH_DISMISSAL_LEDGER_KEY);
  } catch (error) {
    log.warn('Failed to clear dispatch dismissal ledger', { error });
  }
}

export interface DispatchObserverJob {
  jobId: string;
  sessionId: string;
  targetRequest: DispatchTargetRequest;
  target: DispatchTarget;
  sourceWorkspacePath?: string;
  sourceWorkspaceId?: string;
  title: string;
  /** Controller projection metadata; absent on legacy renderer snapshots. */
  titleSource?: 'generated' | 'manual';
  agentType: string;
  approvalPolicy: DispatchApprovalPolicy;
  /** Baseline branch on the controller, once the backend has resolved one. */
  branch?: string;
  baselineWorktreePath?: string;
  baselineWorktreeMissing?: boolean;
  syncedHeadCommit?: string;
  model?: string;
  reasoningPreset?: string;
  modelCatalog?: import('@/infrastructure/api/service-api/AIApi').AIModelCatalog;
  availableModels?: string[];
  defaultModel?: string;
  cursor: number;
  state: DispatchJobState;
  terminalDrained?: boolean;
  lastError?: string;
  pendingPermissions: Array<Record<string, unknown>>;
  eventLogComplete: boolean;
  historyTruncated: boolean;
  omittedEventCount: number;
  appliedEventIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DispatchTransportState {
  reachability: DispatchReachability;
  lastTransportError?: string;
}

/**
 * Controller-side outcome of a stop request. `stopping` covers the window
 * between the request and the terminal state the target reports; `unconfirmed`
 * means every attempt failed and the target may still be running the job.
 */
export type DispatchCancelState = 'stopping' | 'unconfirmed';

interface DispatchJobStoreState {
  jobs: Record<string, DispatchObserverJob>;
  /**
   * Live controller-to-target transport health. This is deliberately excluded
   * from persistence because only a current poll can establish reachability.
   */
  transportByJobId: Record<string, DispatchTransportState>;
  /** Wall-clock time of the last successful target status read. Transient. */
  lastReachableAtByJobId: Record<string, number>;
  /**
   * Permission requests this controller has answered but the target has not
   * yet dropped from its pending list. Transient: a restart re-reads the
   * target, which is the only authority on what is still pending.
   */
  answeredPermissionIdsByJobId: Record<string, string[]>;
  /** Transient stop-request outcome; cleared once the job is terminal. */
  cancelStateByJobId: Record<string, DispatchCancelState>;
  /** Local projection tombstones. The target job remains durable, but must not reopen in navigation. */
  dismissedJobIds: string[];
  /**
   * Session-level tombstones cover incomplete projections where the job id is
   * temporarily missing when the user deletes the navigation row.
   */
  dismissedSessionIds: string[];
  registerJob: (job: DispatchObserverJob) => void;
  mergeOutboundRecords: (records: OutboundDispatchRecord[]) => void;
  updateProgress: (
    jobId: string,
    update: {
      cursor?: number;
      state?: DispatchJobState;
      lastError?: string;
      appliedEventIds?: string[];
      terminalDrained?: boolean;
      cursorReset?: boolean;
      pendingPermissions?: Array<Record<string, unknown>>;
      eventLogComplete?: boolean;
      historyTruncated?: boolean;
      omittedEventCount?: number;
    },
  ) => void;
  hasAppliedEvent: (jobId: string, eventId: string) => boolean;
  /**
   * Apply the state the target reported when it accepted a follow-up turn and
   * reopen the drain gate so the observer resumes polling from the current
   * cursor. Without this a terminal job stays `terminalDrained` and the
   * follow-up's events are never pulled.
   */
  markFollowUpAccepted: (jobId: string, state: DispatchJobState) => void;
  /**
   * A follow-up whose response was lost may have been queued on the target.
   * Reopen the drain gate (keeping state, cursor and applied events) so the
   * observer pulls its events instead of hiding a turn that may be running.
   */
  reopenTerminalObservation: (jobId: string) => void;
  setTransportState: (
    jobId: string,
    reachability: DispatchReachability,
    lastTransportError?: string,
  ) => void;
  markPermissionsAnswered: (jobId: string, requestIds: string[]) => void;
  unmarkPermissionsAnswered: (jobId: string, requestIds: string[]) => void;
  setCancelState: (jobId: string, cancelState: DispatchCancelState | undefined) => void;
  setBaselineWorktreeMissing: (jobId: string, missing: boolean) => void;
  resetReplay: (jobId: string) => void;
  adoptCachedReplay: (
    jobId: string,
    cached: {
      cursor: number;
      appliedEventIds: string[];
      eventLogComplete: boolean;
      historyTruncated: boolean;
      omittedEventCount: number;
    },
  ) => void;
  updateTitle: (jobId: string, title: string, source?: 'generated' | 'manual') => void;
  updateModel: (jobId: string, model: string) => void;
  updateReasoningPreset: (jobId: string, preset: string) => void;
  updateApprovalPolicy: (jobId: string, policy: DispatchApprovalPolicy) => void;
  dismissSession: (sessionId: string, knownJobId?: string) => void;
  dismissJob: (jobId: string) => void;
  removeJob: (jobId: string) => void;
  clear: () => void;
}

/**
 * Terminal states are sticky against passive channels (stale status responses,
 * lagging outbound records) so a settled job cannot flap. The one legitimate
 * way back out is an accepted follow-up turn, which goes through
 * `markFollowUpAccepted` instead of this transition.
 */
function nextJobState(
  current: DispatchJobState,
  requested: DispatchJobState | undefined,
): DispatchJobState {
  if (!requested || isDispatchJobTerminal(current)) {
    return current;
  }
  return requested;
}

function requestFromTarget(target: DispatchTarget): DispatchTargetRequest {
  switch (target.kind) {
    case 'ssh':
      return {
        kind: 'ssh',
        connectionId: target.connectionId,
        workspacePath: target.workspacePath,
      };
    case 'device':
      return {
        kind: 'device',
        deviceId: target.deviceId,
        workspacePath: target.workspacePath,
      };
    default:
      return { kind: 'local' };
  }
}

const initialDismissalLedger = readDismissalLedger();

function omitKeys<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const key of keys) {
    if (key in record) {
      next ??= { ...record };
      delete next[key];
    }
  }
  return next ?? record;
}

/**
 * Keep only answered ids the target still lists as pending. Once the target
 * drops a request, the optimistic marker has done its job.
 */
function pruneAnsweredPermissions(
  answered: Record<string, string[]>,
  jobId: string,
  pendingPermissions: Array<Record<string, unknown>> | undefined,
): Record<string, string[]> {
  const current = answered[jobId];
  if (!current?.length || !pendingPermissions) return answered;
  const pendingIds = new Set(
    pendingPermissions
      .map(request => request.requestId)
      .filter((requestId): requestId is string => typeof requestId === 'string'),
  );
  const kept = current.filter(requestId => pendingIds.has(requestId));
  if (kept.length === current.length) return answered;
  if (kept.length === 0) return omitKeys(answered, [jobId]);
  return { ...answered, [jobId]: kept };
}

export const useDispatchJobStore = create<DispatchJobStoreState>()(
  persist(
    (set, get) => ({
      jobs: {},
      transportByJobId: {},
      lastReachableAtByJobId: {},
      answeredPermissionIdsByJobId: {},
      cancelStateByJobId: {},
      dismissedJobIds: initialDismissalLedger.dismissedJobIds,
      dismissedSessionIds: initialDismissalLedger.dismissedSessionIds,

      registerJob: (job) => {
        set(state => {
          const ledger = readDismissalLedger();
          const dismissedJobIds = mergeDismissedIds(
            state.dismissedJobIds,
            ledger.dismissedJobIds,
            MAX_DISMISSED_JOB_IDS,
          );
          const dismissedSessionIds = mergeDismissedIds(
            state.dismissedSessionIds,
            ledger.dismissedSessionIds,
            MAX_DISMISSED_SESSION_IDS,
          );
          if (
            dismissedJobIds.includes(job.jobId)
            || dismissedSessionIds.includes(job.sessionId)
          ) {
            log.info('Dispatch diagnostic: job registration suppressed by tombstone', {
              jobId: job.jobId,
              sessionId: job.sessionId,
              jobTombstoned: dismissedJobIds.includes(job.jobId),
              sessionTombstoned: dismissedSessionIds.includes(job.sessionId),
            });
            return { dismissedJobIds, dismissedSessionIds };
          }
          const transportByJobId = {
            ...state.transportByJobId,
            [job.jobId]: state.transportByJobId[job.jobId] ?? {
              reachability: 'unknown' as const,
            },
          };
          return {
            jobs: {
              ...state.jobs,
              [job.jobId]: {
                ...job,
                cursor: Math.max(0, job.cursor),
                appliedEventIds: job.appliedEventIds.slice(-MAX_APPLIED_EVENT_IDS),
              },
            },
            transportByJobId,
            dismissedJobIds,
            dismissedSessionIds,
          };
        });
      },

      mergeOutboundRecords: (records) => {
        set(state => {
          const ledger = readDismissalLedger();
          const dismissedJobIds = mergeDismissedIds(
            state.dismissedJobIds,
            ledger.dismissedJobIds,
            MAX_DISMISSED_JOB_IDS,
          );
          const dismissedSessionIds = mergeDismissedIds(
            state.dismissedSessionIds,
            ledger.dismissedSessionIds,
            MAX_DISMISSED_SESSION_IDS,
          );
          const jobs = { ...state.jobs };
          const authoritativeJobIds = new Set(records.map(record => record.jobId));
          const prunedJobIds = new Set<string>();
          for (const [jobId, job] of Object.entries(jobs)) {
            if (
              dismissedJobIds.includes(jobId)
              || dismissedSessionIds.includes(job.sessionId)
              || (
                !authoritativeJobIds.has(jobId)
                && job.state !== 'submitting'
                && job.state !== 'submission_unknown'
              )
            ) {
              // The controller index is authoritative after acknowledgement,
              // while a tombstone also wins over cache rehydrated by an older
              // renderer build.
              delete jobs[jobId];
              prunedJobIds.add(jobId);
            }
          }
          for (const record of records) {
            if (
              dismissedJobIds.includes(record.jobId)
              || dismissedSessionIds.includes(record.sessionId)
            ) {
              const projectionKey = `${record.jobId}:${record.sessionId}`;
              if (!reportedSuppressedProjectionKeys.has(projectionKey)) {
                if (reportedSuppressedProjectionKeys.size >= MAX_DISMISSED_JOB_IDS) {
                  reportedSuppressedProjectionKeys.clear();
                }
                reportedSuppressedProjectionKeys.add(projectionKey);
                log.info('Dispatch diagnostic: outbound record suppressed by tombstone', {
                  jobId: record.jobId,
                  sessionId: record.sessionId,
                  jobTombstoned: dismissedJobIds.includes(record.jobId),
                  sessionTombstoned: dismissedSessionIds.includes(record.sessionId),
                });
              }
              continue;
            }
            const sourceWorkspacePath =
              record.sourceWorkspacePath?.trim()
              || record.baselineProjectWorkspacePath?.trim()
              || undefined;
            if (!record.sourceWorkspaceId && !sourceWorkspacePath) {
              // A legacy/adopted record without controller-side ownership
              // cannot safely be projected into any workspace. In particular,
              // never assign it to whichever workspace happened to initialize
              // first after restart. Remove any previously inferred cache
              // entry so the old behavior migrates itself away. A record that
              // names its source workspace by ID is owned even without a path.
              delete jobs[record.jobId];
              prunedJobIds.add(record.jobId);
              continue;
            }
            const existing = jobs[record.jobId];
            if (existing) {
              const nextState = nextJobState(existing.state, record.lastState);
              const progressed = nextState !== existing.state;
              const nextBaselinePath =
                record.baselineWorktreePath || existing.baselineWorktreePath;
              jobs[record.jobId] = {
                ...existing,
                target: record.target,
                targetRequest: requestFromTarget(record.target),
                // The durable outbound record is the only authority allowed
                // to restore a projection after renderer restart.
                sourceWorkspacePath,
                sourceWorkspaceId:
                  record.sourceWorkspaceId || existing.sourceWorkspaceId,
                // The index keeps the submission name. Later observer titles
                // live in this persisted projection, including old manual names
                // written before titleSource was recorded.
                title: existing.titleSource || (existing.title && existing.title !== record.title)
                  ? existing.title
                  : record.title || existing.title,
                titleSource: existing.titleSource
                  ?? (record.title && existing.title && existing.title !== record.title
                    ? 'manual'
                    : undefined),
                agentType: record.agentType || existing.agentType,
                approvalPolicy: record.approvalPolicy || existing.approvalPolicy,
                model: record.model || existing.model,
                reasoningPreset: record.reasoningPreset ?? existing.reasoningPreset,
                branch: record.branch || existing.branch,
                baselineWorktreePath: nextBaselinePath,
                baselineWorktreeMissing:
                  nextBaselinePath === existing.baselineWorktreePath
                    ? existing.baselineWorktreeMissing
                    : undefined,
                syncedHeadCommit:
                  record.syncedHeadCommit || existing.syncedHeadCommit,
                // `lastCursor` is controller-wide diagnostic progress. A
                // renderer cursor is per observer and must never jump because
                // another observer polled the same target job.
                cursor: existing.cursor,
                state: nextState,
                terminalDrained: progressed ? false : existing.terminalDrained,
                updatedAt: Math.max(existing.updatedAt, Date.parse(record.updatedAt) || 0),
              };
              continue;
            }
            log.info('Dispatch diagnostic: outbound record restored into renderer cache', {
              jobId: record.jobId,
              sessionId: record.sessionId,
              sourceWorkspaceId: record.sourceWorkspaceId,
              state: record.lastState,
            });
            jobs[record.jobId] = {
              jobId: record.jobId,
              sessionId: record.sessionId,
              targetRequest: requestFromTarget(record.target),
              target: record.target,
              sourceWorkspacePath,
              sourceWorkspaceId: record.sourceWorkspaceId,
              title: record.title || record.promptPreview || record.sessionId.slice(0, 8),
              agentType: record.agentType || 'Standard',
              approvalPolicy: record.approvalPolicy || 'reject-and-report',
              branch: record.branch,
              baselineWorktreePath: record.baselineWorktreePath,
              syncedHeadCommit: record.syncedHeadCommit,
              model: record.model,
              reasoningPreset: record.reasoningPreset,
              // A newly reconstructed projection must replay its own
              // transcript instead of inheriting another observer's cursor.
              cursor: 0,
              state: record.lastState,
              terminalDrained: false,
              appliedEventIds: [],
              pendingPermissions: [],
              eventLogComplete: true,
              historyTruncated: false,
              omittedEventCount: 0,
              createdAt: Date.parse(record.createdAt) || Date.now(),
              updatedAt: Date.parse(record.updatedAt) || Date.now(),
            };
          }
          const transportByJobId = { ...state.transportByJobId };
          for (const jobId of prunedJobIds) {
            delete transportByJobId[jobId];
          }
          for (const jobId of Object.keys(jobs)) {
            transportByJobId[jobId] ??= { reachability: 'unknown' };
          }
          return {
            jobs,
            transportByJobId,
            lastReachableAtByJobId: omitKeys(state.lastReachableAtByJobId, prunedJobIds),
            answeredPermissionIdsByJobId: omitKeys(
              state.answeredPermissionIdsByJobId,
              prunedJobIds,
            ),
            cancelStateByJobId: omitKeys(state.cancelStateByJobId, prunedJobIds),
            dismissedJobIds,
            dismissedSessionIds,
          };
        });
      },

      updateProgress: (jobId, update) => {
        set(state => {
          const current = state.jobs[jobId];
          if (!current) return state;
          const eventIds = update.appliedEventIds
            ? Array.from(new Set([...current.appliedEventIds, ...update.appliedEventIds]))
                .slice(-MAX_APPLIED_EVENT_IDS)
            : current.appliedEventIds;
          const nextCursor = update.cursorReset
            ? Math.max(0, update.cursor ?? 0)
            : Math.max(current.cursor, update.cursor ?? current.cursor);
          const nextState = nextJobState(current.state, update.state);
          const progressed = nextCursor > current.cursor || nextState !== current.state;
          return {
            answeredPermissionIdsByJobId: pruneAnsweredPermissions(
              state.answeredPermissionIdsByJobId,
              jobId,
              update.pendingPermissions,
            ),
            // A terminal job has nothing left to stop.
            cancelStateByJobId: isDispatchJobTerminal(nextState)
              ? omitKeys(state.cancelStateByJobId, [jobId])
              : state.cancelStateByJobId,
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                cursor: nextCursor,
                state: nextState,
                terminalDrained: update.terminalDrained ?? (
                  progressed ? false : current.terminalDrained
                ),
                lastError: update.lastError,
                appliedEventIds: eventIds,
                pendingPermissions:
                  update.pendingPermissions ?? current.pendingPermissions ?? [],
                eventLogComplete:
                  update.eventLogComplete ?? current.eventLogComplete ?? true,
                historyTruncated:
                  update.historyTruncated ?? current.historyTruncated ?? false,
                omittedEventCount:
                  update.omittedEventCount ?? current.omittedEventCount ?? 0,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      hasAppliedEvent: (jobId, eventId) =>
        get().jobs[jobId]?.appliedEventIds.includes(eventId) ?? false,

      markFollowUpAccepted: (jobId, state) => {
        set(current => {
          const job = current.jobs[jobId];
          if (!job) return current;
          return {
            cancelStateByJobId: omitKeys(current.cancelStateByJobId, [jobId]),
            jobs: {
              ...current.jobs,
              [jobId]: {
                ...job,
                // The continue response is a fresh read of the target's state
                // machine, so it is applied directly rather than through the
                // sticky-terminal transition rules. Cursor and applied events
                // are kept: the follow-up resumes the log, it does not replay.
                state,
                terminalDrained: false,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      reopenTerminalObservation: (jobId) => {
        set(current => {
          const job = current.jobs[jobId];
          if (!job || !job.terminalDrained) return current;
          return {
            jobs: { ...current.jobs, [jobId]: { ...job, terminalDrained: false, updatedAt: Date.now() } },
          };
        });
      },

      setTransportState: (jobId, reachability, lastTransportError) => {
        set(state => {
          if (!state.jobs[jobId]) return state;
          const current = state.transportByJobId[jobId];
          const normalizedError = lastTransportError?.trim() || undefined;
          const lastReachableAtByJobId = reachability === 'reachable'
            ? { ...state.lastReachableAtByJobId, [jobId]: Date.now() }
            : state.lastReachableAtByJobId;
          if (
            current?.reachability === reachability &&
            current.lastTransportError === normalizedError
          ) {
            return reachability === 'reachable' ? { lastReachableAtByJobId } : state;
          }
          return {
            lastReachableAtByJobId,
            transportByJobId: {
              ...state.transportByJobId,
              [jobId]: {
                reachability,
                lastTransportError: normalizedError,
              },
            },
          };
        });
      },

      markPermissionsAnswered: (jobId, requestIds) => {
        set(state => {
          if (!state.jobs[jobId] || requestIds.length === 0) return state;
          const current = state.answeredPermissionIdsByJobId[jobId] ?? [];
          const next = Array.from(new Set([...current, ...requestIds]));
          if (next.length === current.length) return state;
          return {
            answeredPermissionIdsByJobId: {
              ...state.answeredPermissionIdsByJobId,
              [jobId]: next,
            },
          };
        });
      },

      unmarkPermissionsAnswered: (jobId, requestIds) => {
        set(state => {
          const current = state.answeredPermissionIdsByJobId[jobId];
          if (!current?.length) return state;
          const removed = new Set(requestIds);
          const next = current.filter(requestId => !removed.has(requestId));
          if (next.length === current.length) return state;
          return {
            answeredPermissionIdsByJobId: next.length === 0
              ? omitKeys(state.answeredPermissionIdsByJobId, [jobId])
              : { ...state.answeredPermissionIdsByJobId, [jobId]: next },
          };
        });
      },

      setCancelState: (jobId, cancelState) => {
        set(state => {
          if (state.cancelStateByJobId[jobId] === cancelState) return state;
          if (!cancelState) {
            return { cancelStateByJobId: omitKeys(state.cancelStateByJobId, [jobId]) };
          }
          if (!state.jobs[jobId]) return state;
          return {
            cancelStateByJobId: { ...state.cancelStateByJobId, [jobId]: cancelState },
          };
        });
      },

      setBaselineWorktreeMissing: (jobId, missing) => {
        set(state => {
          const current = state.jobs[jobId];
          if (!current || current.baselineWorktreeMissing === missing) {
            return state;
          }
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                baselineWorktreeMissing: missing,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      resetReplay: (jobId) => {
        set(state => {
          const current = state.jobs[jobId];
          if (!current) return state;
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                cursor: 0,
                terminalDrained: false,
                appliedEventIds: [],
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      adoptCachedReplay: (jobId, cached) => {
        set(state => {
          const current = state.jobs[jobId];
          if (!current) return state;
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                // Replaces rather than merges, and may move the cursor
                // backwards. The restored transcript defines exactly which
                // events are already on screen; anything this store remembers
                // beyond that was projected into a renderer that is gone.
                cursor: Math.max(0, cached.cursor),
                terminalDrained: false,
                appliedEventIds: cached.appliedEventIds.slice(-MAX_APPLIED_EVENT_IDS),
                eventLogComplete: cached.eventLogComplete,
                historyTruncated: cached.historyTruncated,
                omittedEventCount: cached.omittedEventCount,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      updateTitle: (jobId, title, source = 'manual') => {
        set(state => {
          const current = state.jobs[jobId];
          const normalizedTitle = title.trim();
          if (
            !current
            || !normalizedTitle
            || (source === 'generated' && current.titleSource === 'manual')
            || (current.title === normalizedTitle && current.titleSource === source)
          ) {
            return state;
          }
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                title: normalizedTitle,
                titleSource: source,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      updateModel: (jobId, model) => {
        set(state => {
          const current = state.jobs[jobId];
          const normalizedModel = model.trim();
          if (!current || !normalizedModel || current.model === normalizedModel) {
            return state;
          }
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                model: normalizedModel,
                reasoningPreset: 'auto',
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      updateReasoningPreset: (jobId, preset) => {
        set(state => {
          const current = state.jobs[jobId];
          const normalizedPreset = preset.trim();
          if (!current || !normalizedPreset || current.reasoningPreset === normalizedPreset) {
            return state;
          }
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                reasoningPreset: normalizedPreset,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      updateApprovalPolicy: (jobId, approvalPolicy) => {
        set(state => {
          const current = state.jobs[jobId];
          if (!current || current.approvalPolicy === approvalPolicy) {
            return state;
          }
          return {
            jobs: {
              ...state.jobs,
              [jobId]: {
                ...current,
                approvalPolicy,
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      dismissSession: (rawSessionId, knownJobId) => {
        const sessionId = rawSessionId.trim();
        const normalizedKnownJobId = knownJobId?.trim();
        const matchingJobIds = Object.values(get().jobs)
          .filter(job => job.sessionId === sessionId)
          .map(job => job.jobId);
        const ledger = recordDismissals(
          [
            ...matchingJobIds,
            ...(normalizedKnownJobId ? [normalizedKnownJobId] : []),
          ],
          sessionId ? [sessionId] : [],
        );
        set(state => {
          const dismissedJobIds = new Set(mergeDismissedIds(
            state.dismissedJobIds,
            ledger.dismissedJobIds,
            MAX_DISMISSED_JOB_IDS,
          ));
          for (const job of Object.values(state.jobs)) {
            if (job.sessionId === sessionId) {
              dismissedJobIds.add(job.jobId);
            }
          }

          const jobs = { ...state.jobs };
          const transportByJobId = { ...state.transportByJobId };
          for (const jobId of dismissedJobIds) {
            delete jobs[jobId];
            delete transportByJobId[jobId];
          }

          return {
            jobs,
            transportByJobId,
            lastReachableAtByJobId: omitKeys(state.lastReachableAtByJobId, dismissedJobIds),
            answeredPermissionIdsByJobId: omitKeys(
              state.answeredPermissionIdsByJobId,
              dismissedJobIds,
            ),
            cancelStateByJobId: omitKeys(state.cancelStateByJobId, dismissedJobIds),
            dismissedJobIds: Array.from(dismissedJobIds)
              .slice(-MAX_DISMISSED_JOB_IDS),
            dismissedSessionIds: mergeDismissedIds(
              state.dismissedSessionIds,
              ledger.dismissedSessionIds,
              MAX_DISMISSED_SESSION_IDS,
            ),
          };
        });
        const state = get();
        log.info('Dispatch diagnostic: projection dismissed', {
          sessionId,
          knownJobId: normalizedKnownJobId,
          matchingJobIds,
          persistedJobTombstone: normalizedKnownJobId
            ? state.dismissedJobIds.includes(normalizedKnownJobId)
            : false,
          persistedSessionTombstone: state.dismissedSessionIds.includes(sessionId),
          ledgerJobTombstone: normalizedKnownJobId
            ? ledger.dismissedJobIds.includes(normalizedKnownJobId)
            : matchingJobIds.length > 0
              && matchingJobIds.every(jobId => ledger.dismissedJobIds.includes(jobId)),
          ledgerSessionTombstone: ledger.dismissedSessionIds.includes(sessionId),
          dismissedJobCount: state.dismissedJobIds.length,
          dismissedSessionCount: state.dismissedSessionIds.length,
        });
      },

      dismissJob: (jobId) => {
        const sessionId = get().jobs[jobId]?.sessionId ?? '';
        get().dismissSession(sessionId, jobId);
      },

      removeJob: (jobId) => {
        set(state => {
          if (!(jobId in state.jobs)) return state;
          const jobs = { ...state.jobs };
          const transportByJobId = { ...state.transportByJobId };
          delete jobs[jobId];
          delete transportByJobId[jobId];
          return {
            jobs,
            transportByJobId,
            lastReachableAtByJobId: omitKeys(state.lastReachableAtByJobId, [jobId]),
            answeredPermissionIdsByJobId: omitKeys(state.answeredPermissionIdsByJobId, [jobId]),
            cancelStateByJobId: omitKeys(state.cancelStateByJobId, [jobId]),
          };
        });
      },

      clear: () => {
        clearDismissalLedger();
        set({
          jobs: {},
          transportByJobId: {},
          lastReachableAtByJobId: {},
          answeredPermissionIdsByJobId: {},
          cancelStateByJobId: {},
          dismissedJobIds: [],
          dismissedSessionIds: [],
        });
      },
    }),
    {
      name: DISPATCH_JOB_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(getDispatchStorage),
      partialize: state => ({
        jobs: state.jobs,
        dismissedJobIds: state.dismissedJobIds,
        dismissedSessionIds: state.dismissedSessionIds,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<DispatchJobStoreState>;
        const ledger = recordDismissals(
          persisted.dismissedJobIds ?? [],
          persisted.dismissedSessionIds ?? [],
        );
        const dismissedJobIds = mergeDismissedIds(
          persisted.dismissedJobIds ?? [],
          ledger.dismissedJobIds,
          MAX_DISMISSED_JOB_IDS,
        );
        const dismissedSessionIds = mergeDismissedIds(
          persisted.dismissedSessionIds ?? [],
          ledger.dismissedSessionIds,
          MAX_DISMISSED_SESSION_IDS,
        );
        const jobs = Object.fromEntries(
          Object.entries(persisted.jobs ?? {}).filter(([, job]) => (
            !dismissedJobIds.includes(job.jobId)
            && !dismissedSessionIds.includes(job.sessionId)
          )),
        );
        return {
          ...currentState,
          ...persisted,
          jobs,
          transportByJobId: {},
          lastReachableAtByJobId: {},
          answeredPermissionIdsByJobId: {},
          cancelStateByJobId: {},
          dismissedJobIds,
          dismissedSessionIds,
        };
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          log.error('Dispatch diagnostic: projection state rehydration failed', { error });
          return;
        }
        log.info('Dispatch diagnostic: projection state rehydrated', {
          jobIds: Object.keys(state?.jobs ?? {}),
          dismissedJobIds: state?.dismissedJobIds ?? [],
          dismissedSessionIds: state?.dismissedSessionIds ?? [],
        });
      },
    },
  ),
);

export const dispatchJobStore = useDispatchJobStore;
