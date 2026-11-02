import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import {
  beginSubmittedMessagePreview,
  consumeSubmittedMessageFailure,
  consumeSubmittedMessageArrival,
  failSubmittedMessagePreview,
  finishSubmittedMessagePreview,
  getSubmittedMessagePreviews,
  registerSubmittedMessage,
  submittedMessageStatusDelay,
} from './submittedMessagePresentation';

const register = () => registerSubmittedMessage(getActiveSurfaceScope(), 'session', 'turn', 'message');
const consume = () => consumeSubmittedMessageArrival('session', 'turn', 'message');

describe('submittedMessagePresentation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activateSurface(LOCAL_SURFACE_ID);
  });
  afterEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    vi.useRealTimers();
  });

  it('requires an explicit send and consumes it once across renderer remounts', () => {
    expect(consume()).toBeUndefined();
    register();
    expect(consume()).toBeDefined();
    expect(consume()).toBeUndefined();
    register();
    expect(consume()).toBeUndefined();
  });

  it('does not spend another session or message identity', () => {
    register();
    expect(consumeSubmittedMessageArrival('other-session', 'turn', 'message')).toBeUndefined();
    expect(consumeSubmittedMessageArrival('session', 'turn', 'historical-message')).toBeUndefined();
    expect(consume()).toBeDefined();
  });

  it('expires even an unmounted message and does not restart its clock on duplicate registration', () => {
    register();
    vi.advanceTimersByTime(200);
    register();
    vi.advanceTimersByTime(100);
    expect(consume()).toBeUndefined();
  });

  it('isolates equal identities on a peer and discards the old activation on return', () => {
    register();
    const localScope = getActiveSurfaceScope();
    activateSurface('peer-device');
    expect(consume()).toBeUndefined();
    registerSubmittedMessage(localScope, 'session', 'turn', 'message');
    expect(consume()).toBeUndefined();
    register();
    expect(consume()).toBeDefined();
    activateSurface(LOCAL_SURFACE_ID);
    expect(consume()).toBeUndefined();
  });

  it('shares the original clock with status paint without consuming the message claim', () => {
    register();
    expect(submittedMessageStatusDelay('session', 'turn')).toBe(160);
    vi.advanceTimersByTime(100);
    expect(submittedMessageStatusDelay('session', 'turn')).toBe(60);
    expect(submittedMessageStatusDelay('session', 'another-turn')).toBe(0);
    expect(consume()).toBeDefined();
    vi.advanceTimersByTime(60);
    expect(submittedMessageStatusDelay('session', 'turn')).toBe(0);
  });

  it('keeps a foreground preview scoped to its device and hands off a failed shell once', () => {
    const scope = getActiveSurfaceScope();
    const preview = beginSubmittedMessagePreview(scope, 'session', 'turn', {
      id: 'message', content: 'Hello', timestamp: Date.now(),
    });
    expect(getSubmittedMessagePreviews(scope, 'session')).toEqual([preview]);
    expect(getSubmittedMessagePreviews(scope, 'other-session')).toHaveLength(0);
    failSubmittedMessagePreview(scope, 'session', 'turn', 'Unavailable');
    expect(getSubmittedMessagePreviews(scope, 'session')[0].phase).toBe('failed');
    expect(consumeSubmittedMessageFailure('session', 'turn', 'message')).toBeDefined();
    expect(consumeSubmittedMessageFailure('session', 'turn', 'message')).toBeUndefined();
    finishSubmittedMessagePreview(scope, 'session', 'turn');
    expect(getSubmittedMessagePreviews(scope, 'session')).toHaveLength(0);
  });

  it('drops a preview on device activation change', () => {
    const scope = getActiveSurfaceScope();
    beginSubmittedMessagePreview(scope, 'session', 'turn', {
      id: 'message', content: 'Hello', timestamp: Date.now(),
    });
    activateSurface('peer-device');
    expect(getSubmittedMessagePreviews(scope, 'session')).toHaveLength(0);
    expect(getSubmittedMessagePreviews(getActiveSurfaceScope(), 'session')).toHaveLength(0);
  });
});
