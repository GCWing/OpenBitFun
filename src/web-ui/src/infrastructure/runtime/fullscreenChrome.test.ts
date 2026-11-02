import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeNativeFullscreenChrome } from './fullscreenChrome';

const bridge = vi.hoisted(() => ({ listen: vi.fn(), emitTo: vi.fn(), isMac: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen, emitTo: bridge.emitTo }));
vi.mock('./environment', () => ({ isMacOSDesktopRuntime: bridge.isMac }));

describe('controller-local fullscreen presentation handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.isMac.mockReturnValue(true);
    bridge.emitTo.mockResolvedValue(undefined);
  });

  it('negotiates after listening, accepts old payloads, and acknowledges the matching native transition', async () => {
    let register!: (stop: () => void) => void;
    bridge.listen.mockReturnValue(new Promise(resolve => { register = resolve; }));
    const receive = vi.fn();
    const dispose = subscribeNativeFullscreenChrome(receive);
    expect(bridge.emitTo).not.toHaveBeenCalled();
    const stop = vi.fn();
    register(stop);
    await Promise.resolve();
    const ready = bridge.emitTo.mock.calls[0][2];
    expect(ready).toEqual({ kind: 'ready', clientId: expect.any(String) });
    const send = bridge.listen.mock.calls[0][1];
    send({ payload: 'fullscreen' });
    expect(receive).toHaveBeenLastCalledWith({ phase: 'fullscreen' });
    send({ payload: { phase: 'exiting', transitionId: 8, requiresAck: true } });
    await receive.mock.calls.at(-1)![0].acknowledgePaint();
    expect(bridge.emitTo).toHaveBeenLastCalledWith('main', 'window://fullscreen-chrome-handoff', {
      kind: 'settled', clientId: ready.clientId, transitionId: 8,
    });
    dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(bridge.emitTo).toHaveBeenLastCalledWith('main', 'window://fullscreen-chrome-handoff', {
      kind: 'unready', clientId: ready.clientId,
    });
  });

  it('does not arm native suppression if disposed before registration or on web hosts', async () => {
    let register!: (stop: () => void) => void;
    bridge.listen.mockReturnValue(new Promise(resolve => { register = resolve; }));
    subscribeNativeFullscreenChrome(vi.fn())();
    const stop = vi.fn();
    register(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(bridge.emitTo).not.toHaveBeenCalled();
    bridge.isMac.mockReturnValue(false);
    subscribeNativeFullscreenChrome(vi.fn())();
    expect(bridge.listen).toHaveBeenCalledOnce();
  });
});
