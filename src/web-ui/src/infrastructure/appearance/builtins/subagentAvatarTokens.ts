import avatarPalette from '../../../flow_chat/assets/subagent-avatars/palette.json';
import type { AppearanceThemeTokenName } from '../types';
import type { AppearancePalette } from './AppearancePalette';
import { rgbFromHex } from './paletteHelpers';

function channels(hex: string): number[] {
  return rgbFromHex(hex).match(/\d+/g)!.map(Number);
}

function luminance(channels: number[]): number {
  return channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

/** Identity text uses an authored shade, selected for the conversation surface. */
export function createSubagentAvatarTokens(
  palette: AppearancePalette,
): Record<AppearanceThemeTokenName, string> {
  const background = luminance(channels(palette.colors.background.scene));
  const contrast = (color: number[]) => {
    const foreground = luminance(color);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  };
  return Object.fromEntries(avatarPalette.characters.map(character => {
    const shades = [character.body, character.knob, character.stem, character.face];
    let accent = shades.find(shade => contrast(channels(shade)) >= 4.5);
    if (!accent) {
      // Some warm surfaces need a slightly deeper version of the closest shade.
      const strongest = shades.reduce((best, shade) => (
        contrast(channels(shade)) > contrast(channels(best)) ? shade : best
      ));
      const authored = channels(strongest);
      const text = channels(palette.colors.text.primary);
      for (let step = 1; step <= 20; step += 1) {
        const mixed = authored.map((value, index) => Math.round(value + (text[index] - value) * step / 20));
        accent = `rgb(${mixed.join(', ')})`;
        if (contrast(mixed) >= 4.5) break;
      }
    }
    return [`--openbitfun-domain-subagent-${character.file.replace('.svg', '')}`, accent];
  })) as Record<AppearanceThemeTokenName, string>;
}
