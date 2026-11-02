import { beforeEach, describe, expect, it, vi } from 'vitest';

const configManagerMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}));

const emitMock = vi.hoisted(() => vi.fn());

vi.mock('./ConfigManager', () => ({ configManager: configManagerMock }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { emit: emitMock } }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn() }),
}));

describe('PermissionConfigService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    configManagerMock.setConfig.mockResolvedValue(undefined);
  });

  it('defaults missing configuration to full access with auto approval disabled', async () => {
    configManagerMock.getConfig.mockResolvedValue(undefined);
    const { permissionConfigService } = await import('./PermissionConfigService');

    await expect(permissionConfigService.getConfig()).resolves.toEqual({
      policy: { preset: 'full_access', rules: [] },
      interaction: { auto_approve_ask: false },
    });
  });

  it('preserves stored ask and auto approval preferences', async () => {
    const stored = {
      policy: { preset: 'ask', rules: [] },
      interaction: { auto_approve_ask: true },
    };
    configManagerMock.getConfig.mockResolvedValue(stored);
    const { permissionConfigService } = await import('./PermissionConfigService');
    await expect(permissionConfigService.getConfig()).resolves.toEqual(stored);
  });

  it('propagates a failed read when a settings form requires loaded configuration', async () => {
    configManagerMock.getConfig.mockRejectedValueOnce(new Error('offline'));
    const { permissionConfigService } = await import('./PermissionConfigService');
    await expect(permissionConfigService.getConfig({ requireLoaded: true })).rejects.toThrow('offline');
  });

  it('keeps configuration load failures on the ask fallback', async () => {
    configManagerMock.getConfig.mockRejectedValue(new Error('offline'));
    const { permissionConfigService } = await import('./PermissionConfigService');
    await expect(permissionConfigService.getConfig()).resolves.toEqual({
      policy: { preset: 'ask', rules: [] },
      interaction: { auto_approve_ask: false },
    });
  });

  it('writes the complete normalized section and broadcasts the update', async () => {
    const { permissionConfigService } = await import('./PermissionConfigService');

    await permissionConfigService.saveConfig({
      policy: {
        preset: 'full_access',
        rules: [{ action: 'file.read', resource: '*', effect: 'allow' }],
      },
      interaction: { auto_approve_ask: true },
    });

    expect(configManagerMock.setConfig).toHaveBeenCalledWith('tool_permissions', {
      policy: {
        preset: 'full_access',
        rules: [{ action: 'file.read', resource: '*', effect: 'allow' }],
      },
      interaction: { auto_approve_ask: true },
    });
    expect(emitMock).toHaveBeenCalledWith('permission:config:updated', expect.objectContaining({
      policy: { preset: 'full_access', rules: expect.any(Array) },
      interaction: { auto_approve_ask: true },
    }));
  });

  it('does not retain invalid effects or unknown preset values', async () => {
    configManagerMock.getConfig.mockResolvedValue({
      policy: {
        preset: 'unexpected',
        rules: [
          { action: 'file.read', resource: '*', effect: 'unexpected' },
          { action: 12, resource: '*', effect: 'allow' },
        ],
      },
      interaction: { auto_approve_ask: 'yes' },
    });
    const { permissionConfigService } = await import('./PermissionConfigService');

    await expect(permissionConfigService.getConfig()).resolves.toEqual({
      policy: {
        preset: 'ask',
        rules: [{ action: 'file.read', resource: '*', effect: 'ask' }],
      },
      interaction: { auto_approve_ask: false },
    });
  });

  it('uses a narrow nested write for quick interaction changes', async () => {
    configManagerMock.getConfig.mockResolvedValue({
      policy: { preset: 'full_access', rules: [] },
      interaction: { auto_approve_ask: true },
    });
    const { permissionConfigService } = await import('./PermissionConfigService');

    await permissionConfigService.setAutoApproveAsk(false);

    expect(configManagerMock.setConfig).toHaveBeenCalledWith(
      'tool_permissions.interaction.auto_approve_ask',
      false,
    );
    expect(configManagerMock.setConfig).not.toHaveBeenCalledWith('tool_permissions', expect.anything());
    expect(emitMock).toHaveBeenCalledWith('permission:config:updated');
  });
});
