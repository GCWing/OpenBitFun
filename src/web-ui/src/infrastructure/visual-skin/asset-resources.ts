import type { StoredVisualSkin } from './types';
import { referencedSkinAssets } from './part-paint';

/** Display-only image URLs. Persisted packages always retain their original data. */
export class VisualSkinImageResources {
  private readonly generations = new Map<StoredVisualSkin, Map<string, string>>();

  ensure(skin: StoredVisualSkin): ReadonlyMap<string, string> {
    const existing = this.generations.get(skin);
    if (existing) return existing;
    const urls = new Map<string, string>();
    try {
      for (const id of referencedSkinAssets(skin)) {
        const asset = skin.assets[id];
        if (!asset?.dataUrl) continue;
        const payload = asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1);
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        urls.set(id, URL.createObjectURL(new Blob([bytes], { type: asset.mimeType })));
      }
    } catch (error) {
      urls.forEach(url => URL.revokeObjectURL(url));
      throw error;
    }
    this.generations.set(skin, urls);
    return urls;
  }

  retain(skins: readonly (StoredVisualSkin | null)[]): void {
    for (const [skin, urls] of this.generations) {
      if (skins.includes(skin)) continue;
      urls.forEach(url => URL.revokeObjectURL(url));
      this.generations.delete(skin);
    }
  }
}
