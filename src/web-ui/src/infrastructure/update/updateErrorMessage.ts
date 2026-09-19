/**
 * Maps raw updater / network errors to user-facing messages (i18n keys resolved by caller).
 */

export function isUpdateVersionChangedError(error: string | null): boolean {
  return error?.toLowerCase().includes('update version changed') ?? false;
}

export function formatUpdateInstallError(
  raw: string,
  t: (key: string, options?: { detail?: string }) => string
): string {
  const s = raw.trim();
  if (!s) {
    return t('update.errors.unknown');
  }
  const lower = s.toLowerCase();

  if (isUpdateVersionChangedError(raw)) return t('update.errors.versionChanged');
  if (lower.includes('installer metadata')) return t('update.errors.installMetadata');

  if (
    /network|fetch failed|connection|timeout|timed out|failed to send request|reqwest|error sending request|dns|econnrefused|enetunreach/i.test(
      lower
    )
  ) {
    return t('update.errors.network');
  }
  if (/signature|verify|minisign|invalid signature/i.test(lower)) {
    return t('update.errors.signature');
  }
  if (/no update available/i.test(lower)) {
    return t('update.errors.noUpdateAvailable');
  }
  if (/404|not found|status: 404/i.test(lower)) {
    return t('update.errors.notFound');
  }
  if (/certificate|tls|ssl|certif/i.test(lower)) {
    return t('update.errors.tls');
  }

  const detail = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  return t('update.errors.generic', { detail });
}
