import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  builtinAppearancePalettes,
  DEFAULT_DARK_APPEARANCE_ID,
  DEFAULT_LIGHT_APPEARANCE_ID,
} from './palettes';
import { createStartupAppearanceBootstrapManifest } from './startupAppearanceBootstrap';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const generatedManifestPath = path.resolve(
  currentDirectory,
  '../../../../../apps/desktop/src/generated/startup_appearance_bootstrap.json',
);
describe('startup appearance bootstrap manifest', () => {
  it('projects only the desktop first-paint fields from builtin appearances', () => {
    const manifest = createStartupAppearanceBootstrapManifest(builtinAppearancePalettes);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      defaultLightAppearanceId: DEFAULT_LIGHT_APPEARANCE_ID,
      defaultDarkAppearanceId: DEFAULT_DARK_APPEARANCE_ID,
    });
    expect(manifest.appearances).toHaveLength(builtinAppearancePalettes.length);
    expect(new Set(manifest.appearances.map(entry => entry.id)).size)
      .toBe(builtinAppearancePalettes.length);

    const light = manifest.appearances.find(entry => entry.id === DEFAULT_LIGHT_APPEARANCE_ID);
    const palette = builtinAppearancePalettes.find(entry => entry.id === DEFAULT_LIGHT_APPEARANCE_ID);
    const chrome = palette?.colors.chrome;
    expect(light).toEqual({
      id: palette?.id,
      bgPrimary: chrome?.background.chrome
        ?? chrome?.background.primary
        ?? palette?.colors.background.chrome
        ?? palette?.colors.background.primary,
      bgSecondary: chrome?.background.secondary ?? palette?.colors.background.secondary,
      bgScene: palette?.colors.background.scene,
      isLight: true,
      textPrimary: chrome?.text.primary ?? palette?.colors.text.primary,
      textMuted: chrome?.text.muted ?? palette?.colors.text.muted,
      accentColor: chrome?.accent[500] ?? palette?.colors.accent[500],
    });

    const monochrome = manifest.appearances.find(entry => entry.id === 'openbitfun-monochrome');
    expect(monochrome).toMatchObject({
      bgPrimary: '#1c1c1f',
      bgSecondary: '#262626',
      bgScene: '#ffffff',
      isLight: true,
      textPrimary: '#f3f3f5',
      accentColor: '#f3f3f5',
    });
  });

  it('keeps the committed desktop manifest synchronized', () => {
    const generated = JSON.parse(fs.readFileSync(generatedManifestPath, 'utf8'));
    expect(generated).toEqual(createStartupAppearanceBootstrapManifest(builtinAppearancePalettes));
  });
});
