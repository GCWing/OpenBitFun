/**
 * Remote File Browser Component
 * Used to browse and select remote directory as workspace
 */

import { subscribeOverlayInteraction, createOverlayPortal, Button, Dialog, ConfirmDialog, Icon, IconButton, Input, Menu, MenuItem, MenuSeparator, ScrollArea } from '@openbitfun/ui';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import type { RemoteFileEntry } from './types';
import { sshApi } from './sshApi';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { FolderOpen, Home, Loader2 } from 'lucide-react';
import './RemoteFileBrowser.scss';

interface RemoteFileBrowserProps {
  connectionId: string;
  /** Defaults to `/tmp` if parent does not pass a resolved absolute home (avoid literal `~` for SFTP). */
  initialPath?: string;
  /** Used by the Home button; defaults to `initialPath`. */
  homePath?: string;
  /** When true, only directories can be chosen and files are not selectable. */
  selectDirectoriesOnly?: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  entry: RemoteFileEntry | null;
}

interface DeleteConfirmState {
  show: boolean;
  entry: RemoteFileEntry | null;
}

function joinRemotePath(dir: string, fileName: string): string {
  const name = fileName.replace(/^\/+/, '');
  if (!dir || dir === '/') {
    return `/${name}`;
  }
  if (dir === '~') {
    return name ? `~/${name}` : '~';
  }
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return `${base}/${name}`;
}

/** Parent directory for remote paths (supports `~` and absolute POSIX paths). */
function getRemoteParentPath(path: string): string | null {
  if (path === '/' || path === '~') return null;
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    parts.pop();
    if (parts.length === 0) return '~';
    return `~/${parts.join('/')}`;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return '/';
  parts.pop();
  return `/${parts.join('/')}`;
}

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export const RemoteFileBrowser: React.FC<RemoteFileBrowserProps> = ({
  connectionId,
  initialPath = '/tmp',
  homePath,
  selectDirectoriesOnly = false,
  onSelect,
  onCancel,
}) => {
  const homeAnchor = homePath ?? initialPath;
  const { t } = useI18n('common');
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [pathInputValue, setPathInputValue] = useState(initialPath);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const textInputCompositionActiveRef = useRef(false);
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    show: false,
    x: 0,
    y: 0,
    entry: null,
  });
  const [renameEntry, setRenameEntry] = useState<RemoteFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    show: false,
    entry: null,
  });
  const [transferBusy, setTransferBusy] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // One-shot retry: when the SSH session was torn down by a transient network
  // blip, the backend transparently reconnects on the next call but the
  // already-in-flight request still fails. Retrying once gives the recovery
  // path a chance to succeed before surfacing an error to the user.
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    const fetchOnce = () => sshApi.readDir(connectionId, path);
    try {
      let result;
      try {
        result = await fetchOnce();
      } catch (firstErr) {
        // Brief pause lets the backend complete its reconnect handshake before
        // we hammer it again.
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          result = await fetchOnce();
        } catch {
          throw firstErr;
        }
      }
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load directory');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  // Close context menu when clicking outside
  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu({ show: false, x: 0, y: 0, entry: null });
      }
    };
    removeOverlayMousedown0 = subscribeOverlayInteraction(contextMenuRef, 'mousedown', handleClickOutside);
    return () => removeOverlayMousedown0?.();
  }, []);

  const navigateTo = (path: string) => {
    setCurrentPath(path);
    setPathInputValue(path);
    setSelectedPath(null);
    setIsEditingPath(false);
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      (e.key === 'Enter' || e.key === 'Escape')
      && isImeOwnedKeyboardEvent(e, textInputCompositionActiveRef.current)
    ) {
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter') {
      const val = pathInputValue.trim();
      if (val) {
        const nav = val.startsWith('~')
          ? val
          : val.startsWith('/')
            ? val
            : `/${val}`;
        navigateTo(nav);
      }
    } else if (e.key === 'Escape') {
      setPathInputValue(currentPath);
      setIsEditingPath(false);
    }
  };

  const handlePathInputBlur = () => {
    setPathInputValue(currentPath);
    setIsEditingPath(false);
  };

  const handleEntryClick = (entry: RemoteFileEntry) => {
    if (entry.isDir) {
      navigateTo(entry.path);
    } else if (!selectDirectoriesOnly) {
      setSelectedPath(entry.path);
    }
    setContextMenu({ show: false, x: 0, y: 0, entry: null });
  };

  const handleEntryDoubleClick = (entry: RemoteFileEntry) => {
    if (entry.isDir) {
      navigateTo(entry.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: RemoteFileEntry) => {
    e.preventDefault();
    setContextMenu({
      show: true,
      x: e.clientX,
      y: e.clientY,
      entry,
    });
  };

  const handleDownloadEntry = async (entry: RemoteFileEntry) => {
    if (entry.isDir) return;
    if (!isTauriDesktop()) {
      setError(t('ssh.remote.transferNeedsDesktop'));
      return;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const localPath = await save({
      title: t('ssh.remote.downloadDialogTitle'),
      defaultPath: entry.name,
    });
    if (localPath === null) return;

    setTransferBusy(true);
    setError(null);
    try {
      await sshApi.downloadToLocalPath(connectionId, entry.path, localPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('ssh.remote.transferFailed'));
    } finally {
      setTransferBusy(false);
    }
  };

  const handleContextMenuAction = async (action: string) => {
    if (!contextMenu.entry) return;

    const entry = contextMenu.entry;
    setContextMenu({ show: false, x: 0, y: 0, entry: null });

    try {
      switch (action) {
        case 'delete':
          setDeleteConfirm({ show: true, entry });
          break;
        case 'open':
          if (entry.isDir) {
            navigateTo(entry.path);
          } else if (!selectDirectoriesOnly) {
            onSelect(entry.path);
          }
          break;
        case 'rename':
          setRenameEntry(entry);
          setRenameValue(entry.name);
          break;
        case 'download': {
          void handleDownloadEntry(entry);
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm.entry) return;
    const entry = deleteConfirm.entry;
    setDeleteConfirm({ show: false, entry: null });

    try {
      await sshApi.remove(connectionId, entry.path, entry.isDir);
      loadDirectory(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleRename = async () => {
    if (!renameEntry || !renameValue.trim()) return;
    if (renameValue.trim() === renameEntry.name) {
      setRenameEntry(null);
      return;
    }

    const parentPath = getRemoteParentPath(renameEntry.path) ?? '/';
    const newPath = parentPath.endsWith('/')
      ? `${parentPath}${renameValue.trim()}`
      : `${parentPath}/${renameValue.trim()}`;

    try {
      await sshApi.rename(connectionId, renameEntry.path, newPath);
      setRenameEntry(null);
      loadDirectory(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename');
    }
  };

  const handleUploadToCurrentDir = async () => {
    if (!isTauriDesktop()) {
      setError(t('ssh.remote.transferNeedsDesktop'));
      return;
    }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title: t('ssh.remote.uploadDialogTitle'),
      multiple: true,
      directory: false,
    });
    if (selected === null) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;

    setTransferBusy(true);
    setError(null);
    try {
      for (const localPath of paths) {
        const segments = localPath.split(/[/\\]/);
        const base = segments.pop();
        if (!base) continue;
        const remotePath = joinRemotePath(currentPath, base);
        await sshApi.uploadFromLocalPath(connectionId, localPath, remotePath);
      }
      await loadDirectory(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('ssh.remote.transferFailed'));
    } finally {
      setTransferBusy(false);
    }
  };

  const openSelectedWorkspace = () => {
    onSelect(selectDirectoriesOnly ? currentPath : (selectedPath || currentPath));
  };

  const formatFileSize = (bytes?: number): string => {
    if (bytes === undefined || bytes === null) return '-';
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  const formatDate = (timestamp?: number): string => {
    if (!timestamp) return '-';
    const d = new Date(timestamp);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  };

  const getEntryIcon = (entry: RemoteFileEntry) => {
    if (entry.isDir) return <Icon name="folder" size="lg" className="remote-file-browser__entry-icon" />;
    if (entry.isSymlink) return <Icon name="link" size="lg" className="remote-file-browser__entry-icon remote-file-browser__entry-icon--link" />;
    return <Icon name="files" size="lg" className="remote-file-browser__entry-icon remote-file-browser__entry-icon--file" />;
  };

  const pathParts = (() => {
    if (currentPath === '/' || currentPath === '') return [];
    if (currentPath === '~') return ['~'];
    if (currentPath.startsWith('~/')) {
      return ['~', ...currentPath.slice(2).split('/').filter(Boolean)];
    }
    return currentPath.split('/').filter(Boolean);
  })();

  const pathAtSegment = (index: number) => {
    if (pathParts[0] === '~') {
      if (index === 0) return '~';
      return `~/${pathParts.slice(1, index + 1).join('/')}`;
    }
    return `/${pathParts.slice(0, index + 1).join('/')}`;
  };

  const browser = (
    <div className="remote-file-browser-overlay" data-openbitfun-component="ssh-remote" data-openbitfun-part="browserOverlay">
      <div ref={surfaceRef} role="dialog" aria-modal="true" tabIndex={-1}
        className="remote-file-browser" data-openbitfun-component="ssh-remote" data-openbitfun-part="browser">
        {/* Header */}
        <div className="remote-file-browser__header" data-openbitfun-component="ssh-remote" data-openbitfun-part="browserHeader">
          <h2 className="remote-file-browser__header-title">
            {t('ssh.remote.selectWorkspace')}
          </h2>
          <IconButton
            className="remote-file-browser__close-btn"
            icon={<Icon name="xmark" size="lg" />}
            size="md"
            onClick={onCancel}
            aria-label={t('actions.close')}
            data-openbitfun-component="ssh-remote"
            data-openbitfun-part="browserClose"
          />
        </div>

        {/* Path Breadcrumb / Input */}
        <ScrollArea
          className="remote-file-browser__breadcrumb"
          data-openbitfun-component="ssh-remote"
          data-openbitfun-part="breadcrumb"
          orientation="horizontal"
          scrollbarVisibility="hidden"
        >
          {isEditingPath ? (
            <Input
              ref={pathInputRef}
              className="remote-file-browser__path-input-field"
              value={pathInputValue}
              onValueChange={setPathInputValue}
              onKeyDown={handlePathInputKeyDown}
              onCompositionStart={() => {
                textInputCompositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                textInputCompositionActiveRef.current = false;
              }}
              onBlur={handlePathInputBlur}
              autoFocus
              spellCheck={false}
            />
          ) : (
            <div
              className="remote-file-browser__breadcrumb-path"
              onClick={() => {
                setIsEditingPath(true);
                setTimeout(() => pathInputRef.current?.select(), 0);
              }}
              title={t('ssh.remote.clickToEditPath') || 'Click to edit path'}
            >
              <IconButton
                className="remote-file-browser__breadcrumb-btn"
                onClick={(e) => { e.stopPropagation(); navigateTo(homeAnchor); }}
                title={t('ssh.remote.homeFolder') || 'Home folder'}
                aria-label={t('ssh.remote.homeFolder')}
                icon={<Home size={14} />}
              />
              <Icon name="chevron-right" size="xs" className="remote-file-browser__breadcrumb-sep" />
              {pathParts.length === 0 ? (
                <span className="remote-file-browser__breadcrumb-current">/</span>
              ) : (
                pathParts.map((part, index) => {
                  const segPath = pathAtSegment(index);
                  const isLast = index === pathParts.length - 1;
                  return (
                    <React.Fragment key={segPath}>
                      <button
                        className={`remote-file-browser__breadcrumb-btn ${isLast ? 'remote-file-browser__breadcrumb-btn--current' : ''}`}
                        onClick={(e) => { e.stopPropagation(); navigateTo(segPath); }}
                      >
                        {part}
                      </button>
                      {!isLast && <Icon name="chevron-right" size="xs" className="remote-file-browser__breadcrumb-sep" />}
                    </React.Fragment>
                  );
                })
              )}
            </div>
          )}
        </ScrollArea>

        {/* Toolbar */}
        <div className="remote-file-browser__toolbar" data-openbitfun-component="ssh-remote" data-openbitfun-part="toolbar">
          <IconButton
            className="remote-file-browser__toolbar-btn"
            onClick={() => loadDirectory(currentPath)}
            title={t('actions.refresh')}
            disabled={transferBusy}
            aria-label={t('actions.refresh')}
            icon={<Icon name="refresh" size="md" />}
          />
          <IconButton
            className="remote-file-browser__toolbar-btn"
            onClick={() => {
              const p = getRemoteParentPath(currentPath);
              if (p !== null) navigateTo(p);
            }}
            title="Go up"
            disabled={getRemoteParentPath(currentPath) === null || transferBusy}
            aria-label="Go up"
            icon={<Icon name="arrow-left" size="md" />}
          />
          <IconButton
            type="button"
            className="remote-file-browser__toolbar-btn"
            onClick={() => void handleUploadToCurrentDir()}
            title={t('ssh.remote.upload')}
            disabled={transferBusy}
            aria-label={t('ssh.remote.upload')}
            icon={<Icon name="upload" size="md" />}
          />
        </div>

        {transferBusy && (
          <div className="remote-file-browser__transfer-status">
            <Loader2 size={16} className="remote-file-browser__spinner-inline" />
            <span>{t('ssh.remote.transferring')}</span>
          </div>
        )}

        {/* File List */}
        <ScrollArea className="remote-file-browser__content" data-openbitfun-component="ssh-remote" data-openbitfun-part="content">
          {error && (
            <div className="remote-file-browser__error">
              <span>{error}</span>
              <IconButton
                type="button"
                onClick={() => loadDirectory(currentPath)}
                title={t('actions.retry') || 'Retry'}
                style={{ marginLeft: 'auto', marginRight: 8 }}
                aria-label={t('actions.retry')}
                icon={<Icon name="refresh" size="sm" />}
              />
              <IconButton
                onClick={() => setError(null)}
                aria-label={t('actions.close')}
                icon={'×'}
              />
            </div>
          )}

          {loading ? (
            <div className="remote-file-browser__loading">
              <Loader2 size={32} className="remote-file-browser__spinner" />
              <span>Loading...</span>
            </div>
          ) : (
            <table className="remote-file-browser__table">
              <thead className="remote-file-browser__thead">
                <tr>
                  <th className="remote-file-browser__th remote-file-browser__th--name">
                    {t('ssh.remote.name')}
                  </th>
                  <th className="remote-file-browser__th remote-file-browser__th--size">
                    {t('ssh.remote.size')}
                  </th>
                  <th className="remote-file-browser__th remote-file-browser__th--date">
                    {t('ssh.remote.modified')}
                  </th>
                </tr>
              </thead>
              <tbody className="remote-file-browser__tbody">
                {/* Parent directory link */}
                {getRemoteParentPath(currentPath) !== null && (
                  <tr
                    onClick={() => {
                      const parent = getRemoteParentPath(currentPath);
                      if (parent !== null) navigateTo(parent);
                    }}
                    className="remote-file-browser__row remote-file-browser__row--parent"
                  >
                    <td colSpan={3} className="remote-file-browser__td remote-file-browser__td--name">
                      <div className="remote-file-browser__name-cell">
                        <Icon name="folder" size="md" className="remote-file-browser__entry-icon remote-file-browser__entry-icon--parent" />
                        <span className="remote-file-browser__name">..</span>
                      </div>
                    </td>
                  </tr>
                )}
                {entries.map((entry) => (
                  <tr
                    key={entry.path}
                    onClick={() => handleEntryClick(entry)}
                    onDoubleClick={() => handleEntryDoubleClick(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    className={`remote-file-browser__row ${selectedPath === entry.path ? 'remote-file-browser__row--selected' : ''}`}
                  >
                    <td className="remote-file-browser__td remote-file-browser__td--name">
                      <div className="remote-file-browser__name-cell">
                        {getEntryIcon(entry)}
                        <span className="remote-file-browser__name">{entry.name}</span>
                      </div>
                    </td>
                    <td className="remote-file-browser__td remote-file-browser__td--size">
                      {entry.isDir ? '-' : formatFileSize(entry.size)}
                    </td>
                    <td className="remote-file-browser__td remote-file-browser__td--date">
                      {formatDate(entry.modified)}
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && !loading && (
                  <tr>
                    <td colSpan={3} className="remote-file-browser__empty">
                      {t('ssh.remote.emptyDirectory')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </ScrollArea>

        {/* Context Menu */}
        {contextMenu.show && contextMenu.entry && createOverlayPortal(
          <Menu
            ref={contextMenuRef}
            className="remote-file-browser__context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            aria-label={contextMenu.entry.name}
            autoFocusFirstItem
          >
            <MenuItem
              leading={<FolderOpen size={14} aria-hidden />}
              onClick={() => handleContextMenuAction('open')}
            >
              {t('actions.open') || 'Open'}
            </MenuItem>
            {!contextMenu.entry.isDir && (
              <MenuItem
                leading={<Icon name="arrow-down" size="sm" aria-hidden />}
                onClick={() => handleContextMenuAction('download')}
              >
                {t('ssh.remote.download')}
              </MenuItem>
            )}
            <MenuItem
              leading={<Icon name="edit" size="sm" aria-hidden />}
              onClick={() => handleContextMenuAction('rename')}
            >
              {t('ssh.remote.rename')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              leading={<Icon name="delete" size="sm" aria-hidden />}
              tone="danger"
              onClick={() => handleContextMenuAction('delete')}
            >
              {t('actions.delete') || 'Delete'}
            </MenuItem>
          </Menu>,
          getAppearanceOverlayHost(),
        )}

        {/* Rename Dialog */}
        {renameEntry && (
          <Dialog
            open
            onOpenChange={() => setRenameEntry(null)}
            aria-label={t('ssh.remote.rename')}
            className="remote-file-browser__dialog"
            overlayProps={{ className: 'remote-file-browser__dialog-overlay' }}
            portalTarget={getAppearanceOverlayHost()}
            autoFocus={false}
            restoreFocus={false}
            trapFocus={false}
            preventScroll={false}
            closeOnEscape={false}
            closeOnPointerOutside={false}
          >
              <h3 className="remote-file-browser__dialog-title">{t('ssh.remote.rename')}</h3>
              <Input
                type="text"
                value={renameValue}
                onValueChange={setRenameValue}
                className="remote-file-browser__dialog-input-field"
                autoFocus
                onKeyDown={(e) => {
                  if (
                    (e.key === 'Enter' || e.key === 'Escape')
                    && isImeOwnedKeyboardEvent(e, textInputCompositionActiveRef.current)
                  ) {
                    e.stopPropagation();
                    return;
                  }
                  if (e.key === 'Enter') handleRename();
                  if (e.key === 'Escape') setRenameEntry(null);
                }}
                onCompositionStart={() => {
                  textInputCompositionActiveRef.current = true;
                }}
                onCompositionEnd={() => {
                  textInputCompositionActiveRef.current = false;
                }}
              />
              <div className="remote-file-browser__dialog-actions">
                <Button variant="fill" size="sm" onClick={() => setRenameEntry(null)}>
                  {t('actions.cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleRename}
                  disabled={!renameValue.trim() || renameValue.trim() === renameEntry.name}
                >
                  {t('actions.confirm')}
                </Button>
              </div>
          </Dialog>
        )}

        {/* Delete Confirmation Dialog */}
        <ConfirmDialog
          open={deleteConfirm.show}
          title={t('ssh.remote.deleteTitle') || 'Delete'}
          message={deleteConfirm.entry
            ? t('ssh.remote.deleteConfirm') || `Delete "${deleteConfirm.entry.name}"?`
            : ''
          }
          confirmText={t('actions.delete') || 'Delete'}
          cancelText={t('actions.cancel')}
          onConfirm={handleDeleteConfirm}
          onOpenChange={() => setDeleteConfirm({ show: false, entry: null })}
          confirmDanger
          type="error"
        />

        {/* Footer */}
        <div className="remote-file-browser__footer" data-openbitfun-component="ssh-remote" data-openbitfun-part="footer">
          <div className="remote-file-browser__footer-info">
            {!selectDirectoriesOnly && selectedPath ? (
              <>
                <span className="remote-file-browser__footer-label">{t('ssh.remote.selected')}: </span>
                <span className="remote-file-browser__footer-path">{selectedPath}</span>
              </>
            ) : (
              <span className="remote-file-browser__footer-hint">
                {selectDirectoriesOnly ? currentPath : t('ssh.remote.clickToSelect')}
              </span>
            )}
          </div>
          <div className="remote-file-browser__footer-actions">
            <Button variant="fill" size="sm" onClick={onCancel}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={openSelectedWorkspace}
              disabled={false}
            >
              {t('ssh.remote.openWorkspace')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createOverlayPortal(browser, getAppearanceOverlayHost(), null, { modal: true, surfaceRef, onDismiss: onCancel });
};

export default RemoteFileBrowser;
