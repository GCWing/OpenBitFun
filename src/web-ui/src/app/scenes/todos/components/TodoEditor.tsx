import { agentName } from '@/shared/agents/identity';
/**
 * Create / edit form for a Todo.
 *
 * The form is rendered inside the Task Board's dedicated editor dialog. The
 * board is global, so the form owns a workspace picker: a job cannot be
 * scheduled without knowing which workspace it runs in.
 */

import { OverflowText, Button, Combobox, Icon, Input, Select, Switch, ScrollArea, Textarea } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, ClipboardList } from 'lucide-react';
import { agentAPI, type ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import { useI18n } from '@/infrastructure/i18n';
import { WorkspaceKind } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import {
  ASSISTANT_WORKSPACE_AGENT_TYPE,
  DEFAULT_AGENT_TYPE,
  getCurrentLocalDateTimeInput,
  isFutureLocalDateTimeInput,
  type JobDraft,
  type JobDraftValidationErrors,
  type ScheduleKind,
} from '@/app/components/scheduled-jobs/scheduledJobDraft';
import {
  INTERVAL_UNIT_OPTIONS,
  type IntervalUnit,
} from '@/app/components/scheduled-jobs/scheduledJobDraft';
import LocalizedDateTimeField from '@/app/components/scheduled-jobs/LocalizedDateTimeField';
import '@/app/components/scheduled-jobs/LocalizedDateTimeField.scss';
import type { TodoWorkspaceOption } from '../todoPresentation';

const log = createLogger('TodoEditor');

export interface TodoEditorProps {
  draft: JobDraft;
  onDraftChange: (updater: (draft: JobDraft) => JobDraft) => void;
  validationErrors: JobDraftValidationErrors;
  onValidationErrorsChange: (
    updater: (errors: JobDraftValidationErrors) => JobDraftValidationErrors,
  ) => void;
  workspaceOptions: TodoWorkspaceOption[];
  selectedWorkspaceId: string;
  onSelectedWorkspaceIdChange: (workspaceId: string) => void;
  /** True when editing an existing Todo rather than creating one. */
  isEditing: boolean;
  /**
   * Set when the Todo runs inside a specific existing session instead of
   * launching a new one. That binding is preserved on save, so the agent-type
   * picker is replaced by a note rather than implying a fresh session.
   */
  boundSessionId?: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}

const TodoEditor: React.FC<TodoEditorProps> = ({
  draft,
  onDraftChange,
  validationErrors,
  onValidationErrorsChange,
  workspaceOptions,
  selectedWorkspaceId,
  onSelectedWorkspaceIdChange,
  isEditing,
  boundSessionId = null,
  saving,
  onSave,
  onCancel,
}) => {
  const { t } = useI18n(['scenes/todos', 'common', 'shared']);
  const [availableModes, setAvailableModes] = useState<ModeInfo[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((option) => option.value === selectedWorkspaceId)?.workspace ?? null,
    [selectedWorkspaceId, workspaceOptions],
  );
  const isAssistantWorkspace = selectedWorkspace?.workspaceKind === WorkspaceKind.Assistant;

  useEffect(() => {
    let cancelled = false;

    const loadAvailableModes = async () => {
      try {
        const modes = await agentAPI.getAvailableModes();
        if (!cancelled) setAvailableModes(modes);
      } catch (error) {
        log.error('Failed to load available modes for the Todo editor', { error });
      }
    };

    void loadAvailableModes();
    return () => { cancelled = true; };
  }, []);

  // An assistant workspace only ever runs its own agent type; keep the draft in
  // step with the picked workspace so a saved Todo cannot carry a stale one.
  useEffect(() => {
    if (!selectedWorkspace) return;
    onDraftChange((current) => {
      const nextAgentType = isAssistantWorkspace
        ? ASSISTANT_WORKSPACE_AGENT_TYPE
        : current.agentType === ASSISTANT_WORKSPACE_AGENT_TYPE || !current.agentType
          ? DEFAULT_AGENT_TYPE
          : current.agentType;
      return current.agentType === nextAgentType
        ? current
        : { ...current, agentType: nextAgentType };
    });
  }, [isAssistantWorkspace, onDraftChange, selectedWorkspace]);

  const agentTypeOptions = useMemo(() => {
    if (isAssistantWorkspace) {
      return [{ value: ASSISTANT_WORKSPACE_AGENT_TYPE, label: agentName({ id: ASSISTANT_WORKSPACE_AGENT_TYPE, name: ASSISTANT_WORKSPACE_AGENT_TYPE }, t) }];
    }

    const options = availableModes
      .filter((mode) => mode.id !== ASSISTANT_WORKSPACE_AGENT_TYPE)
      .map((mode) => ({ value: mode.id, label: agentName(mode, t) }));

    if (draft.agentType && !options.some((option) => option.value === draft.agentType)) {
      options.push({ value: draft.agentType, label: agentName({ id: draft.agentType, name: draft.agentType }, t) });
    }
    return options;
  }, [availableModes, draft.agentType, isAssistantWorkspace, t]);

  const workspaceSelectOptions = useMemo(
    () => workspaceOptions.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
    })),
    [workspaceOptions],
  );

  const updateDraft = useCallback(
    (patch: Partial<JobDraft>) => onDraftChange((current) => ({ ...current, ...patch })),
    [onDraftChange],
  );

  const clearError = useCallback(
    (field: keyof JobDraftValidationErrors) =>
      onValidationErrorsChange((current) => ({ ...current, [field]: false })),
    [onValidationErrorsChange],
  );

  const handleScheduleKindChange = useCallback((value: string | number | (string | number)[]) => {
    const scheduleKind = value as ScheduleKind;
    onValidationErrorsChange((current) => ({
      ...current,
      at: false,
      everyValue: false,
      cronExpr: false,
    }));
    onDraftChange((current) => ({
      ...current,
      scheduleKind,
      at: scheduleKind === 'at' && !current.at.trim()
        ? getCurrentLocalDateTimeInput()
        : current.at,
    }));
  }, [onDraftChange, onValidationErrorsChange]);

  const title = isEditing ? t('editor.editTitle') : t('editor.createTitle');

  return (
    <form
      className="openbitfun-todos__editor"
      aria-label={title}
      data-openbitfun-scene="todos"
      data-openbitfun-part="editor"
      data-testid="todos-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <header
        className="openbitfun-todos__editor-intro"
        data-openbitfun-scene="todos"
        data-openbitfun-part="editorIntro"
      >
        <span className="openbitfun-todos__editor-intro-icon" aria-hidden="true">
          <CalendarClock size={24} strokeWidth={1.8} />
        </span>
        <div className="openbitfun-todos__editor-intro-copy">
          <h2 className="openbitfun-todos__editor-title">{title}</h2>
          <p className="openbitfun-todos__editor-description">
            {isEditing ? t('editor.editDescription') : t('editor.createDescription')}
          </p>
        </div>
      </header>

      <ScrollArea
        className="openbitfun-todos__editor-body"
        data-openbitfun-scene="todos"
        data-openbitfun-part="editorBody"
      >
        <section
          className="openbitfun-todos__editor-section"
          aria-labelledby="todos-editor-information-title"
          data-openbitfun-scene="todos"
          data-openbitfun-part="editorSection"
        >
          <h3 id="todos-editor-information-title" className="openbitfun-todos__editor-section-title">
            {t('editor.sections.information')}
          </h3>

          <div className="openbitfun-todos__editor-grid" data-openbitfun-scene="todos" data-openbitfun-part="editorGrid">
            <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
              <span className="openbitfun-todos__field-label">
                <ClipboardList size={16} aria-hidden="true" />
                {t('editor.fields.name')}
              </span>
              <Input
                className="openbitfun-todos__field-control"
                value={draft.name}
                invalid={validationErrors.name}
                aria-label={t('editor.fields.name')}
                placeholder={t('editor.placeholders.name')}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  clearError('name');
                  updateDraft({ name });
                }}
                data-testid="todos-editor-name"
                size="md"
              />
            </div>

            <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
              <span className="openbitfun-todos__field-label">
                <Icon name="folder" size="md" aria-hidden="true" />
                {t('shared:features.workspace')}
              </span>
              <Combobox
                size="md"
                className="openbitfun-todos__field-control"
                options={workspaceSelectOptions}
                value={selectedWorkspaceId}
                placeholder={t('editor.placeholders.workspace')}
                aria-label={t('shared:features.workspace')}
                onValueChange={(value) => onSelectedWorkspaceIdChange(String(value))}
              />
            </div>

            {boundSessionId ? (
              <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
                <span className="openbitfun-todos__field-label">
                  <Icon name="user" size="md" aria-hidden="true" />
                  {t('editor.fields.runsIn')}
                </span>
                <span className="openbitfun-todos__field-static" title={boundSessionId}><OverflowText>
                  {t('target.existingSession')}
                </OverflowText></span>
              </div>
            ) : (
              <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
                <span className="openbitfun-todos__field-label">
                  <Icon name="user" size="md" aria-hidden="true" />
                  {t('editor.fields.agentType')}
                </span>
                <Select
                  size="md"
                  className="openbitfun-todos__field-control"
                  options={agentTypeOptions}
                  value={draft.agentType}
                  invalid={validationErrors.agentType}
                  disabled={isAssistantWorkspace}
                  placeholder={t('editor.placeholders.agentType')}
                  aria-label={t('editor.fields.agentType')}
                  onValueChange={(value) => {
                    clearError('agentType');
                    updateDraft({ agentType: String(value) });
                  }}
                />
              </div>
            )}

            <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
              <span className="openbitfun-todos__field-label">
                <Icon name="refresh" size="md" aria-hidden="true" />
                {t('editor.fields.scheduleKind')}
              </span>
              <Select
                size="md"
                className="openbitfun-todos__field-control"
                value={draft.scheduleKind}
                options={[
                  { value: 'at', label: t('schedule.kinds.at') },
                  { value: 'every', label: t('schedule.kinds.every') },
                  { value: 'cron', label: t('schedule.kinds.cron') },
                ]}
                aria-label={t('editor.fields.scheduleKind')}
                onValueChange={handleScheduleKindChange}
                data-testid="todos-editor-schedule-kind"
              />
            </div>

            <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
              <span className="openbitfun-todos__field-label">
                <Icon name="clock" size="md" aria-hidden="true" />
                {draft.scheduleKind === 'at'
                  ? t('editor.fields.at')
                  : draft.scheduleKind === 'every'
                    ? t('editor.fields.every')
                    : t('editor.fields.cronExpr')}
              </span>

              {draft.scheduleKind === 'at' ? (
                <LocalizedDateTimeField
                  className="openbitfun-todos__field-control openbitfun-todos__field-control--datetime"
                  value={draft.at}
                  error={validationErrors.at}
                  aria-label={t('editor.fields.at')}
                  onChange={(at) => {
                    clearError('at');
                    // Re-enable a Todo that was left off after its time passed.
                    onDraftChange((current) => ({
                      ...current,
                      at,
                      enabled: !current.enabled && isFutureLocalDateTimeInput(at)
                        ? true
                        : current.enabled,
                    }));
                  }}
                />
              ) : null}

              {draft.scheduleKind === 'every' ? (
                <div className="openbitfun-todos__interval">
                  <Input
                    className="openbitfun-todos__field-control"
                    type="number"
                    value={draft.everyValue}
                    invalid={validationErrors.everyValue}
                    min="1"
                    aria-label={t('editor.fields.every')}
                    placeholder="1"
                    onChange={(event) => {
                      const everyValue = event.currentTarget.value;
                      clearError('everyValue');
                      updateDraft({ everyValue });
                    }}
                    size="md"
                  />
                  <Select
                    size="md"
                    className="openbitfun-todos__field-control"
                    value={draft.everyUnit}
                    options={INTERVAL_UNIT_OPTIONS.map((unit) => ({
                      value: unit,
                      label: t(`schedule.intervalUnits.${unit}`),
                    }))}
                    aria-label={t('editor.fields.every')}
                    onValueChange={(value) => updateDraft({ everyUnit: value as IntervalUnit })}
                  />
                </div>
              ) : null}

              {draft.scheduleKind === 'cron' ? (
                <Input
                  className="openbitfun-todos__field-control"
                  value={draft.expr}
                  invalid={validationErrors.cronExpr}
                  aria-label={t('editor.fields.cronExpr')}
                  placeholder="0 8 * * *"
                  onChange={(event) => {
                    const expr = event.currentTarget.value;
                    clearError('cronExpr');
                    updateDraft({ expr });
                  }}
                  size="md"
                />
              ) : null}
            </div>
          </div>

          <div
            className="openbitfun-todos__editor-runtime"
            data-openbitfun-scene="todos"
            data-openbitfun-part="editorRuntime"
          >
            <label className="openbitfun-todos__editor-enable">
              <Switch
                checked={draft.enabled}
                aria-label={t('editor.enabled.title')}
                onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })}
              />
              <span className="openbitfun-todos__editor-enable-copy">
                <strong>{t('editor.enabled.title')}</strong>
                <span>{t('editor.enabled.description')}</span>
              </span>
            </label>
            <span className="openbitfun-todos__editor-runtime-divider" aria-hidden="true" />
            <div className="openbitfun-todos__editor-smart">
              <span className="openbitfun-todos__editor-smart-icon" aria-hidden="true">
                <Icon name="spark" size="md" />
              </span>
              <span className="openbitfun-todos__editor-smart-copy">
                <strong>{t('editor.smartExecution.title')}</strong>
                <span>{t('editor.smartExecution.description')}</span>
              </span>
            </div>
          </div>
        </section>

        <section
          className="openbitfun-todos__editor-section"
          aria-labelledby="todos-editor-prompt-title"
          data-openbitfun-scene="todos"
          data-openbitfun-part="editorSection"
        >
          <h3 id="todos-editor-prompt-title" className="openbitfun-todos__editor-section-title">
            {t('editor.sections.prompt')}
          </h3>
          <Textarea
            className="openbitfun-todos__editor-prompt"
            value={draft.text}
            invalid={validationErrors.text}
            showCount
            rows={5}
            maxLength={1000}
            aria-label={t('editor.fields.prompt')}
            placeholder={t('editor.placeholders.prompt')}
            onChange={(event) => {
              const text = event.currentTarget.value;
              clearError('text');
              updateDraft({ text });
            }}
            data-testid="todos-editor-prompt"
          />
        </section>

        <section
          className="openbitfun-todos__editor-advanced"
          data-openbitfun-scene="todos"
          data-openbitfun-part="editorAdvanced"
        >
          <button
            type="button"
            className="openbitfun-todos__editor-advanced-trigger"
            aria-expanded={advancedOpen}
            aria-controls="todos-editor-advanced-panel"
            onClick={() => setAdvancedOpen((open) => !open)}
            data-testid="todos-editor-advanced-toggle"
          >
            <span>{t('editor.advanced.title')}</span>
            <Icon name="chevron-down" size="md" aria-hidden="true" />
          </button>

          {advancedOpen ? (
            <div id="todos-editor-advanced-panel" className="openbitfun-todos__editor-advanced-panel">
              {draft.scheduleKind === 'every' ? (
                <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
                  <span className="openbitfun-todos__field-label">
                    <Icon name="clock" size="md" aria-hidden="true" />
                    {t('editor.fields.anchor')}
                  </span>
                  <LocalizedDateTimeField
                    className="openbitfun-todos__field-control openbitfun-todos__field-control--datetime"
                    value={draft.anchorMs}
                    aria-label={t('editor.fields.anchor')}
                    onChange={(anchorMs) => updateDraft({ anchorMs })}
                  />
                  <span className="openbitfun-todos__field-note">{t('editor.placeholders.anchor')}</span>
                </div>
              ) : null}

              {draft.scheduleKind === 'cron' ? (
                <div className="openbitfun-todos__field-card" data-openbitfun-scene="todos" data-openbitfun-part="field">
                  <span className="openbitfun-todos__field-label">
                    <Icon name="clock" size="md" aria-hidden="true" />
                    {t('editor.fields.timezone')}
                  </span>
                  <Input
                    className="openbitfun-todos__field-control"
                    value={draft.tz}
                    aria-label={t('editor.fields.timezone')}
                    placeholder={t('editor.placeholders.timezone')}
                    onChange={(event) => updateDraft({ tz: event.currentTarget.value })}
                    size="md"
                  />
                  <span className="openbitfun-todos__field-note">{t('editor.hints.cronExpr')}</span>
                </div>
              ) : null}

              {boundSessionId ? (
                <p className="openbitfun-todos__editor-advanced-note">
                  {t('editor.hints.boundSession')}
                </p>
              ) : null}

              {draft.scheduleKind === 'at' && !boundSessionId ? (
                <p className="openbitfun-todos__editor-advanced-note">
                  {t('editor.advanced.empty')}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {workspaceOptions.length === 0 ? (
          <p className="openbitfun-todos__warning" data-openbitfun-scene="todos" data-openbitfun-part="warning">
            {t('editor.noWorkspace')}
          </p>
        ) : null}
      </ScrollArea>

      <footer
        className="openbitfun-todos__editor-actions"
        data-openbitfun-scene="todos"
        data-openbitfun-part="editorActions"
      >
        <Button
          type="button"
          size="md"
          variant="fill"
          onClick={onCancel}
          disabled={saving}
        >
          {t('common:nav.scheduledJobs.actions.cancel')}
        </Button>
        <Button
          type="submit"
          size="md"
          variant="primary"
          loading={saving}
          disabled={workspaceOptions.length === 0 || !selectedWorkspaceId}
          data-testid="todos-editor-save"
        >
          {isEditing ? t('editor.actions.save') : t('editor.actions.create')}
        </Button>
      </footer>
    </form>
  );
};

export default TodoEditor;
