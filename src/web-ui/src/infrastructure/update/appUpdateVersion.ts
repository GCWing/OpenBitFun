import gt from 'semver/functions/gt';
import valid from 'semver/functions/valid';
import type { CheckForUpdatesResponse } from '@/infrastructure/api/service-api/SystemAPI';

export function isAppVersion(value: unknown): value is string {
  return typeof value === 'string' && valid(value) !== null;
}

/** Compare host versions, never the presentation-only `-dev` label. */
export function isNewerAppVersion(candidate: unknown, installed: unknown): boolean {
  return isAppVersion(candidate) && isAppVersion(installed) && gt(candidate, installed);
}

/** A discovery flag alone cannot establish that an upgrade is available. */
export function normalizeAppUpdateResult(
  result: CheckForUpdatesResponse,
  installedVersion: string = result.currentVersion,
): CheckForUpdatesResponse {
  if (!isAppVersion(installedVersion) || result.currentVersion !== installedVersion) {
    throw new Error('Update check returned a different application version; check for updates again');
  }
  if (result.updateAvailable && !isAppVersion(result.latestVersion)) {
    throw new Error('Update check returned an invalid release version');
  }
  const updateAvailable = result.updateAvailable && isNewerAppVersion(result.latestVersion, installedVersion);
  return {
    ...result,
    updateAvailable,
    latestVersion: updateAvailable ? result.latestVersion : null,
    releaseNotes: updateAvailable ? result.releaseNotes : null,
    releaseDate: updateAvailable ? result.releaseDate : null,
  };
}
