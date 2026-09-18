/**
 * Pure draft <-> CronJob conversion helpers shared by every scheduled-job editor.
 *
 * These are deliberately free of React and i18n so both the per-workspace
 * `ScheduledJobsView` and the global Todos scene can build the same request
 * shapes from the same form state.
 */

import type {
  CronJob,
  CronJobTargetRequest,
  CronJobTargetKind,
  CronSchedule,

} from '@/infrastructure/api';

export const MINUTE_IN_MS = 60_000;
export const HOUR_IN_MS = 60 * MINUTE_IN_MS;
export const DAY_IN_MS = 24 * HOUR_IN_MS;
export const DEFAULT_AGENT_TYPE = 'Standard';
export const ASSISTANT_WORKSPACE_AGENT_TYPE = 'Claw';

/**
 * Interval units offered by the editors.
 *
 * The wire format stays milliseconds; the unit only decides how a value is
 * entered and read back, so a daily job reads "every 1 day" rather than
 * "every 1440 minutes".
 */
export type IntervalUnit = 'minute' | 'hour' | 'day';

/** Selector order, coarsest-last so the common "every N minutes" stays first. */
export const INTERVAL_UNIT_OPTIONS: readonly IntervalUnit[] = ['minute', 'hour', 'day'];

export const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  minute: MINUTE_IN_MS,
  hour: HOUR_IN_MS,
  day: DAY_IN_MS,
};

/** Largest unit that divides the interval evenly, so the value stays whole. */
export function splitInterval(everyMs: number): { value: number; unit: IntervalUnit } {
  if (Number.isFinite(everyMs) && everyMs > 0) {
    if (everyMs % DAY_IN_MS === 0) return { value: everyMs / DAY_IN_MS, unit: 'day' };
    if (everyMs % HOUR_IN_MS === 0) return { value: everyMs / HOUR_IN_MS, unit: 'hour' };
  }
  return { value: everyMs / MINUTE_IN_MS, unit: 'minute' };
}

/** Emitted after any create/update/delete so other mounted views reload. */
export const SCHEDULED_JOBS_CHANGED_EVENT = 'openbitfun:scheduled-jobs-changed';

export type ScheduleKind = CronSchedule['kind'];

export interface JobDraft {
  name: string;
  text: string;
  enabled: boolean;
  sessionId: string;
  agentType: string;
  scheduleKind: ScheduleKind;
  at: string;
  /** Interval value in `everyUnit`; kept as a string so the input stays free-form. */
  everyValue: string;
  everyUnit: IntervalUnit;
  anchorMs: string;
  expr: string;
  tz: string;
}

export interface JobDraftValidationErrors {
  name: boolean;
  sessionId: boolean;
  agentType: boolean;
  text: boolean;
  at: boolean;
  everyValue: boolean;
  cronExpr: boolean;
}

/** Shared reset value. Frozen because callers hold the same reference. */
export const EMPTY_VALIDATION_ERRORS: JobDraftValidationErrors = Object.freeze({
  name: false,
  sessionId: false,
  agentType: false,
  text: false,
  at: false,
  everyValue: false,
  cronExpr: false,
});

export function toLocalDateTimeInput(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const timezoneOffset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - timezoneOffset * MINUTE_IN_MS);
  return localDate.toISOString().slice(0, 16);
}

export function getCurrentLocalDateTimeInput(): string {
  return toLocalDateTimeInput(new Date().toISOString());
}

export function timestampMsToLocalDateTimeInput(timestampMs: number): string {
  return toLocalDateTimeInput(new Date(timestampMs).toISOString());
}

export function isFutureLocalDateTimeInput(value: string, nowMs = Date.now()): boolean {
  const timestampMs = new Date(value).getTime();
  return Number.isFinite(timestampMs) && timestampMs > nowMs;
}

/** Trims a possibly fractional interval value to a short display string. */
export function formatIntervalValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function createEmptyDraft(
  defaultSessionId = '',
  defaultAgentType = DEFAULT_AGENT_TYPE,
): JobDraft {
  return {
    name: '',
    text: '',
    enabled: true,
    sessionId: defaultSessionId,
    agentType: defaultAgentType,
    scheduleKind: 'at',
    at: getCurrentLocalDateTimeInput(),
    everyValue: '1',
    everyUnit: 'hour',
    anchorMs: '',
    expr: '0 8 * * *',
    tz: '',
  };
}

export function jobToDraft(job: CronJob, defaultAgentType: string): JobDraft {
  const base = createEmptyDraft('', defaultAgentType);
  const draft: JobDraft = {
    ...base,
    name: job.name,
    text: job.payload.text,
    enabled: job.enabled,
  };
  if (job.target.kind === 'session') {
    draft.sessionId = job.target.sessionId;
  } else {
    draft.agentType = job.target.launch.agentType || defaultAgentType;
  }
  if (job.schedule.kind === 'at') {
    draft.scheduleKind = 'at';
    draft.at = toLocalDateTimeInput(job.schedule.at);
  } else if (job.schedule.kind === 'every') {
    draft.scheduleKind = 'every';
    const interval = splitInterval(job.schedule.everyMs);
    draft.everyValue = formatIntervalValue(interval.value);
    draft.everyUnit = interval.unit;
    draft.anchorMs = job.schedule.anchorMs != null
      ? timestampMsToLocalDateTimeInput(job.schedule.anchorMs)
      : '';
  } else {
    draft.scheduleKind = 'cron';
    draft.expr = job.schedule.expr;
    draft.tz = job.schedule.tz ?? '';
  }
  return draft;
}

export function buildScheduleFromDraft(draft: JobDraft): CronSchedule {
  if (draft.scheduleKind === 'at') {
    return { kind: 'at', at: new Date(draft.at).toISOString() };
  }
  if (draft.scheduleKind === 'every') {
    const everyValue = Number(draft.everyValue);
    const anchorMs = draft.anchorMs.trim() ? new Date(draft.anchorMs).getTime() : undefined;
    return {
      kind: 'every',
      everyMs: Math.round(everyValue * INTERVAL_UNIT_MS[draft.everyUnit]),
      anchorMs,
    };
  }
  return { kind: 'cron', expr: draft.expr.trim(), tz: draft.tz.trim() || undefined };
}

export function buildWorkspaceRef(workspaceId?: string): { workspaceId: string } | null {
  const id = workspaceId?.trim();
  return id ? { workspaceId: id } : null;
}

export function buildTargetFromDraft(
  targetKind: CronJobTargetKind,
  draft: JobDraft,
  workspace: { workspaceId: string },
): CronJobTargetRequest {
  if (targetKind === 'session') {
    return {
      kind: 'session',
      sessionId: draft.sessionId.trim(),
      workspace,
    };
  }

  return {
    kind: 'workspace',
    workspace,
    launch: {
      agentType: draft.agentType.trim() || DEFAULT_AGENT_TYPE,
    },
  };
}

export function validateDraft(
  targetKind: CronJobTargetKind,
  draft: JobDraft,
): JobDraftValidationErrors {
  const everyValue = Number(draft.everyValue);
  return {
    name: !draft.name.trim(),
    sessionId: targetKind === 'session' && !draft.sessionId.trim(),
    agentType: targetKind === 'workspace' && !draft.agentType.trim(),
    text: !draft.text.trim(),
    at: draft.scheduleKind === 'at' && !draft.at.trim(),
    everyValue:
      draft.scheduleKind === 'every'
      && (!draft.everyValue.trim() || !Number.isFinite(everyValue) || everyValue <= 0),
    cronExpr: draft.scheduleKind === 'cron' && !draft.expr.trim(),
  };
}

export function hasValidationErrors(errors: JobDraftValidationErrors): boolean {
  return (
    errors.name
    || errors.sessionId
    || errors.agentType
    || errors.text
    || errors.at
    || errors.everyValue
    || errors.cronExpr
  );
}

/** Timestamp the scheduler will actually act on next, or null when nothing is pending. */
export function getNextExecutionAtMs(job: CronJob): number | null {
  return job.state.pendingTriggerAtMs ?? job.state.retryAtMs ?? job.state.nextRunAtMs ?? null;
}

export function notifyScheduledJobsChanged(sourceId: string): void {
  window.dispatchEvent(new CustomEvent(SCHEDULED_JOBS_CHANGED_EVENT, {
    detail: { sourceId },
  }));
}
