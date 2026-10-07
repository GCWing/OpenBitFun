// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStatusSlot } from './RuntimeStatusSlot';
import { useRuntimeStatusStore } from '../../store/runtimeStatusStore';
import { activateSurface, getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { registerSubmittedMessage } from '../../services/submittedMessagePresentation';

const translationMock = vi.hoisted(() => ({
  t: vi.fn(() => ['Working on it']),
  i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
  ready: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => translationMock,
}));

describe('RuntimeStatusSlot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    activateSurface(LOCAL_SURFACE_ID);
    useRuntimeStatusStore.getState().reset();
    translationMock.t.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    activateSurface(LOCAL_SURFACE_ID);
    vi.useRealTimers();
  });

  it('defers only initial status paint and cancels the delay when a quick reply clears it', () => {
    act(() => root.render(<RuntimeStatusSlot sessionId="session-1" />));
    const slot = container.querySelector<HTMLElement>('.runtime-status-slot')!;
    const content = slot.querySelector<HTMLElement>('.runtime-status-slot__content')!;
    registerSubmittedMessage(getActiveSurfaceScope(), 'session-1', 'turn-1', 'message-1');
    act(() => useRuntimeStatusStore.getState().show({
      sessionId: 'session-1', turnId: 'turn-1', roundId: 'round-1',
    }));
    expect(content.style.transitionDelay).toBe('160ms');
    expect(useRuntimeStatusStore.getState().bySessionId.has('session-1')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(50);
      useRuntimeStatusStore.getState().clear({ sessionId: 'session-1' });
    });
    expect(slot.dataset.runtimeStatusVisible).toBe('false');
    expect(content.style.transitionDelay).toBe('');
    act(() => vi.advanceTimersByTime(300));
    expect(slot.dataset.runtimeStatusVisible).toBe('false');
    expect(container.querySelector('.runtime-status-slot')).toBe(slot);
  });

  it('keeps the same fixed slot mounted while visibility changes', () => {
    act(() => {
      root.render(<RuntimeStatusSlot sessionId="session-1" placement="footer" />);
    });
    const slot = container.querySelector<HTMLElement>('.runtime-status-slot');
    const iconSlot = container.querySelector('[data-openbitfun-part="leadingIcon"]');
    expect(iconSlot?.querySelector('[data-openbitfun-component="spinner"]')).not.toBeNull();
    expect(slot).not.toBeNull();
    expect(slot?.dataset.runtimeStatusVisible).toBe('false');

    act(() => {
      useRuntimeStatusStore.getState().show({
        sessionId: 'session-1',
        turnId: 'turn-1',
        roundId: 'round-1',
      });
    });
    expect(container.querySelector('.runtime-status-slot')).toBe(slot);
    expect(slot?.dataset.runtimeStatusVisible).toBe('true');
    expect(slot?.textContent).toContain('Working on it');

    act(() => {
      useRuntimeStatusStore.getState().show({
        sessionId: 'session-1',
        turnId: 'dispatch-turn',
        roundId: 'dispatch-transfer:job-1',
        label: 'Transferring workspace',
      });
    });
    expect(slot?.textContent).toContain('Transferring workspace');
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(iconSlot);

    act(() => {
      useRuntimeStatusStore.getState().clear({ sessionId: 'session-1' });
    });
    expect(container.querySelector('.runtime-status-slot')).toBe(slot);
    expect(slot?.dataset.runtimeStatusVisible).toBe('false');
    expect(container.querySelector('[data-openbitfun-part="leadingIcon"]')).toBe(iconSlot);
  });

  it('only translates generated hints when an unlabeled status is visible', () => {
    translationMock.i18n.language = 'test-hints';
    translationMock.i18n.resolvedLanguage = 'test-hints';
    act(() => root.render(<RuntimeStatusSlot sessionId="session-1" />));
    expect(translationMock.t).not.toHaveBeenCalled();

    act(() => useRuntimeStatusStore.getState().show({
      sessionId: 'session-1', turnId: 'turn-1', roundId: 'round-1',
    }));
    expect(translationMock.t).toHaveBeenCalledTimes(1);

    act(() => useRuntimeStatusStore.getState().show({
      sessionId: 'session-1', turnId: 'turn-2', roundId: 'round-2',
    }));
    expect(translationMock.t).toHaveBeenCalledTimes(1);

    act(() => useRuntimeStatusStore.getState().show({
      sessionId: 'session-1',
      turnId: 'turn-3',
      roundId: 'round-3',
      label: 'Transferring workspace',
    }));
    expect(translationMock.t).toHaveBeenCalledTimes(1);
  });
});
