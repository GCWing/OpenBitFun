/**
 * Resident listener for account cloud-sync settings application.
 *
 * The desktop backend emits `account://settings-applied` after importing a
 * newer cloud settings blob (login auto-sync and the periodic pull reconcile).
 * Registered once at app startup so the frontend config cache and
 * config-driven UI refresh even while the account dialog is closed.
 */
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { appearanceService } from '@/infrastructure/appearance';
import { fontPreferenceService } from '@/infrastructure/font-preference/core/FontPreferenceService';
import { i18nService, type LocaleId } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SettingsAppliedListener');

let settingsAppliedUnlisten: (() => void) | null = null;
let refreshInFlight = false;
let refreshRequested = false;

async function requestSettingsRefresh(): Promise<void> {
  refreshRequested = true;
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    // Reconcile another snapshot if events arrived while refreshing. Serial
    // application prevents an older asynchronous locale change finishing last.
    while (refreshRequested) {
      refreshRequested = false;
      await applyCloudSyncedSettings();
    }
  } finally {
    refreshInFlight = false;
  }
}

async function applyCloudSyncedSettings(): Promise<void> {
  try {
    await configAPI.reloadConfig();
    // These runtimes read through ConfigAPI directly, so cache invalidation
    // alone cannot update their already-rendered state. Keep failures isolated:
    // an unavailable appearance must not prevent language, fonts or shortcuts loading.
    const refreshes = [
      { name: 'config', run: () => configManager.applyExternalReload() },
      { name: 'appearance', run: () => appearanceService.reconcilePersistedState() },
      { name: 'font', run: () => fontPreferenceService.reloadFromConfig() },
      { name: 'language', run: async () => {
        const locale = await configAPI.getConfig('app.language') as LocaleId;
        await i18nService.applyPersistedLanguage(locale);
      } },
    ];
    const results = await Promise.allSettled(refreshes.map(refresh => refresh.run()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.warn('Failed to refresh cloud-synced preference', { preference: refreshes[index].name, error: result.reason });
      }
    });
  } catch (error) {
    log.warn('Failed to apply cloud-synced settings', error);
  }
}

/** Register once so config refresh works while the account dialog is closed. */
export function ensureSettingsAppliedListener(): void {
  if (settingsAppliedUnlisten) {
    return;
  }
  try {
    settingsAppliedUnlisten = api.listen('account://settings-applied', () => {
      void requestSettingsRefresh();
    });
  } catch (error) {
    log.warn('Failed to register settings-applied listener', error);
  }
}
