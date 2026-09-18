/**
 * Branch selection modal
 * Supports selecting existing branches or creating new branches
 */

import { OverflowText, Button, Checkbox, Icon, IconButton, Input, ScrollArea, Tooltip } from '@openbitfun/ui';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
;
import { createLogger } from '@/shared/utils/logger';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { RetainedMountBoundary, DEFAULT_RETAINED_MOUNT_MS } from '@/shared/presence';
import { useI18n } from '@/infrastructure/i18n';
import { gitAPI, type GitBranch as GitBranchType } from '../../../infrastructure/api/service-api/GitAPI';
import './BranchSelectModal.scss';

const log = createLogger('BranchSelectModal');

type SelectableBranch = GitBranchType & {
  isCurrent?: boolean;
  hasWorktree?: boolean;
};

export interface BranchSelectResult {
  branch: string;
  isNew: boolean;
  openAfterCreate: boolean;
}

export interface BranchSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (result: BranchSelectResult) => void;
  repositoryPath: string;
  workspaceId: string;
  title?: string;
  currentBranch?: string;
  existingWorktreeBranches?: string[];
  showOpenAfterCreate?: boolean;
  defaultOpenAfterCreate?: boolean;
}

export const BranchSelectModal: React.FC<BranchSelectModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  repositoryPath,
  workspaceId,
  title,
  currentBranch,
  existingWorktreeBranches = [],
  showOpenAfterCreate = false,
  defaultOpenAfterCreate = false,
}) => {
  const { t } = useI18n('panels/git');
  const { t: tCommon } = useI18n('common');
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [isNewBranch, setIsNewBranch] = useState(false);
  const [openAfterCreate, setOpenAfterCreate] = useState(defaultOpenAfterCreate);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolvedTitle = title ?? t('branchSelect.title');
  const retainedDisplayRef = useRef({
    title: resolvedTitle,
    currentBranch,
    existingWorktreeBranches,
    showOpenAfterCreate,
  });

  if (isOpen) {
    retainedDisplayRef.current = {
      title: resolvedTitle,
      currentBranch,
      existingWorktreeBranches,
      showOpenAfterCreate,
    };
  }

  const retainedDisplay = retainedDisplayRef.current;

  useEffect(() => {
    if (!isOpen) {
      const resetTimer = window.setTimeout(() => {
        setSearchTerm('');
        setSelectedBranch(null);
        setIsNewBranch(false);
        setOpenAfterCreate(defaultOpenAfterCreate);
        setError(null);
      }, DEFAULT_RETAINED_MOUNT_MS);
      return () => window.clearTimeout(resetTimer);
    }

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => window.clearTimeout(focusTimer);
  }, [defaultOpenAfterCreate, isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isImeOwnedKeyboardEvent(e)) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const loadBranches = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const branchList = await gitAPI.getBranches({ workspaceId, repositoryPath }, false);
      setBranches(branchList);
    } catch (err) {
      log.error('Failed to load branches', err);
      setError(t('branchSelect.errors.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [repositoryPath, t, workspaceId]);

  useEffect(() => {
    if (isOpen && repositoryPath) {
      void loadBranches();
    }
  }, [isOpen, loadBranches, repositoryPath]);

  const filteredBranches = useMemo<SelectableBranch[]>(() => {
    let result = branches;

    if (searchTerm.trim()) {
      const lowerSearch = searchTerm.toLowerCase();
      result = result.filter(branch =>
        branch.name.toLowerCase().includes(lowerSearch)
      );
    }

    const availableBranches: SelectableBranch[] = [];
    const unavailableBranches: SelectableBranch[] = [];
    const existingWorktreeSet = new Set(retainedDisplay.existingWorktreeBranches);

    result.forEach(branch => {
      const isCurrent = branch.name === retainedDisplay.currentBranch;
      const hasWorktree = existingWorktreeSet.has(branch.name);

      if (isCurrent || hasWorktree) {
        unavailableBranches.push({ ...branch, isCurrent, hasWorktree });
      } else {
        availableBranches.push(branch);
      }
    });

    return [...availableBranches, ...unavailableBranches];
  }, [branches, retainedDisplay.currentBranch, retainedDisplay.existingWorktreeBranches, searchTerm]);

  const canCreateNewBranch = useMemo(() => {
    if (!searchTerm.trim()) return false;
    const exists = branches.some(
      branch => branch.name.toLowerCase() === searchTerm.toLowerCase()
    );
    return !exists;
  }, [branches, searchTerm]);

  const handleSelectBranch = useCallback((branchName: string, isNew: boolean) => {
    setSelectedBranch(branchName);
    setIsNewBranch(isNew);
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedBranch) {
      onSelect({
        branch: selectedBranch,
        isNew: isNewBranch,
        openAfterCreate,
      });
      onClose();
    }
  }, [selectedBranch, isNewBranch, onClose, onSelect, openAfterCreate]);

  const handleDoubleClick = useCallback((branchName: string, isNew: boolean) => {
    onSelect({
      branch: branchName,
      isNew: isNew,
      openAfterCreate,
    });
    onClose();
  }, [onClose, onSelect, openAfterCreate]);

  const modalContent = (
    <div
      data-openbitfun-component="branch-select-modal"
      data-openbitfun-part="overlay"
      data-state={isOpen ? 'open' : 'closed'}
      aria-hidden={!isOpen}
      {...(!isOpen ? { inert: '' } : {})}
      className="branch-select-overlay"
      onClick={onClose}
    >
      <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="root" className="branch-select-dialog" onClick={(e) => e.stopPropagation()}>
        <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="header" className="branch-select-dialog__header">
          <h2 className="branch-select-dialog__title">{retainedDisplay.title}</h2>
          <Tooltip content={tCommon('actions.close')}>
            <IconButton
              className="branch-select-dialog__close"
              data-openbitfun-component="branch-select-modal"
              data-openbitfun-part="close"
              icon={<Icon name="xmark" size="lg" />}
              onClick={onClose}
              size="sm"
              aria-label={tCommon('actions.close')}
            />
          </Tooltip>
        </div>

        <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="content" className="branch-select-dialog__content">
          <div className="branch-select-dialog__input-wrapper">
            <Input
              data-openbitfun-component="branch-select-modal"
              data-openbitfun-part="input"
              ref={inputRef}
              type="text"
              placeholder={t('branchSelect.inputPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="branch-select-dialog__input"
            />
          </div>

          {error && (
            <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="error" className="branch-select-dialog__error">
              {error}
            </div>
          )}

          <ScrollArea data-openbitfun-component="branch-select-modal" data-openbitfun-part="list" className="branch-select-dialog__list">
            {isLoading ? (
              <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="loading" className="branch-select-dialog__loading">
                <div className="branch-select-dialog__loading-dots">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                  <span>{t('branchSelect.loading')}</span>
              </div>
            ) : (
              <>
                {canCreateNewBranch && (
                  <div data-overflow-trigger
                    data-openbitfun-component="branch-select-modal"
                    data-openbitfun-part="item"
                    data-openbitfun-state={selectedBranch === searchTerm && isNewBranch ? 'selected' : undefined}
                    className={`branch-select-dialog__item branch-select-dialog__item--new ${
                      selectedBranch === searchTerm && isNewBranch ? 'selected' : ''
                    }`}
                    onClick={() => handleSelectBranch(searchTerm.trim(), true)}
                    onDoubleClick={() => handleDoubleClick(searchTerm.trim(), true)}
                  >
                    <Icon name="plus" size="sm" className="branch-select-dialog__item-icon branch-select-dialog__item-icon--new" />
                    <OverflowText behavior="marquee" data-openbitfun-component="branch-select-modal" data-openbitfun-part="itemName" className="branch-select-dialog__item-name">
                      {t('branchSelect.createNewLabel')} <strong>{searchTerm.trim()}</strong>
                    </OverflowText>
                  </div>
                )}

                {filteredBranches.map((branch) => {
                  const isDisabled = branch.isCurrent || branch.hasWorktree;
                  const hasWorktree = branch.hasWorktree;

                  return (
                    <div data-overflow-trigger data-openbitfun-component="branch-select-modal" data-openbitfun-part="item"
                      data-openbitfun-state={[
                        selectedBranch === branch.name && !isNewBranch && 'selected',
                        branch.current && 'current',
                      ].filter(Boolean).join(' ') || undefined}
                      key={branch.name}
                      className={`branch-select-dialog__item ${
                        selectedBranch === branch.name && !isNewBranch ? 'selected' : ''
                      } ${branch.current ? 'current' : ''} ${isDisabled ? 'disabled' : ''}`}
                      onClick={() => !isDisabled && handleSelectBranch(branch.name, false)}
                      onDoubleClick={() => !isDisabled && handleDoubleClick(branch.name, false)}
                    >
                      <Icon name="git" size="sm" className="branch-select-dialog__item-icon" />
                      <OverflowText data-openbitfun-component="branch-select-modal" data-openbitfun-part="itemName" className="branch-select-dialog__item-name">
                        {branch.name}
                      </OverflowText>
                      {branch.current && (
                        <span data-openbitfun-component="branch-select-modal" data-openbitfun-part="badge" className="branch-select-dialog__item-badge">{t('branch.current')}</span>
                      )}
                      {hasWorktree && !branch.current && (
                        <span data-openbitfun-component="branch-select-modal" data-openbitfun-part="badge" className="branch-select-dialog__item-badge branch-select-dialog__item-badge--worktree">
                          {t('branchSelect.badges.inUse')}
                        </span>
                      )}
                    </div>
                  );
                })}

                {filteredBranches.length === 0 && !canCreateNewBranch && (
                  <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="empty" className="branch-select-dialog__empty">
                    {searchTerm ? t('empty.noMatchingBranches') : t('empty.noBranches')}
                  </div>
                )}
              </>
            )}
          </ScrollArea>
        </div>

        <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="footer" className="branch-select-dialog__footer">
          {retainedDisplay.showOpenAfterCreate ? (
            <div data-openbitfun-component="branch-select-modal" data-openbitfun-part="options" className="branch-select-dialog__options">
              <Checkbox
                checked={openAfterCreate}
                onChange={(event) => setOpenAfterCreate(event.target.checked)}
                label={t('branchSelect.openAfterCreate.label')}
                description={t('branchSelect.openAfterCreate.description')}
              />
            </div>
          ) : null}
          <Button
            variant="fill"
            onClick={onClose}
          >
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!selectedBranch}
          >
            {tCommon('actions.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );

  const retainedModal = (
    <RetainedMountBoundary present={isOpen}>
      {modalContent}
    </RetainedMountBoundary>
  );

  if (typeof document === 'undefined') {
    return retainedModal;
  }

  return createPortal(retainedModal, getAppearanceOverlayHost());
};

export default BranchSelectModal;
