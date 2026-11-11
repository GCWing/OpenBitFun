import { SkinArchive, MAX_SKIN_MANIFEST_BYTES as MAX_MANIFEST_BYTES, MAX_SKIN_EXPANDED_BYTES as MAX_EXPANDED_BYTES, MAX_SKIN_ASSET_BYTES as MAX_ASSET_BYTES, skinAssetDataUrl } from './archive';
import { isVisualSkinTokenName } from './contract';
import { assertValidVisualSkinPackage } from './validator';
import type {
  StoredVisualSkin,
  VisualSkinAsset,
  VisualSkinComponentRecipe,
  VisualSkinMode,
  VisualSkinPackage,
  VisualSkinAssetDefinition,
  VisualSkinStateRecipe,
  VisualSkinSurfaceProfile,
} from './types';

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MANIFEST_PATH = 'skin.json';
const SKILL_FORMAT = 'openbitfun-visual-skin';
const SAFE_BACKGROUND_POSITION = /^(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%)(?:\s+(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%))?$/;

function isZip(source: ArrayBuffer): boolean {
  return source.byteLength >= 4
    && new Uint8Array(source, 0, 4)[0] === 0x50
    && new Uint8Array(source, 0, 4)[1] === 0x4b;
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`Visual skin JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSafePath(path: string): void {
  const segments = path.split('/');
  if (!path || path.startsWith('/') || path.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Visual skin archive path is unsafe: ${path}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizedTokenMap(raw: unknown): Record<string, string | number> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, string | number> = {};
  Object.entries(raw).forEach(([name, value]) => {
    if (!isVisualSkinTokenName(name)) throw new Error(`Visual skin token is not public: ${name}`);
    if (typeof value === 'string' || typeof value === 'number') result[name] = value;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizedStateMap(raw: unknown): Record<string, VisualSkinStateRecipe> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, VisualSkinStateRecipe> = {};
  Object.entries(raw).forEach(([state, value]) => {
    if (!isRecord(value)) return;
    const tokens = normalizedTokenMap(value.tokens);
    const slots = isRecord(value.slots) ? value.slots as VisualSkinStateRecipe['slots'] : undefined;
    if (tokens || slots) result[state] = { ...(tokens ? { tokens } : {}), ...(slots ? { slots } : {}) };
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function readSkillMode(value: unknown): VisualSkinMode | 'all' | null {
  if (value === 'all') return 'all';
  if (value === 'light' || value === 'dark' || value === 'highContrastLight' || value === 'highContrastDark') return value;
  return null;
}

function skillTokensToModes(raw: unknown): Partial<Record<VisualSkinMode, { tokens: Record<string, string | number> }>> {
  const modes: Partial<Record<VisualSkinMode, { tokens: Record<string, string | number> }>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return modes;
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return modes;
  for (const entry of tokens) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as { id?: unknown; values?: unknown };
    if (typeof value.id !== 'string' || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) continue;
    const tokenName = value.id;
    if (!isVisualSkinTokenName(tokenName)) throw new Error(`Visual skin token is not public: ${tokenName}`);
    for (const [modeName, tokenValue] of Object.entries(value.values)) {
      const mode = readSkillMode(modeName);
      if (!mode || (typeof tokenValue !== 'string' && typeof tokenValue !== 'number')) continue;
      const targetModes: VisualSkinMode[] = mode === 'all'
        ? ['light', 'dark', 'highContrastLight', 'highContrastDark']
        : [mode];
      for (const target of targetModes) {
        const patch = modes[target] ?? { tokens: {} };
        patch.tokens[tokenName] = tokenValue;
        modes[target] = patch;
      }
    }
  }
  return modes;
}

function skillAssetDefinitions(raw: unknown): Record<string, VisualSkinAssetDefinition> {
  const result: Record<string, VisualSkinAssetDefinition> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const assets = (raw as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return result;
  for (const entry of assets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as { id?: unknown; path?: unknown; mimeType?: unknown; alt?: unknown };
    if (typeof value.id !== 'string' || typeof value.path !== 'string') continue;
    const mime = value.mimeType;
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp' && mime !== 'image/svg+xml') continue;
    result[value.id] = {
      mimeType: mime,
      source: { kind: 'path', path: value.path },
      ...(typeof value.alt === 'string' ? { alt: value.alt } : {}),
    };
  }
  return result;
}

function skillRecipes(raw: unknown, slotAssets: Map<string, string>): { components: VisualSkinComponentRecipe[]; surfaces: VisualSkinSurfaceProfile[] } {
  const components: VisualSkinComponentRecipe[] = [];
  const surfaces: VisualSkinSurfaceProfile[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { components, surfaces };
  const recipes = (raw as { recipes?: unknown }).recipes;
  if (!Array.isArray(recipes)) return { components, surfaces };
  for (const entry of recipes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const recipe = entry as {
      id?: unknown;
      surface?: unknown;
      layers?: unknown;
      background_position?: unknown;
      background_opacity?: unknown;
      base_token?: unknown;
      scrim_token?: unknown;
      scrim_opacity?: unknown;
      radius?: unknown;
      edge?: unknown;
      tokens?: unknown;
      states?: unknown;
    };
    if (typeof recipe.id !== 'string') continue;
    const tokens = normalizedTokenMap(recipe.tokens);
    const states = normalizedStateMap(recipe.states);
    const component: VisualSkinComponentRecipe = {
      component: recipe.id,
      slots: {},
      ...(tokens ? { tokens } : {}),
      ...(states ? { states } : {}),
    };
    let surfaceAssetId: string | undefined;
    const surfaceProfile: VisualSkinSurfaceProfile | null = typeof recipe.surface === 'string'
      ? {
        surface: recipe.surface,
        ...(tokens ? { tokens } : {}),
        ...(states ? { states } : {}),
      }
      : null;
    if (surfaceProfile) {
      const recipeBaseToken = typeof recipe.base_token === 'string' && isVisualSkinTokenName(recipe.base_token) ? recipe.base_token : null;
      if (recipeBaseToken) surfaceProfile.baseToken = recipeBaseToken as VisualSkinSurfaceProfile['baseToken'];
      if (typeof recipe.background_position === 'string' && SAFE_BACKGROUND_POSITION.test(recipe.background_position)) {
        surfaceProfile.backgroundPosition = recipe.background_position;
      }
      if (typeof recipe.background_opacity === 'number' && recipe.background_opacity >= 0 && recipe.background_opacity <= 1) {
        surfaceProfile.backgroundOpacity = recipe.background_opacity;
      }
      const recipeScrimToken = typeof recipe.scrim_token === 'string' && isVisualSkinTokenName(recipe.scrim_token) ? recipe.scrim_token : null;
      if (recipeScrimToken) surfaceProfile.scrimToken = recipeScrimToken as VisualSkinSurfaceProfile['scrimToken'];
      if (typeof recipe.scrim_opacity === 'number' && recipe.scrim_opacity >= 0 && recipe.scrim_opacity <= 1) {
        surfaceProfile.scrimOpacity = recipe.scrim_opacity;
      }
      if (recipe.radius !== undefined || recipe.edge !== undefined) {
        throw new Error('Skin recipes cannot change component geometry');
      }
    }
    if (Array.isArray(recipe.layers)) {
      for (const layer of recipe.layers) {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
        const value = layer as {
          kind?: unknown;
          slot?: unknown;
          token?: unknown;
          opacity?: unknown;
          fit?: unknown;
          position?: unknown;
          radius?: unknown;
          edge?: unknown;
        };
        const isBackdrop = (value.kind === 'backdrop' || value.kind === 'slot' && typeof value.slot === 'string' && /(?:hero|background|canvas|surface)/i.test(value.slot));
        if ((value.kind === 'slot' || value.kind === 'backdrop') && typeof value.slot === 'string') {
          const assetId = slotAssets.get(value.slot);
          if (assetId) {
            if (isBackdrop) {
              surfaceAssetId ??= assetId;
              if (surfaceProfile) {
                surfaceProfile.backgroundAssetId = surfaceAssetId;
                if (value.fit === 'cover' || value.fit === 'contain' || value.fit === 'fill') surfaceProfile.fit = value.fit;
                if (typeof value.position === 'string' && SAFE_BACKGROUND_POSITION.test(value.position)) surfaceProfile.backgroundPosition = value.position;
                if (typeof value.opacity === 'number' && value.opacity >= 0 && value.opacity <= 1) surfaceProfile.backgroundOpacity = value.opacity;
              }
            } else {
              component.slots![value.slot] = { assetId, fit: 'contain' };
            }
          }
        }
        if (surfaceProfile && (value.kind === 'fill' || value.kind === 'base')) {
          const baseToken = typeof value.token === 'string' && isVisualSkinTokenName(value.token) ? value.token : null;
          if (baseToken) surfaceProfile.baseToken = baseToken as VisualSkinSurfaceProfile['baseToken'];
        }
        if (surfaceProfile && (value.kind === 'scrim' || value.kind === 'tint')) {
          const scrimToken = typeof value.token === 'string' && isVisualSkinTokenName(value.token) ? value.token : null;
          if (scrimToken) surfaceProfile.scrimToken = scrimToken as VisualSkinSurfaceProfile['scrimToken'];
          if (typeof value.opacity === 'number' && value.opacity >= 0 && value.opacity <= 1) surfaceProfile.scrimOpacity = value.opacity;
        }
        if (value.radius !== undefined || value.edge !== undefined || value.kind === 'shape') {
          throw new Error('Skin layers cannot change component geometry');
        }
      }
    }
    if (Object.keys(component.slots ?? {}).length === 0) delete component.slots;
    components.push(component);
    if (surfaceProfile) surfaces.push(surfaceProfile);
  }
  return { components, surfaces };
}

export class VisualSkinPackageParser {
  async parse(source: ArrayBuffer): Promise<StoredVisualSkin> {
    if (source.byteLength === 0 || source.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Visual skin package must be between 1 byte and ${MAX_ARCHIVE_BYTES} bytes`);
    }
    const parsed = isZip(source)
      ? await this.parseZip(source)
      : this.parseJson(new TextDecoder().decode(new Uint8Array(source)));
    const value = assertValidVisualSkinPackage(parsed);
    const assets = Object.fromEntries(
      Object.entries(value.assets ?? {}).map(([id, asset]) => [id, {
        ...asset,
        id,
        dataUrl: asset.source.kind === 'data' ? asset.source.data : '',
      } satisfies VisualSkinAsset]),
    );
    const previewAsset = value.manifest.previewAssetId ? assets[value.manifest.previewAssetId] : undefined;
    if (value.manifest.previewAssetId && !previewAsset) {
      throw new Error(`Visual skin preview asset is missing: ${value.manifest.previewAssetId}`);
    }
    return {
      ...value,
      assets,
      importedAt: new Date().toISOString(),
    };
  }

  private parseJson(raw: string): VisualSkinPackage {
    if (raw.length > MAX_MANIFEST_BYTES) throw new Error('Visual skin JSON is too large');
    const value = decodeJson(new TextEncoder().encode(raw));
    const packageValue = assertValidVisualSkinPackage(value);
    const assetEntries = Object.entries(packageValue.assets ?? {});
    const assetBytes = assetEntries.reduce((total, [, asset]) => {
      if (asset.source.kind === 'path') throw new Error('JSON visual skin assets must use data URLs');
      if (asset.source.kind === 'data') return total + asset.source.data.length;
      return total;
    }, 0);
    if (assetBytes > MAX_EXPANDED_BYTES) throw new Error('Visual skin assets exceed the allowed size');
    return packageValue;
  }

  private async parseZip(source: ArrayBuffer): Promise<VisualSkinPackage> {
    const zip = await SkinArchive.open(source);
    try { return await this.readZip(zip); } finally { await zip.close(); }
  }

  private async readZip(zip: SkinArchive): Promise<VisualSkinPackage> {
    const files = [...zip.files.keys()];
    const manifestBytes = await zip.read(MANIFEST_PATH, MAX_MANIFEST_BYTES);
    const root = decodeJson(manifestBytes);
    if (root && typeof root === 'object' && !Array.isArray(root) && 'format' in root && (root as { format?: unknown }).format === SKILL_FORMAT) {
      return this.parseSkillZip(zip, files, root as Record<string, unknown>);
    }
    const parsed = assertValidVisualSkinPackage(root);
    const assets = { ...(parsed.assets ?? {}) };
    const declared = new Set<string>([MANIFEST_PATH]);
    for (const [assetId, asset] of Object.entries(assets)) {
      if (asset.source.kind !== 'path') continue;
      assertSafePath(asset.source.path);
      if (declared.has(asset.source.path)) throw new Error(`Visual skin archive path is duplicated: ${asset.source.path}`);
      declared.add(asset.source.path);
      const file = zip.files.get(asset.source.path);
      if (!file) throw new Error(`Visual skin asset is missing: ${asset.source.path}`);
      const bytes = await zip.read(asset.source.path, MAX_ASSET_BYTES);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`Visual skin asset has an invalid size: ${assetId}`);

      assets[assetId] = {
        ...asset,
        source: { kind: 'data', data: skinAssetDataUrl(asset.mimeType, bytes) },
      };
    }
    files.forEach(file => {
      if (!declared.has(file)) throw new Error(`Undeclared visual skin archive file: ${file}`);
    });
    return { ...parsed, assets };
  }

  private async parseSkillZip(
    zip: SkinArchive,
    files: string[],
    root: Record<string, unknown>,
  ): Promise<VisualSkinPackage> {
    if (root.schema_version !== 1) throw new Error('Visual skin skill package must use schema_version 1');
    const id = root.id;
    const name = root.name;
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Visual skin skill package requires id and name');
    const rawEntrypoints = root.entrypoints;
    if (!rawEntrypoints || typeof rawEntrypoints !== 'object' || Array.isArray(rawEntrypoints)) throw new Error('Visual skin skill package requires entrypoints');
    const entrypoints = rawEntrypoints as Record<string, unknown>;
    const declared = new Set<string>([MANIFEST_PATH]);
    const readEndpoint = async (name: string): Promise<unknown | null> => {
      const value = entrypoints[name];
      if (typeof value !== 'string') {
        return null;
      }
      assertSafePath(value);
      if (declared.has(value)) throw new Error(`Visual skin archive path is duplicated: ${value}`);
      declared.add(value);
      const file = zip.files.get(value);
      if (!file) throw new Error(`Visual skin skill entrypoint is missing: ${value}`);
      const bytes = await zip.read(value, MAX_MANIFEST_BYTES);
      if (name === 'reference_analysis') return null;
      return decodeJson(bytes);
    };

    const tokenDocument = await readEndpoint('tokens');
    const assetDocument = await readEndpoint('assets');
    const slotDocument = await readEndpoint('slots');
    const recipeDocument = await readEndpoint('recipes');
    // The reference analysis is human-readable and intentionally not parsed.
    await readEndpoint('reference_analysis');

    const assets = skillAssetDefinitions(assetDocument);
    const slotAssets = new Map<string, string>();
    if (slotDocument && typeof slotDocument === 'object' && !Array.isArray(slotDocument)) {
      const slots = (slotDocument as { slots?: unknown }).slots;
      if (Array.isArray(slots)) {
        for (const slot of slots) {
          if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
          const value = slot as { id?: unknown; asset_ids?: unknown };
          if (typeof value.id !== 'string' || !Array.isArray(value.asset_ids)) continue;
          const assetId = value.asset_ids.find(candidate => typeof candidate === 'string' && assets[candidate]);
          if (assetId) slotAssets.set(value.id, assetId);
        }
      }
    }
    for (const asset of Object.values(assets)) {
      if (asset.source.kind !== 'path') continue;
      const assetPath = asset.source.path;
      assertSafePath(assetPath);
      if (declared.has(assetPath)) throw new Error(`Visual skin archive path is duplicated: ${assetPath}`);
      declared.add(assetPath);
      const file = zip.files.get(assetPath);
      if (!file) throw new Error(`Visual skin asset is missing: ${asset.source.path}`);
      const bytes = await zip.read(assetPath, MAX_ASSET_BYTES);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Visual skin asset has an invalid size');
      asset.source = { kind: 'data', data: skinAssetDataUrl(asset.mimeType, bytes) };
    }
    const recipes = skillRecipes(recipeDocument, slotAssets);
    const modes = skillTokensToModes(tokenDocument);
    if (Object.keys(modes).length === 0) modes.light = { tokens: {} };
    const firstAsset = Object.keys(assets)[0];
    const packageValue: VisualSkinPackage = {
      manifest: {
        schema: 'openbitfun.visual-skin',
        schemaVersion: 1,
        id,
        name,
        version: typeof root.version === 'string' ? root.version : '1.0.0',
        ...(typeof root.author === 'string' ? { author: root.author } : {}),
        ...(typeof root.description === 'string' ? { description: root.description } : {}),
        ...(firstAsset ? { previewAssetId: firstAsset } : {}),
      },
      modes,
      assets,
      components: recipes.components,
      surfaces: recipes.surfaces,
    };
    files.forEach(file => {
      if (!declared.has(file)) throw new Error(`Undeclared visual skin archive file: ${file}`);
    });
    return packageValue;
  }
}
