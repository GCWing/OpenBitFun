import type { StoredVisualSkin } from './types';

/** Node Blob URLs cannot cross into the independent Chromium fixture document. */
export function rehostSkinImages(css: string, skin: StoredVisualSkin | null): string {
  if (!skin) return css;
  const assets = Object.values(skin.assets);
  const mappings = [...css.matchAll(/--openbitfun-skin-asset-(\d+):\s*url\(["']?(blob:[^)"']+)["']?\)/g)];
  for (const [, index, url] of mappings) css = css.split(url).join(assets[Number(index)].dataUrl);
  return css;
}
