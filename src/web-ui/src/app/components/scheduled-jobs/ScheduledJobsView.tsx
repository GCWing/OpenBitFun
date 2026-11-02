/**
 * ScheduledJobsView — inline view for managing scheduled jobs.
 *
 * Designed for compact side panels and modals: single-column layout,
 * job list at top, inline editor expands below the selected job.
 */

import { Alert, OverflowText, Icon, Button, Combobox, Switch, IconButton, Input, Select, StatusPill, Textarea, Tooltip, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field } from '@openbitfun/ui';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
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
import { agentName } from '@/shared/agents/identity';
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

type ScheduledJobFieldProps = Pick<React.ComponentProps<typeof Field>, 'label' | 'description' | 'controlTrailing' | 'children'> & {
  dialog: boolean;
  prompt?: boolean;
  controlLayout?: 'schedule' | 'interval';
};

function ScheduledJobField({
  dialog,
  prompt,
  label,
  description,
  controlTrailing,
  controlLayout = 'interval',
  children,
}: ScheduledJobFieldProps) {
  if (dialog) {
    return <Field label={label} description={description} controlWidth="fill" controlTrailing={controlTrailing}>
      {children}
    </Field>;
  }

  return <div className={`asv__form-row asv__form-row--inline${prompt ? ' asv__form-row--prompt' : ''}`}
    data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="field">
    <div className="asv__field-meta" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldMeta">
      <span className="asv__field-label">{label}</span>
    </div>
    <div className="asv__field-control" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="fieldControl">
      {controlTrailing ? <div className={`asv__control-grid asv__control-grid--${controlLayout}`}>{children}{controlTrailing}</div> : children}
      {description && <span className="asv__field-note">{description}</span>}
    </div>
  </div>;
}

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
  listPresentation?: 'cards' | 'table';
  initialCreate?: boolean;
  creationOnly?: boolean;
  onCreationClose?: () => void;
  listTargetKind?: CronJobTargetKind;
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
    resolveSessionLabel: (sessionId: string) => string | undefined;
    resolveAgentLabel: (agentType: string) => string;
  },
): string {
  const scheduleSummary = formatScheduleSummary(job.schedule, formatDate, t);
  if (job.target.kind === 'session') {
    const sessionLabel = options?.resolveSessionLabel(job.target.sessionId) || job.target.sessionId;
    return `${sessionLabel} · ${scheduleSummary}`;
  }
  if (job.target.kind === 'workspace') {
    return `${options?.resolveAgentLabel(job.target.launch.agentType) ?? agentName({ id: job.target.launch.agentType, name: job.target.launch.agentType }, t)} · ${scheduleSummary}`;
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
  t: (key: string) => string,
  workspaceKind?: WorkspaceKind,
) {
  if (workspaceKind === WorkspaceKind.Assistant) {
    return [
      {
        value: defaultAgentType,
        label: agentName({ id: defaultAgentType, name: defaultAgentType }, t),
        description: undefined,
      },
    ];
  }

  const options = modes
    .filter(mode => mode.id !== ASSISTANT_WORKSPACE_AGENT_TYPE)
    .map(mode => ({
      value: mode.id,
      label: agentName(mode, t),
      description: mode.description?.trim() || undefined,
    }));

  const fallbackAgentTypes = [currentAgentType, defaultAgentType]
    .map(value => value.trim())
    .filter(value => Boolean(value) && value !== ASSISTANT_WORKSPACE_AGENT_TYPE);

  for (const agentType of fallbackAgentTypes) {
    if (!options.some(option => option.value === agentType)) {
      options.push({
        value: agentType,
        label: agentName({ id: agentType, name: agentType }, t),
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
  listPresentation = 'cards',
  initialCreate = false,
  creationOnly = false,
  onCreationClose,
  listTargetKind,
}) => {
  const { t, formatDate } = useI18n('common');
  const creationFormId = useId();
  const creationNameRef = useRef<HTMLInputElement | null>(null);
  const peer = usePeerDeviceModeOptional();
  const supportsReportPolicy = !peer?.peerMode.active || peer.currentPeerCapabilities?.backgroundResultDeliveryV1 === true;
  const instanceIdRef = useRef(`scheduled-jobs-${Math.random().toString(36).slice(2)}`);
  const mounted = useRef(true);
  const savePending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [flowChatState, setFlowChatState] = useState<FlowChatState>(() => flowChatStore.getState());
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModes, setAvailableModes] = useState<ModeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>((initialCreate || creationOnly) ? NEW_JOB_ID : null);
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
    const scope = getActiveSurfaceScope();
    if (!workspaceRef) { setJobs([]); return; }
    setLoading(true);
    setLoadError(null);
    // Existing assistant/session owners include both target kinds. Project resources
    // explicitly match the workspace-targeted jobs counted by their summary.
    const request = {
      workspaceId: workspaceRef?.workspaceId ?? undefined,
      ...(listTargetKind ? { targetKind: listTargetKind } : {}),
      sessionId: targetKind === 'session' && lockSessionId && !assistantWorkspaceMode
        ? sessionId || undefined
        : undefined,
    };
    try {
      const result = await cronAPI.listJobs(request);
      if (!mounted.current || !scope.isCurrent()) return;
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
      if (!mounted.current || !scope.isCurrent()) return;
      log.error('Failed to load scheduled jobs', { error });
      setLoadError(t('nav.scheduledJobs.messages.loadFailed', { error: error instanceof Error ? error.message : String(error) }));
      notificationService.error(
        t('nav.scheduledJobs.messages.loadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (mounted.current && scope.isCurrent()) setLoading(false);
    }
  }, [assistantWorkspaceMode, listTargetKind, lockSessionId, sessionId, t, targetKind, workspaceRef]);

  useEffect(() => { if (!creationOnly) void loadJobs(); }, [creationOnly, loadJobs]);

  useEffect(() => {
    if (creationOnly) return;
    const handleScheduledJobsChanged = (event: Event) => {
      const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
      if (sourceId === instanceIdRef.current) return;
      void loadJobs();
    };

    window.addEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleScheduledJobsChanged);
    return () => {
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleScheduledJobsChanged);
    };
  }, [creationOnly, loadJobs]);

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
    if (savePending.current) return;
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
    if (savePending.current) return;
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
    if (savePending.current) return;
    if (creationOnly) onCreationClose?.();
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
    creationOnly,
    onCreationClose,
    defaultAgentType,
    defaultSessionIdForWorkspace,
    assistantWorkspaceMode,
    lockSessionId,
    resetValidationErrors,
    sessionId,
    targetKind,
  ]);

  const handleDeleteJob = useCallback(async (job: CronJob) => {
    const scope = getActiveSurfaceScope();
    const confirmed = await confirmDanger(
      t('nav.scheduledJobs.deleteDialog.title', { name: job.name }),
      null,
    );
    if (!confirmed || !mounted.current || !scope.isCurrent()) return;
    try {
      await cronAPI.deleteJob(job.id);
      if (!mounted.current || !scope.isCurrent()) return;
      if (selectedJobId === job.id || expandedJobId === job.id) { handleCloseEditor(); }
      await loadJobs();
      if (!mounted.current || !scope.isCurrent()) return;
      notifyScheduledJobsChanged();
    } catch (error) {
      if (!mounted.current || !scope.isCurrent()) return;
      log.error('Failed to delete scheduled job', { jobId: job.id, error });
      notificationService.error(
        t('nav.scheduledJobs.messages.deleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [expandedJobId, handleCloseEditor, loadJobs, notifyScheduledJobsChanged, selectedJobId, t]);

  const handleToggleEnabled = useCallback(async (job: CronJob, enabled: boolean) => {
    const scope = getActiveSurfaceScope();
    try {
      await cronAPI.updateJob(job.id, { enabled });
      if (!mounted.current || !scope.isCurrent()) return;
      await loadJobs();
      if (!mounted.current || !scope.isCurrent()) return;
      notifyScheduledJobsChanged();
    } catch (error) {
      if (!mounted.current || !scope.isCurrent()) return;
      log.error('Failed to toggle scheduled job', { jobId: job.id, error });
      notificationService.error(
        t('nav.scheduledJobs.messages.updateFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [loadJobs, notifyScheduledJobsChanged, t]);

  const handleSave = useCallback(async () => {
    if (savePending.current) return;
    const scope = getActiveSurfaceScope();
    const nextValidationErrors = validateDraft(draftTargetKind, draft);
    setValidationErrors(nextValidationErrors);
    if (hasValidationErrors(nextValidationErrors)) { return; }
    if (!workspaceRef) { return; }

    const schedule = buildScheduleFromDraft(draft);
    const target = buildTargetFromDraft(draftTargetKind, draft, workspaceRef);

    savePending.current = true;
    setSaving(true);
    try {
      if (selectedJobId) {
        const request: UpdateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          ...(supportsReportPolicy ? { reportPolicy: draft.reportPolicy } : {}),
          schedule,
          target,
        };
        const updated = await cronAPI.updateJob(selectedJobId, request);
        if (!mounted.current || !scope.isCurrent()) return;
        setSelectedJobId(null);
        setDraft(jobToDraft(updated, defaultAgentType));
        setExpandedJobId(null);
      } else {
        const request: CreateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          ...(supportsReportPolicy ? { reportPolicy: draft.reportPolicy } : {}),
          schedule,
          target,
        };
        await cronAPI.createJob(request);
        if (!mounted.current || !scope.isCurrent()) return;
        setSelectedJobId(null);
        setExpandedJobId(null);
        setDraft(createEmptyDraft(
          targetKind === 'session' && !assistantWorkspaceMode
            ? (lockSessionId ? sessionId || '' : defaultSessionIdForWorkspace)
            : '',
          defaultAgentType,
        ));
      }
      if (creationOnly) {
        notifyScheduledJobsChanged();
        onCreationClose?.();
        return;
      }
      await loadJobs();
      if (!mounted.current || !scope.isCurrent()) return;
      notifyScheduledJobsChanged();
    } catch (error) {
      if (!mounted.current || !scope.isCurrent()) return;
      log.error('Failed to save scheduled job', { error });
      notificationService.error(
        t('nav.scheduledJobs.messages.saveFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      savePending.current = false;
      if (mounted.current && scope.isCurrent()) setSaving(false);
    }
  }, [
    creationOnly,
    onCreationClose,
    defaultAgentType,
    defaultSessionIdForWorkspace,
    supportsReportPolicy,
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
      t,
      workspaceKind,
    ),
    [availableModes, defaultAgentType, draft.agentType, workspaceKind, t],
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

  const separateCreation = creationOnly || listPresentation === 'table';
  const creationDialog = separateCreation && expandedJobId === NEW_JOB_ID && (
    <Dialog open onOpenChange={open => { if (!open) handleCloseEditor(); }} size="md" initialFocusRef={creationNameRef} className="asv__create-dialog">
      <DialogHeader>
        <DialogHeading><DialogTitle>{t('nav.scheduledJobs.actions.newJob')}</DialogTitle></DialogHeading>
        <DialogClose aria-label={t('actions.close')} disabled={saving} />
      </DialogHeader>
      <DialogBody>{renderForm(false)}</DialogBody>
      <DialogFooter>{renderFormActions(true)}</DialogFooter>
    </Dialog>
  );
  if (creationOnly) return creationDialog;

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
          leadingIcon={<Icon name="plus" size="sm" />}
          onClick={handleCreateNew}
          disabled={saving || (assistantWorkspaceMode ? !workspaceRef : targetKind === 'session' ? !canSave : !workspaceRef)}
        >
          {t('nav.scheduledJobs.actions.newJob')}
        </Button>
      </div>

      {separateCreation ? creationDialog : expandedJobId === NEW_JOB_ID ? renderEditor() : null}
      {loadError && <Alert tone="error" role="status" message={loadError}
        description={<Button size="sm" variant="text" disabled={loading} onClick={() => void loadJobs()}>{t('retry')}</Button>} />}

      {loading ? (
        <div className="asv__empty" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="empty" data-openbitfun-state="loading">
          <Icon name="refresh" size="sm" className="asv__spin" />
        </div>
      ) : !loadError && sortedJobs.length === 0 && expandedJobId !== NEW_JOB_ID ? (
        <div className="asv__empty" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="empty">
          <p className="asv__empty-title">{emptyTitle}</p>
        </div>
      ) : sortedJobs.length > 0 && listPresentation === 'table' ? (
        <div className="asv__table-wrap" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="list">
          <div role="table" className="asv__table" aria-label={t('nav.scheduledJobs.listTitle')}>
            <div role="row" className="resource-table__row resource-table__header"><div role="columnheader">{t('nav.scheduledJobs.fields.name')}</div><div role="columnheader">{t('nav.scheduledJobs.fields.scheduleKind')}</div>
              <div role="columnheader">{t('nav.scheduledJobs.columns.status')}</div><div role="columnheader">{t('nav.scheduledJobs.columns.actions')}</div></div>
            {sortedJobs.map(job => <React.Fragment key={job.id}>
              <div role="row" className="resource-table__row asv__table-row" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="job">
                <div role="cell"><div className="asv__table-copy"><OverflowText className="asv__table-name">{job.name}</OverflowText>
                  <OverflowText className="asv__table-meta">{job.payload.text}</OverflowText></div></div>
                <div role="cell"><div className="asv__table-copy"><span>{formatScheduleSummary(job.schedule, formatDate, t)}</span>
                  <span className="asv__table-meta">{t('nav.scheduledJobs.nextRunLabel')}: {formatTimestamp(getNextExecutionAtMs(job), formatDate, t)}</span>
                  {job.state.lastError && <span className="asv__item-error">{job.state.lastError}</span>}</div></div>
                <div role="cell"><StatusPill tone={job.enabled && job.state.lastRunStatus === 'error' ? 'danger' : job.enabled ? 'info' : 'neutral'}>
                  {t(`nav.scheduledJobs.status.${job.enabled ? job.state.lastRunStatus || 'idle' : 'disabled'}`)}</StatusPill></div>
                <div role="cell"><div className="asv__table-actions">
                  <Switch checked={job.enabled} disabled={saving} aria-label={t('nav.scheduledJobs.actions.toggleEnabled')}
                    onChange={event => void handleToggleEnabled(job, event.currentTarget.checked)} />
                  <IconButton size="sm" disabled={saving} aria-label={t('nav.scheduledJobs.actions.edit')} aria-expanded={expandedJobId === job.id}
                    icon={<Icon name="edit" size="sm" />} onClick={() => handleEditJob(job)} />
                  <IconButton size="sm" tone="danger" disabled={saving} aria-label={t('nav.scheduledJobs.actions.delete')}
                    icon={<Icon name="delete" size="sm" />} onClick={() => void handleDeleteJob(job)} />
                </div></div>
              </div>
              {expandedJobId === job.id && <div role="row" className="resource-table__row resource-table__details asv__table-editor"><div role="cell" aria-colspan={4}>{renderEditor()}</div></div>}
            </React.Fragment>)}
          </div>
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
                          resolveAgentLabel: id => {
                            const mode = availableModes.find(mode => mode.id === id);
                            return agentName(mode ?? { id, name: id }, t);
                          },
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

  function renderForm(showActions = true) {
    const Form = showActions ? 'div' : 'form';
    return (
      <Form id={showActions ? undefined : creationFormId} className={`asv__form${showActions ? '' : ' asv__form--dialog'}`}
        onSubmit={event => { event.preventDefault(); if (canSave && !saving) void handleSave(); }}
        data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="form">
        {targetKind === 'session' && !assistantWorkspaceMode && !canSave ? (
          <p className="asv__warning" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="warning">
            {t('nav.scheduledJobs.messages.sessionRequired')}
          </p>
        ) : null}

        <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.name')}>
          <Input
            disabled={saving}
            ref={showActions ? undefined : creationNameRef}
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
        </ScheduledJobField>

        <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.scheduleKind')} controlLayout="schedule"
          controlTrailing={showActions ? (
            <div className="asv__toggle-card" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="toggle">
              <span className="asv__toggle-label">{t('nav.scheduledJobs.fields.enabled')}</span>
              <Switch
                disabled={saving}
                className="asv__switch"
                checked={draft.enabled}
                onChange={e => {
                  const enabled = e.currentTarget.checked;
                  setDraft(c => ({ ...c, enabled }));
                }}
                aria-label={t('nav.scheduledJobs.fields.enabled')}
              />
            </div>
          ) : undefined}>
          <Select
            disabled={saving}
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
        </ScheduledJobField>

        {draft.scheduleKind === 'at' && (
          <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.at')}>
            <LocalizedDateTimeField
              disabled={saving}
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
          </ScheduledJobField>
        )}

        {draft.scheduleKind === 'every' && (
          <>
            <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.everyMs')}
              controlTrailing={
                <Select
                  disabled={saving}
                  aria-label={t('nav.scheduledJobs.fields.everyMs')}
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
              }>
              <Input
                disabled={saving}
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
            </ScheduledJobField>
            <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.anchorMs')}>
              <LocalizedDateTimeField
                disabled={saving}
                value={draft.anchorMs}
                onChange={anchorMs => setDraft(c => ({ ...c, anchorMs }))}
                aria-label={t('nav.scheduledJobs.fields.anchorMs')}
              />
            </ScheduledJobField>
          </>
        )}

        {draft.scheduleKind === 'cron' && (
          <>
            <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.cronExpr')}
              description={t('nav.scheduledJobs.hints.cronExpr')}>
              <Input
                disabled={saving}
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
            </ScheduledJobField>
            <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.timezone')}>
              <Input
                disabled={saving}
                value={draft.tz}
                onChange={e => {
                  const tz = e.currentTarget.value;
                  setDraft(c => ({ ...c, tz }));
                }}
                placeholder={t('nav.scheduledJobs.placeholders.timezone')}
                size="sm"
              />
            </ScheduledJobField>
          </>
        )}

        {assistantWorkspaceMode ? (
          <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.session')}>
            <Combobox
              disabled={saving}
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
          </ScheduledJobField>
        ) : targetKind === 'workspace' ? (
          <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.agentType')}>
            <Combobox
              size="sm"
              options={workspaceAgentOptions}
              value={draft.agentType}
              invalid={validationErrors.agentType}
              disabled={saving || workspaceKind === WorkspaceKind.Assistant}
              className="asv__agent-select"
              onValueChange={value => {
                const agentType = String(value);
                setValidationErrors(current => ({ ...current, agentType: false }));
                setDraft(c => ({ ...c, agentType }));
              }}
              placeholder={t('nav.scheduledJobs.placeholders.agentType')}
            />
          </ScheduledJobField>
        ) : !lockSessionId ? (
          <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.session')}>
            <Combobox
              disabled={saving}
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
          </ScheduledJobField>
        ) : null}

        <ScheduledJobField dialog={!showActions} prompt label={t('nav.scheduledJobs.fields.prompt')}>
          <Textarea
            disabled={saving}
            className="asv__prompt-textarea"
            rows={4}
            value={draft.text}
            onChange={e => {
              const text = e.currentTarget.value;
              setValidationErrors(current => ({ ...current, text: false }));
              setDraft(c => ({ ...c, text }));
            }}
            invalid={validationErrors.text}
            autoResize={showActions}
            layout="fill"
            variant={showActions ? 'default' : 'outlined'}
            resize={showActions ? 'vertical' : 'none'}
            showCount
            maxLength={4000}
            placeholder={t('nav.scheduledJobs.placeholders.prompt')}
          />
        </ScheduledJobField>

        <ScheduledJobField dialog={!showActions} label={t('nav.scheduledJobs.fields.reportPolicy')}
          description={t(supportsReportPolicy ? 'nav.scheduledJobs.hints.reportPolicy' : 'nav.scheduledJobs.hints.reportPolicyUnsupported')}>
          <Select size="sm" value={draft.reportPolicy} disabled={saving || !supportsReportPolicy}
            options={(['inherit', 'always', 'conditional'] as const).map(value => ({ value, label: t(`nav.scheduledJobs.reportPolicies.${value}`) }))}
            onValueChange={value => setDraft(current => ({ ...current, reportPolicy: value as JobDraft['reportPolicy'] }))} />
        </ScheduledJobField>

        {!showActions && <Field label={t('nav.scheduledJobs.fields.enabled')} orientation="horizontal">
          <Switch checked={draft.enabled} disabled={saving} aria-label={t('nav.scheduledJobs.fields.enabled')}
            onChange={event => {
              const enabled = event.currentTarget.checked;
              setDraft(current => ({ ...current, enabled }));
            }} />
        </Field>}

        {showActions && <div className="asv__form-actions" data-openbitfun-component="scheduled-jobs-view" data-openbitfun-part="formActions">
          {renderFormActions()}
        </div>}
      </Form>
    );
  }
  function renderFormActions(dialog = false) {
    return <>
      <Button type="button" size="sm" className={dialog ? undefined : 'asv__action-btn'} variant="fill" disabled={saving} onClick={handleCloseEditor}>
        {t('nav.scheduledJobs.actions.cancel')}
      </Button>
      <Button type={dialog ? 'submit' : 'button'} form={dialog ? creationFormId : undefined}
        size="sm" className={dialog ? undefined : 'asv__action-btn'} variant="primary" onClick={dialog ? undefined : () => { void handleSave(); }}
        disabled={!canSave || saving} loading={saving}>
        {selectedJobId ? t('nav.scheduledJobs.actions.save') : t('nav.scheduledJobs.actions.create')}
      </Button>
    </>;
  }
};

export default ScheduledJobsView;
