import { describe, expect, it } from 'vitest';
import type { AppearancePackage } from '../types';
import { APPEARANCE_THEME_TOKEN_NAMES } from './catalog';
import { composeAppearancePackage } from './composeAppearancePackage';

describe('composeAppearancePackage', () => {
  it.each(['light', 'dark'] as const)('supplies annotation cyan to legacy %s packages without replacing their accent', mode => {
    const original: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: 2,
      id: 'example.legacy-annotations', name: 'Legacy annotations', version: '1.0.0', mode,
      renderers: { 'theme-tokens': { version: 1, settings: {
        tokens: { '--openbitfun-color-accent-default': '#7755aa' },
      } } },
    };
    const resolved = composeAppearancePackage(JSON.parse(JSON.stringify(original)));
    const tokens = resolved.renderers!['theme-tokens']!.settings.tokens;
    expect(tokens['--openbitfun-component-conversation-excerpt-accent']).toBe('#059cb0');
    expect(tokens['--openbitfun-color-accent-default']).toBe('#7755aa');
    expect(composeAppearancePackage(JSON.parse(JSON.stringify(resolved))).renderers?.['theme-tokens'])
      .toEqual(resolved.renderers?.['theme-tokens']);
    expect(original.renderers!['theme-tokens']!.settings.tokens)
      .not.toHaveProperty('--openbitfun-component-conversation-excerpt-accent');
  });

  it('preserves legacy action-card backgrounds in root and chrome across old-payload round trips', () => {
    const original: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: 2,
      id: 'example.legacy-cards', name: 'Legacy cards', version: '1.0.0', mode: 'light',
      renderers: { 'theme-tokens': { version: 1, settings: {
        tokens: { '--openbitfun-color-action-neutral-surface': '#123456', '--openbitfun-color-content-muted': '#556677' },
        scopes: { chrome: { '--openbitfun-color-action-neutral-surface': '#654321', '--openbitfun-color-content-muted': '#778899' } },
      } } },
    };
    const payload = JSON.stringify(original);
    const resolved = composeAppearancePackage(JSON.parse(payload));
    const settings = resolved.renderers!['theme-tokens']!.settings;
    expect(settings.tokens['--openbitfun-color-action-card-background']).toBe('#123456');
    expect(settings.tokens['--openbitfun-color-number-badge-background']).toBe('#123456');
    expect(settings.tokens['--openbitfun-color-key-hint-content']).toBe('#556677');
    expect(settings.scopes?.chrome?.['--openbitfun-color-number-badge-background']).toBe('#654321');
    expect(settings.scopes?.chrome?.['--openbitfun-color-key-hint-content']).toBe('#778899');
    expect(settings.scopes?.chrome?.['--openbitfun-color-action-card-background']).toBe('#654321');
    expect(composeAppearancePackage(JSON.parse(JSON.stringify(resolved))).renderers?.['theme-tokens']).toEqual(resolved.renderers?.['theme-tokens']);
    expect(JSON.stringify(original)).toBe(payload);
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-action-card-background'] = '#112233';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-action-card-background'] = '#334455';
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-number-badge-background'] = '#aabbcc';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-key-hint-content'] = '#ddeeff';
    const explicit = composeAppearancePackage(original).renderers!['theme-tokens']!.settings;
    expect(explicit.tokens['--openbitfun-color-number-badge-background']).toBe('#aabbcc');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-key-hint-content']).toBe('#ddeeff');
    expect(explicit.tokens['--openbitfun-color-action-card-background']).toBe('#112233');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-action-card-background']).toBe('#334455');
  });
  it('preserves legacy field colors and explicit hint overrides across old-payload round trips', () => {
    const original: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: 2,
      id: 'example.legacy-fields', name: 'Legacy fields', version: '1.0.0', mode: 'light',
      renderers: {
        'theme-tokens': {
          version: 1,
          settings: {
            tokens: {
              '--openbitfun-color-field-border': '#123456',
              '--openbitfun-color-field-border-focus': '#654321',
              '--openbitfun-color-content-muted': '#778899',
              '--openbitfun-color-surface-tertiary': '#abcdef',
              '--openbitfun-color-surface-subtle': '#abcdef',
            },
            scopes: { chrome: { '--openbitfun-color-content-muted': '#556677', '--openbitfun-color-field-border-focus': '#445566', '--openbitfun-color-surface-tertiary': '#aabbcc' } },
          },
        },
      },
    };
    const payload = JSON.stringify(original);
    const resolved = composeAppearancePackage(JSON.parse(payload));
    const settings = resolved.renderers!['theme-tokens']!.settings;
    expect(settings.tokens['--openbitfun-color-content-caption']).toBe('#778899');
    expect(settings.scopes?.chrome?.['--openbitfun-color-content-caption']).toBe('#556677');
    expect(settings.tokens['--openbitfun-color-composer-context-background']).toBe('#abcdef');
    expect(settings.tokens['--openbitfun-color-composer-border']).toBe('#123456');
    expect(settings.tokens).toMatchObject({
      '--openbitfun-color-field-border': '#123456',
      '--openbitfun-color-field-border-focus': '#654321',
      '--openbitfun-color-field-border-active': '#654321',
      '--openbitfun-color-field-placeholder': '#778899',
      '--openbitfun-color-field-group-background': '#abcdef',
    });
    expect(settings.scopes?.chrome?.['--openbitfun-color-field-group-background']).toBe('#aabbcc');
    expect(settings.scopes?.chrome?.['--openbitfun-color-field-placeholder']).toBe('#556677');
    expect(settings.scopes?.chrome?.['--openbitfun-color-field-border-active']).toBe('#445566');
    expect(composeAppearancePackage(JSON.parse(JSON.stringify(resolved))).renderers?.['theme-tokens']).toEqual(resolved.renderers?.['theme-tokens']);
    expect(JSON.stringify(original)).toBe(payload);

    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-composer-border'] = '#998877';
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-composer-context-background'] = '#887766';
    expect(composeAppearancePackage(original).renderers!['theme-tokens']!.settings.tokens).toMatchObject({
      '--openbitfun-color-composer-border': '#998877',
      '--openbitfun-color-composer-context-background': '#887766',
    });
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-field-placeholder'] = '#112233';
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-field-border-active'] = '#223344';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-field-placeholder'] = '#334455';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-field-border-active'] = '#556688';
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-field-group-background'] = '#123abc';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-field-group-background'] = '#456def';
    original.renderers!['theme-tokens']!.settings.tokens['--openbitfun-color-content-caption'] = '#abcdef';
    original.renderers!['theme-tokens']!.settings.scopes!.chrome!['--openbitfun-color-content-caption'] = '#fedcba';
    const explicit = composeAppearancePackage(original).renderers!['theme-tokens']!.settings;
    expect(explicit.tokens['--openbitfun-color-content-caption']).toBe('#abcdef');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-content-caption']).toBe('#fedcba');
    expect(explicit.tokens['--openbitfun-color-field-group-background']).toBe('#123abc');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-field-group-background']).toBe('#456def');
    expect(explicit.tokens['--openbitfun-color-field-placeholder']).toBe('#112233');
    expect(explicit.tokens['--openbitfun-color-field-border-active']).toBe('#223344');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-field-placeholder']).toBe('#334455');
    expect(explicit.scopes?.chrome?.['--openbitfun-color-field-border-active']).toBe('#556688');
  });
  it('keeps explicit legacy Button colors through a package round trip without requiring new tokens', () => {
    const original: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: 2,
      id: 'example.legacy-button-colors', name: 'Legacy button colors', version: '1.0.0', mode: 'light',
      renderers: {
        'theme-tokens': {
          version: 1,
          settings: {
            tokens: {
              '--openbitfun-color-action-primary-background': '#123456',
              '--openbitfun-color-action-neutral-surface': '#eeeeee',
              '--openbitfun-color-accent-default': '#007766',
            },
            scopes: { chrome: { '--openbitfun-color-action-neutral-content': '#445566' } },
          },
        },
      },
    };
    const payload = JSON.stringify(original);
    const resolved = composeAppearancePackage(JSON.parse(payload));
    const settings = resolved.renderers?.['theme-tokens']?.settings;
    expect(settings?.tokens).toMatchObject({
      '--openbitfun-color-action-primary-background': '#123456',
      '--openbitfun-component-button-primary-background': '#123456',
      '--openbitfun-component-button-fill-background': '#eeeeee',
      '--openbitfun-component-button-text-content': '#007766',
      '--openbitfun-component-button-primary-content-disabled': 'rgba(0, 0, 0, 0.20)',
    });
    expect(settings?.scopes?.chrome?.['--openbitfun-component-button-content']).toBe('#445566');
    expect(composeAppearancePackage(JSON.parse(JSON.stringify(resolved))).renderers?.['theme-tokens']).toEqual(
      resolved.renderers?.['theme-tokens'],
    );
    expect(JSON.stringify(original)).toBe(payload);
  });

  it('prefers explicit Button tokens over legacy aliases in both root and chrome scopes', () => {
    const tokens = {
      '--openbitfun-color-action-primary-background': '#123456',
      '--openbitfun-component-button-primary-background': '#654321',
    };
    const resolved = composeAppearancePackage({
      schema: 'openbitfun.appearance', schemaVersion: 2,
      id: 'example.button-colors', name: 'Button colors', version: '1.0.0', mode: 'light',
      renderers: { 'theme-tokens': { version: 1, settings: { tokens, scopes: { chrome: tokens } } } },
    });
    const settings = resolved.renderers?.['theme-tokens']?.settings;
    expect(settings?.tokens['--openbitfun-component-button-primary-background']).toBe('#654321');
    expect(settings?.scopes?.chrome?.['--openbitfun-component-button-primary-background']).toBe('#654321');
  });

  it('resolves a partial imported package into a complete host appearance', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 1,
      id: 'example.partial',
      name: 'Partial',
      version: '1.0.0',
      mode: 'dark',
      globals: {
        colors: {
          accent: { kind: 'hex', value: '#ff3366' },
        },
      },
      components: {
        button: {
          parts: {
            root: {
              cascade: 'override',
              base: { borderRadius: { kind: 'px', value: 2 } },
            },
          },
        },
      },
    };

    const resolved = composeAppearancePackage(pkg);

    expect(resolved.id).toBe(pkg.id);
    expect(resolved.globals?.colors?.accent).toEqual({ kind: 'hex', value: '#ff3366' });
    expect(resolved.globals?.colors?.['bg-primary']).toBeDefined();
    expect(resolved.components?.button?.parts.root.base).toMatchObject({
      borderRadius: { kind: 'px', value: 2 },
    });
    expect(resolved.components?.button?.parts.root.cascade).toBe('override');
    expect(resolved.renderers?.monaco).toBeDefined();
    expect(resolved.renderers?.xterm).toBeDefined();
    expect(resolved.renderers?.mermaid).toBeDefined();
    expect(resolved.renderers?.['generative-widget']).toBeDefined();
    expect(resolved.renderers?.['openbitfun-canvas']).toBeDefined();
    expect(Object.keys(resolved.renderers?.['theme-tokens']?.settings.tokens ?? {})).toEqual(
      expect.arrayContaining(APPEARANCE_THEME_TOKEN_NAMES),
    );
  });
});
