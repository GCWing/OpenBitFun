// @vitest-environment jsdom

import React, { act, StrictMode, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { beginSubmittedMessagePreview, failSubmittedMessagePreview, registerSubmittedMessage } from '../../services/submittedMessagePresentation';
import { useSubmittedMessageMotion } from './useSubmittedMessageMotion';

// Lifecycle seam only; these tests do not simulate or assess visual playback.
function Message({ disabled = false, phase }: { disabled?: boolean; phase?: 'forming' | 'failed' }) {
  const ref = useRef<HTMLDivElement>(null);
  useSubmittedMessageMotion(ref, 'session', 'turn', 'message', disabled, phase);
  return <div ref={ref}>
    <div className="user-message-item"><span className="user-message-item__surface" /><span className="user-message-item__content">Message</span></div>
    {phase === 'failed' && <div className="user-message-item__submission-error">Failed</div>}
    <time className="user-message-item__timestamp">12:00:00</time>
    <div className="user-message-item__actions"><button>Copy</button></div>
  </div>;
}

describe('useSubmittedMessageMotion lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let media: MediaQueryList;
  let animations: Array<{ currentTime: number; cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }>;
  let originalAnimate: PropertyDescriptor | undefined;

  const submit = () => registerSubmittedMessage(getActiveSurfaceScope(), 'session', 'turn', 'message');
  const render = (content: React.ReactNode = <Message />) => act(() => root.render(content));

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    activateSurface(LOCAL_SURFACE_ID);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    media = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
    vi.stubGlobal('matchMedia', () => media);
    animations = [];
    originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => {
        let rejectFinished!: (reason: Error) => void;
        const animation = {
          currentTime: 0,
          finished: new Promise<void>((_resolve, reject) => { rejectFinished = reject; }),
          cancel: vi.fn(() => rejectFinished(new Error('Animation cancelled'))),
        };
        animations.push(animation);
        return animation;
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    activateSurface(LOCAL_SURFACE_ID);
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('leaves history still and never replays a submitted row after a real remount', () => {
    render();
    expect(animations).toHaveLength(0);
    render(null);
    submit();
    render();
    expect(animations).toHaveLength(2);
    render(null);
    render();
    expect(animations).toHaveLength(2);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('catches up to the submission clock when the new row commits later', () => {
    submit();
    vi.advanceTimersByTime(120);
    render();
    expect(animations).toHaveLength(2);
    expect(animations.every(animation => animation.currentTime === 120)).toBe(true);
  });

  it('survives StrictMode effect rehearsal without permitting a real remount replay', () => {
    submit();
    render(<StrictMode><Message /></StrictMode>);
    expect(animations).toHaveLength(4);
    expect(animations.slice(0, 2).every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(animations.slice(2).every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
    render(null);
    render(<StrictMode><Message /></StrictMode>);
    expect(animations).toHaveLength(4);
  });

  it('settles immediately when a user focuses an action', () => {
    submit();
    render();
    act(() => container.querySelector('button')?.focus());
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('button'));
  });

  it('skips reduced motion and settles an in-flight preference change', () => {
    Object.assign(media, { matches: true });
    submit();
    render();
    expect(animations).toHaveLength(0);
    render(null);
    activateSurface(LOCAL_SURFACE_ID);
    Object.assign(media, { matches: false });
    submit();
    render();
    expect(animations).toHaveLength(2);
    Object.assign(media, { matches: true });
    act(() => media.dispatchEvent(new Event('change')));
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('cancels on device changes and does not animate same-id peer history', () => {
    submit();
    render();
    act(() => { activateSurface('peer-device'); });
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    render();
    expect(animations).toHaveLength(2);
  });

  it('settles failures and does not restart when the message becomes editable again', () => {
    submit();
    render();
    render(<Message disabled />);
    render();
    expect(animations).toHaveLength(2);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('plays the failure handoff once and leaves a remounted failed shell settled', () => {
    const scope = getActiveSurfaceScope();
    beginSubmittedMessagePreview(scope, 'session', 'turn', {
      id: 'message', content: 'Message', timestamp: Date.now(),
    });
    render(<Message phase="forming" />);
    expect(animations).toHaveLength(2);
    failSubmittedMessagePreview(scope, 'session', 'turn', 'Send failed');
    render(<Message phase="failed" disabled />);
    expect(animations).toHaveLength(4);
    render(null);
    render(<Message phase="failed" disabled />);
    expect(animations).toHaveLength(4);
  });
});
