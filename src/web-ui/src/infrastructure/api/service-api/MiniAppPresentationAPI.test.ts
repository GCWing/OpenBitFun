import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { miniAppPresentationAPI } from './MiniAppPresentationAPI';

const native = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => native.desktop }));
vi.mock('./ApiClient', () => ({ api: { invoke: native.invoke } }));

describe('native MiniApp presentation boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); native.desktop = true; activateSurface('local'); });

  it('refuses Peer and web surfaces before invoking a controller-local operation', async () => {
    activateSurface('peer-device');
    await expect(miniAppPresentationAPI.open('notes', 'window', '/remote')).rejects.toThrow('unavailable');
    await expect(miniAppPresentationAPI.uninstall('notes')).rejects.toThrow('unavailable');
    activateSurface('local'); native.desktop = false;
    await expect(miniAppPresentationAPI.install('notes')).rejects.toThrow('unavailable');
    await expect(miniAppPresentationAPI.installation('notes')).rejects.toThrow('unavailable');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it('queries and uninstalls by app identity without accepting an arbitrary local path', async () => {
    native.invoke.mockResolvedValue({ paths: ['/Applications/Notes.app'] });
    await expect(miniAppPresentationAPI.installation('notes')).resolves.toEqual({ paths: ['/Applications/Notes.app'] });
    await miniAppPresentationAPI.uninstall('notes');
    expect(native.invoke.mock.calls).toEqual([
      ['miniapp_presentation', { request: { operation: 'installation', appId: 'notes' } }],
      ['miniapp_presentation', { request: { operation: 'uninstall', appId: 'notes' } }],
    ]);
  });

  it('passes the app glyph through the structured native launch request', async () => {
    await miniAppPresentationAPI.open('notes', 'window', null, '<svg/>');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('miniapp_presentation', {
      request: { operation: 'open', appId: 'notes', kind: 'window', workspacePath: null, iconSvg: '<svg/>' },
    });
  });

  it('discards a local response when the driving surface changes in flight', async () => {
    let finish!: (value: unknown) => void;
    native.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = miniAppPresentationAPI.snapshot();
    activateSurface('peer-device');
    finish({ protocolVersion: 1, hostEpoch: 'local-host', revision: 1, instances: [] });
    await expect(result).rejects.toThrow('Device surface changed');
  });

  it('keeps reserved content actions inside the structured operation contract', async () => {
    native.invoke.mockRejectedValue(new Error('MiniApp semantic content actions are not supported by this host'));
    const request = { instanceId: 'instance', requestId: 'request', action: 'read', arguments: {} };
    await expect(miniAppPresentationAPI.contentAction(request)).rejects.toThrow('not supported');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('miniapp_presentation', {
      request: { operation: 'contentAction', request },
    });
  });
});
