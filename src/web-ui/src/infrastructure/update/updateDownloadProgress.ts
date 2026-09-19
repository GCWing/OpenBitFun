import type { UpdateInstallState } from './updateInstallStore';
import type { UpdateDownloadProgressPayload } from './installUpdateWithProgress';

export type UpdateDownloadStatus = 'downloading' | 'ready' | 'installing';

export function selectUpdateDownloadStatus(state: UpdateInstallState): UpdateDownloadStatus | null {
  const target = state.status === 'downloading' ? state.downloadVersion : state.version;
  // Skip suppresses discovery reminders, not access to a package that is already being prepared.
  if (!target) return null;
  if (state.status === 'downloading' || state.status === 'installing') return state.status;
  return state.status === 'ready' ? 'ready' : null;
}

/** Unknown totals remain indeterminate; filling always follows downloaded bytes. */
export function getUpdateDownloadFraction(progress: UpdateDownloadProgressPayload): number | null {
  if (progress.total == null || !Number.isFinite(progress.total) || progress.total <= 0) return null;
  return Number.isFinite(progress.downloaded) ? Math.max(0, Math.min(1, progress.downloaded / progress.total)) : 0;
}
