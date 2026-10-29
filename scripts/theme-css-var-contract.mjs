import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeTokenDocuments,
  resolveTokens,
  tokenNameToCssVariable,
} from '../design-system/tooling/token-engine/src/index.mjs';

const contractDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(contractDirectory, '..');

function readDesignSystemTokenDocument(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

const designSystemTokens = resolveTokens(readDesignSystemTokenDocument(
  'design-system/packages/design-tokens/src/system.tokens.json',
));
const openbitfunThemeTokens = resolveTokens(mergeTokenDocuments(
  readDesignSystemTokenDocument('design-system/packages/theme-openbitfun/src/reference.tokens.json'),
  readDesignSystemTokenDocument('design-system/packages/theme-openbitfun/src/light.tokens.json'),
));
const publicThemePrefixes = [
  'color.',
  'component.button.',
  'component.empty.',
  'effect.',
  'opacity.',
  'shadow.',
];

export const PACKAGE_CSS_VAR_DEFINITION_CONTRACTS = Object.freeze([
  Object.freeze({
    owner: 'design-system/packages/design-tokens/src/system.tokens.json',
    packageName: '@openbitfun/design-tokens',
    variables: Object.freeze(Object.keys(designSystemTokens).map(name => tokenNameToCssVariable(name))),
  }),
  Object.freeze({
    owner: 'design-system/packages/theme-openbitfun/src/light.tokens.json',
    packageName: '@openbitfun/theme-openbitfun',
    variables: Object.freeze(
      Object.keys(openbitfunThemeTokens)
        .filter(name => publicThemePrefixes.some(prefix => name.startsWith(prefix)))
        .map(name => tokenNameToCssVariable(name)),
    ),
  }),
]);

/**
 * Resolved default-theme values used to detect raw application literals that
 * duplicate a public semantic token. This keeps the governance check tied to
 * the canonical token package after the Web UI Sass token owner is removed.
 */
export const CANONICAL_THEME_COLOR_TOKENS = Object.freeze(
  Object.entries(openbitfunThemeTokens)
    .filter(([name, token]) => (
      publicThemePrefixes.some(prefix => name.startsWith(prefix))
      && token.type === 'color'
      && typeof token.value === 'string'
    ))
    .map(([name, token]) => Object.freeze({
      cssVariable: tokenNameToCssVariable(name),
      name,
      value: token.value,
    })),
);

export const PACKAGE_CSS_VAR_IMPORT_CONTRACTS = Object.freeze([
  Object.freeze({
    specifier: '@openbitfun/design-tokens/tokens.css',
    packageNames: Object.freeze(['@openbitfun/design-tokens']),
  }),
  Object.freeze({
    specifier: '@openbitfun/theme-openbitfun/default.css',
    packageNames: Object.freeze(['@openbitfun/design-tokens', '@openbitfun/theme-openbitfun']),
  }),
  Object.freeze({
    specifier: '@openbitfun/theme-openbitfun/themes.css',
    packageNames: Object.freeze(['@openbitfun/theme-openbitfun']),
  }),
]);

export const DEFAULT_ROOT = 'src/web-ui';
export const DEFAULT_BASELINE_PATH = 'scripts/theme-color-governance-baseline.json';

export const COLOR_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.sass',
  '.scss',
  '.svg',
  '.ts',
  '.tsx',
  '.webmanifest',
]);

export const TOKEN_PATH_PARTS = [
  'OpenBitFun-Installer/src/theme',
  'design-system/packages/design-tokens/src',
  'design-system/packages/theme-openbitfun/src',
];

export const TOKEN_ALIAS_SOURCE_PATH_PARTS = [
  'design-system/packages/theme-openbitfun/src',
];

export const CONTRACT_VAR_DEFINITION_PATH_PARTS = [
  'OpenBitFun-Installer/src/theme/installerThemeRuntime.ts',
  'design-system/packages/design-tokens/src',
  'design-system/packages/theme-openbitfun/src',
  'infrastructure/appearance',
  'src/mobile-web/src/styles/global.scss',
  'tools/generative-widget/appearancePayload.ts',
];

export const STATIC_CONTRACT_VAR_DEFINITION_PATH_PARTS = [
  'design-system/packages/design-tokens/src',
  'design-system/packages/theme-openbitfun/src',
  'src/mobile-web/src/styles/global.scss',
];

export const RUNTIME_CONTRACT_VAR_DEFINITION_PATH_PARTS = [
  'OpenBitFun-Installer/src/theme/installerThemeRuntime.ts',
  'infrastructure/appearance',
];

export const EXCEPTION_PATH_PARTS = [
  'monaco',
  'terminal',
  'mermaid',
  'syntax',
  'CodeEditor',
];

export const COLOR_DOMAIN_RULES = [
  {
    key: 'assetMetadata',
    label: 'Static asset and install metadata',
    pathParts: ['assets', 'public/favicon', 'site.webmanifest', 'src/assets'],
    extensions: ['.svg', '.webmanifest'],
  },
  {
    key: 'appearanceProjection',
    label: 'Appearance projections',
    pathParts: ['infrastructure/appearance/builtins/buildBuiltinAppearance'],
  },
  {
    key: 'themePreset',
    label: 'Appearance palettes',
    pathParts: ['OpenBitFun-Installer/src/theme', 'infrastructure/appearance/builtins', 'theme/presets'],
  },
  {
    key: 'themeRuntime',
    label: 'Appearance runtime',
    pathParts: ['infrastructure/appearance/runtime', 'infrastructure/appearance/adapters'],
  },
  {
    key: 'tokenContract',
    label: 'Token contracts',
    pathParts: ['design-system/packages/design-tokens', 'design-system/packages/theme-openbitfun'],
  },
  {
    key: 'generatedWidget',
    label: 'Generated widget',
    pathParts: ['tools/generative-widget'],
  },
  {
    key: 'mermaid',
    label: 'Mermaid',
    pathParts: ['tools/mermaid-editor'],
  },
  {
    key: 'editor',
    label: 'Editor',
    pathParts: ['tools/editor', 'infrastructure/appearance/adapters/MonacoAppearanceAdapter'],
  },
  {
    key: 'syntax',
    label: 'Syntax',
    pathParts: ['shared/prism'],
  },
  {
    key: 'terminal',
    label: 'Terminal',
    pathParts: [
      'tools/terminal',
      'app/components/panels/TerminalEditModal',
    ],
  },
  {
    key: 'debugOverlay',
    label: 'Debug overlay',
    pathParts: ['shared/inspector'],
  },
  {
    key: 'appearanceDomain',
    label: 'Appearance domain tokens',
    pathParts: ['infrastructure/appearance/appearanceDomainTokens'],
  },
  {
    key: 'languageIdentity',
    label: 'Language identity',
    pathParts: ['infrastructure/language-detection'],
  },
  {
    key: 'visualEffect',
    label: 'Product identity effects',
    pathParts: ['app/components/SplashScreen'],
  },
];

export const COLOR_DOMAIN_KEYS = [
  ...COLOR_DOMAIN_RULES.map(rule => rule.key),
  'appUi',
];

export const COLOR_DOMAIN_LABELS = Object.fromEntries([
  ...COLOR_DOMAIN_RULES.map(rule => [rule.key, rule.label]),
  ['appUi', 'App UI'],
]);

export const COLOR_DOMAIN_CONTRACTS = [
  {
    key: 'assetMetadata',
    owner: 'src/web-ui/src/app/components/NavPanel/assets; src/web-ui/public/assets; src/mobile-web/src/assets; src/miniapp-market-web/public',
    reason: 'Favicons, install metadata, and self-contained vector assets cannot consume runtime CSS variables and therefore own their serialized colors at the asset boundary.',
    mergePolicy: 'Keep only identity or platform metadata colors here; any rendered application UI color must move to a canonical theme token.',
  },
  {
    key: 'appearanceProjection',
    owner: 'src/web-ui/src/infrastructure/appearance/builtins/buildBuiltinAppearance.ts',
    reason: 'The builtin Appearance projection owns renderer palettes and named product-domain defaults derived from each primitive palette.',
    mergePolicy: 'Keep values here only when a renderer or named domain role cannot be represented by the primitive palette shape; external packages remain free to override every projected role.',
  },
  {
    key: 'themePreset',
    owner: 'src/web-ui/src/infrastructure/appearance/builtins; OpenBitFun-Installer/src/theme',
    reason: 'Builtin appearances own primitive palette mapping and must keep per-appearance personality instead of being folded into shared app tokens.',
    mergePolicy: 'Only merge exact duplicate primitive values after confirming the theme still exposes distinct semantic roles.',
  },
  {
    key: 'themeRuntime',
    owner: 'src/web-ui/src/infrastructure/appearance/adapters/ThemeTokenAppearanceAdapter.ts',
    reason: 'AppearanceRuntime applies the registered canonical theme, product-domain, and component token payloads.',
    mergePolicy: 'Keep runtime payloads canonical and reject compatibility aliases or surface-local token owners.',
  },
  {
    key: 'tokenContract',
    owner: 'design-system/packages/design-tokens/src; design-system/packages/theme-openbitfun/src',
    reason: 'Independent token packages own canonical system scales and semantic theme values for every product surface.',
    mergePolicy: 'Keep token values in their canonical package and reject Web UI aliases or surface-local duplicate definitions.',
  },
  {
    key: 'generatedWidget',
    owner: 'src/web-ui/src/tools/generative-widget',
    reason: 'Generated widgets run in an isolated iframe boundary and need an explicit payload instead of scraping host CSS variables.',
    mergePolicy: 'Derive fallback values from a builtin Appearance package and keep iframe payload keys canonical.',
  },
  {
    key: 'mermaid',
    owner: 'src/web-ui/src/tools/mermaid-editor',
    reason: 'Mermaid rendering owns graph palette semantics that do not map one-to-one to app surface states.',
    mergePolicy: 'Treat as a specialized palette unless a graph role is proven to be equivalent across all Mermaid themes.',
  },
  {
    key: 'editor',
    owner: 'src/web-ui/src/tools/editor',
    reason: 'Code editor and Monaco palettes encode syntax, diff, selection, and editor chrome states beyond generic app UI.',
    mergePolicy: 'Do not merge editor states into app tokens without code-editor focused visual evidence.',
  },
  {
    key: 'syntax',
    owner: 'src/web-ui/src/infrastructure/appearance/appearanceDomainTokens.ts; src/web-ui/src/shared/prism',
    reason: 'Prism consumes named Appearance token roles for token-class contrast and readability.',
    mergePolicy: 'Keep syntax values in the Appearance package and keep Prism consumers value-free.',
  },
  {
    key: 'terminal',
    owner: 'src/web-ui/src/tools/terminal; src/web-ui/src/app/components/panels/TerminalEditModal',
    reason: 'Terminal colors include ANSI and terminal surface roles that must stay compatible with shell output semantics.',
    mergePolicy: 'Keep ANSI roles independent even when values resemble app semantic colors.',
  },
  {
    key: 'debugOverlay',
    owner: 'src/web-ui/src/shared/inspector',
    reason: 'Inspector overlays need high-visibility diagnostic marks and should not influence product token budgets.',
    mergePolicy: 'Keep diagnostic overlays isolated; merge only if the overlay no longer carries a debugging role.',
  },
  {
    key: 'appearanceDomain',
    owner: 'src/web-ui/src/infrastructure/appearance/appearanceDomainTokens.ts',
    reason: 'Named product-domain roles expose stable CSS variable references while Appearance packages own their values.',
    mergePolicy: 'Add a named role only when a visible semantic distinction is real; never place raw colors in the token reference module.',
  },
  {
    key: 'languageIdentity',
    owner: 'src/web-ui/src/infrastructure/appearance/appearanceDomainTokens.ts; src/web-ui/src/infrastructure/language-detection',
    reason: 'Language identity consumers use named Appearance tokens rather than owning fixed colors.',
    mergePolicy: 'Keep language role values package-controlled and do not hard-code colors in the language registry.',
  },
  {
    key: 'visualEffect',
    owner: 'src/web-ui/src/app/components/SplashScreen',
    reason: 'The product splash owns identity-specific decorative gradients that remain separate from interactive UI state semantics.',
    mergePolicy: 'Keep only brand identity effects here and promote any reusable interface state to a canonical semantic theme token.',
  },
];

export const TOKEN_COMPATIBILITY_ALIAS_CONTRACTS = [];

export const TOKEN_COMPATIBILITY_ALIAS_FAMILY_CONTRACTS = [];

export const FALLBACK_VAR_CONTRACTS = [];

export const SURFACE_TOKEN_RENAME_CONTRACTS = [];

export const DYNAMIC_VAR_FAMILY_CONTRACTS = [
  {
    prefix: '--openbitfun-appearance-asset-',
    owner: 'src/web-ui/src/infrastructure/appearance/compiler/AppearanceCompiler.ts; src/web-ui/src/infrastructure/appearance/runtime/AppearanceRuntime.ts',
    reason: 'Appearance package image ids are validated by the package schema, then projected to host-created blob URL variables for registered component parts.',
  },
  {
    prefix: '--openbitfun-font-size-',
    owner: 'src/web-ui/src/infrastructure/font-preference/core/FontPreferenceService.ts',
    reason: 'Font preference runtime overrides the canonical design-system font-size primitives so every semantic role follows one global scale.',
  },
  {
    prefix: '--mobile-',
    owner: 'src/apps/mobile/design-system/preview/preview.js; src/apps/mobile/design-system/preview/preview.css',
    reason: 'The native comparison preview projects the validated mobile token contract into a scoped device canvas without exposing those values as canonical web theme tokens.',
  },
];

export const REGISTERED_DYNAMIC_VAR_PREFIXES = new Set(
  DYNAMIC_VAR_FAMILY_CONTRACTS.map(contract => contract.prefix),
);
