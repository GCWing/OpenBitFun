import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionActivitySync, type ActivityTarget } from './sessionActivitySync';

const target = (index: number, workspacePath = '/workspace'): ActivityTarget => ({ sessionId: `session-${index}`, workspacePath });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('application-level activity batching', () => {
  it('coalesces repeated invalidations and groups remote identities independently', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const sync = new SessionActivitySync(read);
    for (let i = 0; i < 20; i++) sync.request(target(1));
    sync.request({ ...target(2), workspaceId: 'remote-a' });
    sync.request({ ...target(3), workspaceId: 'remote-b' });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map(([batch]) => batch.length)).toEqual([1, 1, 1]);
    sync.dispose();
  });

  it('caps payloads at 128 and keeps at most two requests in flight', async () => {
    const releases: Array<() => void> = [];
    const read = vi.fn((_batch: ActivityTarget[]) => new Promise<void>(resolve => releases.push(resolve)));
    const sync = new SessionActivitySync(read);
    for (let i = 0; i < 400; i++) sync.request(target(i));
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([batch]) => (batch as ActivityTarget[]).length)).toEqual([128, 128]);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(4);
    releases.splice(0).forEach(release => release());
    await vi.advanceTimersByTimeAsync(0);
    sync.dispose();
  });

  it('abandons queued batches on a device switch without issuing old paths on the new host', async () => {
    const releases: Array<() => void> = [];
    const read = vi.fn((_batch: ActivityTarget[]) => new Promise<void>(resolve => releases.push(resolve)));
    const sync = new SessionActivitySync(read);
    for (let i = 0; i < 400; i++) sync.request(target(i, '/old-host'));
    await vi.advanceTimersByTimeAsync(100);
    sync.clear();
    sync.request(target(999, '/new-host'));
    releases.splice(0).forEach(release => release());
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0]).toEqual([target(999, '/new-host')]);
    sync.dispose();
    releases.splice(0).forEach(release => release());
  });
});
