import { beforeEach, describe, expect, it, vi } from 'vitest';

const configManagerMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  watch: vi.fn(),
}));

const configApiMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock('./ConfigManager', () => ({
  configManager: configManagerMock,
}));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: configApiMock,
}));

vi.mock('./AgentCompanionPetService', () => ({
  DEFAULT_AGENT_COMPANION_PET: {
    id: 'bitblob',
    displayName: 'BitBlob',
    source: 'preset',
    packagePath: '/agent-companion-pets/bitblob',
    spritesheetPath: '/agent-companion-pets/bitblob/spritesheet.webp',
    spritesheetMimeType: 'image/webp',
    spriteVersionNumber: 2,
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('AIExperienceConfigService startup behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    configManagerMock.watch.mockReturnValue(() => undefined);
  });

  it('does not read app.ai_experience during module import', async () => {
    await import('./AIExperienceConfigService');
    await Promise.resolve();

    expect(configManagerMock.getConfig).not.toHaveBeenCalled();
  });

  it('loads settings lazily when requested', async () => {
    configManagerMock.getConfig.mockResolvedValueOnce({
      enable_agent_companion: false,
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    await aiExperienceConfigService.getSettingsAsync();

    expect(configManagerMock.watch).toHaveBeenCalledTimes(1);
    expect(configManagerMock.watch).toHaveBeenCalledWith('app.ai_experience', expect.any(Function));
    expect(configManagerMock.getConfig).toHaveBeenCalledTimes(1);
    expect(configManagerMock.getConfig).toHaveBeenCalledWith('app.ai_experience');
  });

  it('uses BitBlob when no companion pet has been configured', async () => {
    configManagerMock.getConfig.mockResolvedValueOnce({
      enable_agent_companion: true,
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    const settings = await aiExperienceConfigService.getSettingsAsync();

    expect(settings.agent_companion_pet).toMatchObject({
      id: 'bitblob',
      displayName: 'BitBlob',
      packagePath: '/agent-companion-pets/bitblob',
      spritesheetPath: '/agent-companion-pets/bitblob/spritesheet.webp',
    });
  });

  it('preserves an existing user-selected companion pet', async () => {
    const selectedPet = {
      id: 'usagi',
      displayName: 'Usagi',
      source: 'preset' as const,
      packagePath: '/agent-companion-pets/usagi',
      spritesheetPath: '/agent-companion-pets/usagi/spritesheet.webp',
      spritesheetMimeType: 'image/webp',
    };
    configManagerMock.getConfig.mockResolvedValueOnce({
      enable_agent_companion: false,
      agent_companion_pet: selectedPet,
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    const settings = await aiExperienceConfigService.getSettingsAsync();

    expect(settings.agent_companion_pet).toEqual(selectedPet);
  });

  it('drops the retired input display mode during cross-window refresh', async () => {
    configApiMock.getConfig.mockResolvedValueOnce({
      enable_agent_companion: true,
      agent_companion_display_mode: 'input',
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true });

    expect(configApiMock.getConfig).toHaveBeenCalledWith('app.ai_experience');
    expect(configManagerMock.getConfig).not.toHaveBeenCalled();
    expect(settings.enable_agent_companion).toBe(true);
    expect(settings).not.toHaveProperty('agent_companion_display_mode');
  });

  it('does not reset cloud voice input when a stale settings view toggles another feature', async () => {
    const persisted = {
      enable_agent_companion: true,
      voice_input: { provider: 'cloud', model_id: 'cloud-fixture', microphone_device_id: 'saved-mic' },
      quick_actions: [{ id: 'fixture', label: 'Fixture', prompt: 'fixture', enabled: true }],
    };
    configManagerMock.getConfig.mockResolvedValue(persisted);
    configManagerMock.setConfig.mockImplementation(async (path: string, value: unknown) => {
      expect(path).toBe('app.ai_experience.enable_agent_companion');
      persisted.enable_agent_companion = value as boolean;
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    // No preceding read is required; fallback defaults must never be saved.
    await aiExperienceConfigService.saveSettings({ enable_agent_companion: false });
    await aiExperienceConfigService.reload();
    expect(aiExperienceConfigService.getSettings()).toMatchObject({
      enable_agent_companion: false,
      voice_input: persisted.voice_input,
      quick_actions: persisted.quick_actions,
    });
    expect(configManagerMock.setConfig).toHaveBeenCalledTimes(1);
  });

  it('updates only an edited voice input field and preserves an explicitly empty quick action list', async () => {
    configManagerMock.getConfig.mockResolvedValue({ quick_actions: [] });
    configManagerMock.setConfig.mockResolvedValue(undefined);
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    await aiExperienceConfigService.saveSettings({ voice_input: { microphone_device_id: 'new-mic' } });
    expect(configManagerMock.setConfig).toHaveBeenCalledWith(
      'app.ai_experience.voice_input.microphone_device_id', 'new-mic'
    );
    await aiExperienceConfigService.reload();
    expect(aiExperienceConfigService.getSettings().quick_actions).toEqual([]);
  });

  it('keeps commit co-author settings unavailable when an older host omits the field', async () => {
    configApiMock.getConfig.mockResolvedValueOnce({ quick_actions: [] });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true });

    expect(settings.enable_git_commit_coauthor).toBeUndefined();
    expect(settings.quick_actions).toEqual([]);
  });

  it('persists a co-author opt-out without overwriting quick actions or voice settings', async () => {
    const persisted = {
      enable_git_commit_coauthor: true,
      voice_input: { provider: 'cloud', model_id: 'saved-model' },
      quick_actions: [{ id: 'custom', label: 'Review', prompt: 'Review changes', enabled: false }],
    };
    configManagerMock.getConfig.mockResolvedValue(persisted);
    configManagerMock.setConfig.mockImplementation(async (path: string, value: unknown) => {
      expect(path).toBe('app.ai_experience.enable_git_commit_coauthor');
      persisted.enable_git_commit_coauthor = value as boolean;
    });
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    await aiExperienceConfigService.saveSettings({ enable_git_commit_coauthor: false });
    await aiExperienceConfigService.reload();

    expect(configManagerMock.setConfig).toHaveBeenCalledTimes(1);
    expect(aiExperienceConfigService.getSettings()).toMatchObject({
      enable_git_commit_coauthor: false,
      voice_input: persisted.voice_input,
      quick_actions: persisted.quick_actions,
    });
  });

  it('reports host read failures instead of supplying defaults to a settings editor', async () => {
    const error = new Error('Execution host unavailable');
    configApiMock.getConfig.mockRejectedValueOnce(error);
    const { aiExperienceConfigService } = await import('./AIExperienceConfigService');

    await expect(aiExperienceConfigService.getSettingsAsync({ forceRefresh: true, requireLoaded: true }))
      .rejects.toBe(error);
  });
});
