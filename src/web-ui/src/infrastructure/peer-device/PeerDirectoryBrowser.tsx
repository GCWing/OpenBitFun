/**
 * In-app directory browser for Peer Device Mode.
 * Lists directories on the peer via HostInvoke FS APIs.
 */

import { OverflowText, Button, Icon, IconButton, Input, ScrollArea } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { Home, Loader2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { workspaceAPI } from '@/infrastructure/api';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { createLogger } from '@/shared/utils/logger';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import {
  joinDirectoryPath,
  parentDirectoryPath,
} from './peerDirectoryPath';
import './PeerDirectoryBrowser.scss';

const log = createLogger('PeerDirectoryBrowser');

export interface PeerDirectoryBrowserProps {
  visible?: boolean;
  title: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

export const PeerDirectoryBrowser: React.FC<PeerDirectoryBrowserProps> = ({
  visible = true,
  title,
  initialPath,
  onSelect,
  onCancel,
}) => {
  const { t } = useI18n('common');
  const [currentPath, setCurrentPath] = useState(initialPath?.trim() || '');
  const [pathInputValue, setPathInputValue] = useState(initialPath?.trim() || '');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const inputRevisionRef = useRef(0);
  const pathInputCompositionActiveRef = useRef(false);
  const loadSeqRef = useRef(0);

  const parentPath = useMemo(() => parentDirectoryPath(currentPath), [currentPath]);

  const loadDirectory = useCallback(async (requestedPath?: string) => {
    const seq = ++loadSeqRef.current;
    const inputRevision = inputRevisionRef.current;
    setLoading(true);
    setError(null);
    setSelectedPath(null);
    try {
      const path = requestedPath || (await systemAPI.getSystemInfo()).homeDir;
      if (seq !== loadSeqRef.current) return;
      if (!path) throw new Error(t('peerDirectoryPicker.homeUnavailable'));
      const children = await workspaceAPI.getDirectoryChildren(path, '');
      if (seq !== loadSeqRef.current) {
        return;
      }
      const directories = (children || [])
        .filter((node) => node.isDirectory)
        .map((node) => ({
          name: node.name,
          path: node.path || joinDirectoryPath(path, node.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setEntries(directories);
      setCurrentPath(path);
      if (inputRevision === inputRevisionRef.current) setPathInputValue(path);
      setSelectedPath(path);
    } catch (loadError) {
      if (seq !== loadSeqRef.current) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      log.warn('Failed to list peer directory', { path: requestedPath, error: loadError });
      setError(message);
      setEntries([]);
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void loadDirectory(initialPath?.trim());
    return () => {
      loadSeqRef.current += 1;
    };
  }, [initialPath, loadDirectory]);

  const handleGoParent = useCallback(() => {
    if (!parentPath) {
      return;
    }
    void loadDirectory(parentPath);
  }, [loadDirectory, parentPath]);

  const handleGoHome = useCallback(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const handleRefresh = useCallback(() => {
    void loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const handleOpenEntry = useCallback((entry: DirectoryEntry) => {
    void loadDirectory(entry.path);
  }, [loadDirectory]);

  const handleCommitPathInput = useCallback(() => {
    const next = pathInputValue.trim();
    if (!next) {
      setPathInputValue(currentPath);
      return;
    }
    void loadDirectory(next);
  }, [currentPath, loadDirectory, pathInputValue]);

  const handleConfirm = useCallback(() => {
    const path = selectedPath;
    if (!path || loading || error || pathInputValue.trim() !== currentPath) {
      return;
    }
    onSelect(path);
  }, [currentPath, error, loading, onSelect, pathInputValue, selectedPath]);

  return createPortal(
    <div
      className="peer-directory-browser-overlay"
      data-state={visible ? 'open' : 'closed'}
      role="dialog"
      aria-modal="true"
      aria-hidden={!visible}
      {...(!visible ? { inert: '' } : {})}
      data-openbitfun-component="peer-device"
      data-openbitfun-part="overlay"
    >
      <div
        className="peer-directory-browser"
        data-testid="peer-directory-browser"
        data-openbitfun-component="peer-device"
        data-openbitfun-part="dialog"
      >
        <div
          className="peer-directory-browser__header"
          data-openbitfun-component="peer-device"
          data-openbitfun-part="header"
        >
          <h2
            className="peer-directory-browser__header-title"
            data-openbitfun-component="peer-device"
            data-openbitfun-part="title"
          >{title}</h2>
          <IconButton
            className="peer-directory-browser__close-btn"
            icon={<Icon name="xmark" size="lg" />}
            size="md"
            aria-label={t('peerDirectoryPicker.cancel')}
            onClick={onCancel}
            data-openbitfun-component="peer-device"
            data-openbitfun-part="closeButton"
          />
        </div>

        <div
          className="peer-directory-browser__toolbar"
          data-openbitfun-component="peer-device"
          data-openbitfun-part="toolbar"
        >
          <button
            type="button"
            className="peer-directory-browser__tool-btn"
            disabled={!parentPath || loading}
            onClick={handleGoParent}
            title={t('peerDirectoryPicker.parent')}
            data-openbitfun-component="peer-device"
            data-openbitfun-part="toolButton"
          >
            <Icon name="arrow-left" size="sm" />
          </button>
          <button
            type="button"
            className="peer-directory-browser__tool-btn"
            disabled={loading}
            onClick={handleGoHome}
            title={t('peerDirectoryPicker.home')}
            data-openbitfun-component="peer-device"
            data-openbitfun-part="toolButton"
          >
            <Home size={14} />
          </button>
          <button
            type="button"
            className="peer-directory-browser__tool-btn"
            disabled={loading || !currentPath}
            onClick={handleRefresh}
            title={t('peerDirectoryPicker.refresh')}
            data-openbitfun-component="peer-device"
            data-openbitfun-part="toolButton"
          >
            <Icon name="refresh" size="sm" />
          </button>
          <div
            className="peer-directory-browser__path"
            data-openbitfun-component="peer-device"
            data-openbitfun-part="path"
          >
            {/* Retain the appearance part for existing user styles around the editable field. */}
            <div data-openbitfun-component="peer-device" data-openbitfun-part="pathDisplay">
              <Input
                className="peer-directory-browser__path-input-field"
                size="sm"
                aria-label={t('peerDirectoryPicker.path')}
                placeholder={t('peerDirectoryPicker.pathHint')}
                value={pathInputValue}
                onValueChange={(value) => {
                  inputRevisionRef.current += 1;
                  setPathInputValue(value);
                }}
                onKeyDown={(event) => {
                  if (
                    (event.key === 'Enter' || event.key === 'Escape')
                    && isImeOwnedKeyboardEvent(event, pathInputCompositionActiveRef.current)
                  ) {
                    event.stopPropagation();
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleCommitPathInput();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setPathInputValue(currentPath);
                  }
                }}
                onCompositionStart={() => {
                  pathInputCompositionActiveRef.current = true;
                }}
                onCompositionEnd={() => {
                  pathInputCompositionActiveRef.current = false;
                }}
                data-openbitfun-component="peer-device"
                data-openbitfun-part="pathInput"
              />
            </div>
          </div>
        </div>

        <ScrollArea
          className="peer-directory-browser__body"
          data-openbitfun-component="peer-device"
          data-openbitfun-part="body"
        >
          {loading ? (
            <div
              className="peer-directory-browser__state"
              data-openbitfun-component="peer-device"
              data-openbitfun-part="status"
              data-openbitfun-state="loading"
            >
              <Loader2 size={16} className="peer-directory-browser__spinner" />
              <span>{t('peerDirectoryPicker.loading')}</span>
            </div>
          ) : error ? (
            <div
              className="peer-directory-browser__state peer-directory-browser__state--error"
              data-openbitfun-component="peer-device"
              data-openbitfun-part="status"
              data-openbitfun-state="error"
            >
              <span>{error}</span>
            </div>
          ) : entries.length === 0 ? (
            <div
              className="peer-directory-browser__state"
              data-openbitfun-component="peer-device"
              data-openbitfun-part="status"
              data-openbitfun-state="empty"
            >
              <span>{t('peerDirectoryPicker.empty')}</span>
            </div>
          ) : (
            <ul
              className="peer-directory-browser__list"
              data-openbitfun-component="peer-device"
              data-openbitfun-part="list"
            >
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={`peer-directory-browser__item${
                      selectedPath === entry.path ? ' is-selected' : ''
                    }`}
                    onClick={() => setSelectedPath(entry.path)}
                    onDoubleClick={() => handleOpenEntry(entry)}
                    data-openbitfun-component="peer-device"
                    data-openbitfun-part="item"
                    data-openbitfun-state={selectedPath === entry.path ? 'selected' : undefined}
                  >
                    <Icon name="folder" size="sm" />
                    <span>{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <div
          className="peer-directory-browser__footer"
          data-openbitfun-component="peer-device"
          data-openbitfun-part="footer"
        >
          <div
            className="peer-directory-browser__selected"
            title={selectedPath || currentPath}
            data-openbitfun-component="peer-device"
            data-openbitfun-part="selection"
          ><OverflowText>
            {t('peerDirectoryPicker.selected', { path: selectedPath || currentPath })}
          </OverflowText></div>
          <div
            className="peer-directory-browser__actions"
            data-openbitfun-component="peer-device"
            data-openbitfun-part="actions"
          >
            <Button type="button" variant="fill" size="sm" onClick={onCancel}>
              {t('peerDirectoryPicker.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              disabled={!selectedPath || loading || !!error || pathInputValue.trim() !== currentPath}
            >
              {t('peerDirectoryPicker.select')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    getAppearanceOverlayHost(),
  );
};

export default PeerDirectoryBrowser;
