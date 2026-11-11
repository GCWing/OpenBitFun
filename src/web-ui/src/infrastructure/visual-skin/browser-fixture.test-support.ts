import { rm } from 'node:fs/promises';
import type { StoredVisualSkin } from './types';

/** Hosted Linux CI does not provide Chromium's user-namespace sandbox. */
export function browserFixtureFlags(platform = process.platform, environment: { CI?: string } = process.env): string[] {
  return platform === 'linux' && environment.CI === 'true' ? ['--no-sandbox'] : [];
}

/** Chromium subprocesses can still flush their profile after the launcher exits. */
export async function cleanupBrowserFixture(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Node Blob URLs cannot cross into the independent Chromium fixture document. */
export function rehostSkinImages(css: string, skin: StoredVisualSkin | null): string {
  if (!skin) return css;
  const assets = Object.values(skin.assets);
  const mappings = [...css.matchAll(/--openbitfun-skin-asset-(\d+):\s*url\(["']?(blob:[^)"']+)["']?\)/g)];
  for (const [, index, url] of mappings) css = css.split(url).join(assets[Number(index)].dataUrl);
  return css;
}
