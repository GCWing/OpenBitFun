// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { bindSubmittedMessageScrollIntent, claimSubmittedMessageScrollIntent, finishSubmittedMessageScrollIntent, registerSubmittedMessageScrollIntent, subscribeSubmittedMessageScrollIntent } from './submittedMessageScrollIntent';

afterEach(() => { activateSurface('local'); vi.useRealTimers(); });
describe('submitted viewport intent', () => {
  it('binds host queue identity before the RPC receipt, without treating unrelated replay as a submission', () => {
    registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'session', 'host-turn', null);
    expect(claimSubmittedMessageScrollIntent('session', 1)).toBeNull();
    bindSubmittedMessageScrollIntent('session', 'remote-turn', 'remote-message');
    expect(claimSubmittedMessageScrollIntent('session', 1)).toBeNull();
    bindSubmittedMessageScrollIntent('session', 'host-turn', 'projected-message');
    expect(claimSubmittedMessageScrollIntent('session', 1)?.messageId).toBe('projected-message');
  });
  it('can cancel before host projection so delayed queue drain cannot steal the viewport', () => {
    registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'session', 'queued', null);
    finishSubmittedMessageScrollIntent(claimSubmittedMessageScrollIntent('session', 1, true)!);
    bindSubmittedMessageScrollIntent('session', 'queued', 'late-message');
    expect(claimSubmittedMessageScrollIntent('session', 1)).toBeNull();
  });
  it('outlives arrival motion, scopes exact identities and has one viewport consumer', () => {
    vi.useFakeTimers();
    const scope = getActiveSurfaceScope();
    registerSubmittedMessageScrollIntent(scope, 'session', 'turn', 'message');
    vi.advanceTimersByTime(10000);
    expect(claimSubmittedMessageScrollIntent('other-session', 1)).toBeNull();
    const intent = claimSubmittedMessageScrollIntent('session', 1)!;
    expect(intent).toMatchObject({ sessionId: 'session', turnId: 'turn', messageId: 'message', viewportId: 1 });
    expect(claimSubmittedMessageScrollIntent('session', 2)).toBeNull();
    finishSubmittedMessageScrollIntent(intent);
    expect(claimSubmittedMessageScrollIntent('session', 1)).toBeNull();
  });
  it('invalidates on device activation, including a later return to the same device', () => {
    const old = getActiveSurfaceScope();
    registerSubmittedMessageScrollIntent(old, 'session', 'turn', 'message');
    activateSurface('peer'); activateSurface('local');
    registerSubmittedMessageScrollIntent(old, 'session', 'turn', 'message');
    expect(claimSubmittedMessageScrollIntent('session', 1)).toBeNull();
  });
  it('new submissions replace obsolete placement without stale cleanup removing the new intent', () => {
    const changed = vi.fn(); const unsubscribe = subscribeSubmittedMessageScrollIntent(changed);
    registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'session', 'first', 'm1');
    const first = claimSubmittedMessageScrollIntent('session', 1)!;
    registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'session', 'second', 'm2');
    finishSubmittedMessageScrollIntent(first);
    expect(claimSubmittedMessageScrollIntent('session', 1)?.turnId).toBe('second');
    expect(changed).toHaveBeenCalledTimes(2); unsubscribe();
  });
});
