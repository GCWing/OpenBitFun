// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const stylesheetPath = resolve(__dirname, 'SettingsNav.scss');

function readSettingsNavStylesheet(): string {
  return readFileSync(stylesheetPath, 'utf8').replace(/\r\n/g, '\n');
}

const styleElement = document.createElement('style');
styleElement.textContent = compile(stylesheetPath).css;
document.head.appendChild(styleElement);
const rules = Array.from(styleElement.sheet!.cssRules).filter(
  (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule,
);
styleElement.remove();

function declarations(selector: string): CSSStyleDeclaration {
  const matches = rules.filter((entry) => entry.selectorText === selector);
  expect(matches.length, `Missing style rule: ${selector}`).toBeGreaterThan(0);
  const merged = document.createElement('div').style;
  for (const rule of matches) {
    for (let index = 0; index < rule.style.length; index += 1) {
      const property = rule.style.item(index);
      merged.setProperty(property, rule.style.getPropertyValue(property));
    }
  }
  return merged;
}

describe('SettingsNav typography and layout ownership', () => {
  it('uses the shared navigation semantic text roles without a local font scale', () => {
    const stylesheet = readSettingsNavStylesheet();

    expect(stylesheet).toContain("@use '../../styles/nav-panel-font-scope.scss' as nav-font;");
    expect(stylesheet).not.toContain('nav-panel-font-token-scope');
    expect(stylesheet).toContain('@include nav-font.nav-panel-text-body;');
    expect(stylesheet).toContain('@include nav-font.nav-panel-text-meta;');
    // typography-audit: negative-test-start -- verifies Appearance no longer owns the navigation font scale
    expect(stylesheet).not.toContain('--openbitfun-appearance-token-font-size-');
    // typography-audit: negative-test-end
    expect(stylesheet).toContain('font-size: var(--openbitfun-type-meta-font-size);');
    expect(stylesheet).toContain('line-height: var(--openbitfun-type-meta-line-height);');
    expect(stylesheet).not.toContain('text-transform: uppercase;');
  });

  it('keeps search and body separated by the navigation spacing token', () => {
    const root = declarations('.openbitfun-settings-nav');
    const header = declarations('.openbitfun-settings-nav__panel-header');
    expect(root.getPropertyValue('gap')).toBe('var(--openbitfun-layout-navigation-panel-content-gap)');
    expect(header.getPropertyValue('display')).toBe('flex');
    expect(header.getPropertyValue('flex-direction')).toBe('column');
    expect(header.getPropertyValue('gap')).toBe('var(--openbitfun-layout-navigation-panel-content-gap)');
    expect(header.getPropertyValue('padding')).toBe('0px');
    expect(root.getPropertyValue('padding-inline-end')).toBe('0px');
    expect(header.getPropertyValue('padding-inline-end')).toBe('var(--openbitfun-space-2)');
  });

  it('resolves shared navigation text against the current chrome instead of secondary action ink', () => {
    const root = declarations('.openbitfun-settings-nav');
    expect(root.getPropertyValue('--openbitfun-color-content-primary')).toBe('var(--openbitfun-color-content-primary)');
    expect(root.getPropertyValue('--openbitfun-color-action-neutral-content')).toBe('');
  });

  it('leaves group spacing, heading typography, and item geometry and states to NavigationPanel', () => {
    const content = declarations('.openbitfun-settings-nav__content');
    expect(content.getPropertyValue('padding')).toBe('0px');
    expect(content.getPropertyValue('padding-inline-end')).toBe('var(--openbitfun-space-2)');
    expect(content.getPropertyValue('gap')).toBe('');
    expect(rules.some((rule) => rule.selectorText === '.openbitfun-settings-nav__item')).toBe(false);
    expect(rules.some((rule) => rule.selectorText.includes('.openbitfun-settings-nav__category'))).toBe(false);
    expect(readSettingsNavStylesheet()).not.toContain('element-bg-soft');
  });

  it('keeps adjacent navigation interaction surfaces separated by the shared compact rhythm', () => {
    expect(declarations('.openbitfun-settings-nav__items').getPropertyValue('gap')).toBe(
      'calc(var(--openbitfun-space-1) / 2)',
    );
    expect(declarations('.openbitfun-settings-nav__search-results').getPropertyValue('gap')).toBe(
      'calc(var(--openbitfun-space-1) / 2)',
    );
  });

  it('stacks search copy inside the shared label without overriding the selected item', () => {
    const label = declarations('.openbitfun-settings-nav__search-result-copy');
    expect(label.getPropertyValue('display')).toBe('flex');
    expect(label.getPropertyValue('flex-direction')).toBe('column');
    expect(label.getPropertyValue('gap')).toBe('2px');
    expect(declarations('.openbitfun-settings-nav__search-result-item').getPropertyValue('background')).toBe('');
    const highlight = rules.find((rule) => rule.selectorText.includes('.is-highlighted'));
    expect(highlight?.selectorText).toContain('.is-highlighted:not(.is-active)');
    expect(highlight?.style.getPropertyValue('background')).toBe('var(--openbitfun-color-action-neutral-surface)');
  });
});
