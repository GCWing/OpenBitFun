import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import { builtinAppearancePackages } from '../builtins/catalog';
import { themeTokenAppearanceAdapter } from './ThemeTokenAppearanceAdapter';
import { MonacoAppearanceAdapter } from './MonacoAppearanceAdapter';
import { projectMonacoAppearanceSettings } from './monacoThemeColorCodec';
import { widgetAppearanceAdapter } from './WidgetAppearanceAdapter';

describe('renderer appearance contracts', () => {
  it('accepts every built-in theme token payload and rejects unregistered token names', () => {
    builtinAppearancePackages.forEach(pkg => {
      expect(themeTokenAppearanceAdapter.validate(pkg.renderers?.['theme-tokens']?.settings)).toEqual([]);
    });

    const settings = builtinAppearancePackages[0].renderers?.['theme-tokens']?.settings;
    expect(settings).toBeDefined();
    expect(themeTokenAppearanceAdapter.validate({
      ...settings,
      tokens: { ...settings?.tokens, '--openbitfun-color-unregistered': '#ffffff' },
    })).toContain('Unsupported root token name: --openbitfun-color-unregistered');
  });

  it('accepts every built-in Widget payload and rejects unregistered variables', () => {
    builtinAppearancePackages.forEach(pkg => {
      expect(widgetAppearanceAdapter.validate(pkg.renderers?.['generative-widget']?.settings)).toEqual([]);
    });

    const settings = builtinAppearancePackages[0].renderers?.['generative-widget']?.settings;
    expect(settings).toBeDefined();
    expect(widgetAppearanceAdapter.validate({
      ...settings,
      vars: { ...settings?.vars, '--unregistered-widget-variable': '#ffffff' },
    })).toContain('vars.--unregistered-widget-variable is not registered by the widget host contract');
  });

  it('enforces Monaco theme names before Monaco is attached', async () => {
    const adapter = new MonacoAppearanceAdapter();
    const validSettings = {
      id: 'appearance-openbitfun-linglong',
      base: 'vs-dark' as const,
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#0b1420' },
    };

    expect(adapter.validate(validSettings)).toEqual([]);
    expect(adapter.validate({ ...validSettings, id: 'appearance.openbitfun-linglong' })).toContain(
      'id must contain only lowercase letters, digits, and hyphens',
    );
    await expect(adapter.apply(
      { ...validSettings, id: 'appearance.openbitfun-linglong' },
      undefined,
      { revision: 1, appearanceId: 'openbitfun-linglong', mode: 'dark', globals: {}, assets: {} },
    )).rejects.toThrow('Invalid Monaco appearance');
  });

  it('projects every built-in Monaco payload into Monaco-native colors', () => {
    const nativeColor = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
    const opaqueTokenColor = /^#[0-9a-f]{6}$/i;

    builtinAppearancePackages.forEach(pkg => {
      const settings = pkg.renderers?.monaco?.settings;
      expect(settings, `${pkg.id} must define Monaco settings`).toBeDefined();
      expect(monacoAppearanceAdapterForValidation.validate(settings)).toEqual([]);

      const projected = projectMonacoAppearanceSettings(settings!);
      Object.values(projected.colors).forEach(value => {
        expect(value, `${pkg.id} emitted non-native Monaco color`).toMatch(nativeColor);
      });
      [projected.colors['editor.foreground'], projected.colors['editor.background']]
        .filter((value): value is string => value !== undefined)
        .forEach(value => expect(value).toMatch(opaqueTokenColor));
      projected.rules.forEach(rule => {
        if (rule.foreground) expect(rule.foreground).toMatch(opaqueTokenColor);
        if (rule.background) expect(rule.background).toMatch(opaqueTokenColor);
      });
    });
  });

  it('passes the projected light theme to Monaco defineTheme', async () => {
    const settings = builtinAppearancePackages
      .find(pkg => pkg.id === 'openbitfun-light')
      ?.renderers?.monaco?.settings;
    expect(settings).toBeDefined();

    let receivedTheme: Monaco.editor.IStandaloneThemeData | undefined;
    const defineTheme = vi.fn((_: string, theme: Monaco.editor.IStandaloneThemeData) => {
      receivedTheme = theme;
    });
    const monaco = {
      editor: {
        defineTheme,
        setTheme: vi.fn(),
        getEditors: () => [],
      },
    } as unknown as typeof Monaco;
    const adapter = new MonacoAppearanceAdapter();
    await adapter.apply(settings!, undefined, {
      revision: 1,
      appearanceId: 'openbitfun-light',
      mode: 'light',
      globals: {},
      assets: {},
    });

    expect(() => adapter.attachMonaco(monaco)).not.toThrow();
    expect(defineTheme).toHaveBeenCalledOnce();
    expect(receivedTheme?.colors['editor.foreground']).toBe('#333333');
    expect(receivedTheme?.colors['editor.selectionBackground']).toBe('#101a2724');
  });

  it('reuses the runtime theme for new views while applying same-id appearance updates', async () => {
    const settings = builtinAppearancePackages.find(pkg => pkg.id === 'openbitfun-light')!.renderers!.monaco!.settings;
    const nextSettings = { ...builtinAppearancePackages.find(pkg => pkg.id === 'openbitfun-dark')!.renderers!.monaco!.settings,
      id: settings.id };
    const editor = { updateOptions: vi.fn() };
    const defineTheme = vi.fn(), setTheme = vi.fn();
    const monaco = { editor: { defineTheme, setTheme, getEditors: () => [editor] } } as unknown as typeof Monaco;
    const context = { revision: 1, appearanceId: 'openbitfun-light', mode: 'light' as const, globals: {}, assets: {} };
    const adapter = new MonacoAppearanceAdapter();
    await adapter.apply(settings, undefined, context);
    for (let view = 0; view < 4; view++) expect(adapter.attachMonaco(monaco)).toBe(settings.id);
    expect(defineTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledOnce();
    expect(editor.updateOptions).toHaveBeenCalledOnce();

    await adapter.apply(nextSettings, settings, { ...context, revision: 2 });
    expect(defineTheme).toHaveBeenCalledTimes(2);
    const { id: themeId, ...projectedSettings } = projectMonacoAppearanceSettings(nextSettings);
    expect(defineTheme).toHaveBeenLastCalledWith(themeId, projectedSettings);
    expect(editor.updateOptions).toHaveBeenCalledTimes(2);
    expect(adapter.attachMonaco(monaco)).toBe(settings.id);
    expect(defineTheme).toHaveBeenCalledTimes(2);
  });

  it('applies the current theme to a replacement runtime and retries a failed attachment', async () => {
    const settings = builtinAppearancePackages.find(pkg => pkg.id === 'openbitfun-light')!.renderers!.monaco!.settings;
    const adapter = new MonacoAppearanceAdapter();
    await adapter.apply(settings, undefined, {
      revision: 1, appearanceId: 'openbitfun-light', mode: 'light', globals: {}, assets: {},
    });
    const first = { editor: { defineTheme: vi.fn(), setTheme: vi.fn(), getEditors: () => [] } };
    adapter.attachMonaco(first as unknown as typeof Monaco);
    const next = { editor: { defineTheme: vi.fn().mockImplementationOnce(() => { throw new Error('Unavailable runtime'); }),
      setTheme: vi.fn(), getEditors: () => [] } };
    expect(() => adapter.attachMonaco(next as unknown as typeof Monaco)).toThrow('Unavailable runtime');
    expect(adapter.attachMonaco(next as unknown as typeof Monaco)).toBe(settings.id);
    expect(next.editor.defineTheme).toHaveBeenCalledTimes(2);
    expect(next.editor.setTheme).toHaveBeenCalledOnce();
    adapter.attachMonaco(next as unknown as typeof Monaco);
    expect(next.editor.defineTheme).toHaveBeenCalledTimes(2);
    expect(first.editor.defineTheme).toHaveBeenCalledOnce();
  });
});

const monacoAppearanceAdapterForValidation = new MonacoAppearanceAdapter();
