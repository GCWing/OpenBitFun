/**
 * TodosScene — one place for every scheduled task across all workspaces.
 *
 * Two tiers, as the panel's contract:
 *   - anything due within 24 hours is listed, soonest first;
 *   - the month calendar carries the whole remaining agenda, near-term runs
 *     included, so a day cell is never mysteriously empty.
 *
 * Todos are scheduled jobs, so this reads and writes the same cron service the
 * agent's own scheduling tool and the per-workspace editors use. Changes here
 * broadcast on the shared change event so those views stay in step.
 */

import {
  Button,
  Icon,
  IconButton,
  ScrollArea,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
} from '@openbitfun/ui';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CalendarDays } from 'lucide-react';
import { RetainedMountBoundary } from '@/shared/presence';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { cronAPI, type CronJob, type CreateCronJobRequest, type UpdateCronJobRequest } from '@/infrastructure/api';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { WorkspaceKind } from '@/shared/types';
import {
  ASSISTANT_WORKSPACE_AGENT_TYPE,
  DEFAULT_AGENT_TYPE,
  EMPTY_VALIDATION_ERRORS,
  SCHEDULED_JOBS_CHANGED_EVENT,
  buildScheduleFromDraft,
  buildTargetFromDraft,
  buildWorkspaceRef,
  createEmptyDraft,
  hasValidationErrors,
  jobToDraft,
  notifyScheduledJobsChanged,
  validateDraft,
  type JobDraft,
  type JobDraftValidationErrors,
} from '@/app/components/scheduled-jobs/scheduledJobDraft';
import TodoCalendar from './components/TodoCalendar';
import TodoEditor from './components/TodoEditor';
import TodoItemRow from './components/TodoItemRow';
import {
  buildTodoBuckets,
  groupOccurrencesByDay,
  monthRangeMs,
  type InactiveReason,
  type TodoOccurrence,
} from './todoOccurrences';
import { buildWorkspaceOptions, formatDateTime } from './todoPresentation';
import './TodosScene.scss';

const log = createLogger('TodosScene');

/** Keeps countdowns honest without re-rendering more than once a minute. */
const CLOCK_TICK_MS = 30_000;

function startOfCurrentMonthMs(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

const TodosScene: React.FC = () => {
  const { t, formatDate } = useI18n(['scenes/todos', 'common', 'shared']);
  const instanceIdRef = useRef(`todos-scene-${Math.random().toString(36).slice(2)}`);

  const { openedWorkspacesList, currentWorkspace, primaryAssistantWorkspaceId } = useWorkspaceContext();

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [saving, setSaving] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [monthAnchorMs, setMonthAnchorMs] = useState(() => startOfCurrentMonthMs(Date.now()));
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  // The whole job, not just its id: saving has to preserve the target kind a
  // job was created with, so editing a session-bound job here never silently
  // turns it into one that launches a fresh session.
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [draft, setDraft] = useState<JobDraft>(() => createEmptyDraft());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [validationErrors, setValidationErrors] = useState<JobDraftValidationErrors>(
    EMPTY_VALIDATION_ERRORS,
  );

  const workspaceOptions = useMemo(
    () => buildWorkspaceOptions(openedWorkspacesList),
    [openedWorkspacesList],
  );
  const liveEditorSnapshot = {
    editingJob,
    draft,
    validationErrors,
    workspaceOptions,
    selectedWorkspaceId,
    saving,
  };
  const retainedEditorSnapshotRef = useRef(liveEditorSnapshot);
  useLayoutEffect(() => {
    if (editorOpen) {
      retainedEditorSnapshotRef.current = {
        editingJob,
        draft,
        validationErrors,
        workspaceOptions,
        selectedWorkspaceId,
        saving,
      };
    }
  }, [
    draft,
    editingJob,
    editorOpen,
    saving,
    selectedWorkspaceId,
    validationErrors,
    workspaceOptions,
  ]);
  const renderedEditor = editorOpen ? liveEditorSnapshot : retainedEditorSnapshotRef.current;

  /** Where a new Todo lands by default: current workspace, else the assistant. */
  const defaultWorkspaceId = useMemo(() => {
    if (currentWorkspace && workspaceOptions.some((o) => o.value === currentWorkspace.id)) {
      return currentWorkspace.id;
    }
    if (
      primaryAssistantWorkspaceId
      && workspaceOptions.some((o) => o.value === primaryAssistantWorkspaceId)
    ) {
      return primaryAssistantWorkspaceId;
    }
    return workspaceOptions[0]?.value ?? '';
  }, [currentWorkspace, primaryAssistantWorkspaceId, workspaceOptions]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      // No filters: the Todos panel is the cross-workspace view.
      const result = await cronAPI.listJobs({});
      setJobs(result);
    } catch (error) {
      log.error('Failed to load scheduled jobs for the Todos scene', { error });
      notificationService.error(
        t('messages.loadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [t]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  // Another view (a workspace editor, or the agent's own scheduling tool)
  // changed a job — reload so the panel is never stale.
  useEffect(() => {
    const handleChanged = (event: Event) => {
      const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
      if (sourceId === instanceIdRef.current) return;
      void loadJobs();
    };
    window.addEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(SCHEDULED_JOBS_CHANGED_EVENT, handleChanged);
  }, [loadJobs]);

  const calendarRange = useMemo(() => monthRangeMs(monthAnchorMs), [monthAnchorMs]);

  const buckets = useMemo(
    () => buildTodoBuckets(jobs, { nowMs, rangeEndMs: calendarRange.endMs }),
    [calendarRange.endMs, jobs, nowMs],
  );

  const selectedDayOccurrences = useMemo(() => {
    if (!selectedDayKey) return [];
    return groupOccurrencesByDay(buckets.calendar).get(selectedDayKey) ?? [];
  }, [buckets.calendar, selectedDayKey]);
  const retainedSelectedDayOccurrencesRef = useRef(selectedDayOccurrences);
  useLayoutEffect(() => {
    if (selectedDayKey) retainedSelectedDayOccurrencesRef.current = selectedDayOccurrences;
  }, [selectedDayKey, selectedDayOccurrences]);
  const renderedSelectedDayOccurrences = selectedDayKey
    ? selectedDayOccurrences
    : retainedSelectedDayOccurrencesRef.current;

  const resetEditor = useCallback(() => {
    setEditorOpen(false);
    setEditingJob(null);
    setValidationErrors(EMPTY_VALIDATION_ERRORS);
    setDraft(createEmptyDraft());
  }, []);

  const handleCloseEditor = useCallback(() => {
    if (saving) return;
    resetEditor();
  }, [resetEditor, saving]);

  const handleCreateNew = useCallback(() => {
    const workspace = workspaceOptions.find((option) => option.value === defaultWorkspaceId);
    const agentType = workspace?.workspace.workspaceKind === WorkspaceKind.Assistant
      ? ASSISTANT_WORKSPACE_AGENT_TYPE
      : DEFAULT_AGENT_TYPE;

    setEditingJob(null);
    setValidationErrors(EMPTY_VALIDATION_ERRORS);
    setDraft(createEmptyDraft('', agentType));
    setSelectedWorkspaceId(defaultWorkspaceId);
    setEditorOpen(true);
  }, [defaultWorkspaceId, workspaceOptions]);

  const handleEdit = useCallback((job: CronJob) => {
    // Toggle the editor shut when the same Todo is clicked twice.
    if (editorOpen && editingJob?.id === job.id) {
      resetEditor();
      return;
    }

    const ref = job.target.workspace;
    const matchedOption = workspaceOptions.find(option => option.workspace.id === ref.workspaceId);

    setEditingJob(job);
    setValidationErrors(EMPTY_VALIDATION_ERRORS);
    setDraft(jobToDraft(job, DEFAULT_AGENT_TYPE));
    setSelectedWorkspaceId(matchedOption?.value ?? '');
    setEditorOpen(true);
  }, [editingJob, editorOpen, resetEditor, workspaceOptions]);

  const handleToggleEnabled = useCallback(async (job: CronJob, enabled: boolean) => {
    try {
      await cronAPI.updateJob(job.id, { enabled });
      await loadJobs();
      notifyScheduledJobsChanged(instanceIdRef.current);
    } catch (error) {
      log.error('Failed to toggle Todo', { jobId: job.id, error });
      notificationService.error(
        t('messages.updateFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [loadJobs, t]);

  const handleDelete = useCallback(async (job: CronJob) => {
    const confirmed = await confirmDanger(t('deleteDialog.title', { name: job.name }), null);
    if (!confirmed) return;

    try {
      await cronAPI.deleteJob(job.id);
      if (editingJob?.id === job.id) resetEditor();
      await loadJobs();
      notifyScheduledJobsChanged(instanceIdRef.current);
    } catch (error) {
      log.error('Failed to delete Todo', { jobId: job.id, error });
      notificationService.error(
        t('messages.deleteFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [editingJob, loadJobs, resetEditor, t]);

  const handleSave = useCallback(async () => {
    // New Todos always launch their own session; an existing job keeps whatever
    // target it was created with, including a binding to a specific session.
    const targetKind = editingJob?.target.kind ?? 'workspace';

    const nextErrors = validateDraft(targetKind, draft);
    setValidationErrors(nextErrors);
    if (hasValidationErrors(nextErrors)) return;

    const option = workspaceOptions.find((entry) => entry.value === selectedWorkspaceId);
    if (!option) {
      notificationService.warning(t('messages.workspaceRequired'));
      return;
    }

    const workspaceRef = buildWorkspaceRef(option.workspace.id);
    if (!workspaceRef) {
      notificationService.warning(t('messages.workspaceRequired'));
      return;
    }

    const schedule = buildScheduleFromDraft(draft);
    const target = buildTargetFromDraft(targetKind, draft, workspaceRef);

    setSaving(true);
    try {
      if (editingJob) {
        const request: UpdateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          schedule,
          target,
        };
        await cronAPI.updateJob(editingJob.id, request);
      } else {
        const request: CreateCronJobRequest = {
          name: draft.name.trim(),
          payload: { text: draft.text.trim() },
          enabled: draft.enabled,
          schedule,
          target,
        };
        await cronAPI.createJob(request);
      }
      resetEditor();
      await loadJobs();
      notifyScheduledJobsChanged(instanceIdRef.current);
    } catch (error) {
      log.error('Failed to save Todo', { error });
      notificationService.error(
        t('messages.saveFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, editingJob, loadJobs, resetEditor, selectedWorkspaceId, t, workspaceOptions]);

  const inactiveStatusLabel = useCallback((reason: InactiveReason) => {
    switch (reason) {
      case 'disabled':
        return t('inactive.disabled');
      case 'completed':
        return t('shared:statuses.done');
      default:
        return t('inactive.invalid');
    }
  }, [t]);

  const visibleTodos = useMemo(() => {
    const nextOccurrenceByJob = new Map<string, TodoOccurrence>();

    for (const occurrence of buckets.calendar) {
      const current = nextOccurrenceByJob.get(occurrence.job.id);
      if (!current || (!current.isNextRun && occurrence.isNextRun)) {
        nextOccurrenceByJob.set(occurrence.job.id, occurrence);
      }
    }

    return [...nextOccurrenceByJob.values()].sort((left, right) => (
      left.atMs - right.atMs || left.job.name.localeCompare(right.job.name)
    ));
  }, [buckets.calendar]);

  const dueSoonTodoCount = useMemo(
    () => new Set(buckets.upcoming.map((occurrence) => occurrence.job.id)).size,
    [buckets.upcoming],
  );

  const monthLabel = useMemo(() => (
    formatDate(new Date(monthAnchorMs), { year: 'numeric', month: 'long' })
  ), [formatDate, monthAnchorMs]);

  const clearSelectedDay = useCallback(() => {
    setSelectedDayKey(null);
  }, []);

  const handleSelectDay = useCallback((dayKey: string | null) => {
    if (dayKey) {
      setSelectedDayKey(dayKey);
      return;
    }
    clearSelectedDay();
  }, [clearSelectedDay]);

  const shiftMonth = useCallback((delta: number) => {
    const anchor = new Date(monthAnchorMs);
    setMonthAnchorMs(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1).getTime());
    clearSelectedDay();
  }, [clearSelectedDay, monthAnchorMs]);

  const showCurrentMonth = useCallback(() => {
    const today = new Date(nowMs);
    setMonthAnchorMs(new Date(today.getFullYear(), today.getMonth(), 1).getTime());
    clearSelectedDay();
  }, [clearSelectedDay, nowMs]);

  return (
    <ScrollArea
      className="openbitfun-todos"
      data-openbitfun-scene="todos"
      data-openbitfun-part="root"
      data-testid="todos-scene"
    >
      <header className="openbitfun-todos__head" data-openbitfun-scene="todos" data-openbitfun-part="header">
        <div className="openbitfun-todos__head-main">
          <div className="openbitfun-todos__head-text">
            <h2 className="openbitfun-todos__title">{t('title')}</h2>
            <p className="openbitfun-todos__subtitle">{t('header.subtitle')}</p>
          </div>
        </div>
        <div className="openbitfun-todos__head-actions" data-openbitfun-scene="todos" data-openbitfun-part="headerActions">
          <div
            className="openbitfun-todos__month-navigation"
            data-openbitfun-scene="todos"
            data-openbitfun-part="monthNavigation"
          >
            <Tooltip content={t('calendar.previousMonth')}>
              <IconButton
                type="button"
                size="sm"
                aria-label={t('calendar.previousMonth')}
                icon={<Icon name="chevron-left" size="lg" />}
                onClick={() => shiftMonth(-1)}
                data-testid="todos-calendar-prev"
              />
            </Tooltip>
            <span className="openbitfun-todos__month-label" data-testid="todos-calendar-month">
              <CalendarDays size={14} aria-hidden="true" />
              <span>{monthLabel}</span>
            </span>
            <Tooltip content={t('calendar.nextMonth')}>
              <IconButton
                type="button"
                size="sm"
                aria-label={t('calendar.nextMonth')}
                icon={<Icon name="chevron-right" size="lg" />}
                onClick={() => shiftMonth(1)}
                data-testid="todos-calendar-next"
              />
            </Tooltip>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="openbitfun-todos__today-button"
            onClick={showCurrentMonth}
          >
            {t('calendar.today')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="openbitfun-todos__new-button"
            leadingIcon={<Icon name="plus" size="lg" />}
            onClick={handleCreateNew}
            disabled={workspaceOptions.length === 0}
            data-testid="todos-new"
          >
            {t('actions.newTodo')}
          </Button>
        </div>
      </header>

      <Dialog
        open={editorOpen}
        onOpenChange={(nextOpen) => { if (!nextOpen) handleCloseEditor(); }}
        size="2xl"
        closeOnPointerOutside={!renderedEditor.saving}
        aria-label={renderedEditor.editingJob ? t('editor.editTitle') : t('editor.createTitle')}
        className="openbitfun-todos-editor-dialog"
        data-testid="todos-editor-modal"
      >
        <DialogHeader className="openbitfun-todos-editor-dialog__header">
          {!renderedEditor.saving && <DialogClose />}
        </DialogHeader>
        <DialogBody className="openbitfun-todos-editor-dialog__body" inset="none">
          <TodoEditor
            draft={renderedEditor.draft}
            onDraftChange={setDraft}
            validationErrors={renderedEditor.validationErrors}
            onValidationErrorsChange={setValidationErrors}
            workspaceOptions={renderedEditor.workspaceOptions}
            selectedWorkspaceId={renderedEditor.selectedWorkspaceId}
            onSelectedWorkspaceIdChange={setSelectedWorkspaceId}
            isEditing={Boolean(renderedEditor.editingJob)}
            boundSessionId={
              renderedEditor.editingJob?.target.kind === 'session'
                ? renderedEditor.editingJob.target.sessionId
                : null
            }
            saving={renderedEditor.saving}
            onSave={() => { void handleSave(); }}
            onCancel={handleCloseEditor}
          />
        </DialogBody>
      </Dialog>

      <div className="openbitfun-todos__panes" data-openbitfun-scene="todos" data-openbitfun-part="panes">
        {/* ── Tier 1: due within 24 hours ───────────────────── */}
        <ScrollArea
          className="openbitfun-todos__pane openbitfun-todos__pane--list"
          aria-label={t('list.title')}
          data-openbitfun-scene="todos"
          data-openbitfun-part="listPane"
          data-testid="todos-list-pane"
          role="region"
        >
          <section
            className="openbitfun-todos__overview"
            aria-label={t('overview.title')}
            data-openbitfun-scene="todos"
            data-openbitfun-part="overview"
            data-testid="todos-overview"
          >
            <header className="openbitfun-todos__overview-head">
              <h3 className="openbitfun-todos__overview-title">{t('overview.title')}</h3>
              <CalendarDays size={14} aria-hidden="true" />
            </header>
            <div className="openbitfun-todos__overview-metrics">
              <div className="openbitfun-todos__overview-metric">
                <p className="openbitfun-todos__overview-value">
                  <strong>{visibleTodos.length}</strong>
                  <span>{t('overview.unit')}</span>
                </p>
                <p className="openbitfun-todos__overview-label">{t('overview.total')}</p>
              </div>
              <div className="openbitfun-todos__overview-metric">
                <p className="openbitfun-todos__overview-value">
                  <strong>{dueSoonTodoCount}</strong>
                  <span>{t('overview.unit')}</span>
                </p>
                <p className="openbitfun-todos__overview-label">{t('overview.dueSoon')}</p>
              </div>
            </div>
          </section>

          <header className="openbitfun-todos__pane-head">
            <h3 className="openbitfun-todos__list-title">
              {t('list.countTitle', { total: visibleTodos.length })}
            </h3>
          </header>

          {visibleTodos.length === 0 ? (
            <p className="openbitfun-todos__empty" data-openbitfun-scene="todos" data-openbitfun-part="empty">
              {t('list.empty')}
            </p>
          ) : (
            <div className="openbitfun-todos__rows" data-openbitfun-scene="todos" data-openbitfun-part="rows">
              {visibleTodos.map((occurrence) => (
                <TodoItemRow
                  key={occurrence.job.id}
                  job={occurrence.job}
                  atMs={occurrence.atMs}
                  isOverdue={occurrence.isOverdue}
                  isNextRun={occurrence.isNextRun}
                  isRunning={occurrence.isRunning}
                  nowMs={nowMs}
                  workspaces={openedWorkspacesList}
                  isSelected={editingJob?.id === occurrence.job.id}
                  onEdit={handleEdit}
                  onDelete={(job) => { void handleDelete(job); }}
                  onToggleEnabled={(job, enabled) => { void handleToggleEnabled(job, enabled); }}
                />
              ))}
            </div>
          )}

          {buckets.inactive.length > 0 ? (
            <div className="openbitfun-todos__inactive" data-openbitfun-scene="todos" data-openbitfun-part="inactive">
              <h4 className="openbitfun-todos__inactive-title">
                {t('inactive.title', { total: buckets.inactive.length })}
              </h4>
              <div className="openbitfun-todos__rows">
                {buckets.inactive.map((entry) => (
                  <TodoItemRow
                    key={entry.job.id}
                    job={entry.job}
                    atMs={null}
                    nowMs={nowMs}
                    workspaces={openedWorkspacesList}
                    statusLabel={inactiveStatusLabel(entry.reason)}
                    isSelected={editingJob?.id === entry.job.id}
                    onEdit={handleEdit}
                    onDelete={(job) => { void handleDelete(job); }}
                    onToggleEnabled={(job, enabled) => { void handleToggleEnabled(job, enabled); }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </ScrollArea>

        {/* ── Tier 2: more than 24 hours out ────────────────── */}
        <div
          className="openbitfun-todos__pane openbitfun-todos__pane--calendar"
          data-openbitfun-scene="todos"
          data-openbitfun-part="calendarPane"
          data-has-selection={selectedDayKey ? 'true' : 'false'}
          data-testid="todos-calendar-pane"
        >
          <TodoCalendar
            occurrences={buckets.calendar}
            monthAnchorMs={monthAnchorMs}
            selectedDayKey={selectedDayKey}
            nowMs={nowMs}
            onSelectDay={handleSelectDay}
          />

          <RetainedMountBoundary
            present={selectedDayKey != null}
            retainForMs={160}
            minimumRetainMs={160}
          >
            <ScrollArea
              className="openbitfun-todos__day-detail-presence"
              data-open={selectedDayKey ? 'true' : 'false'}
              aria-hidden={!selectedDayKey}
              {...(!selectedDayKey ? { inert: '' } : {})}
            >
              <section
                className="openbitfun-todos__day-detail"
                aria-label={t('calendar.dayDetailTitle')}
                data-openbitfun-scene="todos"
                data-openbitfun-part="dayDetail"
                data-testid="todos-day-detail"
              >
                <header className="openbitfun-todos__day-detail-head">
                  <h4 className="openbitfun-todos__day-detail-title">
                    {renderedSelectedDayOccurrences[0]
                      ? formatDateTime(renderedSelectedDayOccurrences[0].atMs, formatDate)
                      : t('calendar.dayDetailTitle')}
                  </h4>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearSelectedDay}
                    data-testid="todos-day-clear"
                  >
                    {t('calendar.clearDay')}
                  </Button>
                </header>
                {renderedSelectedDayOccurrences.length === 0 ? (
                  <p className="openbitfun-todos__empty" data-testid="todos-day-empty">
                    {t('calendar.dayEmpty')}
                  </p>
                ) : (
                  <div className="openbitfun-todos__rows">
                    {renderedSelectedDayOccurrences.map((occurrence) => (
                      <TodoItemRow
                        key={`${occurrence.job.id}-${occurrence.atMs}`}
                        job={occurrence.job}
                        atMs={occurrence.atMs}
                        isNextRun={occurrence.isNextRun}
                        isRunning={occurrence.isRunning}
                        nowMs={nowMs}
                        workspaces={openedWorkspacesList}
                        isSelected={editingJob?.id === occurrence.job.id}
                        onEdit={handleEdit}
                        onDelete={(job) => { void handleDelete(job); }}
                        onToggleEnabled={(job, enabled) => { void handleToggleEnabled(job, enabled); }}
                      />
                    ))}
                  </div>
                )}
              </section>
            </ScrollArea>
          </RetainedMountBoundary>
        </div>
      </div>
    </ScrollArea>
  );
};

export default TodosScene;
