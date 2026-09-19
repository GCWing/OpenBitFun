/**
 * Session file change badge.
 * Shows compact file change stats in FlowChatHeader.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { FilePlus, SearchCheck, Zap, GitPullRequest } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createOverlayPortal, useDismissibleLayer, OverflowText, Icon, IconButton, Menu, MenuItem, MenuSeparator, Tooltip } from '@openbitfun/ui';
import { useSnapshotState } from '../../../tools/snapshot_system/hooks/useSnapshotState';
import { createDiffEditorTab } from '../../../shared/utils/tabUtils';
import { snapshotAPI } from '../../../infrastructure/api';
import { useWorkspaceContext } from '../../../infrastructure/contexts/WorkspaceContext';
import { notificationService } from '../../../shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { runWithConcurrencyLimit } from '@/shared/utils/runWithConcurrencyLimit';
import {
  launchPreparedReviewSession,
  prepareReviewLaunchFromSessionFiles,
} from '../../services/ReviewService';
import { getDeepReviewLaunchErrorMessage } from '../../deep-review/launch/launchErrors';
import { useDeepReviewConsent } from '../DeepReviewConsentDialog';
import {
  REVIEW_READY_GLINT_DURATION_MS,
  shouldTriggerReviewReadyGlint,
} from './reviewReadyGlint';
import { flowChatStore } from '../../store/FlowChatStore';
import type { DialogTurn } from '../../types/flow-chat';
import { useSessionReviewActivity } from '../../hooks/useSessionReviewActivity';
import { useSessionStateMachine } from '../../hooks/useSessionStateMachine';
import { SessionExecutionState } from '../../state-machine/types';
import { isReviewActivityBlocking } from '../../utils/sessionReviewActivity';
import {
  aiExperienceConfigService,
  DEFAULT_QUICK_ACTIONS,
  type QuickAction,
} from '@/infrastructure/config/services/AIExperienceConfigService';
import { resolveQuickActionText } from '@/infrastructure/config/services/quickActionLocalization';
import { deriveDeepReviewSessionConcurrencyGuard } from '../../utils/deepReviewCapacityGuard';
import { scheduleAfterStartupSignal } from '@/shared/utils/startupTaskScheduling';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { sessionWorkspaceId } from '../../session-drivers/sessionFileNavigation';
import './SessionFilesBadge.scss';

const log = createLogger('SessionFilesBadge');

const REVIEW_EXCLUDED_EXTENSIONS = new Set([
  '.7z', '.avi', '.avif', '.bin', '.bmp', '.class', '.dll', '.doc', '.docx', '.eot', '.exe',
  '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lock', '.map', '.min.js', '.min.css',
  '.mov', '.mp3', '.mp4', '.otf', '.pdf', '.png', '.rar', '.so', '.svg', '.tar', '.tgz',
  '.tiff', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xz', '.zip',
]);

const REVIEW_EXCLUDED_FILENAMES = new Set([
  'bun.lock', 'bun.lockb', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'package-lock.json',
  'pnpm-lock.yaml', 'poetry.lock', 'Podfile.lock', 'yarn.lock',
]);

const REVIEW_EXCLUDED_PATH_SEGMENTS = new Set([
  '.cache', '.next', '.nuxt', '.output', '.parcel-cache', '.svelte-kit', '.turbo',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);

function shouldReviewFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const segments = normalizedPath
    .split('/')
    .map(segment => segment.trim().toLowerCase())
    .filter(Boolean);

  if (segments.some(segment => REVIEW_EXCLUDED_PATH_SEGMENTS.has(segment))) {
    return false;
  }

  const fileName = normalizedPath.split('/').pop()?.trim() || normalizedPath;
  const lowerFileName = fileName.toLowerCase();

  if (REVIEW_EXCLUDED_FILENAMES.has(fileName) || REVIEW_EXCLUDED_FILENAMES.has(lowerFileName)) {
    return false;
  }

  if (lowerFileName.endsWith('.min.js') || lowerFileName.endsWith('.min.css')) {
    return false;
  }

  const extMatch = lowerFileName.match(/(\.[^.]+)$/);
  const extension = extMatch?.[1];

  if (extension && REVIEW_EXCLUDED_EXTENSIONS.has(extension)) {
    return false;
  }

  return true;
}

export interface SessionFilesBadgeProps {
  /** Session ID. */
  sessionId?: string;
  /** Disabled state. */
  disabled?: boolean;
}

interface FileStats {
  filePath: string;
  fileName: string;
  additions: number;
  deletions: number;
  operationType: 'write' | 'edit' | 'delete';
  loading?: boolean;
  error?: string;
}

interface StatsCache {
  [filePath: string]: {
    stats: FileStats;
    timestamp: number;
  };
}

type LatestTurnSnapshot = {
  turnId: string | null;
  status: DialogTurn['status'] | null;
};

function getLatestTurnSnapshot(sessionId?: string): LatestTurnSnapshot {
  if (!sessionId) {
    return { turnId: null, status: null };
  }

  const session = flowChatStore.getState().sessions.get(sessionId);
  const latestTurn = session?.dialogTurns[session.dialogTurns.length - 1];
  return {
    turnId: latestTurn?.id ?? null,
    status: latestTurn?.status ?? null,
  };
}

function isTurnActivelyRunning(status: DialogTurn['status'] | null): boolean {
  return (
    status === 'pending' ||
    status === 'image_analyzing' ||
    status === 'processing' ||
    status === 'finishing' ||
    status === 'cancelling'
  );
}

/**
 * Session file change badge.
 */
export const SessionFilesBadge: React.FC<SessionFilesBadgeProps> = ({
  sessionId,
  disabled = false,
}) => {
  const { t } = useTranslation('flow-chat');
  const canLaunchReview = isTauriRuntime();
  const { files } = useSnapshotState(sessionId);
  const { currentWorkspace } = useWorkspaceContext();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isReviewMenuOpen, setIsReviewMenuOpen] = useState(false);
  const [showReviewReadyGlint, setShowReviewReadyGlint] = useState(false);
  const [launchingReviewMode, setLaunchingReviewMode] = useState<'review' | null>(null);
  const [fileStats, setFileStats] = useState<Map<string, FileStats>>(new Map());
  const [loadingStats, setLoadingStats] = useState(false);
  const reviewActivity = useSessionReviewActivity(sessionId);
  const sessionMachine = useSessionStateMachine(sessionId ?? null);
  const isSessionProcessing =
    sessionMachine?.currentState === SessionExecutionState.PROCESSING ||
    sessionMachine?.currentState === SessionExecutionState.FINISHING;
  const isReviewLaunchOrActivityBlocking =
    launchingReviewMode !== null ||
    isReviewActivityBlocking(reviewActivity);
  /** Includes loadingStats: used for review launches and “review ready” affordances. */
  const isReviewActionLocked =
    loadingStats ||
    isReviewLaunchOrActivityBlocking;
  const [latestTurnSnapshot, setLatestTurnSnapshot] = useState<LatestTurnSnapshot>(() =>
    getLatestTurnSnapshot(sessionId),
  );

  const statsCacheRef = useRef<StatsCache>({});
  const loadingFilesRef = useRef<Set<string>>(new Set());
  const activeFilePathsRef = useRef<Set<string>>(new Set());
  const previousSessionIdRef = useRef<string | undefined>(undefined);
  const observedProcessingTurnIdRef = useRef<string | null>(null);
  const promptedReviewReadyTurnIdRef = useRef<string | null>(null);
  const reviewReadyGlintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CACHE_TTL = 60000;
  const DIFF_STATS_MAX_CONCURRENCY = 3;

  const [quickActions, setQuickActions] = useState<QuickAction[]>(() => {
    const stored = aiExperienceConfigService.getSettings().quick_actions;
    return stored ?? DEFAULT_QUICK_ACTIONS;
  });

  const badgeRef = useRef<HTMLDivElement>(null);
  const fileTriggerRef = useRef<HTMLButtonElement>(null);
  const filePopoverRef = useRef<HTMLDivElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewPopoverRef = useRef<HTMLDivElement>(null);
  const { confirmDeepReviewLaunch, deepReviewConsentDialog } = useDeepReviewConsent();
  const reviewPopoverLayout = useAnchoredPopoverPosition({
    open: isReviewMenuOpen && !isReviewLaunchOrActivityBlocking,
    anchorRef: reviewTriggerRef,
    popoverRef: reviewPopoverRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 4,
    layoutRevision: quickActions,
  });
  const filePopoverLayout = useAnchoredPopoverPosition({
    open: isExpanded && fileStats.size > 0,
    anchorRef: fileTriggerRef,
    popoverRef: filePopoverRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 4,
    layoutRevision: fileStats,
  });

  const clearReviewReadyGlint = useCallback(() => {
    setShowReviewReadyGlint(false);
    if (reviewReadyGlintTimeoutRef.current) {
      clearTimeout(reviewReadyGlintTimeoutRef.current);
      reviewReadyGlintTimeoutRef.current = null;
    }
  }, []);

  // Sync quick actions when settings change.
  useEffect(() => {
    let cancelled = false;
    let unsubscribeSettings: (() => void) | null = null;
    const cancelStartupSchedule = scheduleAfterStartupSignal(async () => {
      const settings = await aiExperienceConfigService.getSettingsAsync();
      if (cancelled) {
        return;
      }
      const actions = settings.quick_actions;
      setQuickActions(actions ?? DEFAULT_QUICK_ACTIONS);
      unsubscribeSettings = aiExperienceConfigService.addChangeListener((nextSettings) => {
        const nextActions = nextSettings.quick_actions;
        setQuickActions(nextActions ?? DEFAULT_QUICK_ACTIONS);
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

  // Reset cached state when the session changes.
  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      statsCacheRef.current = {};
      loadingFilesRef.current.clear();
      activeFilePathsRef.current = new Set(files.map(file => file.filePath));
      setFileStats(new Map());
      setIsExpanded(false);
      setIsReviewMenuOpen(false);
      clearReviewReadyGlint();
      setLaunchingReviewMode(null);
      observedProcessingTurnIdRef.current = null;
      promptedReviewReadyTurnIdRef.current = null;
      setLatestTurnSnapshot(getLatestTurnSnapshot(sessionId));
    }
  }, [clearReviewReadyGlint, files, sessionId, t]);

  useEffect(() => {
    const activeFilePaths = new Set(files.map(file => file.filePath));
    activeFilePathsRef.current = activeFilePaths;

    setFileStats(prev => {
      let changed = false;
      const next = new Map<string, FileStats>();
      prev.forEach((stat, filePath) => {
        if (activeFilePaths.has(filePath)) {
          next.set(filePath, stat);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    for (const filePath of Object.keys(statsCacheRef.current)) {
      if (!activeFilePaths.has(filePath)) {
        delete statsCacheRef.current[filePath];
      }
    }

    for (const filePath of Array.from(loadingFilesRef.current)) {
      if (!activeFilePaths.has(filePath)) {
        loadingFilesRef.current.delete(filePath);
      }
    }
  }, [files]);

  useEffect(() => () => {
    if (reviewReadyGlintTimeoutRef.current) {
      clearTimeout(reviewReadyGlintTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const syncLatestTurn = () => {
      const nextSnapshot = getLatestTurnSnapshot(sessionId);
      setLatestTurnSnapshot(prev => (
        prev.turnId === nextSnapshot.turnId && prev.status === nextSnapshot.status
          ? prev
          : nextSnapshot
      ));
    };

    syncLatestTurn();
    const unsubscribe = flowChatStore.subscribe(syncLatestTurn);
    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    const { turnId, status } = latestTurnSnapshot;
    if (!turnId) {
      observedProcessingTurnIdRef.current = null;
      promptedReviewReadyTurnIdRef.current = null;
      clearReviewReadyGlint();
      return;
    }

    if (isTurnActivelyRunning(status)) {
      observedProcessingTurnIdRef.current = turnId;
      promptedReviewReadyTurnIdRef.current = null;
      clearReviewReadyGlint();
      setIsReviewMenuOpen(false);
    }
  }, [clearReviewReadyGlint, latestTurnSnapshot]);

  useDismissibleLayer({
    enabled: isExpanded, layerRef: filePopoverRef, branchRefs: [badgeRef],
    onDismiss: () => setIsExpanded(false),
  });
  useDismissibleLayer({
    enabled: isReviewMenuOpen, layerRef: reviewPopoverRef, branchRefs: [badgeRef],
    onDismiss: () => setIsReviewMenuOpen(false),
  });

  /**
   * Fetch per-file diff stats with caching.
   */
  const loadFileStats = useCallback(async (filesToLoad: typeof files) => {
    if (!sessionId || filesToLoad.length === 0) {
      return;
    }

    const now = Date.now();

    const newFilesToLoad = filesToLoad.filter(file => {
      if (loadingFilesRef.current.has(file.filePath)) {
        return false;
      }
      const cached = statsCacheRef.current[file.filePath];
      if (cached && now - cached.timestamp < CACHE_TTL) {
        return false;
      }
      return true;
    });

    if (newFilesToLoad.length === 0) {
      return;
    }

    setLoadingStats(true);

    try {
      newFilesToLoad.forEach(file => {
        loadingFilesRef.current.add(file.filePath);
      });

      const batchResults = await runWithConcurrencyLimit(
        newFilesToLoad,
        DIFF_STATS_MAX_CONCURRENCY,
        async (file) => {
          let stats: FileStats | null = null;

          try {
            const statsResp = await snapshotAPI.getSessionFileDiffStats(
              sessionId,
              file.filePath,
            );
            const fileName = file.filePath.split(/[/\\]/).pop() || file.filePath;

            const additions = statsResp.linesAdded;
            const deletions = statsResp.linesRemoved;
            const operationType: 'write' | 'edit' | 'delete' =
              statsResp.changeKind === 'create'
                ? 'write'
                : statsResp.changeKind === 'delete'
                  ? 'delete'
                  : 'edit';

            stats = {
              filePath: file.filePath,
              fileName,
              additions,
              deletions,
              operationType,
            };

            if (activeFilePathsRef.current.has(file.filePath)) {
              statsCacheRef.current[file.filePath] = {
                stats,
                timestamp: now,
              };
            }
          } catch (error) {
            log.warn('Failed to get file stats', { filePath: file.filePath, error });
            const fileName = file.filePath.split(/[/\\]/).pop() || file.filePath;
            stats = {
              filePath: file.filePath,
              fileName,
              additions: 0,
              deletions: 0,
              operationType: 'edit',
              error: t('sessionFilesBadge.loadFailed'),
            };
          } finally {
            loadingFilesRef.current.delete(file.filePath);
          }

          return { filePath: file.filePath, stats };
        },
      );

      setFileStats((prev) => {
        const newMap = new Map(prev);
        for (const { filePath, stats } of batchResults) {
          if (
            activeFilePathsRef.current.has(filePath) &&
            stats &&
            (stats.additions > 0 || stats.deletions > 0 || stats.error)
          ) {
            newMap.set(filePath, stats);
          }
        }
        return newMap;
      });
    } catch (error) {
      log.error('Failed to load file stats', error);
    } finally {
      setLoadingStats(false);
    }
  }, [sessionId, t]);

  // Reload stats when the file list changes.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (files.length > 0) {
        loadFileStats(files);
      } else {
        setFileStats(new Map());
        statsCacheRef.current = {};
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [files, loadFileStats]);

  useEffect(() => {
    if (fileStats.size === 0) {
      setIsExpanded(false);
    }
  }, [fileStats.size]);

  // Compute totals.
  const totalStats = useMemo(() => {
    let totalAdditions = 0;
    let totalDeletions = 0;

    fileStats.forEach((stat) => {
      totalAdditions += stat.additions;
      totalDeletions += stat.deletions;
    });

    return { totalAdditions, totalDeletions };
  }, [fileStats]);

  const fileChangeToggleHint = useMemo(() => {
    if (fileStats.size === 0) return '';
    const head = t('sessionFilesBadge.filesSummaryCount', {
      count: fileStats.size,
    });
    const deltas: string[] = [];
    if (totalStats.totalAdditions > 0) deltas.push(`+${totalStats.totalAdditions}`);
    if (totalStats.totalDeletions > 0) deltas.push(`-${totalStats.totalDeletions}`);
    const cue = t('sessionFilesBadge.expandChangeListCue');
    return deltas.length > 0 ? `${head} · ${deltas.join(' ')} · ${cue}` : `${head} · ${cue}`;
  }, [fileStats.size, totalStats.totalAdditions, totalStats.totalDeletions, t]);

  const fileChangeToggleAriaCollapsed = useMemo(() => {
    if (fileStats.size === 0) return '';
    const head = t('sessionFilesBadge.filesSummaryCount', {
      count: fileStats.size,
    });
    const deltas: string[] = [];
    if (totalStats.totalAdditions > 0) deltas.push(`+${totalStats.totalAdditions}`);
    if (totalStats.totalDeletions > 0) deltas.push(`-${totalStats.totalDeletions}`);
    const cue = t('sessionFilesBadge.expandChangeListAriaCue');
    return deltas.length > 0 ? `${head}, ${deltas.join(' ')}, ${cue}` : `${head}, ${cue}`;
  }, [fileStats.size, totalStats.totalAdditions, totalStats.totalDeletions, t]);

  const reviewableFileCount = useMemo(() => {
    return Array.from(fileStats.keys()).filter(shouldReviewFile).length;
  }, [fileStats]);
  const reviewActionAvailable =
    !disabled &&
    reviewableFileCount > 0 &&
    !isReviewActionLocked &&
    !isSessionProcessing;

  const areReviewMenuItemsDisabled =
    loadingStats ||
    reviewableFileCount === 0 ||
    isSessionProcessing ||
    isReviewLaunchOrActivityBlocking;

  useEffect(() => {
    if (shouldTriggerReviewReadyGlint({
      currentTurnId: latestTurnSnapshot.turnId,
      currentTurnStatus: latestTurnSnapshot.status,
      observedProcessingTurnId: observedProcessingTurnIdRef.current,
      promptedTurnId: promptedReviewReadyTurnIdRef.current,
      nextReviewableCount: reviewableFileCount,
      loadingStats,
      reviewActionAvailable,
      sessionProcessing: isSessionProcessing,
    })) {
      setShowReviewReadyGlint(true);
      promptedReviewReadyTurnIdRef.current = latestTurnSnapshot.turnId;
      if (reviewReadyGlintTimeoutRef.current) {
        clearTimeout(reviewReadyGlintTimeoutRef.current);
      }
      reviewReadyGlintTimeoutRef.current = setTimeout(() => {
        setShowReviewReadyGlint(false);
        reviewReadyGlintTimeoutRef.current = null;
      }, REVIEW_READY_GLINT_DURATION_MS);
    }
  }, [isSessionProcessing, latestTurnSnapshot, loadingStats, reviewActionAvailable, reviewableFileCount]);

  useEffect(() => {
    if (showReviewReadyGlint && !reviewActionAvailable) {
      clearReviewReadyGlint();
    }
  }, [clearReviewReadyGlint, reviewActionAvailable, showReviewReadyGlint]);

  // Open diff for the selected file.
  const handleFileClick = useCallback(async (filePath: string) => {
    if (!sessionId) return;

    try {
      const diffData = await snapshotAPI.getOperationDiff(sessionId, filePath);
      if ((diffData.originalContent || '') === (diffData.modifiedContent || '')) {
        log.debug('Skipping empty session diff', { filePath, sessionId });
        setIsExpanded(false);
        return;
      }
      const fileName = filePath.split(/[/\\]/).pop() || filePath;

      // Expand the right panel.
      window.dispatchEvent(new CustomEvent('expand-right-panel'));

      setTimeout(() => {
        createDiffEditorTab(
          filePath,
          fileName,
          diffData.originalContent || '',
          diffData.modifiedContent || '',
          false,
          'agent',
          currentWorkspace?.rootPath,
          undefined,
          false,
          {
            titleKind: 'diff',
            duplicateKeyPrefix: 'diff',
            workspaceId: sessionWorkspaceId(sessionId) ?? currentWorkspace?.id,
          }
        );
      }, 250);

      setIsExpanded(false);
    } catch (error) {
      log.error('Failed to open diff', { filePath, error });
    }
  }, [sessionId, currentWorkspace?.rootPath, currentWorkspace?.id]);

  // Prepare and launch the least costly sufficient Review path.
  const handleReviewClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sessionId || fileStats.size === 0 || isReviewActionLocked) return;
    setIsReviewMenuOpen(false);

    const filePaths = Array.from(fileStats.keys());
    const reviewableFilePaths = filePaths.filter(shouldReviewFile);
    const skippedCount = filePaths.length - reviewableFilePaths.length;

    if (reviewableFilePaths.length === 0) {
      notificationService.warning(
        t('sessionFilesBadge.review.noEligibleFiles'),
        { duration: 3500 }
      );
      return;
    }

    if (skippedCount > 0) {
      notificationService.info(
        t('sessionFilesBadge.review.filteredNotice', {
          included: reviewableFilePaths.length,
          skipped: skippedCount,
        }),
        { duration: 3500 }
      );
    }

    const fileList = reviewableFilePaths.map(p => `- ${p}`).join('\n');
    const displayMessage = skippedCount > 0
      ? t('sessionFilesBadge.review.displayMessageFiltered', {
          files: fileList,
          skipped: skippedCount,
        })
      : t('sessionFilesBadge.review.displayMessage', { files: fileList });
    setLaunchingReviewMode('review');
    try {
      const reviewableStats = reviewableFilePaths
        .map((filePath) => fileStats.get(filePath))
        .filter((stat): stat is FileStats => Boolean(stat));
      const hasUnknownLineStats = reviewableStats.some((stat) => Boolean(stat.error));
      const prepared = await prepareReviewLaunchFromSessionFiles(
        reviewableFilePaths,
        {
          workspacePath: currentWorkspace?.rootPath,
          workspaceId: currentWorkspace?.id,
          changeStats: {
            fileCount: reviewableFilePaths.length,
            ...(!hasUnknownLineStats
              ? {
                totalLinesChanged: reviewableStats.reduce(
                  (total, stat) => total + stat.additions + stat.deletions,
                  0,
                ),
              }
              : {}),
            lineCountSource: hasUnknownLineStats ? 'unknown' : 'diff_stat',
          },
        },
      );

      if (prepared.mode === 'strict' && prepared.requiresConsent) {
        const confirmed = await confirmDeepReviewLaunch(prepared.runManifest, {
          sessionConcurrencyGuard: deriveDeepReviewSessionConcurrencyGuard(
            flowChatStore.getState(),
            sessionId,
          ),
        });
        if (!confirmed) {
          return;
        }
      }

      const reviewThreadTitle = t('sessionFilesBadge.review.threadTitle');
      const launched = await launchPreparedReviewSession({
        parentSessionId: sessionId,
        workspaceId: currentWorkspace?.id,
        workspacePath: currentWorkspace?.rootPath,
        displayMessage,
        prepared,
        childSessionName: reviewThreadTitle,
      });
      if (launched?.launchStatus === 'uncertain') {
        notificationService.warning(t('deepReviewActionBar.launchError.uncertain'), {
          duration: 8000,
        });
      }

      setIsExpanded(false);
    } catch (error) {
      log.error('Failed to send review request', {
        sessionId,
        fileCount: reviewableFilePaths.length,
        skippedCount,
        error,
      });
      notificationService.error(
        getDeepReviewLaunchErrorMessage(error, t, t('error.unknown')),
        {
          title: t('sessionFilesBadge.review.launchFailed'),
          duration: 5000,
        },
      );
    } finally {
      setLaunchingReviewMode(null);
    }
  }, [confirmDeepReviewLaunch, fileStats, isReviewActionLocked, sessionId, t, currentWorkspace?.id, currentWorkspace?.rootPath]);

  const handleQuickActionClick = useCallback(async (action: QuickAction) => {
    if (!sessionId || isSessionProcessing) return;
    setIsReviewMenuOpen(false);
    const actionText = resolveQuickActionText(action, t);
    try {
      const { FlowChatManager } = await import('../../services/FlowChatManager');
      await FlowChatManager.getInstance().sendMessage(
        actionText.prompt,
        sessionId,
        actionText.label,
      );
    } catch (error) {
      log.error('Failed to trigger quick action', { actionId: action.id, error });
    }
  }, [sessionId, isSessionProcessing, t]);

  const getOperationIcon = (operationType: 'write' | 'edit' | 'delete') => {
    switch (operationType) {
      case 'write':
        return <FilePlus size={12} className="icon-write" />;
      case 'delete':
        return <Icon name="delete" size="xs" className="icon-delete" />;
      default:
        return <Icon name="edit" size="xs" className="icon-edit" />;
    }
  };

  const activeReviewMode = launchingReviewMode ?? (reviewActivity?.isBlocking ? reviewActivity.kind : null) ?? null;
  const reviewButtonTitle = activeReviewMode
    ? t('sessionFilesBadge.reviewRunningHint')
    : t('sessionFilesBadge.actionsMenuHint');

  // Hide when there is no session or parent disabled. Actions menu (reviews + quick actions)
  // renders first; file-change summary appears after we have stats.
  if (!sessionId || disabled) {
    return null;
  }

  const showFileStatsSummary = fileStats.size > 0;

  return (
    <>
      <div data-openbitfun-component="session-files-badge" data-openbitfun-part="root" data-openbitfun-state={isExpanded ? 'expanded' : undefined}
        ref={badgeRef}
        className={`session-files-badge ${isExpanded ? 'session-files-badge--expanded' : ''}`}
      >
      <div
        className="session-files-badge__review-menu"
        data-openbitfun-component="session-files-badge"
        data-openbitfun-part="reviewMenu"
      >
        <Tooltip content={reviewButtonTitle}>
          <span
            className="session-files-badge__review-trigger"
            data-openbitfun-component="session-files-badge"
            data-openbitfun-part="reviewTrigger"
            data-openbitfun-state={isReviewMenuOpen ? 'open' : undefined}
          >
            <IconButton
              ref={reviewTriggerRef}
              className={[
                'session-files-badge__review-btn',
                showReviewReadyGlint && 'session-files-badge__review-btn--glint',
                activeReviewMode && 'session-files-badge__review-btn--running',
              ].filter(Boolean).join(' ')}
              size="xs"
              icon={<Icon name="commit" size="sm" className="session-files-badge__review-main-icon" />}
              loading={Boolean(activeReviewMode)}
              onClick={(event) => {
                event.stopPropagation();
                if (isReviewLaunchOrActivityBlocking) return;
                setIsReviewMenuOpen((open) => {
                  const next = !open;
                  if (next) setIsExpanded(false);
                  return next;
                });
              }}
              disabled={isReviewLaunchOrActivityBlocking}
              aria-label={reviewButtonTitle}
              aria-haspopup="menu"
              aria-expanded={isReviewMenuOpen && !isReviewLaunchOrActivityBlocking}
            />
          </span>
        </Tooltip>

        {isReviewMenuOpen && !isReviewLaunchOrActivityBlocking && createOverlayPortal(
          <Menu
            ref={reviewPopoverRef}
            className="session-files-badge__review-menu-popover"
            data-openbitfun-component="session-files-badge"
            data-openbitfun-part="reviewPopover"
            data-openbitfun-placement={reviewPopoverLayout?.placement ?? 'bottom'}
            style={{
              top: `${reviewPopoverLayout?.top ?? 0}px`,
              left: `${reviewPopoverLayout?.left ?? 0}px`,
              visibility: reviewPopoverLayout ? 'visible' : 'hidden',
            }}
          >
            {canLaunchReview && <MenuItem
              data-openbitfun-component="session-files-badge"
              data-openbitfun-part="reviewItem"
              onClick={handleReviewClick}
              type="button"
              disabled={areReviewMenuItemsDisabled}
              leading={<SearchCheck size={12} />}
            >
              <span>{t('sessionFilesBadge.reviewModeStandard')}</span>
            </MenuItem>}
            {quickActions.filter(a => a.enabled).length > 0 && (
              <MenuSeparator />
            )}

            {quickActions.filter(a => a.enabled).map(action => {
              const actionText = resolveQuickActionText(action, t);
              return (
                <MenuItem data-openbitfun-component="session-files-badge" data-openbitfun-part="reviewItem"
                  key={action.id}
                  onClick={() => { void handleQuickActionClick(action); }}
                  type="button"
                  disabled={isSessionProcessing}
                  leading={action.id === 'commit' ? (
                    <Icon name="commit" size="xs" />
                  ) : action.id === 'create_pr' ? (
                    <GitPullRequest size={12} />
                  ) : (
                    <Zap size={12} />
                  )}
                >
                  <span>{actionText.label}</span>
                </MenuItem>
              );
            })}
          </Menu>,
          getAppearanceOverlayHost(),
        )}
      </div>

      {showFileStatsSummary ? (
      <button
        ref={fileTriggerRef}
        className="session-files-badge__button"
        data-openbitfun-component="session-files-badge"
        data-openbitfun-part="trigger"
        data-openbitfun-state={isExpanded ? 'expanded' : undefined}
        onClick={() => {
          setIsExpanded((prev) => {
            const next = !prev;
            if (next) setIsReviewMenuOpen(false);
            return next;
          });
        }}
        disabled={loadingStats}
        type="button"
        title={fileChangeToggleHint}
        aria-label={
          isExpanded
            ? t('sessionFilesBadge.collapseFileDiffList')
            : fileChangeToggleAriaCollapsed
        }
        aria-expanded={isExpanded}
      >
        {totalStats.totalAdditions > 0 && (
          <span className="session-files-badge__stats session-files-badge__stats--add" data-openbitfun-component="session-files-badge" data-openbitfun-part="stats">
            +{totalStats.totalAdditions}
          </span>
        )}
        {totalStats.totalDeletions > 0 && (
          <span className="session-files-badge__stats session-files-badge__stats--del" data-openbitfun-component="session-files-badge" data-openbitfun-part="stats">
            -{totalStats.totalDeletions}
          </span>
        )}
        <Icon
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size="xs"
          className="session-files-badge__arrow"
        />
      </button>
      ) : null}

      {showFileStatsSummary && isExpanded && createOverlayPortal(
        <div
          ref={filePopoverRef}
          className="session-files-badge__popover"
          data-openbitfun-component="session-files-badge"
          data-openbitfun-part="popover"
          data-openbitfun-placement={filePopoverLayout?.placement ?? 'bottom'}
          style={{
            top: `${filePopoverLayout?.top ?? 0}px`,
            left: `${filePopoverLayout?.left ?? 0}px`,
            visibility: filePopoverLayout ? 'visible' : 'hidden',
          }}
        >
          <div className="session-files-badge__popover-summary" data-openbitfun-component="session-files-badge" data-openbitfun-part="summary">
            <OverflowText className="session-files-badge__popover-summary-count">
              {t('sessionFilesBadge.filesSummaryCount', {
                count: fileStats.size,
              })}
            </OverflowText>
            {(totalStats.totalAdditions > 0 || totalStats.totalDeletions > 0) && (
              <span className="session-files-badge__popover-summary-stats">
                {totalStats.totalAdditions > 0 && (
                  <span className="session-files-badge__stats session-files-badge__stats--add">
                    +{totalStats.totalAdditions}
                  </span>
                )}
                {totalStats.totalDeletions > 0 && (
                  <span className="session-files-badge__stats session-files-badge__stats--del">
                    -{totalStats.totalDeletions}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="session-files-badge__list" data-openbitfun-component="session-files-badge" data-openbitfun-part="list">
            {Array.from(fileStats.values()).map((stat) => (
              <div data-overflow-trigger
                key={stat.filePath}
                className={`session-files-badge__file-item session-files-badge__file-item--${stat.operationType} ${
                  stat.error ? 'session-files-badge__file-item--error' : ''
                }`}
                data-openbitfun-component="session-files-badge"
                data-openbitfun-part="file"
                data-openbitfun-operation={stat.operationType}
                data-openbitfun-state={stat.error ? 'error' : undefined}
                onClick={() => !stat.error && handleFileClick(stat.filePath)}
                title={stat.error ? stat.error : t('sessionFilesBadge.clickToViewDiff')}
              >
                <span className="session-files-badge__file-icon">
                  {getOperationIcon(stat.operationType)}
                </span>

                <OverflowText className="session-files-badge__file-name">{stat.fileName}</OverflowText>

                {stat.error ? (
                  <span className="session-files-badge__file-error" data-openbitfun-component="session-files-badge" data-openbitfun-part="fileError">{stat.error}</span>
                ) : (
                  <span className="session-files-badge__file-stats" data-openbitfun-component="session-files-badge" data-openbitfun-part="fileStats">
                    {stat.additions > 0 && (
                      <span className="session-files-badge__file-stat session-files-badge__file-stat--add">
                        +{stat.additions}
                      </span>
                    )}
                    {stat.deletions > 0 && (
                      <span className="session-files-badge__file-stat session-files-badge__file-stat--del">
                        -{stat.deletions}
                      </span>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>,
        getAppearanceOverlayHost(),
      )}
      </div>
      {deepReviewConsentDialog}
    </>
  );
};

SessionFilesBadge.displayName = 'SessionFilesBadge';
