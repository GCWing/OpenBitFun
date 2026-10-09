import '@/app/scenes/settings/pages/tools/QuickActionsSettingsSection.scss';
import { ConfigLoadingState, ConfigPageSection, ConfigPageSectionStack, ConfigRetryState } from '@/infrastructure/config/components/common';
import {
  aiExperienceConfigService,
  DEFAULT_QUICK_ACTIONS,
  type AIExperienceSettingsPatch,
  type QuickAction,
} from '@/infrastructure/config/services/AIExperienceConfigService';
import {
  normalizeQuickActionTextForStorage,
  resolveQuickActionText,
} from '@/infrastructure/config/services/quickActionLocalization';
import {
  requestSettingsDraftExit,
  useSettingsDraft,
} from '@/infrastructure/config/settingsDraftRegistry';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Icon,
  IconButton,
  Input,
  OverflowText,
  Switch,
  Textarea,
  Tooltip,
} from '@openbitfun/ui';
import { GitPullRequest, Zap } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('QuickActionsSettingsSection');

const BUILTIN_IDS = new Set(['commit', 'create_pr']);

type TranslationFn = (key: string, options?: Record<string, unknown>) => string;

function getActionIcon(id: string, size = 15) {
  if (id === 'commit') return <Icon name="commit" size="lg" style={{ width: size, height: size }} />;
  if (id === 'create_pr') return <GitPullRequest size={size} />;
  return <Zap size={size} />;
}

// ── ActionFormModal ─────────────────────────────────────────────────────────

interface ActionFormModalProps {
  isOpen: boolean;
  /** undefined = create mode, QuickAction = edit mode */
  target: QuickAction | undefined;
  onClose: () => void;
  onSubmit: (label: string, prompt: string) => Promise<boolean>;
  saving: boolean;
  t: TranslationFn;
}

const ActionFormModal: React.FC<ActionFormModalProps> = ({ isOpen, target, onClose, onSubmit, saving, t }) => {
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [initialValues, setInitialValues] = useState({ label: '', prompt: '' });
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Sync form when target changes or modal opens.
  useEffect(() => {
    if (!isOpen) return undefined;
    const targetText = target ? resolveQuickActionText(target, t) : undefined;
    const nextValues = {
      label: targetText?.label ?? '',
      prompt: targetText?.prompt ?? '',
    };
    setLabel(nextValues.label);
    setPrompt(nextValues.prompt);
    setInitialValues(nextValues);
    // Delay focus so the modal animation completes first.
    const focusTimer = window.setTimeout(() => labelInputRef.current?.focus(), 80);
    return () => window.clearTimeout(focusTimer);
  }, [isOpen, t, target]);

  const canSubmit = label.trim().length > 0 && prompt.trim().length > 0;
  const dirty = label !== initialValues.label || prompt !== initialValues.prompt;
  const isEdit = !!target;

  const discardDraft = useCallback(() => {
    setLabel(initialValues.label);
    setPrompt(initialValues.prompt);
  }, [initialValues]);

  useSettingsDraft({
    id: 'quick-action-editor',
    pageId: 'tools.automation',
    label: isEdit ? t('modal.editTitle') : t('modal.addTitle'),
    dirty,
    saving,
    save: () => canSubmit && onSubmit(label.trim(), prompt.trim()),
    discard: discardDraft,
    enabled: isOpen,
  });

  const requestClose = () => {
    if (saving) return;
    requestSettingsDraftExit(['quick-action-editor'], onClose);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !saving) { requestClose(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit && !saving) {
      e.preventDefault();
      void onSubmit(label.trim(), prompt.trim());
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}
      size="md"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{isEdit ? t('modal.editTitle') : t('modal.addTitle')}</DialogTitle>
        </DialogHeading>
        <DialogClose disabled={saving} />
      </DialogHeader>
      <DialogBody>
        <div className="quick-actions-config__modal-body" onKeyDown={handleKeyDown} data-openbitfun-component="quick-actions-config" data-openbitfun-part="dialog">
          {target && (
            <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="dialogIcon" className="quick-actions-config__modal-icon-preview">
              <div className="quick-actions-config__modal-action-icon">
                {getActionIcon(target.id, 18)}
              </div>
            </div>
          )}

          <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="field" className="quick-actions-config__modal-field">
            <label className="quick-actions-config__modal-label" htmlFor="qa-label">
              {t('modal.labelField')}
            </label>
            <Input
              ref={labelInputRef}
              id="qa-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('modal.labelPlaceholder')}
              disabled={saving}
            />
          </div>

          <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="field" className="quick-actions-config__modal-field">
            <label className="quick-actions-config__modal-label" htmlFor="qa-prompt">
              {t('modal.promptField')}
            </label>
            <Textarea
              id="qa-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('modal.promptPlaceholder')}
              rows={4}
              autoResize
              disabled={saving}
              className="quick-actions-config__modal-textarea"
            />
            <p className="quick-actions-config__modal-hint">{t('modal.promptHint')}</p>
          </div>

        </div>
      </DialogBody>
      <DialogFooter
        separator
        data-openbitfun-component="quick-actions-config"
        data-openbitfun-part="dialogFooter"
        className="quick-actions-config__modal-footer"
      >
        <Button variant="fill" size="sm" onClick={requestClose} disabled={saving}>
          {t('modal.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onSubmit(label.trim(), prompt.trim())}
          disabled={!canSubmit || saving}
          loading={saving}
          leadingIcon={<Icon name="check-line" size="sm" />}
        >

          {isEdit ? t('modal.saveEdit') : t('modal.confirmAdd')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

// ── ActionRow ───────────────────────────────────────────────────────────────

interface ActionRowProps {
  action: QuickAction;
  onToggle: (id: string) => void;
  onEdit: (action: QuickAction) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
  disabled: boolean;
  t: TranslationFn;
}

const ActionRow: React.FC<ActionRowProps> = ({ action, onToggle, onEdit, onDelete, canDelete, disabled, t }) => {
  const actionText = resolveQuickActionText(action, t);

  return (
    <div className="quick-actions-config__row" data-openbitfun-component="quick-actions-config" data-openbitfun-part="row">
      <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="rowIcon" className="quick-actions-config__row-icon">
        {getActionIcon(action.id)}
      </div>

      <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="rowBody" className="quick-actions-config__row-body">
        <div className="quick-actions-config__row-label">{actionText.label}</div>
        <div className="quick-actions-config__row-prompt"><OverflowText>{actionText.prompt}</OverflowText></div>
      </div>

      <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="rowControls" className="quick-actions-config__row-controls">
        <Switch
          checked={action.enabled}
          onChange={() => onToggle(action.id)}
          disabled={disabled}
        />
        <Tooltip content={t('edit.button')}>
          <IconButton
            type="button"
            size="sm"
            aria-label={t('edit.button')}
            onClick={() => onEdit(action)}
            disabled={disabled}
            icon={<Icon name="edit" size="xs" />}
          />
        </Tooltip>
        {canDelete && (
          <Tooltip content={t('delete.button')}>
            <IconButton
              type="button"
              size="sm"
              aria-label={t('delete.button')}
              onClick={() => onDelete(action.id)}
              disabled={disabled}
              className="quick-actions-config__delete-btn"
              icon={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
};

// ── Main page ───────────────────────────────────────────────────────────────

const QuickActionsSettingsSection: React.FC = () => {
  const { t } = useTranslation('settings/quick-actions');
  const notification = useNotification();

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actions, setActions] = useState<QuickAction[]>([]);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);

  // Modal state: undefined = closed, null = create, QuickAction = edit
  const [modalTarget, setModalTarget] = useState<QuickAction | null | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<QuickAction | null>(null);
  const isModalOpen = modalTarget !== undefined;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });
      const stored = settings.quick_actions;
      setActions(stored ?? DEFAULT_QUICK_ACTIONS);
    } catch (error) {
      log.error('Failed to load quick actions', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const persistSettings = useCallback((patch: AIExperienceSettingsPatch, onSaved: () => void): Promise<boolean> => {
    if (pendingSaveCountRef.current > 0) {
      return Promise.resolve(false);
    }
    pendingSaveCountRef.current += 1;
    setSaving(true);
    const operation = saveQueueRef.current.then(async () => {
      try {
        await aiExperienceConfigService.saveSettings(patch);
        onSaved();
        notification.success(t('messages.saved'));
        return true;
      } catch (error) {
        log.error('Failed to save quick action settings', error);
        notification.error(t('messages.saveFailed'));
        return false;
      } finally {
        pendingSaveCountRef.current -= 1;
        if (pendingSaveCountRef.current === 0) setSaving(false);
      }
    });
    saveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [notification, t]);

  const persist = useCallback((next: QuickAction[]) => persistSettings(
    { quick_actions: next },
    () => setActions(next),
  ), [persistSettings]);

  const handleToggle = useCallback((id: string) => {
    if (saving) return;
    void persist(actions.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a));
  }, [actions, persist, saving]);

  const handleDelete = useCallback((id: string) => {
    const target = actions.find(action => action.id === id);
    if (target) setDeleteTarget(target);
  }, [actions]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const saved = await persist(actions.filter(action => action.id !== deleteTarget.id));
    if (saved) setDeleteTarget(null);
  }, [actions, deleteTarget, persist]);

  const handleModalSubmit = useCallback(async (label: string, prompt: string): Promise<boolean> => {
    let saved = false;
    if (modalTarget === null) {
      // Create mode
      const newAction: QuickAction = {
        id: `custom_${Date.now()}`,
        label,
        prompt,
        enabled: true,
      };
      saved = await persist([...actions, newAction]);
    } else if (modalTarget) {
      // Edit mode
      const normalizedText = normalizeQuickActionTextForStorage(modalTarget, label, prompt, t);
      saved = await persist(actions.map(a => a.id === modalTarget.id ? { ...a, ...normalizedText } : a));
    }
    if (saved) setModalTarget(undefined);
    return saved;
  }, [actions, modalTarget, persist, t]);

  const sectionAnchor = useSettingsSectionAnchor('quick-actions', !loading);

  if (loading || loadFailed) {
    return (
      <div id={sectionAnchor} className="quick-actions-config" data-openbitfun-component="quick-actions-config" data-openbitfun-part="root">
        <ConfigPageSectionStack>
          {loading ? (
            <ConfigLoadingState label={t('loading')} />
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void load()}
            />
          )}
        </ConfigPageSectionStack>
      </div>
    );
  }

  const builtinActions = actions.filter(a => BUILTIN_IDS.has(a.id));
  const customActions = actions.filter(a => !BUILTIN_IDS.has(a.id));

  return (
    <div id={sectionAnchor} className="quick-actions-config" data-openbitfun-component="quick-actions-config" data-openbitfun-part="root">

      <ConfigPageSectionStack data-openbitfun-component="quick-actions-config" data-openbitfun-part="content" className="quick-actions-config__content">

        {/* ── Built-in actions ──────────────────────────────────────────── */}
        <ConfigPageSection title={t('sections.builtin.title')} description={t('sections.builtin.description')}>
          <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="list" className="quick-actions-config__list">
            {builtinActions.map(action => (
              <ActionRow
                key={action.id}
                action={action}
                onToggle={handleToggle}
                onEdit={(a) => setModalTarget(a)}
                onDelete={handleDelete}
                canDelete={false}
                disabled={saving}
                t={t}
              />
            ))}
          </div>
        </ConfigPageSection>

        {/* ── Custom actions ────────────────────────────────────────────── */}
        <ConfigPageSection
          title={t('sections.custom.title')}
          description={t('sections.custom.description')}
          extra={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setModalTarget(null)}
              disabled={saving}
              leadingIcon={<Icon name="plus" size="sm" />}
            >

              {t('add.button')}
            </Button>
          }
        >
          {customActions.length > 0 && (
            <div data-openbitfun-component="quick-actions-config" data-openbitfun-part="list" className="quick-actions-config__list">
              {customActions.map(action => (
                <ActionRow
                  key={action.id}
                  action={action}
                  onToggle={handleToggle}
                  onEdit={(a) => setModalTarget(a)}
                  onDelete={handleDelete}
                  canDelete
                  disabled={saving}
                  t={t}
                />
              ))}
            </div>
          )}
        </ConfigPageSection>

      </ConfigPageSectionStack>

      <ActionFormModal
        isOpen={isModalOpen}
        target={modalTarget ?? undefined}
        onClose={() => setModalTarget(undefined)}
        onSubmit={handleModalSubmit}
        saving={saving}
        t={t}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open && !saving) setDeleteTarget(null); }}
        onConfirm={confirmDelete}
        title={t('delete.confirmTitle')}
        message={t('delete.confirmMessage', {
          name: deleteTarget ? resolveQuickActionText(deleteTarget, t).label : '',
        })}
        confirmText={t('delete.confirmAction')}
        type="warning"
        confirmDanger
      />
    </div>
  );
};

export default QuickActionsSettingsSection;
