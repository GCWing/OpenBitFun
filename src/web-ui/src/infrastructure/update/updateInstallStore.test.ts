// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectHasUpdateAttention, useUpdateInstallStore } from './updateInstallStore';
import { selectUpdateDownloadStatus } from './updateDownloadProgress';
import { readAppUpdateSnapshot, recordSkipThisVersion, writeAppUpdateSnapshot } from './appUpdateStorage';

const mocks = vi.hoisted(() => ({ pending: vi.fn(), download: vi.fn(), install: vi.fn(), check: vi.fn(), current: vi.fn(), enabled: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: {
  getPendingUpdate: mocks.pending,
  installPendingUpdate: mocks.install,
  checkForUpdates: mocks.check,
  getLocalAppVersion: mocks.current,
  getAutoUpdateEnabled: mocks.enabled,
} }));
vi.mock('./installUpdateWithProgress', () => ({ installUpdateWithProgress: mocks.download }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));

const state = () => useUpdateInstallStore.getState();
const available = (version = '2.0.0') => ({ updateAvailable: true, currentVersion: '1.0.0', latestVersion: version, releaseNotes: 'Changes', releaseDate: null });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DEV', false);
  vi.stubGlobal('__TAURI__', {});
  localStorage.clear();
  mocks.pending.mockResolvedValue(null);
  mocks.download.mockResolvedValue({ version: '2.0.0' });
  mocks.install.mockResolvedValue(undefined);
  mocks.current.mockResolvedValue('1.0.0');
  mocks.enabled.mockResolvedValue(true);
  mocks.check.mockResolvedValue(available());
  useUpdateInstallStore.setState({
    status: 'idle', progress: { downloaded: 0, total: null }, error: null,
    startedAt: null, version: null, promptOpen: false, initialized: false,
    downloadVersion: null, availableUpdate: null, currentVersion: null,
    checkStatus: 'idle', checkError: null, lastCheckedAt: null, lastCheckAttemptAt: null,
    skippedVersion: null, notice: null, noticeRevision: 0, detailsOpen: false, releaseNotesOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('staged app update', () => {
  it('starts development without cached discovery or automatic checks and still allows a manual check', async () => {
    vi.stubEnv('DEV', true);
    writeAppUpdateSnapshot({ result: available(), checkedAt: Date.now() });
    const saved = localStorage.getItem('openbitfun:update:checkSnapshot');
    await state().initialize();
    await state().checkForUpdates('automatic', true);
    expect(state()).toMatchObject({ availableUpdate: null, notice: null, checkStatus: 'idle', lastCheckedAt: null });
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(localStorage.getItem('openbitfun:update:checkSnapshot')).toBe(saved);
    await state().checkForUpdates();
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(selectHasUpdateAttention(state())).toBe(true);
    useUpdateInstallStore.setState({ initialized: false });
    await state().initialize();
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(state().checkStatus).toBe('idle');
  });

  it.each(['1.0.0', '1.0.1', '1.0.1-rc.1', '1.0.1+build'])('never advertises %s as an upgrade for installed 1.0.1', async latestVersion => {
    mocks.current.mockResolvedValue('1.0.1');
    const result = { ...available(latestVersion), currentVersion: '1.0.1' };
    writeAppUpdateSnapshot({ result, checkedAt: Date.now() });
    await state().initialize();
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(state()).toMatchObject({ checkStatus: 'idle', lastCheckedAt: null });
    expect(mocks.check).not.toHaveBeenCalled();
    mocks.check.mockResolvedValueOnce(result);
    await state().checkForUpdates();
    state().showNotice();
    await state().startInstall(false, latestVersion);
    expect(state()).toMatchObject({ checkStatus: 'latest', availableUpdate: null, notice: null });
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(readAppUpdateSnapshot()?.result.updateAvailable).toBe(false);
  });

  it('does not defer automatic checks after the system clock moves backwards', async () => {
    await state().initialize();
    const future = Date.now() + 86400000;
    useUpdateInstallStore.setState({ lastCheckedAt: future, lastCheckAttemptAt: future });
    await state().checkForUpdates('automatic');
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it.each([true, false])('honors a manual check while an automatic preference read is pending (%s)', async enabled => {
    let finish!: (enabled: boolean) => void;
    mocks.enabled.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const automatic = state().checkForUpdates('automatic', true);
    await vi.waitFor(() => expect(mocks.enabled).toHaveBeenCalledOnce());
    await state().checkForUpdates();
    expect(mocks.check).toHaveBeenCalledOnce();
    finish(enabled);
    await automatic;
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(state().checkStatus).toBe('available');
  });

  it.each([null, '2.1.0'])('clears a failed download reminder when discovery changes to %s', async latestVersion => {
    mocks.download.mockRejectedValueOnce(new Error('network offline'));
    await state().startInstall();
    expect(state()).toMatchObject({ error: 'network offline', downloadVersion: '2.0.0', notice: 'error' });
    mocks.check.mockResolvedValueOnce(latestVersion ? available(latestVersion) : {
      ...available(), updateAvailable: false, latestVersion: null,
    });
    await state().checkForUpdates();
    expect(state()).toMatchObject({ status: 'idle', error: null, downloadVersion: null, notice: null });
    state().showNotice();
    expect(state().notice).toBe(latestVersion ? 'available' : null);
    expect(selectHasUpdateAttention(state())).toBe(Boolean(latestVersion));
  });

  it('does not reopen an available notice after download completes while the preference read is pending', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    let finish!: (enabled: boolean) => void;
    mocks.enabled.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const automatic = state().checkForUpdates('automatic');
    await vi.waitFor(() => expect(mocks.enabled).toHaveBeenCalledTimes(2));
    await state().startInstall();
    finish(true);
    await automatic;
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', notice: null });
    expect(selectHasUpdateAttention(state())).toBe(false);
  });

  it('does not attach an older package installation error to a newer version reminder', () => {
    useUpdateInstallStore.setState({
      status: 'ready', version: '1.5.0', availableUpdate: available(),
      error: 'installer unavailable', downloadVersion: null,
    });
    state().showNotice();
    expect(state()).toMatchObject({ notice: 'available', detailsOpen: false, version: '1.5.0' });
    expect(selectHasUpdateAttention(state())).toBe(true);
    state().requestInstall();
    expect(state()).toMatchObject({ promptOpen: true, error: 'installer unavailable', notice: null });
  });

  it('keeps attention after dismissing or reading details, and only skips the selected version', async () => {
    await state().checkForUpdates('automatic');
    expect(state().notice).toBe('available');
    state().markNoticePresented();
    state().dismissNotice();
    expect(selectHasUpdateAttention(state())).toBe(true);
    state().openDetails();
    expect(selectHasUpdateAttention(state())).toBe(true);
    state().closeDetails();
    await state().checkForUpdates('automatic', true);
    expect(state().notice).toBeNull();
    state().skipVersion('2.0.0');
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBe('2.0.0');
    mocks.check.mockResolvedValueOnce(available('2.1.0'));
    await state().checkForUpdates('automatic', true);
    expect(selectHasUpdateAttention(state())).toBe(true);
    expect(state().notice).toBe('available');
  });

  it('respects a legacy skip on manual checks and restores attention only on an explicit choice', async () => {
    recordSkipThisVersion('2.0.0');
    await state().checkForUpdates();
    expect(state().availableUpdate?.latestVersion).toBe('2.0.0');
    expect(state().notice).toBeNull();
    expect(selectHasUpdateAttention(state())).toBe(false);
    state().restoreReminder('2.0.0');
    expect(selectHasUpdateAttention(state())).toBe(true);
    expect(state().notice).toBeNull();
  });

  it('restores discovery after reopening but discards stale discovery after upgrading', async () => {
    writeAppUpdateSnapshot({ result: available(), checkedAt: Date.now() });
    await state().initialize();
    expect(selectHasUpdateAttention(state())).toBe(true);
    expect(state().notice).toBeNull();
    useUpdateInstallStore.setState({ initialized: false });
    mocks.current.mockResolvedValue('2.0.0');
    await state().initialize();
    expect(state().availableUpdate).toBeNull();
    expect(selectHasUpdateAttention(state())).toBe(false);
  });

  it('preserves known availability and the last successful check on a network failure', async () => {
    await state().checkForUpdates();
    const checkedAt = state().lastCheckedAt;
    mocks.check.mockRejectedValueOnce(new Error('offline'));
    await state().checkForUpdates();
    expect(state()).toMatchObject({ checkStatus: 'error', checkError: 'offline', lastCheckedAt: checkedAt });
    expect(selectHasUpdateAttention(state())).toBe(true);
    expect(readAppUpdateSnapshot()?.result).toEqual(available());
  });

  it('throttles automatic checks, honors the preference, and always permits a manual check', async () => {
    mocks.enabled.mockResolvedValue(false);
    await state().checkForUpdates('automatic');
    expect(mocks.check).not.toHaveBeenCalled();
    await state().checkForUpdates();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    mocks.enabled.mockResolvedValue(true);
    await state().checkForUpdates('automatic');
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await state().checkForUpdates();
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it('allows checking for a newer release while retaining the downloaded package', async () => {
    mocks.pending.mockResolvedValue({ version: '2.0.0' });
    mocks.check.mockResolvedValue(available('2.1.0'));
    await state().checkForUpdates();
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0' });
    expect(state().availableUpdate?.latestVersion).toBe('2.1.0');
    mocks.download.mockRejectedValueOnce(new Error('network failed'));
    await state().startInstall(true);
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', error: 'network failed' });
  });

  it('does not open a completion notice over the update details', async () => {
    state().openDetails();
    await state().startInstall();
    expect(state()).toMatchObject({ status: 'ready', promptOpen: false, notice: null, detailsOpen: true });
  });

  it('does not revive a notice when the user skips during the final preference read', async () => {
    let finish!: (enabled: boolean) => void;
    mocks.enabled.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const checking = state().checkForUpdates('automatic');
    await vi.waitFor(() => expect(mocks.enabled).toHaveBeenCalledTimes(2));
    state().skipVersion('2.0.0');
    finish(true);
    await checking;
    expect(state().notice).toBeNull();
    expect(selectHasUpdateAttention(state())).toBe(false);
  });

  it('pins the version from the clicked action even if discovery changes before download', async () => {
    await state().checkForUpdates();
    mocks.check.mockResolvedValueOnce(available('2.1.0'));
    await state().checkForUpdates();
    mocks.download.mockRejectedValueOnce(new Error('Update version changed from 2.0.0 to 2.1.0'));
    await state().startInstall(false, '2.0.0');
    expect(mocks.download).toHaveBeenCalledWith(expect.any(Function), '2.0.0');
    expect(state().status).toBe('error');
    expect(mocks.install).not.toHaveBeenCalled();
    await state().checkForUpdates();
    expect(state().error).toBeNull();
    expect(state().status).toBe('idle');
    expect(state().notice).toBeNull();
  });

  it('downloads in the background without showing a completion card, opening a dialog, or installing', async () => {
    mocks.download.mockImplementation(async (progress) => {
      expect(state().status).toBe('downloading');
      expect(selectHasUpdateAttention(state())).toBe(false);
      expect(state().promptOpen).toBe(false);
      progress({ downloaded: 100, total: 100 });
      return { version: '2.0.0' };
    });
    await state().startInstall();
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', promptOpen: false, notice: null });
    expect(selectHasUpdateAttention(state())).toBe(false);
    state().showNotice();
    expect(state().notice).toBeNull();
    expect(mocks.download).toHaveBeenCalledWith(expect.any(Function), '2.0.0');
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('defers without discarding the package and installs from the checkmark without downloading again', async () => {
    await state().startInstall();
    state().deferInstall();
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', promptOpen: false });
    await state().confirmInstall();
    expect(mocks.install).not.toHaveBeenCalled();
    state().requestInstall();
    await state().confirmInstall();
    expect(mocks.install).toHaveBeenCalledWith('2.0.0');
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(state().status).toBe('installing');
  });

  it('restores a downloaded update after restart without forcing a new prompt', async () => {
    mocks.pending.mockResolvedValue({ version: '2.0.0' });
    await state().initialize();
    await state().startInstall();
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', promptOpen: false });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps a prepared package in the checkmark when its discovery reminder was skipped', async () => {
    mocks.pending.mockResolvedValue({ version: '2.0.0' });
    recordSkipThisVersion('2.0.0');
    await state().initialize();
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(selectUpdateDownloadStatus(state())).toBe('ready');
    state().requestInstall();
    expect(state().promptOpen).toBe(true);
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(selectUpdateDownloadStatus(state())).toBe('ready');
    expect(localStorage.getItem('openbitfun:update:skippedVersion')).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not mark a failed download or signature check ready', async () => {
    mocks.download.mockRejectedValue(new Error('signature invalid'));
    await state().startInstall();
    expect(state()).toMatchObject({ status: 'error', version: null, promptOpen: false });
    await state().confirmInstall();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps partial progress on a failed download and prepares the package after retry', async () => {
    mocks.download.mockImplementationOnce(async progress => {
      progress({ downloaded: 50, total: 100 });
      throw new Error('Network connection lost');
    });
    await state().startInstall();
    expect(state()).toMatchObject({
      status: 'error', version: null, notice: 'error', promptOpen: false,
      progress: { downloaded: 50, total: 100 },
    });
    expect(selectHasUpdateAttention(state())).toBe(true);

    mocks.download.mockImplementationOnce(async progress => {
      expect(state().progress).toEqual({ downloaded: 0, total: null });
      progress({ downloaded: 100, total: 100 });
      return { version: '2.0.0' };
    });
    await state().startInstall(true);
    expect(state()).toMatchObject({
      status: 'ready', version: '2.0.0', error: null, notice: null, promptOpen: false,
    });
    expect(selectHasUpdateAttention(state())).toBe(false);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('retains the pending version after an install failure and permits retry', async () => {
    await state().startInstall();
    state().requestInstall();
    mocks.install.mockRejectedValueOnce(new Error('installer unavailable'));
    await state().confirmInstall();
    expect(state()).toMatchObject({ status: 'ready', version: '2.0.0', promptOpen: true, error: 'installer unavailable' });
    await state().confirmInstall();
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it('coalesces startup reads and prevents duplicate downloads and installs', async () => {
    let finish!: (value: { version: string }) => void;
    mocks.download.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = state().startInstall();
    const second = state().startInstall();
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    finish({ version: '2.0.0' });
    await Promise.all([first, second]);
    expect(mocks.pending).toHaveBeenCalledTimes(1);
    state().requestInstall();
    await Promise.all([state().confirmInstall(), state().confirmInstall()]);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    state().deferInstall();
    expect(state().status).toBe('installing');
  });

  it('allows an explicit replacement download after a cached package fails installation', async () => {
    await state().startInstall();
    state().requestInstall();
    mocks.install.mockRejectedValueOnce(new Error('package corrupt'));
    await state().confirmInstall();
    mocks.download.mockResolvedValueOnce({ version: '2.1.0' });
    mocks.check.mockResolvedValueOnce(available('2.1.0'));
    await state().checkForUpdates();
    await state().startInstall(true);
    expect(state()).toMatchObject({ status: 'ready', version: '2.1.0', error: null, promptOpen: false });
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });
});
