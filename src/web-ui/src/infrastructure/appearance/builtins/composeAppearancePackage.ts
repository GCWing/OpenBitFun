import type {
  AppearanceGlobalTokens,
  AppearanceMaterialDefinition,
  AppearancePackage,
  AppearancePartRule,
  AppearanceRendererDefinitions,
  AppearanceStyle,
  AppearanceSurfaceDefinition,
} from '../types';
import {
  DEFAULT_DARK_APPEARANCE_ID,
  DEFAULT_LIGHT_APPEARANCE_ID,
  getBuiltinAppearance,
} from './catalog';
import { withLegacyButtonTokens } from './buttonThemeCompatibility';
import { withLegacyFieldTokens } from './fieldThemeCompatibility';
import { withLegacyCaptionToken } from './captionThemeCompatibility';
import { withLegacyActionCardToken } from './actionCardThemeCompatibility';
import { withLegacyIndicatorTokens } from './indicatorThemeCompatibility';
import { withLegacyComposerTokens } from './composerThemeCompatibility';

const COMPOSITION_LAYERS = Symbol('openbitfun.appearance.composition-layers');

interface AppearanceCompositionLayers {
  base: AppearancePackage;
  override: AppearancePackage;
}

type ComposedAppearancePackage = AppearancePackage & {
  [COMPOSITION_LAYERS]?: AppearanceCompositionLayers;
};

export function getAppearanceCompositionLayers(pkg: AppearancePackage): AppearanceCompositionLayers | undefined {
  return (pkg as ComposedAppearancePackage)[COMPOSITION_LAYERS];
}

function mergeStyle(base: AppearanceStyle | undefined, override: AppearanceStyle | undefined): AppearanceStyle {
  return { ...(base ?? {}), ...(override ?? {}) };
}

function mergeNestedStyles(
  base: Record<string, Record<string, AppearanceStyle>> | undefined,
  override: Record<string, Record<string, AppearanceStyle>> | undefined,
): Record<string, Record<string, AppearanceStyle>> | undefined {
  if (!base && !override) return undefined;
  const result: Record<string, Record<string, AppearanceStyle>> = {};
  new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})]).forEach(group => {
    const baseGroup = base?.[group];
    const overrideGroup = override?.[group];
    result[group] = {};
    new Set([...Object.keys(baseGroup ?? {}), ...Object.keys(overrideGroup ?? {})]).forEach(key => {
      result[group][key] = mergeStyle(baseGroup?.[key], overrideGroup?.[key]);
    });
  });
  return result;
}

function mergeStateStyles(
  base: Record<string, AppearanceStyle> | undefined,
  override: Record<string, AppearanceStyle> | undefined,
): Record<string, AppearanceStyle> | undefined {
  if (!base && !override) return undefined;
  const result: Record<string, AppearanceStyle> = {};
  new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})]).forEach(key => {
    result[key] = mergeStyle(base?.[key], override?.[key]);
  });
  return result;
}

function mergePartRule(base: AppearancePartRule | undefined, override: AppearancePartRule | undefined): AppearancePartRule {
  return {
    ...(base?.cascade || override?.cascade ? { cascade: override?.cascade ?? base?.cascade } : {}),
    ...(base?.materials || override?.materials ? { materials: override?.materials ?? base?.materials } : {}),
    ...(base?.decorationIntent || override?.decorationIntent
      ? { decorationIntent: override?.decorationIntent ?? base?.decorationIntent }
      : {}),
    ...((base?.base || override?.base) ? { base: mergeStyle(base?.base, override?.base) } : {}),
    ...(mergeNestedStyles(base?.facets, override?.facets) ? { facets: mergeNestedStyles(base?.facets, override?.facets) } : {}),
    ...(mergeStateStyles(base?.states, override?.states) ? { states: mergeStateStyles(base?.states, override?.states) } : {}),
    ...((base?.contexts || override?.contexts) ? { contexts: [...(base?.contexts ?? []), ...(override?.contexts ?? [])] } : {}),
  };
}

function mergeSurface(
  base: AppearanceSurfaceDefinition | undefined,
  override: AppearanceSurfaceDefinition | undefined,
): AppearanceSurfaceDefinition {
  const parts: AppearanceSurfaceDefinition['parts'] = {};
  new Set([...Object.keys(base?.parts ?? {}), ...Object.keys(override?.parts ?? {})]).forEach(partId => {
    parts[partId] = mergePartRule(base?.parts[partId], override?.parts[partId]);
  });
  return { parts };
}

function mergeSurfaces(
  base: Record<string, AppearanceSurfaceDefinition> | undefined,
  override: Record<string, AppearanceSurfaceDefinition> | undefined,
): Record<string, AppearanceSurfaceDefinition> {
  const result: Record<string, AppearanceSurfaceDefinition> = {};
  new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})]).forEach(surfaceId => {
    result[surfaceId] = mergeSurface(base?.[surfaceId], override?.[surfaceId]);
  });
  return result;
}

function mergeGlobals(base: AppearanceGlobalTokens | undefined, override: AppearanceGlobalTokens | undefined): AppearanceGlobalTokens {
  return {
    colors: { ...(base?.colors ?? {}), ...(override?.colors ?? {}) },
    lengths: { ...(base?.lengths ?? {}), ...(override?.lengths ?? {}) },
    numbers: { ...(base?.numbers ?? {}), ...(override?.numbers ?? {}) },
    durations: { ...(base?.durations ?? {}), ...(override?.durations ?? {}) },
    easings: { ...(base?.easings ?? {}), ...(override?.easings ?? {}) },
    shadows: { ...(base?.shadows ?? {}), ...(override?.shadows ?? {}) },
  };
}

function mergeRenderers(
  base: AppearanceRendererDefinitions | undefined,
  override: AppearanceRendererDefinitions | undefined,
): AppearanceRendererDefinitions {
  return {
    'theme-tokens': override?.['theme-tokens'] ? {
      version: 1,
      settings: {
        ...base?.['theme-tokens']?.settings,
        ...override['theme-tokens'].settings,
        tokens: {
          ...(base?.['theme-tokens']?.settings.tokens ?? {}),
          ...withLegacyComposerTokens(withLegacyIndicatorTokens(withLegacyActionCardToken(withLegacyCaptionToken(withLegacyFieldTokens(withLegacyButtonTokens(override['theme-tokens'].settings.tokens)))))),
        },
        scopes: {
          chrome: {
            ...(base?.['theme-tokens']?.settings.scopes?.chrome ?? {}),
            ...withLegacyComposerTokens(withLegacyIndicatorTokens(withLegacyActionCardToken(withLegacyCaptionToken(withLegacyFieldTokens(withLegacyButtonTokens(override['theme-tokens'].settings.scopes?.chrome)))))),
          },
        },
      },
    } : base?.['theme-tokens'],
    monaco: override?.monaco ? {
      version: 1,
      settings: {
        ...base?.monaco?.settings,
        ...override.monaco.settings,
        colors: { ...(base?.monaco?.settings.colors ?? {}), ...override.monaco.settings.colors },
      },
    } : base?.monaco,
    xterm: override?.xterm ? {
      version: 1,
      settings: {
        ...base?.xterm?.settings,
        ...override.xterm.settings,
        surfaces: {
          terminal: {
            ...(base?.xterm?.settings.surfaces.terminal ?? {}),
            ...override.xterm.settings.surfaces.terminal,
          },
          output: {
            ...(base?.xterm?.settings.surfaces.output ?? {}),
            ...override.xterm.settings.surfaces.output,
          },
        },
      },
    } : base?.xterm,
    mermaid: override?.mermaid ? {
      version: 1,
      settings: {
        ...base?.mermaid?.settings,
        ...override.mermaid.settings,
        palette: { ...(base?.mermaid?.settings.palette ?? {}), ...override.mermaid.settings.palette },
      },
    } : base?.mermaid,
    'generative-widget': override?.['generative-widget'] ? {
      version: 1,
      settings: {
        ...base?.['generative-widget']?.settings,
        ...override['generative-widget'].settings,
        vars: {
          ...(base?.['generative-widget']?.settings.vars ?? {}),
          ...override['generative-widget'].settings.vars,
        },
      },
    } : base?.['generative-widget'],
  };
}

export function composeAppearancePackage(pkg: AppearancePackage): AppearancePackage {
  const registered = getBuiltinAppearance(pkg.id);
  if (registered === pkg) return pkg;
  const baseId = pkg.mode === 'dark' ? DEFAULT_DARK_APPEARANCE_ID : DEFAULT_LIGHT_APPEARANCE_ID;
  const base = getBuiltinAppearance(baseId);
  if (!base) throw new Error(`Base appearance is unavailable: ${baseId}`);

  const requiredCapabilities = [...new Set([
    ...(base.requiredCapabilities ?? []),
    ...(pkg.requiredCapabilities ?? []),
  ])];
  const materials: Record<string, AppearanceMaterialDefinition> = {};
  new Set([...Object.keys(base.materials ?? {}), ...Object.keys(pkg.materials ?? {})]).forEach(id => {
    const baseMaterial = base.materials?.[id];
    const overrideMaterial = pkg.materials?.[id];
    materials[id] = {
      style: mergeStyle(baseMaterial?.style, overrideMaterial?.style),
      ...(overrideMaterial?.visualRole ?? baseMaterial?.visualRole
        ? { visualRole: overrideMaterial?.visualRole ?? baseMaterial?.visualRole }
        : {}),
    };
  });

  const composed: ComposedAppearancePackage = {
    ...base,
    ...pkg,
    requiredCapabilities,
    globals: mergeGlobals(base.globals, pkg.globals),
    materials,
    components: mergeSurfaces(base.components, pkg.components),
    scenes: mergeSurfaces(base.scenes, pkg.scenes),
    renderers: mergeRenderers(base.renderers, pkg.renderers),
    assets: { ...(base.assets ?? {}), ...(pkg.assets ?? {}) },
    ...(pkg.integrity ? { integrity: pkg.integrity } : { integrity: undefined }),
  };
  Object.defineProperty(composed, COMPOSITION_LAYERS, {
    value: { base, override: pkg },
    enumerable: false,
  });
  return composed;
}
