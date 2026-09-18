/**
 * WorkingCopyView — Git working copy: commit bar + file list + diff area (ContentCanvas mode=git).
 */

import { OverflowText, Button, Icon, IconButton, SearchField, Textarea, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useState, useMemo, useEffect, useRef } from 'react';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { useTranslation } from 'react-i18next';
import { Minus, RotateCcw, Square, FileCode2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { ContentCanvas } from '@/app/components/panels/content-canvas';
import { CanvasStoreModeContext } from '@/app/components/panels/content-canvas/stores';
import { useGitState, useGitOperations, useGitAgent } from '@/tools/git/hooks';
import { gitService } from '@/tools/git/services';
import { createGitDiffEditorTab, createGitCodeEditorTab } from '@/shared/utils/tabUtils';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import './WorkingCopyView.scss';

const log = createLogger('WorkingCopyView');

const getFileNameAndDir = (filePath: string): { fileName: string; dirPath: string } => {
  const n = filePath.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  if (i === -1) return { fileName: filePath, dirPath: '' };
  return { fileName: n.slice(i + 1), dirPath: n.slice(0, i + 1) };
};

const getFileStatusInfo = (status: string): { className: string; text: string } => {
  const s = (status || '').toLowerCase();
  if (s.includes('m') || s.includes('modified')) return { className: 'wcv-status--modified', text: 'M' };
  if (s.includes('a') || s.includes('added')) return { className: 'wcv-status--added', text: 'A' };
  if (s.includes('d') || s.includes('deleted')) return { className: 'wcv-status--deleted', text: 'D' };
  if (s.includes('r') || s.includes('renamed')) return { className: 'wcv-status--renamed', text: 'R' };
  return { className: 'wcv-status--modified', text: 'M' };
};

const MAX_RENDERED_FILES = 200;
const FILE_LIST_WIDTH_DEFAULT = 260;
const FILE_LIST_WIDTH_MIN = 160;
const FILE_LIST_WIDTH_MAX = 560;

interface WorkingCopyViewProps {
  workspacePath?: string;
  workspaceId?: string;
  isActive?: boolean;
}

const WorkingCopyView: React.FC<WorkingCopyViewProps> = ({
  workspacePath,
  workspaceId,
  isActive = true,
}) => {
  const { t } = useTranslation('panels/git');
  const { t: tComponents } = useI18n('components');
  const notification = useNotification();

  const [quickCommitMessage, setQuickCommitMessage] = useState('');
  const [expandedFileGroups, setExpandedFileGroups] = useState<Set<string>>(new Set(['unstaged', 'staged', 'untracked']));
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingDiffFiles, setLoadingDiffFiles] = useState<Set<string>>(new Set());
  const [fileListWidth, setFileListWidth] = useState(FILE_LIST_WIDTH_DEFAULT);
  const mainRef = useRef<HTMLDivElement>(null);

  const {
    currentBranch,
    staged,
    unstaged,
    untracked,
    ahead,
    behind,
    refresh,
  } = useGitState({
    repositoryPath: { workspaceId: workspaceId ?? '', repositoryPath: workspacePath },
    isActive,
    refreshOnMount: true,
    layers: ['basic', 'status'],
  });

  const status = useMemo(
    () =>
      currentBranch
        ? { current_branch: currentBranch, staged: staged ?? [], unstaged: unstaged ?? [], untracked: untracked ?? [], ahead: ahead ?? 0, behind: behind ?? 0 }
        : null,
    [currentBranch, staged, unstaged, untracked, ahead, behind]
  );

  const { isOperating, addFiles, commit, push, pull, resetFiles } = useGitOperations({
    repositoryPath: { workspaceId: workspaceId ?? '', repositoryPath: workspacePath },
    autoRefresh: false,
  });
  const { commitMessage: aiCommitMessage, isGeneratingCommit, quickGenerateCommit, cancelCommitGeneration } = useGitAgent({
    repoPath: workspacePath ?? '',
  });

  useEffect(() => {
    if (aiCommitMessage?.fullMessage) setQuickCommitMessage(aiCommitMessage.fullMessage);
  }, [aiCommitMessage]);

  const handleRefresh = useCallback(() => refresh({ force: true, layers: ['basic', 'status'], reason: 'manual' }), [refresh]);
  const handlePush = useCallback(async () => {
    if (!workspacePath) return;
    await push({ force: false });
    await handleRefresh();
  }, [workspacePath, push, handleRefresh]);
  const handlePull = useCallback(async () => {
    await pull();
    await handleRefresh();
  }, [pull, handleRefresh]);

  const getAllUnstagedFiles = useCallback((): string[] => {
    if (!status) return [];
    const u = (status.unstaged || []).map((f: { path: string }) => f.path);
    const ut = status.untracked || [];
    return [...u, ...ut];
  }, [status]);

  const toggleFileSelection = useCallback((path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const all = getAllUnstagedFiles();
    setSelectedFiles(prev => (all.length > 0 && all.every(f => prev.has(f)) ? new Set() : new Set(all)));
  }, [getAllUnstagedFiles]);

  const isAllSelected = useMemo(() => {
    const all = getAllUnstagedFiles();
    return all.length > 0 && all.every(f => selectedFiles.has(f));
  }, [getAllUnstagedFiles, selectedFiles]);

  const isPartialSelected = useMemo(() => {
    const all = getAllUnstagedFiles();
    const n = all.filter(f => selectedFiles.has(f)).length;
    return n > 0 && n < all.length;
  }, [getAllUnstagedFiles, selectedFiles]);

  const handleStageSelectedFiles = useCallback(async () => {
    if (selectedFiles.size === 0) {
      notification.warning(t('notifications.selectFilesToStage'));
      return;
    }
    const result = await addFiles({ files: Array.from(selectedFiles), all: false });
    if (result.success) {
      setSelectedFiles(new Set());
      await handleRefresh();
      notification.success(t('notifications.stageSuccess', { count: selectedFiles.size }));
    } else if (result.error) notification.error(t('notifications.stageFailed', { error: result.error }));
  }, [selectedFiles, addFiles, handleRefresh, notification, t]);

  const handleQuickCommit = useCallback(async () => {
    if (!quickCommitMessage.trim()) {
      notification.warning(t('notifications.enterCommitMessage'));
      return;
    }
    if (!status?.staged?.length) {
      notification.warning(t('notifications.noStagedFiles'));
      return;
    }
    const result = await commit({ message: quickCommitMessage.trim() });
    if (result.success) {
      setQuickCommitMessage('');
      await handleRefresh();
      notification.success(t('notifications.commitSuccess'));
    } else notification.error(t('notifications.commitFailed', { error: result.error || t('common.unknownError') }));
  }, [quickCommitMessage, status, commit, handleRefresh, notification, t]);

  const handleAIGenerateCommit = useCallback(async () => {
    if (!status?.staged?.length && !status?.unstaged?.length && !status?.untracked?.length) {
      notification.warning(t('notifications.noFilesToGenerate'));
      return;
    }
    await quickGenerateCommit();
  }, [status, quickGenerateCommit, notification, t]);

  const handleDiscardFile = useCallback(
    async (filePath: string, fileType: 'staged' | 'unstaged' | 'untracked') => {
      if (!workspacePath) return;
      const msg = fileType === 'untracked' ? t('confirm.deleteFile', { file: filePath }) : t('confirm.discardFile', { file: filePath });
      if (!confirm(msg)) return;
      try {
        const { workspaceAPI } = await import('@/infrastructure/api');
        if (fileType === 'untracked') {
          const full = workspacePath.replace(/\\/g, '/') + '/' + filePath.replace(/\\/g, '/');
          await workspaceAPI.deleteFile(full);
        } else {
          const unstage = fileType === 'staged';
          if (unstage) await gitService.resetFiles({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, [filePath], true);
          await gitService.resetFiles({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, [filePath], false);
        }
        await handleRefresh();
        notification.success(t('notifications.fileRestored'));
      } catch (err) {
        log.error('Discard failed', { filePath, fileType, err });
        notification.error(t('notifications.fileRestoreFailed', { error: (err as Error).message }));
      }
    },
    [workspacePath, workspaceId, handleRefresh, notification, t]
  );

  const handleOpenFileDiff = useCallback(
    async (filePath: string, statusStr: string) => {
      if (!workspacePath) return;
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      setLoadingDiffFiles(prev => new Set(prev).add(filePath));
      setTimeout(async () => {
        try {
          const statusLower = (statusStr || '').toLowerCase();
          const isDeleted = statusLower.includes('d') || statusLower.includes('deleted');
          const { workspaceAPI } = await import('@/infrastructure/api');
          const fullPath = `${workspacePath.replace(/\\/g, '/')}/${filePath.replace(/\\/g, '/')}`;

          if (statusStr === 'Untracked') {
            createGitCodeEditorTab(fullPath, fileName);
            setLoadingDiffFiles(prev2 => {
              const s = new Set(prev2);
              s.delete(filePath);
              return s;
            });
            return;
          }

          let modifiedContent = '';
          if (!isDeleted) {
            modifiedContent = workspaceId
              ? await workspaceAPI.readWorkspaceFile(workspaceId, fullPath)
              : await workspaceAPI.readFileContent(fullPath);
          }
          let originalContent = '';
          try {
            originalContent = await gitService.getFileContent({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, filePath, 'HEAD');
          } catch (_) {}
          createGitDiffEditorTab(filePath, fileName, originalContent, modifiedContent, workspacePath, false, undefined, workspaceId);
        } catch (err) {
          log.error('Open file diff failed', { filePath, err });
          notification.error(t('notifications.openDiffFailedWithPath', { error: String(err), file: filePath }));
        } finally {
          setLoadingDiffFiles(prev2 => {
            const s = new Set(prev2);
            s.delete(filePath);
            return s;
          });
        }
      }, 0);
    },
    [workspacePath, workspaceId, notification, t]
  );

  const toggleFileGroup = useCallback((groupId: string) => {
    setExpandedFileGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const filteredFiles = useMemo(() => {
    if (!status) return { unstaged: [], untracked: [], staged: [] };
    const q = searchQuery.toLowerCase().trim();
    if (!q)
      return {
        unstaged: status.unstaged || [],
        untracked: status.untracked || [],
        staged: status.staged || [],
      };
    return {
      unstaged: (status.unstaged || []).filter((f: { path: string }) => f.path.toLowerCase().includes(q)),
      untracked: (status.untracked || []).filter((p: string) => p.toLowerCase().includes(q)),
      staged: (status.staged || []).filter((f: { path: string }) => f.path.toLowerCase().includes(q)),
    };
  }, [status, searchQuery]);

  const handleInteraction = useCallback(async () => {}, []);
  const handleBeforeClose = useCallback(async () => true, []);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = fileListWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      let next = startWidth + delta;
      next = Math.max(FILE_LIST_WIDTH_MIN, Math.min(FILE_LIST_WIDTH_MAX, next));
      setFileListWidth(next);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [fileListWidth]);

  const handleGitStageAll = useCallback(async () => {
    const files = getAllUnstagedFiles();
    if (files.length === 0) return;
    const result = await addFiles({ files, all: false });
    if (result.success) {
      setSelectedFiles(new Set());
      await handleRefresh();
      notification.success(t('notifications.stageSuccess', { count: files.length }));
    } else if (result.error) notification.error(t('notifications.stageFailed', { error: result.error }));
  }, [getAllUnstagedFiles, addFiles, handleRefresh, notification, t]);

  const handleGitUnstageAll = useCallback(async () => {
    if (!status?.staged?.length) return;
    const paths = status.staged.map((f: { path: string }) => f.path);
    const result = await resetFiles(paths, true);
    if (result.success) await handleRefresh();
    else if (result.error) notification.error(result.error);
  }, [status, resetFiles, handleRefresh, notification]);

  const gitShortcutsEnabled = Boolean(workspacePath) && isActive;

  useShortcut(
    'git.refresh',
    { key: 'F5', scope: 'git' },
    () => {
      void handleRefresh();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.refresh' }
  );
  useShortcut(
    'git.commit',
    { key: 'Enter', ctrl: true, scope: 'git', allowInInput: true },
    () => {
      void handleQuickCommit();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.commit' }
  );
  useShortcut(
    'git.push',
    { key: 'P', ctrl: true, shift: true, scope: 'git' },
    () => {
      void handlePush();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.push' }
  );
  useShortcut(
    'git.pull',
    { key: 'L', ctrl: true, shift: true, scope: 'git' },
    () => {
      void handlePull();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.pull' }
  );
  useShortcut(
    'git.stageAll',
    { key: 'A', ctrl: true, shift: true, scope: 'git' },
    () => {
      void handleGitStageAll();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.stageAll' }
  );
  useShortcut(
    'git.unstageAll',
    { key: 'U', ctrl: true, shift: true, scope: 'git' },
    () => {
      void handleGitUnstageAll();
    },
    { enabled: gitShortcutsEnabled, description: 'keyboard.shortcuts.git.unstageAll' }
  );

  if (!workspacePath) {
    return (
      <div data-openbitfun-component="working-copy-view" data-openbitfun-part="root" className="openbitfun-git-scene-working-copy">
        <div className="openbitfun-git-scene-working-copy__placeholder" data-openbitfun-component="working-copy-view" data-openbitfun-part="placeholder">
          <FileCode2 size={48} aria-hidden />
          <p>{t('tabs.changes')}</p>
          <p className="openbitfun-git-scene-working-copy__hint">Open a workspace to see changes.</p>
        </div>
      </div>
    );
  }

  return (
    <div data-openbitfun-component="working-copy-view" data-openbitfun-part="root" className="openbitfun-git-scene-working-copy">
      <div className="openbitfun-git-scene-working-copy__commit-bar" data-openbitfun-component="working-copy-view" data-openbitfun-part="commitBar">
        <div className="openbitfun-git-scene-working-copy__status-row" data-openbitfun-component="working-copy-view" data-openbitfun-part="statusRow">
          <Icon name="git" size="xs" />
          <span className="openbitfun-git-scene-working-copy__branch" data-openbitfun-component="working-copy-view" data-openbitfun-part="branch">{status?.current_branch ?? t('common.unknown')}</span>
          {(status?.ahead ?? 0) > 0 && (
            <Tooltip content={t('status.ahead')}>
              <span className="openbitfun-git-scene-working-copy__badge wcv-badge--ahead">↑{status?.ahead}</span>
            </Tooltip>
          )}
          {(status?.behind ?? 0) > 0 && (
            <Tooltip content={t('status.behind')}>
              <span className="openbitfun-git-scene-working-copy__badge wcv-badge--behind">↓{status?.behind}</span>
            </Tooltip>
          )}
          <div className="openbitfun-git-scene-working-copy__sync-actions" data-openbitfun-component="working-copy-view" data-openbitfun-part="syncActions">
            <Tooltip content={t('actions.pull')}>
              <IconButton
                aria-label={t('actions.pull')}
                size="sm"
                onClick={handlePull}
                disabled={isOperating}
                icon={<Icon name="arrow-down" size="sm" />}
              />
            </Tooltip>
            <Tooltip content={t('actions.push')}>
              <IconButton
                aria-label={t('actions.push')}
                size="sm"
                onClick={handlePush}
                disabled={isOperating}
                icon={<Icon name="arrow-up" size="sm" />}
              />
            </Tooltip>
          </div>
        </div>
        <div className="openbitfun-git-scene-working-copy__commit-input-row" data-openbitfun-component="working-copy-view" data-openbitfun-part="commitInput">
          <Textarea
            className="openbitfun-git-scene-working-copy__message"
            placeholder={status?.staged?.length ? t('commit.inputPlaceholder') : t('commit.inputPlaceholderNoStaged')}
            value={quickCommitMessage}
            onChange={e => setQuickCommitMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleQuickCommit();
              }
            }}
            disabled={isOperating || isGeneratingCommit}
          />
          {isGeneratingCommit ? (
            <Tooltip content={t('actions.cancelGenerate')}>
              <IconButton
                aria-label={t('actions.cancelGenerate')}
                size="sm"
                onClick={cancelCommitGeneration}
                icon={<Square size={12} />}
              />
            </Tooltip>
          ) : (
            <Tooltip content={t('actions.aiGenerateCommit')}>
              <IconButton
                aria-label={t('actions.aiGenerateCommit')}
                size="sm"
                onClick={handleAIGenerateCommit}
                disabled={isOperating}
                icon={<Icon name="spark" size="sm" />}
              />
            </Tooltip>
          )}
        </div>
        <div className="openbitfun-git-scene-working-copy__commit-actions" data-openbitfun-component="working-copy-view" data-openbitfun-part="commitActions">
          <Button
            size="sm"
            variant="primary"
            onClick={handleQuickCommit}
            disabled={!status?.staged?.length || !quickCommitMessage.trim() || isOperating || isGeneratingCommit}
          >
            {status?.staged?.length ? t('actions.commitWithCount', { count: status.staged.length }) : t('actions.commit')}
          </Button>
        </div>
      </div>

      <div className="openbitfun-git-scene-working-copy__main" ref={mainRef} data-openbitfun-component="working-copy-view" data-openbitfun-part="main">
        <div className="openbitfun-git-scene-working-copy__file-list" style={{ width: fileListWidth }} data-openbitfun-component="working-copy-view" data-openbitfun-part="fileList">
          <div className="openbitfun-git-scene-working-copy__search" data-openbitfun-component="working-copy-view" data-openbitfun-part="search">
            <SearchField
              size="sm"
              leadingIcon={<Icon name="search" size="sm" aria-hidden />}
              placeholder={t('search.files')}
              aria-label={t('search.files')}
              value={searchQuery}
              onValueChange={setSearchQuery}
              clearLabel={searchQuery ? tComponents('search.clear') : undefined}
              onClear={searchQuery ? () => setSearchQuery('') : undefined}
            />
          </div>
          {status && (status.unstaged?.length || status.untracked?.length || status.staged?.length) ? (
            <>
              {filteredFiles.unstaged.length > 0 && (
                <>
                  <div
                    className="openbitfun-git-scene-working-copy__group-header"
                    data-openbitfun-component="working-copy-view"
                    data-openbitfun-part="groupHeader"
                    onClick={() => toggleFileGroup('unstaged')}
                  >
                    {expandedFileGroups.has('unstaged') ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
                    <span>
                      {searchQuery
                        ? t('fileGroups.unstagedWithFilter', { filtered: filteredFiles.unstaged.length, total: status.unstaged?.length || 0 })
                        : t('fileGroups.unstagedWithCount', { count: filteredFiles.unstaged.length })}
                    </span>
                    <Tooltip content={isAllSelected ? t('selection.deselectAll') : t('selection.selectAll')}>
                      <IconButton
                        aria-label={isAllSelected ? t('selection.deselectAll') : t('selection.selectAll')}
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          toggleSelectAll();
                        }}
                        icon={isAllSelected ? <Icon name="check-line" size="sm" /> : isPartialSelected ? <Minus size={14} /> : <Icon name="unselected" size="sm" />}
                      />
                    </Tooltip>
                    <Tooltip content={t('actions.stageSelected', { count: selectedFiles.size })}>
                      <IconButton
                        aria-label={t('actions.stageSelected', { count: selectedFiles.size })}
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          handleStageSelectedFiles();
                        }}
                        disabled={isOperating || selectedFiles.size === 0}
                        icon={<Icon name="check-line" size="sm" />}
                      />
                    </Tooltip>
                  </div>
                  {expandedFileGroups.has('unstaged') &&
                    filteredFiles.unstaged.slice(0, MAX_RENDERED_FILES).map((file: { path: string; status: string }, idx: number) => {
                      const { fileName, dirPath } = getFileNameAndDir(file.path);
                      const statusInfo = getFileStatusInfo(file.status);
                      const isLoading = loadingDiffFiles.has(file.path);
                      const isSelected = selectedFiles.has(file.path);
                      return (
                        <div data-overflow-trigger data-openbitfun-component="working-copy-view" data-openbitfun-part="file"
                          key={`u-${idx}`}
                          className={`openbitfun-git-scene-working-copy__file-row ${isSelected ? 'wcv-file--selected' : ''} ${isLoading ? 'wcv-file--loading' : ''}`}
                          data-openbitfun-state={[isSelected && 'selected', isLoading && 'loading'].filter(Boolean).join(' ') || undefined}
                          onClick={() => !isLoading && handleOpenFileDiff(file.path, file.status)}
                          title={t('tooltips.viewDiff')}
                        >
                          <button
                            type="button"
                            className="openbitfun-git-scene-working-copy__file-check"
                            data-openbitfun-component="working-copy-view"
                            data-openbitfun-part="fileCheck"
                            onClick={e => {
                              e.stopPropagation();
                              toggleFileSelection(file.path);
                            }}
                          >
                            {isSelected ? <Icon name="check-line" size="sm" /> : <Icon name="unselected" size="sm" />}
                          </button>
                          <OverflowText className="openbitfun-git-scene-working-copy__file-name" data-openbitfun-component="working-copy-view" data-openbitfun-part="fileName">{fileName}</OverflowText>
                          {dirPath && <span className="openbitfun-git-scene-working-copy__file-dir">{dirPath}</span>}
                          <span className={`openbitfun-git-scene-working-copy__file-status ${statusInfo.className}`} data-openbitfun-component="working-copy-view" data-openbitfun-part="fileStatus">{statusInfo.text}</span>
                          <Tooltip content={t('actions.discardFile')}>
                            <IconButton
                              aria-label={t('actions.discardFile')}
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                handleDiscardFile(file.path, 'unstaged');
                              }}
                              disabled={isOperating}
                              icon={<RotateCcw size={12} />}
                            />
                          </Tooltip>
                        </div>
                      );
                    })}
                </>
              )}
              {filteredFiles.untracked.length > 0 && (
                <>
                  <div className="openbitfun-git-scene-working-copy__group-header" onClick={() => toggleFileGroup('untracked')} data-openbitfun-component="working-copy-view" data-openbitfun-part="groupHeader">
                    {expandedFileGroups.has('untracked') ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
                    <span>
                      {searchQuery
                        ? t('fileGroups.untrackedWithFilter', { filtered: filteredFiles.untracked.length, total: status.untracked?.length || 0 })
                        : t('fileGroups.untrackedWithCount', { count: filteredFiles.untracked.length })}
                    </span>
                  </div>
                  {expandedFileGroups.has('untracked') &&
                    filteredFiles.untracked.slice(0, MAX_RENDERED_FILES).map((filePath: string, idx: number) => {
                      const { fileName, dirPath } = getFileNameAndDir(filePath);
                      const isLoading = loadingDiffFiles.has(filePath);
                      const isSelected = selectedFiles.has(filePath);
                      return (
                        <div data-overflow-trigger data-openbitfun-component="working-copy-view" data-openbitfun-part="file"
                          key={`ut-${idx}`}
                          className={`openbitfun-git-scene-working-copy__file-row ${isSelected ? 'wcv-file--selected' : ''} ${isLoading ? 'wcv-file--loading' : ''}`}
                          data-openbitfun-state={[isSelected && 'selected', isLoading && 'loading'].filter(Boolean).join(' ') || undefined}
                          onClick={() => !isLoading && handleOpenFileDiff(filePath, 'Untracked')}
                          title={t('tooltips.viewDiff')}
                        >
                          <button
                            type="button"
                            className="openbitfun-git-scene-working-copy__file-check"
                            data-openbitfun-component="working-copy-view"
                            data-openbitfun-part="fileCheck"
                            onClick={e => {
                              e.stopPropagation();
                              toggleFileSelection(filePath);
                            }}
                          >
                            {isSelected ? <Icon name="check-line" size="sm" /> : <Icon name="unselected" size="sm" />}
                          </button>
                          <OverflowText className="openbitfun-git-scene-working-copy__file-name" data-openbitfun-component="working-copy-view" data-openbitfun-part="fileName">{fileName}</OverflowText>
                          {dirPath && <span className="openbitfun-git-scene-working-copy__file-dir">{dirPath}</span>}
                          <span className="openbitfun-git-scene-working-copy__file-status wcv-status--added" data-openbitfun-component="working-copy-view" data-openbitfun-part="fileStatus">U</span>
                          <Tooltip content={t('actions.deleteFile')}>
                            <IconButton
                              aria-label={t('actions.deleteFile')}
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                handleDiscardFile(filePath, 'untracked');
                              }}
                              disabled={isOperating}
                              icon={<RotateCcw size={12} />}
                            />
                          </Tooltip>
                        </div>
                      );
                    })}
                </>
              )}
              {filteredFiles.staged.length > 0 && (
                <>
                  <div className="openbitfun-git-scene-working-copy__group-header" onClick={() => toggleFileGroup('staged')} data-openbitfun-component="working-copy-view" data-openbitfun-part="groupHeader">
                    {expandedFileGroups.has('staged') ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
                    <span>
                      {searchQuery
                        ? t('fileGroups.stagedWithFilter', { filtered: filteredFiles.staged.length, total: status.staged?.length || 0 })
                        : t('fileGroups.stagedWithCount', { count: filteredFiles.staged.length })}
                    </span>
                  </div>
                  {expandedFileGroups.has('staged') &&
                    filteredFiles.staged.map((file: { path: string; status: string }, idx: number) => {
                      const statusInfo = getFileStatusInfo(file.status);
                      const isLoading = loadingDiffFiles.has(file.path);
                      return (
                        <div data-overflow-trigger data-openbitfun-component="working-copy-view" data-openbitfun-part="file"
                          key={`s-${idx}`}
                          className={`openbitfun-git-scene-working-copy__file-row ${isLoading ? 'wcv-file--loading' : ''}`}
                          data-openbitfun-state={isLoading ? 'loading' : undefined}
                          onClick={() => !isLoading && handleOpenFileDiff(file.path, file.status)}
                          title={t('tooltips.viewDiff')}
                        >
                          <OverflowText className="openbitfun-git-scene-working-copy__file-name" data-openbitfun-component="working-copy-view" data-openbitfun-part="fileName">{file.path}</OverflowText>
                          <span className={`openbitfun-git-scene-working-copy__file-status ${statusInfo.className}`} data-openbitfun-component="working-copy-view" data-openbitfun-part="fileStatus">{statusInfo.text}</span>
                          <Tooltip content={t('actions.discardFile')}>
                            <IconButton
                              aria-label={t('actions.discardFile')}
                              size="sm"
                              onClick={e => {
                                e.stopPropagation();
                                handleDiscardFile(file.path, 'staged');
                              }}
                              disabled={isOperating}
                              icon={<RotateCcw size={12} />}
                            />
                          </Tooltip>
                        </div>
                      );
                    })}
                </>
              )}
            </>
          ) : (
            <div className="openbitfun-git-scene-working-copy__empty" data-openbitfun-component="working-copy-view" data-openbitfun-part="empty">{t('empty.noChanges')}</div>
          )}
        </div>
        <div
          className="openbitfun-git-scene-working-copy__resizer"
          data-openbitfun-component="working-copy-view"
          data-openbitfun-part="resizer"
          onMouseDown={handleResizerMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={fileListWidth}
          title={t('tooltips.resizeFileList')}
        />
        <div className="openbitfun-git-scene-working-copy__diff-area" data-openbitfun-component="working-copy-view" data-openbitfun-part="diffArea">
          <CanvasStoreModeContext.Provider value="git">
            <ContentCanvas workspacePath={workspacePath} mode="git" onInteraction={handleInteraction} onBeforeClose={handleBeforeClose} />
          </CanvasStoreModeContext.Provider>
        </div>
      </div>
    </div>
  );
};

export default WorkingCopyView;
