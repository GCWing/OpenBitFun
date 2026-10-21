import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { useDeviceDirectory, resolveDeviceName } from '@/infrastructure/account/deviceDirectory';
import { requireSessionOwningWorkspaceId } from '@/flow_chat/utils/sessionOrdering';
import { isSessionEmptyForCopy } from '@/flow_chat/utils/sessionCopy';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { canCopySessionsOnSurface } from '@/infrastructure/peer-device/peerCapabilityResolution';
/**
 * SessionsSection — inline accordion content for the "Sessions" nav item.
 *
 * Rendered inside NavPanel when the Sessions item is expanded.
 * Owns all data fetching / mutation for chat sessions.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, Alert, Button, Icon, IconButton, Input, Menu, MenuItem, OverflowText, StatusPill, Tooltip } from '@openbitfun/ui';
import { Loader2, Archive, FolderGit2, FolderOpen, ListChecks } from 'lucide-react';
import { RetainedMountBoundary } from '@/shared/presence';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '../../../../../flow_chat/store/FlowChatStore';
import { flowChatManager } from '../../../../../flow_chat/services/FlowChatManager';
import type { FlowChatState, Session } from '../../../../../flow_chat/types/flow-chat';
import { useSceneStore } from '../../../../stores/sceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { sessionAPI, type SessionCatalogQuery, type SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { createLogger } from '@/shared/utils/logger';
import { isSamePath } from '@/shared/utils/pathUtils';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useSessionMenuPreferences, type SessionMenuAction } from './sessionMenuPreferences';
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
  isWorktreeIsolatedSession,
  sessionBelongsToWorkspaceNavRow,
} from '@/flow_chat/utils/sessionOrdering';
import { sessionWorktreeRootPath } from '@/flow_chat/utils/sessionWorktree';
import {
  compareWorkspaceNavSessions,
  DEFAULT_WORKSPACE_SESSION_FILTERS,
  hasWorkspaceSessionFilters,
  matchesWorkspaceSessionView,
  matchesWorkspaceSourceAgent,
  sessionSourceAgentLabel,
  useWorkspaceSessionViewStore,
} from '../../workspaceSessionView';
import { stateMachineManager } from '@/flow_chat/state-machine';
import { sessionNavStatusService } from '@/flow_chat/services/sessionNavStatusService';
import { i18nService } from '@/infrastructure/i18n';
import { isDefaultSessionTitle, resolveSessionTitle } from '@/flow_chat/utils/sessionTitle';
import { useSessionTitleNumbers } from '@/flow_chat/hooks/useSessionTitleNumbers';
import { SessionTitleNumber } from '@/flow_chat/components/SessionTitleNumber';
import { useSessionComposerStore } from '@/flow_chat/store/sessionComposerStore';
import { getActiveSurfaceId, getActiveSurfaceScope, isSurfaceChangedError, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { getWorkspaceSessionHierarchy } from './sessionNavHierarchy';
import { useWorkspaceSessionCatalog } from './useWorkspaceSessionCatalog';
import { captureWorkspaceSessionCatalogQuery, countPersistedWorkspaceCatalogSessions, workspaceSessionCatalogQuery, workspaceSessionCatalogTotal } from './workspaceSessionCatalogQuery';
import { useWorkspaceSessionDiscovery } from './useWorkspaceSessionDiscovery';
import { useSessionNavExpansion } from './useSessionNavExpansion';
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
  ensureCronJobCountsListener,
  getCronJobCountsSnapshot,
  subscribeCronJobCounts,
} from '@/app/components/scheduled-jobs/cronJobCountsStore';
import {
  SESSION_METADATA_DEFERRED_FALLBACK_MS,
  SESSION_METADATA_DEFERRED_FRAME_COUNT,
  SESSION_METADATA_DEFERRED_SIGNAL,
  getDeferredSessionMetadataDelayMs,
  getInitialSessionMetadataLoadMode,
  hasStartupOverlayHandedOff,
} from './sessionMetadataStartup';
import {
  getSessionDisplayLimit,
  getSessionExpandToggleState,
  SESSIONS_LEVEL_0,
  SESSIONS_LEVEL_1,
} from './sessionNavExpand';
import { useSessionRowRemovalTransition } from './sessionRowShift';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { createSessionsNavSelector } from './sessionsNavSelector';
import './SessionsSection.scss';

const log = createLogger('SessionsSection');
const ScheduledJobsModal = lazyWithRecovery(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'));
const WorkspaceSessionBatchModal = lazyWithRecovery(() => import('../workspaces/WorkspaceSessionBatchModal'));

type HistoryOpenIntentDispatchResult = 'none' | 'dispatched' | 'already-pending';

/** Page size for the fully-expanded (level 2) session list. */
const SESSIONS_LEVEL_2_PAGE = 200;

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
  /** Close a containing history surface after explicit session navigation. */
  onSessionOpened?: () => void;
  /** Assistant history owns persistence; ordinary project rows do not expose this action. */
  defaultSessionAction?: {
    sessionId: string | null;
    disabled: boolean;
    disabledReason?: string;
    onChange: (sessionId: string | null) => void;
  };
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
  onSessionOpened,
  defaultSessionAction,
}) => {
  useDeviceDirectory();
  const { t } = useI18n('common');
  useEffect(() => { ensureCronJobCountsListener(); }, []);
  const storedSessionOrdering = useWorkspaceSessionViewStore(state => state.ordering);
  const storedSessionShow = useWorkspaceSessionViewStore(state => state.show);
  const storedSessionFilters = useWorkspaceSessionViewStore(state => state.filters);
  const sourceAgents = useWorkspaceSessionViewStore(state => state.sourceAgents);
  const sourceAgent = sourceAgents[surfaceScopedKey(getActiveSurfaceId(), workspaceId)] ?? 'all';
  const hasSourceFilter = sourceAgent !== 'all' || Boolean(workspaceScopes?.some(scope =>
    (sourceAgents[surfaceScopedKey(getActiveSurfaceId(), scope.workspaceId)] ?? 'all') !== 'all'));
  const matchesSourceAgent = useCallback((session: Session) => matchesWorkspaceSourceAgent(
    session,
    sourceAgents[surfaceScopedKey(getActiveSurfaceId(), workspaceId ?? session.workspaceId ?? session.config.workspaceId)] ?? 'all',
  ), [sourceAgents, workspaceId]);
  const sessionOrdering = useWorkspaceViewPreferences ? storedSessionOrdering : 'created';
  const sessionShow = useWorkspaceViewPreferences ? storedSessionShow : 'all';
  const sessionFilters = useWorkspaceViewPreferences
    ? storedSessionFilters
    : DEFAULT_WORKSPACE_SESSION_FILTERS;
  const hasWorkspaceViewFilter = sessionShow !== 'all' || hasWorkspaceSessionFilters(sessionFilters);
  const hasActiveSessionFilter = hasSourceFilter || hasWorkspaceViewFilter;
  const showAllWithoutLimit = layout === 'flat' && Boolean(workspaceScopes?.length);
  const sessionListClassName = `openbitfun-nav-panel__inline-list${layout === 'flat' ? ' is-flat-workspace-view' : ''}`;
  const { setActiveWorkspace, openWorkspace, openedWorkspacesList, currentWorkspace } = useWorkspaceContext();
  const activeTabId = useSceneStore(s => s.activeTabId);
  const activeBtwSessionTab = useAgentCanvasStore(state => selectActiveBtwSessionTab(state as any));
  const activeBtwSessionData = activeBtwSessionTab?.content.data as
    | { childSessionId: string; parentSessionId: string; workspacePath?: string }
    | undefined;
  const sessionMenuPreferences = useSessionMenuPreferences();
  const isMenuActionVisible = (action: SessionMenuAction) => !sessionMenuPreferences.hiddenActions.includes(action);
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() =>
    flowChatStore.getState()
  );
  const peerDevice = usePeerDeviceModeOptional();
  const canCopySessions = canCopySessionsOnSurface(
    peerDevice?.peerMode.active ?? false,
    peerDevice?.currentPeerCapabilities ?? null,
  );
  const backgroundSubagentActivities = useBackgroundSubagentActivityStore(state => state.activities);
  const dispatchTransportByJobId = useDispatchJobStore(state => state.transportByJobId);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const { expandLevel, level2DisplayCount, setExpandLevel, setLevel2DisplayCount } = useSessionNavExpansion(
    `${surfaceScopedKey(getActiveSurfaceId(), workspaceId)}:${sourceAgent}`,
    SESSIONS_LEVEL_2_PAGE,
  );
  const surface = getActiveSurfaceScope();
  const initialMetadataKey = surface.key(workspaceId, surface.epoch);
  const [metadataPageState, setMetadataPageState] = useState<{
    loadedScope: string | null;
    isLoading: boolean;
    loadError: boolean;
    firstPage?: SessionMetadataPage;
  }>({
    loadedScope: null,
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
  const [catalogRefreshVersion, setCatalogRefreshVersion] = useState(0);
  const onDiscoveryCompleted = useCallback(() => {
    setCatalogRefreshVersion(value => value + 1);
    setAggregateReloadRequestId(value => value + 1);
  }, []);
  const discovery = useWorkspaceSessionDiscovery(
    workspaceScopes?.map(scope => scope.workspaceId) ?? (workspaceId ? [workspaceId] : []),
    isVisible,
    onDiscoveryCompleted,
  );
  const observeDiscovery = discovery.observe;
  const [openMenuSessionId, setOpenMenuSessionId] = useState<string | null>(null);
  /** Second level of the session menu: pick what a Markdown export includes. */
  const [isExportScopeMenu, setIsExportScopeMenu] = useState(false);
  const [exportingSessionId, setExportingSessionId] = useState<string | null>(null);
  /** Session whose copy request is in flight; one copy runs at a time. */
  const [duplicatingSessionId, setDuplicatingSessionId] = useState<string | null>(null);
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
  const catalogQueryJson = useMemo(() => {
    void orderingRevision;
    return JSON.stringify(workspaceSessionCatalogQuery(workspaceId, sessionOrdering, sessionShow,
      sessionFilters, sourceAgent, flowChatState.sessions.values(), sessionNavStatusService.getSortTimestamp) ?? null);
  }, [workspaceId, sessionOrdering, sessionShow, sessionFilters, sourceAgent, flowChatState.sessions, orderingRevision]);
  const captureCatalogQuery = useCallback((query: SessionCatalogQuery) => captureWorkspaceSessionCatalogQuery(
    query, flowChatStore.getState().sessions.values(), sessionNavStatusService.getSortTimestamp,
  ), []);
  // Capture the view's observed order only when beginning a catalog. Hydration
  // and streaming must not restart it; a refresh or device switch must rebind it.
  const catalogQuery = useMemo(() => {
    void catalogRefreshVersion;
    void initialMetadataKey;
    const query = (JSON.parse(catalogQueryJson) ?? undefined) as SessionCatalogQuery | undefined;
    return query ? captureCatalogQuery(query) : undefined;
  }, [captureCatalogQuery, catalogQueryJson, catalogRefreshVersion, initialMetadataKey]);
  const getKnownCatalogCount = useCallback(() => countPersistedWorkspaceCatalogSessions(
    flowChatStore.getState().sessions.values(), workspaceId, sourceAgent,
  ), [workspaceId, sourceAgent]);
  const catalog = useWorkspaceSessionCatalog({
    workspaceId,
    enabled: isVisible && !workspaceScopes?.length && metadataPageState.loadedScope === initialMetadataKey,
    refreshVersion: catalogRefreshVersion,
    onPage: observeDiscovery,
    query: catalogQuery,
    captureQuery: captureCatalogQuery,
    targetCount: expandLevel === 2 ? level2DisplayCount : expandLevel === 1 ? SESSIONS_LEVEL_1 : SESSIONS_LEVEL_0,
    firstPage: metadataPageState.loadedScope === initialMetadataKey ? metadataPageState.firstPage : undefined,
    getKnownCount: getKnownCatalogCount,
  });
  const [scheduledJobsSessionId, setScheduledJobsSessionId] = useState<string | null>(null);
  const cronJobCountsRevision = useSyncExternalStore(
    subscribeCronJobCounts,
    () => getCronJobCountsSnapshot(),
    () => getCronJobCountsSnapshot(),
  );
  const cronJobCountsBySession = cronJobCountsRevision.bySessionId;
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
  const initialMetadataLoadKeyRef = useRef<string | null>(null);
  const sessionListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selector = createSessionsNavSelector();
    const unsub = flowChatStore.subscribeSelector(selector, (() => {
      setFlowChatState(flowChatStore.getState());
    }));
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
    setMetadataPageState({
      loadedScope: null,
      isLoading: false,
      loadError: false,
    });
    return () => { metadataLoadRequestIdRef.current += 1; };
  }, [initialMetadataKey]);

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
            { fresh: aggregateReloadRequestId > 0 },
          );
          if (cancelled) return;
          observeDiscovery(scope.workspaceId, page);
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
    observeDiscovery,
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
    ) => {
      if (!workspaceId || limit <= 0) {
        return null;
      }

      const requestId = ++metadataLoadRequestIdRef.current;
      setMetadataPageState(prev => ({ ...prev, isLoading: true, loadError: false }));

      try {
        const page = await flowChatStore.loadSessionMetadataPage(
          workspaceId, limit, cursor,
          source, { query: catalogQuery },
        );
        if (metadataLoadRequestIdRef.current === requestId && surface.isCurrent()) {
          observeDiscovery(workspaceId, page);
          setMetadataPageState({
            loadedScope: initialMetadataKey,
            isLoading: false,
            loadError: false,
            firstPage: page,
          });
        }
        return page;
      } catch (error) {
        if (metadataLoadRequestIdRef.current === requestId && surface.isCurrent()) {
          setMetadataPageState(prev => ({
            ...prev,
            isLoading: false,
            loadError: true,
          }));
        }
        log.warn('Failed to load visible session metadata page', { error, workspaceId, cursor, limit });
        return null;
      }
    },
    [catalogQuery, initialMetadataKey, observeDiscovery, surface, workspaceId]
  );

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

  // When sessions are archived, reset stale metadata so the expand toggle
  // doesn't linger with old counts after all sessions are gone.
  useEffect(() => {
    const handler = () => {
      metadataLoadRequestIdRef.current += 1;
      setCatalogRefreshVersion(value => value + 1);
      setExpandLevel(0);
      setMetadataPageState({
        loadedScope: null,
        isLoading: false,
        loadError: false,
      });
      if (isVisible && workspaceId) {
        void loadMetadataPage(SESSIONS_LEVEL_0, undefined, 'sessions_nav_post_archive');
      }
    };
    window.addEventListener('openbitfun:session-archived', handler);
    return () => window.removeEventListener('openbitfun:session-archived', handler);
  }, [isVisible, workspaceId, loadMetadataPage, setExpandLevel]);

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
    const removeOverlayMousedown0 = subscribeOverlayInteraction(sessionMenuPopoverRef, 'mousedown', handleOutside);
    return () => removeOverlayMousedown0?.();
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

  const { topLevelSessions: allTopLevelSessions, childrenByParent } = useMemo(() => {
    // Activity timestamps can change independently of the session records.
    void orderingRevision;
    const { topLevelSessions: parents, childrenByParent: childMap } = getWorkspaceSessionHierarchy(
      flowChatState.sessions.values(),
      workspaceScopes?.length ? workspaceScopes.map(scope => scope.workspaceId) : workspaceId ? [workspaceId] : [],
    );

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
  }, [flowChatState.sessions, orderingRevision, runningSessionIds, sessionOrdering, workspaceId, workspaceScopes]);

  const topLevelSessions = useMemo(
    () => allTopLevelSessions.filter(session => matchesSourceAgent(session) && matchesWorkspaceSessionView(
      session,
      sessionShow,
      sessionFilters,
      runningSessionIds.has(session.sessionId),
    )),
    [allTopLevelSessions, matchesSourceAgent, runningSessionIds, sessionFilters, sessionShow],
  );

  const visibleChildrenByParent = useMemo(() => {
    if (!hasActiveSessionFilter) return childrenByParent;

    const filtered = new Map<string, Session[]>();
    for (const [parentId, children] of childrenByParent) {
      filtered.set(parentId, children.filter(session => matchesSourceAgent(session) && matchesWorkspaceSessionView(
        session,
        sessionShow,
        sessionFilters,
        runningSessionIds.has(session.sessionId),
      )));
    }
    return filtered;
  }, [childrenByParent, hasActiveSessionFilter, matchesSourceAgent, runningSessionIds, sessionFilters, sessionShow]);

  const sessionDisplayLimit = useMemo(() => {
    return getSessionDisplayLimit({
      loadedTopLevelCount: topLevelSessions.length,
      expandLevel,
      level2DisplayCount,
      showAllWithoutLimit,
    });
  }, [topLevelSessions.length, expandLevel, level2DisplayCount, showAllWithoutLimit]);

  // Only an acknowledged workspace query provides a scoped total. Include
  // newly-created local rows while their metadata publication is in flight.
  const totalTopLevelSessionCount = workspaceSessionCatalogTotal(topLevelSessions.length, catalog);
  const knownCatalogCount = getKnownCatalogCount();
  useEffect(() => {
    // Page hydration updates the baseline inside the reader. A later local
    // creation/removal/archive needs a new bounded first page to refill rows.
    if (isVisible && catalog.paged && catalog.complete && !catalog.loading
      && catalog.knownCount !== knownCatalogCount) setCatalogRefreshVersion(value => value + 1);
  }, [catalog.complete, catalog.knownCount, catalog.loading, catalog.paged, isVisible, knownCatalogCount]);
  const isSessionCountComplete = !workspaceId || Boolean(workspaceScopes?.length)
    || (catalog.complete && !discovery.pending && !discovery.failed);
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
        ariaLabel: isSessionCountComplete ? t('nav.sessions.showMore', { count }) : t('nav.sessions.showMoreLabel'),
        remainingCount: isSessionCountComplete ? count : null,
      };
    }
    if (expandToggleState.action === 'show-all') {
      const count = expandToggleState.expandedRemainingCount;
      return {
        label: t('nav.sessions.showAllLabel'),
        ariaLabel: isSessionCountComplete ? t('nav.sessions.showAll', { count }) : t('nav.sessions.showAllLabel'),
        remainingCount: isSessionCountComplete ? count : null,
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
    isSessionCountComplete,
    t,
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
          onSessionOpened?.();
          return;
        }

        if (sessionId === activeSessionId) {
          await openMainSession(sessionId, {
            workspaceId: targetWorkspaceId,
            activateWorkspace,
          });
          onSessionOpened?.();
          return;
        }

        await openMainSession(sessionId, {
          workspaceId: targetWorkspaceId,
          activateWorkspace,
        });
        onSessionOpened?.();
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
      onSessionOpened,
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

  const handleRevealSessionStorageDirectory = useCallback(async (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    closeSessionMenu();
    try {
      if (isNonLocalDispatchTarget(session.config.dispatchTarget)) {
        throw new Error(t('nav.sessions.storageDirectoryDesktopOnly'));
      }
      const storageWorkspaceId = workspaceId ?? requireSessionOwningWorkspaceId(session);
      await sessionAPI.revealStorageDirectory(storageWorkspaceId, session.sessionId);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.sessions.openStorageDirectoryFailed'),
        { duration: 4000 },
      );
    }
  }, [closeSessionMenu, t, workspaceId]);

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
            workspaceId: requireSessionOwningWorkspaceId(session),
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
      const sourceView = session?.externalHistory?.mode === 'follow';
      const confirmed = !sessionMenuPreferences.confirmDelete || await confirmDanger(
        sourceView ? t('nav.sessions.removeSourceConfirmTitle') : t('nav.sessions.deleteConfirmTitle'),
        sourceView ? t('nav.sessions.removeSourceConfirmMessage', {
          name: session ? resolveSessionTitle(session) : t('nav.sessions.untitled'),
        }) : t('nav.sessions.deleteConfirmMessage', {
          name: session ? resolveSessionTitle(session) : t('nav.sessions.untitled'),
        }),
        { confirmText: sourceView ? t('nav.sessions.removeSource') : t('nav.sessions.delete') },
      );
      if (!confirmed) return;

      try {
        await flowChatManager.deleteChatSession(sessionId);
      } catch (err) {
        log.error('Failed to delete session', err);
      }
    },
    [resolveSessionTitle, sessionMenuPreferences.confirmDelete, t]
  );

  const handleArchive = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        await flowChatManager.archiveChatSession(sessionId);
        window.dispatchEvent(new CustomEvent('openbitfun:session-archived'));
        if (sessionMenuPreferences.showArchiveNotice) {
          notificationService.success(t('nav.sessions.archivedAll', { count: 1 }), { duration: 3000 });
        }
      } catch (err) {
        log.error('Failed to archive session', err);
      }
    },
    [sessionMenuPreferences.showArchiveNotice, t]
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

  /**
   * Copy the session into a new independent session. The copy is created by the
   * host and appears in this list; the current row and the active session stay
   * untouched (delete and archive never move the user either).
   */
  const handleDuplicateSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      closeSessionMenu();
      if (duplicatingSessionId) return;

      setDuplicatingSessionId(sessionId);
      try {
        const copied = await flowChatManager.duplicateChatSession(sessionId);
        if (copied.metadataProjected) {
          notificationService.success(
            t('nav.sessions.duplicateSuccess', { name: copied.sessionName }),
            { duration: 3000 },
          );
        } else {
          notificationService.warning(
            t('nav.sessions.duplicateCreatedRefreshFailed', { name: copied.sessionName }),
            { duration: 5000 },
          );
        }
      } catch (error) {
        if (isSurfaceChangedError(error)) return;
        log.error('Failed to copy session', { sessionId, error });
        notificationService.error(
          error instanceof Error && error.message
            ? error.message
            : t('nav.sessions.duplicateFailed'),
          { duration: 4000 },
        );
      } finally {
        setDuplicatingSessionId(null);
      }
    },
    [closeSessionMenu, duplicatingSessionId, t],
  );

  /**
   * A worktree directory is registered for execution but not opened, so the
   * session row is the only place it can be reached from. Opening it as a
   * workspace is an explicit user action; if the worktree happens to be open
   * already, activating it is the whole effect.
   */
  const handleOpenWorktreeWorkspace = useCallback(
    async (e: React.MouseEvent, worktreePath: string) => {
      e.stopPropagation();
      closeSessionMenu();
      const opened = openedWorkspacesList.find(workspace =>
        isSamePath(workspace.rootPath ?? '', worktreePath)
      );
      try {
        if (opened) {
          await setActiveWorkspace(opened.id);
          return;
        }
        await openWorkspace(worktreePath);
      } catch (err) {
        log.error('Failed to open the worktree directory as a workspace', {
          worktreePath,
          error: err,
        });
        notificationService.error(t('nav.sessions.openWorktreeWorkspaceFailed'), { duration: 3000 });
      }
    },
    [closeSessionMenu, openWorkspace, openedWorkspacesList, setActiveWorkspace, t]
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

  const handleExpandToggle = useCallback(() => {
    if (expandLevel === 0) {
      setExpandLevel(1);
      return;
    }
    if (expandLevel === 1 && totalTopLevelSessionCount > SESSIONS_LEVEL_1) {
      setExpandLevel(2);
      return;
    }
    setExpandLevel(0);
  }, [expandLevel, setExpandLevel, totalTopLevelSessionCount]);

  const sourceFilterStatus = discovery.failed ? (
    <Button variant="outline" size="sm" onClick={discovery.retry}>{t('nav.sessions.partialLoadFailedRetry')}</Button>
  ) : catalog.loading || discovery.pending ? (
    <div className="openbitfun-nav-panel__inline-loading" role="status">
      <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
      <OverflowText>{t(discovery.pending ? 'nav.sessions.discoveringExternal' : 'nav.sessions.loading')}</OverflowText>
    </div>
  ) : catalog.failed ? (
    <Button variant="outline" size="sm" onClick={() => setCatalogRefreshVersion(value => value + 1)}>
      {t('nav.sessions.partialLoadFailedRetry')}
    </Button>
  ) : null;
  const discoveryNotice = discovery.warnings.length > 0 ? (
    <Alert tone="warning" role="status" title={discovery.warnings.join('\n')} message={t('nav.sessions.discoveryPartial')} />
  ) : null;
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
            <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
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
    if (sourceFilterStatus) return <div className={sessionListClassName}>{sourceFilterStatus}{discoveryNotice}</div>;
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
            <Loader2 className="openbitfun-nav-panel__inline-loading-icon" aria-hidden="true" />
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
        {discoveryNotice}
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
    if (sourceFilterStatus) return <div className={sessionListClassName}>{sourceFilterStatus}{discoveryNotice}</div>;
    if (aggregateLoadState.isLoading && aggregateLoadStatus) {
      return (
        <div className={sessionListClassName}>
          {aggregateLoadStatus}
        </div>
      );
    }
    return (
      <div className={sessionListClassName}>
        {discoveryNotice}
        <div className="openbitfun-nav-panel__inline-empty" aria-disabled="true">
          {t('nav.sessions.viewMenu.noMatches')}
        </div>
        {aggregateLoadStatus}
      </div>
    );
  }

  return (
    <div className={sessionListClassName} ref={sessionListRef}>
      {sourceFilterStatus}
      {discoveryNotice}
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
          const scheduledJobCount = cronJobCountsBySession.get(session.sessionId) ?? 0;
          // Same mark the session status indicator draws, in the same trailing
          // cell: one 12px secondary clock on the row's right edge, no count.
          // Sessions with a status to report keep that status instead.
          const scheduledJobMark = scheduledJobCount > 0 ? (
            <Icon
              name="clock"
              size="xs"
              tone="secondary"
              label={t('nav.scheduledJobs.badgeTooltip', { count: scheduledJobCount })}
            />
          ) : undefined;
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
          const worktreeIsolated = isWorktreeIsolatedSession(session);
          const worktreeRootPath = sessionWorktreeRootPath(session) ?? '';
          const dispatchTargetLabel =
            dispatchTarget?.kind === 'ssh' || dispatchTarget?.kind === 'device'
              ? (dispatchTarget.kind === 'device' ? resolveDeviceName(dispatchTarget.deviceId, dispatchTarget.displayName) : dispatchTarget.displayName)
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
            worktreeIsolated ||
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
              {worktreeIsolated ? (
                <div className="openbitfun-nav-panel__inline-item-tooltip-meta">
                  {t('nav.sessions.worktreeTooltip', { path: worktreeRootPath })}
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
                          {defaultSessionAction?.sessionId === session.sessionId && (
                            <StatusPill tone="neutral">{t('nav.sessions.defaultSession')}</StatusPill>
                          )}
                        </span>
                    {session.importedSource ? (
                      <StatusPill className="openbitfun-nav-panel__inline-item-source-badge" tone="neutral"
                        title={t('nav.sessions.sourceAgentLabel', { name: sessionSourceAgentLabel(session.importedSource) })}>
                        {sessionSourceAgentLabel(session.importedSource)}
                      </StatusPill>
                    ) : null}
                    {isChildSession ? (
                      <StatusPill className="openbitfun-nav-panel__inline-item-btw-badge" tone="neutral">
                        {childSessionBadge}
                      </StatusPill>
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
                    {worktreeIsolated ? (
                      // Icon-only marker: the badge sits next to the title, where a
                      // label competes with it. The tooltip carries the worktree path.
                      <span
                        className="openbitfun-nav-panel__inline-item-worktree-badge"
                        title={t('nav.sessions.worktreeTooltip', { path: worktreeRootPath })}
                        aria-label={t('nav.sessions.worktreeTooltip', { path: worktreeRootPath })}
                      >
                        <FolderGit2 className="openbitfun-nav-panel__inline-item-worktree-icon" aria-hidden />
                      </span>
                    ) : null}
                    {reviewActivityKind ? (
                      <span className="openbitfun-nav-panel__inline-item-review-badge">
                        <Loader2 className="openbitfun-nav-panel__inline-item-review-icon" aria-hidden />
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
                    <SessionStatusIndicator
                      sessionId={session.sessionId}
                      idleFallback={scheduledJobMark}
                    />
                    <div
                      className={`openbitfun-nav-panel__inline-item-actions${openMenuSessionId === session.sessionId ? ' is-open' : ''}`}
                      data-openbitfun-component="sessions-section"
                      data-openbitfun-part="actions"
                      data-openbitfun-state={openMenuSessionId === session.sessionId ? 'menuOpen' : undefined}
                    >
                      {defaultSessionAction && !isChildSession && !session.isTransient && session.persistedStatus !== 'archived' && (
                        <Tooltip content={defaultSessionAction.disabledReason ?? t(
                          defaultSessionAction.sessionId === session.sessionId ? 'nav.sessions.clearDefault' : 'nav.sessions.setDefault',
                        )}>
                          <IconButton
                            size="xs"
                            disabled={defaultSessionAction.disabled}
                            aria-label={t(defaultSessionAction.sessionId === session.sessionId ? 'nav.sessions.clearDefault' : 'nav.sessions.setDefault')}
                            aria-pressed={defaultSessionAction.sessionId === session.sessionId}
                            icon={<Icon name="pin" size="xs" />}
                            onClick={event => {
                              event.stopPropagation();
                              defaultSessionAction.onChange(defaultSessionAction.sessionId === session.sessionId ? null : session.sessionId);
                            }}
                            data-testid="nav-session-default-btn"
                            data-session-id={session.sessionId}
                          />
                        </Tooltip>
                      )}
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
                  {openMenuSessionId === session.sessionId && createOverlayPortal(
                    <Menu
                      ref={sessionMenuPopoverRef}
                      className="openbitfun-nav-panel__inline-item-menu-popover"
                      inlineSize="content"
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
                            leading={<Icon name="chevron-left" size="sm" />}
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
                            leading={<Icon name="arrow-down" size="sm" />}
                            onClick={e => { void handleExportMarkdown(e, session, 'full'); }}
                            data-testid="nav-session-menu-export-full"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.exportMarkdownFull')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="arrow-down" size="sm" />}
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
                            leading={<Icon name="edit" size="sm" />}
                            onClick={e => { closeSessionMenu(); handleStartEdit(e, session); }}
                            hidden={!isMenuActionVisible('rename')}
                            data-testid="nav-session-menu-rename"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.rename')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="duplicate" size="sm" />}
                            onClick={e => { closeSessionMenu(); void handleCopySessionId(e, session.sessionId); }}
                            hidden={!isMenuActionVisible('copyId')}
                            data-testid="nav-session-menu-copy-id"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.copySessionId')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={duplicatingSessionId === session.sessionId
                              ? <Loader2 className="openbitfun-nav-panel__inline-toggle-spinner" aria-hidden />
                              : <Icon name="files" size="sm" />}
                            onClick={e => { void handleDuplicateSession(e, session.sessionId); }}
                            // A running turn is still being persisted, so its
                            // history is not a stable copy boundary; a session
                            // owned by another device has no local history.
                            disabled={isDispatched
                              || !canCopySessions
                              || isSessionEmptyForCopy(session)
                              || runningSessionIds.has(session.sessionId)
                              || duplicatingSessionId === session.sessionId}
                            title={isDispatched
                              ? t('nav.sessions.duplicateDispatchUnsupported')
                              : !canCopySessions
                                ? t('nav.sessions.duplicateHostUnsupported')
                                : isSessionEmptyForCopy(session)
                                  ? t('nav.sessions.duplicateEmpty')
                                  : runningSessionIds.has(session.sessionId)
                                    ? t('nav.sessions.duplicateRunning')
                                    : undefined}
                            hidden={!isMenuActionVisible('duplicate')}
                            data-testid="nav-session-menu-duplicate"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.duplicate')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon glyph={FolderOpen} size="sm" />}
                            onClick={e => { void handleRevealSessionStorageDirectory(e, session); }}
                            disabled={!sessionAPI.canRevealStorageDirectory() || isDispatched || (!workspaceId && !session.projectWorkspaceId && !session.workspaceId)}
                            title={!sessionAPI.canRevealStorageDirectory() || isDispatched
                              ? t('nav.sessions.storageDirectoryDesktopOnly')
                              : (!workspaceId && !session.projectWorkspaceId && !session.workspaceId)
                                ? t('nav.sessions.storageDirectoryWorkspaceUnavailable')
                                : undefined}
                            hidden={!isMenuActionVisible('openStorage')}
                            data-testid="nav-session-menu-open-storage"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.openStorageDirectory')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setIsExportScopeMenu(true);
                            }}
                            disabled={exportingSessionId === session.sessionId}
                            hidden={!isMenuActionVisible('export')}
                            data-testid="nav-session-menu-export-markdown"
                            data-session-id={session.sessionId}
                            leading={exportingSessionId === session.sessionId
                              ? <Loader2 className="openbitfun-nav-panel__inline-toggle-spinner" aria-hidden />
                              : <Icon name="arrow-down" size="sm" />}
                          >
                            <span>{t('nav.sessions.exportMarkdown')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon name="clock" size="sm" />}
                            onClick={e => {
                              e.stopPropagation();
                              closeSessionMenu();
                              setScheduledJobsSessionId(session.sessionId);
                            }}
                            disabled={!workspacePath}
                            hidden={!isMenuActionVisible('scheduledJobs')}
                            data-testid="nav-session-menu-scheduled-jobs"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.scheduledJobs.open')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon glyph={Archive} size="sm" />}
                            onClick={e => { closeSessionMenu(); void handleArchive(e, session.sessionId); }}
                            hidden={!isMenuActionVisible('archive')}
                            data-testid="nav-session-menu-archive"
                            data-session-id={session.sessionId}
                          >
                            <span>{t('nav.sessions.archive')}</span>
                          </MenuItem>
                          <MenuItem
                            type="button"
                            leading={<Icon glyph={ListChecks} size="sm" />}
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
                            hidden={!isMenuActionVisible('manage')}
                            data-testid="nav-session-menu-manage-sessions"
                          >
                            <span>{t('nav.sessions.manage')}</span>
                          </MenuItem>
                          {worktreeIsolated && worktreeRootPath ? (
                            <MenuItem
                              type="button"
                              leading={<Icon glyph={FolderGit2} size="sm" />}
                              onClick={e => { void handleOpenWorktreeWorkspace(e, worktreeRootPath); }}
                              hidden={!isMenuActionVisible('openWorktreeWorkspace')}
                              data-testid="nav-session-menu-open-worktree-workspace"
                              data-session-id={session.sessionId}
                            >
                              <span>{t('nav.sessions.openWorktreeWorkspace')}</span>
                            </MenuItem>
                          ) : null}
                          <MenuItem
                            type="button"
                            tone="danger"
                            leading={<Icon name="delete" size="sm" />}
                            onClick={e => { closeSessionMenu(); void handleDelete(e, session.sessionId); }}
                            hidden={!isMenuActionVisible('delete')}
                            data-testid="nav-session-menu-delete"
                            data-session-id={session.sessionId}
                          >
                            <span>{t(session.externalHistory?.mode === 'follow' ? 'nav.sessions.removeSource' : 'nav.sessions.delete')}</span>
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

      {!showAllWithoutLimit && expandLevel === 2 && totalTopLevelSessionCount > sessionDisplayLimit && (
        <button data-overflow-trigger
          type="button"
          className="openbitfun-nav-panel__inline-toggle"
          data-testid="nav-session-list-load-more"
          aria-label={isSessionCountComplete ? t('nav.sessions.showMore', {
            count: totalTopLevelSessionCount - sessionDisplayLimit,
          }) : t('nav.sessions.showMoreLabel')}
          onClick={() => setLevel2DisplayCount(prev => prev + SESSIONS_LEVEL_2_PAGE)}
          disabled={catalog.loading}
        >
          <OverflowText className="openbitfun-nav-panel__inline-toggle-label">
            {t('nav.sessions.showMoreLabel')}
          </OverflowText>
          {isSessionCountComplete && (
            <span className="openbitfun-nav-panel__inline-toggle-count" aria-hidden>
              +{totalTopLevelSessionCount - sessionDisplayLimit}
            </span>
          )}
          <span className="openbitfun-nav-panel__inline-toggle-trailing">
            <Icon name="chevron-down" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
          </span>
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
          <span className="openbitfun-nav-panel__inline-toggle-trailing">
            {metadataPageState.isLoading ? (
              <Loader2 className="openbitfun-nav-panel__inline-toggle-spinner" aria-hidden />
            ) : expandToggleState.action === 'show-less' ? (
              <Icon name="chevron-up" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
            ) : (
              <Icon name="chevron-down" size="xs" className="openbitfun-nav-panel__inline-toggle-chevron" aria-hidden />
            )}
          </span>
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
