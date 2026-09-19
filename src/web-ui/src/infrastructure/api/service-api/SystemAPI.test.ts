import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemAPI } from './SystemAPI';

const invokeMock = vi.hoisted(() => vi.fn());
const copyTextToClipboardMock = vi.hoisted(() => vi.fn());
const controllerInvoke = vi.hoisted(() => vi.fn());
const localVersion = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: controllerInvoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: localVersion }));

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

vi.mock('@/shared/utils/textSelection', () => ({
  copyTextToClipboard: copyTextToClipboardMock,
}));

describe('SystemAPI', () => {
  let systemAPI: SystemAPI;

  beforeEach(() => {
    systemAPI = new SystemAPI();
    invokeMock.mockReset();
    copyTextToClipboardMock.mockReset();
    controllerInvoke.mockReset();
    localVersion.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('allows explicit update checks with DEV=%s', async development => {
    vi.stubEnv('DEV', development);
    const response = {
      updateAvailable: false,
      currentVersion: '1.0.0',
      latestVersion: null,
      releaseNotes: null,
      releaseDate: null,
    };
    invokeMock.mockResolvedValueOnce(response);

    await expect(systemAPI.checkForUpdates()).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenCalledWith('check_for_updates', {
      request: {},
    });
  });

  it('reads the installed version and update preference from the controller in peer mode', async () => {
    localVersion.mockResolvedValue('1.0.0');
    controllerInvoke.mockResolvedValue({ currentOptionValues: { 'auto-update': false } });
    await expect(systemAPI.getLocalAppVersion()).resolves.toBe('1.0.0');
    await expect(systemAPI.getAutoUpdateEnabled()).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(controllerInvoke).toHaveBeenCalledWith('product_control_invoke', {
      request: { action: 'get', capabilityId: 'setting.application.general' },
    });
  });

  it('writes the update preference on the controller and announces the saved value', async () => {
    vi.stubGlobal('window', new EventTarget());
    const changed = vi.fn();
    const unsubscribe = systemAPI.onAutoUpdateEnabledChange(changed);

    await systemAPI.setAutoUpdateEnabled(true);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(controllerInvoke).toHaveBeenCalledWith('product_control_invoke', {
      request: { action: 'configure', capabilityId: 'setting.application.general', optionId: 'auto-update', value: true },
    });
    expect(changed).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('passes the reviewed download version to the host', async () => {
    await systemAPI.downloadUpdate('2.0.0');
    expect(invokeMock).toHaveBeenCalledWith('download_update', { request: { expectedVersion: '2.0.0' } }, {
      timeout: 3600000, retries: 0,
    });
  });

  it('reads the persisted desktop preference', async () => {
    invokeMock.mockResolvedValueOnce({
      catalogDigest: 'digest',
      revision: 3,
      currentOptionValues: { 'prevent-sleep': false },
      controlAvailability: { status: 'available', adapter: 'desktop-native', readBack: true },
    });

    await expect(systemAPI.getPreventSleepEnabled()).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('product_control_invoke', {
      request: { action: 'get', capabilityId: 'setting.application.general' },
    });
  });

  it('allows a background download to outlive the default request timeout without replaying it', async () => {
    invokeMock.mockResolvedValueOnce({ version: '2.0.0' });
    await expect(systemAPI.downloadUpdate()).resolves.toEqual({ version: '2.0.0' });
    expect(invokeMock).toHaveBeenCalledWith('download_update', { request: {} }, {
      timeout: 3600000, retries: 0,
    });
  });

  it('installs only the version the user confirmed and disables automatic mutation retries', async () => {
    await systemAPI.installPendingUpdate('2.0.0');
    expect(invokeMock).toHaveBeenCalledWith('install_pending_update', {
      request: { version: '2.0.0' },
    }, { timeout: 120000, retries: 0 });
  });

  it('sends the requested app-wide state', async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(systemAPI.setPreventSleepEnabled(true)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('product_control_invoke', {
      request: {
        action: 'configure',
        capabilityId: 'setting.application.general',
        optionId: 'prevent-sleep',
        value: true,
      },
    });
  });

  it('writes clipboard text on the controller without invoking a host command', async () => {
    copyTextToClipboardMock.mockResolvedValueOnce(true);

    await expect(systemAPI.setClipboard('device-code')).resolves.toBeUndefined();

    expect(copyTextToClipboardMock).toHaveBeenCalledWith('device-code');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('reports a clipboard helper failure to the caller', async () => {
    copyTextToClipboardMock.mockResolvedValueOnce(false);

    await expect(systemAPI.setClipboard('device-code')).rejects.toThrow('Clipboard write failed');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('checks path existence on the active host', async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(systemAPI.checkPathExists(
      '/workspace/src/existing.ts',
    )).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('check_path_exists', {
      request: {
        path: '/workspace/src/existing.ts',
      },
    });
  });
});
