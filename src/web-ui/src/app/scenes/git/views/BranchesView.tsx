/**
 * BranchesView — Left: branch list (switch/create/delete). Right: commit history for selected branch.
 */

import { OverflowText, Button, Icon, IconButton, SearchField, Tooltip, ScrollArea } from '@openbitfun/ui';
import React, { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, FileText } from 'lucide-react';

import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { gitService } from '@/tools/git/services';
import { useGitOperations } from '@/tools/git/hooks';
import { useNotification } from '@/shared/notification-system';
import { CreateBranchDialog } from '@/tools/git/components/CreateBranchDialog';
import type { GitBranch as GitBranchType, GitCommit as GitCommitType, GitFileChange } from '@/tools/git/types/repository';
import './BranchesView.scss';

interface BranchesViewProps {
  workspacePath?: string;
  workspaceId?: string;
}

const BranchesView: React.FC<BranchesViewProps> = ({ workspacePath, workspaceId }) => {
  const { t } = useTranslation('panels/git');
  const { t: tComponents } = useI18n('components');
  const notification = useNotification();

  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchSearchQuery, setBranchSearchQuery] = useState('');
  const [selectedBranchName, setSelectedBranchName] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [baseBranch, setBaseBranch] = useState('');

  const [commits, setCommits] = useState<GitCommitType[]>([]);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitSearchQuery, setCommitSearchQuery] = useState('');
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set());
  const [isResetting, setIsResetting] = useState(false);

  const { isOperating, checkoutBranch, createBranch, deleteBranch } = useGitOperations({
    repositoryPath: { workspaceId: workspaceId ?? '', repositoryPath: workspacePath },
    autoRefresh: false,
  });

  const loadBranches = useCallback(async () => {
    if (!workspacePath) return;
    setBranchLoading(true);
    try {
      const result = await gitService.getBranches({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, true);
      const list = Array.isArray(result) ? result : [];
      setBranches(list);
      if (list.length > 0 && !selectedBranchName) {
        const current = list.find(b => b.current);
        setSelectedBranchName(current?.name ?? list[0]?.name ?? null);
      }
    } catch {
      setBranches([]);
    } finally {
      setBranchLoading(false);
    }
  }, [selectedBranchName, workspacePath, workspaceId]);

  const loadCommits = useCallback(
    async (branchRef: string | null) => {
      if (!workspacePath || !branchRef) {
        setCommits([]);
        return;
      }
      setCommitLoading(true);
      try {
        const result = await gitService.getCommits({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, { maxCount: 50 });
        const list = Array.isArray(result) ? result : [];
        setCommits([...list].reverse());
      } catch {
        setCommits([]);
      } finally {
        setCommitLoading(false);
      }
    },
    [workspacePath, workspaceId]
  );

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  useEffect(() => {
    loadCommits(selectedBranchName);
  }, [selectedBranchName, loadCommits]);

  const filteredBranches = branchSearchQuery.trim()
    ? branches.filter(b => (b.name ?? '').toLowerCase().includes(branchSearchQuery.toLowerCase()))
    : branches;

  const filteredCommits = commitSearchQuery.trim()
    ? commits.filter(
        c =>
          (c.message ?? '').toLowerCase().includes(commitSearchQuery.toLowerCase()) ||
          ((c as any).author?.name ?? (c as any).author ?? '').toLowerCase().includes(commitSearchQuery.toLowerCase()) ||
          (c.hash ?? '').toLowerCase().includes(commitSearchQuery.toLowerCase())
      )
    : commits;

  const handleSelectBranch = useCallback((name: string) => {
    setSelectedBranchName(name);
  }, []);

  const handleSwitchBranch = useCallback(
    async (name: string) => {
      const result = await checkoutBranch(name);
      if (result.success) {
        notification.success(t('quickSwitch.notifications.switchSuccess', { branch: name }));
        loadBranches();
        setSelectedBranchName(name);
      } else notification.error(result.error || t('quickSwitch.errors.switchFailed'));
    },
    [checkoutBranch, notification, t, loadBranches]
  );

  const handleCreateFrom = useCallback((base: string) => {
    setBaseBranch(base);
    setShowCreateDialog(true);
  }, []);

  const handleCreateConfirm = useCallback(
    async (newName: string) => {
      const result = await createBranch(newName.trim(), baseBranch);
      if (result.success) {
        setShowCreateDialog(false);
        setBaseBranch('');
        loadBranches();
      }
    },
    [createBranch, baseBranch, loadBranches]
  );

  const handleDeleteBranch = useCallback(
    async (name: string, isCurrent: boolean) => {
      if (isCurrent) {
        notification.warning(t('notifications.cannotDeleteCurrentBranch'));
        return;
      }
      if (!confirm(t('confirm.deleteBranch', { branch: name }))) return;
      const result = await deleteBranch(name, false);
      if (result.success) {
        loadBranches();
        if (selectedBranchName === name) setSelectedBranchName(branches.find(b => b.name !== name)?.name ?? null);
      } else notification.error(result.error || 'Delete failed');
    },
    [deleteBranch, notification, t, loadBranches, selectedBranchName, branches]
  );

  const toggleCommitExpand = useCallback((hash: string) => {
    setExpandedCommits(prev => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  const handleCopyHash = useCallback(
    async (hash: string) => {
      try {
        await navigator.clipboard.writeText(hash);
        notification.success(t('branchHistory.copied') || 'Copied');
      } catch {
        notification.error('Copy failed');
      }
    },
    [notification, t]
  );

  const handleResetToCommit = useCallback(
    async (hash: string) => {
      if (!workspacePath) return;
      if (!confirm(t('confirm.resetToCommit', { hash: hash.substring(0, 7) }))) return;
      setIsResetting(true);
      try {
        const result = await gitService.resetToCommit({ workspaceId: workspaceId ?? '', repositoryPath: workspacePath }, hash, 'mixed');
        if (result.success) {
          notification.success(t('notifications.resetSuccess', { hash: hash.substring(0, 7) }));
          loadBranches();
          loadCommits(selectedBranchName);
        } else notification.error(result.error || 'Reset failed');
      } finally {
        setIsResetting(false);
      }
    },
    [workspacePath, notification, t, selectedBranchName, loadBranches, loadCommits, workspaceId]
  );

  if (!workspacePath) {
    return (
      <div data-openbitfun-component="branches-view" data-openbitfun-part="root" className="openbitfun-git-scene-branches">
        <div data-openbitfun-component="branches-view" data-openbitfun-part="placeholder" className="openbitfun-git-scene-branches__placeholder">
          <Icon name="git" size="lg" />
          <p>{t('tabs.branches')}</p>
          <p className="openbitfun-git-scene-branches__hint">Open a workspace to see branches.</p>
        </div>
      </div>
    );
  }

  return (
    <div data-openbitfun-component="branches-view" data-openbitfun-part="root" className="openbitfun-git-scene-branches">
      <div data-openbitfun-component="branches-view" data-openbitfun-part="left" className="openbitfun-git-scene-branches__left">
        <div data-openbitfun-component="branches-view" data-openbitfun-part="toolbar" className="openbitfun-git-scene-branches__toolbar">
          <div data-openbitfun-component="branches-view" data-openbitfun-part="search" className="openbitfun-git-scene-branches__toolbar-search">
            <SearchField
              size="sm"
              leadingIcon={<Icon name="search" size="sm" aria-hidden />}
              placeholder={t('search.branches')}
              aria-label={t('search.branches')}
              value={branchSearchQuery}
              onValueChange={setBranchSearchQuery}
              clearLabel={branchSearchQuery ? tComponents('search.clear') : undefined}
              onClear={branchSearchQuery ? () => setBranchSearchQuery('') : undefined}
            />
          </div>
          <div data-openbitfun-component="branches-view" data-openbitfun-part="actions" className="openbitfun-git-scene-branches__toolbar-actions">
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<Icon name="plus" size="sm" />}
              onClick={() => handleCreateFrom(branches.find(b => b.current)?.name ?? selectedBranchName ?? '')}
              title={t('dialog.createNewBranch.title')}
            >
              {t('dialog.createNewBranch.confirm')}
            </Button>
          </div>
        </div>
        <ScrollArea data-openbitfun-component="branches-view" data-openbitfun-part="list" className="openbitfun-git-scene-branches__list">
          {branchLoading ? (
            <div data-openbitfun-component="branches-view" data-openbitfun-part="empty" className="openbitfun-git-scene-branches__empty">{t('common.loading')}</div>
          ) : filteredBranches.length === 0 ? (
            <div data-openbitfun-component="branches-view" data-openbitfun-part="empty" className="openbitfun-git-scene-branches__empty">
              {branchSearchQuery ? t('empty.noMatchingBranches') : t('empty.noBranches')}
            </div>
          ) : (
            filteredBranches.map((branch, idx) => (
              <div data-overflow-trigger
                data-openbitfun-component="branches-view"
                data-openbitfun-part="branch"
                data-openbitfun-state={[
                  branch.current && 'current',
                  selectedBranchName === branch.name && 'selected',
                ].filter(Boolean).join(' ') || undefined}
                key={branch.name ?? idx}
                className={`openbitfun-git-scene-branches__row ${branch.current ? 'openbitfun-git-scene-branches__row--current' : ''} ${selectedBranchName === branch.name ? 'openbitfun-git-scene-branches__row--selected' : ''}`}
                onClick={() => handleSelectBranch(branch.name)}
              >
                <div data-openbitfun-component="branches-view" data-openbitfun-part="branchInfo" className="openbitfun-git-scene-branches__info">
                  <Icon name="git" size="sm" />
                  <OverflowText className="openbitfun-git-scene-branches__name">{branch.name}</OverflowText>
                  {branch.current && <span className="openbitfun-git-scene-branches__current-badge">{t('branch.current')}</span>}
                </div>
                <div data-openbitfun-component="branches-view" data-openbitfun-part="branchActions" className="openbitfun-git-scene-branches__actions" onClick={e => e.stopPropagation()}>
                  {!branch.current && (
                    <Tooltip content={t('actions.switchBranch')}>
                      <IconButton
                        aria-label={t('actions.switchBranch')}
                        size="sm"
                        onClick={() => handleSwitchBranch(branch.name)}
                        disabled={isOperating}
                        icon={<Icon name="commit" size="sm" />}
                      />
                    </Tooltip>
                  )}
                  <Tooltip content={t('actions.createBranchFrom')}>
                    <IconButton
                      aria-label={t('actions.createBranchFrom')}
                      size="sm"
                      onClick={() => handleCreateFrom(branch.name)}
                      disabled={isOperating}
                      icon={<Icon name="plus" size="sm" />}
                    />
                  </Tooltip>
                  {!branch.current && (
                    <Tooltip content={t('actions.deleteBranch')}>
                      <IconButton
                        aria-label={t('actions.deleteBranch')}
                        size="sm"
                        onClick={() => handleDeleteBranch(branch.name, !!branch.current)}
                        disabled={isOperating}
                        icon={<Icon name="delete" size="sm" />}
                      />
                    </Tooltip>
                  )}
                </div>
              </div>
            ))
          )}
        </ScrollArea>
      </div>

      <div data-openbitfun-component="branches-view" data-openbitfun-part="right" className="openbitfun-git-scene-branches__right">
        <div data-openbitfun-component="branches-view" data-openbitfun-part="historyToolbar" className="openbitfun-git-scene-branches__history-toolbar">
          <span data-openbitfun-component="branches-view" data-openbitfun-part="historyTitle" className="openbitfun-git-scene-branches__history-title">
            {selectedBranchName ? t('tabs.branchCommitHistory', { branch: selectedBranchName }) : t('tabs.commits')}
          </span>
          <SearchField
            size="sm"
            leadingIcon={<Icon name="search" size="sm" aria-hidden />}
            placeholder={t('search.commits')}
            aria-label={t('search.commits')}
            value={commitSearchQuery}
            onValueChange={setCommitSearchQuery}
            clearLabel={commitSearchQuery ? tComponents('search.clear') : undefined}
            onClear={commitSearchQuery ? () => setCommitSearchQuery('') : undefined}
          />
        </div>
        <ScrollArea data-openbitfun-component="branches-view" data-openbitfun-part="historyList" className="openbitfun-git-scene-branches__history-list">
          {!selectedBranchName ? (
            <div data-openbitfun-component="branches-view" data-openbitfun-part="empty" className="openbitfun-git-scene-branches__empty">{t('empty.noCommits')}</div>
          ) : commitLoading ? (
            <div data-openbitfun-component="branches-view" data-openbitfun-part="empty" className="openbitfun-git-scene-branches__empty">{t('common.loading')}</div>
          ) : filteredCommits.length === 0 ? (
            <div data-openbitfun-component="branches-view" data-openbitfun-part="empty" className="openbitfun-git-scene-branches__empty">
              {commitSearchQuery ? t('empty.noMatchingCommits') : t('empty.noCommits')}
            </div>
          ) : (
            filteredCommits.map((commit, idx) => {
              const isExpanded = expandedCommits.has(commit.hash);
              const msg = commit.message ?? '';
              const summary = msg.split('\n')[0];
              const body = msg.split('\n').slice(1).join('\n').trim();
              const author = (commit as any).author?.name ?? (commit as any).author ?? t('common.unknown');
              const files = commit.files;
              return (
                <div data-openbitfun-component="branches-view" data-openbitfun-part="commit" data-openbitfun-state={isExpanded ? 'expanded' : undefined}
                  key={commit.hash ?? idx}
                  className={`openbitfun-git-scene-branches__commit ${isExpanded ? 'openbitfun-git-scene-branches__commit--expanded' : ''}`}
                >
                  <div data-overflow-trigger data-openbitfun-component="branches-view" data-openbitfun-part="commitHeader" className="openbitfun-git-scene-branches__commit-header" onClick={() => toggleCommitExpand(commit.hash)}>
                    <button type="button" className="openbitfun-git-scene-branches__expand">
                      {isExpanded ? <Icon name="chevron-down" size="xs" /> : <Icon name="chevron-right" size="xs" />}
                    </button>
                    <div data-openbitfun-component="branches-view" data-openbitfun-part="commitInfo" className="openbitfun-git-scene-branches__commit-info">
                      <div className="openbitfun-git-scene-branches__commit-message"><OverflowText>{summary}</OverflowText></div>
                      <div className="openbitfun-git-scene-branches__commit-meta">
                        {author} · {commit.hash?.substring(0, 7)}
                      </div>
                    </div>
                    <div data-openbitfun-component="branches-view" data-openbitfun-part="commitActions" className="openbitfun-git-scene-branches__commit-actions" onClick={e => e.stopPropagation()}>
                      <Tooltip content={t('actions.copyCommitHash')}>
                        <IconButton
                          aria-label={t('actions.copyCommitHash')}
                          size="sm"
                          onClick={() => handleCopyHash(commit.hash)}
                          icon={<Icon name="duplicate" size="sm" />}
                        />
                      </Tooltip>
                      <Tooltip content={t('actions.resetToCommit')}>
                        <IconButton
                          aria-label={t('actions.resetToCommit')}
                          size="sm"
                          onClick={() => handleResetToCommit(commit.hash)}
                          disabled={isResetting}
                          icon={<RotateCcw size={14} />}
                        />
                      </Tooltip>
                    </div>
                  </div>
                  {isExpanded && (
                    <div data-openbitfun-component="branches-view" data-openbitfun-part="commitDetails" className="openbitfun-git-scene-branches__commit-detail">
                      {body && <pre className="openbitfun-git-scene-branches__commit-body">{body}</pre>}
                      {files && files.length > 0 && (
                        <div className="openbitfun-git-scene-branches__files">
                          <span>
                            <FileText size={12} /> {t('commit.changedFiles', { count: files.length })}
                          </span>
                          <ul>
                            {(files as GitFileChange[]).map((file, i) => (
                              <li key={i}>{file.path}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      <CreateBranchDialog
        isOpen={showCreateDialog}
        baseBranch={baseBranch}
        onConfirm={handleCreateConfirm}
        onCancel={() => {
          setShowCreateDialog(false);
          setBaseBranch('');
        }}
        isCreating={isOperating}
        existingBranches={branches.map(b => b.name).filter((n): n is string => Boolean(n))}
      />
    </div>
  );
};

export default BranchesView;
