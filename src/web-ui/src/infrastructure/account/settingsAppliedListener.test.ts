import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  reloadConfig: vi.fn(),
  applyExternalReload: vi.fn(),
  getConfig: vi.fn(),
  reconcilePersistedState: vi.fn(),
  reloadFromConfig: vi.fn(),
  applyPersistedLanguage: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: { listen: mocks.listen },
}));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: { reloadConfig: mocks.reloadConfig, getConfig: mocks.getConfig },
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { applyExternalReload: mocks.applyExternalReload },
}));

vi.mock('@/infrastructure/appearance', () => ({
  appearanceService: { reconcilePersistedState: mocks.reconcilePersistedState },
}));
vi.mock('@/infrastructure/font-preference/core/FontPreferenceService', () => ({
  fontPreferenceService: { reloadFromConfig: mocks.reloadFromConfig },
}));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { applyPersistedLanguage: mocks.applyPersistedLanguage },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
  }),
}));

describe('settingsAppliedListener', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listen.mockReturnValue(() => undefined);
    mocks.reloadConfig.mockResolvedValue(undefined);
    mocks.applyExternalReload.mockResolvedValue(undefined);
    mocks.getConfig.mockResolvedValue('en-US');
    mocks.reconcilePersistedState.mockResolvedValue(undefined);
    mocks.reloadFromConfig.mockResolvedValue(undefined);
    mocks.applyPersistedLanguage.mockResolvedValue(undefined);
  });

  it('refreshes the config cache when the backend applies cloud settings', async () => {
    const { ensureSettingsAppliedListener } = await import('./settingsAppliedListener');
    ensureSettingsAppliedListener();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
    const [event, handler] = mocks.listen.mock.calls[0];
    expect(event).toBe('account://settings-applied');

    handler({ applied: true });

    await vi.waitFor(() => {
      expect(mocks.reloadConfig).toHaveBeenCalledTimes(1);
      expect(mocks.applyExternalReload).toHaveBeenCalledTimes(1);
      expect(mocks.reconcilePersistedState).toHaveBeenCalledTimes(1);
      expect(mocks.reloadFromConfig).toHaveBeenCalledTimes(1);
      expect(mocks.applyPersistedLanguage).toHaveBeenCalledWith('en-US');
    });
    expect(mocks.getConfig).toHaveBeenCalledWith('app.language');
  });

  it('refreshes the remaining preferences when one runtime fails', async () => {
    mocks.reconcilePersistedState.mockRejectedValueOnce(new Error('appearance unavailable'));
    const { ensureSettingsAppliedListener } = await import('./settingsAppliedListener');
    ensureSettingsAppliedListener();
    mocks.listen.mock.calls[0][1]({ applied: true });
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to refresh cloud-synced preference',
      expect.objectContaining({ preference: 'appearance' }),
    ));
    expect(mocks.applyExternalReload).toHaveBeenCalledTimes(1);
    expect(mocks.reloadFromConfig).toHaveBeenCalledTimes(1);
    expect(mocks.applyPersistedLanguage).toHaveBeenCalledWith('en-US');
  });

  it('registers the listener only once', async () => {
    const { ensureSettingsAppliedListener } = await import('./settingsAppliedListener');
    ensureSettingsAppliedListener();
    ensureSettingsAppliedListener();

    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });

  it('finishes the current language apply before refreshing a newer settings event', async () => {
    let finishLanguage!: () => void;
    mocks.applyPersistedLanguage.mockReturnValueOnce(new Promise<void>(resolve => { finishLanguage = resolve; }));
    const { ensureSettingsAppliedListener } = await import('./settingsAppliedListener');
    ensureSettingsAppliedListener();
    const handler = mocks.listen.mock.calls[0][1];
    handler({ applied: true });
    await vi.waitFor(() => expect(mocks.applyPersistedLanguage).toHaveBeenCalledTimes(1));

    mocks.getConfig.mockResolvedValue('zh-CN');
    handler({ applied: true });
    handler({ applied: true });
    expect(mocks.reloadConfig).toHaveBeenCalledTimes(1);
    finishLanguage();
    await vi.waitFor(() => expect(mocks.applyPersistedLanguage).toHaveBeenLastCalledWith('zh-CN'));
    expect(mocks.reloadConfig).toHaveBeenCalledTimes(2);
  });
});
