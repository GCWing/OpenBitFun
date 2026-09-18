import { describe, expect, it } from 'vitest';
import { builtinAppearancePalettes, openBitFunDarkPalette } from '../builtins/palettes';
import { buildBuiltinAppearance } from '../builtins/buildBuiltinAppearance';
import { composeAppearancePackage } from '../builtins/composeAppearancePackage';
import { AppearanceRegistry } from '../registry/AppearanceRegistry';
import { createDefaultAppearanceRegistry } from '../registry/defaultAppearanceRegistry';
import { AppearancePackageValidationError } from '../schema/AppearancePackageValidationError';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '../types';
import { AppearanceCompiler } from './AppearanceCompiler';

describe('AppearanceCompiler', () => {
  it('preserves structured validation diagnostics when compilation is rejected', () => {
    const pkg = {
      ...buildBuiltinAppearance(openBitFunDarkPalette),
      components: {
        'toolbar-mode': {
          parts: {
            sessionMenu: { base: { opacity: { kind: 'number', value: 1 } } },
          },
        },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('compiles a built-in appearance without retired design-system component selectors', () => {
    const compiler = new AppearanceCompiler(createDefaultAppearanceRegistry());
    const snapshot = compiler.compile(buildBuiltinAppearance(openBitFunDarkPalette), 3);

    expect(snapshot.id).toBe(openBitFunDarkPalette.id);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.cssText).toContain('--openbitfun-appearance-colors-bg-primary');
    expect(snapshot.cssText).not.toContain('[data-openbitfun-component="card"]');
    expect(snapshot.cssText).not.toContain('@layer');
    expect(snapshot.cssText).not.toContain(' !important;');
    expect(snapshot.cssText).not.toContain('.btn-primary');
  });

  it('keeps product Appearance selectors distinct from design-system anatomy', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.product-surface',
      name: 'Product Surface',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'user-message-edit-composer': {
          parts: {
            root: { base: { opacity: { kind: 'number', value: 0.9 } } },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);

    expect(snapshot.cssText).toContain(
      '[data-openbitfun-product-component="user-message-edit-composer"]'
      + '[data-openbitfun-product-part="root"]',
    );
    expect(snapshot.cssText).not.toContain(
      '[data-openbitfun-component="user-message-edit-composer"][data-openbitfun-part="root"]',
    );
  });

  it('targets the renamed context picker for legacy file-picker Appearance packages', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.legacy-context-picker',
      name: 'Legacy Context Picker',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'file-mention-picker': {
          parts: {
            root: { base: { opacity: { kind: 'number', value: 0.9 } } },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);

    expect(snapshot.cssText).toContain(
      '[data-openbitfun-component="chat-context-picker"][data-openbitfun-part="root"]',
    );
    expect(snapshot.cssText).not.toContain(
      '[data-openbitfun-component="file-mention-picker"]',
    );
  });

  it('rejects retired Settings surface ids without rewriting the package', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 2,
      id: 'test.legacy-settings-surface',
      name: 'Legacy Settings Surface',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'session-config': {
          parts: {
            petTrigger: {
              facets: {
                view: {
                  personalization: { borderColor: { kind: 'hex', value: '#4488ff' } },
                },
              },
            },
            content: {
              facets: {
                view: {
                  execution: { color: { kind: 'hex', value: '#4488ff' } },
                },
              },
            },
            control: {
              facets: {
                view: {
                  'device-control': { color: { kind: 'hex', value: '#4488ff' } },
                },
              },
            },
            platformNote: {
              facets: {
                view: {
                  'execution-control': { color: { kind: 'hex', value: '#4488ff' } },
                },
              },
            },
          },
        },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('rejects retired split execution facets without rewriting the package', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 2,
      id: 'test.split-execution-settings',
      name: 'Split Execution Settings',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'runtime-settings': {
          parts: {
            content: {
              facets: {
                view: {
                  'execution-common': { color: { kind: 'hex', value: '#4488ff' } },
                  'execution-advanced': { color: { kind: 'hex', value: '#8844ff' } },
                },
              },
            },
          },
        },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('rejects retired appearance Settings parts without rewriting the package', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 2,
      id: 'test.legacy-appearance-settings-cards',
      name: 'Legacy Appearance Settings Cards',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'appearance-config': {
          parts: {
            packageGrid: { base: { opacity: { kind: 'number', value: 0.8 } } },
            packagePreview: { base: { opacity: { kind: 'number', value: 0.9 } } },
          },
        },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('rejects retired product action parts without rewriting the package', () => {
    const visible = { kind: 'number', value: 0.9 } as const;
    const retired = { kind: 'number', value: 0.4 } as const;
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 2,
      id: 'test.retired-product-actions',
      name: 'Retired Product Actions',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'copy-output-button': {
          parts: {
            root: { base: { opacity: visible } },
            action: { base: { opacity: retired } },
          },
        },
        'sessions-section': {
          parts: {
            root: { base: { opacity: visible } },
            retry: { base: { opacity: retired } },
          },
        },
        'editor-config': {
          parts: {
            root: {
              base: { opacity: visible },
              states: { saving: { opacity: retired } },
            },
            actions: { base: { opacity: retired } },
            saving: { base: { opacity: retired } },
          },
        },
      },
      scenes: {
        skills: {
          parts: {
            root: { base: { opacity: visible } },
            addAction: { base: { opacity: retired } },
          },
        },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('rejects retired component surfaces without rewriting the package', () => {
    const visible = { kind: 'number', value: 0.9 } as const;
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: 2,
      id: 'test.retired-component-surfaces',
      name: 'Retired Component Surfaces',
      version: '1.0.0',
      mode: 'dark',
      components: {
        button: { parts: { root: { base: { opacity: visible } } } },
        switch: { parts: { root: { base: { opacity: visible } } } },
        select: { parts: { dropdown: { base: { opacity: visible } } } },
        card: { parts: { root: { base: { opacity: visible } } } },
      },
    };

    expect(() => new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1))
      .toThrow(AppearancePackageValidationError);
  });

  it('compiles canonical Settings surface ids', () => {
    const accent = { kind: 'hex', value: '#4488ff' } as const;
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.settings-surfaces',
      name: 'Settings Surfaces',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'application-settings': { parts: { notifications: { base: { borderColor: accent } } } },
        'model-settings': {
          parts: { root: { facets: { view: { selection: { borderColor: accent } } } } },
        },
        'appearance-settings': { parts: { root: { base: { borderColor: accent } } } },
        'runtime-settings': { parts: { petTrigger: { states: { expanded: { borderColor: accent } } } } },
        'worktree-settings': { parts: { results: { base: { borderColor: accent } } } },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('[data-openbitfun-component="application-settings"][data-openbitfun-part="notifications"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="model-settings"][data-openbitfun-part="root"][data-openbitfun-view="selection"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="appearance-settings"][data-openbitfun-part="root"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="runtime-settings"][data-openbitfun-part="petTrigger"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="worktree-settings"][data-openbitfun-part="results"]');
  });

  it('compiles every built-in appearance without raw CSS passthrough', () => {
    const compiler = new AppearanceCompiler(createDefaultAppearanceRegistry());
    builtinAppearancePalettes.forEach((palette, index) => {
      const snapshot = compiler.compile(buildBuiltinAppearance(palette), index + 1);
      expect(snapshot.mode).toBe(palette.type);
      expect(snapshot.cssText).not.toContain('url(');
    });
  });

  it('keeps built-in UI motion within the responsive interaction budget', () => {
    const seconds = (value: string) => Number.parseFloat(value.replace('s', ''));

    builtinAppearancePalettes.forEach((palette) => {
      expect(seconds(palette.motion.duration.fast)).toBeLessThanOrEqual(0.16);
      expect(seconds(palette.motion.duration.base)).toBeLessThanOrEqual(0.24);
      expect(seconds(palette.motion.duration.slow)).toBeLessThanOrEqual(0.45);
      expect(palette.motion.easing.standard).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
    });
  });

  it('calculates real contrast diagnostics for structured colors', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.low-contrast',
      name: 'Low Contrast',
      version: '1.0.0',
      mode: 'light',
      components: {
        'gallery-layout': {
          parts: {
            root: {
              base: {
                backgroundColor: { kind: 'hex', value: '#ffffff' },
                color: { kind: 'hex', value: '#eeeeee' },
              },
            },
          },
        },
      },
    };
    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LOW_CONTRAST' }),
    ]));
  });

  it('uses important declarations only for explicitly overriding parts', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.cascade-override',
      name: 'Cascade Override',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'gallery-layout': {
          parts: {
            root: {
              cascade: 'override',
              base: { color: { kind: 'hex', value: '#ffffff' } },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('color:#ffffff !important;');
  });

  it('keeps non-forceable layout declarations in the normal cascade', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.property-level-override',
      name: 'Property Level Override',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'content-canvas': {
          parts: {
            root: {
              cascade: 'override',
              base: {
                backgroundColor: { kind: 'hex', value: '#101010' },
                position: 'relative',
              },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('background-color:#101010 !important;');
    expect(snapshot.cssText).toContain('position:relative;');
    expect(snapshot.cssText).not.toContain('position:relative !important;');
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OVERRIDE_PROPERTY_NOT_FORCEABLE' }),
    ]));
  });

  it('normalizes side borders and outlines into deterministic CSS', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.border-normalization',
      name: 'Border Normalization',
      version: '1.0.0',
      mode: 'light',
      components: {
        'gallery-layout': {
          parts: {
            root: {
              base: {
                borderStyle: 'solid',
                borderBottomWidth: { kind: 'px', value: 1 },
                outlineWidth: { kind: 'px', value: 2 },
                outlineColor: { kind: 'hex', value: '#8866ff' },
              },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('border-width:0;border-bottom-width:1px;border-style:solid;');
    expect(snapshot.cssText).toContain('outline-color:#8866ff;outline-width:2px;outline-style:solid;');
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BORDER_WIDTH_NORMALIZED' }),
      expect.objectContaining({ code: 'OUTLINE_STYLE_NORMALIZED' }),
    ]));
  });

  it('combines materials in declaration order before applying the part base', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.material-composition',
      name: 'Material Composition',
      version: '1.0.0',
      mode: 'dark',
      materials: {
        surface: {
          visualRole: 'control',
          style: {
            backgroundColor: { kind: 'hex', value: '#202020' },
            borderRadius: { kind: 'px', value: 6 },
          },
        },
        accent: {
          visualRole: 'control',
          style: {
            color: { kind: 'hex', value: '#ff66cc' },
            backgroundColor: { kind: 'hex', value: '#303030' },
          },
        },
      },
      components: {
        'gallery-layout': {
          parts: {
            root: {
              materials: ['surface', 'accent'],
              base: { backgroundColor: { kind: 'hex', value: '#404040' } },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('background-color:#404040;');
    expect(snapshot.cssText).toContain('color:#ff66cc;');
    expect(snapshot.cssText).toContain('border-radius:6px;');
  });

  it('does not synthesize retired component baselines for an explicit product-surface override', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.layered-cascade',
      name: 'Layered Cascade',
      version: '1.0.0',
      mode: 'light',
      components: {
        'gallery-layout': {
          parts: {
            root: {
              cascade: 'override',
              base: { borderRadius: { kind: 'px', value: 2 } },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(
      composeAppearancePackage(pkg),
      1,
    );
    expect(snapshot.cssText).toContain('border-radius:2px !important;');
    expect(snapshot.cssText).not.toContain('display:flex;');
  });

  it('compiles structured layout, media, transform, and filter values without CSS passthrough', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.structured-style',
      name: 'Structured Style',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'content-canvas': {
          parts: {
            root: {
              base: {
                display: 'grid',
                width: { kind: 'lengthKeyword', value: 'fit-content' },
                paddingTop: { kind: 'vh', value: 2 },
                marginInline: { kind: 'lengthKeyword', value: 'auto' },
                gridTemplateColumns: {
                  kind: 'gridTracks',
                  tracks: [{ kind: 'fr', value: 1 }, { kind: 'px', value: 24 }],
                },
                aspectRatio: { kind: 'ratio', width: 16, height: 9 },
                objectFit: 'cover',
                justifyItems: 'center',
                order: { kind: 'number', value: 2 },
                caretColor: { kind: 'hex', value: '#33ffaa' },
                transform: { kind: 'transform', rotate: 12, scale: 1.05 },
                filter: [
                  { kind: 'blur', value: { kind: 'px', value: 2 } },
                  { kind: 'saturate', value: { kind: 'number', value: 1.2 } },
                ],
              },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('grid-template-columns:1fr 24px;');
    expect(snapshot.cssText).toContain('width:fit-content;');
    expect(snapshot.cssText).toContain('padding-top:2vh;');
    expect(snapshot.cssText).toContain('margin-inline:auto;');
    expect(snapshot.cssText).toContain('justify-items:center;');
    expect(snapshot.cssText).toContain('order:2;');
    expect(snapshot.cssText).toContain('caret-color:#33ffaa;');
    expect(snapshot.cssText).toContain('aspect-ratio:16 / 9;');
    expect(snapshot.cssText).toContain('object-fit:cover;');
    expect(snapshot.cssText).toContain('transform:rotate(12deg) scale(1.05);');
    expect(snapshot.cssText).toContain('filter:blur(2px) saturate(1.2);');
  });

  it('compiles layered package assets into aligned host-owned background declarations', () => {
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.layered-backgrounds',
      name: 'Layered Backgrounds',
      version: '1.0.0',
      mode: 'light',
      assets: {
        backdrop: { kind: 'image', mimeType: 'image/webp', source: { kind: 'package', path: 'assets/backdrop.webp' } },
        texture: { kind: 'image', mimeType: 'image/png', source: { kind: 'package', path: 'assets/texture.png' } },
        ornament: { kind: 'image', mimeType: 'image/png', source: { kind: 'package', path: 'assets/ornament.png' } },
      },
      components: {
        'gallery-layout': {
          parts: {
            root: {
              base: {
                backgroundImages: [
                  { kind: 'asset', assetId: 'ornament' },
                  { kind: 'asset', assetId: 'texture' },
                  { kind: 'asset', assetId: 'backdrop' },
                ],
                backgroundSizes: [
                  { kind: 'backgroundSize', width: { kind: 'px', value: 96 }, height: { kind: 'lengthKeyword', value: 'auto' } },
                  { kind: 'backgroundSize', width: { kind: 'px', value: 256 }, height: { kind: 'lengthKeyword', value: 'auto' } },
                  'cover',
                ],
                backgroundPositions: [
                  { kind: 'backgroundPosition', x: { kind: 'percent', value: 100 }, y: { kind: 'percent', value: 100 } },
                  { kind: 'backgroundPosition', x: { kind: 'percent', value: 0 }, y: { kind: 'percent', value: 0 } },
                  { kind: 'backgroundPosition', x: { kind: 'percent', value: 65 }, y: { kind: 'percent', value: 50 } },
                ],
                backgroundRepeats: ['no-repeat', 'repeat', 'no-repeat'],
                backgroundBlendModes: ['normal', 'soft-light', 'normal'],
              },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain(
      'background-image:var(--openbitfun-appearance-asset-ornament, none), var(--openbitfun-appearance-asset-texture, none), var(--openbitfun-appearance-asset-backdrop, none);',
    );
    expect(snapshot.cssText).toContain('background-size:96px auto, 256px auto, cover;');
    expect(snapshot.cssText).toContain('background-position:100% 100%, 0% 0%, 65% 50%;');
    expect(snapshot.cssText).toContain('background-repeat:no-repeat, repeat, no-repeat;');
    expect(snapshot.cssText).toContain('background-blend-mode:normal, soft-light, normal;');
    expect(snapshot.cssText).not.toContain('url(');
  });

  it('compiles ancestor-owned state selectors for descendant parts', () => {
    const registry = new AppearanceRegistry()
      .registerComponent({
        id: 'checkbox',
        parts: [{ id: 'root' }, { id: 'box' }],
        states: [{
          id: 'checked',
          selector: {
            kind: 'ancestorPart',
            part: 'root',
            suffix: ':has(input:checked)',
          },
        }],
      })
      .freeze();
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.ancestor-state',
      name: 'Ancestor State',
      version: '1.0.0',
      mode: 'dark',
      components: {
        checkbox: {
          parts: {
            box: {
              states: {
                checked: { backgroundColor: { kind: 'hex', value: '#22cc88' } },
              },
            },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(registry).compile(pkg, 1);
    expect(snapshot.cssText).toContain(
      '[data-openbitfun-component="checkbox"][data-openbitfun-part="root"]:has(input:checked) [data-openbitfun-component="checkbox"][data-openbitfun-part="box"]',
    );
  });

  it('targets multiple parts, facets, and states across complex product surfaces', () => {
    const accent = { kind: 'hex', value: '#ff3366' } as const;
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.product-surfaces',
      name: 'Product Surfaces',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'about-dialog': {
          parts: {
            hero: { base: { backgroundColor: accent } },
            title: { base: { color: { kind: 'hex', value: '#ffffff' } } },
            progressFill: { states: { downloading: { backgroundColor: accent } } },
          },
        },
        'nav-panel': {
          parts: {
            topAction: {
              contexts: [{
                when: { facets: { action: 'new-session' }, states: ['active'] },
                style: { backgroundColor: accent },
              }],
            },
          },
        },
        'canvas-editor-area': {
          parts: {
            root: {
              facets: { layout: { grid: { gap: { kind: 'px', value: 8 } } } },
            },
          },
        },
        'canvas-tab': {
          parts: {
            root: { states: { active: { borderBottomColor: accent } } },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('[data-openbitfun-component="about-dialog"][data-openbitfun-part="hero"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="about-dialog"][data-openbitfun-part="updateCard"][data-openbitfun-state~="downloading"] [data-openbitfun-component="about-dialog"][data-openbitfun-part="progressFill"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="nav-panel"][data-openbitfun-part="topAction"][data-openbitfun-action="new-session"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="canvas-editor-area"][data-openbitfun-part="root"][data-openbitfun-layout="grid"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="canvas-tab"][data-openbitfun-product-part="root"][data-openbitfun-state~="active"]');
  });

  it('compiles dedicated contracts for large interactive owners', () => {
    const accent = { kind: 'hex', value: '#33ffaa' } as const;
    const pkg: AppearancePackage = {
      schema: 'openbitfun.appearance',
      schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.large-owners',
      name: 'Large Owners',
      version: '1.0.0',
      mode: 'dark',
      components: {
        'chat-input': {
          parts: {
            target: {
              contexts: [{
                when: { facets: { target: 'btw' }, states: ['selected'] },
                style: { backgroundColor: accent },
              }],
            },
          },
        },
        'virtual-message-list': {
          parts: {
            boundaryStatus: {
              states: { unavailable: { color: accent } },
            },
          },
        },
        'model-settings': {
          parts: {
            root: {
              facets: { view: { selection: { backgroundColor: accent } } },
            },
          },
        },
        'external-sources-config': {
          parts: {
            conflict: { base: { borderColor: accent } },
          },
        },
        'review-platform': {
          parts: {
            listItem: { states: { selected: { backgroundColor: accent } } },
          },
        },
        'modern-flow-chat': {
          parts: {
            historyOpenIntent: { base: { backgroundColor: accent } },
          },
        },
        'runtime-settings': {
          parts: {
            petTrigger: { states: { expanded: { borderColor: accent } } },
          },
        },
        'mcp-tools-config': {
          parts: {
            root: { facets: { view: { json: { backgroundColor: accent } } } },
            authEditor: { base: { borderColor: accent } },
          },
        },
        'sessions-section': {
          parts: {
            row: { states: { active: { backgroundColor: accent } } },
          },
        },
        'files-panel': {
          parts: {
            search: { facets: { searchMode: { content: { borderColor: accent } } } },
          },
        },
        'remote-connect-dialog': {
          parts: {
            sidebar: { base: { borderColor: accent } },
            overviewAction: {
              contexts: [{
                when: { facets: { group: 'account' }, states: ['authenticated'] },
                style: { backgroundColor: accent },
              }],
            },
          },
        },
        'session-usage-panel': {
          parts: {
            tab: {
              contexts: [{
                when: { facets: { tab: 'models' }, states: ['active'] },
                style: { color: accent },
              }],
            },
          },
        },
        'acp-agents-config': {
          parts: {
            root: { facets: { view: { json: { backgroundColor: accent } } } },
            remoteServer: { base: { borderColor: accent } },
          },
        },
        'tiptap-editor': {
          parts: {
            inlineAiPanel: { base: { backgroundColor: accent } },
          },
        },
        'scheduled-jobs-view': {
          parts: {
            root: { facets: { target: { workspace: { backgroundColor: accent } } } },
            job: { states: { expanded: { borderColor: accent } } },
          },
        },
        'deep-review-action-bar': {
          parts: {
            root: {
              contexts: [{
                when: { facets: { phase: 'review_completed', variant: 'success' } },
                style: { borderColor: accent },
              }],
            },
          },
        },
        'rich-text-input': {
          parts: {
            contextTag: { facets: { contextType: { 'widget-reference': { backgroundColor: accent } } } },
          },
        },
        'model-round-item': {
          parts: {
            root: { facets: { status: { streaming: { backgroundColor: accent } } } },
            action: { states: { copied: { color: accent } } },
          },
        },
        'flexible-panel': {
          parts: {
            code: { states: { needsFix: { borderColor: accent } } },
          },
        },
        'btw-session-panel': {
          parts: {
            root: { facets: { view: { session: { backgroundColor: accent } } } },
          },
        },
        'model-selector': {
          parts: {
            trigger: { states: { open: { borderColor: accent } } },
          },
        },
        'session-files-badge': {
          parts: {
            file: { facets: { operation: { modify: { borderColor: accent } } } },
          },
        },
        'code-review-tool-card': {
          parts: {
            group: { states: { expanded: { backgroundColor: accent } } },
          },
        },
        'create-agent-page': {
          parts: {
            levelOption: { states: { active: { backgroundColor: accent } } },
          },
        },
        'keyboard-shortcuts': {
          parts: {
            item: { states: { recording: { borderColor: accent } } },
          },
        },
        'task-tool-display': {
          parts: {
            root: { states: { failed: { borderColor: accent } } },
          },
        },
        'application-settings': {
          parts: {
            notifications: { base: { backgroundColor: accent } },
          },
        },
        'markdown-editor': {
          parts: {
            root: { facets: { view: { source: { backgroundColor: accent } } } },
          },
        },
        'plan-viewer': {
          parts: {
            editorPanel: { states: { expanded: { borderColor: accent } } },
          },
        },
        'terminal-tool': {
          parts: {
            screen: { base: { backgroundColor: accent } },
          },
        },
        'app-layout': {
          parts: {
            root: { states: { toolbar: { backgroundColor: accent } } },
          },
        },
        'skill-group-picker': {
          parts: {
            token: { states: { selected: { borderColor: accent } } },
          },
        },
        'working-copy-view': {
          parts: {
            file: { states: { selected: { backgroundColor: accent } } },
          },
        },
        'assistant-config-page': {
          parts: {
            persona: { states: { selected: { borderColor: accent } } },
          },
        },
        'assistant-defaults-page': {
          parts: {
            skill: { states: { covered: { backgroundColor: accent } } },
          },
        },
        'task-detail-panel': {
          parts: {
            root: { states: { empty: { backgroundColor: accent } } },
          },
        },
        'toolbar-mode': {
          parts: {
            root: { states: { expanded: { borderColor: accent } } },
          },
        },
        'mcp-tool-display': {
          parts: {
            expanded: { states: { expanded: { backgroundColor: accent } } },
          },
        },
        'skills-config': {
          parts: {
            marketItem: { states: { installed: { borderColor: accent } } },
          },
        },
        'diff-editor': {
          parts: {
            loading: { states: { loading: { backgroundColor: accent } } },
          },
        },
        'agent-companion-desktop-pet': {
          parts: { hitbox: { states: { attention: { borderColor: accent } } } },
        },
        'tool-group-picker': {
          parts: { token: { states: { selected: { backgroundColor: accent } } } },
        },
        'inline-diff-preview': {
          parts: { root: { states: { empty: { backgroundColor: accent } } } },
        },
        'export-image': {
          parts: { trigger: { states: { exporting: { color: accent } } } },
        },
        'user-message-item': {
          parts: { root: { states: { failed: { borderColor: accent } } } },
        },
        'session-usage-report-card': {
          parts: { loading: { states: { loading: { backgroundColor: accent } } } },
        },
        'create-plan-display': {
          parts: { todos: { states: { expanded: { backgroundColor: accent } } } },
        },
        'workspace-project-permissions-dialog': {
          parts: { rule: { base: { borderColor: accent } } },
        },
        'workspace-session-batch-modal': {
          parts: { row: { states: { selected: { backgroundColor: accent } } } },
        },
        'archived-sessions-config': {
          parts: { group: { states: { collapsed: { borderColor: accent } } } },
        },
        'settings-nav': {
          parts: { item: { states: { active: { backgroundColor: accent } } } },
        },
        'background-command-output-panel': {
          parts: { root: { states: { error: { borderColor: accent } } } },
        },
        'chat-input-pixel-pet': {
          parts: { root: { facets: { mood: { working: { backgroundColor: accent } } } } },
        },
        'chat-context-picker': {
          parts: { root: { states: { loading: { backgroundColor: accent } } } },
        },
        'session-file-modifications-bar': {
          parts: { file: { facets: { operation: { edit: { borderColor: accent } } } } },
        },
        'editor-breadcrumb': {
          parts: { item: { states: { active: { backgroundColor: accent } } } },
        },
        'git-branch-history': {
          parts: { commit: { states: { expanded: { borderColor: accent } } } },
        },
        'git-diff-view': {
          parts: { file: { states: { expanded: { backgroundColor: accent } } } },
        },
        'git-settings-view': {
          parts: { status: { states: { error: { borderColor: accent } } } },
        },
      },
      scenes: {
        agents: {
          parts: {
            catalogGrid: { base: { borderColor: accent } },
          },
        },
      },
    };

    const snapshot = new AppearanceCompiler(createDefaultAppearanceRegistry()).compile(pkg, 1);
    expect(snapshot.cssText).toContain('[data-openbitfun-component="chat-input"][data-openbitfun-part="target"][data-openbitfun-target="btw"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="virtual-message-list"][data-openbitfun-part="boundaryStatus"][data-openbitfun-state~="unavailable"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="model-settings"][data-openbitfun-part="root"][data-openbitfun-view="selection"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="external-sources-config"][data-openbitfun-product-part="conflict"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="review-platform"][data-openbitfun-product-part="listItem"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="modern-flow-chat"][data-openbitfun-part="historyOpenIntent"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="runtime-settings"][data-openbitfun-part="petTrigger"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="mcp-tools-config"][data-openbitfun-part="root"][data-openbitfun-view="json"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="mcp-tools-config"][data-openbitfun-part="authEditor"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="sessions-section"][data-openbitfun-part="row"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="files-panel"][data-openbitfun-part="search"][data-openbitfun-search-mode="content"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="remote-connect-dialog"][data-openbitfun-part="sidebar"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="remote-connect-dialog"][data-openbitfun-part="overviewAction"][data-openbitfun-group="account"][data-openbitfun-state~="authenticated"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-scene="agents"][data-openbitfun-part="catalogGrid"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="session-usage-panel"][data-openbitfun-product-part="tab"][data-openbitfun-tab="models"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="acp-agents-config"][data-openbitfun-part="root"][data-openbitfun-view="json"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="acp-agents-config"][data-openbitfun-part="remoteServer"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="tiptap-editor"][data-openbitfun-part="inlineAiPanel"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="scheduled-jobs-view"][data-openbitfun-part="root"][data-openbitfun-target="workspace"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="scheduled-jobs-view"][data-openbitfun-part="job"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="deep-review-action-bar"][data-openbitfun-product-part="root"][data-openbitfun-phase="review_completed"][data-openbitfun-variant="success"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="rich-text-input"][data-openbitfun-part="contextTag"][data-openbitfun-context-type="widget-reference"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="model-round-item"][data-openbitfun-product-part="root"][data-openbitfun-status="streaming"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="model-round-item"][data-openbitfun-product-part="action"][data-openbitfun-state~="copied"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="flexible-panel"][data-openbitfun-part="code"][data-openbitfun-state~="needsFix"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="btw-session-panel"][data-openbitfun-part="root"][data-openbitfun-view="session"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="model-selector"][data-openbitfun-part="trigger"][data-openbitfun-state~="open"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="session-files-badge"][data-openbitfun-part="file"][data-openbitfun-operation="modify"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="code-review-tool-card"][data-openbitfun-part="group"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="create-agent-page"][data-openbitfun-part="levelOption"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="keyboard-shortcuts"][data-openbitfun-part="item"][data-openbitfun-state~="recording"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="task-tool-display"][data-openbitfun-part="root"][data-openbitfun-state~="failed"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="application-settings"][data-openbitfun-part="notifications"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="markdown-editor"][data-openbitfun-product-part="root"][data-openbitfun-view="source"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="plan-viewer"][data-openbitfun-part="editorPanel"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="terminal-tool"][data-openbitfun-part="screen"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="app-layout"][data-openbitfun-part="root"][data-openbitfun-state~="toolbar"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="skill-group-picker"][data-openbitfun-product-part="token"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="working-copy-view"][data-openbitfun-part="file"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="assistant-config-page"][data-openbitfun-part="persona"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="assistant-defaults-page"][data-openbitfun-part="skill"][data-openbitfun-state~="covered"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="task-detail-panel"][data-openbitfun-product-part="root"][data-openbitfun-state~="empty"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="toolbar-mode"][data-openbitfun-product-part="root"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="mcp-tool-display"][data-openbitfun-part="expanded"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="skills-config"][data-openbitfun-part="marketItem"][data-openbitfun-state~="installed"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="diff-editor"][data-openbitfun-part="loading"][data-openbitfun-state~="loading"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="agent-companion-desktop-pet"][data-openbitfun-part="hitbox"][data-openbitfun-state~="attention"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="tool-group-picker"][data-openbitfun-product-part="token"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="inline-diff-preview"][data-openbitfun-part="root"][data-openbitfun-state~="empty"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="export-image"][data-openbitfun-product-part="trigger"][data-openbitfun-state~="exporting"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="user-message-item"][data-openbitfun-product-part="root"][data-openbitfun-state~="failed"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="session-usage-report-card"][data-openbitfun-part="loading"][data-openbitfun-state~="loading"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="create-plan-display"][data-openbitfun-part="todos"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="workspace-project-permissions-dialog"][data-openbitfun-part="rule"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="workspace-session-batch-modal"][data-openbitfun-part="row"][data-openbitfun-state~="selected"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="archived-sessions-config"][data-openbitfun-part="group"][data-openbitfun-state~="collapsed"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="settings-nav"][data-openbitfun-part="item"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="background-command-output-panel"][data-openbitfun-part="root"][data-openbitfun-state~="error"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="chat-input-pixel-pet"][data-openbitfun-part="root"][data-openbitfun-mood="working"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="chat-context-picker"][data-openbitfun-part="root"][data-openbitfun-state~="loading"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="session-file-modifications-bar"][data-openbitfun-part="file"][data-openbitfun-operation="edit"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-product-component="editor-breadcrumb"][data-openbitfun-product-part="item"][data-openbitfun-state~="active"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="git-branch-history"][data-openbitfun-part="commit"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="git-diff-view"][data-openbitfun-part="file"][data-openbitfun-state~="expanded"]');
    expect(snapshot.cssText).toContain('[data-openbitfun-component="git-settings-view"][data-openbitfun-part="status"][data-openbitfun-state~="error"]');
  });
});
