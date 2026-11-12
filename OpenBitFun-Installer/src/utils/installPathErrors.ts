import type { TFunction } from 'i18next';

/** Matches Rust `INSTALL_PATH_ERR_PREFIX` in `commands.rs`. */
export const INSTALL_PATH_ERROR_PREFIX = 'INSTALL_PATH::';

export function parseInstallPathErrorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/recovery failed|repair required|recovery needs repair|backup.*preserv|cleanup.*pending|files.*remain/i.test(message)) return null;
  if (/access is denied|permission denied|os error 5\b/i.test(message)) return 'directory_not_writable';
  if (!message.startsWith(INSTALL_PATH_ERROR_PREFIX)) return null;
  return message.slice(INSTALL_PATH_ERROR_PREFIX.length);
}

function snakeToCamelKey(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Maps backend `INSTALL_PATH::snake_case` to `errors.installPath.camelCase` i18n keys.
 * Returns the raw message if not a known code or missing translation.
 */
export function formatInstallPathError(message: string, t: TFunction): string {
  const code = parseInstallPathErrorCode(message);
  if (!code) {
    if (/recovery failed|repair required|recovery needs repair|backup.*preserv/i.test(message)) return t('errors.maintenance.recovery', { detail: message });
    if (/cleanup.*pending|files.*remain/i.test(message)) return t('errors.maintenance.cleanupPending');
    if (/another maintenance/i.test(message)) return t('errors.maintenance.busy');
    if (/authorization.*cancel|canceled|cancelled/i.test(message)) return t('errors.maintenance.canceled');
    if (/close the application|used by another process|os error 32/i.test(message)) return t('errors.maintenance.fileLocked');
    if (/insufficient disk space/i.test(message)) return t('errors.maintenance.space');
    if (/disk space|target drive/i.test(message)) return t('errors.maintenance.diskUnknown');
    return t('errors.maintenance.failed', { detail: message });
  }
  const key = `errors.installPath.${snakeToCamelKey(code)}`;
  const translated = t(key);
  if (translated === key) return message;
  return translated;
}

/** Show "run as administrator" hint (e.g. Program Files without elevation). */
export function installPathErrorShowsAdminHint(code: string | null): boolean {
  if (!code) return false;
  return code === 'parent_not_writable' || code === 'directory_not_writable';
}
