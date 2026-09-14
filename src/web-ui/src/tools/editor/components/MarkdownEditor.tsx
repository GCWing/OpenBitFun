/**
 * Markdown Editor Component
 * 
 * Based on M-Editor with IR (Instant Render) mode.
 * @module components/MarkdownEditor
 */

import { Button, Icon, IconButton, SegmentedControl, Toolbar, ToolbarGroup } from '@openbitfun/ui';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { MEditor } from '../meditor';
import { resourcePathKey } from '@/shared/utils/resourcePath';
import { useEditorDocument } from '../services/EditorDocument';
import type { EditorInstance } from '../meditor';
import { AlertCircle } from 'lucide-react';
import { createLogger } from '@/shared/utils/logger';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { globalEventBus } from '@/infrastructure/event-bus';
import { isSamePath } from '@/shared/utils/pathUtils';
import {
  isPeerDeviceModeActive,
  PEER_MODE_FILE_SYNC_POLL_MS,
} from '@/infrastructure/peer-device/peerModeFlag';
import { LoadingState } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import {
  diskVersionFromMetadata,
  diskVersionsDiffer,
  type DiskFileVersion,
} from '../utils/diskFileVersion';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import {
  isFileMissingFromMetadata,
  isLikelyFileNotFoundError,
} from '@/shared/utils/fsErrorUtils';
import './MarkdownEditor.scss';

import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

const log = createLogger('MarkdownEditor');


const FILE_SYNC_POLL_INTERVAL_MS = 1000;

function getPollOffsetMs(filePath: string): number {
  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = ((hash << 5) - hash + filePath.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 400;
}

export interface MarkdownEditorProps {
  /** File path - loads from file if provided, otherwise uses initialContent */
  filePath?: string;
  /** Initial content - used when no filePath */
  initialContent?: string;
  /** Workspace path */
  workspacePath?: string;
  /** File name */
  fileName?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** CSS class name */
  className?: string;
  /** Content change callback */
  onContentChange?: (content: string, hasChanges: boolean) => void;
  /** Save callback */
  onSave?: (content: string) => void;
  /** Jump to line number (auto-jump after file opens) */
  jumpToLine?: number;
  /** Jump to column (auto-jump after file opens) */
  jumpToColumn?: number;
  /** When false, disk sync polling is paused (background tab). */
  isActiveTab?: boolean;
  navigationToken?: number;
  /** File missing on disk (tab chrome); skipped when embedded CodeEditor handles the same path */
  onFileMissingFromDiskChange?: (missing: boolean) => void;
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  filePath,
  initialContent = '',
  workspacePath,
  readOnly = false,
  className = '',
  onContentChange,
  onSave,
  jumpToLine,
  jumpToColumn,
  isActiveTab = true,
  navigationToken,
  onFileMissingFromDiskChange,
}) => {
  const { t } = useI18n('tools');
  const documentSession = useEditorDocument();
  const documentFiles = documentSession?.files;
  const documentIdentity = documentSession?.id ?? filePath;
  const documentMarkdownMode = documentSession?.markdownMode;
  const [content, setContent] = useState<string>(initialContent);
  const [hasChanges, setHasChanges] = useState(false);
  const [viewMode, setViewMode] = useState<'ir' | 'source'>('ir');
  const [loading, setLoading] = useState(!!filePath);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<EditorInstance>(null);
  const isUnmountedRef = useRef(false);
  const diskVersionRef = useRef<DiskFileVersion | null>(null);
  const isCheckingDiskRef = useRef(false);
  const hasChangesRef = useRef(false);
  const lastNavigationTokenRef = useRef<number | undefined>(undefined);
  const lastJumpPositionRef = useRef<{ filePath: string; line: number } | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  const contentRef = useRef(content);
  const lastReportedDirtyRef = useRef<boolean | null>(null);
  const lastReportedMissingRef = useRef<boolean | undefined>(undefined);


  const reportFileMissingFromDisk = useCallback(
    (missing: boolean) => {
      if (!onFileMissingFromDiskChange) {
        return;
      }
      if (lastReportedMissingRef.current === missing) {
        return;
      }
      lastReportedMissingRef.current = missing;
      onFileMissingFromDiskChange(missing);
    },
    [onFileMissingFromDiskChange]
  );

  onContentChangeRef.current = onContentChange;
  contentRef.current = content;

  useEffect(() => {
    hasChangesRef.current = hasChanges;
  }, [hasChanges]);

  const basePath = React.useMemo(() => {
    if (!filePath) return undefined;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    if (lastSlashIndex >= 0) {
      return normalizedPath.substring(0, lastSlashIndex);
    }
    return undefined;
  }, [filePath]);

  useEffect(() => {
    isUnmountedRef.current = false;
    const editor = editorRef.current;
    return () => {
      isUnmountedRef.current = true;
      editor?.destroy();
    };
  }, []);

  useEffect(() => {
    setViewMode(documentMarkdownMode ?? 'ir');
  }, [documentIdentity, documentMarkdownMode, initialContent]);

  const fetchFileMetadata = useCallback(async () => {
    if (!filePath) {
      throw new Error('Missing file path');
    }
    const workspaceAPI = documentFiles ?? (await import('@/infrastructure/api')).workspaceAPI;
    return workspaceAPI.getFileMetadata(filePath);
  }, [documentFiles, filePath]);

  const loadFileContent = useCallback(async () => {
    if (!filePath || isUnmountedRef.current) return;


    if (documentSession?.snapshot) {
      const snapshot = documentSession.snapshot;
      setError(null);
      setContent(snapshot.content);
      contentRef.current = snapshot.content;
      setHasChanges(snapshot.isDirty);
      hasChangesRef.current = snapshot.isDirty;
      onContentChangeRef.current?.(snapshot.content, snapshot.isDirty);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const workspaceAPI = documentFiles ?? (await import('@/infrastructure/api')).workspaceAPI;

      const fileContent = await workspaceAPI.readFileContent(filePath);
      reportFileMissingFromDisk(false);

      try {
        const fileInfo = await fetchFileMetadata();
        if (isFileMissingFromMetadata(fileInfo)) {
          reportFileMissingFromDisk(true);
        } else {
          reportFileMissingFromDisk(false);
          const v = diskVersionFromMetadata(fileInfo);
          if (v) {
            diskVersionRef.current = v;
          }
        }
      } catch (err) {
        if (isLikelyFileNotFoundError(err)) {
          reportFileMissingFromDisk(true);
        }
        log.warn('Failed to get file metadata', err);
      }

      if (!isUnmountedRef.current) {
        const nextContent = fileContent;

        documentSession?.capture(nextContent, false);
        setContent(nextContent);
        setHasChanges(false);
        lastReportedDirtyRef.current = false;
        setTimeout(() => {
          editorRef.current?.setInitialContent?.(nextContent);
        }, 0);
        // NOTE: Do NOT call onContentChange here during initial load.
        // Calling it triggers parent re-render which unmounts this component,
        // causing an infinite loop.
      }
    } catch (err) {
      if (!isUnmountedRef.current) {
        const errStr = String(err);
        log.error('Failed to load file', err);
        let displayError = t('editor.common.loadFailed');
        if (errStr.includes('does not exist') || errStr.includes('No such file')) {
          displayError = t('editor.common.fileNotFound');
        } else if (errStr.includes('Permission denied') || errStr.includes('permission')) {
          displayError = t('editor.common.permissionDenied');
        }
        setError(displayError);
        if (errStr.includes('does not exist') || errStr.includes('No such file')) {
          reportFileMissingFromDisk(true);
        }
      }
    } finally {
      if (!isUnmountedRef.current) {
        setLoading(false);
      }
    }
  }, [documentFiles, documentSession, fetchFileMetadata, filePath, reportFileMissingFromDisk, t]);

  // Initial file load - only run once when filePath changes
  const loadFileContentCalledRef = useRef(false);
  useEffect(() => {
    loadFileContentCalledRef.current = false;
    diskVersionRef.current = null;
    lastReportedMissingRef.current = undefined;
  }, [filePath]);
  
  useEffect(() => {
    if (filePath) {
      if ((!documentSession || documentSession.isCurrent()) && !loadFileContentCalledRef.current) {
        loadFileContentCalledRef.current = true;
        loadFileContent();
      }
    } else if (initialContent !== undefined) {
      const nextContent = initialContent;

      setContent(nextContent);
      setHasChanges(false);
      lastReportedDirtyRef.current = false;
      setTimeout(() => {
        editorRef.current?.setInitialContent?.(nextContent);
      }, 0);
      // NOTE: Do NOT call onContentChange here during initial load.
      // Calling it triggers parent re-render which unmounts this component,
      // causing an infinite loop.
    }
  }, [filePath, initialContent, loadFileContent, isActiveTab, documentSession]);

  const retryStateRef = useRef({ error, loadFileContent });
  retryStateRef.current = { error, loadFileContent };
  useEffect(() => {
    // Failure and callback changes must not trigger another read. Retry only
    // when the tab is reactivated or its document session changes.
    const { error: loadError, loadFileContent: retryLoad } = retryStateRef.current;
    if (isActiveTab && documentSession?.isCurrent() && !documentSession.snapshot && loadError) void retryLoad();
  }, [documentSession, isActiveTab]);

  const syncMarkdownFromDisk = useCallback(async (source: 'poll' | 'event') => {
    if (!filePath || isUnmountedRef.current || isCheckingDiskRef.current) {
      return;
    }

    if (
      source === 'poll' &&
      (!isActiveTab ||
        (typeof document !== 'undefined' && document.visibilityState !== 'visible'))
    ) {
      return;
    }

    isCheckingDiskRef.current = true;
    const startedAt = nowMs();
    let outcome = 'started';
    let probeError: string | null = null;
    try {
      const workspaceAPI = documentFiles ?? (await import('@/infrastructure/api')).workspaceAPI;
      const fileInfo = await fetchFileMetadata();
      if (isFileMissingFromMetadata(fileInfo)) {
        outcome = 'missing-on-disk';
        reportFileMissingFromDisk(true);
        return;
      }
      reportFileMissingFromDisk(false);
      const currentVersion = diskVersionFromMetadata(fileInfo);
      if (!currentVersion) {
        outcome = 'missing-version';
        return;
      }
      const baseline = diskVersionRef.current;
      if (!baseline) {
        diskVersionRef.current = currentVersion;
        outcome = 'initialized-baseline';
        return;
      }
      if (!diskVersionsDiffer(currentVersion, baseline)) {
        outcome = 'no-change';
        return;
      }

      const localBefore = contentRef.current;
      const raw = await workspaceAPI.readFileContent(filePath);
      if (localBefore !== contentRef.current) {
        outcome = 'editor-changed-before-read';
        return;
      }
      const nextContent = raw;
      if (nextContent === contentRef.current) {
        diskVersionRef.current = currentVersion;
        outcome = 'content-match';
        return;
      }

      if (hasChangesRef.current) {
        const shouldReload = await confirmDialog({
          title: t('editor.codeEditor.externalModifiedTitle'),
          message: t('editor.codeEditor.externalModifiedDetail'),
          type: 'warning',
          confirmText: t('editor.codeEditor.discardAndReload'),
          cancelText: t('editor.codeEditor.keepLocalEdits'),
          confirmDanger: true,
        });
        if (!shouldReload) {
          diskVersionRef.current = currentVersion;
          outcome = 'kept-local-changes';
          return;
        }
      }

      if (!isUnmountedRef.current) {
        setContent(nextContent);
        contentRef.current = nextContent;
        setHasChanges(false);
        lastReportedDirtyRef.current = false;
        onContentChangeRef.current?.(nextContent, false);
        setTimeout(() => {
          editorRef.current?.setInitialContent?.(nextContent);
        }, 0);
        editorRef.current?.markSaved?.();
        reportFileMissingFromDisk(false);
      }

      const fileInfoAfter = await fetchFileMetadata();
      if (!isFileMissingFromMetadata(fileInfoAfter)) {
        const vAfter = diskVersionFromMetadata(fileInfoAfter);
        if (vAfter) {
          diskVersionRef.current = vAfter;
        }
      }
      outcome = 'reloaded-from-disk';
    } catch (e) {
      outcome = 'error';
      probeError = e instanceof Error ? e.message : String(e);
      if (isLikelyFileNotFoundError(e)) {
        reportFileMissingFromDisk(true);
      }
      log.error('Markdown disk sync check failed', e);
    } finally {
      const durationMs = elapsedMs(startedAt);
      if (probeError || outcome !== 'no-change' || durationMs >= 80) {
        sendDebugProbe(
          'MarkdownEditor.tsx:checkMarkdownDisk',
          'Markdown editor disk sync completed',
          {
            filePath,
            source,
            outcome,
            durationMs,
            error: probeError,
          }
        );
      }
      isCheckingDiskRef.current = false;
    }
  }, [documentFiles, fetchFileMetadata, filePath, isActiveTab, reportFileMissingFromDisk, t]);

  const checkMarkdownDisk = useCallback(async () => {
    await syncMarkdownFromDisk('poll');
  }, [syncMarkdownFromDisk]);

  useEffect(() => {
    if (!filePath || !isActiveTab) {
      return;
    }
    const tick = () => {
      void checkMarkdownDisk();
    };
    const pollOffsetMs = getPollOffsetMs(filePath);
    const pollIntervalMs = isPeerDeviceModeActive()
      ? PEER_MODE_FILE_SYNC_POLL_MS
      : FILE_SYNC_POLL_INTERVAL_MS;
    let intervalId: number | null = null;
    const timeoutId = window.setTimeout(() => {
      tick();
      intervalId = window.setInterval(tick, pollIntervalMs + pollOffsetMs);
    }, 250 + pollOffsetMs);
    const onPeerModeChanged = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      const nextIntervalMs = isPeerDeviceModeActive()
        ? PEER_MODE_FILE_SYNC_POLL_MS
        : FILE_SYNC_POLL_INTERVAL_MS;
      intervalId = window.setInterval(tick, nextIntervalMs + pollOffsetMs);
    };
    window.addEventListener('peer-mode:changed', onPeerModeChanged);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener('peer-mode:changed', onPeerModeChanged);
    };
  }, [checkMarkdownDisk, filePath, isActiveTab]);

  useEffect(() => {
    if (!filePath) {
      return;
    }

    return globalEventBus.on('editor:file-changed', (data: { filePath?: string }) => {
      if (!isActiveTab || (documentSession && !documentSession.isCurrent())
        || !(documentSession ? resourcePathKey(data.filePath || '', documentSession.scope) === resourcePathKey(filePath, documentSession.scope)
          : isSamePath(data.filePath || '', filePath))) {
        return;
      }
      void syncMarkdownFromDisk('event');
    });
  }, [filePath, syncMarkdownFromDisk, isActiveTab, documentSession]);

  const saveFileContent = useCallback(async () => {
    if (!hasChanges || isUnmountedRef.current) return;

    setError(null);

    try {
      if (filePath && workspacePath) {
        const workspaceAPI = documentFiles ?? (await import('@/infrastructure/api')).workspaceAPI;

        const fileInfoPre = await fetchFileMetadata();
        if (isFileMissingFromMetadata(fileInfoPre)) {
          reportFileMissingFromDisk(true);
        } else {
          reportFileMissingFromDisk(false);
        }
        const diskNow = diskVersionFromMetadata(fileInfoPre);
        const baseline = diskVersionRef.current;

        if (diskNow && baseline && diskVersionsDiffer(diskNow, baseline)) {
          const overwrite = await confirmDialog({
            title: t('editor.codeEditor.saveConflictTitle'),
            message: t('editor.codeEditor.saveConflictDetail'),
            type: 'warning',
            confirmText: t('editor.codeEditor.overwriteSave'),
            cancelText: t('editor.codeEditor.reloadFromDisk'),
            confirmDanger: true,
          });
          if (!overwrite) {
            const raw = await workspaceAPI.readFileContent(filePath);
            const nextContent = raw;
            if (!isUnmountedRef.current) {
              setContent(nextContent);
              contentRef.current = nextContent;
              setHasChanges(false);
              lastReportedDirtyRef.current = false;
              editorRef.current?.markSaved?.();
              onContentChangeRef.current?.(nextContent, false);
              setTimeout(() => {
                editorRef.current?.setInitialContent?.(nextContent);
              }, 0);
              reportFileMissingFromDisk(false);
            }
            try {
              const fileInfoAfter = await fetchFileMetadata();
              if (!isFileMissingFromMetadata(fileInfoAfter)) {
                const v = diskVersionFromMetadata(fileInfoAfter);
                if (v) {
                  diskVersionRef.current = v;
                }
              }
            } catch (err) {
              log.warn('Failed to sync disk version after save conflict reload', err);
            }
            return;
          }
        }

        await workspaceAPI.writeFileContent(workspacePath, filePath, content);

        try {
          const fileInfo = await fetchFileMetadata();
          if (!isFileMissingFromMetadata(fileInfo)) {
            reportFileMissingFromDisk(false);
            const v = diskVersionFromMetadata(fileInfo);
            if (v) {
              diskVersionRef.current = v;
            }
          }
        } catch (err) {
          log.warn('Failed to get file metadata', err);
        }

        if (!isUnmountedRef.current) {
          const stillDirty = contentRef.current !== content;
          documentSession?.capture(contentRef.current, stillDirty, content);
          if (!stillDirty) editorRef.current?.markSaved?.();
          setHasChanges(stillDirty);
          hasChangesRef.current = stillDirty;
          lastReportedDirtyRef.current = stillDirty;
          onContentChangeRef.current?.(contentRef.current, stillDirty);
        }

        globalEventBus.emit('file-tree:refresh');
      }

      if (onSave) {
        onSave(content);
        onContentChangeRef.current?.(contentRef.current, contentRef.current !== content);
      }
    } catch (err) {
      if (!isUnmountedRef.current) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error('Failed to save file', err);
        setError(t('editor.common.saveFailedWithMessage', { message: errorMessage }));
      }
    }
  }, [content, documentFiles, documentSession, fetchFileMetadata, filePath, hasChanges, onSave, reportFileMissingFromDisk, t, workspacePath]);

  useEffect(() => {
    if (documentSession) documentSession.save = saveFileContent;
  }, [documentSession, saveFileContent]);

  useEffect(() => {
    if (!loading && (!error || documentSession?.snapshot)) documentSession?.capture(content, hasChanges);
  }, [documentSession, content, hasChanges, loading, error]);

  const handleContentChange = useCallback((newContent: string) => {
    contentRef.current = newContent;
    if (documentSession?.snapshot) documentSession.capture(newContent, newContent !== documentSession.snapshot.savedContent);
    setContent(newContent);
  }, [documentSession]);

  const handleDirtyChange = useCallback((reportedDirty: boolean) => {
    const isDirty = documentSession?.snapshot ? contentRef.current !== documentSession.snapshot.savedContent : reportedDirty;
    setHasChanges(isDirty);
    if (lastReportedDirtyRef.current === isDirty) {
      return;
    }

    lastReportedDirtyRef.current = isDirty;
    onContentChangeRef.current?.(contentRef.current, isDirty);
  }, [documentSession]);

  const handleSave = useCallback((_value: string) => {
    saveFileContent();
  }, [saveFileContent]);

  const handleCopyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(contentRef.current);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      log.warn('Failed to copy markdown editor content', err);
    }
  }, []);

  useEffect(() => {
    if (!jumpToLine || !isActiveTab) {
      return;
    }

    const lastJump = lastJumpPositionRef.current;
    if (lastJump && 
        lastJump.filePath === filePath && 
        lastJump.line === jumpToLine && lastNavigationTokenRef.current === navigationToken) {
      return;
    }

    if (loading) {
      return;
    }

    if (!editorRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      if (editorRef.current?.scrollToLine) {
        lastNavigationTokenRef.current = navigationToken;
        editorRef.current.scrollToLine(jumpToLine, true);
        
        lastJumpPositionRef.current = {
          filePath: filePath || '',
          line: jumpToLine
        };
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [jumpToLine, jumpToColumn, filePath, loading, content, navigationToken, isActiveTab]);

  if (loading) {
    return (
      <div className={`openbitfun-markdown-editor-loading ${className}`} data-openbitfun-product-component="markdown-editor" data-openbitfun-product-part="loading" data-openbitfun-state="loading">
        <LoadingState size="md">{t('editor.markdownEditor.loadingFile')}</LoadingState>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`openbitfun-markdown-editor-error ${className}`} data-openbitfun-product-component="markdown-editor" data-openbitfun-product-part="error" data-openbitfun-state="error">
        <div className="error-content">
          <AlertCircle className="error-icon" />
          <p>{error}</p>
          {filePath && (
            <Button variant="outline" size="sm" onClick={loadFileContent}>
              {t('editor.common.retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`openbitfun-markdown-editor ${className}`} data-openbitfun-product-component="markdown-editor" data-openbitfun-product-part="root" data-openbitfun-view={viewMode}>
      <Toolbar
        className="openbitfun-markdown-editor__mode-toolbar"
        data-openbitfun-product-component="markdown-editor"
        data-openbitfun-product-part="toolbar"
        size="sm"
        leading={(
          <SegmentedControl
            aria-label={t('editor.markdownEditor.viewModeLabel')}
            size="sm"
            tone="neutral"
            options={[
              { value: 'ir', label: t('editor.markdownEditor.richText') },
              { value: 'source', label: t('editor.markdownEditor.source') },
            ]}
            value={viewMode}
            onValueChange={(value) => {
              if (documentSession) documentSession.markdownMode = value as 'ir' | 'source';
              setViewMode(value as 'ir' | 'source');
            }}
          />
        )}
        trailing={(
          <ToolbarGroup data-openbitfun-product-component="markdown-editor" data-openbitfun-product-part="actions">
            <IconButton
              type="button"
              size="sm"
              onClick={() => void handleCopyMarkdown()}
              aria-label={copied
                ? t('editor.markdownEditor.copiedMarkdown')
                : t('editor.markdownEditor.copyMarkdown')}
              icon={copied ? <Icon name="check-line" size="lg" /> : <Icon name="duplicate" size="lg" />}
              title={copied
                ? t('editor.markdownEditor.copiedMarkdown')
                : t('editor.markdownEditor.copyMarkdown')}
            />
          </ToolbarGroup>
        )}
      />
      <div className="openbitfun-markdown-editor__body" data-openbitfun-product-component="markdown-editor" data-openbitfun-product-part="body">
        <MEditor
          ref={editorRef}
          value={content}
          onChange={handleContentChange}
          onSave={handleSave}
          onDirtyChange={handleDirtyChange}
          mode={viewMode === 'ir' ? 'ir' : 'edit'}
          height="100%"
          width="100%"
          placeholder={t('editor.markdownEditor.placeholder')}
          readonly={readOnly}
          toolbar={false}
          filePath={filePath}
          basePath={basePath}
        />
      </div>
    </div>
  );
};

export default MarkdownEditor;
