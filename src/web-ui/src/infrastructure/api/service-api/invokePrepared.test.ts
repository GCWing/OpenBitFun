import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { invokePrepared } from './invokePrepared';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));

describe('prepared command device ownership', () => {
  beforeEach(() => {
    activateSurface('local');
    invoke.mockReset();
  });

  it.each(['peer-b', 'local'])('rejects preparation from an expired activation before dispatch to %s', async (destination) => {
    let prepare!: (args: Record<string, unknown>) => void;
    const pending = invokePrepared('delete_session', () => new Promise(resolve => { prepare = resolve; }));
    const rejection = expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    activateSurface('peer-b');
    activateSurface(destination);
    prepare({ request: { workspaceId: 'identical-id', sessionId: 'identical-session' } });
    await rejection;
    expect(invoke).not.toHaveBeenCalled();
  });

  it('classifies a late preparation failure as cancellation of the departed device', async () => {
    let fail!: (error: Error) => void;
    const pending = invokePrepared('get_sessions', () => new Promise((_, reject) => { fail = reject; }));
    const rejection = expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    activateSurface('peer');
    fail(new Error('old host unavailable'));
    await rejection;
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves a current-device preparation error without dispatch', async () => {
    const failure = new Error('Workspace is ambiguous');
    await expect(invokePrepared('get_sessions', async () => { throw failure; })).rejects.toBe(failure);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps controller-local commands authoritative across a device switch', async () => {
    let prepare!: (args: Record<string, unknown>) => void;
    invoke.mockResolvedValue({ ok: true });
    const pending = invokePrepared('account_github_info', () => new Promise(resolve => { prepare = resolve; }));
    activateSurface('peer-b');
    prepare({ request: {} });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('account_github_info', { request: {} });
  });

  it('passes prepared arguments and transport options unchanged on the current device', async () => {
    const args = { request: { workspaceId: 'opaque-id' } };
    const config = { timeout: 2000 };
    invoke.mockResolvedValue({ sessions: [] });
    await expect(invokePrepared('get_sessions', async () => args, config)).resolves.toEqual({ sessions: [] });
    expect(invoke).toHaveBeenCalledWith('get_sessions', args, config);
  });
});
