/**
 * Label helpers shared by the Todos list, calendar and editor.
 *
 * All user-visible strings come from i18n; these functions only assemble them.
 */

import type { CronJob, CronSchedule } from '@/infrastructure/api';
import { formatIntervalValue, splitInterval } from '@/app/components/scheduled-jobs/scheduledJobDraft';
import { WorkspaceKind, type WorkspaceInfo, isRemoteWorkspace } from '@/shared/types';
import { normalizePath } from '@/shared/utils/pathUtils';

type Translate = (key: string, params?: Record<string, unknown>) => string;
type FormatDate = (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;

export function formatTimeOfDay(timestampMs: number, formatDate: FormatDate): string {
  return formatDate(timestampMs, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(timestampMs: number, formatDate: FormatDate): string {
  return formatDate(timestampMs, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * "Every 30 minutes" / "Every 1 day", using the largest unit that divides the
 * interval evenly so a daily job does not read as 1440 minutes.
 */
export function formatIntervalSummary(everyMs: number, t: Translate): string {
  const { value, unit } = splitInterval(everyMs);
  return t(`schedule.everyUnit.${unit}`, { value: formatIntervalValue(value) });
}

/** Human summary of the recurrence rule, independent of any single run. */
export function formatScheduleSummary(
  schedule: CronSchedule,
  t: Translate,
  formatDate: FormatDate,
): string {
  switch (schedule.kind) {
    case 'at':
      return t('schedule.once', { at: formatDateTime(new Date(schedule.at).getTime(), formatDate) });
    case 'every':
      return formatIntervalSummary(schedule.everyMs, t);
    case 'cron':
      return schedule.tz
        ? t('schedule.cronWithTz', { expr: schedule.expr, tz: schedule.tz })
        : t('schedule.cron', { expr: schedule.expr });
    default:
      return '';
  }
}

/**
 * Coarse "in 2 hr" / "in 3 days" text for the list tier.
 *
 * Uses explicit keys rather than `Intl.RelativeTimeFormat` so the wording stays
 * under translator control alongside the rest of the panel.
 */
export function formatCountdown(
  targetMs: number,
  nowMs: number,
  t: Translate,
): string {
  const deltaMs = targetMs - nowMs;
  if (deltaMs < 0) return t('relative.overdue');

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return t('relative.now');
  if (minutes < 60) return t('relative.inMinutes', { value: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('relative.inHours', { value: hours });

  const days = Math.floor(hours / 24);
  return days === 1 ? t('relative.inOneDay') : t('relative.inDays', { value: days });
}

export function resolveWorkspaceDisplayName(workspace: WorkspaceInfo): string {
  if (workspace.workspaceKind === WorkspaceKind.Assistant) {
    return workspace.identity?.name?.trim() || workspace.name;
  }
  return workspace.name;
}

/**
 * Names the workspace a job runs in.
 *
 * The job's `workspaceId` is the only identity that may select a workspace
 * record (`CronAPI` upgrades pre-ID jobs before they reach this layer). Jobs
 * outlive the workspace list — a workspace can be closed while its jobs keep
 * running — so an unmatched job is labelled from its stored path instead of
 * implying the job is gone; the path never picks another workspace.
 */
export function resolveJobWorkspaceLabel(
  job: CronJob,
  workspaces: WorkspaceInfo[],
): string {
  const ref = job.target.workspace;
  const matched = ref.workspaceId
    ? workspaces.find((workspace) => workspace.id === ref.workspaceId)
    : undefined;

  if (matched) return resolveWorkspaceDisplayName(matched);

  const normalizedJobPath = normalizePath(ref.workspacePath);
  const segments = normalizedJobPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || ref.workspacePath;
}

/** What the job launches into: a specific session, or a fresh one. */
export function formatJobTargetLabel(job: CronJob, t: Translate): string {
  if (job.target.kind === 'session') {
    return t('target.existingSession');
  }
  return t('target.newSession', { agentType: job.target.launch.agentType });
}

export interface TodoWorkspaceOption {
  workspace: WorkspaceInfo;
  value: string;
  label: string;
  description: string;
  remoteConnectionId: string | null;
  remoteSshHost: string | null;
}

/** Workspaces a Todo can be created against, assistants first. */
export function buildWorkspaceOptions(workspaces: WorkspaceInfo[]): TodoWorkspaceOption[] {
  const ranked = [...workspaces].sort((a, b) => {
    const aAssistant = a.workspaceKind === WorkspaceKind.Assistant ? 0 : 1;
    const bAssistant = b.workspaceKind === WorkspaceKind.Assistant ? 0 : 1;
    return aAssistant - bAssistant;
  });

  return ranked.map((workspace) => ({
    workspace,
    value: workspace.id,
    label: resolveWorkspaceDisplayName(workspace),
    description: workspace.rootPath,
    remoteConnectionId: isRemoteWorkspace(workspace) ? workspace.connectionId ?? null : null,
    remoteSshHost: isRemoteWorkspace(workspace) ? workspace.sshHost ?? null : null,
  }));
}
