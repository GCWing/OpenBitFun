// @vitest-environment jsdom

import { resolve } from 'node:path';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

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
});
