export const APPEARANCE_SCHEMA = 'openbitfun.appearance' as const;
export const APPEARANCE_SCHEMA_VERSION = 2 as const;
export const SYSTEM_APPEARANCE_ID = 'system' as const;

export type AppearanceMode = 'light' | 'dark';
export type AppearanceSelectionId = string | typeof SYSTEM_APPEARANCE_ID;
export type AppearanceCapability =
  | 'components.v1'
  | 'scenes.v1'
  | 'renderers.v1'
  | 'assets.v1'
  | 'background-media.v1';

export interface AppearanceReference {
  kind: 'ref';
  path: string;
}

export interface AppearanceHexColor {
  kind: 'hex';
  value: string;
}

export interface AppearanceRgbColor {
  kind: 'rgb';
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface AppearanceHslColor {
  kind: 'hsl';
  h: number;
  s: number;
  l: number;
  a?: number;
}

export interface AppearanceTransparentColor {
  kind: 'transparent';
}

export type AppearanceColorValue =
  | AppearanceReference
  | AppearanceHexColor
  | AppearanceRgbColor
  | AppearanceHslColor
  | AppearanceTransparentColor;

export interface AppearanceLengthLiteral {
  kind: 'px' | 'rem' | 'em' | 'ch' | 'vw' | 'vh' | 'percent';
  value: number;
}

export interface AppearanceLengthKeyword {
  kind: 'lengthKeyword';
  value: 'auto' | 'min-content' | 'max-content' | 'fit-content';
}

export interface AppearanceZeroLength {
  kind: 'zero';
}

export type AppearanceLengthValue = AppearanceReference | AppearanceLengthLiteral | AppearanceLengthKeyword | AppearanceZeroLength;

export interface AppearanceNumberLiteral {
  kind: 'number';
  value: number;
}

export type AppearanceNumberValue = AppearanceReference | AppearanceNumberLiteral;

export interface AppearanceDurationLiteral {
  kind: 'ms';
  value: number;
}

export type AppearanceDurationValue = AppearanceReference | AppearanceDurationLiteral;

export interface AppearanceShadowLiteral {
  kind: 'shadow';
  x: AppearanceLengthValue;
  y: AppearanceLengthValue;
  blur: AppearanceLengthValue;
  spread?: AppearanceLengthValue;
  color: AppearanceColorValue;
  inset?: boolean;
}

export interface AppearanceNoShadow {
  kind: 'none';
}

export type AppearanceShadowValue = AppearanceReference | AppearanceShadowLiteral | AppearanceNoShadow;

export type AppearanceEasingValue =
  | AppearanceReference
  | { kind: 'easing'; value: 'linear' | 'standard' | 'decelerate' | 'accelerate' };

export type AppearanceBorderStyle = 'none' | 'solid' | 'dashed' | 'dotted';
export type AppearanceDisplay = 'block' | 'inline' | 'inline-block' | 'flex' | 'inline-flex' | 'grid';
export type AppearanceOverflow = 'visible' | 'hidden' | 'clip' | 'auto' | 'scroll';
export type AppearanceCursor = 'default' | 'pointer' | 'text' | 'move' | 'grab' | 'grabbing' | 'wait' | 'not-allowed';
export type AppearancePosition = 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
export type AppearanceGridTrackValue =
  | AppearanceLengthValue
  | { kind: 'fr'; value: number }
  | { kind: 'trackKeyword'; value: 'auto' | 'min-content' | 'max-content' };

export interface AppearanceGridTemplateValue {
  kind: 'gridTracks';
  tracks: AppearanceGridTrackValue[];
}

export interface AppearanceRatioValue {
  kind: 'ratio';
  width: number;
  height: number;
}

export type AppearanceFilterItem =
  | { kind: 'blur'; value: AppearanceLengthValue }
  | { kind: 'brightness' | 'contrast' | 'grayscale' | 'saturate'; value: AppearanceNumberValue }
  | { kind: 'hueRotate'; degrees: number };

export interface AppearanceTransitionItem {
  property:
    | 'all'
    | 'background-color'
    | 'background-position'
    | 'border-color'
    | 'border-radius'
    | 'box-shadow'
    | 'color'
    | 'filter'
    | 'gap'
    | 'height'
    | 'margin'
    | 'opacity'
    | 'padding'
    | 'width'
    | 'transform';
  duration: AppearanceDurationValue;
  easing: AppearanceEasingValue;
  delay?: AppearanceDurationValue;
}

export interface AppearanceTransformValue {
  kind: 'transform';
  scale?: number;
  translateX?: AppearanceLengthValue;
  translateY?: AppearanceLengthValue;
  rotate?: number;
}

export interface AppearanceAssetReference {
  kind: 'asset';
  assetId: string;
}

export type AppearanceBackgroundRepeat = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';
export type AppearanceBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'soft-light'
  | 'hard-light';

export type AppearanceBackgroundDimensionValue =
  | AppearanceReference
  | AppearanceLengthLiteral
  | AppearanceZeroLength
  | { kind: 'lengthKeyword'; value: 'auto' };

export type AppearanceBackgroundPositionCoordinate =
  | AppearanceReference
  | AppearanceLengthLiteral
  | AppearanceZeroLength;

export type AppearanceBackgroundSizeValue =
  | 'auto'
  | 'cover'
  | 'contain'
  | {
      kind: 'backgroundSize';
      width: AppearanceBackgroundDimensionValue;
      height?: AppearanceBackgroundDimensionValue;
    };

export type AppearanceBackgroundPositionValue =
  | 'center'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | {
      kind: 'backgroundPosition';
      x: AppearanceBackgroundPositionCoordinate;
      y: AppearanceBackgroundPositionCoordinate;
    };

export interface AppearanceStyle {
  backgroundColor?: AppearanceColorValue;
  backgroundImage?: AppearanceAssetReference;
  backgroundSize?: 'auto' | 'cover' | 'contain';
  backgroundPosition?: 'center' | 'top' | 'right' | 'bottom' | 'left';
  backgroundRepeat?: AppearanceBackgroundRepeat;
  backgroundImages?: AppearanceAssetReference[];
  backgroundSizes?: AppearanceBackgroundSizeValue[];
  backgroundPositions?: AppearanceBackgroundPositionValue[];
  backgroundRepeats?: AppearanceBackgroundRepeat[];
  backgroundBlendModes?: AppearanceBlendMode[];
  color?: AppearanceColorValue;
  caretColor?: AppearanceColorValue;
  accentColor?: AppearanceColorValue;
  textDecorationColor?: AppearanceColorValue;
  borderColor?: AppearanceColorValue;
  borderTopColor?: AppearanceColorValue;
  borderRightColor?: AppearanceColorValue;
  borderBottomColor?: AppearanceColorValue;
  borderLeftColor?: AppearanceColorValue;
  borderWidth?: AppearanceLengthValue;
  borderTopWidth?: AppearanceLengthValue;
  borderRightWidth?: AppearanceLengthValue;
  borderBottomWidth?: AppearanceLengthValue;
  borderLeftWidth?: AppearanceLengthValue;
  borderStyle?: AppearanceBorderStyle;
  borderRadius?: AppearanceLengthValue;
  borderTopLeftRadius?: AppearanceLengthValue;
  borderTopRightRadius?: AppearanceLengthValue;
  borderBottomRightRadius?: AppearanceLengthValue;
  borderBottomLeftRadius?: AppearanceLengthValue;
  boxSizing?: 'content-box' | 'border-box';
  outlineColor?: AppearanceColorValue;
  outlineWidth?: AppearanceLengthValue;
  outlineOffset?: AppearanceLengthValue;
  outlineStyle?: AppearanceBorderStyle;
  boxShadow?: AppearanceShadowValue[];
  opacity?: AppearanceNumberValue;
  textAlign?: 'left' | 'center' | 'right' | 'start' | 'end';
  verticalAlign?: 'baseline' | 'sub' | 'super' | 'text-top' | 'text-bottom' | 'middle' | 'top' | 'bottom';
  textIndent?: AppearanceLengthValue;
  textDecoration?: 'none' | 'underline' | 'line-through';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  textOverflow?: 'clip' | 'ellipsis';
  whiteSpace?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line';
  wordBreak?: 'normal' | 'break-all' | 'keep-all' | 'break-word';
  overflowWrap?: 'normal' | 'break-word' | 'anywhere';
  display?: AppearanceDisplay;
  flexDirection?: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  flexGrow?: AppearanceNumberValue;
  flexShrink?: AppearanceNumberValue;
  flexBasis?: AppearanceLengthValue;
  alignItems?: 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'baseline';
  alignContent?: 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  alignSelf?: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'baseline';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  justifySelf?: 'auto' | 'stretch' | 'start' | 'center' | 'end';
  justifyItems?: 'auto' | 'normal' | 'stretch' | 'start' | 'center' | 'end';
  placeItems?: 'normal' | 'stretch' | 'start' | 'center' | 'end';
  placeContent?: 'normal' | 'stretch' | 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
  order?: AppearanceNumberValue;
  gridTemplateColumns?: AppearanceGridTemplateValue;
  gridTemplateRows?: AppearanceGridTemplateValue;
  gridAutoFlow?: 'row' | 'column' | 'dense' | 'row dense' | 'column dense';
  gridColumnSpan?: AppearanceNumberValue;
  gridRowSpan?: AppearanceNumberValue;
  gap?: AppearanceLengthValue;
  rowGap?: AppearanceLengthValue;
  columnGap?: AppearanceLengthValue;
  width?: AppearanceLengthValue;
  minWidth?: AppearanceLengthValue;
  maxWidth?: AppearanceLengthValue;
  height?: AppearanceLengthValue;
  minHeight?: AppearanceLengthValue;
  maxHeight?: AppearanceLengthValue;
  padding?: AppearanceLengthValue;
  paddingBlock?: AppearanceLengthValue;
  paddingInline?: AppearanceLengthValue;
  paddingTop?: AppearanceLengthValue;
  paddingRight?: AppearanceLengthValue;
  paddingBottom?: AppearanceLengthValue;
  paddingLeft?: AppearanceLengthValue;
  margin?: AppearanceLengthValue;
  marginBlock?: AppearanceLengthValue;
  marginInline?: AppearanceLengthValue;
  marginTop?: AppearanceLengthValue;
  marginRight?: AppearanceLengthValue;
  marginBottom?: AppearanceLengthValue;
  marginLeft?: AppearanceLengthValue;
  position?: AppearancePosition;
  insetBlock?: AppearanceLengthValue;
  insetInline?: AppearanceLengthValue;
  top?: AppearanceLengthValue;
  right?: AppearanceLengthValue;
  bottom?: AppearanceLengthValue;
  left?: AppearanceLengthValue;
  zIndex?: AppearanceNumberValue;
  aspectRatio?: AppearanceRatioValue;
  overflow?: AppearanceOverflow;
  overflowX?: AppearanceOverflow;
  overflowY?: AppearanceOverflow;
  cursor?: AppearanceCursor;
  transition?: AppearanceTransitionItem[];
  transform?: AppearanceTransformValue;
  filter?: AppearanceFilterItem[];
  backdropBlur?: AppearanceLengthValue;
  objectFit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
  objectPosition?: 'center' | 'top' | 'right' | 'bottom' | 'left';
  mixBlendMode?: AppearanceBlendMode;
  isolation?: 'auto' | 'isolate';
}

export type AppearanceStyleProperty = keyof AppearanceStyle;

export type AppearancePropertyProfile =
  | 'paint'
  | 'control'
  | 'container'
  | 'layout'
  | 'overlay';

export type AppearanceVisualRole =
  | 'workspace'
  | 'continuous-surface'
  | 'panel'
  | 'toolbar'
  | 'card'
  | 'control'
  | 'popup'
  | 'dialog'
  | 'divider'
  | 'content'
  | 'decoration';

export type AppearanceDecorationIntent = 'flat' | 'separator' | 'framed';

export interface AppearanceGlobalTokens {
  colors?: Record<string, AppearanceColorValue>;
  lengths?: Record<string, AppearanceLengthValue>;
  numbers?: Record<string, AppearanceNumberValue>;
  durations?: Record<string, AppearanceDurationValue>;
  easings?: Record<string, AppearanceEasingValue>;
  shadows?: Record<string, AppearanceShadowValue>;
}

export interface AppearanceCondition {
  facets?: Record<string, string>;
  states?: string[];
}

export interface AppearanceConditionalStyle {
  when: AppearanceCondition;
  style: AppearanceStyle;
}

export interface AppearancePartRule {
  cascade?: 'normal' | 'override';
  materials?: string[];
  decorationIntent?: AppearanceDecorationIntent;
  base?: AppearanceStyle;
  facets?: Record<string, Record<string, AppearanceStyle>>;
  states?: Record<string, AppearanceStyle>;
  contexts?: AppearanceConditionalStyle[];
}

export interface AppearanceMaterialDefinition {
  style: AppearanceStyle;
  visualRole?: AppearanceVisualRole;
}

export interface AppearanceSurfaceDefinition {
  parts: Record<string, AppearancePartRule>;
}

export type AppearanceRendererId =
  | 'theme-tokens'
  | 'monaco'
  | 'xterm'
  | 'mermaid'
  | 'generative-widget';

export type AppearanceThemeTokenName =
  | `--openbitfun-color-${string}`
  | `--openbitfun-shadow-${string}`
  | `--openbitfun-effect-${string}`
  | `--openbitfun-opacity-${string}`
  | `--openbitfun-domain-${string}`
  | `--openbitfun-component-${string}`;

export type AppearanceThemeScopeId = 'chrome';

export interface ThemeTokenAppearanceSettings {
  tokens: Partial<Record<AppearanceThemeTokenName, string>>;
  scopes?: Partial<Record<
    AppearanceThemeScopeId,
    Partial<Record<AppearanceThemeTokenName, string>>
  >>;
}

export interface MonacoAppearanceTokenRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoAppearanceSettings {
  id: string;
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: MonacoAppearanceTokenRule[];
  colors: Record<string, string>;
}

export type XtermAppearanceSurface = 'terminal' | 'output';

export interface XtermAppearanceColors {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface XtermAppearanceSettings {
  surfaces: Record<XtermAppearanceSurface, XtermAppearanceColors>;
}

export interface MermaidAppearancePalette {
  nodeFill: string;
  nodeFillHover: string;
  nodeText: string;
  nodeStroke: string;
  nodeStrokeHover: string;
  clusterFill: string;
  clusterText: string;
  clusterStroke: string;
  edgeStroke: string;
  edgeLabelBackground: string;
  edgeLabelText: string;
  noteFill: string;
  noteText: string;
  noteStroke: string;
  activationFill: string;
  activationStroke: string;
  success: string;
  warning: string;
  error: string;
  errorBackground: string;
  info: string;
  highlight: string;
  pieColors: string[];
}

export interface MermaidAppearanceSettings {
  mode: AppearanceMode;
  palette: MermaidAppearancePalette;
}

export interface WidgetAppearanceSettings {
  id: string;
  mode: AppearanceMode;
  vars: Record<string, string>;
}

export interface AppearanceRendererSettingsMap {
  'theme-tokens': ThemeTokenAppearanceSettings;
  monaco: MonacoAppearanceSettings;
  xterm: XtermAppearanceSettings;
  mermaid: MermaidAppearanceSettings;
  'generative-widget': WidgetAppearanceSettings;
}

export type AppearanceRendererSettings = AppearanceRendererSettingsMap[AppearanceRendererId];

export type AppearanceRendererDefinitions = {
  [K in AppearanceRendererId]?: {
    version: 1;
    settings: AppearanceRendererSettingsMap[K];
  };
};

export interface AppearancePackageImageAsset {
  kind: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  source: { kind: 'package'; path: string };
}

export interface AppearancePackageVideoAsset {
  kind: 'video';
  mimeType: 'video/mp4' | 'video/webm';
  source: { kind: 'package'; path: string };
}

export type AppearancePackageAsset = AppearancePackageImageAsset | AppearancePackageVideoAsset;

export interface AppearanceBackgroundMedia {
  kind: 'video';
  assetId: string;
  posterAssetId: string;
  fit?: 'cover' | 'contain';
  position?: 'center' | 'top' | 'right' | 'bottom' | 'left';
}

export interface AppearancePackage {
  schema: typeof APPEARANCE_SCHEMA;
  schemaVersion: typeof APPEARANCE_SCHEMA_VERSION;
  id: string;
  name: string;
  author?: string;
  description?: string;
  version: string;
  mode: AppearanceMode;
  preview?: AppearanceAssetReference;
  backgroundMedia?: AppearanceBackgroundMedia;
  requiredCapabilities?: AppearanceCapability[];
  globals?: AppearanceGlobalTokens;
  materials?: Record<string, AppearanceMaterialDefinition>;
  components?: Record<string, AppearanceSurfaceDefinition>;
  scenes?: Record<string, AppearanceSurfaceDefinition>;
  renderers?: AppearanceRendererDefinitions;
  assets?: Record<string, AppearancePackageAsset>;
  integrity?: {
    sha256: Record<string, string>;
  };
}

export interface AppearancePartDescriptor {
  id: string;
  allowedProperties?: readonly AppearanceStyleProperty[];
  propertyProfile?: AppearancePropertyProfile;
  forceableProperties?: readonly AppearanceStyleProperty[];
  visualRole?: AppearanceVisualRole;
  continuityGroup?: string;
}

export interface AppearanceFacetDescriptor {
  id: string;
  attribute: `data-openbitfun-${string}`;
  values: readonly string[];
}

export interface AppearanceStateDescriptor {
  id: string;
  selector:
    | { kind: 'self'; suffix: string }
    | { kind: 'ancestorPart'; part: string; suffix: string };
}

export interface AppearanceSurfaceDescriptor {
  id: string;
  /** Current DOM surface id used when this descriptor reads a legacy persisted id. */
  hostSelectorId?: string;
  componentAttribute?: 'data-openbitfun-component' | 'data-openbitfun-product-component';
  parts: readonly AppearancePartDescriptor[];
  facets?: readonly AppearanceFacetDescriptor[];
  states?: readonly AppearanceStateDescriptor[];
}

export interface AppearanceRendererContext {
  revision: number;
  appearanceId: string;
  mode: AppearanceMode;
  globals: Readonly<Record<string, string>>;
  assets: Readonly<Record<string, ResolvedAppearanceAsset>>;
}

export interface AppearanceRendererAdapter<K extends AppearanceRendererId = AppearanceRendererId> {
  id: K;
  validate(settings: unknown): string[];
  apply(
    next: Readonly<AppearanceRendererSettingsMap[K]> | undefined,
    previous: Readonly<AppearanceRendererSettingsMap[K]> | undefined,
    context: AppearanceRendererContext,
  ): void | Promise<void>;
}

export type RegisteredAppearanceRendererAdapter = {
  [K in AppearanceRendererId]: AppearanceRendererAdapter<K>;
}[AppearanceRendererId];

export type ResolvedAppearanceStyle = Partial<Record<AppearanceStyleProperty, string>>;

export interface ResolvedAppearanceSurface {
  parts: Readonly<Record<string, readonly ResolvedAppearanceStyle[]>>;
}

export interface ResolvedAppearanceAsset {
  definition: AppearancePackageAsset;
  url?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface ResolvedAppearanceBackgroundMedia extends AppearanceBackgroundMedia {
  url?: string;
  posterUrl?: string;
}

export interface AppearanceDiagnostic {
  level: 'warning' | 'error';
  code: string;
  path: string;
  message: string;
}

export interface ResolvedAppearance {
  revision: number;
  id: string;
  name: string;
  version: string;
  mode: AppearanceMode;
  backgroundMedia?: Readonly<ResolvedAppearanceBackgroundMedia>;
  globals: Readonly<Record<string, string>>;
  materials: Readonly<Record<string, ResolvedAppearanceStyle>>;
  components: Readonly<Record<string, ResolvedAppearanceSurface>>;
  scenes: Readonly<Record<string, ResolvedAppearanceSurface>>;
  renderers: Readonly<{
    [K in AppearanceRendererId]?: Readonly<AppearanceRendererSettingsMap[K]>;
  }>;
  assets: Readonly<Record<string, ResolvedAppearanceAsset>>;
  diagnostics: readonly AppearanceDiagnostic[];
  cssText: string;
}

export interface AppearanceValidationIssue {
  path: string;
  code: string;
  message: string;
  context?: {
    surfaceKind?: 'component' | 'scene';
    surfaceId?: string;
    partId?: string;
    allowedParts?: readonly string[];
  };
}

export interface AppearanceValidationResult {
  valid: boolean;
  errors: AppearanceValidationIssue[];
  warnings: AppearanceValidationIssue[];
  value?: AppearancePackage;
}

export interface StoredAppearanceAsset {
  mimeType: AppearancePackageAsset['mimeType'];
  bytes: ArrayBuffer;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * Review provenance for a package installed from the public Appearance market.
 * Package bytes remain device-local; this small sidecar is used to discover
 * updates and to distinguish a reviewed release from a later local import.
 */
export interface AppearanceMarketOrigin {
  listingId: string;
  slug: string;
  releaseId: string;
  releaseNumber: number;
  packageId: string;
  packageVersion: string;
  packageSha256: string;
}

export interface AppearanceImportOptions {
  marketOrigin?: AppearanceMarketOrigin;
}

export interface StoredAppearancePackage {
  manifest: AppearancePackage;
  archive: ArrayBuffer;
  /** Version of the manifest serialized inside archive. Missing on pre-v2 records. */
  archiveSchemaVersion?: typeof APPEARANCE_SCHEMA_VERSION;
  assets: Record<string, StoredAppearanceAsset>;
  importedAt: string;
  marketOrigin?: AppearanceMarketOrigin;
  localOverride?: boolean;
}

export interface StoredAppearanceCatalogEntry {
  id: string;
  name: string;
  author?: string;
  description?: string;
  version: string;
  mode: AppearanceMode;
  importedAt: string;
  marketOrigin?: AppearanceMarketOrigin;
  localOverride?: boolean;
  schemaVersion?: typeof APPEARANCE_SCHEMA_VERSION;
  archiveSchemaVersion?: typeof APPEARANCE_SCHEMA_VERSION;
}

export interface AppearanceCatalogEntry {
  id: string;
  name: string;
  author?: string;
  description?: string;
  version: string;
  mode: AppearanceMode;
  source: 'builtin' | 'imported';
  importedAt?: string;
  marketOrigin?: AppearanceMarketOrigin;
  localOverride?: boolean;
}

export interface AppearanceStorage {
  listCatalog(): Promise<StoredAppearanceCatalogEntry[]>;
  get(id: string): Promise<StoredAppearancePackage | null>;
  put(value: StoredAppearancePackage): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface AppearanceServiceSnapshot {
  initialized: boolean;
  status: 'initializing' | 'ready' | 'applying' | 'degraded';
  /** Selection stored in synchronized config, even when its package is absent locally. */
  persistedSelectionId: AppearanceSelectionId | null;
  /** Persisted selection that this device cannot currently resolve or apply. */
  unavailableSelectionId?: AppearanceSelectionId;
  selectedAppearanceId: AppearanceSelectionId;
  pendingSelectionId?: AppearanceSelectionId;
  resolvedAppearanceId: string | null;
  appearances: readonly AppearanceCatalogEntry[];
  current: ResolvedAppearance | null;
  lastError?: string;
}
