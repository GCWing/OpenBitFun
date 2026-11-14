import type { TokenName as SystemTokenName } from '@openbitfun/design-tokens';
import type { ThemeDataName, ThemeTokenName } from '@openbitfun/theme-openbitfun';

export const VISUAL_SKIN_SCHEMA = 'openbitfun.visual-skin' as const;
export const VISUAL_SKIN_SCHEMA_VERSION = 1 as const;

export type VisualSkinMode = ThemeDataName;
export type VisualSkinTokenName = ThemeTokenName | Extract<SystemTokenName, `color.${string}` | `shadow.${string}`>;
type BuiltinVisualSkinStateName =
  | 'hover'
  | 'pressed'
  | 'focus'
  | 'focus-within'
  | 'selected'
  | 'disabled'
  | 'checked'
  | 'indeterminate'
  | 'expanded'
  | 'collapsed'
  | 'open'
  | 'closed'
  | 'active'
  | 'loading'
  | 'busy'
  | 'changing'
  | 'dragging'
  | 'transitioning'
  | 'invalid'
  | 'valid'
  | 'readonly'
  | 'required'
  | 'empty'
  | 'fullscreen'
  | 'toolbar'
  | 'connected'
  | 'disconnected'
  | 'local'
  | 'remote'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'error'
  | 'warning'
  | 'success';

/**
 * Product components already expose a larger, documented state vocabulary
 * (active, loading, expanded, dragging, and so on). Keep the built-in states
 * strongly discoverable while allowing those product-owned state ids to pass
 * through the same bounded data attribute contract.
 */
export type VisualSkinStateName = BuiltinVisualSkinStateName | (string & {});

export interface VisualSkinManifest {
  schema: typeof VISUAL_SKIN_SCHEMA;
  schemaVersion: typeof VISUAL_SKIN_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  previewAssetId?: string;
}

export interface VisualSkinAssetDefinition {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  /** Package-relative path for ZIP packages or a data URL for JSON packages. */
  source: { kind: 'path'; path: string } | { kind: 'data'; data: string };
  alt?: string;
}

export interface VisualSkinAsset extends VisualSkinAssetDefinition {
  id: string;
  dataUrl: string;
}

export type VisualSkinTokenValue = string | number;

export interface VisualSkinModePatch {
  tokens?: Partial<Record<VisualSkinTokenName, VisualSkinTokenValue>>;
  /** Replaces a shared/base-mode profile by surface id, as a whole profile. */
  surfaces?: VisualSkinSurfaceProfile[];
  /** Values become CSS variables under the product's named visual slot. */
  slots?: Record<string, Partial<Record<string, VisualSkinTokenValue>>>;
}

export interface VisualSkinPartRecipe {
  /** null explicitly removes the base recipe's image in an interaction state. */
  assetId?: string | null;
  fit?: 'cover' | 'contain' | 'fill';
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat?: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';
  /** Image-only composition over an opaque backgroundToken; never element opacity. */
  backgroundOpacity?: number;
  backgroundToken?: VisualSkinTokenName;
  /** Public shadow token applied to glyphs only; no surface fill or box changes. */
  textShadowToken?: VisualSkinTokenName;
  foregroundToken?: VisualSkinTokenName;
  borderToken?: VisualSkinTokenName;
  shadowToken?: VisualSkinTokenName;
}

export interface VisualSkinStateRecipe {
  tokens?: Partial<Record<VisualSkinTokenName, VisualSkinTokenValue>>;
  slots?: Record<string, VisualSkinPartRecipe>;
}

export interface VisualSkinComponentRecipe {
  /** Stable component or scene id from the product appearance contract. */
  component: string;
  /** Named decorative slots only; recipes cannot add selectors or markup. */
  slots?: Record<string, VisualSkinPartRecipe>;
  tokens?: Partial<Record<VisualSkinTokenName, VisualSkinTokenValue>>;
  states?: Partial<Record<VisualSkinStateName, VisualSkinStateRecipe>>;
}

export interface VisualSkinSurfaceProfile {
  /** Stable product surface id such as workbench, chat, editor, or terminal. */
  surface: string;
  /** Public semantic token for the fallback/base fill of the surface. */
  baseToken?: VisualSkinTokenName;
  /** Base material alpha only; never fades content or changes geometry. Defaults to 1. */
  baseOpacity?: number;
  /** Reveal the single shell backdrop through this surface instead of copying it. */
  backgroundSource?: 'shell';
  backgroundAssetId?: string;
  /** CSS position keywords or percentages used by the backdrop layer. */
  backgroundPosition?: string;
  /** Opacity applied to the backdrop image only. */
  backgroundOpacity?: number;
  scrimToken?: VisualSkinTokenName;
  /** Opacity applied to the scrim layer only. */
  scrimOpacity?: number;
  fit?: 'cover' | 'contain' | 'fill';
  tokens?: Partial<Record<VisualSkinTokenName, VisualSkinTokenValue>>;
  states?: Partial<Record<VisualSkinStateName, VisualSkinStateRecipe>>;
}

export interface VisualSkinPackage {
  manifest: VisualSkinManifest;
  modes: Partial<Record<VisualSkinMode, VisualSkinModePatch>>;
  assets?: Record<string, VisualSkinAssetDefinition>;
  components?: VisualSkinComponentRecipe[];
  surfaces?: VisualSkinSurfaceProfile[];
}

export interface StoredVisualSkin extends VisualSkinPackage {
  assets: Record<string, VisualSkinAsset>;
  importedAt: string;
}

export interface VisualSkinCatalogEntry {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  previewAssetId?: string;
  /** Resolved data URL used by the settings preview card. */
  previewAsset?: string;
  importedAt?: string;
}

export interface InvalidVisualSkinRecord {
  /** Actual IndexedDB key, even when the stored manifest is unreadable. */
  key: IDBValidKey;
  error: string;
}

export interface VisualSkinSnapshot {
  initialized: boolean;
  status: 'initializing' | 'ready' | 'applying' | 'previewing' | 'degraded';
  activeSkinId: string | null;
  previewSkinId: string | null;
  catalog: readonly VisualSkinCatalogEntry[];
  invalidRecords: readonly InvalidVisualSkinRecord[];
  activeSkin: StoredVisualSkin | null;
  projection: VisualSkinProjectionReport | null;
  error?: string;
}

export type VisualSkinProjectionStatus = 'projected' | 'inactive' | 'unresolved' | 'unsupported';

export interface VisualSkinProjectionEntry {
  path: string;
  status: VisualSkinProjectionStatus;
  message: string;
}

export interface VisualSkinProjectionReport {
  mode: VisualSkinMode;
  baseMode: VisualSkinMode;
  projected: number;
  inactive: number;
  unresolved: number;
  unsupported: number;
  entries: readonly VisualSkinProjectionEntry[];
}

export interface VisualSkinValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface VisualSkinValidationResult {
  valid: boolean;
  errors: VisualSkinValidationIssue[];
  warnings: VisualSkinValidationIssue[];
  value?: VisualSkinPackage;
}
