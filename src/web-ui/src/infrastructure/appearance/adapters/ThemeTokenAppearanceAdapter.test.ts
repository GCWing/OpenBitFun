// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinAppearancePackages } from '../builtins/catalog';
import { themeTokenAppearanceAdapter } from './ThemeTokenAppearanceAdapter';
import { resolveHighlightPaintColors } from './highlightPaintColors';

const context = { revision: 1, appearanceId: 'test', mode: 'light' as const, globals: {}, assets: {} };

afterEach(async () => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-openbitfun-native-material');
  await themeTokenAppearanceAdapter.apply(undefined, undefined, context);
});

describe('annotation highlight paint colors', () => {
  const accent = '--openbitfun-component-conversation-excerpt-accent';
  const paintStyle = () => document.querySelector<HTMLStyleElement>('style[data-openbitfun-appearance-highlight-paint]');
  const background = () => /background-color: ([^;]+);/.exec(paintStyle()?.textContent ?? '')?.[1] ?? '';
  it.each([
    ['#059cb0', 'rgba(5, 156, 176, 0.3)'],
    ['rgba(10, 20, 30, 0.5)', 'rgba(10, 20, 30, 0.15)'],
    ['#1234', 'rgba(17, 34, 51, 0.08)'],
    ['hsl(120, 100%, 50%)', 'rgba(0, 255, 0, 0.3)'],
    ['transparent', 'rgba(0, 0, 0, 0)'],
  ])('derives concrete paint from legacy accent %s without adding stored fields', async (value, expected) => {
    const settings = { tokens: { [accent]: value } };
    const original = JSON.stringify(settings);
    expect(themeTokenAppearanceAdapter.validate(settings)).toEqual([]);
    await themeTokenAppearanceAdapter.apply(settings, undefined, context);
    const actual = background();
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    expect(channels(actual).slice(0, 3)).toEqual(channels(expected).slice(0, 3));
    // CSSOM may round 8-bit alpha when serializing a legacy hex color.
    expect(channels(actual)[3]).toBeCloseTo(channels(expected)[3], 3);
    expect(JSON.stringify(settings)).toBe(original);
    expect(document.querySelector('span')).toBeNull();
  });
  it('refreshes derived colors on theme changes and clears them for old sparse settings', async () => {
    await themeTokenAppearanceAdapter.apply({ tokens: { [accent]: '#ff0000' } }, undefined, context);
    expect(background()).toBe('rgba(255, 0, 0, 0.3)');
    await themeTokenAppearanceAdapter.apply({ tokens: { [accent]: '#0000ff' } }, undefined, context);
    expect(background()).toBe('rgba(0, 0, 255, 0.3)');
    await themeTokenAppearanceAdapter.apply({ tokens: {} }, undefined, context);
    expect(background()).toBe('');
  });
  it('keeps concrete wide-gamut colors and does not emit unresolved expressions', () => {
    const computed = vi.spyOn(window, 'getComputedStyle');
    computed.mockReturnValueOnce({ color: 'color(display-p3 0.2 0.4 0.6 / 0.5)' } as CSSStyleDeclaration);
    computed.mockReturnValueOnce({ color: 'color(srgb 0.1 0.4 0.6 / 0.15)' } as CSSStyleDeclaration);
    expect(resolveHighlightPaintColors(document, 'color(display-p3 0.2 0.4 0.6 / 0.5)')).toEqual({
      foreground: 'color(display-p3 0.2 0.4 0.6 / 0.5)', background: 'color(srgb 0.1 0.4 0.6 / 0.15)',
    });
    computed.mockReturnValue({ color: 'color-mix(in srgb, red 30%, transparent)' } as CSSStyleDeclaration);
    expect(resolveHighlightPaintColors(document, '#ff0000')).toEqual({});
    expect(document.querySelector('span')).toBeNull();
  });
  it('leaves forced colors to the static system-color rules and removes old paint on reset', async () => {
    await themeTokenAppearanceAdapter.apply({ tokens: { [accent]: '#059cb0' } }, undefined, context);
    expect(paintStyle()?.textContent).toContain('@media (forced-colors: none)');
    expect(paintStyle()?.textContent).not.toContain('color-mix(');
    await themeTokenAppearanceAdapter.apply(undefined, undefined, context);
    expect(paintStyle()).toBeNull();
  });
  it('materializes indirect search/selection mixes in both root and chrome without mutating packages', async () => {
    // jsdom does not compute color-mix; model the browser's computed-color boundary.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'color(srgb 0 0.5 1 / 0.25)' } as CSSStyleDeclaration);
    const value = 'color-mix(in srgb, #0080ff 25%, transparent)';
    const tokens = {
      '--openbitfun-color-accent-border-subtle': value,
      '--openbitfun-color-selection-surface': value,
      '--openbitfun-color-action-secondary-pressed': value,
    };
    const settings = { tokens, scopes: { chrome: tokens } };
    const before = JSON.stringify(settings);
    await themeTokenAppearanceAdapter.apply(settings, undefined, context);
    for (const name of Object.keys(tokens)) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe('color(srgb 0 0.5 1 / 0.25)');
    }
    const scope = document.querySelector('style[data-openbitfun-appearance-theme-scopes]')!;
    expect(scope.textContent).not.toContain('color-mix(');
    expect(scope.textContent).toContain('[data-openbitfun-theme-scope="chrome"]');
    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe('theme root background', () => {
  it('keeps the native backdrop exposed across theme switches and resets', async () => {
    document.documentElement.setAttribute('data-openbitfun-native-material', 'sidebar');
    for (const pkg of builtinAppearancePackages) {
      await themeTokenAppearanceAdapter.apply(pkg.renderers?.['theme-tokens']?.settings, undefined, context);
      expect(document.documentElement.style.backgroundColor).toBe('transparent');
      expect(document.body.style.backgroundColor).toBe('transparent');
    }
    await themeTokenAppearanceAdapter.apply(undefined, undefined, context);
    expect(document.documentElement.style.backgroundColor).toBe('');
    expect(document.documentElement.getAttribute('data-openbitfun-native-material')).toBe('sidebar');
  });

  it('preserves the opaque theme background in browsers and older desktop hosts', async () => {
    const settings = builtinAppearancePackages[0].renderers?.['theme-tokens']?.settings;
    await themeTokenAppearanceAdapter.apply(settings, undefined, context);
    expect(document.documentElement.style.backgroundColor).toBe('var(--openbitfun-color-surface-chrome)');
    expect(document.body.style.backgroundColor).toBe('var(--openbitfun-color-surface-chrome)');
  });
});
