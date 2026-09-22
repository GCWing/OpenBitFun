import { themeCssVariables } from '@openbitfun/theme-openbitfun';
import { resolveHighlightColor, resolveHighlightPaintColors } from './highlightPaintColors';
import './highlightPaintColors.scss';

import {
  APPEARANCE_ROOT_TOKEN_NAMES,
  APPEARANCE_SCOPED_TOKEN_NAMES,
  APPEARANCE_THEME_SCOPE_SELECTORS,
} from '../appearanceTokenContract';
import type {
  AppearanceRendererAdapter,
  AppearanceThemeScopeId,
  AppearanceThemeTokenName,
  ThemeTokenAppearanceSettings,
} from '../types';

const ROOT_ALLOWED_TOKEN_NAMES = new Set<string>(APPEARANCE_ROOT_TOKEN_NAMES);
const SCOPED_ALLOWED_TOKEN_NAMES = new Set<string>(APPEARANCE_SCOPED_TOKEN_NAMES);
const SCOPE_STYLE_ATTRIBUTE = 'data-openbitfun-appearance-theme-scopes';
const HIGHLIGHT_STYLE_ATTRIBUTE = 'data-openbitfun-appearance-highlight-paint';
const ROOT_BACKGROUND_VARIABLE = themeCssVariables['color.surface.chrome'];
const FORBIDDEN_VALUE = /(?:url\s*\(|var\s*\(|expression\s*\(|[;{}<>])/i;
const HIGHLIGHT_COLOR_TOKENS = new Set([
  '--openbitfun-color-accent-border-subtle',
  '--openbitfun-color-selection-surface',
  '--openbitfun-color-action-secondary-pressed',
  '--openbitfun-color-content-primary',
]);

function projectHighlightToken(name: string, value: string): string {
  return HIGHLIGHT_COLOR_TOKENS.has(name) && /color-mix\(/i.test(value)
    ? resolveHighlightColor(document, value) ?? value
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSettings(value: unknown): value is ThemeTokenAppearanceSettings {
  if (!isRecord(value) || !isRecord(value.tokens)) return false;
  if (value.scopes === undefined) return true;
  if (!isRecord(value.scopes)) return false;
  return Object.entries(value.scopes).every(([scopeId, tokens]) => (
    scopeId in APPEARANCE_THEME_SCOPE_SELECTORS && isRecord(tokens)
  ));
}

function validateToken(
  name: string,
  value: unknown,
  allowedNames: ReadonlySet<string>,
  path: string,
): string | null {
  if (!allowedNames.has(name)) return `Unsupported ${path} token name: ${name}`;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return `${path} token ${name} must be a non-empty string of at most 512 characters`;
  }
  if (FORBIDDEN_VALUE.test(value)) return `${path} token ${name} contains a forbidden value`;
  return null;
}

function removeAppliedTokens(): void {
  const rootStyle = document.documentElement.style;
  APPEARANCE_ROOT_TOKEN_NAMES.forEach(name => rootStyle.removeProperty(name));
  document.querySelectorAll(`style[${HIGHLIGHT_STYLE_ATTRIBUTE}]`).forEach(node => node.remove());
  document.querySelectorAll<HTMLStyleElement>(`style[${SCOPE_STYLE_ATTRIBUTE}]`)
    .forEach(node => node.remove());
}

function renderScopeStyles(settings: Readonly<ThemeTokenAppearanceSettings>): string {
  return Object.entries(settings.scopes ?? {}).flatMap(([scopeId, tokens]) => {
    if (!tokens) return [];
    const selector = APPEARANCE_THEME_SCOPE_SELECTORS[scopeId as AppearanceThemeScopeId];
    const declarations = Object.entries(tokens)
      .map(([name, value]) => `${name}:${value === undefined ? value : projectHighlightToken(name, value)};`)
      .join('');
    return declarations ? [`${selector}{${declarations}}`] : [];
  }).join('\n');
}

export function getThemeAppearanceTokenValue(
  settings: Readonly<ThemeTokenAppearanceSettings> | undefined,
  name: AppearanceThemeTokenName,
  scope?: AppearanceThemeScopeId,
): string | undefined {
  return scope ? settings?.scopes?.[scope]?.[name] : settings?.tokens[name];
}

export const themeTokenAppearanceAdapter: AppearanceRendererAdapter<'theme-tokens'> = {
  id: 'theme-tokens',
  validate(settings) {
    if (!isSettings(settings)) return ['theme-tokens settings must contain canonical tokens'];
    const errors = Object.entries(settings.tokens)
      .map(([name, value]) => validateToken(name, value, ROOT_ALLOWED_TOKEN_NAMES, 'root'))
      .filter((error): error is string => error !== null);
    Object.entries(settings.scopes ?? {}).forEach(([scopeId, tokens]) => {
      Object.entries(tokens ?? {}).forEach(([name, value]) => {
        const error = validateToken(name, value, SCOPED_ALLOWED_TOKEN_NAMES, `scope ${scopeId}`);
        if (error) errors.push(error);
      });
    });
    return errors;
  },
  apply(next) {
    removeAppliedTokens();
    const rootStyle = document.documentElement.style;
    if (!isSettings(next)) {
      rootStyle.backgroundColor = '';
      if (document.body) document.body.style.backgroundColor = '';
      return;
    }
    Object.entries(next.tokens).forEach(([name, value]) => {
      if (value !== undefined) rootStyle.setProperty(name, projectHighlightToken(name, value));
    });
    const accent = next.tokens['--openbitfun-component-conversation-excerpt-accent'];
    if (accent) {
      const paint = resolveHighlightPaintColors(document, accent);
      // Renderer output only: old theme packages need no new setting or token.
      // Keep concrete colors out of pseudo-style color-mix evaluation on repaint.
      if (paint.background && paint.foreground) {
        const style = document.createElement('style');
        style.setAttribute(HIGHLIGHT_STYLE_ATTRIBUTE, 'true');
        style.textContent = `@media (forced-colors: none) {
          [data-flowchat-highlight-excerpt]::highlight(openbitfun-flowchat-excerpt),
          [data-flowchat-highlight-annotations]::highlight(openbitfun-flowchat-annotations) {
            background-color: ${paint.background}; color: ${paint.foreground};
          }
        }`;
        document.head.append(style);
      }
    }
    const scopeCss = renderScopeStyles(next);
    if (scopeCss) {
      const style = document.createElement('style');
      style.setAttribute(SCOPE_STYLE_ATTRIBUTE, 'true');
      style.textContent = scopeCss;
      document.head.appendChild(style);
    }
    // Native material is advertised by the local desktop window bootstrap.
    // Keep this independent of the active peer/runtime and of theme changes.
    const background = document.documentElement.getAttribute('data-openbitfun-native-material') === 'sidebar'
      ? 'transparent'
      : `var(${ROOT_BACKGROUND_VARIABLE})`;
    rootStyle.backgroundColor = background;
    if (document.body) document.body.style.backgroundColor = background;
  },
};
