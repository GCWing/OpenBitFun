// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMenu } from './SessionMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./useFlowChatSessions', () => ({
  resolveDisplayTitle: (session: { title: string }) => session.title,
  useFlowChatSessions: () => ({
    activeSessionId: 'session-1',
    sessions: [
      { sessionId: 'session-1', title: 'Current session' },
      { sessionId: 'session-2', title: 'Other session' },
    ],
  }),
}));

vi.mock('../../services/sessionActivation', () => ({
  activateMainSession: vi.fn().mockResolvedValue(true),
}));

describe('SessionMenu', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let widthSpy: ReturnType<typeof vi.spyOn>;
  let heightSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this instanceof HTMLElement && this.classList.contains('openbitfun-session-menu__trigger')) {
        return {
          top: 760,
          bottom: 784,
          left: 900,
          right: 924,
          width: 24,
          height: 24,
          x: 900,
          y: 760,
          toJSON() { return this; },
        } as DOMRect;
      }
      return {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() { return this; },
      } as DOMRect;
    });
    widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    container.remove();
    rectSpy.mockRestore();
    widthSpy.mockRestore();
    heightSpy.mockRestore();
    vi.useRealTimers();
  });

  it('escapes the floating-window clip and flips inside the viewport', async () => {
    await act(async () => {
      root.render(<SessionMenu />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('.openbitfun-session-menu__trigger');
    await act(async () => {
      trigger!.click();
      await Promise.resolve();
    });

    const dropdown = document.querySelector<HTMLElement>('.openbitfun-session-menu__dropdown');
    expect(dropdown?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(dropdown?.dataset.openbitfunPlacement).toBe('top');
    expect(dropdown?.style.visibility).toBe('visible');
    expect(Number.parseFloat(dropdown?.style.left ?? '')).toBeLessThanOrEqual(752);
  });
});
