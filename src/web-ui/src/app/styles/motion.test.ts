// @vitest-environment jsdom

import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, Sheet } from '@openbitfun/ui';
import { compile } from 'sass';
import { describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const style = document.createElement('style');
style.textContent = compile(resolve(__dirname, 'motion.scss')).css;
document.head.appendChild(style);
const motionRules = Array.from(style.sheet!.cssRules)
  .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule
    && rule.conditionText === '(prefers-reduced-motion: no-preference)')
  .flatMap(rule => Array.from(rule.cssRules))
  .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
style.remove();

function entranceRules(element: HTMLElement): CSSStyleRule[] {
  return motionRules.filter(rule => rule.style.animation && element.matches(rule.selectorText));
}

describe('global motion ownership', () => {
  it.each(['dialog', 'alertdialog'])('gives a plain %s one default entrance', role => {
    const element = document.createElement('div');
    element.setAttribute('role', role);
    const matches = entranceRules(element);
    expect(matches).toHaveLength(1);
    expect(matches[0].style.animation).toContain('openbitfun-motion-dialog-enter');
  });

  it.each(['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip'])(
    'leaves the complete %s enter/exit lifecycle to its presence owner', role => {
      const element = document.createElement('div');
      element.setAttribute('role', role);
      element.dataset.motion = 'presence';
      expect(entranceRules(element)).toHaveLength(0);
    },
  );

  it.each([
    { name: 'Dialog', Surface: Dialog },
    { name: 'Sheet', Surface: Sheet },
  ])('keeps the production $name entrance and exit outside the fallback animation', ({ Surface }) => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (open: boolean) => act(() => root.render(createElement(
      Surface,
      { open, onOpenChange: () => undefined, children: createElement('button', null, 'Content') },
    )));
    try {
      render(true);
      const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(entranceRules(surface)).toHaveLength(0);
      render(false);
      expect(surface.dataset.state).toBe('exiting');
      expect(entranceRules(surface)).toHaveLength(0);
      act(() => vi.runAllTimers());
      expect(surface.isConnected).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
