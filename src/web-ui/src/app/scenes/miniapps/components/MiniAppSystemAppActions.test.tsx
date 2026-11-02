/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { MiniAppSystemAppActions } from './MiniAppSystemAppActions';

const native = vi.hoisted(() => ({ installation: vi.fn(), install: vi.fn(), uninstall: vi.fn(),
  progress: vi.fn(), success: vi.fn(), error: vi.fn(), cancel: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', () => ({ miniAppPresentationAPI: native }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, currentLanguage: 'en-US' }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => native }));
vi.mock('../utils/miniAppSystemIcon', () => ({ renderMiniAppSystemIcon: () => '<svg />' }));

let root: Root;
let container: HTMLDivElement;
const app = { id: 'notes', name: 'Notes', icon: 'book' } as MiniAppMeta;
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;
const render = (supported = true) => act(async () => {
  root.render(<MiniAppSystemAppActions app={app} workspacePath={null} supported={supported} />);
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.resetAllMocks();
  native.installation.mockResolvedValue({ paths: [] });
  native.install.mockResolvedValue({ path: '/Applications/Notes.app' });
  native.uninstall.mockResolvedValue(undefined);
  native.progress.mockReturnValue({ complete: native.success, fail: native.error, cancel: native.cancel });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
});

describe('MiniApp system installation controls', () => {
  it('offers uninstall immediately after export and permits adding it again after removal', async () => {
    await render();
    expect(button('presentation.uninstall')).toBeUndefined();
    await act(async () => { button('presentation.install').click(); });
    expect(native.install).toHaveBeenCalledExactlyOnceWith('notes', null, '<svg />');
    expect(native.progress).toHaveBeenCalledWith({
      title: 'presentation.install', message: 'presentation.installing', progressMode: 'text-only',
    });
    expect(native.success).toHaveBeenLastCalledWith('presentation.installed');
    expect(button('presentation.updateInstallation')).toBeDefined();
    await act(async () => { button('presentation.uninstall').click(); });
    expect(native.uninstall).toHaveBeenCalledExactlyOnceWith('notes');
    expect(native.success).toHaveBeenLastCalledWith('presentation.uninstalled');
    expect(button('presentation.uninstall')).toBeUndefined();
    expect(button('presentation.install').disabled).toBe(false);
  });

  it('discovers an existing system app without launching it', async () => {
    native.installation.mockResolvedValue({ paths: ['/Applications/Notes.app'] });
    await render();
    expect(button('presentation.uninstall')).toBeDefined();
    expect(button('presentation.updateInstallation')).toBeDefined();
    expect(native.install).not.toHaveBeenCalled();
  });

  it('retains the uninstall action on failure and coalesces repeated clicks', async () => {
    native.installation.mockResolvedValue({ paths: ['/Applications/Notes.app'] });
    native.uninstall.mockRejectedValueOnce(new Error('Permission denied'));
    await render();
    await act(async () => {
      button('presentation.uninstall').click();
      button('presentation.uninstall').click();
    });
    expect(native.uninstall).toHaveBeenCalledTimes(1);
    expect(native.error).toHaveBeenCalledWith('presentation.uninstallFailed');
    expect(button('presentation.uninstall').disabled).toBe(false);
    expect(native.success).not.toHaveBeenCalled();
  });

  it('shows a retry when status is unreadable instead of claiming the app is uninstalled', async () => {
    native.installation.mockRejectedValueOnce(new Error('Unavailable'));
    await render();
    expect(button('presentation.install')).toBeUndefined();
    expect(button('presentation.uninstall')).toBeUndefined();
    await act(async () => { button('presentation.retryInstallation').click(); });
    expect(button('presentation.install').disabled).toBe(false);
  });

  it('does not inspect or change local system apps on unsupported surfaces', async () => {
    await render(false);
    expect(native.installation).not.toHaveBeenCalled();
    expect(button('presentation.install').disabled).toBe(true);
    act(() => button('presentation.install').click());
    expect(native.install).not.toHaveBeenCalled();
    expect(native.progress).not.toHaveBeenCalled();
  });

  it('does not report a completed uninstall on a newly selected peer surface', async () => {
    native.installation.mockResolvedValue({ paths: ['/Applications/Notes.app'] });
    let finish!: () => void;
    native.uninstall.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await act(async () => { button('presentation.uninstall').click(); });
    await act(async () => { activateSurface('peer'); finish(); });
    expect(native.success).not.toHaveBeenCalled();
    expect(native.cancel).toHaveBeenCalledOnce();
  });

  it('reports completion even after leaving the initiating view', async () => {
    let finish!: (result: { path: string }) => void;
    native.install.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await act(async () => { button('presentation.install').click(); });
    await act(async () => { root.render(null); });
    await act(async () => { finish({ path: '/Applications/Notes.app' }); });
    expect(native.success).toHaveBeenCalledExactlyOnceWith('presentation.installed');
  });

  it('reports a system app update separately from its first installation', async () => {
    native.installation.mockResolvedValue({ paths: ['/Applications/Notes.app'] });
    await render();
    await act(async () => { button('presentation.updateInstallation').click(); });
    expect(native.progress).toHaveBeenCalledWith({
      title: 'presentation.updateInstallation', message: 'presentation.updating', progressMode: 'text-only',
    });
    expect(native.success).toHaveBeenCalledExactlyOnceWith('presentation.updated');
  });
});
