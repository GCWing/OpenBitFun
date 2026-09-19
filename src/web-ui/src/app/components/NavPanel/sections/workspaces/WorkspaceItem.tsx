import { subscribeOverlayInteraction, createOverlayPortal, ActionItem } from '@openbitfun/ui';
import {
  Button,
  ConfirmDialog,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  OverflowText,
} from '@openbitfun/ui';
import React, { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FolderOpen, FolderSearch, RotateCcw, FileText, ListChecks, ShieldCheck, Network, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RetainedMountBoundary } from '@/shared/presence';
import { InputDialog } from '@/app/components/InputDialog';

import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { aiExperienceConfigService } from '@/infrastructure/config/services/AIExperienceConfigService';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import { useApp } from '@/app/hooks/useApp';
import { useGitBasicInfo } from '@/tools/git/hooks/useGitState';
import { gitStateManager } from '@/tools/git/state/GitStateManager';
import { workspaceAPI } from '@/infrastructure/api';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { notificationService } from '@/shared/notification-system';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import {
  getHistorySessionOpenTransitionSnapshot,
  subscribeHistorySessionOpenTransition,
} from '@/flow_chat/services/sessionOpenIntent';
import {
  findReusableEmptySessionId,
  flowChatSessionConfigForWorkspace,
} from '@/app/utils/projectSessionWorkspace';
import type { AcpClientInfo } from '@/infrastructure/api/service-api/ACPClientAPI';
import { loadWorkspaceAcpMenuClients } from './workspaceAcpMenuClients';
import WorkspaceAcpSessionSubmenu from './WorkspaceAcpSessionSubmenu';
import SessionsSection from '../sessions/SessionsSection';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';
import {
  WorkspaceKind,
  isRemoteWorkspace,
  type WorkspaceInfo,
} from '@/shared/types';
import { SSHContext } from '@/features/ssh-remote/SSHRemoteContext';
import { useWorkspaceSearchIndex } from '@/tools/file-explorer';
import { WORKSPACE_SEARCH_AVAILABLE } from '@/infrastructure/config/workspaceSearchAvailability';
import { useSideAnchoredPopoverPosition } from '@/shared/utils/useSideAnchoredPopoverPosition';
import { scheduleAfterStartupSignal } from '@/shared/utils/startupTaskScheduling';
import {
  getWorkspaceGitBasicInfoOptions,
  suppressWorkspaceGitRefreshOnMountDuringSessionTransition,
  WORKSPACE_GIT_PENDING_CANCEL_REASONS,
  WORKSPACE_GIT_PENDING_CANCEL_SOURCES,
} from './workspaceGitRefreshOptions';

const WorkspaceRelatedPathsDialog = lazy(() => import('./WorkspaceRelatedPathsDialog'));
const WorkspaceProjectPermissionsDialog = lazy(() => import('./WorkspaceProjectPermissionsDialog'));
const PortForwardDialog = lazy(() =>
  import('@/features/ssh-remote/PortForwardDialog').then((module) => ({
    default: module.PortForwardDialog,
  }))
);
const WorkspaceSessionBatchModal = lazy(() => import('./WorkspaceSessionBatchModal'));
const ScheduledJobsModal = lazy(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'));

const MAX_WORKSPACE_NAME_CHARS = 80;

function containsWorkspaceNameControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

interface WorkspaceItemProps {
  workspace: WorkspaceInfo;
  isActive: boolean;
  isSingle?: boolean;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
}

const WorkspaceItem: React.FC<WorkspaceItemProps> = ({
  workspace,
  isActive,
  isSingle = false,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}) => {
  const { t } = useI18n('common');
  const { t: tFiles } = useTranslation('panels/files');
  const {
    setActiveWorkspace,
    closeWorkspaceById,
    deleteAssistantWorkspace,
    primaryAssistantWorkspaceId,
    resetAssistantWorkspace,
    renameWorkspace,
  } = useWorkspaceContext();
  const { switchLeftPanelTab } = useApp();
  const openWorkspaceResources = useNavSceneStore(s => s.openWorkspaceResources);
  const historySessionOpenTransition = useSyncExternalStore(
    subscribeHistorySessionOpenTransition,
    getHistorySessionOpenTransitionSnapshot,
    getHistorySessionOpenTransitionSnapshot
  );
  const gitBasicInfoOptions = suppressWorkspaceGitRefreshOnMountDuringSessionTransition(
    getWorkspaceGitBasicInfoOptions(workspace, isActive),
    historySessionOpenTransition !== null
  );
  useGitBasicInfo({ workspaceId: workspace.id }, gitBasicInfoOptions);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuContextPoint, setMenuContextPoint] = useState<{ x: number; y: number } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [relatedPathsDialogOpen, setRelatedPathsDialogOpen] = useState(false);
  const [projectPermissionsDialogOpen, setProjectPermissionsDialogOpen] = useState(false);
  const [portForwardDialogOpen, setPortForwardDialogOpen] = useState(false);
  const [isDeletingAssistant, setIsDeletingAssistant] = useState(false);
  const [isResettingWorkspace, setIsResettingWorkspace] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const sessionDisclosureIcon = sessionsCollapsed ? 'chevron-right' : 'chevron-down';
  const collapseAllRequestId = useWorkspaceSessionViewStore(state => state.collapseAllRequestId);
  const [searchIndexModalOpen, setSearchIndexModalOpen] = useState(false);
  const [scheduledJobsModalOpen, setScheduledJobsModalOpen] = useState(false);
  const [sessionBatchModalOpen, setSessionBatchModalOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  useEffect(() => {
    if (collapseAllRequestId > 0) setSessionsCollapsed(true);
  }, [collapseAllRequestId]);
  const [workspaceSearchEnabled, setWorkspaceSearchEnabled] = useState(
    () => aiExperienceConfigService.getSettings().enable_workspace_search,
  );
  const [acpClients, setAcpClients] = useState<AcpClientInfo[]>([]);
  const [acpClientsLoading, setAcpClientsLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const acpSubmenuRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuPosition = useSideAnchoredPopoverPosition({
    open: menuOpen,
    anchorRef: menuAnchorRef,
    anchorPoint: menuContextPoint,
    popoverRef: menuPopoverRef,
    layoutRevision: `${acpClientsLoading}:${acpClients.length}`,
  });
  const isDefaultAssistantWorkspace =
    workspace.workspaceKind === WorkspaceKind.Assistant &&
    (workspace.id === primaryAssistantWorkspaceId ||
      (!primaryAssistantWorkspaceId && !workspace.assistantId));
  const isDeletableAssistantWorkspace =
    workspace.workspaceKind === WorkspaceKind.Assistant &&
    !isDefaultAssistantWorkspace;
  const workspaceDisplayName =
    workspace.workspaceKind === WorkspaceKind.Assistant
      ? workspace.identity?.name?.trim() || workspace.name
      : workspace.name;
  const relatedPathCount = workspace.relatedPaths?.length ?? 0;
  const workspaceIsRemote = isRemoteWorkspace(workspace);
  const canShowSearchIndex =
    WORKSPACE_SEARCH_AVAILABLE
    && isActive
    && workspaceSearchEnabled
    && !workspaceIsRemote
    && workspace.workspaceKind === WorkspaceKind.Normal;
  const workspaceSearchIndex = useWorkspaceSearchIndex({
    workspaceId: canShowSearchIndex ? workspace.id : undefined,
    enabled: canShowSearchIndex,
    isRemote: workspaceIsRemote,
  });

  useEffect(() => {
    if (!isActive || workspaceIsRemote) {
      return;
    }

    const cancelPendingAutoGitRefresh = () => {
      if (getHistorySessionOpenTransitionSnapshot() === null) {
        return;
      }

      for (const reason of WORKSPACE_GIT_PENDING_CANCEL_REASONS) {
        for (const source of WORKSPACE_GIT_PENDING_CANCEL_SOURCES) {
          gitStateManager.cancelPendingRefresh({ workspaceId: workspace.id }, {
            layers: ['basic'],
            reason,
            source,
          });
        }
      }
    };

    cancelPendingAutoGitRefresh();
    return subscribeHistorySessionOpenTransition(cancelPendingAutoGitRefresh);
  }, [isActive, workspace.id, workspaceIsRemote]);

  useEffect(() => {
    if (!WORKSPACE_SEARCH_AVAILABLE) return;
    let cancelled = false;
    let unsubscribeSettings: (() => void) | null = null;
    const cancelStartupSchedule = scheduleAfterStartupSignal(async () => {
      const settings = await aiExperienceConfigService.getSettingsAsync();
      if (cancelled) {
        return;
      }
      setWorkspaceSearchEnabled(settings.enable_workspace_search);
      unsubscribeSettings = aiExperienceConfigService.addChangeListener(nextSettings => {
        setWorkspaceSearchEnabled(nextSettings.enable_workspace_search);
      });
    }, {
      signalName: 'openbitfun:interactive-shell-ready',
      fallbackTimeoutMs: 10000,
      frameCount: 1,
    });
    return () => {
      cancelled = true;
      cancelStartupSchedule();
      unsubscribeSettings?.();
    };
  }, []);

  // Remote connection status — optional: safe if not inside SSHRemoteProvider
  const sshContext = useContext(SSHContext);
  const remoteConnStatus = workspace.connectionId && sshContext
    ? sshContext.workspaceStatuses[workspace.connectionId]
    : undefined;

  const remoteMeta = useMemo(() => {
    if (!workspaceIsRemote) {
      return null;
    }

    const status = remoteConnStatus ?? 'unknown';
    const statusLabel = t(`nav.workspaces.remote.status.${status}`, {
      defaultValue: t('nav.workspaces.remote.status.unknown'),
    });
    const connectionLabel =
      workspace.connectionName?.trim()
      || workspace.sshHost?.trim()
      || workspace.connectionId?.trim()
      || '';
    const hostLabel = workspace.sshHost?.trim() || connectionLabel;

    return {
      status,
      statusLabel,
      connectionLabel,
      /** A green dot already reads as "fine"; spell out only the states that need attention. */
      showStatusText: status !== 'connected',
      tooltip: t('nav.workspaces.remote.tooltip', {
        connection: connectionLabel,
        host: hostLabel,
        status: statusLabel,
      }),
      ariaLabel: t('nav.workspaces.remote.ariaLabel', {
        connection: connectionLabel,
        status: statusLabel,
      }),
    };
  }, [
    remoteConnStatus,
    t,
    workspace.connectionId,
    workspace.connectionName,
    workspace.sshHost,
    workspaceIsRemote,
  ]);

  const searchIndexIndicator = useMemo(() => {
    if (!canShowSearchIndex) {
      return null;
    }

    const repoStatus = workspaceSearchIndex.indexStatus?.repoStatus ?? null;
    const activeTask = workspaceSearchIndex.indexStatus?.activeTask ?? null;
    // A non-Git workspace can never be indexed; that is a property of the folder, not a fault,
    // so it stays on the neutral gray tone and gets its own wording instead of a red "unhealthy".
    const isNonGitWorkspace = workspaceSearchIndex.unsupportedReason === 'non_git';
    const phase = repoStatus?.phase;
    const isTaskActive = activeTask?.state === 'queued' || activeTask?.state === 'running';
    const hasError = Boolean(
      workspaceSearchIndex.error
      || repoStatus?.lastError
      || repoStatus?.lastMaintenanceError
      || activeTask?.error
      || activeTask?.state === 'failed'
    );
    const dirtyFiles = repoStatus
      ? repoStatus.dirtyFiles.modified + repoStatus.dirtyFiles.deleted + repoStatus.dirtyFiles.new
      : 0;

    let tone: 'green' | 'yellow' | 'gray' | 'red' = 'gray';
    if (hasError || phase === 'limited') {
      tone = 'red';
    } else if (!phase || phase === 'needs_index') {
      tone = 'gray';
    } else if (
      isTaskActive
      || phase === 'preparing'
      || phase === 'building'
      || phase === 'refreshing'
      || Boolean(repoStatus?.baseAdvanceInProgress)
    ) {
      tone = 'yellow';
    } else if (phase === 'ready' || phase === 'tracking_changes') {
      tone = 'green';
    }

    // The daemon says `needs_index` both while OpenBitFun's auto-index policy is still evaluating the
    // workspace and after it deliberately declined, so without the policy's own decision the UI
    // can only hedge. When the decision is known it replaces the hedged wording with the reason.
    const autoIndex = workspaceSearchIndex.indexStatus?.autoIndex ?? null;
    const autoIndexExplanation =
      phase === 'needs_index' && !isTaskActive && autoIndex
        ? tFiles(`search.index.autoIndex.${autoIndex.decision}`, {
            defaultValue: '',
            files: autoIndex.indexableFiles ?? 0,
            threshold: autoIndex.threshold,
            reason: autoIndex.reason ?? '',
          }) || null
        : null;
    const isBelowThreshold = autoIndex?.decision === 'belowThreshold';

    const phaseLabel = isNonGitWorkspace
      ? tFiles('search.index.phase.non_git')
      : isBelowThreshold && phase === 'needs_index'
        ? tFiles('search.index.phase.no_index_needed')
        : tFiles(`search.index.phase.${phase ?? 'unknown'}`, {
            defaultValue: phase ?? tFiles('search.index.phase.unknown'),
          });
    const title = tFiles(`search.index.indicator.tones.${tone}`);
    let summary: string;
    if (isNonGitWorkspace) {
      summary = tFiles('search.index.summary.non_git');
    } else if (autoIndexExplanation) {
      summary = autoIndexExplanation;
    } else if (repoStatus) {
      summary = tFiles(`search.index.summary.${phase ?? 'unavailable'}`, {
        defaultValue: tFiles('search.index.summary.unavailable'),
      });
    } else if (workspaceSearchIndex.loading) {
      summary = tFiles('search.index.indicator.checking');
    } else {
      summary = tFiles('search.index.summary.unavailable');
    }
    const activeTaskLabel = activeTask
      ? tFiles(`search.index.taskState.${activeTask.state}`, {
          defaultValue: activeTask.state,
        })
      : null;
    const progressLabel = activeTask
      ? typeof activeTask.total === 'number' && activeTask.total > 0
        ? tFiles('search.index.indicator.progressKnown', {
            processed: activeTask.processed,
            total: activeTask.total,
          })
        : tFiles('search.index.indicator.progressUnknown', {
            processed: activeTask.processed,
          })
      : null;
    const progressPercent =
      activeTask && typeof activeTask.total === 'number' && activeTask.total > 0
        ? Math.max(0, Math.min(100, (activeTask.processed / activeTask.total) * 100))
        : null;
    const progressPercentLabel =
      typeof progressPercent === 'number'
        ? `${Math.round(progressPercent)}%`
        : null;
    const dirtyFilesLabel =
      repoStatus && dirtyFiles > 0
        ? tFiles('search.index.indicator.dirtyFiles', {
            modified: repoStatus.dirtyFiles.modified,
            deleted: repoStatus.dirtyFiles.deleted,
            new: repoStatus.dirtyFiles.new,
          })
        : null;
    // `lastError` is cleared by every successful worktree probe, so it is usually already gone by
    // the time we poll; `lastMaintenanceError` is the slot a background compaction/advance failure
    // survives in, and is the only one that reliably reaches this render.
    const errorText =
      workspaceSearchIndex.error
      ?? activeTask?.error
      ?? repoStatus?.lastError
      ?? repoStatus?.lastMaintenanceError
      ?? null;

    return {
      tone,
      title,
      phaseLabel,
      summary,
      activeTaskLabel,
      activeTaskMessage: activeTask?.message ?? null,
      progressLabel,
      progressPercent,
      progressPercentLabel,
      dirtyFilesLabel,
      baseAdvanceInProgress: Boolean(repoStatus?.baseAdvanceInProgress),
      probeHealthy: repoStatus?.probeHealthy ?? true,
      // Not a degradation: the daemon owes a worktree reconcile, so the dirty counts above are from
      // a moment ago. It clears itself, which is why it stays a tooltip note and not a badge.
      workspaceProbePending: Boolean(repoStatus?.workspaceProbePending),
      errorText,
      ariaLabel: `${tFiles('search.index.indicator.label')}: ${title} · ${phaseLabel}`,
    };
  }, [
    canShowSearchIndex,
    tFiles,
    workspaceSearchIndex.error,
    workspaceSearchIndex.indexStatus,
    workspaceSearchIndex.loading,
    workspaceSearchIndex.unsupportedReason,
  ]);
  const searchIndexPhase = workspaceSearchIndex.indexStatus?.repoStatus.phase ?? null;
  const canRebuildSearchIndex = Boolean(
    searchIndexPhase
    && searchIndexPhase !== 'needs_index'
    && searchIndexPhase !== 'preparing'
    && searchIndexPhase !== 'building'
  );

  const handleSearchIndexAction = useCallback(async () => {
    const result = await workspaceSearchIndex.rebuildIndex();

    if (!result) {
      return;
    }

    notificationService.success(
      tFiles('notifications.searchIndexRebuildStarted'),
      { duration: 2200 }
    );
  }, [tFiles, workspaceSearchIndex]);

  const handleMenuTriggerClick = useCallback(() => {
    setMenuContextPoint(null);
    setMenuOpen(open => !open);
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Portalled menus bubble through the card without belonging to its DOM subtree.
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuContextPoint({ x: event.clientX, y: event.clientY });
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    if (!menuOpen) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideTriggerArea = menuRef.current?.contains(target);
      const isInsidePopover = menuPopoverRef.current?.contains(target);
      const isInsideAcpSubmenu = acpSubmenuRef.current?.contains(target);
      if (!isInsideTriggerArea && !isInsidePopover && !isInsideAcpSubmenu) {
        setMenuOpen(false);
      }
    };
    removeOverlayMousedown0 = subscribeOverlayInteraction(menuPopoverRef, 'mousedown', handleOutside);
    return () => removeOverlayMousedown0?.();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    let cancelled = false;
    const remoteWorkspace = isRemoteWorkspace(workspace);

    const loadAcpClients = async () => {
      setAcpClients([]);
      setAcpClientsLoading(true);
      try {
        const clients = await loadWorkspaceAcpMenuClients({
          remoteWorkspace,
          remoteConnectionId: remoteWorkspace ? workspace.connectionId : undefined,
        });
        if (!cancelled) {
          setAcpClients(clients);
        }
      } catch (_error) {
        if (!cancelled) {
          setAcpClients([]);
        }
      } finally {
        if (!cancelled) {
          setAcpClientsLoading(false);
        }
      }
    };

    void loadAcpClients();
    window.addEventListener('openbitfun:acp-clients-changed', loadAcpClients);
    window.addEventListener('openbitfun:acp-requirements-changed', loadAcpClients);
    return () => {
      cancelled = true;
      window.removeEventListener('openbitfun:acp-clients-changed', loadAcpClients);
      window.removeEventListener('openbitfun:acp-requirements-changed', loadAcpClients);
    };
  }, [menuOpen, workspace]);

  const handleCollapseToggle = useCallback(() => {
    setSessionsCollapsed(prev => !prev);
  }, []);

  const handleCloseWorkspace = useCallback(async () => {
    setMenuOpen(false);
    try {
      await closeWorkspaceById(workspace.id);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.closeFailed'),
        { duration: 4000 }
      );
    }
  }, [closeWorkspaceById, t, workspace.id]);

  const handleOpenSessionBatchModal = useCallback(() => {
    setMenuOpen(false);
    setSessionBatchModalOpen(true);
  }, []);

  const handleOpenScheduledJobs = useCallback(() => {
    setMenuOpen(false);
    setScheduledJobsModalOpen(true);
  }, []);

  const handleOpenProjectPermissions = useCallback(() => {
    setMenuOpen(false);
    setProjectPermissionsDialogOpen(true);
  }, []);

  const handleOpenPortForward = useCallback(() => {
    setMenuOpen(false);
    setPortForwardDialogOpen(true);
  }, []);

  // A forward is carried by this workspace's SSH session, so the entry belongs
  // to the workspace that owns the connection rather than to a global menu.
  const portForwardConnectionId =
    isRemoteWorkspace(workspace) && workspace.connectionId ? workspace.connectionId : null;

  const handleRequestRename = useCallback(() => {
    setMenuOpen(false);
    setRenameDialogOpen(true);
  }, []);

  const validateWorkspaceName = useCallback((value: string): string | null => {
    const normalizedName = value.trim();
    if (!normalizedName) {
      return t('nav.workspaces.renameDialog.validation.required');
    }
    if (containsWorkspaceNameControlCharacter(normalizedName)) {
      return t('nav.workspaces.renameDialog.validation.invalidCharacters');
    }
    if (Array.from(normalizedName).length > MAX_WORKSPACE_NAME_CHARS) {
      return t('nav.workspaces.renameDialog.validation.tooLong', {
        max: MAX_WORKSPACE_NAME_CHARS,
      });
    }
    return null;
  }, [t]);

  const handleRenameWorkspace = useCallback(async (name: string) => {
    const normalizedName = name.trim();
    if (normalizedName === workspace.name) {
      return;
    }

    try {
      await renameWorkspace(workspace.id, normalizedName);
      notificationService.success(t('nav.workspaces.renamed'), { duration: 2500 });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.renameFailed'),
        { duration: 4000 }
      );
    }
  }, [renameWorkspace, t, workspace.id, workspace.name]);

  const handleRequestDeleteAssistant = useCallback(() => {
    setMenuOpen(false);
    setDeleteDialogOpen(true);
  }, []);

  const handleRequestResetWorkspace = useCallback(() => {
    setMenuOpen(false);
    setResetDialogOpen(true);
  }, []);

  const handleConfirmDeleteAssistant = useCallback(async () => {
    if (!isDeletableAssistantWorkspace || isDeletingAssistant) {
      return;
    }

    setIsDeletingAssistant(true);
    try {
      await deleteAssistantWorkspace(workspace.id);
      notificationService.success(t('nav.workspaces.assistantDeleted'), { duration: 2500 });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.deleteAssistantFailed'),
        { duration: 4000 }
      );
    } finally {
      setIsDeletingAssistant(false);
    }
  }, [deleteAssistantWorkspace, isDeletableAssistantWorkspace, isDeletingAssistant, t, workspace.id]);

  const handleConfirmResetWorkspace = useCallback(async () => {
    if (!isDefaultAssistantWorkspace || isResettingWorkspace) {
      return;
    }

    setIsResettingWorkspace(true);
    setResetDialogOpen(false);
    try {
      await resetAssistantWorkspace(workspace.id);
      await flowChatManager.resetWorkspaceSessions(workspace, {
        reinitialize: isActive,
        preferredMode: 'Claw',
      });
      notificationService.success(t('nav.workspaces.workspaceReset'), { duration: 2500 });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.resetWorkspaceFailed'),
        { duration: 4000 }
      );
    } finally {
      setIsResettingWorkspace(false);
    }
  }, [isActive, isDefaultAssistantWorkspace, isResettingWorkspace, resetAssistantWorkspace, t, workspace]);

  const handleReveal = useCallback(async () => {
    setMenuOpen(false);
    if (isRemoteWorkspace(workspace)) return;
    try {
      await workspaceAPI.revealInExplorer(workspace.rootPath);
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.revealFailed'),
        { duration: 4000 }
      );
    }
  }, [t, workspace]);

  const handleCopyWorkspacePath = useCallback(async () => {
    setMenuOpen(false);
    const path = workspace.rootPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      notificationService.success(t('contextMenu.status.copyPathSuccess'), { duration: 2000 });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.copyPathFailed'),
        { duration: 4000 }
      );
    }
  }, [t, workspace.rootPath]);

  const handleCreateSession = useCallback(async (mode?: 'Standard' | 'Cowork' | 'Claw') => {
    setMenuOpen(false);
    const resolvedMode = mode ?? (workspace.workspaceKind === WorkspaceKind.Assistant ? 'Claw' : undefined);
    try {
      const reusableId = findReusableEmptySessionId(workspace, resolvedMode);
      if (reusableId) {
        await openMainSession(reusableId, {
          workspaceId: workspace.id,
          activateWorkspace: setActiveWorkspace,
        });
        return;
      }
      const newSessionId = await flowChatManager.createChatSession(
        flowChatSessionConfigForWorkspace(workspace),
        resolvedMode
      );
      await openMainSession(newSessionId, {
        workspaceId: workspace.id,
        activateWorkspace: setActiveWorkspace,
      });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.createSessionFailed'),
        { duration: 4000 }
      );
    }
  }, [
    setActiveWorkspace,
    t,
    workspace,
  ]);

  const handleCreateProjectSession = useCallback(() => {
    void handleCreateSession();
  }, [handleCreateSession]);

  const handleCreateAcpSession = useCallback(async (client: AcpClientInfo) => {
    setMenuOpen(false);
    try {
      const sessionId = await flowChatManager.createAcpChatSession(
        client.id,
        flowChatSessionConfigForWorkspace(workspace),
      );
      await openMainSession(sessionId, {
        workspaceId: workspace.id,
        activateWorkspace: setActiveWorkspace,
      });
    } catch {
      // createAcpChatSession records the failure through the ACP notification lifecycle.
    }
  }, [setActiveWorkspace, workspace]);

  const handleCreateInitSession = useCallback(async () => {
    setMenuOpen(false);

    try {
      const preferredMode = workspace.workspaceKind === WorkspaceKind.Assistant ? 'Claw' : undefined;
      const sessionId = await flowChatManager.createChatSession(
        flowChatSessionConfigForWorkspace(workspace),
        preferredMode
      );

      await openMainSession(sessionId, {
        workspaceId: workspace.id,
        activateWorkspace: setActiveWorkspace,
      });

      await agentAPI.runInitAgentsMd({
        sessionId,
        workspaceId: workspace.id,
        workspacePath: workspace.rootPath,
        ...(isRemoteWorkspace(workspace) && workspace.connectionId
          ? { remoteConnectionId: workspace.connectionId }
          : {}),
        ...(isRemoteWorkspace(workspace) && workspace.sshHost
          ? { remoteSshHost: workspace.sshHost }
          : {}),
      });
    } catch (error) {
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.initSessionFailed'),
        { duration: 4000 }
      );
    }
  }, [setActiveWorkspace, t, workspace]);

  const handleOpenFiles = useCallback(() => {
    switchLeftPanelTab('files');
    openWorkspaceResources(workspace.id);
  }, [openWorkspaceResources, switchLeftPanelTab, workspace.id]);

  const handleCreateTerminal = useCallback(() => {
    setMenuOpen(false);
    const surfaceId = getActiveSurfaceId();
    window.dispatchEvent(new CustomEvent('terminal-create-requested', {
      detail: {
        workingDirectory: workspace.rootPath,
        surfaceId,
        resourceScope: {
          surfaceId,
          workspaceId: workspace.id,
          workspacePath: workspace.rootPath,
          remoteConnectionId: workspace.connectionId,
        },
      },
    }));
  }, [workspace]);

  if (workspace.workspaceKind === WorkspaceKind.Assistant) {
    return (
      <div className={[
        'openbitfun-nav-panel__assistant-item',
        isActive && 'is-active',
        isDragging && 'is-dragging',
        menuOpen && 'is-menu-open',
        sessionsCollapsed && 'is-sessions-collapsed',
        isSingle && 'is-single',
      ].filter(Boolean).join(' ')}
      data-openbitfun-product-component="workspace-item"
      data-openbitfun-product-part="root"
      data-openbitfun-variant="assistant"
      data-openbitfun-state={[
        isActive && 'active',
        isDragging && 'dragging',
        sessionsCollapsed && 'collapsed',
        workspaceIsRemote && 'remote',
      ].filter(Boolean).join(' ')}
      aria-current={isActive ? 'location' : undefined}
      aria-grabbed={draggable ? isDragging : undefined}
      data-testid="nav-workspace-item"
      data-workspace-id={workspace.id}
      data-workspace-kind={workspace.workspaceKind}
      data-workspace-active={isActive ? 'true' : 'false'}>
        <div
          data-openbitfun-product-component="workspace-item"
          data-openbitfun-product-part="card"
          ref={cardRef}
          className="openbitfun-nav-panel__assistant-item-card"
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={handleCollapseToggle}
          onContextMenu={handleContextMenu}
          style={{ cursor: 'pointer' }}
          data-testid="nav-workspace-card"
          data-workspace-id={workspace.id}
        >
          <button
            data-openbitfun-product-component="workspace-item"
            data-openbitfun-product-part="collapse"
            type="button"
            className="openbitfun-nav-panel__assistant-item-collapse-btn"
            onClick={e => { e.stopPropagation(); handleCollapseToggle(); }}
            aria-label={sessionsCollapsed ? t('nav.workspaces.expandSessions') : t('nav.workspaces.collapseSessions')}
            aria-expanded={!sessionsCollapsed}
            data-testid="nav-workspace-sessions-toggle"
            data-workspace-id={workspace.id}
          >
            <span className="openbitfun-nav-panel__assistant-item-avatar is-group-icon" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="icon" aria-hidden="true">
              <span className="openbitfun-nav-panel__assistant-item-group-icon">
                <Icon name="user" size="sm" />
              </span>
              <span className="openbitfun-nav-panel__assistant-item-icon-toggle">
                <Icon name={sessionDisclosureIcon} size="sm" />
              </span>
            </span>
          </button>
          <Tooltip content={workspace.rootPath} placement="right" followCursor>
            <ActionItem data-overflow-trigger
              data-openbitfun-product-component="workspace-item"
              data-openbitfun-product-part="name"
              type="button"
              className="openbitfun-nav-panel__assistant-item-name-action"
              triggerClassName="openbitfun-nav-panel__assistant-item-name-btn"
              labelBehavior="static"
              onClick={e => { e.stopPropagation(); handleCollapseToggle(); }}
              data-testid="nav-workspace-name-btn"
              data-workspace-id={workspace.id}
            >
              <OverflowText className="openbitfun-nav-panel__assistant-item-label" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="label">{workspaceDisplayName}</OverflowText>
            </ActionItem>
          </Tooltip>

          <div className="openbitfun-nav-panel__assistant-item-menu" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="menu" ref={menuRef} onClick={e => e.stopPropagation()}>
            <Tooltip content={t('nav.workspaces.actions.newSession')} placement="right" followCursor>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="action"
                type="button"
                className="openbitfun-nav-panel__assistant-item-menu-trigger"
                onClick={() => { void handleCreateSession(); }}
                aria-label={t('nav.workspaces.actions.newSession')}
                data-testid="nav-workspace-new-session-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="plus" size="xs" />
              </button>
            </Tooltip>
            <Tooltip content={t('nav.resources.title')} placement="right" followCursor>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="action"
                type="button"
                className="openbitfun-nav-panel__assistant-item-menu-trigger"
                onClick={() => { void handleOpenFiles(); }}
                data-testid="nav-workspace-files-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="folder" size="xs" />
              </button>
            </Tooltip>
            <div ref={menuAnchorRef}>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="action"
                type="button"
                className={`openbitfun-nav-panel__assistant-item-menu-trigger${menuOpen ? ' is-open' : ''}`}
                onClick={handleMenuTriggerClick}
                data-testid="nav-workspace-menu-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="more" size="xs" />
              </button>
            </div>

            {menuOpen && createOverlayPortal(
              <Menu
                ref={menuPopoverRef}
                className="openbitfun-nav-panel__workspace-item-menu-popover"
                style={{
                  top: menuPosition?.top ?? 0,
                  left: menuPosition?.left ?? 0,
                  visibility: menuPosition ? 'visible' : 'hidden',
                }}
                data-testid="nav-workspace-item-menu"
                data-workspace-id={workspace.id}
              >
                <MenuItem
                  leading={<Icon name="plus" size="xs" />}
                  onClick={() => { void handleCreateSession(); }}
                  data-testid="nav-workspace-menu-create-session"
                >
                  {t('nav.workspaces.actions.newSession')}
                </MenuItem>
                <MenuItem leading={<Icon name="clock" size="xs" />} onClick={handleOpenScheduledJobs}>
                  {t('nav.scheduledJobs.open')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={ShieldCheck} />}
                  onClick={handleOpenProjectPermissions}
                  data-testid="nav-workspace-menu-project-permissions"
                >
                  {t('nav.workspaces.actions.manageProjectPermissions')}
                </MenuItem>
                {portForwardConnectionId ? (
                  <MenuItem
                    leading={<Icon glyph={Network} />}
                    onClick={handleOpenPortForward}
                    data-testid="nav-workspace-menu-port-forward"
                  >
                    {t('ssh.portForward.menuEntry')}
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  leading={<Icon name="duplicate" size="xs" />}
                  onClick={() => { void handleCopyWorkspacePath(); }}
                  disabled={!workspace.rootPath}
                  data-testid="nav-workspace-menu-copy-path"
                >
                  {t('nav.workspaces.actions.copyPath')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={FolderSearch} />}
                  onClick={() => { void handleReveal(); }}
                  disabled={isRemoteWorkspace(workspace)}
                  data-testid="nav-workspace-menu-reveal"
                >
                  {t('nav.workspaces.actions.reveal')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  leading={<Icon glyph={ListChecks} />}
                  onClick={handleOpenSessionBatchModal}
                  data-testid="nav-workspace-menu-manage-sessions"
                >
                  {t('nav.sessions.manage')}
                </MenuItem>
                {(isDefaultAssistantWorkspace || isDeletableAssistantWorkspace) ? (
                  <>
                    {isDefaultAssistantWorkspace ? (
                      <MenuItem
                        leading={<Icon glyph={RotateCcw} />}
                        tone="danger"
                        onClick={handleRequestResetWorkspace}
                        disabled={isResettingWorkspace}
                        data-testid="nav-workspace-menu-reset-assistant"
                      >
                        {t('nav.workspaces.actions.resetWorkspace')}
                      </MenuItem>
                    ) : null}
                    {isDeletableAssistantWorkspace ? (
                      <MenuItem
                        leading={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
                        tone="danger"
                        onClick={handleRequestDeleteAssistant}
                        disabled={isDeletingAssistant}
                        data-testid="nav-workspace-menu-delete-assistant"
                      >
                        {t('nav.workspaces.actions.deleteAssistant')}
                      </MenuItem>
                    ) : null}
                  </>
                ) : null}
              </Menu>,
              getAppearanceOverlayHost()
            )}
          </div>
        </div>

        <div
          data-openbitfun-product-component="workspace-item"
          data-openbitfun-product-part="sessions"
          className={`openbitfun-nav-panel__assistant-item-sessions${sessionsCollapsed ? ' is-collapsed' : ''}`}
          data-testid="nav-workspace-session-region"
          data-workspace-id={workspace.id}
        >
          <SessionsSection
            workspaceId={workspace.id}
            workspacePath={workspace.rootPath}
            isActiveWorkspace={isActive}
            isVisible={!sessionsCollapsed}
            useWorkspaceViewPreferences
          />
        </div>

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={() => setDeleteDialogOpen(false)}
          onConfirm={() => { void handleConfirmDeleteAssistant(); }}
          title={t('nav.workspaces.deleteAssistantDialog.title', { name: workspaceDisplayName })}
          message={t('nav.workspaces.deleteAssistantDialog.message')}
          confirmText={t('nav.workspaces.actions.deleteAssistant')}
          cancelText={t('actions.cancel')}
          confirmDanger
        />
        <ConfirmDialog
          open={resetDialogOpen}
          onOpenChange={() => setResetDialogOpen(false)}
          onConfirm={() => { void handleConfirmResetWorkspace(); }}
          title={t('nav.workspaces.resetWorkspaceDialog.title', { name: workspaceDisplayName })}
          message={t('nav.workspaces.resetWorkspaceDialog.message')}
          confirmText={t('nav.workspaces.actions.resetWorkspace')}
          cancelText={t('actions.cancel')}
          confirmDanger
          preview={`${t('nav.workspaces.resetWorkspaceDialog.pathLabel')}\n${workspace.rootPath}`}
        />
        <RetainedMountBoundary present={sessionBatchModalOpen}>
          <Suspense fallback={null}>
            <WorkspaceSessionBatchModal
              isOpen={sessionBatchModalOpen}
              onClose={() => setSessionBatchModalOpen(false)}
              workspaceId={workspace.id}
              workspaceLabel={workspaceDisplayName}
            />
          </Suspense>
        </RetainedMountBoundary>
        <RetainedMountBoundary present={scheduledJobsModalOpen}>
          <Suspense fallback={null}>
            <ScheduledJobsModal
              isOpen={scheduledJobsModalOpen}
              onClose={() => setScheduledJobsModalOpen(false)}
              workspaceId={workspace.id}
              workspaceKind={workspace.workspaceKind}
              targetKind="workspace"
              title={t('nav.scheduledJobs.title')}
              targetLabel={workspaceDisplayName}
              targetDescription={workspace.rootPath}
            />
          </Suspense>
        </RetainedMountBoundary>
        <RetainedMountBoundary present={projectPermissionsDialogOpen}>
          <Suspense fallback={null}>
            <WorkspaceProjectPermissionsDialog
              workspace={workspace}
              isOpen={projectPermissionsDialogOpen}
              onClose={() => setProjectPermissionsDialogOpen(false)}
            />
          </Suspense>
        </RetainedMountBoundary>
        <RetainedMountBoundary present={portForwardDialogOpen}>
          <Suspense fallback={null}>
            {portForwardConnectionId ? (
              <PortForwardDialog
                open={portForwardDialogOpen}
                connectionId={portForwardConnectionId}
                connectionName={workspaceDisplayName}
                onClose={() => setPortForwardDialogOpen(false)}
              />
            ) : null}
          </Suspense>
        </RetainedMountBoundary>
        
      </div>
    );
  }

  return (
    <div className={[
      'openbitfun-nav-panel__workspace-item',
      isActive && 'is-active',
      isDragging && 'is-dragging',
      menuOpen && 'is-menu-open',
      sessionsCollapsed && 'is-sessions-collapsed',
      isSingle && 'is-single',
    ].filter(Boolean).join(' ')}
    data-openbitfun-product-component="workspace-item"
    data-openbitfun-product-part="root"
    data-openbitfun-variant="workspace"
    data-openbitfun-state={[
      isActive && 'active',
      isDragging && 'dragging',
      sessionsCollapsed && 'collapsed',
      workspaceIsRemote && 'remote',
    ].filter(Boolean).join(' ')}
    aria-current={isActive ? 'location' : undefined}
    aria-grabbed={draggable ? isDragging : undefined}
    data-testid="nav-workspace-item"
    data-workspace-id={workspace.id}
    data-workspace-kind={workspace.workspaceKind}
    data-workspace-active={isActive ? 'true' : 'false'}>
      <div
        data-openbitfun-product-component="workspace-item"
        data-openbitfun-product-part="card"
        ref={cardRef}
        className="openbitfun-nav-panel__workspace-item-card"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={handleCollapseToggle}
        onContextMenu={handleContextMenu}
        style={{ cursor: 'pointer' }}
        data-testid="nav-workspace-card"
        data-workspace-id={workspace.id}
      >
        <button
          data-openbitfun-product-component="workspace-item"
          data-openbitfun-product-part="collapse"
          type="button"
          className="openbitfun-nav-panel__workspace-item-collapse-btn"
          onClick={e => { e.stopPropagation(); handleCollapseToggle(); }}
          aria-label={sessionsCollapsed ? t('nav.workspaces.expandSessions') : t('nav.workspaces.collapseSessions')}
          aria-expanded={!sessionsCollapsed}
          data-testid="nav-workspace-sessions-toggle"
          data-workspace-id={workspace.id}
        >
          <span className="openbitfun-nav-panel__workspace-item-icon" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="icon" aria-hidden="true">
            <span className="openbitfun-nav-panel__workspace-item-icon-default">
              {workspaceIsRemote ? (
                <Icon glyph={Server} size="sm" />
              ) : (
                <Icon name="folder" size="sm" />
              )}
            </span>
            <span className="openbitfun-nav-panel__workspace-item-icon-toggle">
              <Icon name={sessionDisclosureIcon} size="sm" />
            </span>
          </span>
        </button>
        <div className="openbitfun-nav-panel__workspace-item-name-cluster">
          <div className="openbitfun-nav-panel__workspace-item-name-stack">
            <div className="openbitfun-nav-panel__workspace-item-name-row">
              <Tooltip content={workspace.rootPath} placement="right" followCursor>
                <ActionItem
                  data-openbitfun-product-component="workspace-item"
                  data-openbitfun-product-part="name"
                  data-overflow-trigger
                  type="button"
                  className="openbitfun-nav-panel__workspace-item-name-action"
                  triggerClassName="openbitfun-nav-panel__workspace-item-name-btn"
                  labelBehavior="static"
                  onClick={e => { e.stopPropagation(); handleCollapseToggle(); }}
                  data-testid="nav-workspace-name-btn"
                  data-workspace-id={workspace.id}
                >
                  <span className="openbitfun-nav-panel__workspace-item-name-line">
                    <OverflowText
                      behavior="marquee"
                      className="openbitfun-nav-panel__workspace-item-label"
                      data-openbitfun-product-component="workspace-item"
                      data-openbitfun-product-part="label"
                      title=""
                    >
                      {workspaceDisplayName}
                    </OverflowText>
                    {relatedPathCount > 0 ? (
                      <span className="openbitfun-nav-panel__workspace-item-badge" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="badge">
                        {t('nav.workspaces.relatedPaths.badge', { count: relatedPathCount })}
                      </span>
                    ) : null}
                  </span>
                </ActionItem>
              </Tooltip>
              {searchIndexIndicator && (
                <>
                  <Tooltip
                    placement="right"
                    content={tFiles('search.index.indicator.hoverTooltip', {
                      status: [
                        searchIndexIndicator.title,
                        searchIndexIndicator.activeTaskLabel ?? searchIndexIndicator.phaseLabel,
                      ].join(' · '),
                    })}
                  >
                    <button
                      data-openbitfun-product-component="workspace-item"
                      data-openbitfun-product-part="indexIndicator"
                      type="button"
                      className={`openbitfun-nav-panel__workspace-index-indicator is-${searchIndexIndicator.tone}`}
                      aria-label={searchIndexIndicator.ariaLabel}
                      aria-expanded={searchIndexModalOpen}
                      onClick={e => {
                        e.stopPropagation();
                        setSearchIndexModalOpen(true);
                      }}
                      data-testid="nav-workspace-search-index-btn"
                      data-workspace-id={workspace.id}
                    />
                  </Tooltip>
                  <Dialog
                    open={searchIndexModalOpen}
                    onOpenChange={(nextOpen) => { if (!nextOpen) setSearchIndexModalOpen(false); }}
                    size="sm"
                  >
                    <DialogHeader>
                      <DialogHeading>
                        <DialogTitle>{tFiles('search.index.indicator.label')}</DialogTitle>
                      </DialogHeading>
                      <DialogClose />
                    </DialogHeader>
                    <DialogBody>
                      <div className="openbitfun-nav-panel__workspace-index-modal-content">
                    <div className={`openbitfun-nav-panel__workspace-index-tooltip is-${searchIndexIndicator.tone}`} data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="indexPanel">
                      <div className="openbitfun-nav-panel__workspace-index-tooltip-header">
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-heading">
                          <span className={`openbitfun-nav-panel__workspace-index-tooltip-dot is-${searchIndexIndicator.tone}`} aria-hidden="true" />
                          <div className="openbitfun-nav-panel__workspace-index-tooltip-title-wrap">
                            <span className="openbitfun-nav-panel__workspace-index-tooltip-title">
                              {searchIndexIndicator.title}
                            </span>
                            <span className="openbitfun-nav-panel__workspace-index-tooltip-phase">
                              {searchIndexIndicator.activeTaskLabel ?? searchIndexIndicator.phaseLabel}
                            </span>
                          </div>
                        </div>
                        <span className={`openbitfun-nav-panel__workspace-index-tooltip-badge is-${searchIndexIndicator.tone}`}>
                          {searchIndexIndicator.phaseLabel}
                        </span>
                      </div>
                      <div className="openbitfun-nav-panel__workspace-index-tooltip-summary">
                        {searchIndexIndicator.activeTaskMessage ?? searchIndexIndicator.summary}
                      </div>
                      {searchIndexIndicator.progressLabel ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-progress">
                          <div className="openbitfun-nav-panel__workspace-index-tooltip-progress-head">
                            <span>{searchIndexIndicator.progressLabel}</span>
                            {searchIndexIndicator.progressPercentLabel ? (
                              <span className="openbitfun-nav-panel__workspace-index-tooltip-progress-value">
                                {searchIndexIndicator.progressPercentLabel}
                              </span>
                            ) : null}
                          </div>
                          {typeof searchIndexIndicator.progressPercent === 'number' ? (
                            <div className="openbitfun-nav-panel__workspace-index-tooltip-progress-bar" aria-hidden="true">
                              <span
                                className={`openbitfun-nav-panel__workspace-index-tooltip-progress-fill is-${searchIndexIndicator.tone}`}
                                style={{ width: `${searchIndexIndicator.progressPercent}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {searchIndexIndicator.dirtyFilesLabel ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-meta">
                          {searchIndexIndicator.dirtyFilesLabel}
                        </div>
                      ) : null}
                      {searchIndexIndicator.workspaceProbePending ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-meta">
                          {tFiles('search.index.indicator.probePending')}
                        </div>
                      ) : null}
                      {searchIndexIndicator.baseAdvanceInProgress ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-meta is-warning">
                          {tFiles('search.index.indicator.baseAdvancing')}
                        </div>
                      ) : null}
                      {!searchIndexIndicator.probeHealthy ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-meta is-warning">
                          {tFiles('search.index.indicator.probeDegraded')}
                        </div>
                      ) : null}
                      {searchIndexIndicator.errorText ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-error">
                          {searchIndexIndicator.errorText}
                        </div>
                      ) : null}
                      {canRebuildSearchIndex ? (
                        <div className="openbitfun-nav-panel__workspace-index-tooltip-actions">
                          <Button
                            className="openbitfun-nav-panel__workspace-index-tooltip-action"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              void handleSearchIndexAction();
                            }}
                            disabled={
                              workspaceSearchIndex.loading
                              || workspaceSearchIndex.actionRunning
                              || workspaceSearchIndex.hasActiveTask
                            }
                          >
                            {workspaceSearchIndex.actionRunning || workspaceSearchIndex.hasActiveTask
                              ? tFiles('search.index.actions.running')
                              : tFiles('search.index.actions.rebuild')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                                        </div>
                                        </DialogBody>
                  </Dialog>
                </>
              )}
              {remoteMeta && (
                <Tooltip content={remoteMeta.tooltip} placement="right" followCursor>
                  <span
                    data-openbitfun-product-component="workspace-item"
                    data-openbitfun-product-part="remoteStatus"
                    className={`openbitfun-nav-panel__workspace-item-remote is-${remoteMeta.status}`}
                    role="img"
                    aria-label={remoteMeta.ariaLabel}
                    data-testid="nav-workspace-remote-meta"
                    data-remote-status={remoteMeta.status}
                  >
                    <span
                      className={`openbitfun-nav-panel__workspace-item-status-dot is-${remoteMeta.status}`}
                      aria-hidden="true"
                    />
                    <span className="openbitfun-nav-panel__workspace-item-remote-host">
                      {remoteMeta.connectionLabel}
                    </span>
                    {remoteMeta.showStatusText ? (
                      <span className="openbitfun-nav-panel__workspace-item-remote-status">
                        {remoteMeta.statusLabel}
                      </span>
                    ) : null}
                  </span>
                </Tooltip>
              )}
            </div>
          </div>
        </div>

        <div className="openbitfun-nav-panel__workspace-item-actions" onClick={e => e.stopPropagation()}>
          <div className="openbitfun-nav-panel__workspace-item-menu" data-openbitfun-product-component="workspace-item" data-openbitfun-product-part="menu" ref={menuRef}>
            <Tooltip content={t('nav.sessions.newSession')} placement="right" followCursor>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="action"
                type="button"
                className="openbitfun-nav-panel__workspace-item-menu-trigger"
                onClick={handleCreateProjectSession}
                aria-label={t('nav.sessions.newSession')}
                data-testid="nav-workspace-new-session-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="plus" size="xs" />
              </button>
            </Tooltip>
            <Tooltip content={t('nav.resources.title')} placement="right" followCursor>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="menuTrigger"
                data-openbitfun-state={menuOpen ? 'open' : undefined}
                type="button"
                className="openbitfun-nav-panel__workspace-item-menu-trigger"
                onClick={() => { void handleOpenFiles(); }}
                data-testid="nav-workspace-files-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="folder" size="xs" />
              </button>
            </Tooltip>
            <div ref={menuAnchorRef}>
              <button
                data-openbitfun-product-component="workspace-item"
                data-openbitfun-product-part="menuTrigger"
                data-openbitfun-state={menuOpen ? 'open' : undefined}
                type="button"
                className={`openbitfun-nav-panel__workspace-item-menu-trigger${menuOpen ? ' is-open' : ''}`}
                onClick={handleMenuTriggerClick}
                data-testid="nav-workspace-menu-btn"
                data-workspace-id={workspace.id}
              >
                <Icon name="more" size="xs" />
              </button>
            </div>

            {menuOpen && createOverlayPortal(
              <Menu
                ref={menuPopoverRef}
                className="openbitfun-nav-panel__workspace-item-menu-popover"
                style={{
                  top: menuPosition?.top ?? 0,
                  left: menuPosition?.left ?? 0,
                  visibility: menuPosition ? 'visible' : 'hidden',
                }}
                data-testid="nav-workspace-item-menu"
                data-workspace-id={workspace.id}
              >
                <MenuItem
                  leading={<Icon name="plus" size="xs" />}
                  onClick={handleCreateProjectSession}
                  data-testid="nav-workspace-menu-create-session"
                >
                  {t('nav.sessions.newSession')}
                </MenuItem>
                <WorkspaceAcpSessionSubmenu
                  ref={acpSubmenuRef}
                  clients={acpClients}
                  loading={acpClientsLoading}
                  onSelect={client => { void handleCreateAcpSession(client); }}
                />
                <MenuItem
                  leading={<Icon name="terminal" size="xs" />}
                  onClick={handleCreateTerminal}
                  disabled={!workspace.rootPath}
                  data-testid="nav-workspace-menu-create-terminal"
                >
                  {t('nav.shell.actions.newTerminal')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={FileText} />}
                  onClick={() => { void handleCreateInitSession(); }}
                  data-testid="nav-workspace-menu-create-init-session"
                >
                  {t('nav.workspaces.actions.initAgents')}
                </MenuItem>
                <MenuItem
                  leading={<Icon name="link" size="xs" />}
                  onClick={() => {
                    setMenuOpen(false);
                    setRelatedPathsDialogOpen(true);
                  }}
                  data-testid="nav-workspace-menu-related-paths"
                >
                  {t('nav.workspaces.actions.manageRelatedPaths')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={ShieldCheck} />}
                  onClick={handleOpenProjectPermissions}
                  data-testid="nav-workspace-menu-project-permissions"
                >
                  {t('nav.workspaces.actions.manageProjectPermissions')}
                </MenuItem>
                <MenuItem leading={<Icon name="clock" size="xs" />} onClick={handleOpenScheduledJobs}>
                  {t('nav.scheduledJobs.open')}
                </MenuItem>
                {portForwardConnectionId ? (
                  <MenuItem
                    leading={<Icon glyph={Network} />}
                    onClick={handleOpenPortForward}
                    data-testid="nav-workspace-menu-port-forward"
                  >
                    {t('ssh.portForward.menuEntry')}
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  leading={<Icon name="edit" size="xs" />}
                  onClick={handleRequestRename}
                  data-testid="nav-workspace-menu-rename"
                >
                  {t('nav.workspaces.actions.rename')}
                </MenuItem>
                <MenuItem
                  leading={<Icon name="duplicate" size="xs" />}
                  onClick={() => { void handleCopyWorkspacePath(); }}
                  disabled={!workspace.rootPath}
                  data-testid="nav-workspace-menu-copy-path"
                >
                  {t('nav.workspaces.actions.copyPath')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={FolderSearch} />}
                  onClick={() => { void handleReveal(); }}
                  disabled={isRemoteWorkspace(workspace)}
                  data-testid="nav-workspace-menu-reveal"
                >
                  {t('nav.workspaces.actions.reveal')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  leading={<Icon glyph={ListChecks} />}
                  onClick={handleOpenSessionBatchModal}
                  data-testid="nav-workspace-menu-manage-sessions"
                >
                  {t('nav.sessions.manage')}
                </MenuItem>
                <MenuItem
                  leading={<Icon glyph={FolderOpen} />}
                  tone="danger"
                  onClick={() => { void handleCloseWorkspace(); }}
                  data-testid="nav-workspace-menu-close"
                >
                  {t('nav.workspaces.actions.close')}
                </MenuItem>
              </Menu>,
              getAppearanceOverlayHost()
            )}
          </div>
        </div>
      </div>

      <div
        data-openbitfun-product-component="workspace-item"
        data-openbitfun-product-part="sessions"
        className={`openbitfun-nav-panel__workspace-item-sessions${sessionsCollapsed ? ' is-collapsed' : ''}`}
        data-testid="nav-workspace-session-region"
        data-workspace-id={workspace.id}
      >
        <SessionsSection
          workspaceId={workspace.id}
          workspacePath={workspace.rootPath}
          isActiveWorkspace={isActive}
          isVisible={!sessionsCollapsed}
          useWorkspaceViewPreferences
        />
      </div>

      <InputDialog
        isOpen={renameDialogOpen}
        onClose={() => setRenameDialogOpen(false)}
        onConfirm={(name) => { void handleRenameWorkspace(name); }}
        title={t('nav.workspaces.renameDialog.title')}
        description={t('nav.workspaces.renameDialog.description')}
        placeholder={t('nav.workspaces.renameDialog.placeholder')}
        defaultValue={workspace.name}
        confirmText={t('actions.save')}
        cancelText={t('actions.cancel')}
        validator={validateWorkspaceName}
        required={false}
      />
      <RetainedMountBoundary present={relatedPathsDialogOpen}>
        <Suspense fallback={null}>
          <WorkspaceRelatedPathsDialog
            workspace={workspace}
            isOpen={relatedPathsDialogOpen}
            onClose={() => setRelatedPathsDialogOpen(false)}
          />
        </Suspense>
      </RetainedMountBoundary>
      <RetainedMountBoundary present={projectPermissionsDialogOpen}>
        <Suspense fallback={null}>
          <WorkspaceProjectPermissionsDialog
            workspace={workspace}
            isOpen={projectPermissionsDialogOpen}
            onClose={() => setProjectPermissionsDialogOpen(false)}
          />
        </Suspense>
      </RetainedMountBoundary>
      <RetainedMountBoundary present={portForwardDialogOpen}>
        <Suspense fallback={null}>
          {portForwardConnectionId ? (
            <PortForwardDialog
              open={portForwardDialogOpen}
              connectionId={portForwardConnectionId}
              connectionName={workspaceDisplayName}
              onClose={() => setPortForwardDialogOpen(false)}
            />
          ) : null}
        </Suspense>
      </RetainedMountBoundary>
      
      <RetainedMountBoundary present={sessionBatchModalOpen}>
        <Suspense fallback={null}>
          <WorkspaceSessionBatchModal
            isOpen={sessionBatchModalOpen}
            onClose={() => setSessionBatchModalOpen(false)}
            workspaceId={workspace.id}
            workspaceLabel={workspaceDisplayName}
          />
        </Suspense>
      </RetainedMountBoundary>
      <RetainedMountBoundary present={scheduledJobsModalOpen}>
        <Suspense fallback={null}>
          <ScheduledJobsModal
            isOpen={scheduledJobsModalOpen}
            onClose={() => setScheduledJobsModalOpen(false)}
            workspaceId={workspace.id}
            workspaceKind={workspace.workspaceKind}
            targetKind="workspace"
            title={t('nav.scheduledJobs.title')}
            targetLabel={workspaceDisplayName}
            targetDescription={workspace.rootPath}
          />
        </Suspense>
      </RetainedMountBoundary>
    </div>
  );
};

export default WorkspaceItem;
