import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/** Searchable branch picker with guarded checkout and commit-then-switch recovery. */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { OverflowText,
  Button,
  Icon,
  Input,
  Listbox,
  ListboxEmpty,
  ListboxOption,
  SearchField,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  useDismissibleLayer,
  usePresence,
} from '@openbitfun/ui';
import { Loader2 } from 'lucide-react';

import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system/services/NotificationService';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { createLogger } from '@/shared/utils/logger';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { gitEventService, gitService } from '@/tools/git/services';
import { gitStateManager } from '@/tools/git/state/GitStateManager';
import type { GitBranch } from '@/tools/git/types/repository';
import {
  fallbackChangedPaths,
  mergeBranchSwitchFileStats,
  parseCheckoutOverwriteFailure,
  parseUnifiedDiffStats,
  type BranchSwitchFileStats,
} from './branchSwitchFailure';
import { useStableGitWorkspaceScope } from '../hooks/useStableGitWorkspaceScope';
import './BranchQuickSwitch.scss';

const log = createLogger('BranchQuickSwitch');

interface BranchSwitchBlocker {
  files: string[];
  stats: Map<string, BranchSwitchFileStats>;
  targetBranch: string;
}

export interface BranchQuickSwitchProps {
  id?: string;
  isOpen: boolean;
  onClose: () => void;
  repositoryPath: GitWorkspaceScope;
  currentBranch: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSwitchSuccess?: (branchName: string) => void;
}

const branchListFromCache = (repositoryPath: GitWorkspaceScope): GitBranch[] | undefined => (
  gitStateManager.getState(repositoryPath)?.branches
);

export const BranchQuickSwitch: React.FC<BranchQuickSwitchProps> = ({
  id,
  isOpen,
  onClose,
  repositoryPath: workspaceReference,
  currentBranch,
  anchorRef,
  onSwitchSuccess,
}) => {
  const repositoryPath = useStableGitWorkspaceScope(workspaceReference);
  const { t } = useI18n('panels/git');
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [blocker, setBlocker] = useState<BranchSwitchBlocker | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitCreated, setCommitCreated] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [inputCompositionActive, setInputCompositionActive] = useState(false);
  const { present, state: phase } = usePresence(isOpen, 100);

  const inputRef = useRef<HTMLInputElement>(null);
  const commitInputRef = useRef<HTMLInputElement>(null);
  const conflictConfirmRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const switchInFlightRef = useRef(false);

  const filteredBranches = useMemo(() => {
    const lowerSearch = searchTerm.trim().toLowerCase();
    const filtered = lowerSearch
      ? branches.filter(branch => branch.name.toLowerCase().includes(lowerSearch))
      : branches;
    return [...filtered].sort((left, right) => {
      if (left.current) return -1;
      if (right.current) return 1;
      return left.name.localeCompare(right.name);
    });
  }, [branches, searchTerm]);

  const popoverLayout = useAnchoredPopoverPosition({
    open: present,
    anchorRef,
    popoverRef: layerRef,
    preferredPlacement: 'top',
    alignment: 'start',
    gap: 7,
    layoutRevision: `${isLoading}:${loadFailed}:${filteredBranches.length}`,
  });

  const closePicker = useCallback((restoreFocus = true) => {
    const panel = panelRef.current;
    // Async checkout must not take focus back after the user left the picker.
    if (restoreFocus && panel?.contains(panel.ownerDocument.activeElement)) {
      anchorRef.current?.focus({ preventScroll: true });
    }
    onClose();
  }, [anchorRef, onClose]);

  useDismissibleLayer({
    enabled: isOpen,
    layerRef,
    branchRefs: [anchorRef],
    dismissOnEscape: !inputCompositionActive,
    onDismiss: reason => closePicker(reason !== 'pointer-outside'),
  });
  const focusReady = isOpen && present && Boolean(popoverLayout);
  useLayoutEffect(() => {
    if (focusReady) inputRef.current?.focus({ preventScroll: true });
  }, [focusReady]);

  const loadBranches = useCallback(async () => {
    setIsLoading(true);
    setLoadFailed(false);
    try {
      const cachedBranches = branchListFromCache(repositoryPath);
      if (cachedBranches?.length) setBranches(cachedBranches);

      await gitStateManager.refresh(repositoryPath, {
        layers: ['detailed'],
        force: true,
        silent: true,
        reason: 'manual',
        source: 'branch_quick_switch',
      });
      const refreshedBranches = branchListFromCache(repositoryPath);
      if (refreshedBranches) {
        setBranches(refreshedBranches);
        return;
      }

      const serviceBranches = await gitService.getBranches(repositoryPath, false);
      setBranches(serviceBranches);
    } catch (error) {
      log.error('Failed to load branches', { repositoryPath, error });
      setLoadFailed(true);
      if (!branchListFromCache(repositoryPath)?.length) setBranches([]);
    } finally {
      setIsLoading(false);
    }
  }, [repositoryPath]);

  useEffect(() => {
    if (!present) {
      setSearchTerm('');
      setSelectedIndex(0);
      setInputCompositionActive(false);
    }
  }, [present]);

  useEffect(() => {
    if (!isOpen) return;
    void loadBranches();
  }, [isOpen, loadBranches]);

  useEffect(() => {
    setBlocker(null);
    setCommitDialogOpen(false);
    setCommitMessage('');
    setCommitError(null);
    setCommitCreated(false);
  }, [repositoryPath]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredBranches.length, searchTerm]);

  useEffect(() => {
    const items = listRef.current?.querySelectorAll<HTMLElement>(
      '[data-openbitfun-part="option"]',
    );
    const selectedItem = items?.[selectedIndex];
    if (typeof selectedItem?.scrollIntoView === 'function') {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [filteredBranches.length, selectedIndex]);

  const completeSwitch = useCallback((branchName: string) => {
    notificationService.success(
      t('quickSwitch.notifications.switchSuccess', { branch: branchName }),
      { duration: 3000 },
    );
    gitEventService.emit('branch:changed', {
      repositoryPath,
      branch: {
        name: branchName,
        current: true,
        remote: false,
        ahead: 0,
        behind: 0,
      },
      timestamp: new Date(),
    });
    setBlocker(null);
    setCommitDialogOpen(false);
    setCommitMessage('');
    setCommitError(null);
    setCommitCreated(false);
    onSwitchSuccess?.(branchName);
    closePicker();
  }, [closePicker, onSwitchSuccess, repositoryPath, t]);

  const loadBlockerStats = useCallback(async (targetBranch: string, files: string[]) => {
    if (files.length === 0) return;
    try {
      const [unstagedDiff, stagedDiff] = await Promise.all([
        gitService.getDiff(repositoryPath, { files, staged: false }),
        gitService.getDiff(repositoryPath, { files, staged: true }),
      ]);
      const stats = mergeBranchSwitchFileStats(
        parseUnifiedDiffStats(unstagedDiff),
        parseUnifiedDiffStats(stagedDiff),
      );
      setBlocker(current => current?.targetBranch === targetBranch
        ? { ...current, stats }
        : current);
    } catch (error) {
      // The checkout diagnostic remains authoritative even if a remote Git
      // host cannot provide the optional diff decoration.
      log.warn('Failed to load branch switch diff stats', {
        repositoryPath,
        targetBranch,
        error,
      });
    }
  }, [repositoryPath]);

  const showSwitchFailure = useCallback((targetBranch: string, error?: string) => {
    const overwrite = parseCheckoutOverwriteFailure(error);
    if (overwrite) {
      const files = overwrite.files.length > 0
        ? overwrite.files
        : fallbackChangedPaths(gitStateManager.getState(repositoryPath));
      setBlocker({ targetBranch, files, stats: new Map() });
      setCommitDialogOpen(false);
      setCommitMessage('');
      setCommitError(null);
      setCommitCreated(false);
      closePicker();
      void loadBlockerStats(targetBranch, files);
      return;
    }

    const lowerError = error?.toLowerCase() ?? '';
    let errorMessage = error
      ? t('quickSwitch.errors.switchFailedWithMessage', { error })
      : t('quickSwitch.errors.switchFailed');
    if (lowerError.includes('resolve your current index first')) {
      errorMessage = t('quickSwitch.errors.indexConflict');
    }
    notificationService.error(errorMessage, {
      title: t('quickSwitch.errors.title'),
      duration: 5000,
    });
  }, [closePicker, loadBlockerStats, repositoryPath, t]);

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    if (
      branchName === currentBranch
      || switchInFlightRef.current
    ) return;

    switchInFlightRef.current = true;
    setIsSwitching(true);
    setSwitchingBranch(branchName);
    try {
      const result = await gitService.checkoutBranch(repositoryPath, branchName);
      if (result.success) {
        completeSwitch(branchName);
      } else {
        showSwitchFailure(branchName, result.error);
      }
    } catch (error) {
      log.error('Failed to switch branch', { repositoryPath, branchName, error });
      notificationService.error(t('quickSwitch.errors.unexpected'), { duration: 5000 });
    } finally {
      switchInFlightRef.current = false;
      setIsSwitching(false);
      setSwitchingBranch(null);
    }
  }, [completeSwitch, currentBranch, repositoryPath, showSwitchFailure, t]);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (
      (event.key === 'Enter' || event.key === 'Escape')
      && isImeOwnedKeyboardEvent(event, inputCompositionActive)
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'Tab') {
      // Resume the page's tab order at the trigger, outside the portal.
      closePicker();
      return;
    }
    if (filteredBranches.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex(current => Math.min(current + 1, filteredBranches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex(current => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = filteredBranches[selectedIndex];
      if (selected && !selected.current) void handleSwitchBranch(selected.name);
    }
  }, [closePicker, filteredBranches, handleSwitchBranch, inputCompositionActive, selectedIndex]);

  const closeRecoveryDialogs = useCallback(() => {
    if (isCommitting) return;
    setBlocker(null);
    setCommitDialogOpen(false);
    setCommitMessage('');
    setCommitError(null);
    setCommitCreated(false);
  }, [isCommitting]);

  const handleCommitAndSwitch = useCallback(async () => {
    const targetBranch = blocker?.targetBranch;
    const message = commitMessage.trim();
    if (!targetBranch || isCommitting) return;
    if (!commitCreated && !message) {
      setCommitError(t('quickSwitch.conflict.commitMessageRequired'));
      commitInputRef.current?.focus();
      return;
    }

    setIsCommitting(true);
    setCommitError(null);
    try {
      if (!commitCreated) {
        const stageResult = await gitService.addFiles(repositoryPath, {
          files: [],
          all: true,
        });
        if (!stageResult.success) {
          setCommitError(t('quickSwitch.conflict.stageFailed', {
            error: stageResult.error ?? t('quickSwitch.errors.unexpected'),
          }));
          return;
        }

        const commitResult = await gitService.commit(repositoryPath, { message });
        if (!commitResult.success) {
          setCommitError(t('quickSwitch.conflict.commitFailed', {
            error: commitResult.error ?? t('quickSwitch.errors.unexpected'),
          }));
          return;
        }
        setCommitCreated(true);
      }

      const checkoutResult = await gitService.checkoutBranch(repositoryPath, targetBranch);
      if (!checkoutResult.success) {
        setCommitError(t('quickSwitch.conflict.retryFailed', {
          error: checkoutResult.error ?? t('quickSwitch.errors.switchFailed'),
        }));
        return;
      }

      completeSwitch(targetBranch);
    } catch (error) {
      log.error('Failed to commit and switch branch', {
        repositoryPath,
        targetBranch,
        error,
      });
      setCommitError(t('quickSwitch.errors.unexpected'));
    } finally {
      setIsCommitting(false);
      if (blocker) {
        void gitStateManager.refresh(repositoryPath, {
          layers: ['basic', 'status'],
          force: true,
          silent: true,
          reason: 'operation',
          source: 'branch_commit_and_switch',
        });
      }
    }
  }, [
    blocker,
    commitCreated,
    commitMessage,
    completeSwitch,
    isCommitting,
    repositoryPath,
    t,
  ]);

  const popover = present ? (
    <div
      id={id}
      ref={panelRef}
      className="branch-quick-switch"
      data-openbitfun-product-component="branch-quick-switch"
      data-openbitfun-product-part="root"
      data-testid="branch-quick-switch"
      data-motion="presence"
      role="dialog"
      aria-modal={false}
      aria-label={t('quickSwitch.menuLabel')}
      onKeyDown={handleListKeyDown}
    >
      <div
        className="branch-quick-switch__search"
        data-openbitfun-product-component="branch-quick-switch"
        data-openbitfun-product-part="search"
      >
        <SearchField
          ref={inputRef}
          className="branch-quick-switch__input-field"
          leadingIcon={<Icon name="search" size="sm" aria-hidden />}
          aria-label={t('quickSwitch.searchLabel')}
          placeholder={t('quickSwitch.searchPlaceholder')}
          value={searchTerm}
          onValueChange={setSearchTerm}
          onCompositionStart={() => setInputCompositionActive(true)}
          onCompositionEnd={() => setInputCompositionActive(false)}
          data-openbitfun-product-component="branch-quick-switch"
          data-openbitfun-product-part="input"
        />
      </div>
      <Listbox
        ref={listRef}
        aria-label={t('quickSwitch.menuLabel')}
        className="branch-quick-switch__list"
        focusMode="virtual"
      >
        {isLoading && branches.length === 0 ? (
          <ListboxEmpty
            className="branch-quick-switch__loading"
            data-openbitfun-product-component="branch-quick-switch"
            data-openbitfun-product-part="loading"
          >
            <Loader2 size={16} className="branch-quick-switch__spinner" aria-hidden />
            <span>{t('quickSwitch.loading')}</span>
          </ListboxEmpty>
        ) : loadFailed && branches.length === 0 ? (
          <ListboxEmpty
            className="branch-quick-switch__empty"
            data-openbitfun-product-component="branch-quick-switch"
            data-openbitfun-product-part="empty"
            aria-live="polite"
          >
            {t('quickSwitch.errors.loadFailed')}
          </ListboxEmpty>
        ) : filteredBranches.length === 0 ? (
          <ListboxEmpty
            className="branch-quick-switch__empty"
            data-openbitfun-product-component="branch-quick-switch"
            data-openbitfun-product-part="empty"
          >
            {searchTerm ? t('empty.noMatchingBranches') : t('empty.noBranches')}
          </ListboxEmpty>
        ) : (
          filteredBranches.map((branch, index) => (
            <ListboxOption
              active={index === selectedIndex}
              className="branch-quick-switch__item"
              data-index={index}
              data-openbitfun-state={branch.current ? 'current' : undefined}
              data-testid={`branch-quick-switch-option-${branch.name}`}
              disabled={isSwitching}
              indicator={switchingBranch === branch.name
                ? <Loader2 size={14} className="branch-quick-switch__spinner" aria-hidden />
                : undefined}
              key={branch.name}
              leading={<Icon name="git" size="sm" aria-hidden />}
              onClick={() => void handleSwitchBranch(branch.name)}
              selected={branch.current}
              value={branch.name}
            >
              {branch.name}
            </ListboxOption>
          ))
        )}
      </Listbox>
    </div>
  ) : null;

  return (
    <>
      {popover && createPortal(
        <div
          ref={layerRef}
          className="branch-quick-switch__layer"
          data-openbitfun-native-webview-occlusion
          data-openbitfun-placement={popoverLayout?.placement ?? 'top'}
          data-state={phase}
          data-motion="presence"
          aria-hidden={!isOpen || undefined}
          {...(!isOpen ? { inert: '' } : {})}
          style={{
            top: popoverLayout?.bottom === undefined ? `${popoverLayout?.top ?? 0}px` : undefined,
            bottom: popoverLayout?.bottom === undefined ? undefined : `${popoverLayout.bottom}px`,
            left: `${popoverLayout?.left ?? 0}px`,
            visibility: popoverLayout ? 'visible' : 'hidden',
          }}
        >
          {popover}
        </div>,
        getAppearanceOverlayHost(),
      )}

      <Dialog
        open={!!blocker && !commitDialogOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) closeRecoveryDialogs(); }}
        size="sm"
        role="alertdialog"
        closeOnEscape={!isCommitting}
        closeOnPointerOutside={!isCommitting}
        initialFocusRef={conflictConfirmRef}
        className="branch-switch-conflict-dialog"
        data-testid="branch-switch-conflict-dialog"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('quickSwitch.conflict.title')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        {blocker ? (
          <div className="branch-switch-conflict-dialog__content">
            <p>{t('quickSwitch.conflict.description')}</p>
            {blocker.files.length > 0 ? (
              <div
                className="branch-switch-conflict-dialog__files"
                data-testid="branch-switch-conflict-files"
                role="list"
              >
                {blocker.files.map(file => {
                  const stats = blocker.stats.get(file);
                  return (
                    <div className="branch-switch-conflict-dialog__file" key={file} role="listitem">
                      <OverflowText className="branch-switch-conflict-dialog__file-path" title={file}>
                        {file}
                      </OverflowText>
                      {stats ? (
                        <span className="branch-switch-conflict-dialog__file-stats">
                          <span className="branch-switch-conflict-dialog__additions">
                            +{stats.additions}
                          </span>
                          <span className="branch-switch-conflict-dialog__deletions">
                            −{stats.deletions}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>{t('quickSwitch.conflict.filesUnavailable')}</p>
            )}
            <p>{t('quickSwitch.conflict.instruction')}</p>
          </div>
        ) : null}
              </DialogBody>
        <DialogFooter>{(
          <>
            <Button variant="fill" disabled={isCommitting} onClick={closeRecoveryDialogs}>
              {t('quickSwitch.conflict.cancel')}
            </Button>
            <Button
              ref={conflictConfirmRef}
              variant="primary"
              disabled={isCommitting}
              data-testid="branch-switch-conflict-confirm"
              onClick={() => {
                setCommitDialogOpen(true);
                setCommitError(null);
                setCommitCreated(false);
              }}
            >
              {t('quickSwitch.conflict.commitAndSwitch')}
            </Button>
          </>
        )}</DialogFooter>
      </Dialog>

      <Dialog
        open={!!blocker && commitDialogOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) closeRecoveryDialogs(); }}
        size="md"
        closeOnEscape={!isCommitting}
        closeOnPointerOutside={!isCommitting}
        initialFocusRef={commitInputRef}
        className="branch-switch-commit-dialog"
        data-testid="branch-switch-commit-dialog"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('quickSwitch.conflict.commitTitle', {
          branch: blocker?.targetBranch ?? '',
        })}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        <div className="branch-switch-commit-dialog__content">
          <p>
            {t(
              commitCreated
                ? 'quickSwitch.conflict.retryDescription'
                : 'quickSwitch.conflict.commitDescription',
              { branch: blocker?.targetBranch ?? '' },
            )}
          </p>
          <Input
            className="branch-switch-commit-dialog__input"
            ref={commitInputRef}
            value={commitMessage}
            placeholder={t('quickSwitch.conflict.commitMessagePlaceholder')}
            aria-label={t('quickSwitch.conflict.commitMessageLabel')}
            disabled={isCommitting || commitCreated}
            invalid={!!commitError}
            onChange={event => {
              setCommitMessage(event.target.value);
              if (commitError) setCommitError(null);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !isCommitting) {
                event.preventDefault();
                void handleCommitAndSwitch();
              }
            }}
          />
          {commitError ? (
            <p className="branch-switch-commit-dialog__error" role="alert">
              {commitError}
            </p>
          ) : null}
        </div>
              </DialogBody>
        <DialogFooter>{(
          <>
            <Button variant="fill" disabled={isCommitting} onClick={closeRecoveryDialogs}>
              {t('quickSwitch.conflict.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={isCommitting}
              disabled={isCommitting || (!commitCreated && !commitMessage.trim())}
              onClick={() => void handleCommitAndSwitch()}
              data-testid="branch-switch-commit-confirm"
            >
              {t(
                commitCreated
                  ? 'quickSwitch.conflict.retrySwitchAction'
                  : 'quickSwitch.conflict.commitAction',
              )}
            </Button>
          </>
        )}</DialogFooter>
      </Dialog>
    </>
  );
};

BranchQuickSwitch.displayName = 'BranchQuickSwitch';

export default BranchQuickSwitch;
