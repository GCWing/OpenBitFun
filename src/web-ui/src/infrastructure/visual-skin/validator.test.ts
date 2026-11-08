import { describe, expect, it } from 'vitest';
import { validateVisualSkinPackage } from './validator';
import { MAX_SKIN_ASSET_BYTES } from './archive';

const base = {
  manifest: {
    schema: 'openbitfun.visual-skin',
    schemaVersion: 1,
    id: 'validator-skin',
    name: 'Validator Skin',
    version: '1.0.0',
  },
  modes: { light: {} },
};

describe('validateVisualSkinPackage', () => {
  it('uses the same decoded byte budget for embedded assets and archive entries', () => {
    const asset = (size: number) => ({ ...base, assets: { art: { mimeType: 'image/webp', source: { kind: 'data', data: 'data:image/webp;base64,' + Buffer.alloc(size).toString('base64') } } } });
    expect(validateVisualSkinPackage(asset(MAX_SKIN_ASSET_BYTES)).valid).toBe(true);
    expect(validateVisualSkinPackage(asset(MAX_SKIN_ASSET_BYTES + 1)).valid).toBe(false);
  });
  it('accepts exact camelCase product part names without relaxing identifier safety', () => {
    const component = { component: 'chat-composer', slots: { contextBar: { foregroundToken: 'color.content.primary' } }, states: { hover: { slots: { pageHeader: { borderToken: 'color.border.default' } } } } };
    expect(validateVisualSkinPackage({ ...base, components: [component] }).valid).toBe(true);
    expect(validateVisualSkinPackage({ ...base, components: [{ ...component, slots: { 'contextBar"]': { foregroundToken: 'color.content.primary' } } }] }).valid).toBe(false);
    expect(validateVisualSkinPackage({ ...base, components: [{ ...component, component: 'chatComposer' }] }).valid).toBe(false);
  });
  it('accepts public semantic tokens and named slot variables', () => {
    const result = validateVisualSkinPackage({
      ...base,
      modes: {
        light: {
          tokens: { 'color.content.primary': '#ffffff' },
          slots: { 'shell.hero': { 'image-opacity': 0.8 } },
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts paint and component state tokens', () => {
    const result = validateVisualSkinPackage({
      ...base,
      modes: {
        light: {
          tokens: {
            'color.content.primary': '#123456',
            'shadow.sm': '0 1px 3px #000000',
          },
        },
      },
      components: [{
        component: 'app-layout',
        states: {
          selected: { tokens: { 'color.selection.surface': '#123456' } },
          active: { tokens: { 'color.accent.default': '#456789' } },
          focus: { tokens: { 'color.focus.ring': '#abcdef' } },
        },
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects arbitrary CSS values and unknown theme tokens', () => {
    const result = validateVisualSkinPackage({
      ...base,
      modes: { light: { tokens: { 'color.not-public': '#fff', 'color.content.primary': 'url(https://example.com)' } } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.path.includes('color.not-public'))).toBe(true);
    expect(result.errors.some(error => error.message.includes('forbidden CSS'))).toBe(true);
  });

  it('rejects unsafe asset paths and component references', () => {
    const result = validateVisualSkinPackage({
      ...base,
      assets: {
        hero: { mimeType: 'image/png', source: { kind: 'path', path: '../hero.png' } },
      },
      components: [{ component: 'shell', slots: { hero: { assetId: '../hero' } } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.path === 'assets.hero.source.path')).toBe(true);
    expect(result.errors.some(error => error.path.includes('assetId'))).toBe(true);
  });

  it('validates isolated surface backdrop and scrim controls', () => {
    const valid = validateVisualSkinPackage({
      ...base,
      surfaces: [{
        surface: 'navigation',
        baseToken: 'color.surface.canvas',
        fit: 'cover',
        backgroundPosition: 'center top',
        backgroundOpacity: 0.72,
        scrimToken: 'color.surface.canvas',
        scrimOpacity: 0.4,
      }],
    });
    expect(valid.valid).toBe(true);

    const invalid = validateVisualSkinPackage({
      ...base,
      surfaces: [{
        surface: 'navigation',
        baseToken: 'color.not-public',
        fit: 'url(https://example.com)',
        backgroundPosition: 'center; color: red',
        backgroundOpacity: 2,
        scrimOpacity: -1,
        edge: 'diagonal',
      }],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some(error => error.path.endsWith('backgroundPosition'))).toBe(true);
    expect(invalid.errors.some(error => error.path.endsWith('fit'))).toBe(true);
    expect(invalid.errors.some(error => error.path.endsWith('baseToken'))).toBe(true);
    expect(invalid.errors.some(error => error.path.endsWith('backgroundOpacity'))).toBe(true);
    expect(invalid.errors.some(error => error.path.endsWith('scrimOpacity'))).toBe(true);
    expect(invalid.errors.some(error => error.path.endsWith('edge'))).toBe(true);
  });

  it('checks asset references inside surface interaction states', () => {
    const result = validateVisualSkinPackage({
      ...base,
      assets: {},
      surfaces: [{
        surface: 'chat',
        states: {
          expanded: { slots: { overlay: { assetId: 'missing' } } },
        },
      }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.path === 'surfaces[0].states.expanded.slots.overlay.assetId')).toBe(true);
  });
});


it.each(['radius.md', 'space.4', 'layout.toolbar.md.height', 'type.body.md.fontSize', 'motion.duration.fast', 'control.launcherButton.radius'])('rejects geometry token %s at every recipe scope', name => {
  const tokens = { [name]: '12px' };
  for (const patch of [
    { modes: { light: { tokens } } },
    { components: [{ component: 'button', tokens }] },
    { components: [{ component: 'button', states: { hover: { tokens } } }] },
    { surfaces: [{ surface: 'navigation', tokens }] },
    { modes: { light: { surfaces: [{ surface: 'navigation', tokens }] } } },
  ]) expect(validateVisualSkinPackage({ manifest: { schema: 'openbitfun.visual-skin', schemaVersion: 1, id: 'geometry', name: 'geometry', version: '1' }, modes: { light: {} }, ...patch }).valid).toBe(false);
});

it.each(['radiusToken', 'edge'])('rejects surface geometry field %s', field => {
  const result = validateVisualSkinPackage({manifest:{schema:'openbitfun.visual-skin',schemaVersion:1,id:'geometry',name:'geometry',version:'1'},modes:{light:{}},surfaces:[{surface:'navigation',[field]:field==='edge'?'none':'pill'}]});
  expect(result.valid).toBe(false);
  expect(result.errors.some(error=>error.path===`surfaces[0].${field}`)).toBe(true);
});


it('accepts glyph shadows only through public shadow tokens', () => {
  const check = (token: string) => validateVisualSkinPackage({ ...base, components: [{ component: 'markdown', slots: { root: { textShadowToken: token } } }] });
  expect(check('shadow.base').valid).toBe(true);
  expect(check('color.surface.panel').valid).toBe(false);
  expect(check('0 0 3px black').valid).toBe(false);
});
