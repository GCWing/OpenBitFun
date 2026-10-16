import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Session } from '@/flow_chat/types/flow-chat';
import { isWorktreeIsolatedSession } from '@/flow_chat/utils/sessionOrdering';
import type { ManualOrderScopeKey, SessionOrderingMode } from '@/flow_chat/utils/sessionManualOrder';

export type WorkspaceSessionGrouping = 'grouped' | 'all';
/**
 * Navigation ordering modes. `manual` defers to the drag order stored per scope,
 * and the alias keeps every mode assignable to the shared ordering contract.
 */
export type WorkspaceSessionOrdering = SessionOrderingMode;
export type WorkspaceSessionShow = 'all' | 'unread' | 'attention';
export type WorkspaceSessionStatus = 'running' | 'attention' | 'error' | 'completed' | 'idle';
export type WorkspaceSessionEnvironment = 'local' | 'remote' | 'detached';
export type WorkspaceSessionSource = 'openbitfun' | 'external';
export type WorkspaceSessionWorktree = 'main' | 'worktree';

export interface WorkspaceSessionFilters {
  hiddenStatuses: WorkspaceSessionStatus[];
  hiddenEnvironments: WorkspaceSessionEnvironment[];
  hiddenSources: WorkspaceSessionSource[];
  hiddenWorktrees: WorkspaceSessionWorktree[];
  hideArchived: boolean;
}

export interface WorkspaceSessionViewPreferences {
  grouping: WorkspaceSessionGrouping;
  ordering: WorkspaceSessionOrdering;
  show: WorkspaceSessionShow;
  filters: WorkspaceSessionFilters;
}

/** Drag order per scope key; only scopes the user actually reordered are listed. */
type WorkspaceSessionManualOrder = Record<ManualOrderScopeKey, string[]>;

interface WorkspaceSessionViewState extends WorkspaceSessionViewPreferences {
  manualOrder: WorkspaceSessionManualOrder;
  collapseAllRequestId: number;
  setGrouping: (grouping: WorkspaceSessionGrouping) => void;
  setOrdering: (ordering: WorkspaceSessionOrdering) => void;
  setManualOrder: (scopeKey: ManualOrderScopeKey, order: readonly string[]) => void;
  setShow: (show: WorkspaceSessionShow) => void;
  toggleHiddenStatus: (value: WorkspaceSessionStatus) => void;
  toggleHiddenEnvironment: (value: WorkspaceSessionEnvironment) => void;
  toggleHiddenSource: (value: WorkspaceSessionSource) => void;
  toggleHiddenWorktree: (value: WorkspaceSessionWorktree) => void;
  toggleArchived: () => void;
  resetFilters: () => void;
  requestCollapseAll: () => void;
}

export const DEFAULT_WORKSPACE_SESSION_FILTERS: WorkspaceSessionFilters = {
  hiddenStatuses: [],
  hiddenEnvironments: [],
  hiddenSources: [],
  hiddenWorktrees: [],
  hideArchived: true,
};

export const DEFAULT_WORKSPACE_SESSION_VIEW: WorkspaceSessionViewPreferences = {
  grouping: 'grouped',
  ordering: 'updated',
  show: 'all',
  filters: DEFAULT_WORKSPACE_SESSION_FILTERS,
};

export const getNextWorkspaceSessionGrouping = (
  grouping: WorkspaceSessionGrouping,
): WorkspaceSessionGrouping => grouping === 'grouped' ? 'all' : 'grouped';

export const normalizeWorkspaceSessionGrouping = (value: unknown): WorkspaceSessionGrouping =>
  value === 'all' ? 'all' : 'grouped';

export const WORKSPACE_SESSION_ORDERING_MODES: readonly WorkspaceSessionOrdering[] = [
  'updated',
  'status',
  'created',
  'name',
  'manual',
];

/** Unknown or legacy persisted values fall back to recency instead of breaking the list. */
export const normalizeWorkspaceSessionOrdering = (value: unknown): WorkspaceSessionOrdering =>
  WORKSPACE_SESSION_ORDERING_MODES.includes(value as WorkspaceSessionOrdering)
    ? value as WorkspaceSessionOrdering
    : DEFAULT_WORKSPACE_SESSION_VIEW.ordering;

/** Shared stand-in for "no drag order stored yet", so selectors keep a stable reference. */
const EMPTY_MANUAL_ORDER: string[] = [];

/** A stored order only holds non-empty session ids, each at most once. */
function sanitizeManualOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isSanitizedManualOrder(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(id => typeof id === 'string' && id.length > 0)
    && new Set(value).size === value.length;
}

/** Tolerant parse of the persisted scope map: unusable entries are dropped, never thrown on. */
function normalizeWorkspaceSessionManualOrder(value: unknown): WorkspaceSessionManualOrder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: WorkspaceSessionManualOrder = {};
  for (const [scopeKey, order] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeManualOrder(order);
    if (sanitized.length > 0) normalized[scopeKey] = sanitized;
  }
  return normalized;
}

const sameManualOrder = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Returns the current map when the write changes nothing, so a repeated reconcile
 * during render cannot loop through the store. An empty order drops the scope
 * entirely instead of keeping an unused key in storage forever.
 */
function withManualOrder(
  current: WorkspaceSessionManualOrder,
  scopeKey: ManualOrderScopeKey,
  order: readonly string[],
): WorkspaceSessionManualOrder {
  const next = sanitizeManualOrder(order);
  const existing = sanitizeManualOrder(current[scopeKey]);
  if (sameManualOrder(existing, next)) return current;

  const updated = { ...current };
  if (next.length === 0) delete updated[scopeKey];
  else updated[scopeKey] = next;
  return updated;
}

const toggleArrayValue = <T extends string>(values: T[], value: T): T[] =>
  values.includes(value) ? values.filter(item => item !== value) : [...values, value];

export const useWorkspaceSessionViewStore = create<WorkspaceSessionViewState>()(
  persist(
    (set) => ({
      ...DEFAULT_WORKSPACE_SESSION_VIEW,
      manualOrder: {},
      collapseAllRequestId: 0,
      setGrouping: grouping => set({ grouping }),
      setOrdering: ordering => set({ ordering }),
      setManualOrder: (scopeKey, order) => set(state => {
        const manualOrder = withManualOrder(state.manualOrder, scopeKey, order);
        return manualOrder === state.manualOrder ? state : { manualOrder };
      }),
      setShow: show => set({ show }),
      toggleHiddenStatus: value => set(state => ({
        filters: { ...state.filters, hiddenStatuses: toggleArrayValue(state.filters.hiddenStatuses, value) },
      })),
      toggleHiddenEnvironment: value => set(state => ({
        filters: { ...state.filters, hiddenEnvironments: toggleArrayValue(state.filters.hiddenEnvironments, value) },
      })),
      toggleHiddenSource: value => set(state => ({
        filters: { ...state.filters, hiddenSources: toggleArrayValue(state.filters.hiddenSources, value) },
      })),
      toggleHiddenWorktree: value => set(state => ({
        filters: { ...state.filters, hiddenWorktrees: toggleArrayValue(state.filters.hiddenWorktrees, value) },
      })),
      toggleArchived: () => set(state => ({
        filters: { ...state.filters, hideArchived: !state.filters.hideArchived },
      })),
      resetFilters: () => set({ filters: DEFAULT_WORKSPACE_SESSION_FILTERS }),
      requestCollapseAll: () => set(state => ({ collapseAllRequestId: state.collapseAllRequestId + 1 })),
    }),
    {
      name: 'openbitfun.workspace-session-view.v2',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ grouping, ordering, show, filters, manualOrder }) => (
        { grouping, ordering, show, filters, manualOrder }
      ),
      merge: (persistedState, currentState): WorkspaceSessionViewState => {
        const state = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<WorkspaceSessionViewState>
          : {};
        return {
          ...currentState,
          ...state,
          grouping: normalizeWorkspaceSessionGrouping(state.grouping ?? currentState.grouping),
          ordering: normalizeWorkspaceSessionOrdering(state.ordering ?? currentState.ordering),
          manualOrder: normalizeWorkspaceSessionManualOrder(
            state.manualOrder ?? currentState.manualOrder,
          ),
        };
      },
      migrate: (persistedState: unknown) => {
        const state = persistedState && typeof persistedState === 'object'
          ? persistedState as Partial<WorkspaceSessionViewState> & { grouping?: unknown }
          : {};
        return {
          ...state,
          grouping: normalizeWorkspaceSessionGrouping(state.grouping),
        } as WorkspaceSessionViewState;
      },
    },
  ),
);

/**
 * Drag order of one scope, as persisted with the rest of the session view
 * preferences. The stored array is returned as-is so selectors keep a stable
 * reference; treat it as read-only and pass changes through `writeManualOrder`.
 */
export function readManualOrder(scopeKey: ManualOrderScopeKey): string[] {
  const stored = useWorkspaceSessionViewStore.getState().manualOrder[scopeKey];
  return isSanitizedManualOrder(stored) ? stored : EMPTY_MANUAL_ORDER;
}

/**
 * Persist the drag order of one scope. Best effort: storage being unavailable
 * must not break the drag interaction, and the store keeps the order in memory.
 */
export function writeManualOrder(scopeKey: ManualOrderScopeKey, order: readonly string[]): void {
  try {
    useWorkspaceSessionViewStore.getState().setManualOrder(scopeKey, order);
  } catch {
    // Presentation-only preference; the in-memory store already holds the order.
  }
}

export function deriveWorkspaceSessionStatus(
  session: Session,
  isRunning: boolean,
): WorkspaceSessionStatus {
  if (isRunning) return 'running';
  if (session.needsUserAttention) return 'attention';
  if (session.status === 'error' || session.error) return 'error';
  if (session.persistedStatus === 'completed' || typeof session.lastFinishedAt === 'number') return 'completed';
  return 'idle';
}

export function deriveWorkspaceSessionEnvironment(session: Session): WorkspaceSessionEnvironment {
  if (session.config.dispatchTarget) return 'detached';
  if (session.remoteConnectionId || session.remoteSshHost) return 'remote';
  return 'local';
}

export function deriveWorkspaceSessionSource(session: Session): WorkspaceSessionSource {
  return session.config.agentType?.startsWith('acp:') ? 'external' : 'openbitfun';
}

export function deriveWorkspaceSessionWorktree(session: Session): WorkspaceSessionWorktree {
  return isWorktreeIsolatedSession(session) ? 'worktree' : 'main';
}

const STATUS_ORDER: Record<WorkspaceSessionStatus, number> = {
  running: 0,
  attention: 1,
  error: 2,
  idle: 3,
  completed: 4,
};

export function compareWorkspaceNavSessions(
  left: Session,
  right: Session,
  ordering: WorkspaceSessionOrdering,
  getTitle: (session: Session) => string,
  isRunning: (session: Session) => boolean = () => false,
  getActivityTimestamp: (session: Session) => number = session => session.createdAt,
): number {
  if (ordering === 'name') {
    const titleDiff = getTitle(left).localeCompare(getTitle(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (titleDiff !== 0) return titleDiff;
  } else if (ordering === 'status') {
    const statusDiff = STATUS_ORDER[deriveWorkspaceSessionStatus(left, isRunning(left))]
      - STATUS_ORDER[deriveWorkspaceSessionStatus(right, isRunning(right))];
    if (statusDiff !== 0) return statusDiff;
  } else {
    const leftTimestamp = ordering === 'updated' ? getActivityTimestamp(left) : left.createdAt;
    const rightTimestamp = ordering === 'updated' ? getActivityTimestamp(right) : right.createdAt;
    const timestampDiff = rightTimestamp - leftTimestamp;
    if (timestampDiff !== 0) return timestampDiff;
  }

  const activityDiff = ordering === 'status' ? getActivityTimestamp(right) - getActivityTimestamp(left) : 0;
  return activityDiff || right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId);
}

export function matchesWorkspaceSessionView(
  session: Session,
  show: WorkspaceSessionShow,
  filters: WorkspaceSessionFilters,
  isRunning: boolean,
): boolean {
  if (show === 'unread' && !session.hasUnreadCompletion) return false;
  if (show === 'attention' && !session.needsUserAttention) return false;
  if (filters.hideArchived && session.persistedStatus === 'archived') return false;
  if (filters.hiddenStatuses.includes(deriveWorkspaceSessionStatus(session, isRunning))) return false;
  if (filters.hiddenEnvironments.includes(deriveWorkspaceSessionEnvironment(session))) return false;
  if (filters.hiddenSources.includes(deriveWorkspaceSessionSource(session))) return false;
  if (filters.hiddenWorktrees.includes(deriveWorkspaceSessionWorktree(session))) return false;
  return true;
}

export function hasWorkspaceSessionFilters(filters: WorkspaceSessionFilters): boolean {
  return filters.hiddenStatuses.length > 0
    || filters.hiddenEnvironments.length > 0
    || filters.hiddenSources.length > 0
    || filters.hiddenWorktrees.length > 0
    || filters.hideArchived !== DEFAULT_WORKSPACE_SESSION_FILTERS.hideArchived;
}
