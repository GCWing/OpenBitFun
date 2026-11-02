import { describe, expect, it, vi } from 'vitest';
import { miniAppAgentSurfaceAPI } from './MiniAppAgentSurfaceAPI';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('./ApiClient', () => ({ api: mocks }));

describe('MiniApp Agent readiness transport', () => {
  it('serializes detach and attach even after an earlier update fails', async () => {
    let rejectFirst!: (error: Error) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(undefined);
    const first = miniAppAgentSurfaceAPI.markReady(true);
    const firstFailure = first.catch(() => undefined);
    const detached = miniAppAgentSurfaceAPI.markReady(false);
    const attached = miniAppAgentSurfaceAPI.markReady(true);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('temporary transport failure'));
    await Promise.all([firstFailure, detached, attached]);
    expect(mocks.invoke.mock.calls).toEqual([
      ['mark_miniapp_web_surface_ready', { request: { ready: true } }],
      ['mark_miniapp_web_surface_ready', { request: { ready: false } }],
      ['mark_miniapp_web_surface_ready', { request: { ready: true } }],
    ]);
  });
});
