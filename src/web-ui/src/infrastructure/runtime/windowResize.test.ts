import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeNativeWindowResizeEnd } from './windowResize';

const bridge = vi.hoisted(() => ({ listen: vi.fn(), isMac: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
vi.mock('./environment', () => ({ isMacOSDesktopRuntime: bridge.isMac }));

describe('controller-local resize completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.isMac.mockReturnValue(true);
  });

  it('accepts the versioned local completion and ignores incompatible payloads or disposed callbacks', async () => {
    const stop = vi.fn();
    bridge.listen.mockResolvedValue(stop);
    const receive = vi.fn();
    const dispose = subscribeNativeWindowResizeEnd(receive);
    await Promise.resolve();
    expect(bridge.listen.mock.calls[0][0]).toBe('window://resize-ended');
    const send = bridge.listen.mock.calls[0][1];
    send({ payload: { version: 2 } });
    send({ payload: 'ended' });
    send({ payload: null });
    expect(receive).not.toHaveBeenCalled();
    send({ payload: { version: 1, futureField: true } });
    expect(receive).toHaveBeenCalledOnce();
    dispose();
    expect(stop).toHaveBeenCalledOnce();
    send({ payload: { version: 1 } });
    expect(receive).toHaveBeenCalledOnce();
  });

  it('unlistens when disposal overtakes registration and skips non-macOS hosts', async () => {
    let register!: (stop: () => void) => void;
    bridge.listen.mockReturnValue(new Promise(resolve => { register = resolve; }));
    subscribeNativeWindowResizeEnd(vi.fn())();
    const stop = vi.fn(); register(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    bridge.isMac.mockReturnValue(false);
    subscribeNativeWindowResizeEnd(vi.fn())();
    expect(bridge.listen).toHaveBeenCalledOnce();
  });

  it('degrades to ordinary frontend scheduling if the optional listener is unavailable', async () => {
    bridge.listen.mockRejectedValue(new Error('unavailable'));
    const receive = vi.fn();
    const dispose = subscribeNativeWindowResizeEnd(receive);
    await Promise.resolve(); await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
    dispose();
  });
});
