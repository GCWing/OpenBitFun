import type { VisualSkinMode, VisualSkinModePatch, VisualSkinPackage } from './types';

/**
 * Keep mode selection deterministic even when a package only declares one
 * mode. Standard contrast is preferred, then the opposite scheme, followed by
 * the corresponding high-contrast mode and finally the other high-contrast
 * mode. Object insertion order must not affect the rendered result.
 */
const BASE_MODE_FALLBACKS: Record<VisualSkinMode, readonly VisualSkinMode[]> = {
  light: ['light', 'dark', 'highContrastLight', 'highContrastDark'],
  dark: ['dark', 'light', 'highContrastDark', 'highContrastLight'],
  highContrastLight: ['light', 'dark', 'highContrastLight', 'highContrastDark'],
  highContrastDark: ['dark', 'light', 'highContrastDark', 'highContrastLight'],
};


export function resolveSkinMode(skin: VisualSkinPackage, mode: VisualSkinMode) {
  const baseMode = BASE_MODE_FALLBACKS[mode].find(candidate => skin.modes[candidate])!;
  const base = skin.modes[baseMode] ?? {};
  const override = skin.modes[mode] ?? {};
  const sources = new Map<string, string>();
  for (const name of Object.keys(base.tokens ?? {})) sources.set(`tokens.${name}`, baseMode);
  for (const name of Object.keys(override.tokens ?? {})) sources.set(`tokens.${name}`, mode);
  // Slots merge by slot id, matching the compiled patch.
  for (const slot of Object.keys(base.slots ?? {})) sources.set(`slots.${slot}`, baseMode);
  for (const slot of Object.keys(override.slots ?? {})) sources.set(`slots.${slot}`, mode);
  const patch: VisualSkinModePatch = {
    tokens: { ...base.tokens, ...override.tokens },
    slots: { ...base.slots, ...override.slots },
  };
  return { patch, baseMode, sources };
}

export function resolveSkinSurfaces(skin: VisualSkinPackage, mode: VisualSkinMode) {
  const { baseMode } = resolveSkinMode(skin, mode);
  const all = [
    ...(skin.surfaces ?? []).map((surface, index) => ({ surface, path: `surfaces[${index}]` })),
    ...Object.entries(skin.modes).flatMap(([name, patch]) =>
      (patch.surfaces ?? []).map((surface, index) => ({ surface, path: `modes.${name}.surfaces[${index}]` }))),
  ];
  const selected = new Map<string, typeof all[number]>();
  for (const prefix of ['surfaces[', `modes.${baseMode}.surfaces[`, ...(mode === baseMode ? [] : [`modes.${mode}.surfaces[`])]) {
    for (const entry of all.filter(entry => entry.path.startsWith(prefix))) selected.set(entry.surface.surface, entry);
  }
  return { selected: [...selected.values()], inactive: all.filter(entry => selected.get(entry.surface.surface) !== entry) };
}
