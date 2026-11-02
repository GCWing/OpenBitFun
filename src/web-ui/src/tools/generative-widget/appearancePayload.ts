import {
  cssVariables as systemCssVariables,
  tokens as systemTokens,
  type TokenName as SystemTokenName,
} from '@openbitfun/design-tokens';

import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import { WIDGET_APPEARANCE_VARIABLE_NAMES } from '@/infrastructure/appearance/adapters/widgetAppearanceVariables';
import { getBuiltinAppearanceThemeTokens } from '@/infrastructure/appearance/builtins/catalog';

export type WidgetAppearancePayload = {
  id: string;
  mode: string;
  vars: Record<string, string>;
};

const builtinThemeTokens = getBuiltinAppearanceThemeTokens();

function requireBuiltinThemeToken(name: string): string {
  const value = builtinThemeTokens[name as keyof typeof builtinThemeTokens];
  if (typeof value !== 'string') {
    throw new Error(`Default Appearance does not define widget theme token ${name}`);
  }
  return value;
}

export const WIDGET_APPEARANCE_FALLBACK_VARS = Object.freeze(Object.fromEntries(
  WIDGET_APPEARANCE_VARIABLE_NAMES.map(name => [
    name,
    name === '--openbitfun-color-surface-canvas' ? 'transparent' : requireBuiltinThemeToken(name),
  ]),
));

const WIDGET_SYSTEM_TOKEN_NAMES = Object.freeze(Object.keys(systemTokens) as SystemTokenName[]);
const WIDGET_SYSTEM_FALLBACK_VARS = Object.freeze(Object.fromEntries(
  WIDGET_SYSTEM_TOKEN_NAMES.map(name => [systemCssVariables[name], String(systemTokens[name])]),
));

// The host design-system root carries the complete resolved system token set
// (density, font preferences, control sizing included), so every system token
// is projected instead of staying a frozen iframe scaffold value.
export const WIDGET_SYSTEM_VARIABLE_NAMES = Object.freeze(
  WIDGET_SYSTEM_TOKEN_NAMES.map(name => systemCssVariables[name]),
);

export function createWidgetAppearanceFallbackCss(): string {
  return Object.entries({
    ...WIDGET_SYSTEM_FALLBACK_VARS,
    ...WIDGET_APPEARANCE_FALLBACK_VARS,
  })
    .map(([name, value]) => `      ${name}: ${value};`)
    .join('\n');
}

export const WIDGET_APPEARANCE_VAR_NAMES = WIDGET_APPEARANCE_VARIABLE_NAMES;

export function readWidgetAppearancePayload(): WidgetAppearancePayload | null {
  const settings = widgetAppearanceAdapter.getSettings();
  const vars: Record<string, string> = {};
  for (const name of WIDGET_APPEARANCE_VAR_NAMES) {
    const value = settings.vars[name] ?? WIDGET_APPEARANCE_FALLBACK_VARS[name];
    if (value) vars[name] = value;
  }

  const computedStyle = typeof document !== 'undefined' && typeof getComputedStyle === 'function'
    ? getComputedStyle(document.documentElement)
    : null;
  for (const name of WIDGET_SYSTEM_VARIABLE_NAMES) {
    vars[name] = computedStyle?.getPropertyValue(name).trim()
      || WIDGET_SYSTEM_FALLBACK_VARS[name];
  }

  return {
    id: settings.id,
    mode: settings.mode,
    vars,
  };
}
