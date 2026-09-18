/**
 * Session file modifications bar.
 * Shows modified files, with vertical list, auto expand/collapse, and cached stats.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FilePlus } from 'lucide-react';
import { OverflowText, Tooltip, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { useSnapshotState } from '../../../tools/snapshot_system/hooks/useSnapshotState';
import { createDiffEditorTab } from '../../../shared/utils/tabUtils';
import { snapshotAPI } from '../../../infrastructure/api';
import { useCurrentWorkspace } from '../../../infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { runWithConcurrencyLimit } from '@/shared/utils/runWithConcurrencyLimit';
import { sessionWorkspaceId } from '../../session-drivers/sessionFileNavigation';
import './SessionFileModificationsBar.scss';

const log = createLogger('SessionFileModificationsBar');

export interface SessionFileModificationsBarProps {
  /** Session ID. */
  sessionId?: string;
  /** Visible when there are messages. */
  visible: boolean;
  /** Whether the dialog is executing. */
  isExecuting?: boolean;
  /** Compact mode for narrow width. */
  compact?: boolean;
}

interface FileStats {
  filePath: string;
  sourceSessionId: string;
  sourceKind: 'parent' | 'review' | 'deep_review';
  fileName: string;
  additions: number;
  deletions: number;
  operationType: 'write' | 'edit' | 'delete';
  loading?: boolean;
  error?: string;
}

interface SourceFile {
  filePath: string;
  sourceSessionId: string;
  sourceKind: FileStats['sourceKind'];
}

interface StatsCache {
  [filePath: string]: {
    stats: FileStats;
    timestamp: number;
  };
}

/**
 * Session file modifications bar component.
 */
export const SessionFileModificationsBar: React.FC<SessionFileModificationsBarProps> = ({
  sessionId,
  visible,
  isExecuting = false,
  compact = false,
}) => {
  const { t } = useTranslation('flow-chat');
  const { files } = useSnapshotState(sessionId);
  const { workspace: currentWorkspace } = useCurrentWorkspace();

  const [isExpanded, setIsExpanded] = useState(false);
  const [fileStats, setFileStats] = useState<Map<string, FileStats>>(new Map());
  const [loadingStats, setLoadingStats] = useState(false);

  // Cache to avoid repeated requests for the same file.
  const statsCacheRef = useRef<StatsCache>({});
  const loadingFilesRef = useRef<Set<string>>(new Set());
  const activeSourceKeysRef = useRef<Set<string>>(new Set());
  const previousSessionIdRef = useRef<string | undefined>(undefined);
  const CACHE_TTL = 60000;
  /** Limit parallel Tauri IPC for diff stats so the webview stays responsive on large file lists. */
  const DIFF_STATS_MAX_CONCURRENCY = 3;

  const initializedRef = useRef(false);

  const sourceFiles = useMemo<SourceFile[]>(() => {
    return files.map((file): SourceFile => ({
      filePath: file.filePath,
      sourceSessionId: sessionId ?? '',
      sourceKind: 'parent',
    }));
  }, [files, sessionId]);

  useEffect(() => {
    const activeKeys = new Set(sourceFiles.map(file => `${file.sourceSessionId}:${file.filePath}`));
    activeSourceKeysRef.current = activeKeys;
    setFileStats(prev => {
      let changed = false;
      const next = new Map<string, FileStats>();
      prev.forEach((stat, key) => {
        if (activeKeys.has(key)) {
          next.set(key, stat);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    for (const sourceKey of Object.keys(statsCacheRef.current)) {
      if (!activeKeys.has(sourceKey)) {
        delete statsCacheRef.current[sourceKey];
      }
    }

    for (const sourceKey of Array.from(loadingFilesRef.current)) {
      if (!activeKeys.has(sourceKey)) {
        loadingFilesRef.current.delete(sourceKey);
      }
    }
  }, [sourceFiles]);


  useEffect(() => {
    if (!initializedRef.current && fileStats.size > 0) {
      initializedRef.current = true;
      setIsExpanded(!isExecuting);
    }
  }, [fileStats.size, isExecuting]);

  useEffect(() => {
    if (initializedRef.current) {
      if (!isExecuting && fileStats.size > 0) {
        setIsExpanded(true);
      }
    }
  }, [isExecuting, fileStats.size]);

  /**
   * Load diff stats for files with caching.
   */
  const loadFileStats = useCallback(async (filesToLoad: SourceFile[]) => {
    if (!sessionId || filesToLoad.length === 0) {
      return;
    }

    const sessionChanged = previousSessionIdRef.current !== sessionId;
    if (sessionChanged) {
      log.debug('Session changed, clearing old stats', {
        previousSession: previousSessionIdRef.current,
        currentSession: sessionId
      });
      previousSessionIdRef.current = sessionId;
      statsCacheRef.current = {};
      loadingFilesRef.current.clear();
      setFileStats(new Map());
    }

    const now = Date.now();

    const newFilesToLoad = filesToLoad.filter(file => {
      const sourceKey = `${file.sourceSessionId}:${file.filePath}`;
      if (loadingFilesRef.current.has(sourceKey)) {
        return false;
      }
      const cached = statsCacheRef.current[sourceKey];
      if (cached && now - cached.timestamp < CACHE_TTL) {
        if (!sessionChanged) {
          return false;
        }
      }
      return true;
    });

    if (newFilesToLoad.length === 0) {
      return;
    }

    log.debug('Loading file stats', { count: newFilesToLoad.length });

    setLoadingStats(true);

    try {
      newFilesToLoad.forEach(file => {
        loadingFilesRef.current.add(`${file.sourceSessionId}:${file.filePath}`);
      });

      const batchResults = await runWithConcurrencyLimit(
        newFilesToLoad,
        DIFF_STATS_MAX_CONCURRENCY,
        async (file) => {
          const sourceKey = `${file.sourceSessionId}:${file.filePath}`;
          let stats: FileStats | null = null;

          try {
            const statsResp = await snapshotAPI.getSessionFileDiffStats(
              file.sourceSessionId,
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
              sourceSessionId: file.sourceSessionId,
              sourceKind: file.sourceKind,
              fileName,
              additions,
              deletions,
              operationType,
            };

            if (activeSourceKeysRef.current.has(sourceKey)) {
              statsCacheRef.current[sourceKey] = {
                stats,
                timestamp: now,
              };
            }
          } catch (error) {
            log.warn('Failed to get file stats', { filePath: file.filePath, error });

            const fileName = file.filePath.split(/[/\\]/).pop() || file.filePath;
            stats = {
              filePath: file.filePath,
              sourceSessionId: file.sourceSessionId,
              sourceKind: file.sourceKind,
              fileName,
              additions: 0,
              deletions: 0,
              operationType: 'edit',
              error: t('sessionFilesBadge.loadFailed'),
            };
          } finally {
            loadingFilesRef.current.delete(sourceKey);
          }

          return { sourceKey, stats };
        },
      );

      setFileStats((prev) => {
        const newMap = new Map(prev);
        for (const { sourceKey, stats } of batchResults) {
          if (
            activeSourceKeysRef.current.has(sourceKey) &&
            stats &&
            (stats.additions > 0 || stats.deletions > 0 || stats.error)
          ) {
            newMap.set(sourceKey, stats);
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

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (sourceFiles.length > 0) {
        loadFileStats(sourceFiles);
      } else {
        setFileStats(new Map());
        statsCacheRef.current = {};
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [sourceFiles, loadFileStats]);

  const totalStats = useMemo(() => {
    let totalAdditions = 0;
    let totalDeletions = 0;

    fileStats.forEach((stat) => {
      totalAdditions += stat.additions;
      totalDeletions += stat.deletions;
    });

    return { totalAdditions, totalDeletions };
  }, [fileStats]);

  const handleFileClick = useCallback(async (stat: FileStats) => {
    if (!sessionId) return;

    try {
      const diffData = await snapshotAPI.getOperationDiff(stat.sourceSessionId, stat.filePath);
      if ((diffData.originalContent || '') === (diffData.modifiedContent || '')) {
        log.debug('Skipping empty session diff', { filePath: stat.filePath, sessionId: stat.sourceSessionId });
        return;
      }
      const fileName = stat.filePath.split(/[/\\]/).pop() || stat.filePath;

      window.dispatchEvent(new CustomEvent('expand-right-panel'));

      setTimeout(() => {
        createDiffEditorTab(
          stat.filePath,
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
    } catch (error) {
      log.error('Failed to open diff', error);
    }
  }, [sessionId, currentWorkspace?.rootPath, currentWorkspace?.id]);

  const getOperationIcon = (operationType: 'write' | 'edit' | 'delete') => {
    switch (operationType) {
      case 'write':
        return <FilePlus size={14} className="icon-write" />;
      case 'delete':
        return <Icon name="delete" size="sm" className="icon-delete" />;
      default:
        return <Icon name="edit" size="sm" className="icon-edit" />;
    }
  };

  if (!visible || !sessionId || fileStats.size === 0) {
    return null;
  }

  return (
    <div data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="root" data-openbitfun-layout={compact ? 'compact' : 'default'} data-openbitfun-state={isExpanded ? 'expanded' : undefined} className={`session-file-modifications-bar ${compact ? 'session-file-modifications-bar--compact' : ''}`}>
      <div data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="header" className="session-file-modifications-bar__header">
        <div data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="summary" className="header-info">
          <span className="file-count">{t('sessionFileModificationsBar.filesCount', { count: fileStats.size })}</span>
          <span className="total-stats">
            {totalStats.totalAdditions > 0 && (
              <span className="stat-add">+{totalStats.totalAdditions}</span>
            )}
            {totalStats.totalDeletions > 0 && (
              <span className="stat-del">-{totalStats.totalDeletions}</span>
            )}
          </span>
        </div>

        <Tooltip
          content={isExpanded ? t('sessionFileModificationsBar.collapseList') : t('sessionFileModificationsBar.expandList')}
          placement="top"
        >
          <button
            data-openbitfun-component="session-file-modifications-bar"
            data-openbitfun-part="toggle"
            className="expand-toggle-btn"
            onClick={() => setIsExpanded(!isExpanded)}
            disabled={loadingStats}
          >
            {isExpanded ? (
              <Icon name="chevron-up" size="md" />
            ) : (
              <Icon name="chevron-down" size="md" />
            )}
          </button>
        </Tooltip>
      </div>

      {isExpanded && (
        <div data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="list" className="session-file-modifications-bar__list">
          {Array.from(fileStats.values()).map((stat) => (
            <Tooltip key={`${stat.sourceSessionId}:${stat.filePath}`} content={stat.filePath} placement="left">
              <div data-overflow-trigger
                data-openbitfun-component="session-file-modifications-bar"
                data-openbitfun-part="file"
                data-openbitfun-operation={stat.operationType}
                data-openbitfun-state={stat.error ? 'error' : undefined}
                className={`file-row file-row--${stat.operationType} ${stat.error ? 'file-row--error' : ''}`}
                onClick={() => !stat.error && handleFileClick(stat)}
              >
                <span data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="fileIcon" className="file-row__icon">
                  {getOperationIcon(stat.operationType)}
                </span>

                <OverflowText data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="fileName" className="file-row__name">{stat.fileName}</OverflowText>
                {stat.sourceKind !== 'parent' ? (
                  <span data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="fileSource" className="file-row__source">
                    {stat.sourceKind === 'deep_review'
                      ? t('sessionFileModificationsBar.deepReviewSource')
                      : t('sessionFileModificationsBar.reviewSource')}
                  </span>
                ) : null}

                {stat.error ? (
                  <span data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="fileError" className="file-row__error">{stat.error}</span>
                ) : (
                  <span data-openbitfun-component="session-file-modifications-bar" data-openbitfun-part="fileStats" className="file-row__stats">
                    {stat.additions > 0 && (
                      <span className="stat-add">+{stat.additions}</span>
                    )}
                    {stat.deletions > 0 && (
                      <span className="stat-del">-{stat.deletions}</span>
                    )}
                  </span>
                )}
              </div>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
};

SessionFileModificationsBar.displayName = 'SessionFileModificationsBar';
