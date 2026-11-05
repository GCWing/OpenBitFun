import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const theme = readFileSync(new URL('./components/openui/theme.css', import.meta.url), 'utf8');
const components = readFileSync(new URL('./components/openui/components.css', import.meta.url), 'utf8');
const map = readFileSync(new URL('./components/openui/map/map.css', import.meta.url), 'utf8');
const scheme = readFileSync(new URL('./components/openui/scheme.ts', import.meta.url), 'utf8');
const openbitfunMap = readFileSync(new URL('./components/map/MapView.tsx', import.meta.url), 'utf8');

describe('OpenBitFun GenUI theme integration', () => {
  it('uses host Appearance tokens for OpenUI text, canvas, borders and status colors', () => {
    expect(theme).toContain('--iui-canvas: var(--openbitfun-color-surface-canvas');
    expect(theme).toContain('--iui-ink: var(--openbitfun-color-content-primary');
    expect(theme).toContain('--iui-muted: var(--openbitfun-color-content-secondary');
    expect(theme).toContain('--iui-border: var(--openbitfun-color-border-default');
    expect(theme).toContain('--iui-success: var(--openbitfun-color-status-success-content');
    expect(theme).toContain(':root[data-openbitfun-appearance-mode="dark"]');
    expect(theme).not.toContain('[data-theme="dark"]');
  });

  it('updates OpenUI dark selectors and scheme-aware components from Appearance mode', () => {
    expect(components).toContain('[data-openbitfun-appearance-mode="dark"]');
    expect(map).toContain('[data-openbitfun-appearance-mode="dark"]');
    expect(scheme).toContain('data-openbitfun-appearance-mode');
    expect(openbitfunMap).toContain('useColorScheme(containerRef)');
    expect(openbitfunMap).not.toContain('prefers-color-scheme: dark');
  });
});
