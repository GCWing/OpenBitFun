import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { i18nService } from '@/infrastructure/i18n';

const CONFIG_PATH = 'app.assistant_default_sessions';

function parsePreferences(value: unknown): Record<string, string> | undefined {
  // Missing on older hosts: latest-session navigation remains available, writes do not.
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(sessionId => typeof sessionId !== 'string')) {
    throw new Error(i18nService.t('common:nav.sessions.defaultReadFailed'));
  }
  return value as Record<string, string>;
}

export async function readAssistantDefaultSession(workspaceId: string) {
  const scope = getActiveSurfaceScope();
  // Read the host each time so another controller's selection is observed.
  const preferences = parsePreferences(await configAPI.getConfig(CONFIG_PATH, { skipRetryOnNotFound: true }));
  scope.assertCurrent('read assistant default session');
  return { supported: preferences !== undefined, sessionId: preferences?.[workspaceId] || null };
}

export async function saveAssistantDefaultSession(workspaceId: string, sessionId: string | null): Promise<void> {
  await configManager.updateConfig<Record<string, string>>(CONFIG_PATH, value => {
    const preferences = parsePreferences(value);
    if (!preferences) throw new Error(i18nService.t('common:nav.sessions.defaultUnsupported'));
    const next = { ...preferences };
    if (sessionId) next[workspaceId] = sessionId;
    else delete next[workspaceId];
    return next;
  });
}
