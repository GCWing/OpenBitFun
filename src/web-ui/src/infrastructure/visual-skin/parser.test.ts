import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VisualSkinPackageParser } from './parser';

const parser = new VisualSkinPackageParser();

describe('VisualSkinPackageParser', () => {
  it('parses a canonical JSON package and resolves the preview asset', async () => {
    const source = {
      manifest: {
        schema: 'openbitfun.visual-skin',
        schemaVersion: 1,
        id: 'canonical-skin',
        name: 'Canonical Skin',
        version: '1.0.0',
        previewAssetId: 'preview',
      },
      modes: { light: { tokens: { 'color.content.primary': '#112233' } } },
      assets: {
        preview: {
          mimeType: 'image/svg+xml',
          source: { kind: 'data', data: 'data:image/svg+xml;base64,PHN2Zy8+' },
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(source));
    const result = await parser.parse(bytes.buffer);
    expect(result.manifest.id).toBe('canonical-skin');
    expect(result.assets.preview.dataUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+');
  });

  it('converts an AI skill package with entrypoints into the canonical package', async () => {
    const zip = new JSZip();
    zip.file('skin.json', JSON.stringify({
      format: 'openbitfun-visual-skin',
      schema_version: 1,
      id: 'skill-skin',
      name: 'Skill Skin',
      entrypoints: {
        tokens: 'tokens.json',
        assets: 'assets.json',
        slots: 'slots.json',
        recipes: 'recipes.json',
      },
    }));
    zip.file('tokens.json', JSON.stringify({
      tokens: [{ id: 'color.surface.canvas', values: { light: '#fefefe', dark: '#111111' } }],
    }));
    zip.file('assets.json', JSON.stringify({
      assets: [
        { id: 'brand.mark', path: 'assets/mark.svg', mimeType: 'image/svg+xml' },
        { id: 'shell.background', path: 'assets/background.svg', mimeType: 'image/svg+xml' },
      ],
    }));
    zip.file('slots.json', JSON.stringify({ slots: [
      { id: 'brand.mark', asset_ids: ['brand.mark'] },
      { id: 'shell.background', asset_ids: ['shell.background'] },
    ] }));
    zip.file('recipes.json', JSON.stringify({ recipes: [{
      id: 'shell',
      surface: 'shell',
      base_token: 'color.surface.canvas',
      background_position: 'center top',
      layers: [
        { kind: 'slot', slot: 'brand.mark' },
        { kind: 'backdrop', slot: 'shell.background', fit: 'cover', opacity: 0.72, position: 'center 20%' },
        { kind: 'scrim', token: 'color.overlay.scrim', opacity: 0.32 },
      ],
    }] }));
    zip.file('assets/mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    zip.file('assets/background.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const source = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parser.parse(source);
    expect(result.manifest.id).toBe('skill-skin');
    expect(result.manifest.previewAssetId).toBe('brand.mark');
    expect(result.assets['brand.mark'].dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(result.modes.light?.tokens?.['color.surface.canvas']).toBe('#fefefe');
    expect(result.components?.[0].slots?.['brand.mark']?.assetId).toBe('brand.mark');
    expect(result.surfaces?.[0]).toMatchObject({
      surface: 'shell',
      baseToken: 'color.surface.canvas',
      backgroundAssetId: 'shell.background',
      backgroundPosition: 'center 20%',
      backgroundOpacity: 0.72,
      scrimToken: 'color.overlay.scrim',
      scrimOpacity: 0.32,
    });
  });

  it('rejects undeclared archive files', async () => {
    const zip = new JSZip();
    zip.file('skin.json', JSON.stringify({
      manifest: {
        schema: 'openbitfun.visual-skin',
        schemaVersion: 1,
        id: 'safe-skin',
        name: 'Safe Skin',
        version: '1.0.0',
      },
      modes: { light: {} },
    }));
    zip.file('unexpected.txt', 'not part of the package');
    const source = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parser.parse(source)).rejects.toThrow('Undeclared visual skin archive file');
  });

  it('imports the bundled example using the current public token and MIME names', async () => {
    const directory = join(process.cwd(), '../crates/assembly/core/builtin_skills/create-visual-theme/examples/aurora-paper');
    const zip = new JSZip();
    const manifest = JSON.parse(readFileSync(join(directory, 'skin.json'), 'utf8'));
    zip.file('skin.json', JSON.stringify(manifest));
    for (const asset of Object.values(manifest.assets) as { source: { path: string } }[]) {
      zip.file(asset.source.path, readFileSync(join(directory, asset.source.path)));
    }
    const skin = await parser.parse(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(skin.modes.light?.tokens).toMatchObject({
      'color.accent.default': '#3E4A92',
      'color.accent.secondary': '#82D8C4',
      'color.content.primary': '#202636',
    });
    expect(skin.assets['brand.mark'].dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(skin.surfaces?.[0].baseToken).toBe('color.surface.canvas');
  });

  it('rejects token aliases rather than translating them into public tokens', async () => {
    const zip = new JSZip();
    zip.file('skin.json', JSON.stringify({
      format: 'openbitfun-visual-skin', schema_version: 1,
      id: 'alias-skin', name: 'Alias Skin', entrypoints: { tokens: 'tokens.json' },
    }));
    zip.file('tokens.json', JSON.stringify({
      tokens: [{ id: 'color.canvas', values: { light: '#ffffff' } }],
    }));
    await expect(parser.parse(await zip.generateAsync({ type: 'arraybuffer' })))
      .rejects.toThrow('Visual skin token is not public: color.canvas');
  });
});
