import { SegmentedControl } from '@openbitfun/ui';
import { FileText as LucideFileText } from 'lucide-react';
/**
 * Files panel component
 * Displays the file explorer for the current workspace
 */

import { OverflowText, Button, Icon, IconButton, SearchField, StatusPill, Tooltip, ScrollArea } from '@openbitfun/ui';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CaseSensitive, Regex, WholeWord, List, Loader2 } from 'lucide-react';
import {
  FileExplorer,
  getNewItemParentPath,
  useFileSystem,
  type FileExplorerToolbarHandlers,
} from '@/tools/file-system';
import { useExplorerSearch } from '@/tools/file-explorer';
import { planFileTreeReveal } from '@/tools/file-system/utils/fileTreeReveal';

import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { confirmWarning } from '@/infrastructure/confirm-dialog';
import { FileSearchResults } from '@/tools/file-system/components/FileSearchResults';
import { workspaceAPI } from '@/infrastructure/api';
import type { FileSystemNode, FileTreeRevealTarget } from '@/tools/file-system/types';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useNotification } from '@/shared/notification-system';
import { LoadingState } from '@openbitfun/ui';
import { InputDialog } from '@/app/components/InputDialog';
import { openFileInBestTarget } from '@/shared/utils/tabUtils';
import { PanelHeader } from './base';
import { createLogger } from '@/shared/utils/logger';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  basenamePath,
  normalizeLocalPathForRename,
  normalizeRemoteWorkspacePath,
  pathsEquivalentFs,
  replaceBasename,
} from '@/shared/utils/pathUtils';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import type {
  SearchMetadata,
  WorkspaceSearchRepoPhase,
} from '@/infrastructure/api/service-api/tauri-commands';
import {
  downloadWorkspaceFileToDisk,
  joinWorkspaceTargetPath,
  normalizeWorkspaceTargetDirectory,
  pasteClipboardFilesToWorkspaceDirectory,
  resolvePasteTargetDirectory,
  type TransferProgressState,
} from '@/tools/file-system/services/workspaceFileTransfer';
import { useWorkspaceFileDrop } from '@/tools/file-system/hooks/useWorkspaceFileDrop';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { sshApi } from '@/features/ssh-remote/sshApi';
import { formatBytes } from '@/shared/utils/format';
import '@/tools/file-system/styles/FileExplorer.scss';
import './FilesPanel.scss';

const log = createLogger('FilesPanel');
const FOCUS_REFRESH_THROTTLE_MS = 1000;
const REMOTE_REFRESH_POLL_MS = 15000;
const LARGE_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** Format a byte-per-second speed value for display, e.g. "1.4 MB/s". */
function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function getIndexPhaseBadgeVariant(phase?: WorkspaceSearchRepoPhase): 'neutral' | 'warning' | 'success' | 'danger' | 'info' {
  switch (phase) {
    case 'ready':
      return 'success';
    case 'tracking_changes':
      return 'info';
    case 'needs_index':
      return 'warning';
    case 'building':
    case 'refreshing':
    case 'preparing':
      return 'info';
    case 'limited':
      return 'danger';
    default:
      return 'neutral';
  }
}

function getSearchBackendBadgeVariant(
  metadata: SearchMetadata | null
): 'neutral' | 'success' | 'warning' | 'info' {
  switch (metadata?.backend) {
    case 'indexed':
    case 'indexed_workspace':
      return 'success';
    case 'text_fallback':
    case 'scan_fallback':
      return 'warning';
    default:
      return 'neutral';
  }
}

interface FilesPanelProps {
  workspace?: WorkspaceInfo | null;
  workspacePath?: string;
  searchStateKey?: string;
  onFileSelect?: (filePath: string, fileName: string) => void;
  onFileDoubleClick?: (filePath: string) => void;
  hideHeader?: boolean;
  viewMode?: 'tree' | 'search';
  onViewModeChange?: (mode: 'tree' | 'search') => void;
  /** Hide the in-explorer floating toolbar; parent can render equivalent actions (e.g. file viewer nav header). */
  hideExplorerToolbar?: boolean;
  onExplorerToolbarApi?: (api: FileExplorerToolbarHandlers | null) => void;
}

const FilesPanel: React.FC<FilesPanelProps> = ({
  workspace: targetWorkspace,
  workspacePath,
  searchStateKey,
  onFileSelect,
  onFileDoubleClick,
  hideHeader = false,
  viewMode: externalViewMode,
  onViewModeChange,
  hideExplorerToolbar = false,
  onExplorerToolbarApi,
}) => {
  const { t } = useTranslation('panels/files');
  const { t: tComponents } = useI18n('components');
  const { workspace: activeWorkspace } = useCurrentWorkspace();
  const currentWorkspace = targetWorkspace === undefined ? activeWorkspace : targetWorkspace;
  const surface = getActiveSurfaceScope();
  // Identity is (surface, workspace ID). The path and connection are IO
  // projections that downstream openers still record for legacy tab data.
  const currentWorkspaceId = currentWorkspace?.id;
  const resourceScope = useMemo(() => ({
    surfaceId: surface.surfaceId, workspaceId: currentWorkspaceId,
    workspacePath, remoteConnectionId: currentWorkspace?.connectionId,
  }), [surface.surfaceId, currentWorkspaceId, currentWorkspace?.connectionId, workspacePath]);
  
  const panelRef = useRef<HTMLDivElement>(null);
  const navigationRequestRef = useRef(0);
  const [revealTarget, setRevealTarget] = useState<FileTreeRevealTarget>();
  useEffect(() => {
    navigationRequestRef.current += 1;
    setRevealTarget(undefined);
    return () => { navigationRequestRef.current += 1; };
  }, [currentWorkspaceId]);
  const lastFocusRefreshAtRef = useRef<number>(0);
  const [internalViewMode, setInternalViewMode] = useState<'tree' | 'search'>('tree');
  const viewMode = externalViewMode !== undefined ? externalViewMode : internalViewMode;
  const isRemoteCurrentWorkspace = Boolean(
    currentWorkspace && isRemoteWorkspace(currentWorkspace)
  );
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    searchMode,
    setSearchMode,
    allGroups: searchResults,
    isSearching,
    error: searchError,
    filenameLimit,
    contentLimit,
    filenameTruncated,
    contentTruncated,
    contentSearchMetadata,
    searchOptions,
    setSearchOptions,
    clearSearch,
  } = useExplorerSearch({
    workspaceId: currentWorkspace?.id,
    stateKey: searchStateKey,
    initialMode: 'content',
    filenameSearchDebounce: 300,
    contentSearchDebounce: 300,
    minFilenameLength: 1,
    minContentLength: 2,
    filenameMaxResults: 500,
    contentMaxResults: 1000,
  });

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Map<string, TransferProgressState>>(new Map());
  const dropTransferIdRef = useRef<string | null>(null);
  const [fileDropHighlight, setFileDropHighlight] = useState(false);
  const [inputDialog, setInputDialog] = useState<{
    isOpen: boolean;
    type: 'newFile' | 'newFolder' | null;
    parentPath: string;
  }>({
    isOpen: false,
    type: null,
    parentPath: '',
  });

  const notification = useNotification();
  const cancelledTransferIdsRef = useRef<Set<string>>(new Set());

  /**
   * Create a per-transfer onProgress callback that tracks a single transfer
   * in the `transfers` Map by its unique ID. When `null` is received, the
   * transfer is removed from the Map. Returns both the ID (for passing to
   * the backend for cancellation) and the callback.
   */
  const createTransferProgress = useCallback(() => {
    const id = crypto.randomUUID();
    const onProgress = (state: TransferProgressState | null) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        if (state === null) {
          next.delete(id);
        } else {
          next.set(id, state);
        }
        return next;
      });
    };
    return { id, onProgress };
  }, []);

  /** Stop an in-progress transfer by its ID. */
  const handleStopTransfer = useCallback((transferId: string) => {
    cancelledTransferIdsRef.current.add(transferId);
    void sshApi.cancelTransfer(transferId);
    setTransfers((prev) => {
      const next = new Map(prev);
      next.delete(transferId);
      return next;
    });
  }, []);

  /**
   * Stable callback for drag-and-drop file uploads. Uses a ref to track the
   * current drop's transfer ID so each drop session gets its own entry in the
   * `transfers` Map.
   */
  const handleDropProgress = useCallback((state: TransferProgressState | null) => {
    setTransfers((prev) => {
      const next = new Map(prev);
      if (state === null) {
        const id = dropTransferIdRef.current;
        if (id) {
          next.delete(id);
          dropTransferIdRef.current = null;
        }
      } else {
        if (!dropTransferIdRef.current) {
          dropTransferIdRef.current = crypto.randomUUID();
        }
        next.set(dropTransferIdRef.current, state);
      }
      return next;
    });
  }, []);

  const searchLimitNotice =
    searchMode === 'content'
      ? contentTruncated
        ? t('search.limitReachedContent', { count: contentLimit })
        : null
      : filenameTruncated
        ? t('search.limitReachedFiles', { count: filenameLimit })
        : null;
  const contentSearchBackendLabel = contentSearchMetadata
    ? t(`search.backend.${contentSearchMetadata.backend}`, {
        defaultValue: contentSearchMetadata.backend,
      })
    : null;
  const showContentSearchMetadata =
    searchMode === 'content' && Boolean(searchQuery.trim()) && Boolean(contentSearchMetadata);

  const {
    fileTree,
    selectedFile,
    expandedFolders,
    loadingPaths,
    loading,
    error,
    loadFileTree,
    selectFile,
    expandFolder,
    expandFolderLazy,
    expandFolderEnsure,
    removePath,
  } = useFileSystem({
    workspaceId: currentWorkspace?.id,
    rootPath: workspacePath,
    remoteConnectionId: currentWorkspace?.connectionId,
    autoLoad: true,
    enablePathCompression: true,
    showHiddenFiles: true,
    // Local filesystem watchers are unavailable for remote SSH workspaces.
    enableAutoWatch: !isRemoteCurrentWorkspace,
  });
  const handleNodeExpandLazy = useCallback((path: string) => {
    expandFolderLazy(path);
  }, [expandFolderLazy]);

  const prevWorkspaceIdRef = useRef<string | undefined>(currentWorkspace?.id);
  useEffect(() => {
    if (prevWorkspaceIdRef.current !== undefined && prevWorkspaceIdRef.current !== currentWorkspace?.id) {
      log.debug('Workspace ID changed, clearing local state', {
        from: prevWorkspaceIdRef.current,
        to: currentWorkspace?.id
      });
      
      clearSearch();
      setRenamingPath(null);
      setInputDialog({
        isOpen: false,
        type: null,
        parentPath: '',
      });
      if (onViewModeChange) {
        onViewModeChange('tree');
      } else {
        setInternalViewMode('tree');
      }
    }
    prevWorkspaceIdRef.current = currentWorkspace?.id;
  }, [currentWorkspace?.id, clearSearch, onViewModeChange]);

  const normalizePathForCurrentWorkspace = useCallback(
    (path: string) =>
      isRemoteCurrentWorkspace
        ? normalizeRemoteWorkspacePath(path)
        : normalizeLocalPathForRename(path),
    [isRemoteCurrentWorkspace]
  );

  // ===== File Operation Handlers =====

  const shouldOpenLargeFile = useCallback(async (filePath: string, nodeSize?: number): Promise<boolean> => {
    let fileSize: number | undefined = nodeSize;

    if (fileSize === undefined || fileSize === null) {
      try {
        if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
        const metadata = await workspaceAPI.getWorkspaceFileMetadata(currentWorkspaceId, filePath);
        fileSize = metadata.size;
      } catch (error) {
        log.warn('Failed to get file metadata for size check, opening anyway', { filePath, error: String(error) });
        return true;
      }
    }

    if (fileSize === undefined || fileSize <= LARGE_FILE_THRESHOLD_BYTES) {
      return true;
    }

    return confirmWarning(
      t('dialog.largeFile.title'),
      t('dialog.largeFile.message', { size: formatBytes(fileSize) }),
      {
        confirmText: t('dialog.largeFile.confirm'),
        cancelText: t('dialog.largeFile.cancel'),
      },
    );
  }, [t, currentWorkspaceId]);

  const handleOpenFile = useCallback((data: { path: string; line?: number; column?: number }) => {
    log.info('Opening file', { path: data.path, line: data.line, column: data.column });

    const request = navigationRequestRef.current;
    void shouldOpenLargeFile(data.path).then((ok) => {
      if (!ok || !surface.isCurrent() || request !== navigationRequestRef.current) return;
      openFileInBestTarget({
        filePath: data.path,
        scope: resourceScope,
        workspacePath,
        ...(data.line ? { jumpToLine: data.line } : {}),
        ...(data.column ? { jumpToColumn: data.column } : {}),
      }, { source: 'project-nav' });
    });
  }, [workspacePath, shouldOpenLargeFile, surface, resourceScope]);

  const handleNewFile = useCallback((data: { parentPath: string }) => {
    setInputDialog({
      isOpen: true,
      type: 'newFile',
      parentPath: data.parentPath,
    });
  }, []);

  const handleInputDialogClose = useCallback(() => {
    setInputDialog({
      isOpen: false,
      type: null,
      parentPath: '',
    });
  }, []);

  const handleConfirmNewFile = useCallback(async (fileName: string) => {
    const filePath = joinWorkspaceTargetPath(
      inputDialog.parentPath,
      fileName,
      isRemoteWorkspace(currentWorkspace),
    );
    
    try {
      if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
      await workspaceAPI.createWorkspaceFile(currentWorkspaceId, filePath);
      log.info('File created', { path: filePath });
      handleInputDialogClose();
      loadFileTree(workspacePath || '', true);
    } catch (error) {
      log.error('Failed to create file', error);
      notification.error(t('notifications.createFileFailed', { error: String(error) }));
    }
  }, [inputDialog.parentPath, workspacePath, loadFileTree, notification, t, handleInputDialogClose, currentWorkspace, currentWorkspaceId]);

  const handleNewFolder = useCallback((data: { parentPath: string }) => {
    setInputDialog({
      isOpen: true,
      type: 'newFolder',
      parentPath: data.parentPath,
    });
  }, []);

  const handleConfirmNewFolder = useCallback(async (folderName: string) => {
    const folderPath = joinWorkspaceTargetPath(
      inputDialog.parentPath,
      folderName,
      isRemoteWorkspace(currentWorkspace),
    );
    
    try {
      if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
      await workspaceAPI.createWorkspaceDirectory(currentWorkspaceId, folderPath);
      log.info('Directory created', { path: folderPath });
      handleInputDialogClose();
      loadFileTree(workspacePath || '', true);
    } catch (error) {
      log.error('Failed to create directory', error);
      notification.error(t('notifications.createFolderFailed', { error: String(error) }));
    }
  }, [inputDialog.parentPath, workspacePath, loadFileTree, notification, t, handleInputDialogClose, currentWorkspace, currentWorkspaceId]);

  const handleInputDialogConfirm = useCallback((value: string) => {
    if (inputDialog.type === 'newFile') {
      handleConfirmNewFile(value);
    } else if (inputDialog.type === 'newFolder') {
      handleConfirmNewFolder(value);
    }
  }, [inputDialog.type, handleConfirmNewFile, handleConfirmNewFolder]);

  const handleStartRename = useCallback((data: { path: string; name: string }) => {
    setRenamingPath(normalizePathForCurrentWorkspace(data.path));
  }, [normalizePathForCurrentWorkspace]);

  const handleExecuteRename = useCallback(async (oldPath: string, newName: string) => {
    const normalizedOld = normalizePathForCurrentWorkspace(oldPath);
    const oldName = basenamePath(normalizedOld);

    if (newName.trim() === oldName) {
      setRenamingPath(null);
      return;
    }

    const newPath = replaceBasename(normalizedOld, newName.trim());

    try {
      if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
      await workspaceAPI.renameWorkspaceFile(currentWorkspaceId, normalizedOld, newPath);
      log.info('File renamed', { oldPath: normalizedOld, newPath });
      setRenamingPath(null);
      removePath(normalizedOld);
      await loadFileTree(workspacePath || '', true);
    } catch (error) {
      log.error('Failed to rename file', error);
      notification.error(t('notifications.renameFailed', { error: String(error) }));
      setRenamingPath(null);
    }
  }, [workspacePath, loadFileTree, removePath, notification, t, normalizePathForCurrentWorkspace, currentWorkspaceId]);

  const handleCancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleDelete = useCallback(async (data: { path: string; isDirectory: boolean }) => {
    const normalizedPath = normalizePathForCurrentWorkspace(data.path);

    try {
      if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
      if (data.isDirectory) {
        await workspaceAPI.deleteWorkspaceDirectory(currentWorkspaceId, normalizedPath, true);
      } else {
        await workspaceAPI.deleteWorkspaceFile(currentWorkspaceId, normalizedPath);
      }
      log.info('File deleted', { path: normalizedPath, isDirectory: data.isDirectory });
      removePath(normalizedPath);
      await loadFileTree(workspacePath || '', true);
    } catch (error) {
      log.error('Failed to delete file', error);
      notification.error(t('notifications.deleteFailed', { error: String(error) }));
    }
  }, [workspacePath, loadFileTree, removePath, notification, t, normalizePathForCurrentWorkspace, currentWorkspaceId]);

  const handleFileDownload = useCallback(
    async (data: { path: string; isDirectory?: boolean }) => {
      const { id, onProgress } = createTransferProgress();
      try {
        await downloadWorkspaceFileToDisk(
          data.path,
          currentWorkspace,
          onProgress,
          id,
          data.isDirectory,
        );
      } catch (error) {
        log.error('Failed to download file', error);
        onProgress(null);
        if (cancelledTransferIdsRef.current.has(id)) {
          cancelledTransferIdsRef.current.delete(id);
        } else {
          notification.error(t('transfer.failed', { error: String(error) }));
        }
      }
    },
    [notification, t, createTransferProgress, currentWorkspace]
  );

  const handleCompress = useCallback(
    async (data: { path: string; isDirectory?: boolean }) => {
      try {
        if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
        await workspaceAPI.compressWorkspacePath(currentWorkspaceId, data.path);
        notification.success(
          t('archive.compressSuccess', { name: data.path.split(/[/\\]/).pop() || '' }),
        );
        loadFileTree(undefined, true);
      } catch (error) {
        log.error('Failed to compress', error);
        const reason = error instanceof Error ? error.message : String(error);
        notification.error(t('archive.compressFailed', { error: reason }));
      }
    },
    [notification, t, loadFileTree, currentWorkspaceId],
  );

  const handleDecompress = useCallback(
    async (data: { path: string }) => {
      try {
        if (!currentWorkspaceId) throw new Error('Workspace ID is unavailable');
        await workspaceAPI.decompressWorkspacePath(currentWorkspaceId, data.path);
        notification.success(
          t('archive.decompressSuccess', { name: data.path.split(/[/\\]/).pop() || '' }),
        );
        loadFileTree(undefined, true);
      } catch (error) {
        log.error('Failed to decompress', error);
        const reason = error instanceof Error ? error.message : String(error);
        notification.error(t('archive.decompressFailed', { error: reason }));
      }
    },
    [notification, t, loadFileTree, currentWorkspaceId],
  );

  const handleFileTreeRefresh = useCallback(() => {
    loadFileTree(undefined, true);
  }, [loadFileTree]);

  const triggerFocusCompensatingRefresh = useCallback((reason: 'windowFocus' | 'visibilityVisible') => {
    if (!workspacePath || viewMode !== 'tree') {
      return;
    }

    // Peer Mode relies on file-watch / DeviceEvent fan-out; focus refreshes flood HostInvoke.
    if (isPeerDeviceModeActive()) {
      return;
    }

    const panelEl = panelRef.current;
    if (!panelEl || panelEl.getClientRects().length === 0) {
      return;
    }

    const now = Date.now();
    if (now - lastFocusRefreshAtRef.current < FOCUS_REFRESH_THROTTLE_MS) {
      return;
    }

    lastFocusRefreshAtRef.current = now;
    log.debug('Compensating file tree refresh after focus/visibility', {
      reason,
      workspacePath,
    });
    void loadFileTree(undefined, true);
  }, [workspacePath, viewMode, loadFileTree]);

  const handleNavigateToPath = useCallback((data: { path: string; scrollIntoView?: boolean }) => {
    if (!data.path || !workspacePath) {
      return;
    }

    log.debug('Navigating to path', { path: data.path, scrollIntoView: data.scrollIntoView });

    const plan = planFileTreeReveal(workspacePath, data.path, isRemoteCurrentWorkspace);
    if (!plan) return;
    const scope = getActiveSurfaceScope();
    const request = ++navigationRequestRef.current;
    const isCurrent = () => scope.isCurrent() && request === navigationRequestRef.current;

    void (async () => {
      for (const expandPath of plan.pathsToExpand) {
        if (!isCurrent()) return;
        try {
          await expandFolderEnsure(expandPath);
        } catch (err) {
          log.warn('Failed to expand path during navigation', { expandPath, err });
          break;
        }
      }
      if (!isCurrent()) return;
      selectFile(plan.targetPath);
      if (data.scrollIntoView) setRevealTarget({ path: plan.targetPath, requestId: request });
    })();
  }, [workspacePath, isRemoteCurrentWorkspace, expandFolderEnsure, selectFile]);

  const findNode = useCallback((nodes: FileSystemNode[], path: string): FileSystemNode | null => {
    for (const node of nodes) {
      if (pathsEquivalentFs(node.path, path)) return node;
      if (node.children) {
        const found = findNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }, []);

  const executePaste = useCallback(async (targetDir?: string) => {
    if (!workspacePath) {
      notification.warning(t('notifications.selectWorkspaceFirst'));
      return;
    }

    if (!currentWorkspace) {
      notification.warning(t('notifications.selectWorkspaceFirst'));
      return;
    }

    const { id, onProgress } = createTransferProgress();
    try {
      let targetDirectory = resolvePasteTargetDirectory({
        workspacePath,
        explicitTargetDir: targetDir,
        selectedFile,
        fileTree,
        findNode,
      });

      targetDirectory = normalizeWorkspaceTargetDirectory(targetDirectory, currentWorkspace);

      notification.info(
        t('notifications.pastingFiles', {
          count: 1,
          target: targetDirectory.split(/[/\\]/).pop(),
        })
      );

      const result = await pasteClipboardFilesToWorkspaceDirectory(
        targetDirectory,
        currentWorkspace,
        onProgress,
        id
      );

      if (result.successCount === 0 && result.failedFiles.length === 0) {
        notification.info(t('notifications.pasteNoFiles'));
        return;
      }

      if (result.successCount > 0) {
        const dirCount = result.directoryCount ?? 0;
        let key: string;
        if (dirCount === 0) {
          key = 'notifications.pasteSuccessFiles';
        } else if (dirCount === result.successCount) {
          key = 'notifications.pasteSuccessFolders';
        } else {
          key = 'notifications.pasteSuccessItems';
        }
        notification.success(t(key, { count: result.successCount }));
        await loadFileTree(undefined, true);

        if (!pathsEquivalentFs(targetDirectory, workspacePath)) {
          expandFolder(targetDirectory, true);
        }
      }

      if (result.failedFiles.length > 0) {
        const failedNames = result.failedFiles.map((entry) => {
          const name = entry.path.split(/[/\\]/).pop() || entry.path;
          return `${name}: ${entry.error}`;
        }).join('\n');
        notification.error(
          t('notifications.pasteFailed', { count: result.failedFiles.length }) + `:\n${failedNames}`,
          { duration: 5000 }
        );
      }
    } catch (error) {
      log.error('Failed to paste files', error);
      onProgress(null);
      if (cancelledTransferIdsRef.current.has(id)) {
        cancelledTransferIdsRef.current.delete(id);
      } else {
        notification.error(t('notifications.pasteFailed', { count: 1 }));
      }
    }
  }, [
    workspacePath,
    currentWorkspace,
    selectedFile,
    fileTree,
    notification,
    loadFileTree,
    expandFolder,
    findNode,
    t,
    createTransferProgress,
  ]);

  const handlePasteFromContextMenu = useCallback((data: { targetDirectory: string }) => {
    executePaste(data.targetDirectory);
  }, [executePaste]);

  const handlePaste = useCallback(() => {
    executePaste();
  }, [executePaste]);

  // Register paste as a filetree-scoped shortcut (Windows/Linux primary path).
  useShortcut(
    'filetree.paste',
    { key: 'V', ctrl: true, scope: 'filetree' },
    () => handlePaste(),
    { enabled: Boolean(workspacePath) }
  );

  // macOS bridge: the native menu bar intercepts Cmd+V before the DOM sees a
  // keydown event, so ShortcutManager never fires. In "System" edit-menu mode
  // (the default when no text editor is focused) the menu tells the WebView to
  // perform a native paste, which surfaces as a DOM `paste` event. In
  // "Renderer" mode (when a Monaco editor was recently focused) the menu emits
  // a Tauri `openbitfun_menu_edit_paste` event. We listen to both so file-tree
  // paste works regardless of which mode the menu is in.
  useEffect(() => {
    if (!workspacePath) return;

    const isPanelFocused = () => {
      const el = document.activeElement;
      return !!el && !!panelRef.current && panelRef.current.contains(el);
    };

    // DOM paste event — System menu mode path.
    const handleDomPaste = (e: ClipboardEvent) => {
      if (!isPanelFocused()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handlePaste();
    };
    document.addEventListener('paste', handleDomPaste, true);

    // Tauri menu event — Renderer menu mode path.
    let unlistenTauri: (() => void) | null = null;
    let cancelled = false;
    if (typeof window !== 'undefined' && '__TAURI__' in window) {
      (async () => {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          const unsubscribe = await listen('openbitfun_menu_edit_paste', () => {
            if (isPanelFocused()) {
              handlePaste();
            }
          });
          if (cancelled) {
            unsubscribe();
            return;
          }
          unlistenTauri = unsubscribe;
        } catch {
          // Non-Tauri environment or event module unavailable — ignore.
        }
      })();
    }

    return () => {
      cancelled = true;
      document.removeEventListener('paste', handleDomPaste, true);
      unlistenTauri?.();
    };
  }, [workspacePath, handlePaste]);

  useEffect(() => {
    globalEventBus.on('file:open', handleOpenFile);
    globalEventBus.on('file:new-file', handleNewFile);
    globalEventBus.on('file:new-folder', handleNewFolder);
    globalEventBus.on('file:rename', handleStartRename);
    globalEventBus.on('file:delete', handleDelete);
    globalEventBus.on('file:download', handleFileDownload);
    globalEventBus.on('file:compress', handleCompress);
    globalEventBus.on('file:decompress', handleDecompress);
    globalEventBus.on('file:paste', handlePasteFromContextMenu);
    globalEventBus.on('file-tree:refresh', handleFileTreeRefresh);
    globalEventBus.on('file-explorer:navigate', handleNavigateToPath);

    return () => {
      globalEventBus.off('file:open', handleOpenFile);
      globalEventBus.off('file:new-file', handleNewFile);
      globalEventBus.off('file:new-folder', handleNewFolder);
      globalEventBus.off('file:rename', handleStartRename);
      globalEventBus.off('file:delete', handleDelete);
      globalEventBus.off('file:download', handleFileDownload);
      globalEventBus.off('file:compress', handleCompress);
      globalEventBus.off('file:decompress', handleDecompress);
      globalEventBus.off('file:paste', handlePasteFromContextMenu);
      globalEventBus.off('file-tree:refresh', handleFileTreeRefresh);
      globalEventBus.off('file-explorer:navigate', handleNavigateToPath);
    };
  }, [handleOpenFile, handleNewFile, handleNewFolder, handleStartRename, handleDelete, handleFileDownload, handleCompress, handleDecompress, handlePasteFromContextMenu, handleFileTreeRefresh, handleNavigateToPath]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleWindowFocus = () => {
      triggerFocusCompensatingRefresh('windowFocus');
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerFocusCompensatingRefresh('visibilityVisible');
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [triggerFocusCompensatingRefresh]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!isRemoteCurrentWorkspace || !workspacePath || viewMode !== 'tree') {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      const panelEl = panelRef.current;
      if (!panelEl || panelEl.getClientRects().length === 0) {
        return;
      }

      log.debug('Polling remote file tree refresh', { workspacePath });
      void loadFileTree(undefined, true);
    }, REMOTE_REFRESH_POLL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRemoteCurrentWorkspace, workspacePath, viewMode, loadFileTree]);

  const handleFileDropOver = useCallback((overPanel: boolean) => {
    setFileDropHighlight(overPanel);
  }, []);

  const handleFileDropComplete = useCallback((targetDirectory: string) => {
    setFileDropHighlight(false);
    void loadFileTree(workspacePath || '', true);
    if (workspacePath && !pathsEquivalentFs(targetDirectory, workspacePath)) {
      expandFolder(targetDirectory, true);
    }
  }, [workspacePath, loadFileTree, expandFolder]);

  const handleFileDropError = useCallback((error: unknown) => {
    handleDropProgress(null);
    setFileDropHighlight(false);
    notification.error(t('transfer.failed', { error: String(error) }));
  }, [notification, t, handleDropProgress]);

  useWorkspaceFileDrop({
    workspace: currentWorkspace,
    workspacePath,
    panelRef,
    enabled: Boolean(workspacePath) && viewMode === 'tree',
    onProgress: handleDropProgress,
    onDragOver: handleFileDropOver,
    onComplete: handleFileDropComplete,
    onError: handleFileDropError,
  });

  const handleFileSelect = useCallback((filePath: string, fileName: string) => {
    selectFile(filePath);
    onFileSelect?.(filePath, fileName);
    
    const selectedNode = findNode(fileTree, filePath);
    if (selectedNode && !selectedNode.isDirectory) {
      const request = navigationRequestRef.current;
      void shouldOpenLargeFile(filePath, selectedNode.size).then((ok) => {
        if (!ok || !surface.isCurrent() || request !== navigationRequestRef.current) return;
        openFileInBestTarget({
          filePath,
          fileName,
          workspacePath,
          scope: resourceScope,
        }, { source: 'project-nav' });
      });
    }
  }, [selectFile, onFileSelect, workspacePath, fileTree, findNode, shouldOpenLargeFile, surface, resourceScope]);

  const handleFileDoubleClick = useCallback((filePath: string) => {
    onFileDoubleClick?.(filePath);
  }, [onFileDoubleClick]);

  const handleSearchResultSelect = useCallback((filePath: string, fileName: string) => {
    selectFile(filePath);
    onFileSelect?.(filePath, fileName);
  }, [selectFile, onFileSelect]);

  const handleSearchFolderNavigate = useCallback((folderPath: string, _folderName: string) => {
    if (onViewModeChange) {
      onViewModeChange('tree');
    } else {
      setInternalViewMode('tree');
    }
    selectFile(folderPath);
    setTimeout(() => {
      handleNavigateToPath({ path: folderPath, scrollIntoView: true });
    }, 0);
  }, [onViewModeChange, selectFile, handleNavigateToPath]);

  const handleClearSearch = useCallback(() => {
    clearSearch();
  }, [clearSearch]);

  const handleToggleViewMode = useCallback(() => {
    const next = viewMode === 'tree' ? 'search' : 'tree';
    if (onViewModeChange) {
      onViewModeChange(next);
    } else {
      setInternalViewMode(next);
    }
  }, [viewMode, onViewModeChange]);

  const handleExplorerToolbarNewFile = useCallback(() => {
    const parentPath = getNewItemParentPath(workspacePath, selectedFile, fileTree);
    if (parentPath) {
      handleNewFile({ parentPath });
    }
  }, [workspacePath, selectedFile, fileTree, handleNewFile]);

  const handleExplorerToolbarNewFolder = useCallback(() => {
    const parentPath = getNewItemParentPath(workspacePath, selectedFile, fileTree);
    if (parentPath) {
      handleNewFolder({ parentPath });
    }
  }, [workspacePath, selectedFile, fileTree, handleNewFolder]);

  const handleExplorerToolbarRefresh = useCallback(() => {
    loadFileTree(workspacePath || '', false);
  }, [loadFileTree, workspacePath]);

  const explorerToolbarApi = React.useMemo<FileExplorerToolbarHandlers | null>(() => {
    if (!workspacePath || viewMode !== 'tree') {
      return null;
    }

    return {
      onNewFile: handleExplorerToolbarNewFile,
      onNewFolder: handleExplorerToolbarNewFolder,
      onRefresh: handleExplorerToolbarRefresh,
    };
  }, [
    workspacePath,
    viewMode,
    handleExplorerToolbarNewFile,
    handleExplorerToolbarNewFolder,
    handleExplorerToolbarRefresh,
  ]);

  useEffect(() => {
    if (!onExplorerToolbarApi) return;
    onExplorerToolbarApi(hideExplorerToolbar ? explorerToolbarApi : null);
  }, [
    onExplorerToolbarApi,
    hideExplorerToolbar,
    explorerToolbarApi,
  ]);

  useEffect(() => {
    if (!onExplorerToolbarApi) return;
    return () => onExplorerToolbarApi(null);
  }, [onExplorerToolbarApi]);

  return (
    <div data-overflow-trigger
      data-openbitfun-component="files-panel"
      data-openbitfun-part="root"
      ref={panelRef}
      data-resource-surface={resourceScope.surfaceId}
      data-resource-workspace-id={resourceScope.workspaceId}
      data-resource-workspace-path={resourceScope.workspacePath}
      data-resource-connection-id={resourceScope.remoteConnectionId}
      className="openbitfun-files-panel"
      tabIndex={-1}
      onFocus={() => {}}
    >
      {!hideHeader && (
        <PanelHeader
          title={t('title')}
          className="openbitfun-files-panel__header"
          actions={
            workspacePath && (
              <Tooltip content={viewMode === 'tree' ? t('actions.switchToSearch') : t('actions.switchToTree')} placement="bottom">
                <IconButton
                  aria-label={viewMode === 'tree' ? t('actions.switchToSearch') : t('actions.switchToTree')}
                  size="sm"
                  onClick={handleToggleViewMode}
                  icon={viewMode === 'tree' ? <Icon name="search" size="sm" /> : <List size={14} />}
                />
              </Tooltip>
            )
          }
        />
      )}
      
      <div className="openbitfun-files-panel__content" data-openbitfun-component="files-panel" data-openbitfun-part="content">
        {workspacePath && viewMode === 'search' && (
          <div className="openbitfun-files-panel__search" data-openbitfun-component="files-panel" data-openbitfun-part="search" data-openbitfun-search-mode={searchMode}>
            <SearchField
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              value={searchQuery}
              onValueChange={(val) => setSearchQuery(val)}
              clearLabel={searchQuery ? tComponents('search.clear') : undefined}
              onClear={searchQuery ? handleClearSearch : undefined}
              size="sm"
              leadingIcon={isSearching
                ? <Loader2 className="openbitfun-files-panel__search-spinner" size={14} aria-hidden />
                : <Icon name="search" size="sm" aria-hidden />}
            />
            <div className="openbitfun-files-panel__search-toolbar" data-openbitfun-component="files-panel" data-openbitfun-part="searchToolbar">
              <SegmentedControl
                className="openbitfun-files-panel__search-modes"
                interaction="buttons"
                labelBehavior="static"
                aria-label={t('search.placeholder')}
                value={searchMode}
                onValueChange={value => setSearchMode(value as 'content' | 'filenames')}
                options={[
                  { value: 'content', label: t('search.modeContent') },
                  { value: 'filenames', label: t('search.modeFiles') },
                ]}
              />
              <div className="openbitfun-files-panel__search-options">
                <Tooltip content={t('options.caseSensitive')}>
                  <IconButton
                    type="button"
                    className={`openbitfun-files-panel__search-option ${searchOptions.caseSensitive ? 'active' : ''}`}
                    onClick={() => setSearchOptions(prev => ({ ...prev, caseSensitive: !prev.caseSensitive }))}
                    aria-label={t('options.caseSensitive')}
                    icon={<CaseSensitive size={14} />}
                  />
                </Tooltip>
                <Tooltip content={t('options.wholeWord')}>
                  <IconButton
                    type="button"
                    className={`openbitfun-files-panel__search-option ${searchOptions.wholeWord ? 'active' : ''}`}
                    onClick={() => setSearchOptions(prev => ({ ...prev, wholeWord: !prev.wholeWord }))}
                    aria-label={t('options.wholeWord')}
                    icon={<WholeWord size={14} />}
                  />
                </Tooltip>
                <Tooltip content={t('options.useRegex')}>
                  <IconButton
                    type="button"
                    className={`openbitfun-files-panel__search-option ${searchOptions.useRegex ? 'active' : ''}`}
                    onClick={() => setSearchOptions(prev => ({ ...prev, useRegex: !prev.useRegex }))}
                    aria-label={t('options.useRegex')}
                    icon={<Regex size={14} />}
                  />
                </Tooltip>
              </div>
            </div>
          </div>
        )}

        <div
          className={`openbitfun-files-panel__main-content${
            fileDropHighlight ? ' openbitfun-files-panel__main-content--drop-target' : ''
          }`}
          data-openbitfun-component="files-panel"
          data-openbitfun-part="main"
        >
        {!workspacePath ? (
          <div className="openbitfun-files-panel__placeholder" data-openbitfun-component="files-panel" data-openbitfun-part="placeholder">
            <div className="openbitfun-files-panel__placeholder-icon">
              <LucideFileText width="32" height="32" stroke="currentColor" aria-hidden="true" />
            </div>
            <p>{t('empty.selectWorkspace')}</p>
          </div>
        ) : viewMode === 'search' ? (
          searchQuery ? (
            <div className="openbitfun-files-panel__search-content">
              {searchLimitNotice && (
                <div className="openbitfun-files-panel__search-limit-notice">
                  <span>{searchLimitNotice}</span>
                </div>
              )}

              {showContentSearchMetadata && contentSearchMetadata && (
                <div className="openbitfun-files-panel__search-backend">
                  <div className="openbitfun-files-panel__search-backend-badges">
                    <StatusPill tone={getSearchBackendBadgeVariant(contentSearchMetadata)}>
                      {contentSearchBackendLabel}
                    </StatusPill>
                    <StatusPill tone={getIndexPhaseBadgeVariant(contentSearchMetadata.repoPhase as WorkspaceSearchRepoPhase)}>
                      {t(`search.index.phase.${contentSearchMetadata.repoPhase}`, {
                        defaultValue: contentSearchMetadata.repoPhase,
                      })}
                    </StatusPill>
                    {contentSearchMetadata.baseAdvanceInProgress ? (
                      <StatusPill tone="warning">
                        {t('search.index.badges.baseAdvancing')}
                      </StatusPill>
                    ) : null}
                    {contentSearchMetadata.workspaceProbePending ? (
                      // Neutral, not warning: the reconcile clears itself and the results are still
                      // usable — they just describe the worktree from a moment ago.
                      <StatusPill tone="neutral">
                        {t('search.index.badges.probePending')}
                      </StatusPill>
                    ) : null}
                  </div>
                  <div className="openbitfun-files-panel__search-backend-summary">
                    {t('search.backendSummary', {
                      candidateDocs: contentSearchMetadata.candidateDocs,
                      matchedLines: contentSearchMetadata.matchedLines,
                      matchedOccurrences: contentSearchMetadata.matchedOccurrences,
                    })}
                  </div>
                </div>
              )}

              {searchError && (
                <div className="openbitfun-files-panel__error" data-openbitfun-component="files-panel" data-openbitfun-part="error">
                  <p>❌ {searchError}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSearchQuery(searchQuery)}
                  >
                    {t('actions.retry')}
                  </Button>
                </div>
              )}
              
              {searchResults.length > 0 ? (
                <FileSearchResults
                  resourceScope={resourceScope}
                  results={searchResults}
                  searchQuery={searchQuery}
                  onFileSelect={handleSearchResultSelect}
                  onFolderNavigate={handleSearchFolderNavigate}
                  workspacePath={workspacePath}
                  className="openbitfun-files-panel__search-results"
                />
              ) : (
                !isSearching && !searchError && (
                  <div className="openbitfun-files-panel__placeholder" data-openbitfun-component="files-panel" data-openbitfun-part="placeholder">
                    <div className="openbitfun-files-panel__placeholder-icon">
                      <Icon name="search" size="lg" />
                    </div>
                    <p>{t('search.noResults')}</p>
                  </div>
                )
              )}
            </div>
          ) : (
            <div className="openbitfun-files-panel__placeholder" data-openbitfun-component="files-panel" data-openbitfun-part="placeholder">
              <div className="openbitfun-files-panel__placeholder-icon">
                <Icon name="search" size="lg" />
              </div>
              <p>{t('search.enterKeyword')}</p>
            </div>
          )
        ) : (
          loading && fileTree.length === 0 ? (
            <div className="openbitfun-files-panel__loading">
              <LoadingState size="md">{t('status.loadingFileTree')}</LoadingState>
            </div>
          ) : error ? (
            <div className="openbitfun-files-panel__error" data-openbitfun-component="files-panel" data-openbitfun-part="error">
              <p>❌ {error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadFileTree()}
              >
                {t('actions.retry')}
              </Button>
            </div>
          ) : (
            <FileExplorer
              key={currentWorkspaceId || 'no-workspace'}
              fileTree={fileTree}
              selectedFile={selectedFile}
              revealTarget={revealTarget}
              expandedFolders={expandedFolders}
              loadingPaths={loadingPaths}
              onNodeExpand={handleNodeExpandLazy}
              onFileSelect={handleFileSelect}
              onFileDoubleClick={handleFileDoubleClick}
              className="openbitfun-files-panel__explorer"
              enablePathCompression={true}
              renamingPath={renamingPath}
              onRename={handleExecuteRename}
              onCancelRename={handleCancelRename}
              workspacePath={workspacePath}
              onNewFile={handleNewFile}
              onNewFolder={handleNewFolder}
              onRefresh={() => loadFileTree(workspacePath || '', false)}
              hideToolbar={hideExplorerToolbar}
            />
          )
        )}
        </div>
      </div>

      {transfers.size > 0 && (
        <ScrollArea className="openbitfun-files-panel__transfers" data-openbitfun-component="files-panel" data-openbitfun-part="transfers">
          {Array.from(transfers.entries()).map(([id, tp]) => (
            <div className="openbitfun-files-panel__transfer" data-openbitfun-component="files-panel" data-openbitfun-part="transfer" role="status" key={id}>
              <div className="openbitfun-files-panel__transfer-label">
                <OverflowText className="openbitfun-files-panel__transfer-label-text">
                  {tp.phase === 'download'
                    ? t('transfer.downloading')
                    : t('transfer.uploading')}
                  {tp.label ? ` — ${tp.label}` : ''}
                </OverflowText>
                {!tp.indeterminate &&
                tp.bytesTotal &&
                tp.bytesTotal > 0 ? (
                  <span className="openbitfun-files-panel__transfer-stats">
                    {Math.min(
                      100,
                      Math.round(
                        (100 * (tp.bytesTransferred ?? tp.current)) /
                          tp.bytesTotal,
                      ),
                    )}
                    %
                    {tp.speed ? ` · ${formatSpeed(tp.speed)}` : ''}
                  </span>
                ) : null}
              </div>
              <div
                className={`openbitfun-files-panel__transfer-track${
                  tp.indeterminate ? ' openbitfun-files-panel__transfer-track--indeterminate' : ''
                }`}
                data-openbitfun-component="files-panel"
                data-openbitfun-part="transferTrack"
              >
                <div
                  className="openbitfun-files-panel__transfer-fill"
                  data-openbitfun-component="files-panel"
                  data-openbitfun-part="transferFill"
                  style={
                    tp.indeterminate || !tp.total
                      ? undefined
                      : {
                          width: `${Math.min(
                            100,
                            Math.round((100 * tp.current) / tp.total)
                          )}%`,
                        }
                  }
                />
              </div>
              <div className="openbitfun-files-panel__transfer-bottom">
                {!tp.indeterminate &&
                tp.bytesTotal &&
                tp.bytesTotal > 0 ? (
                  <span className="openbitfun-files-panel__transfer-detail">
                    {formatBytes(tp.bytesTransferred ?? 0)} /{' '}
                    {formatBytes(tp.bytesTotal)}
                  </span>
                ) : <span />}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleStopTransfer(id)}
                  title={t('transfer.stop')}
                >
                  {t('transfer.stop')}
                </Button>
              </div>
            </div>
          ))}
        </ScrollArea>
      )}

      <InputDialog
        isOpen={inputDialog.isOpen}
        onClose={handleInputDialogClose}
        onConfirm={handleInputDialogConfirm}
        title={inputDialog.type === 'newFile' ? t('dialog.newFile.title') : t('dialog.newFolder.title')}
        placeholder={inputDialog.type === 'newFile' ? t('dialog.newFile.placeholder') : t('dialog.newFolder.placeholder')}
        confirmText={inputDialog.type === 'newFile' ? t('dialog.newFile.confirm') : t('dialog.newFolder.confirm')}
        cancelText={inputDialog.type === 'newFile' ? t('dialog.newFile.cancel') : t('dialog.newFolder.cancel')}
        validator={(value) => {
          const validPattern = isRemoteCurrentWorkspace
            // eslint-disable-next-line no-control-regex -- filename rules explicitly forbid ASCII control characters.
            ? /^[^/\x00-\x1F]+$/
            // eslint-disable-next-line no-control-regex -- filename rules explicitly forbid ASCII control characters.
            : /^[^<>:"/\\|?*\x00-\x1F]+$/;
          if (!validPattern.test(value)) {
            return t('validation.invalidFilename');
          }
          return null;
        }}
      />
    </div>
  );
};

export default FilesPanel;
