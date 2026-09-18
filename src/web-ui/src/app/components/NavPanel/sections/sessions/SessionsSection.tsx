import { requireSessionWorkspaceId } from '@/flow_chat/utils/sessionWorkspace';
/**
 * SessionsSection — inline accordion content for the "Sessions" nav item.
 *
 * Rendered inside NavPanel when the Sessions item is expanded.
 * Owns all data fetching / mutation for chat sessions.
 */

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Icon, IconButton, Input, Menu, MenuItem, OverflowText, Tooltip } from '@openbitfun/ui';
import { createPortal } from 'react-dom';
import { Loader2, Archive, ListChecks } from 'lucide-react';
import { RetainedMountBoundary } from '@/shared/presence';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '../../../../../flow_chat/store/FlowChatStore';
import { flowChatManager } from '../../../../../flow_chat/services/FlowChatManager';
import type { FlowChatState, Session } from '../../../../../flow_chat/types/flow-chat';
import { useSceneStore } from '../../../../stores/sceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import {
  openBtwSessionInAuxPane,
  selectActiveBtwSessionTab,
} from '@/flow_chat/services/btwSessionPane';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import {
  dispatchHistorySessionOpenIntent,
  shouldShowHistorySessionOpenIntent,
} from '@/flow_chat/services/sessionOpenIntent';
import { recordHistorySessionDiagnosticEvent } from '@/flow_chat/services/historySessionDiagnostics';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import {
  sessionBelongsToWorkspaceNavRow,
} from '@/flow_chat/utils/sessionOrdering';
import {
  compareWorkspaceNavSessions,
  DEFAULT_WORKSPACE_SESSION_FILTERS,
  hasWorkspaceSessionFilters,
  matchesWorkspaceSessionView,
  useWorkspaceSessionViewStore,
} from '../../workspaceSessionView';
import { stateMachineManager } from '@/flow_chat/state-machine';
import { sessionNavStatusService } from '@/flow_chat/services/sessionNavStatusService';
import { i18nService } from '@/infrastructure/i18n';
import { isDefaultSessionTitle, resolveSessionTitle } from '@/flow_chat/utils/sessionTitle';
import { useSessionTitleNumbers } from '@/flow_chat/hooks/useSessionTitleNumbers';
import { SessionTitleNumber } from '@/flow_chat/components/SessionTitleNumber';
import { useSessionComposerStore } from '@/flow_chat/store/sessionComposerStore';
import { getActiveSurfaceId, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { isSessionNavRowActive } from './sessionNavSelection';
import { isSessionRowPointerTarget } from './sessionOpenPointer';
import {
  deriveSessionReviewActivity,
  isReviewActivityBlocking,
} from '@/flow_chat/utils/sessionReviewActivity';
import { useBackgroundSubagentActivityStore } from '@/flow_chat/store/backgroundSubagentActivityStore';
import type {
  BackgroundSubagentActivity,
  BackgroundSubagentActivityItem,
} from '@/flow_chat/utils/backgroundSubagentActivity';
import { useSideAnchoredPopoverPosition } from '@/shared/utils/useSideAnchoredPopoverPosition';
import {
  computeFixedPopoverPositionInViewport,
} from '@/shared/utils/fixedPopoverViewport';
import { exportSessionToMarkdown } from '@/flow_chat/services/sessionMarkdownExport';
import type { TranscriptExportScope } from '@/flow_chat/utils/dialogTranscriptExport';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import { notificationService } from '@/shared/notification-system';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { isOutcomeUnknownError } from '@/infrastructure/api/errors/TauriCommandError';
import { scheduleAfterStartupPaint, scheduleAfterStartupSignal } from '@/shared/utils/startupTaskScheduling';
import {
  isNonLocalDispatchTarget,
  type DispatchJobState,
} from '@/features/dispatch/types';
import { useDispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { resolveDispatchNavPresentation } from '@/features/dispatch/dispatchNavPresentation';
import {
  SESSION_METADATA_DEFERRED_FALLBACK_MS,
  SESSION_METADATA_DEFERRED_FRAME_COUNT,
  SESSION_METADATA_DEFERRED_SIGNAL,
  getDeferredSessionMetadataDelayMs,
  getInitialSessionMetadataLoadMode,
  hasStartupOverlayHandedOff,
} from './sessionMetadataStartup';
import {
  getEffectiveTopLevelSessionCount,
  getSessionBufferPrefetchLimit,
  getSessionDisplayLimit,
  getSessionExpandToggleState,
  SESSIONS_LEVEL_0,
  SESSIONS_LEVEL_1,
} from './sessionNavExpand';
import { useSessionRowRemovalTransition } from './sessionRowShift';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import './SessionsSection.scss';

const log = createLogger('SessionsSection');
const ScheduledJobsModal = lazy(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'));
const WorkspaceSessionBatchModal = lazy(() => import('../workspaces/WorkspaceSessionBatchModal'));

type HistoryOpenIntentDispatchResult = 'none' | 'dispatched' | 'already-pending';

/** Page size for the fully-expanded (level 2) session list. */
const SESSIONS_LEVEL_2_PAGE = 200;

/**
 * Delay before topping the off-screen row buffer back up. Keeps the refill out
 * of the startup burst and coalesces the repeated deletes of a cleanup pass.
 */
const SESSIONS_BUFFER_PREFETCH_DELAY_MS = 800;

const getTitle = (session: Session): string =>
  resolveSessionTitle(session, (key, options) => i18nService.t(key, options));

function DefaultSessionTitlePreview({ sessionId, createdAt }: Pick<Session, 'sessionId' | 'createdAt'>) {
  const draft = useSessionComposerStore(state =>
    state.drafts[surfaceScopedKey(getActiveSurfaceId(), sessionId)]?.value,
  );
  const firstLine = draft?.trim().split(/\r?\n/, 1)[0];
  return (
    <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
      {firstLine || i18nService.formatDate(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
    </div>
  );
}

const countTopLevelSessionsInScope = (
  sessions: Iterable<Session>, workspaceId?: string,
): number => {
  const scopedSessions = Array.from(sessions).filter((session: Session) => {
    if (session.isTransient || session.sessionKind === 'subagent') return false;
    return workspaceId ? sessionBelongsToWorkspaceNavRow(session, workspaceId) : !session.workspaceId;
  });

  const knownIds = new Set(scopedSessions.map(session => session.sessionId));
  return scopedSessions.reduce((count, session) => {
    const parentSessionId = resolveSessionRelationship(session).parentSessionId;
    if (parentSessionId && knownIds.has(parentSessionId)) {
      return count;
    }
    return count + 1;
  }, 0);
};

const getChildSessionBadge = (kind: Session['sessionKind']): string => {
  const normalizedKind =
    kind === 'review' || kind === 'deep_review' || kind === 'subagent'
      ? kind
      : 'btw';
  const fallback = normalizedKind === 'deep_review'
    ? 'Strict'
    : normalizedKind === 'review'
      ? 'Review'
      : normalizedKind === 'subagent'
        ? 'Agent'
      : 'btw';
  return i18nService.t(`flow-chat:childSession.kinds.${normalizedKind}.short`, {
    defaultValue: fallback,
  });
};

const getReviewActivityBadge = (kind: 'review' | 'deep_review'): string =>
  i18nService.t(
    kind === 'deep_review'
      ? 'common:nav.sessions.deepReviewRunning'
      : 'common:nav.sessions.reviewRunning',
    {
      defaultValue: 'Reviewing',
    },
  );

export interface AssistantSessionPresentation {
  kind: 'assistant';
  assistant: {
    id: string;
    name: string;
    avatar?: string | null;
    emoji?: string | null;
  };
}

interface SessionsSectionProps {
  /** Authoritative scope: every load, reset, and dedup key is `workspaceId`. */
  workspaceId?: string;
  /** IO/display projection of the scoped workspace root; never a scope key. */
  workspacePath?: string;
  isActiveWorkspace?: boolean;
  showCreateActions?: boolean;
  /** Product presentation for assistant-owned sessions. Project sessions use the compact row. */
  presentation?: AssistantSessionPresentation;
  /** Prevents startup metadata fetching while the surrounding section is collapsed. */
  isVisible?: boolean;
  /** Apply the Workspace section's shared sorting and display preferences. */
  useWorkspaceViewPreferences?: boolean;
  /** Multiple project scopes used by the flat "all sessions" projection. */
  workspaceScopes?: WorkspaceSessionScope[];
  /** Navigation geometry for nested workspace rows versus the flat aggregate list. */
  layout?: 'nested' | 'flat';
}

export interface WorkspaceSessionScope {
  /** Authoritative scope key; loads and dedup use only this. */
  workspaceId: string;
  workspaceName: string;
}

const SessionsSection: React.FC<SessionsSectionProps> = ({
  workspaceId,
  workspacePath,
  isActiveWorkspace = true,
  presentation,
  isVisible = true,
  useWorkspaceViewPreferences = false,
  workspaceScopes,
  layout = 'nested',
}) => {
  const { t } = useI18n('common');
  const storedSessionOrdering = useWorkspaceSessionViewStore(state => state.ordering);
  const storedSessionShow = useWorkspaceSessionViewStore(state => state.show);
  const storedSessionFilters = useWorkspaceSessionViewStore(state => state.filters);
  const sessionOrdering = useWorkspaceViewPreferences ? storedSessionOrdering : 'created';
  const sessionShow = useWorkspaceViewPreferences ? storedSessionShow : 'all';
  const sessionFilters = useWorkspaceViewPreferences
    ? storedSessionFilters
    : DEFAULT_WORKSPACE_SESSION_FILTERS;
  const hasActiveSessionFilter = sessionShow !== 'all' || hasWorkspaceSessionFilters(sessionFilters);
  const showAllWithoutLimit = layout === 'flat' && Boolean(workspaceScopes?.length);
  const sessionListClassName = `openbitfun-nav-panel__inline-list${layout === 'flat' ? ' is-flat-workspace-view' : ''}`;
  const { setActiveWorkspace, currentWorkspace } = useWorkspaceContext();
  const activeTabId = useSceneStore(s => s.activeTabId);
  const activeBtwSessionTab = useAgentCanvasStore(state => selectActiveBtwSessionTab(state as any));
  const activeBtwSessionData = activeBtwSessionTab?.content.data as
    | { childSessionId: string; parentSessionId: string; workspacePath?: string }
    | undefined;
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() =>
    flowChatStore.getState()
  );
  const backgroundSubagentActivities = useBackgroundSubagentActivityStore(state => state.activities);
  const dispatchTransportByJobId = useDispatchJobStore(state => state.transportByJobId);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [expandLevel, setExpandLevel] = useState<0 | 1 | 2>(0);
  // Grouped workspace history keeps its existing level-2 paging. The flat
  // aggregate projection bypasses this display cap and streams every page in.
  const [level2DisplayCount, setLevel2DisplayCount] = useState(SESSIONS_LEVEL_2_PAGE);

  useEffect(() => {
    if (expandLevel !== 2) {
      setLevel2DisplayCount(SESSIONS_LEVEL_2_PAGE);
    }
  }, [expandLevel]);
  const [metadataPageState, setMetadataPageState] = useState<{
    totalTopLevelCount: number | null;
    syncedTopLevelCount: number | null;
    nextCursor?: string;
    hasMore: boolean;
    isLoading: boolean;
    loadError: boolean;
  }>({
    totalTopLevelCount: null,
    syncedTopLevelCount: null,
    nextCursor: undefined,
    hasMore: false,
    isLoading: false,
    loadError: false,
  });
  const [aggregateLoadState, setAggregateLoadState] = useState<{
    isLoading: boolean;
    failedScopeCount: number;
  }>(() => ({
    isLoading: showAllWithoutLimit && isVisible,
    failedScopeCount: 0,
  }));
  const [aggregateReloadRequestId, setAggregateReloadRequestId] = useState(0);
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  /** Second level of the session menu: pick what a Markdown export includes. */
  const [isExportScopeMenu, setIsExportScopeMenu] = useState(false);
  const [exportingSessionId, setExportingSessionId] = useState<string | null>(null);
  const orderingRevision = useSyncExternalStore(
    sessionNavStatusService.subscribeOrdering,
    sessionNavStatusService.getOrderingSnapshot,
    sessionNavStatusService.getOrderingSnapshot,
  );
  const runningSessionIds = useMemo(() => {
    // The revision invalidates these reads from the live navigation service.
    void orderingRevision;
    return new Set([...flowChatState.sessions.keys()].filter(sessionNavStatusService.isRunning));
  }, [flowChatState.sessions, orderingRevision]);
  const [scheduledJobsSessionId, setScheduledJobsSessionId] = useState<string | null>(null);
  const [batchWorkspace, setBatchWorkspace] = useState<WorkspaceSessionScope | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sessionMenuPopoverRef = useRef<HTMLDivElement>(null);
  const sessionMenuAnchorRef = useRef<HTMLButtonElement>(null);
  /** How the open session menu was triggered: anchored to the "more" button or to a right-click point. */
  const sessionMenuAnchorKindRef = useRef<'button' | 'context'>('button');
  /** Viewport coordinates of the right-click that opened the menu. */
  const sessionMenuContextPointRef = useRef<{ x: number; y: number } | null>(null);
  const [contextSessionMenuPosition, setContextSessionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const anchoredSessionMenuPosition = useSideAnchoredPopoverPosition({
    open: openMenuSessionId !== null && sessionMenuAnchorKindRef.current === 'button',
    anchorRef: sessionMenuAnchorRef,
    popoverRef: sessionMenuPopoverRef,
    gap: 4,
    layoutRevision: `${openMenuSessionId}:${isExportScopeMenu}`,
  });
  const sessionMenuPosition = sessionMenuAnchorKindRef.current === 'context'
    ? contextSessionMenuPosition
    : anchoredSessionMenuPosition;
  const metadataLoadRequestIdRef = useRef(0);
  /** User-driven metadata loads still running; background loads yield to them. */
  const foregroundLoadCountRef = useRef(0);
  const initialMetadataLoadKeyRef = useRef<string | null>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);
  /** Last (scope, live, synced) triple a background reconcile ran for. */
  const liveReconcileSignatureRef = useRef<string | null>(null);
  /** Last (scope, cursor, size) triple a buffer prefetch ran for. */
  const bufferPrefetchSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    const selector = (s: FlowChatState): string => {
      const parts: string[] = [s.activeSessionId ?? ''];
      for (const session of s.sessions.values()) {
        const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];
        const dispatchTarget = session.config.dispatchTarget;
        const dispatchTargetSnapshot = dispatchTarget?.kind === 'ssh'
          ? `ssh:${dispatchTarget.connectionId}:${dispatchTarget.workspacePath}:${dispatchTarget.displayName}`
          : dispatchTarget?.kind === 'device'
            ? `device:${dispatchTarget.deviceId}:${dispatchTarget.workspacePath}:${dispatchTarget.displayName}`
            : 'local';
        parts.push(
          `${session.sessionId}|${session.isTransient ? '1':'0'}|${session.sessionKind}|` +
          `${session.parentSessionId ?? ''}|${session.parentToolCallId ?? ''}|${session.subagentType ?? ''}|` +
          `${session.workspacePath ?? ''}|${session.mode ?? ''}|${session.needsUserAttention ?? ''}|` +
          `${session.hasUnreadCompletion ?? ''}|${latestTurn?.status ?? ''}|` +
          `${session.title ?? ''}|${dispatchTargetSnapshot}|${session.config.dispatchJobState ?? ''}`
        );
      }
      return parts.join(';');
    };
    const unsub = flowChatStore.subscribeSelector(selector, (() => {
      setFlowChatState(flowChatStore.getState());
    }), { isEqual: (a, b) => a === b });
    return () => unsub();
  }, []);

  const backgroundSubagentActivityByParent = useMemo(() => {
    const itemsByParent = new Map<string, BackgroundSubagentActivityItem[]>();
    for (const item of Object.values(backgroundSubagentActivities)) {
      const items = itemsByParent.get(item.parentSessionId) ?? [];
      items.push(item);
      itemsByParent.set(item.parentSessionId, items);
    }

    const activityByParent = new Map<string, BackgroundSubagentActivity>();
    for (const [parentSessionId, items] of itemsByParent) {
      const sortedItems = [...items].sort((left, right) => (
        left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId)
      ));
      activityByParent.set(parentSessionId, {
        runningCount: sortedItems.filter(item => item.status === 'processing').length,
        finishingCount: sortedItems.filter(item => item.status === 'finishing').length,
        totalCount: sortedItems.length,
        items: sortedItems,
      });
    }

    return activityByParent;
  }, [backgroundSubagentActivities]);

  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  useEffect(() => {
    metadataLoadRequestIdRef.current += 1;
    initialMetadataLoadKeyRef.current = null;
    liveReconcileSignatureRef.current = null;
    bufferPrefetchSignatureRef.current = null;
    setExpandLevel(0);
    setMetadataPageState({
      totalTopLevelCount: null,
      syncedTopLevelCount: null,
      nextCursor: undefined,
      hasMore: false,
      isLoading: false,
      loadError: false,
    });
  }, [workspaceId]);

  const workspaceScopesKey = useMemo(
    () => workspaceScopes?.map(scope => scope.workspaceId).join('|') ?? '',
    [workspaceScopes],
  );

  useEffect(() => {
    if (!isVisible || !workspaceScopes?.length) {
      setAggregateLoadState({ isLoading: false, failedScopeCount: 0 });
      return;
    }

    let cancelled = false;
    setAggregateLoadState({ isLoading: true, failedScopeCount: 0 });

    const loadAllScopes = async () => {
      const results = await Promise.allSettled(workspaceScopes.map(async scope => {
        let cursor: string | undefined;
        do {
          const page = await flowChatStore.loadSessionMetadataPage(
            scope.workspaceId, SESSIONS_LEVEL_2_PAGE, cursor,
            'sessions_nav_all_grouping',
          );
          if (cancelled) return;
          cursor = page.hasMore ? page.nextCursor : undefined;
        } while (cursor);

        if (!sessionFilters.hideArchived && !cancelled) {
          await flowChatStore.loadArchivedSessionMetadata(
            scope.workspaceId,
          );
        }
      }));

      if (cancelled) return;

      let failedScopeCount = 0;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        failedScopeCount += 1;
        const scope = workspaceScopes[index];
        log.warn('Failed to load all-session workspace projection', {
          error: result.reason,
          workspaceId: scope?.workspaceId,
        });
      });
      setAggregateLoadState({ isLoading: false, failedScopeCount });
    };

    void loadAllScopes().catch(error => {
      if (!cancelled) {
        log.warn('Failed to coordinate all-session workspace projection', { error });
        setAggregateLoadState({
          isLoading: false,
          failedScopeCount: workspaceScopes.length,
        });
      }
    });
    return () => { cancelled = true; };
  }, [
    aggregateReloadRequestId,
    isVisible,
    sessionFilters.hideArchived,
    workspaceScopes,
    workspaceScopesKey,
  ]);

  useEffect(() => {
    if (!isVisible || sessionFilters.hideArchived || workspaceScopes?.length || !workspaceId) return;
    void flowChatStore.loadArchivedSessionMetadata(
      workspaceId!,
    ).catch(error => {
      log.warn('Failed to load archived session projection', { error });
    });
  }, [
    isVisible,
    sessionFilters.hideArchived,
    workspaceId,
    workspaceScopes,
  ]);

  const loadMetadataPage = useCallback(
    async (
      limit: number,
      cursor: string | undefined,
      source: string,
      options?: { background?: boolean },
    ) => {
      if (!workspaceId || limit <= 0) {
        return null;
      }

      // A background refresh only re-syncs counts for a list that is already on
      // screen. Surfacing its spinner (or its retry state) would make routine
      // upkeep — such as replacing the row a delete consumed — flash the list.
      // It also leaves the request id alone so it cannot strand a user-driven
      // load (which would otherwise never clear its spinner); instead it drops
      // its own result if anything else claimed the list meanwhile.
      const isBackgroundLoad = options?.background === true;
      if (isBackgroundLoad && foregroundLoadCountRef.current > 0) {
        return null;
      }

      const requestId = isBackgroundLoad
        ? metadataLoadRequestIdRef.current
        : metadataLoadRequestIdRef.current + 1;
      if (!isBackgroundLoad) {
        metadataLoadRequestIdRef.current = requestId;
        foregroundLoadCountRef.current += 1;
        setMetadataPageState(prev => ({
          ...prev,
          isLoading: true,
          loadError: false,
        }));
      }

      try {
        const page = await flowChatStore.loadSessionMetadataPage(
          workspaceId, limit, cursor,
          source
        );
        if (metadataLoadRequestIdRef.current === requestId) {
          const syncedTopLevelCount = countTopLevelSessionsInScope(
            flowChatStore.getState().sessions.values(),
            workspaceId,
          );
          setMetadataPageState({
            totalTopLevelCount: page.totalTopLevelCount,
            syncedTopLevelCount,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            isLoading: false,
            loadError: false,
          });
        }
        return page;
      } catch (error) {
        if (metadataLoadRequestIdRef.current === requestId && !isBackgroundLoad) {
          setMetadataPageState(prev => ({
            ...prev,
            isLoading: false,
            loadError: true,
          }));
        }
        log.warn('Failed to load visible session metadata page', { error, workspaceId, cursor, limit });
        return null;
      } finally {
        if (!isBackgroundLoad) {
          foregroundLoadCountRef.current = Math.max(foregroundLoadCountRef.current - 1, 0);
        }
      }
    },
    [workspaceId]
  );

  const initialMetadataKey = workspaceId ?? '';

  const loadInitialMetadataPage = useCallback(
    async (source: string) => {
      if (!workspaceId) {
        return;
      }
      if (initialMetadataLoadKeyRef.current === initialMetadataKey) {
        return;
      }

      initialMetadataLoadKeyRef.current = initialMetadataKey;
      const page = await loadMetadataPage(SESSIONS_LEVEL_0, undefined, source);
      if (!page && initialMetadataLoadKeyRef.current === initialMetadataKey) {
        initialMetadataLoadKeyRef.current = null;
      }
    },
    [initialMetadataKey, loadMetadataPage, workspaceId],
  );

  useEffect(() => {
    if (!isVisible || !workspaceId) {
      return;
    }

    const loadMode = getInitialSessionMetadataLoadMode({
      hasWorkspace: Boolean(workspaceId),
      isActiveWorkspace,
      isVisible,
      startupOverlayHandedOff: hasStartupOverlayHandedOff(),
    });

    if (loadMode === 'skip') {
      return;
    }

    if (loadMode === 'immediate') {
      void loadInitialMetadataPage('sessions_nav_initial_active');
      return;
    }

    let cancelled = false;
    let delayTimer: number | null = null;
    const scheduleDeferredMetadataLoad = () => {
      if (cancelled) {
        return;
      }
      const delayMs = getDeferredSessionMetadataDelayMs(workspaceId);
      const runDeferredLoad = () => {
        delayTimer = null;
        if (!cancelled) {
          void loadInitialMetadataPage('sessions_nav_initial_deferred');
        }
      };

      if (delayMs > 0) {
        delayTimer = window.setTimeout(runDeferredLoad, delayMs);
        return;
      }
      runDeferredLoad();
    };
    const cancelStartupSchedule = loadMode === 'after-startup-paint'
      ? scheduleAfterStartupPaint(scheduleDeferredMetadataLoad, {
          frameCount: SESSION_METADATA_DEFERRED_FRAME_COUNT,
        })
      : scheduleAfterStartupSignal(scheduleDeferredMetadataLoad, {
          signalName: SESSION_METADATA_DEFERRED_SIGNAL,
          fallbackTimeoutMs: SESSION_METADATA_DEFERRED_FALLBACK_MS,
          frameCount: SESSION_METADATA_DEFERRED_FRAME_COUNT,
        });

    return () => {
      cancelled = true;
      cancelStartupSchedule();
      if (delayTimer !== null) {
        window.clearTimeout(delayTimer);
      }
    };
  }, [
    isActiveWorkspace,
    isVisible,
    loadInitialMetadataPage,
    workspaceId,
  ]);

  useEffect(() => {
    const needsExpandedDataset = sessionOrdering !== 'updated' || hasActiveSessionFilter;
    if (!needsExpandedDataset || !isVisible || !workspaceId) {
      return;
    }

    setExpandLevel(2);
    setLevel2DisplayCount(SESSIONS_LEVEL_2_PAGE);
    void loadMetadataPage(
      SESSIONS_LEVEL_2_PAGE,
      undefined,
      'sessions_nav_view_preferences',
    );
  }, [
    isVisible,
    loadMetadataPage,
    sessionOrdering,
    hasActiveSessionFilter,
    workspaceId,
  ]);

  // When sessions are archived, reset stale metadata so the expand toggle
  // doesn't linger with old counts after all sessions are gone.
  useEffect(() => {
    const handler = () => {
      metadataLoadRequestIdRef.current += 1;
      liveReconcileSignatureRef.current = null;
      bufferPrefetchSignatureRef.current = null;
      setExpandLevel(0);
      setMetadataPageState({
        totalTopLevelCount: null,
        syncedTopLevelCount: null,
        nextCursor: undefined,
        hasMore: false,
        isLoading: false,
        loadError: false,
      });
      if (isVisible && workspaceId) {
        void loadMetadataPage(SESSIONS_LEVEL_0, undefined, 'sessions_nav_post_archive');
      }
    };
    window.addEventListener('openbitfun:session-archived', handler);
    return () => window.removeEventListener('openbitfun:session-archived', handler);
  }, [isVisible, workspaceId, loadMetadataPage]);

  const closeSessionMenu = useCallback(() => {
    setOpenMenuSessionId(null);
    setIsExportScopeMenu(false);
    setContextSessionMenuPosition(null);
    sessionMenuAnchorKindRef.current = 'button';
    sessionMenuContextPointRef.current = null;
  }, []);

  useEffect(() => {
    if (!openMenuSessionId) return;
    const handleOutside = (event: MouseEvent) => {
      if (!sessionMenuPopoverRef.current?.contains(event.target as Node)
        && !sessionMenuAnchorRef.current?.contains(event.target as Node)) {
        closeSessionMenu();
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [closeSessionMenu, openMenuSessionId]);

  const updateContextSessionMenuPosition = useCallback(() => {
    if (!openMenuSessionId || sessionMenuAnchorKindRef.current !== 'context') return;
    const point = sessionMenuContextPointRef.current;
    if (!point) return;
    const viewportPadding = 8;
    const gap = 4;
    const fallbackWidth = 160;
    const fallbackHeight = 96;
    const menuEl = sessionMenuPopoverRef.current;
    const width = menuEl?.offsetWidth ?? fallbackWidth;
    const height = menuEl?.offsetHeight ?? fallbackHeight;
    setContextSessionMenuPosition(computeFixedPopoverPositionInViewport(
      { left: point.x, right: point.x, top: point.y, bottom: point.y },
      width,
      height,
      { width: window.innerWidth, height: window.innerHeight },
      { gap, padding: viewportPadding },
    ));
  }, [openMenuSessionId]);

  useEffect(() => {
    if (!openMenuSessionId || sessionMenuAnchorKindRef.current !== 'context') return;

    updateContextSessionMenuPosition();
    const frameId = requestAnimationFrame(updateContextSessionMenuPosition);

    const handleViewportChange = () => updateContextSessionMenuPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isExportScopeMenu, openMenuSessionId, updateContextSessionMenuPosition]);

  const sessions = useMemo(
    () =>
      Array.from(flowChatState.sessions.values())
        .filter((s: Session) => {
          if (s.isTransient) {
            return false;
          }
          if (s.sessionKind === 'subagent') {
            return false;
          }
          if (workspaceScopes?.length) {
            return workspaceScopes.some(scope => sessionBelongsToWorkspaceNavRow(s, scope.workspaceId));
          }
          if (workspaceId) {
            return sessionBelongsToWorkspaceNavRow(s, workspaceId);
          }
          return !s.workspaceId;
        }),
    [flowChatState.sessions, workspaceId, workspaceScopes]
  );

  const { topLevelSessions: allTopLevelSessions, childrenByParent } = useMemo(() => {
    // Activity timestamps can change independently of the session records.
    void orderingRevision;
    const childMap = new Map<string, Session[]>();
    const parents: Session[] = [];

    const knownIds = new Set(sessions.map(s => s.sessionId));

    for (const s of sessions) {
      const pid = resolveSessionRelationship(s).parentSessionId;
      if (pid && typeof pid === 'string' && pid.trim() && knownIds.has(pid)) {
        const list = childMap.get(pid) || [];
        list.push(s);
        childMap.set(pid, list);
      } else {
        parents.push(s);
      }
    }

    const compareForCurrentView = (left: Session, right: Session) =>
      compareWorkspaceNavSessions(
        left,
        right,
        sessionOrdering,
        getTitle,
        session => runningSessionIds.has(session.sessionId),
        sessionNavStatusService.getSortTimestamp,
      );

    for (const [pid, list] of childMap) {
      childMap.set(pid, [...list].sort(compareForCurrentView));
    }

    return {
      topLevelSessions: [...parents].sort(compareForCurrentView),
      childrenByParent: childMap,
    };
  }, [orderingRevision, runningSessionIds, sessionOrdering, sessions]);

  const topLevelSessions = useMemo(
    () => allTopLevelSessions.filter(session => matchesWorkspaceSessionView(
      session,
      sessionShow,
      sessionFilters,
      runningSessionIds.has(session.sessionId),
    )),
    [allTopLevelSessions, runningSessionIds, sessionFilters, sessionShow],
  );

  const visibleChildrenByParent = useMemo(() => {
    if (!hasActiveSessionFilter) return childrenByParent;

    const filtered = new Map<string, Session[]>();
    for (const [parentId, children] of childrenByParent) {
      filtered.set(parentId, children.filter(session => matchesWorkspaceSessionView(
        session,
        sessionShow,
        sessionFilters,
        runningSessionIds.has(session.sessionId),
      )));
    }
    return filtered;
  }, [childrenByParent, hasActiveSessionFilter, runningSessionIds, sessionFilters, sessionShow]);

  const sessionDisplayLimit = useMemo(() => {
    return getSessionDisplayLimit({
      loadedTopLevelCount: topLevelSessions.length,
      expandLevel,
      level2DisplayCount,
      showAllWithoutLimit,
    });
  }, [topLevelSessions.length, expandLevel, level2DisplayCount, showAllWithoutLimit]);

  const totalTopLevelSessionCount = !hasActiveSessionFilter && !workspaceScopes?.length
    ? getEffectiveTopLevelSessionCount(
        metadataPageState.totalTopLevelCount,
        metadataPageState.syncedTopLevelCount,
        allTopLevelSessions.length,
        metadataPageState.isLoading,
      )
    : topLevelSessions.length;
  const hasMoreUnloadedSessions =
    !hasActiveSessionFilter && !workspaceScopes?.length && allTopLevelSessions.length < totalTopLevelSessionCount;
  const expandToggleState = getSessionExpandToggleState(totalTopLevelSessionCount, expandLevel);
  // The visible label stays short ("Show more") and the remaining count rides in
  // a trailing `+N` chip; screen readers get the full sentence via aria-label.
  // Keyed off `action` so the label, the chevron direction and the CSS hook on
  // data-session-nav-toggle-action can never disagree.
  const expandToggleLabels = useMemo((): {
    label: string;
    ariaLabel: string;
    remainingCount: number | null;
  } => {
    if (expandToggleState.action === 'show-more') {
      const count = expandToggleState.collapsedRemainingCount;
      return {
        label: t('nav.sessions.showMoreLabel'),
        ariaLabel: t('nav.sessions.showMore', { count }),
        remainingCount: count,
      };
    }
    if (expandToggleState.action === 'show-all') {
      const count = expandToggleState.expandedRemainingCount;
      return {
        label: t('nav.sessions.showAllLabel'),
        ariaLabel: t('nav.sessions.showAll', { count }),
        remainingCount: count,
      };
    }
    return {
      label: t('nav.sessions.showLess'),
      ariaLabel: t('nav.sessions.showLess'),
      remainingCount: null,
    };
  }, [
    expandToggleState.action,
    expandToggleState.collapsedRemainingCount,
    expandToggleState.expandedRemainingCount,
    t,
  ]);

  useEffect(() => {
    if (
      !isVisible ||
      !workspaceId ||
      metadataPageState.isLoading ||
      metadataPageState.totalTopLevelCount === null ||
      metadataPageState.syncedTopLevelCount === null ||
      allTopLevelSessions.length === metadataPageState.syncedTopLevelCount
    ) {
      return;
    }

    // Re-running for a scope whose counts have not moved would spin on a
    // failing backend, since a background load leaves the state untouched.
    const signature = [
      initialMetadataKey,
      allTopLevelSessions.length,
      metadataPageState.syncedTopLevelCount,
    ].join('\n');
    if (liveReconcileSignatureRef.current === signature) {
      return;
    }
    liveReconcileSignatureRef.current = signature;

    void loadMetadataPage(SESSIONS_LEVEL_0, undefined, 'sessions_nav_live_reconcile', {
      background: true,
    });
  }, [
    initialMetadataKey,
    isVisible,
    loadMetadataPage,
    metadataPageState.isLoading,
    metadataPageState.syncedTopLevelCount,
    metadataPageState.totalTopLevelCount,
    allTopLevelSessions.length,
    workspaceId,
  ]);

  // Keep a few rows loaded past the visible slice. Deleting a session then
  // promotes an already-loaded row in the same commit instead of leaving a gap
  // until a metadata round trip lands.
  useEffect(() => {
    if (
      !isVisible ||
      !workspaceId ||
      metadataPageState.isLoading ||
      metadataPageState.loadError ||
      metadataPageState.totalTopLevelCount === null ||
      !metadataPageState.nextCursor
    ) {
      return;
    }

    const prefetchLimit = getSessionBufferPrefetchLimit({
      expandLevel,
      loadedTopLevelCount: allTopLevelSessions.length,
      totalTopLevelCount: totalTopLevelSessionCount,
      hasMore: metadataPageState.hasMore,
    });
    if (prefetchLimit <= 0) {
      return;
    }

    const signature = [initialMetadataKey, metadataPageState.nextCursor, prefetchLimit].join('\n');
    if (bufferPrefetchSignatureRef.current === signature) {
      return;
    }

    const cursor = metadataPageState.nextCursor;
    const timer = window.setTimeout(() => {
      bufferPrefetchSignatureRef.current = signature;
      void loadMetadataPage(prefetchLimit, cursor, 'sessions_nav_buffer_prefetch', {
        background: true,
      });
    }, SESSIONS_BUFFER_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    allTopLevelSessions.length,
    expandLevel,
    initialMetadataKey,
    isVisible,
    loadMetadataPage,
    metadataPageState.hasMore,
    metadataPageState.isLoading,
    metadataPageState.loadError,
    metadataPageState.nextCursor,
    metadataPageState.totalTopLevelCount,
    totalTopLevelSessionCount,
    workspaceId,
  ]);

  const visibleItems = useMemo(() => {
    const visibleParents = topLevelSessions.slice(0, sessionDisplayLimit);
    const out: Array<{ session: Session; level: 0 | 1 }> = [];
    for (const p of visibleParents) {
      out.push({ session: p, level: 0 });
      const children = visibleChildrenByParent.get(p.sessionId) || [];
      for (const c of children) out.push({ session: c, level: 1 });
    }
    return out;
  }, [sessionDisplayLimit, topLevelSessions, visibleChildrenByParent]);

  const visibleSessionIds = useMemo(
    () => new Set(visibleItems.map(item => item.session.sessionId)),
    [visibleItems],
  );

  const visibleRowSignature = useMemo(
    () => visibleItems.map(item => item.session.sessionId).join('|'),
    [visibleItems],
  );
  useSessionRowRemovalTransition(sessionListRef, visibleRowSignature);

  const activeSessionId = flowChatState.activeSessionId;
  const scheduledJobsSession = scheduledJobsSessionId
    ? flowChatState.sessions.get(scheduledJobsSessionId) ?? null
    : null;
  const lastScheduledJobsSessionRef = useRef<Session | null>(null);
  if (scheduledJobsSession) {
    lastScheduledJobsSessionRef.current = scheduledJobsSession;
  }
  const retainedScheduledJobsSession = scheduledJobsSession ?? lastScheduledJobsSessionRef.current;
  const lastHistoryOpenIntentRef = useRef<{ sessionId: string; atMs: number } | null>(null);

  const dispatchHistoryOpenIntentForSession = useCallback(
    (session: Session, source: 'pointerdown' | 'switch'): HistoryOpenIntentDispatchResult => {
      const sessionId = session.sessionId;
      if (
        sessionId === activeSessionId ||
        !shouldShowHistorySessionOpenIntent(session, {
          isRunning: runningSessionIds.has(sessionId),
        })
      ) {
        return 'none';
      }

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const lastIntent = lastHistoryOpenIntentRef.current;
      if (
        lastIntent &&
        lastIntent.sessionId === sessionId &&
        now - lastIntent.atMs < 250
      ) {
        recordHistorySessionDiagnosticEvent(sessionId, 'history_open_intent_deduped', {
          source,
          ageMs: Math.round(now - lastIntent.atMs),
        });
        return 'already-pending';
      }

      lastHistoryOpenIntentRef.current = { sessionId, atMs: now };
      dispatchHistorySessionOpenIntent(sessionId, getTitle(session));
      recordHistorySessionDiagnosticEvent(sessionId, 'history_open_intent_source', {
        source,
      });
      return 'dispatched';
    },
    [activeSessionId, runningSessionIds],
  );

  const handleSwitch = useCallback(
    async (sessionId: string) => {
      if (editingSessionId) return;
      try {
        // Opening a row explicitly acknowledges its current unread result,
        // including an already-active session or an unopened history record.
        flowChatStore.clearSessionUnreadCompletion(sessionId);
        const session = flowChatStore.getState().sessions.get(sessionId);
        const historyOpenIntentDispatch = session
          ? dispatchHistoryOpenIntentForSession(session, 'switch')
          : 'none';
        if (session && historyOpenIntentDispatch !== 'none') {
          flowChatManager.preloadHistoricalSessionForOpen(sessionId);
        }
        const relationship = resolveSessionRelationship(session);
        const parentSessionId = relationship.parentSessionId;
        const matchingScope = session && workspaceScopes?.find(scope => sessionBelongsToWorkspaceNavRow(session, scope.workspaceId));
        const targetWorkspaceId = matchingScope?.workspaceId ?? workspaceId;
        const mustActivateWorkspace =
          Boolean(targetWorkspaceId) && targetWorkspaceId !== currentWorkspace?.id;
        const activateWorkspace = mustActivateWorkspace
          ? async (targetWorkspaceId: string) => {
              await setActiveWorkspace(targetWorkspaceId);
            }
          : undefined;

        const parentSession = parentSessionId
          ? flowChatStore.getState().sessions.get(parentSessionId)
          : undefined;
        if (relationship.canOpenInAuxPane && parentSessionId && parentSession && session) {
          await openMainSession(parentSessionId, {
            workspaceId: targetWorkspaceId,
            activateWorkspace,
          });
          openBtwSessionInAuxPane({
            childSessionId: sessionId,
            parentSessionId,
            workspaceId: targetWorkspaceId,
            workspacePath: session.workspacePath,
          });
          return;
        }

        if (sessionId === activeSessionId) {
          await openMainSession(sessionId, {
            workspaceId: targetWorkspaceId,
            activateWorkspace,
          });
          return;
        }

        await openMainSession(sessionId, {
          workspaceId: targetWorkspaceId,
          activateWorkspace,
        });
        window.dispatchEvent(
          new CustomEvent('flowchat:switch-session', { detail: { sessionId } })
        );
      } catch (err) {
        log.error('Failed to switch session', err);
      }
    },
    [
      activeSessionId,
      dispatchHistoryOpenIntentForSession,
      editingSessionId,
      setActiveWorkspace,
      workspaceId,
      workspaceScopes,
      currentWorkspace?.id,
    ]
  );

  const handleSessionOpenPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, session: Session) => {
      if (editingSessionId || session.sessionId === activeSessionId) {
        return;
      }
      if (event.button !== 0) {
        return;
      }

      // React portal events still bubble through the component tree. Only a
      // pointer physically inside the row is an intent to open that session;
      // menu actions rendered in the overlay host must not start hydration.
      if (!isSessionRowPointerTarget(event.currentTarget, event.target)) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('.openbitfun-nav-panel__inline-item-actions, .openbitfun-nav-panel__inline-item-edit')) {
        return;
      }

      const historyOpenIntentDispatch = dispatchHistoryOpenIntentForSession(session, 'pointerdown');
      if (historyOpenIntentDispatch !== 'none') {
        flowChatManager.preloadHistoricalSessionForOpen(session.sessionId);
      }
    },
    [activeSessionId, dispatchHistoryOpenIntentForSession, editingSessionId],
  );

  const resolveSessionTitle = getTitle;
  const titleNumbers = useSessionTitleNumbers(flowChatState.sessions);

  const handleMenuOpen = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (openMenuSessionId === sessionId) {
        closeSessionMenu();
        return;
      }
      sessionMenuAnchorKindRef.current = 'button';
      sessionMenuContextPointRef.current = null;
      setContextSessionMenuPosition(null);
      setIsExportScopeMenu(false);
      setOpenMenuSessionId(sessionId);
    },
    [closeSessionMenu, openMenuSessionId]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      if (editingSessionId === sessionId) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      sessionMenuAnchorKindRef.current = 'context';
      const point = { x: e.clientX, y: e.clientY };
      sessionMenuContextPointRef.current = point;
      const { top, left } = computeFixedPopoverPositionInViewport(
        { left: point.x, right: point.x, top: point.y, bottom: point.y },
        160,
        120,
        { width: window.innerWidth, height: window.innerHeight },
        { gap: 4, padding: 8 },
      );
      setContextSessionMenuPosition({ top, left });
      setIsExportScopeMenu(false);
      setOpenMenuSessionId(sessionId);
    },
    [editingSessionId]
  );

  const handleExportMarkdown = useCallback(
    async (e: React.MouseEvent, session: Session, scope: TranscriptExportScope) => {
      e.stopPropagation();
      closeSessionMenu();
      if (exportingSessionId) return;

      setExportingSessionId(session.sessionId);
      try {
        await exportSessionToMarkdown(
          {
            sessionId: session.sessionId,
            title: resolveSessionTitle(session),
            workspaceId: requireSessionWorkspaceId(session),
          },
          scope
        );
      } finally {
        setExportingSessionId(null);
      }
    },
    [closeSessionMenu, exportingSessionId, resolveSessionTitle]
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const session = flowChatStore.getState().sessions.get(sessionId);
      const confirmed = await confirmDanger(
        t('nav.sessions.deleteConfirmTitle'),
        t('nav.sessions.deleteConfirmMessage', {
          name: session ? resolveSessionTitle(session) : t('nav.sessions.untitled'),
        }),
        { confirmText: t('nav.sessions.delete') },
      );
      if (!confirmed) return;

      try {
        await flowChatManager.deleteChatSession(sessionId);
      } catch (err) {
        log.error('Failed to delete session', err);
      }
    },
    [resolveSessionTitle, t]
  );

  const handleArchive = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        await flowChatManager.archiveChatSession(sessionId);
        window.dispatchEvent(new CustomEvent('openbitfun:session-archived'));
        notificationService.success(t('nav.sessions.archivedAll', { count: 1 }), { duration: 3000 });
      } catch (err) {
        log.error('Failed to archive session', err);
      }
    },
    [t]
  );

  const handleCopySessionId = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const copied = await copyTextToClipboard(sessionId);
      if (copied) {
        notificationService.success(t('nav.sessions.copySessionIdSuccess'), { duration: 2000 });
      } else {
        notificationService.error(t('nav.sessions.copySessionIdFailed'), { duration: 3000 });
      }
    },
    [t]
  );

  const handleStartEdit = useCallback(
    (e: React.MouseEvent, session: Session) => {
      e.stopPropagation();
      setEditingSessionId(session.sessionId);
      setEditingTitle(resolveSessionTitle(session));
    },
    [resolveSessionTitle]
  );

  const handleConfirmEdit = useCallback(async () => {
    if (!editingSessionId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      try {
        await flowChatManager.renameChatSessionTitle(editingSessionId, trimmed);
      } catch (err) {
        log.error('Failed to update session title', { sessionId: editingSessionId, error: err });
        if (isOutcomeUnknownError(err)) {
          notificationService.warning(t('nav.sessions.renameOutcomeUnknown'), { duration: 6000 });
          try {
            await flowChatManager.reloadSessionTitle(editingSessionId);
          } catch (refreshError) {
            log.error('Failed to reload the session title after an unknown rename outcome', {
              sessionId: editingSessionId,
              error: refreshError,
            });
          }
        }
      }
    }
    setEditingSessionId(null);
    setEditingTitle('');
  }, [editingSessionId, editingTitle, t]);

  const handleCancelEdit = useCallback(() => {
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirmEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelEdit();
      }
    },
    [handleConfirmEdit, handleCancelEdit]
  );

  const handleExpandToggle = useCallback(async () => {
    if (metadataPageState.isLoading) {
      return;
    }

    const loadedTopLevelCount = topLevelSessions.length;
    const total = totalTopLevelSessionCount;

    if (expandLevel === 0) {
      const targetCount = Math.min(total, SESSIONS_LEVEL_1);
      if (
        loadedTopLevelCount < targetCount &&
        hasMoreUnloadedSessions &&
        metadataPageState.nextCursor
      ) {
        await loadMetadataPage(
          targetCount - loadedTopLevelCount,
          metadataPageState.nextCursor,
          'sessions_nav_expand_level_1'
        );
      }
      setExpandLevel(1);
      return;
    }

    if (expandLevel === 1 && total > SESSIONS_LEVEL_1) {
      if (
        loadedTopLevelCount < total &&
        hasMoreUnloadedSessions &&
        metadataPageState.nextCursor
      ) {
        await loadMetadataPage(
          total - loadedTopLevelCount,
          metadataPageState.nextCursor,
          'sessions_nav_expand_all'
        );
      }
      setExpandLevel(2);
      return;
    }

    setExpandLevel(0);
  }, [
    expandLevel,
    hasMoreUnloadedSessions,
    loadMetadataPage,
    metadataPageState.isLoading,
    metadataPageState.nextCursor,
    topLevelSessions.length,
    totalTopLevelSessionCount,
  ]);

  const aggregateLoadStatus = showAllWithoutLimit
    ? aggregateLoadState.isLoading
      ? (
          <div
            className="openbitfun-nav-panel__inline-loading"
            data-openbitfun-component="sessions-section"
            data-openbitfun-part="aggregateLoading"
            data-openbitfun-state="loading"
            data-testid="nav-session-aggregate-loading"
            role="status"
            aria-live="polite"
          >
            <Loader2 size={12} />
            <OverflowText>{t('nav.sessions.loading')}</OverflowText>
          </div>
        )
      : aggregateLoadState.failedScopeCount > 0
        ? (
            <Button
              variant="outline"
              size="sm"
              className="openbitfun-nav-panel__inline-action"
              data-openbitfun-state="partial"
              data-testid="nav-session-aggregate-retry"
              onClick={() => setAggregateReloadRequestId(current => current + 1)}
            >
              {t('nav.sessions.partialLoadFailedRetry')}
            </Button>
          )
        : null
    : null;

  if (allTopLevelSessions.length === 0) {
    if (aggregateLoadStatus) {
      return (
        <div data-openbitfun-component="sessions-section" data-openbitfun-part="root" className={sessionListClassName}>
          {aggregateLoadStatus}
        </div>
      );
    }
    if (metadataPageState.isLoading) {
      return (
        <div data-openbitfun-component="sessions-section" data-openbitfun-part="root" className={sessionListClassName}>
          <div className="openbitfun-nav-panel__inline-loading" data-openbitfun-component="sessions-section" data-openbitfun-part="loading" data-openbitfun-state="loading">
            <Loader2 size={12} />
            <OverflowText>{t('nav.sessions.loading')}</OverflowText>
          </div>
        </div>
      );
    }
    if (metadataPageState.loadError) {
      return (
        <div data-openbitfun-component="sessions-section" data-openbitfun-part="root" className={sessionListClassName}>
          <Button
            variant="outline"
            size="sm"
            className="openbitfun-nav-panel__inline-action"
            onClick={() => {
              void loadInitialMetadataPage('sessions_nav_manual_retry');
            }}
          >
            {t('nav.sessions.loadFailedRetry')}
          </Button>
        </div>
      );
    }
    return (
      <div className={sessionListClassName}>
        {presentation?.kind === 'assistant' ? (
          <div className="openbitfun-nav-panel__inline-empty is-assistant" aria-disabled="true">
            <AssistantAvatar
              presetId={presentation.assistant.avatar}
              emoji={presentation.assistant.emoji}
              stableKey={presentation.assistant.id}
              name={presentation.assistant.name}
              size={26}
            />
            <span className="openbitfun-nav-panel__inline-empty-copy">
              <OverflowText className="openbitfun-nav-panel__inline-empty-name">{presentation.assistant.name}</OverflowText>
              <span>{t('nav.sessions.noSessions')}</span>
            </span>
          </div>
        ) : (
          <div className="openbitfun-nav-panel__inline-empty" aria-disabled="true">
            {t('nav.sessions.noSessions')}
          </div>
        )}
      </div>
    );
  }

  if (topLevelSessions.length === 0) {
    if (aggregateLoadState.isLoading && aggregateLoadStatus) {
      return (
        <div className={sessionListClassName}>
          {aggregateLoadStatus}
        </div>
      );
    }
    return (
      <div className={sessionListClassName}>
        <div className="openbitfun-nav-panel__inline-empty" aria-disabled="true">
          {t('nav.sessions.viewMenu.noMatches')}
        </div>
        {aggregateLoadStatus}
      </div>
    );
  }

  return (
    <div className={sessionListClassName} ref={sessionListRef}>
      {visibleItems.map(({ session, level }) => {
          const isEditing = editingSessionId === session.sessionId;
          const relationship = resolveSessionRelationship(session);
          const isChildSession = level === 1 && relationship.displayAsChild;
          const childSessionBadge = getChildSessionBadge(relationship.kind);
          const parentReviewActivity = deriveSessionReviewActivity(
            flowChatState,
            session.sessionId,
            id => stateMachineManager.getCurrentState(id),
          );
          const showParentReviewActivity = !isChildSession && isReviewActivityBlocking(parentReviewActivity);
          const showChildReviewActivity =
            isChildSession && relationship.isReview && runningSessionIds.has(session.sessionId);
          const reviewActivityKind =
            showParentReviewActivity
              ? parentReviewActivity!.kind
              : showChildReviewActivity && (relationship.kind === 'review' || relationship.kind === 'deep_review')
                ? relationship.kind
                : null;
          const sessionTitle = resolveSessionTitle(session);
          const titleNumber = titleNumbers.get(session.sessionId);
          const displayTitle = titleNumber ? `${sessionTitle} ${titleNumber}` : sessionTitle;
          const isDefaultTitle = isDefaultSessionTitle(session);
          const sessionWorkspaceScope = workspaceScopes?.find(scope => sessionBelongsToWorkspaceNavRow(session, scope.workspaceId));
          const backgroundSubagentActivity = !isChildSession
            ? backgroundSubagentActivityByParent.get(session.sessionId)
            : undefined;
          const backgroundSubagentActivityCount = backgroundSubagentActivity?.totalCount ?? 0;
          const showBackgroundSubagentActivity = !isChildSession && backgroundSubagentActivityCount > 0;
          const parentSessionId = relationship.parentSessionId;
          const parentSession = parentSessionId ? flowChatState.sessions.get(parentSessionId) : undefined;
          const parentTitle = parentSession ? resolveSessionTitle(parentSession) : '';
          const parentTurnIndex = relationship.origin?.parentTurnIndex;
          const assistantIdentity = presentation?.kind === 'assistant'
            ? presentation.assistant
            : null;
          const trimmedAssistant = assistantIdentity?.name.trim() ?? '';
          const showAssistantInTooltip = trimmedAssistant.length > 0;
          const dispatchTarget = session.config.dispatchTarget;
          const isDispatched = isNonLocalDispatchTarget(dispatchTarget);
          const dispatchTargetLabel =
            dispatchTarget?.kind === 'ssh' || dispatchTarget?.kind === 'device'
              ? dispatchTarget.displayName
              : '';
          const dispatchState = session.config.dispatchJobState ?? 'submitting';
          const dispatchStateLabel = {
            submitting: t('nav.sessions.dispatchStates.submitting'),
            submission_unknown: t('nav.sessions.dispatchStates.submission_unknown'),
            queued: t('nav.sessions.dispatchStates.queued'),
            running: t('nav.sessions.dispatchStates.running'),
            succeeded: t('nav.sessions.dispatchStates.succeeded'),
            failed: t('nav.sessions.dispatchStates.failed'),
            cancelled: t('nav.sessions.dispatchStates.cancelled'),
          } satisfies Record<DispatchJobState, string>;
          const dispatchTransport = session.config.dispatchJobId
            ? dispatchTransportByJobId[session.config.dispatchJobId]
            : undefined;
          const dispatchPresentation = isDispatched
            ? resolveDispatchNavPresentation({
                targetLabel: dispatchTargetLabel,
                state: dispatchState,
                reachability: dispatchTransport?.reachability,
                runningSummary: t('nav.sessions.dispatchRunningOn', {
                  target: dispatchTargetLabel,
                  state: dispatchStateLabel[dispatchState],
                }),
                unreachableLabel: t('nav.sessions.dispatchUnreachable'),
                unreachableSummary: t('nav.sessions.dispatchUnreachableDetails', {
                  target: dispatchTargetLabel,
                }),
              })
            : null;
          const showRichTooltip =
            isDefaultTitle ||
            Boolean(sessionWorkspaceScope) ||
            showAssistantInTooltip ||
            isChildSession ||
            showBackgroundSubagentActivity ||
            isDispatched;
          const tooltipContent = showRichTooltip ? (
            <div className="openbitfun-nav-panel__inline-item-tooltip">
              <div className="openbitfun-nav-panel__inline-item-tooltip-title">{displayTitle}</div>
              {isDefaultTitle ? (
                <DefaultSessionTitlePreview sessionId={session.sessionId} createdAt={session.createdAt} />
              ) : null}
              {sessionWorkspaceScope ? (
                <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                  {sessionWorkspaceScope.workspaceName}
                </div>
              ) : null}
              {showAssistantInTooltip ? (
                <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                  {t('nav.sessions.assistantOwner', { name: trimmedAssistant })}
                </div>
              ) : null}
              {isChildSession ? (
                <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                  {parentTurnIndex
                    ? t('nav.sessions.childSourceWithTurn', {
                        parentTitle: parentTitle || t('nav.sessions.parentSession'),
                        turnIndex: parentTurnIndex,
                      })
                    : t('nav.sessions.childSourceWithoutTurn', {
                        parentTitle: parentTitle || t('nav.sessions.parentSession'),
                  })}
                </div>
              ) : null}
              {isDispatched ? (
                <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                  {dispatchPresentation?.summary}
                </div>
              ) : null}
              {showBackgroundSubagentActivity && backgroundSubagentActivity ? (
                <>
                  <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                    {t('nav.sessions.backgroundSubagentsRunning', {
                      count: backgroundSubagentActivityCount,
                    })}
                  </div>
                  {backgroundSubagentActivity.items.length > 0 ? (
                    <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                      {backgroundSubagentActivity.items
                        .slice(0, 2)
                        .map(item => item.title)
                        .join(' · ')}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            sessionTitle
          );
          const isRowActive = isSessionNavRowActive({
            rowSessionId: session.sessionId,
            activeTabId,
            activeSessionId,
            activeChildSessionId: activeBtwSessionData?.childSessionId,
            activeChildParentSessionId: activeBtwSessionData?.parentSessionId,
            activeChildHasVisibleRow: activeBtwSessionData?.childSessionId
              ? visibleSessionIds.has(activeBtwSessionData.childSessionId)
              : false,
          });
          const showAssistantIdentity = Boolean(assistantIdentity && !isChildSession);
          const row = (
            <div
              className={[
                'openbitfun-nav-panel__inline-item',
                showAssistantIdentity && 'is-assistant-session',
                level === 1 && 'is-child',
                isChildSession && 'is-btw-child',
                isRowActive && 'is-active',
                isEditing && 'is-editing',
                openMenuSessionId === session.sessionId && 'is-menu-open',
              ]
                .filter(Boolean)
                .join(' ')}
              data-openbitfun-component="sessions-section"
              data-openbitfun-part="row"
              data-overflow-trigger
              data-openbitfun-state={[
                isRowActive && 'active',
                isEditing && 'editing',
                openMenuSessionId === session.sessionId && 'menuOpen',
              ].filter(Boolean).join(' ') || undefined}
              data-testid="nav-session-item"
              aria-label={displayTitle}
              data-session-id={session.sessionId}
              data-session-kind={relationship.kind}
              data-session-level={String(level)}
              data-session-active={isRowActive ? 'true' : 'false'}
              onPointerDown={event => handleSessionOpenPointerDown(event, session)}
              onClick={() => handleSwitch(session.sessionId)}
              onContextMenu={event => handleContextMenu(event, session.sessionId)}
            >
              {showAssistantIdentity && assistantIdentity ? (
                <span className="openbitfun-nav-panel__inline-item-avatar" data-openbitfun-component="sessions-section" data-openbitfun-part="assistantAvatar">
                  <AssistantAvatar
                    presetId={assistantIdentity.avatar}
                    emoji={assistantIdentity.emoji}
                    stableKey={assistantIdentity.id}
                    name={assistantIdentity.name}
                    size={26}
                    active={isRowActive}
                  />
                </span>
              ) : null}

              {isEditing ? (
                <div className="openbitfun-nav-panel__inline-item-edit" data-openbitfun-component="sessions-section" data-openbitfun-part="edit" onClick={e => e.stopPropagation()}>
                  <Input
                    ref={editInputRef}
                    className="openbitfun-nav-panel__inline-item-edit-field"
                    value={editingTitle}
                    onChange={e => setEditingTitle(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    onBlur={handleConfirmEdit}
                    size="sm"
                  />
                  <Tooltip content={t('nav.sessions.confirmEdit')} placement="top">
                    <IconButton
                      aria-label={t('nav.sessions.confirmEdit')}
                      variant="quiet"
                      size="sm"
                      className="openbitfun-nav-panel__inline-item-edit-btn confirm"
                      onClick={e => { e.stopPropagation(); handleConfirmEdit(); }}
                      icon={<Icon name="check-line" size="2xs" />}
                    />
                  </Tooltip>
                  <Tooltip content={t('nav.sessions.cancelEdit')} placement="top">
                    <IconButton
                      aria-label={t('nav.sessions.cancelEdit')}
                      size="sm"
                      className="openbitfun-nav-panel__inline-item-edit-btn cancel"
                      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); handleCancelEdit(); }}
                      icon={<Icon name="xmark" size="2xs" />}
                    />
                  </Tooltip>
                </div>
              ) : (
                <>
                  <span className="openbitfun-nav-panel__inline-item-main" data-openbitfun-component="sessions-section" data-openbitfun-part="rowMain">
                    <span className="openbitfun-nav-panel__inline-item-copy">
                      <span className="openbitfun-nav-panel__inline-item-primary">
                        <span className="openbitfun-nav-panel__inline-item-title">
                          <OverflowText behavior="marquee" title="" className="openbitfun-nav-panel__inline-item-label">{sessionTitle}</OverflowText>
                          <SessionTitleNumber number={titleNumber} />
                        </span>
                    {isChildSession ? (
                      <span className="openbitfun-nav-panel__inline-item-btw-badge">{childSessionBadge}</span>
                    ) : null}
                    {isDispatched ? (
                      <span
                        className="openbitfun-nav-panel__inline-item-dispatch-badge"
                        data-state={dispatchPresentation?.visualState}
                        title={dispatchPresentation?.summary}
                      ><OverflowText>
                        {dispatchPresentation?.badgeLabel}
                      </OverflowText></span>
                    ) : null}
                    {reviewActivityKind ? (
                      <span className="openbitfun-nav-panel__inline-item-review-badge">
                        <Loader2 size={9} aria-hidden />
                        {getReviewActivityBadge(reviewActivityKind)}
                      </span>
                    ) : null}
                        {showBackgroundSubagentActivity ? (
                      <span
                        className="openbitfun-nav-panel__inline-item-background-subagent-badge"
                        aria-label={t('nav.sessions.backgroundSubagentsRunning', {
                          count: backgroundSubagentActivityCount,
                        })}
                      >
                        <Icon
                          name="user"
                          className="openbitfun-nav-panel__inline-item-background-subagent-icon is-agent"
                          size="2xs"
                          aria-hidden
                        />
                        <Loader2
                          className="openbitfun-nav-panel__inline-item-background-subagent-icon is-loader"
                          size={10}
                          aria-hidden
                        />
                      </span>
                        ) : null}
                        {sessionWorkspaceScope && !isChildSession ? (
                          <OverflowText className="openbitfun-nav-panel__inline-item-workspace-name">
                            {sessionWorkspaceScope.workspaceName}
                          </OverflowText>
                        ) : null}
                      </span>
                      {showAssistantIdentity ? (
                        <OverflowText className="openbitfun-nav-panel__inline-item-assistant-name">{trimmedAssistant}</OverflowText>
                      ) : null}
                    </span>
                  </span>
                  <div className="openbitfun-nav-panel__inline-item-trailing">
                    <SessionStatusIndicator sessionId={session.sessionId} />
                    <div
                      className={`openbitfun-nav-panel__inline-item-actions${openMenuSessionId === session.sessionId ? ' is-open' : ''}`}
                      data-openbitfun-component="sessions-section"
                      data-openbitfun-part="actions"
                      data-openbitfun-state={openMenuSessionId === session.sessionId ? 'menuOpen' : undefined}
                    >
                      <button
                        type="button"
                        ref={openMenuSessionId === session.sessionId ? sessionMenuAnchorRef : undefined}
                        className={`openbitfun-nav-panel__inline-item-action-btn${openMenuSessionId === session.sessionId ? ' is-open' : ''}`}
                        onClick={e => handleMenuOpen(e, session.sessionId)}
                        aria-label={`${sessionTitle} · ${t('actions.more')}`}
                        aria-haspopup="menu"
                        aria-expanded={openMenuSessionId === session.sessionId}
                        data-testid="nav-session-menu-btn"
                        data-session-id={session.sessionId}
                      >
                        <Icon name="more" size="xs" />
                      </button>
                    </div>
                  </div>
                  {openMenuSessionId === session.sessionId && createPortal(
                    <Menu
                      ref={sessionMenuPopoverRef}
                      className="openbitfun-nav-panel__inline-item-menu-popover"
                      data-openbitfun-component="sessions-section"
                      data-openbitfun-part="menu"
                      data-openbitfun-state="menuOpen"
                      style={{
                        top: sessionMenuPosition?.top ?? 0,
                        left: sessionMenuPosition?.left ?? 0,
                        visibility: sessionMenuPosition ? 'visible' : 'hidden',
                      }}
                      data-testid="nav-session-menu"
                      data-session-id={session.sessionId}
                    >
                      {isExportScopeMenu ? (
                        <>
                          <MenuItem
                            type="button"
                            leading={<Icon name="chevron-left" />}
                            onClick={e => {
                              e.stopPropagation();
                              setIsExportScopeMenu(false);
                            }}
                            data-testid="nav-session-menu-export-back"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.exportMarkdown')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="arrow-down" size="lg" style={{ width: 13, height: 13 }} />}
                            onClick={e => { void handleExportMarkdown(e, session, 'full'); }}
                            data-testid="nav-session-menu-export-full"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.exportMarkdownFull')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="arrow-down" size="lg" style={{ width: 13, height: 13 }} />}
                            onClick={e => { void handleExportMarkdown(e, session, 'result'); }}
                            data-testid="nav-session-menu-export-result"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.exportMarkdownResult')}</span>
                          </MenuItem>
                        </>
                      ) : (
                        <>
                          <MenuItem
                            type="button"
                            leading={<Icon name="edit" size="xs" />}
                            onClick={e => { closeSessionMenu(); handleStartEdit(e, session); }}
                            data-testid="nav-session-menu-rename"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.rename')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="duplicate" size="xs" />}
                            onClick={e => { closeSessionMenu(); void handleCopySessionId(e, session.sessionId); }}
                            data-testid="nav-session-menu-copy-id"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.copySessionId')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setIsExportScopeMenu(true);
                            }}
                            disabled={exportingSessionId === session.sessionId}
                            data-testid="nav-session-menu-export-markdown"
                            data-session-id={session.sessionId}
                            leading={exportingSessionId === session.sessionId
                              ? <Loader2 size={13} className="openbitfun-nav-panel__inline-toggle-spinner" />
                              : <Icon name="arrow-down" size="lg" style={{ width: 13, height: 13 }} />}
                          >
                            <span>{t('nav.sessions.exportMarkdown')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="clock" size="xs" />}
                            onClick={e => {
                              e.stopPropagation();
                              closeSessionMenu();
                              setScheduledJobsSessionId(session.sessionId);
                            }}
                            disabled={!workspacePath}
                            data-testid="nav-session-menu-scheduled-jobs"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.scheduledJobs.open')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon glyph={Archive} />}
                            onClick={e => { closeSessionMenu(); void handleArchive(e, session.sessionId); }}
                            data-testid="nav-session-menu-archive"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.archive')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon glyph={ListChecks} />}
                            disabled={!workspaceId && !session.projectWorkspaceId && !session.workspaceId}
                            onClick={e => {
                              e.stopPropagation();
                              closeSessionMenu();
                              const batchWorkspaceId = workspaceId || session.projectWorkspaceId || session.workspaceId;
                              if (!batchWorkspaceId) return;
                              const path = workspacePath || session.projectWorkspacePath || session.workspacePath || '';
                              setBatchWorkspace({
                                workspaceId: batchWorkspaceId,
                                workspaceName: presentation?.assistant.name
                                  || (currentWorkspace?.id === batchWorkspaceId && currentWorkspace.name)
                                  || path
                                  || batchWorkspaceId,
                              });
                            }}
                            data-testid="nav-session-menu-manage-sessions"
                          >
                            <span>{t('nav.sessions.manage')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            tone="danger"
                            leading={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
                            onClick={e => { closeSessionMenu(); void handleDelete(e, session.sessionId); }}
                            data-testid="nav-session-menu-delete"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.delete')}</span>
                          </MenuItem>
                        </>
                      )}
                    </Menu>,
                    getAppearanceOverlayHost()
                  )}
                </>
              )}
            </div>
          );
          // Always wrapped, even while editing or with a row menu open: swapping
          // the wrapper out would change every row's element type, remounting
          // the whole list (and flashing it) on each menu open/close.
          return (
            <Tooltip
              key={session.sessionId}
              content={tooltipContent}
              placement="right"
              disabled={isEditing || openMenuSessionId !== null}
            >
              {row}
            </Tooltip>
          );
        })}

      {aggregateLoadStatus}

      {!showAllWithoutLimit && expandLevel === 2 && topLevelSessions.length > sessionDisplayLimit && (
        <button data-overflow-trigger
          type="button"
          className="openbitfun-nav-panel__inline-toggle"
          data-testid="nav-session-list-load-more"
          aria-label={t('nav.sessions.showMore', {
            count: topLevelSessions.length - sessionDisplayLimit,
          })}
          onClick={() => setLevel2DisplayCount(prev => prev + SESSIONS_LEVEL_2_PAGE)}
        >
          <OverflowText className="openbitfun-nav-panel__inline-toggle-label">
            {t('nav.sessions.showMoreLabel')}
          </OverflowText>
          <span className="openbitfun-nav-panel__inline-toggle-count" aria-hidden>
            +{topLevelSessions.length - sessionDisplayLimit}
          </span>
          <Icon name="chevron-down" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
        </button>
      )}

      {!showAllWithoutLimit && expandToggleState.shouldRender && (
        <button data-overflow-trigger
          type="button"
          className={`openbitfun-nav-panel__inline-toggle${metadataPageState.isLoading ? ' is-loading' : ''}`}
          data-openbitfun-component="sessions-section"
          data-openbitfun-part="toggle"
          data-openbitfun-state={metadataPageState.isLoading ? 'loading' : undefined}
          data-testid="nav-session-list-toggle"
          data-session-nav-toggle-action={expandToggleState.action}
          aria-label={expandToggleLabels.ariaLabel}
          disabled={metadataPageState.isLoading}
          onClick={() => { void handleExpandToggle(); }}
        >
          <OverflowText className="openbitfun-nav-panel__inline-toggle-label">
            {expandToggleLabels.label}
          </OverflowText>
          {expandToggleLabels.remainingCount !== null && (
            <span className="openbitfun-nav-panel__inline-toggle-count" aria-hidden>
              +{expandToggleLabels.remainingCount}
            </span>
          )}
          {metadataPageState.isLoading ? (
            <Loader2 size={12} className="openbitfun-nav-panel__inline-toggle-spinner" aria-hidden />
          ) : expandToggleLabels.remainingCount === null ? (
            <Icon name="chevron-up" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
          ) : (
            <Icon name="chevron-down" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
          )}
        </button>
      )}

      <RetainedMountBoundary present={scheduledJobsSession != null}>
        {retainedScheduledJobsSession && (
          <Suspense fallback={null}>
            <ScheduledJobsModal
              isOpen={scheduledJobsSession != null}
              onClose={() => setScheduledJobsSessionId(null)}
              workspaceId={retainedScheduledJobsSession.workspaceId || workspaceId}
              sessionId={retainedScheduledJobsSession.sessionId}
              targetKind="session"
              lockSessionId
              title={t('nav.scheduledJobs.title')}
              targetLabel={resolveSessionTitle(retainedScheduledJobsSession)}
              targetDescription={retainedScheduledJobsSession.workspacePath || workspacePath}
            />
          </Suspense>
        )}
      </RetainedMountBoundary>
      {batchWorkspace && (
        <Suspense fallback={null}>
          <WorkspaceSessionBatchModal
            isOpen
            onClose={() => setBatchWorkspace(null)}
            workspaceId={batchWorkspace.workspaceId}
            workspaceLabel={batchWorkspace.workspaceName}
          />
        </Suspense>
      )}
    </div>
  );
};

export default SessionsSection;
