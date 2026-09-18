/**
 * ScheduledJobsView — inline view for managing scheduled jobs.
 *
 * Designed for compact side panels and modals: single-column layout,
 * job list at top, inline editor expands below the selected job.
 */

import { OverflowText, Icon, Button, Combobox, Switch, IconButton, Input, Select, Textarea, Tooltip } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import {
  cronAPI,
  type CreateCronJobRequest,
  type CronJob,
  type CronJobTargetKind,
  type CronSchedule,
  type UpdateCronJobRequest,
} from '@/infrastructure/api';
import { agentAPI, type ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import { useI18n } from '@/infrastructure/i18n';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { FlowChatState, Session } from '@/flow_chat/types/flow-chat';
import {
  compareSessionsForDisplay,
  sessionBelongsToWorkspaceNavRow,
} from '@/flow_chat/utils/sessionOrdering';
import { notificationService } from '@/shared/notification-system/services/NotificationService';
import { createLogger } from '@/shared/utils/logger';
import { i18nService } from '@/infrastructure/i18n';
import { resolveSessionTitle } from '@/flow_chat/utils/sessionTitle';
import { WorkspaceKind } from '@/shared/types';
import {
  ASSISTANT_WORKSPACE_AGENT_TYPE,
  DEFAULT_AGENT_TYPE,
  EMPTY_VALIDATION_ERRORS,
  INTERVAL_UNIT_OPTIONS,
  SCHEDULED_JOBS_CHANGED_EVENT,
  buildScheduleFromDraft,
  buildTargetFromDraft,
  buildWorkspaceRef,
  createEmptyDraft,
  formatIntervalValue,
  splitInterval,
  getCurrentLocalDateTimeInput,
  getNextExecutionAtMs,
  hasValidationErrors,
  isFutureLocalDateTimeInput,
  jobToDraft,
  notifyScheduledJobsChanged as emitScheduledJobsChanged,
  validateDraft,
  type IntervalUnit,
  type JobDraft,
  type JobDraftValidationErrors,
  type ScheduleKind,
} from './scheduledJobDraft';
import LocalizedDateTimeField from './LocalizedDateTimeField';
import './LocalizedDateTimeField.scss';
import './ScheduledJobsView.scss';

const log = createLogger('ScheduledJobsView');
const NEW_JOB_ID = '__new__';

export interface ScheduledJobsViewProps {
  workspaceId?: string;
  workspaceKind?: WorkspaceKind;
  sessionId?: string;
  assistantName?: string;
  headerTitle?: string | null;
  targetLabel?: string;
  targetDescription?: string;
  targetKind?: CronJobTargetKind;
  lockSessionId?: boolean;
  assistantWorkspaceMode?: boolean;
}

function getDefaultAgentType(
  targetKind: CronJobTargetKind,
  workspaceKind?: WorkspaceKind,
): string {
  if (targetKind === 'workspace' && workspaceKind === WorkspaceKind.Assistant) {
    return ASSISTANT_WORKSPACE_AGENT_TYPE;
  }
  return DEFAULT_AGENT_TYPE;
}

function formatScheduleSummary(
  schedule: CronSchedule,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  switch (schedule.kind) {
    case 'at':
      return `${t('nav.scheduledJobs.scheduleKinds.at')}: ${formatTimestamp(new Date(schedule.at).getTime(), formatDate, t)}`;
    case 'every': {
      const interval = splitInterval(schedule.everyMs);
      return t(`nav.scheduledJobs.scheduleSummary.everyUnit.${interval.unit}`, {
        value: formatIntervalValue(interval.value),
      });
    }
    case 'cron':
      return schedule.tz
        ? t('nav.scheduledJobs.scheduleSummary.cronWithTz', { expr: schedule.expr, tz: schedule.tz })
        : t('nav.scheduledJobs.scheduleSummary.cron', { expr: schedule.expr });
    default:
      return '';
  }
}

function formatJobMetaSummary(
  job: CronJob,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
  t: (key: string, params?: Record<string, unknown>) => string,
  options?: {
    showTarget: boolean;
    resolveSessionLabel: (sessionId: string) => string | undefined;
  },
): string {
  const scheduleSummary = formatScheduleSummary(job.schedule, formatDate, t);
  if (options?.showTarget) {
    if (job.target.kind === 'session') {
      const sessionLabel = options.resolveSessionLabel(job.target.sessionId) || job.target.sessionId;
      return `${sessionLabel} · ${scheduleSummary}`;
    }
    return `${t('nav.scheduledJobs.targets.newSession')} · ${scheduleSummary}`;
  }
  if (job.target.kind === 'workspace') {
    return `${job.target.launch.agentType} · ${scheduleSummary}`;
  }
  return scheduleSummary;
}

function formatTimestamp(
  timestampMs: number | null | undefined,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return t('nav.scheduledJobs.never');
  return formatDate(timestampMs, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function resolveSessionLabel(session: Session): string {
  return resolveSessionTitle(session, (key, options) => i18nService.t(key, options));
}

function buildWorkspaceAgentOptions(
  modes: ModeInfo[],
  currentAgentType: string,
  defaultAgentType: string,
  workspaceKind?: WorkspaceKind,
) {
  if (workspaceKind === WorkspaceKind.Assistant) {
    return [
      {
        value: defaultAgentType,
        label: defaultAgentType,
        description: undefined,
      },
    ];
  }

  const options = modes
    .filter(mode => mode.id !== ASSISTANT_WORKSPACE_AGENT_TYPE)
    .map(mode => ({
      value: mode.id,
      label: mode.name?.trim() || mode.id,
      description: mode.description?.trim() || undefined,
    }));

  const fallbackAgentTypes = [currentAgentType, defaultAgentType]
    .map(value => value.trim())
    .filter(value => Boolean(value) && value !== ASSISTANT_WORKSPACE_AGENT_TYPE);

  for (const agentType of fallbackAgentTypes) {
    if (!options.some(option => option.value === agentType)) {
      options.push({
        value: agentType,
        label: agentType,
        description: undefined,
      });
    }
  }

  return options;
}

const ScheduledJobsView: React.FC<ScheduledJobsViewProps> = ({
  workspaceId,
  workspaceKind,
  sessionId,
  headerTitle,
  targetLabel,
  targetDescription,
  targetKind = 'session',
  lockSessionId = false,
  assistantWorkspaceMode = false,
}) => {
  const { t, formatDate } = useI18n('common');
  const instanceIdRef = useRef(`scheduled-jobs-${Math.random().toString(36).slice(2)}`);
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => flowChatStore.getState());
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModes, setAvailableModes] = useState<ModeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<JobDraftValidationErrors>(
    EMPTY_VALIDATION_ERRORS,
  );

  const defaultAgentType = useMemo(
    () => assistantWorkspaceMode
      ? ASSISTANT_WORKSPACE_AGENT_TYPE
      : getDefaultAgentType(targetKind, workspaceKind),
    [assistantWorkspaceMode, targetKind, workspaceKind],
  );
  const workspaceRef = useMemo(
    () => buildWorkspaceRef(workspaceId),
    [workspaceId],
  );

  const [draft, setDraft] = useState<JobDraft>(() =>
    createEmptyDraft(sessionId ?? '', defaultAgentType),
  );
  const draftTargetKind: CronJobTargetKind = assistantWorkspaceMode && !draft.sessionId.trim()
    ? 'workspace'
    : targetKind;

  const notifyScheduledJobsChanged = useCallback(() => {
    emitScheduledJobsChanged(instanceIdRef.current);
  }, []);

  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe((state) => setFlowChatState(state));
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAvailableModes = async () => {
      try {
        const modes = await agentAPI.getAvailableModes();
        if (!cancelled) {
          setAvailableModes(modes);
        }
      } catch (error) {
        log.error('Failed to load available modes for scheduled job editor', { error });
      }
    };

    if (targetKind === 'workspace' && !assistantWorkspaceMode) {
      void loadAvailableModes();
    }

    return () => {
      cancelled = true;
    };
  }, [assistantWorkspaceMode, targetKind]);

  const workspaceSessions = useMemo(() => {
    return Array.from(flowChatState.sessions.values())
      .filter(s => {
        if (s.parentSessionId) return false;
        return Boolean(workspaceId && sessionBelongsToWorkspaceNavRow(s, workspaceId));
      })
      .sort(compareSessionsForDisplay);
  }, [flowChatState.sessions, workspaceId]);

  const defaultSessionIdForWorkspace = useMemo(
    () => sessionId || workspaceSessions[0]?.sessionId || '',
    [sessionId, workspaceSessions],
  );

  const sortedJobs = useMemo(() => [...jobs].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const diff = b.configUpdatedAtMs - a.configUpdatedAtMs;
    return diff !== 0 ? diff : b.createdAtMs - a.createdAtMs;
  }), [jobs]);

  const loadJobs = useCallback(async () => {
    if (!workspaceRef) { setJobs([]); return; }
    setLoading(true);
    const request = {
      workspaceId: workspaceRef?.workspaceId ?? undefined,
      sessionId: targetKind === 'session' && lockSessionId && !assistantWorkspaceMode ? sessionId || undefined : undefined,
      targetKind: assistantWorkspaceMode ? undefined : targetKind,
    };
    try {
      const result = await cronAPI.listJobs(request);
      setJobs(result);
      setExpandedJobId(current => {
        if (current === NEW_JOB_ID) {
          return current;
        }
        if (current && result.some(j => j.id === current)) return current;
        return null;
      });
      setSelectedJobId(current => {
        if (current && result.some(j => j.id === current)) return current;
        return null;
      });
    } catch (error) {
      log.error('Failed to load scheduled jobs', { error });
      notificationService.error(
        t('nav.scheduledJobs.messages.loadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [assistantWorkspaceMode, lockSessionId, sessionId, t, targetKind, workspaceRef]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  useEffect(() => {
    const handleScheduledJobsChanged = (event: Event) => {
      const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
      if (sourceId === instanceIdRef.current) return;
      void loadJobs();
    };

    window.addEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleScheduledJobsChanged);
    return () => {
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleScheduledJobsChanged);
    };
  }, [loadJobs]);

  useEffect(() => {
    setDraft(prev => ({
      ...prev,
      sessionId: targetKind === 'session' && !assistantWorkspaceMode
        ? (lockSessionId ? sessionId || '' : prev.sessionId || defaultSessionIdForWorkspace)
        : prev.sessionId,
      agentType: targetKind === 'workspace' || assistantWorkspaceMode
        ? (
          workspaceKind === WorkspaceKind.Assistant || assistantWorkspaceMode
            ? defaultAgentType
            : (
              !prev.agentType
              || prev.agentType === ASSISTANT_WORKSPACE_AGENT_TYPE
                ? defaultAgentType
                : prev.agentType
            )
        )
        : prev.agentType,
    }));
  }, [
    assistantWorkspaceMode,
    defaultAgentType,
    defaultSessionIdForWorkspace,
    lockSessionId,
    sessionId,
    targetKind,
    workspaceKind,
  ]);

  const resetValidationErrors = useCallback(() => {
    setValidationErrors(EMPTY_VALIDATION_ERRORS);
  }, []);

  const handleCreateNew = useCallback(() => {
    setSelectedJobId(null);
    resetValidationErrors();
    setDraft(createEmptyDraft(
      targetKind === 'session' && !assistantWorkspaceMode
        ? (lockSessionId ? sessionId || '' : defaultSessionIdForWorkspace)
        : '',
      defaultAgentType,
    ));
    setExpandedJobId(NEW_JOB_ID);
  }, [
    defaultAgentType,
    defaultSessionIdForWorkspace,
    assistantWorkspaceMode,
    lockSessionId,
    resetValidationErrors,
    sessionId,
    targetKind,
  ]);

  const handleEditJob = useCallback((job: CronJob) => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null);
      setSelectedJobId(null);
      return;
    }
    setSelectedJobId(job.id);
    resetValidationErrors();
    setDraft(jobToDraft(job, defaultAgentType));
    setExpandedJobId(job.id);
  }, [defaultAgentType, expandedJobId, resetValidationErrors]);

  const handleCloseEditor = useCallback(() => {
    setExpandedJobId(null);
    setSelectedJobId(null);
    resetValidationErrors();
    setDraft(createEmptyDraft(
      targetKind === 'session' && !assistantWorkspaceMode
        ? (lockSessionId ? sessionId || '' : defaultSessionIdForWorkspace)
        : '',
      defaultAgentType,
    ));
  }, [
    defaultAgentType,
    defaultSessionIdForWorkspace,
    assistantWorkspaceMode,
    lockSessionId,
    resetValidationErrors,
    sessionId,
    targetKind,
  ]);

  const handleDeleteJob = useCallback(async (job: CronJob) => {
    const confirmed = await confirmDanger(
      t('nav.scheduledJobs.deleteDialog.title', { name: job.name }),
      null,
    );
    if (!confirmed) return;
    try {
      await cronAPI.deleteJob(job.id);
      if (selectedJobId === job.id || expandedJobId === job.id) { handleCloseEditor(); }
      await loadJobs();
      notifyScheduledJobsChanged();
    } catch (error) {
      log.error('Failed to delete scheduled job', { jobId: job.id, error });
      notificationService.error(
        t('nav.scheduledJobs.messages.deleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [expandedJobId, handleCloseEditor, loadJobs, notifyScheduledJobsChanged, selectedJobId, t]);

  const handleToggleEnabled = useCallback(async (job: CronJob, enabled: boolean) => {
    try {
      await cronAPI.updateJob(job.id, { enabled });
      await loadJobs();
      notifyScheduledJobsChanged();
    } catch (error) {
      log.error('Failed to toggle scheduled job', { jobId: job.id, error });
      notificationService.error(
        t('nav.scheduledJobs.messages.updateFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [loadJobs, notifyScheduledJobsChanged, t]);

  const handleSave = useCallback(async () => {
    const nextValidationErrors = validateDraft(draftTargetKind, draft);
    setValidationErrors(nextValidationErrors);
    if (hasValidationErrors(nextValidationErrors)) { return; }
    if (!workspaceRef) { return; }

    const schedule = buildScheduleFromDraft(draft);
    const target = buildTargetFromDraft(draftTargetKind, draft, workspaceRef);

    setSaving(true);
    try {
      if (selectedJobId) {
        const request: UpdateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          schedule,
          target,
        };
        const updated = await cronAPI.updateJob(selectedJobId, request);
        setSelectedJobId(null);
        setDraft(jobToDraft(updated, defaultAgentType));
        setExpandedJobId(null);
      } else {
        const request: CreateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          schedule,
          target,
        };
        await cronAPI.createJob(request);
        setSelectedJobId(null);
        setExpandedJobId(null);
        setDraft(createEmptyDraft(
          targetKind === 'session' && !assistantWorkspaceMode
            ? (lockSessionId ? sessionId || '' : defaultSessionIdForWorkspace)
            : '',
          defaultAgentType,
        ));
      }
      await loadJobs();
      notifyScheduledJobsChanged();
    } catch (error) {
      log.error('Failed to save scheduled job', { error });
      notificationService.error(
        t('nav.scheduledJobs.messages.saveFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [
    defaultAgentType,
    defaultSessionIdForWorkspace,
    draft,
    draftTargetKind,
    loadJobs,
    notifyScheduledJobsChanged,
    assistantWorkspaceMode,
    lockSessionId,
    selectedJobId,
    sessionId,
    t,
    targetKind,
    workspaceRef,
  ]);

  const sessionOptions = useMemo(
    () => workspaceSessions.map(s => ({
      value: s.sessionId,
      label: resolveSessionLabel(s),
    })),
    [workspaceSessions],
  );
  const sessionLabelById = useMemo(() => {
    const labels = new Map<string, string>();
    workspaceSessions.forEach(session => {
      labels.set(session.sessionId, resolveSessionLabel(session));
    });
    return labels;
  }, [workspaceSessions]);
  const workspaceAgentOptions = useMemo(
    () => buildWorkspaceAgentOptions(
      availableModes,
      draft.agentType,
      defaultAgentType,
      workspaceKind,
    ),
    [availableModes, defaultAgentType, draft.agentType, workspaceKind],
  );

  const canSave = assistantWorkspaceMode
    ? Boolean(workspaceRef)
    : targetKind === 'session'
      ? Boolean(workspaceRef && draft.sessionId.trim())
      : Boolean(workspaceRef && draft.agentType.trim());
  const effectiveHeaderTitle = headerTitle === undefined ? t('nav.scheduledJobs.title') : headerTitle;
  const targetTypeLabel = targetKind === 'session'
    ? t('nav.scheduledJobs.targets.session')
    : t('shared:features.workspace');
  const hasHeaderContent = Boolean(targetLabel?.trim() || effectiveHeaderTitle);
  const emptyTitle = targetKind === 'workspace' && !assistantWorkspaceMode
    ? t('nav.scheduledJobs.empty.workspaceTitle')
    : t('nav.scheduledJobs.empty.title');

  return (
    <div
      className="asv"
      data-openbitfun-component="scheduled-jobs-view"
      data-openbitfun-part="root"
      data-openbitfun-target={targetKind}
      data-openbitfun-schedule={draft.scheduleKind}
    >
      <div
        className={`asv__head${hasHeaderContent ? '' : ' asv__head--actions-only'}`}
        data-openbitfun-component="scheduled-jobs-view"
        data-openbitfun-part="header"
      >
        {targetLabel?.trim() ? (
          <div
            className="asv__target"
            title={targetDescription || targetLabel}
            data-openbitfun-component="scheduled-jobs-view"
            data-openbitfun-part="target"
          >
            <span className="asv__target-kind">{targetTypeLabel}</span>
            <OverflowText className="asv__target-main">{targetLabel}</OverflowText>
            {targetDescription?.trim() ? (
              <OverflowText className="asv__target-sub">{targetDescription}</OverflowText>
            ) : null}
          </div>
        ) : effectiveHeaderTitle ? (
          <span className="asv__head-title">{effectiveHeaderTitle}</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="asv__new-job"
          onClick={handleCreateNew}
          disabled={assistantWorkspaceMode ? !workspaceRef : targetKind === 'session' ? !canSave : !workspaceRef}
        >
          {t('nav.scheduledJobs.actions.newJob')}
        </Button>
      </div>

      {expandedJobId === NEW_JOB_ID ? renderEditor() : null}

      {loading ? (
        <div className="asv__empty" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="empty" data-openbitfun-state="loading">
          <Icon name="refresh" size="sm" className="asv__spin" />
        </div>
      ) : sortedJobs.length === 0 && expandedJobId !== NEW_JOB_ID ? (
        <div className="asv__empty" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="empty">
          <p className="asv__empty-title">{emptyTitle}</p>
        </div>
      ) : sortedJobs.length > 0 ? (
        <div className="asv__list" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="list">
          {sortedJobs.map(job => {
            const isExpanded = expandedJobId === job.id;
            return (
              <React.Fragment key={job.id}>
                <div data-overflow-trigger
                  className={`asv__item${isExpanded ? ' is-expanded' : ''}`}
                  data-openbitfun-component="scheduled-jobs-view"
                  data-openbitfun-part="job"
                  data-openbitfun-state={isExpanded ? 'expanded' : undefined}
                  role="group"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  aria-label={`${job.name}, ${t('nav.scheduledJobs.actions.edit')}`}
                  onClick={() => handleEditJob(job)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleEditJob(job);
                    }
                  }}
                >
                  <div className="asv__item-body" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="jobBody">
                    <div className="asv__item-top">
                      <OverflowText className="asv__item-name">{job.name}</OverflowText>
                      <div className="asv__item-actions" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="jobActions">
                        <div
                          className="asv__switch-wrap"
                          onClick={e => e.stopPropagation()}
                          role="presentation"
                        >
                          <Switch
                            className="asv__switch"
                            checked={job.enabled}
                            onChange={e => {
                              void handleToggleEnabled(job, e.currentTarget.checked);
                            }}
                            aria-label={t('nav.scheduledJobs.actions.toggleEnabled')}
                          />
                        </div>
                        <Tooltip content={t('nav.scheduledJobs.actions.delete')}>
                          <IconButton
                            type="button"
                            size="sm"
                            tone="danger"
                            aria-label={t('nav.scheduledJobs.actions.delete')}
                            onClick={e => { e.stopPropagation(); void handleDeleteJob(job); }}
                            icon={<Icon name="delete" size="lg" style={{ width: 13, height: 13 }} />}
                          />
                        </Tooltip>
                      </div>
                    </div>
                    <div className="asv__item-meta-row" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="jobMeta">
                      <div className="asv__item-meta"><OverflowText>
                        {formatJobMetaSummary(job, formatDate, t, {
                          showTarget: assistantWorkspaceMode,
                          resolveSessionLabel: sessionId => sessionLabelById.get(sessionId),
                        })}
                      </OverflowText></div>
                      <div className="asv__item-meta asv__item-meta--dim asv__item-next-run"><OverflowText>
                        {t('nav.scheduledJobs.nextRunLabel')}: {formatTimestamp(getNextExecutionAtMs(job), formatDate, t)}
                      </OverflowText></div>
                    </div>
                    {job.state.lastError ? (
                      <div className="asv__item-error" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="error">
                        {job.state.lastError}
                      </div>
                    ) : null}
                  </div>
                </div>
                {isExpanded ? renderEditor() : null}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  function renderEditor() {
    return (
      <section
        className="asv__editor"
        aria-label={t('nav.scheduledJobs.title')}
        data-openbitfun-component="scheduled-jobs-view"
        data-openbitfun-part="editor"
      >
        {renderForm()}
      </section>
    );
  }

  function renderForm() {
    return (
      <div className="asv__form" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="form">
        {targetKind === 'session' && !assistantWorkspaceMode && !canSave ? (
          <p className="asv__warning" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="warning">
            {t('nav.scheduledJobs.messages.sessionRequired')}
          </p>
        ) : null}

        <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
          <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
            <span className="asv__field-label">{t('nav.scheduledJobs.fields.name')}</span>
          </div>
          <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
            <Input
              value={draft.name}
              onChange={e => {
                const name = e.currentTarget.value;
                setValidationErrors(current => ({ ...current, name: false }));
                setDraft(c => ({ ...c, name }));
              }}
              invalid={validationErrors.name}
              placeholder={t('nav.scheduledJobs.placeholders.name')}
              size="sm"
            />
          </div>
        </div>

        <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
          <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
            <span className="asv__field-label">{t('nav.scheduledJobs.fields.scheduleKind')}</span>
          </div>
          <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
            <div className="asv__control-grid asv__control-grid--schedule">
              <Select
                size="sm"
                value={draft.scheduleKind}
                options={[
                  { value: 'at', label: t('nav.scheduledJobs.scheduleKinds.at') },
                  { value: 'every', label: t('nav.scheduledJobs.scheduleKinds.every') },
                  { value: 'cron', label: t('nav.scheduledJobs.scheduleKinds.cron') },
                ]}
                onValueChange={value => {
                  setValidationErrors(current => ({
                    ...current,
                    at: false,
                    everyValue: false,
                    cronExpr: false,
                  }));
                  setDraft(c => ({
                    ...c,
                    scheduleKind: value as ScheduleKind,
                    at: (value as ScheduleKind) === 'at' && !c.at.trim() ? getCurrentLocalDateTimeInput() : c.at,
                  }));
                }}
              />

              <div className="asv__toggle-card" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="toggle">
                <span className="asv__toggle-label">{t('nav.scheduledJobs.fields.enabled')}</span>
                <Switch
                  className="asv__switch"
                  checked={draft.enabled}
                  onChange={e => {
                    const enabled = e.currentTarget.checked;
                    setDraft(c => ({ ...c, enabled }));
                  }}
                  aria-label={t('nav.scheduledJobs.fields.enabled')}
                />
              </div>
            </div>
          </div>
        </div>

        {draft.scheduleKind === 'at' && (
          <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
            <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
              <span className="asv__field-label">{t('nav.scheduledJobs.fields.at')}</span>
            </div>
            <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
              <LocalizedDateTimeField
                value={draft.at}
                error={validationErrors.at}
                onChange={at => {
                  setValidationErrors(current => ({ ...current, at: false }));
                  setDraft(c => ({
                    ...c,
                    at,
                    enabled: !c.enabled && isFutureLocalDateTimeInput(at) ? true : c.enabled,
                  }));
                }}
              />
            </div>
          </div>
        )}

        {draft.scheduleKind === 'every' && (
          <>
            <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
              <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
                <span className="asv__field-label">{t('nav.scheduledJobs.fields.everyMs')}</span>
              </div>
              <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
                <div className="asv__control-grid asv__control-grid--interval">
                  <Input
                    type="number"
                    value={draft.everyValue}
                    invalid={validationErrors.everyValue}
                    onChange={e => {
                      const everyValue = e.currentTarget.value;
                      setValidationErrors(current => ({ ...current, everyValue: false }));
                      setDraft(c => ({ ...c, everyValue }));
                    }}
                    placeholder="1"
                    size="sm"
                  />
                  <Select
                    size="sm"
                    value={draft.everyUnit}
                    options={INTERVAL_UNIT_OPTIONS.map(unit => ({
                      value: unit,
                      label: t(`nav.scheduledJobs.intervalUnits.${unit}`),
                    }))}
                    onValueChange={value => {
                      setDraft(c => ({ ...c, everyUnit: value as IntervalUnit }));
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
              <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
                <span className="asv__field-label">{t('nav.scheduledJobs.fields.anchorMs')}</span>
              </div>
              <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
                <LocalizedDateTimeField
                  value={draft.anchorMs}
                  onChange={anchorMs => setDraft(c => ({ ...c, anchorMs }))}
                  aria-label={t('nav.scheduledJobs.fields.anchorMs')}
                />
              </div>
            </div>
          </>
        )}

        {draft.scheduleKind === 'cron' && (
          <>
            <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
              <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
                <span className="asv__field-label">{t('nav.scheduledJobs.fields.cronExpr')}</span>
              </div>
              <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
                <Input
                  value={draft.expr}
                  invalid={validationErrors.cronExpr}
                  onChange={e => {
                    const expr = e.currentTarget.value;
                    setValidationErrors(current => ({ ...current, cronExpr: false }));
                    setDraft(c => ({ ...c, expr }));
                  }}
                  placeholder="0 8 * * *"
                  size="sm"
                />
                <span className="asv__field-note">
                  {t('nav.scheduledJobs.hints.cronExpr')}
                </span>
              </div>
            </div>
            <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
              <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
                <span className="asv__field-label">{t('nav.scheduledJobs.fields.timezone')}</span>
              </div>
              <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
                <Input
                  value={draft.tz}
                  onChange={e => {
                    const tz = e.currentTarget.value;
                    setDraft(c => ({ ...c, tz }));
                  }}
                  placeholder={t('nav.scheduledJobs.placeholders.timezone')}
                  size="sm"
                />
              </div>
            </div>
          </>
        )}

        {assistantWorkspaceMode ? (
          <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
            <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
              <span className="asv__field-label">{t('nav.scheduledJobs.fields.session')}</span>
            </div>
            <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
              <Combobox
                size="sm"
                options={sessionOptions}
                value={draft.sessionId}
                invalid={validationErrors.sessionId}
                onCreateValue={value => value}
                clearable
                className="asv__session-select"
                onValueChange={value => {
                  setValidationErrors(current => ({ ...current, sessionId: false }));
                  setDraft(c => ({ ...c, sessionId: String(value) }));
                }}
                placeholder={t('nav.scheduledJobs.placeholders.optionalSession')}
              />
            </div>
          </div>
        ) : targetKind === 'workspace' ? (
          <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
            <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
              <span className="asv__field-label">{t('nav.scheduledJobs.fields.agentType')}</span>
            </div>
            <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
              <Combobox
                size="sm"
                options={workspaceAgentOptions}
                value={draft.agentType}
                invalid={validationErrors.agentType}
                disabled={workspaceKind === WorkspaceKind.Assistant}
                className="asv__agent-select"
                onValueChange={value => {
                  const agentType = String(value);
                  setValidationErrors(current => ({ ...current, agentType: false }));
                  setDraft(c => ({ ...c, agentType }));
                }}
                placeholder={t('nav.scheduledJobs.placeholders.agentType')}
              />
            </div>
          </div>
        ) : !lockSessionId ? (
          <div className="asv__form-row asv__form-row--inline" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
            <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
              <span className="asv__field-label">{t('nav.scheduledJobs.fields.session')}</span>
            </div>
            <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
              <Combobox
                size="sm"
                options={sessionOptions}
                value={draft.sessionId}
                invalid={validationErrors.sessionId}
                onCreateValue={value => value}
                onValueChange={value => {
                  setValidationErrors(current => ({ ...current, sessionId: false }));
                  setDraft(c => ({ ...c, sessionId: String(value) }));
                }}
                placeholder={t('nav.scheduledJobs.placeholders.session')}
              />
            </div>
          </div>
        ) : null}

        <div className="asv__form-row asv__form-row--inline asv__form-row--prompt" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
          <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
            <span className="asv__field-label">{t('nav.scheduledJobs.fields.prompt')}</span>
          </div>
          <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
            <Textarea
              className="asv__prompt-textarea"
              rows={4}
              value={draft.text}
              onChange={e => {
                const text = e.currentTarget.value;
                setValidationErrors(current => ({ ...current, text: false }));
                setDraft(c => ({ ...c, text }));
              }}
              invalid={validationErrors.text}
              autoResize
              showCount
              maxLength={4000}
              placeholder={t('nav.scheduledJobs.placeholders.prompt')}
            />
          </div>
        </div>

        <div className="asv__form-actions" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="formActions">
          <Button
            size="sm"
            className="asv__action-btn"
            variant="fill"
            onClick={handleCloseEditor}
          >
            {t('nav.scheduledJobs.actions.cancel')}
          </Button>
          <Button
            size="sm"
            className="asv__action-btn"
            variant="primary"
            onClick={() => { void handleSave(); }}
            disabled={!canSave}
            loading={saving}
          >
            {selectedJobId
              ? t('nav.scheduledJobs.actions.save')
              : t('nav.scheduledJobs.actions.create')}
          </Button>
        </div>
      </div>
    );
  }
};

export default ScheduledJobsView;
