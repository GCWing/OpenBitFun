import { tokenVariable } from './contract';
import type { StoredVisualSkin, VisualSkinPartRecipe } from './types';

const css = (property: string, value: string) => `${property}:${value} !important;`;

export function partAssetVariable(skin: StoredVisualSkin, id: string): string {
  return `--openbitfun-skin-asset-${Object.keys(skin.assets).indexOf(id)}`;
}

export function referencedSkinAssets(skin: StoredVisualSkin): ReadonlySet<string> {
  const ids = new Set<string>();
  const collect = (slots: Record<string, VisualSkinPartRecipe> | undefined) => {
    for (const recipe of Object.values(slots ?? {})) if (recipe.assetId) ids.add(recipe.assetId);
  };
  for (const recipe of skin.components ?? []) {
    collect(recipe.slots);
    for (const state of Object.values(recipe.states ?? {})) collect(state?.slots);
  }
  for (const surface of [...skin.surfaces ?? [], ...Object.values(skin.modes).flatMap(mode => mode.surfaces ?? [])]) {
    if (surface.backgroundAssetId) ids.add(surface.backgroundAssetId);
    for (const state of Object.values(surface.states ?? {})) collect(state?.slots);
  }
  return ids;
}

export function partAssetDeclarations(skin: StoredVisualSkin, urls: ReadonlyMap<string, string>): string {
  const style = typeof document === 'undefined' ? null : document.createElement('div').style;
  const declarations: string[] = [];
  for (const [id, url] of urls) {
    const index = Object.keys(skin.assets).indexOf(id);
    if (style) style.setProperty(`--openbitfun-skin-asset-${index}`, `url("${url}")`, 'important');
    else declarations.push(css(partAssetVariable(skin, id), `url("${url}")`));
  }
  return style?.cssText || declarations.join('');
}

/** Paint existing boxes; no DOM insertion, layout, pseudo-element replacement or element opacity. */
export function compilePartPaint(recipe: VisualSkinPartRecipe, skin: StoredVisualSkin): { background: string; edge: string; content: string } {
  let background = '', edge = '', content = '';
  const base = recipe.backgroundToken && tokenVariable(recipe.backgroundToken);
  if (base) background += css('background-color', `var(${base})`);
  for (const [field, property] of [['foregroundToken', 'color'], ['borderToken', 'border-color'], ['shadowToken', 'box-shadow'], ['textShadowToken', 'text-shadow']] as const) {
    const variable = recipe[field] && tokenVariable(recipe[field]);
    if (variable) {
      if (field === 'foregroundToken' || field === 'textShadowToken') content += css(property, `var(${variable})`);
      else edge += css(property, `var(${variable})`);
    }
  }
  const asset = recipe.assetId ? skin.assets[recipe.assetId] : undefined;
  if (recipe.assetId === null) background += css('background-image', 'none');
  if (asset?.dataUrl) {
    const size = recipe.backgroundSize ?? (recipe.fit === 'fill' ? '100% 100%' : recipe.fit ?? 'cover');
    const position = recipe.backgroundPosition ?? 'center';
    const repeat = recipe.backgroundRepeat ?? 'no-repeat';
    // An opaque base-colored veil produces image-only alpha while retaining
    // intrinsic image dimensions. It never fades text, borders or children.
    const veil = base && recipe.backgroundOpacity !== undefined
      ? `linear-gradient(color-mix(in srgb, var(${base}) ${(1 - recipe.backgroundOpacity) * 100}%, transparent), color-mix(in srgb, var(${base}) ${(1 - recipe.backgroundOpacity) * 100}%, transparent)), ` : '';
    background += css('background-image', `${veil}var(${partAssetVariable(skin, recipe.assetId!)})`);
    background += css('background-size', veil ? `100% 100%, ${size}` : size);
    background += css('background-position', veil ? `center, ${position}` : position);
    background += css('background-repeat', veil ? `no-repeat, ${repeat}` : repeat);
  }
  return { background, edge, content };
}
