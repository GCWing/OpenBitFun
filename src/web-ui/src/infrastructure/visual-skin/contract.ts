import { cssVariables as systemCssVariables } from '@openbitfun/design-tokens';
import { themeCssVariables } from '@openbitfun/theme-openbitfun';

import type { VisualSkinStateName, VisualSkinTokenName } from './types';

export const VISUAL_SKIN_PART_FIELDS = Object.freeze([
  'assetId', 'fit', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
  'backgroundOpacity', 'backgroundToken', 'textShadowToken', 'foregroundToken', 'borderToken', 'shadowToken',
] as const);
export const VISUAL_SKIN_SURFACE_FIELDS = Object.freeze([
  'surface', 'baseToken', 'baseOpacity', 'backgroundSource', 'backgroundAssetId',
  'backgroundPosition', 'backgroundOpacity', 'scrimToken', 'scrimOpacity', 'fit', 'tokens', 'states',
] as const);
export const VISUAL_SKIN_BACKGROUND_POSITION = /^(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%)(?:\s+(?:center|top|bottom|left|right|[-+]?\d{1,3}(?:\.\d+)?%))?$/;
export function isVisualSkinBackgroundSize(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = value.split(' ');
  return parts.length > 0 && parts.length <= 2 && parts.every(part => {
    if (part === 'auto') return true;
    const match = /^(\d{1,4}(?:\.\d+)?)(px|%)$/.exec(part);
    return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= (match[2] === '%' ? 400 : 4096));
  });
}

export const VISUAL_SKIN_SURFACE_IDS = Object.freeze([
  'shell',
  'workbench',
  'workbench-content',
  'navigation',
  'chat',
  'editor',
  'terminal',
  'empty-state',
] as const);

/** Opaque product fallback for every paint owner, including shared underlays. */
export const VISUAL_SKIN_SURFACE_BASE_TOKENS: Readonly<Record<string, VisualSkinTokenName>> = Object.freeze({
  shell: 'color.surface.canvas',
  workbench: 'color.surface.chrome',
  'workbench-content': 'color.surface.scene',
  navigation: 'color.surface.chrome',
  chat: 'color.surface.scene',
  editor: 'color.surface.canvas',
  terminal: 'color.surface.scene',
  'empty-state': 'color.surface.scene',
});

export const VISUAL_SKIN_SLOT_IDS = Object.freeze([
  'shell-background',
  'workbench-background',
  'workbench-content-background',
  'navigation-background',
  'chat-background',
  'editor-background',
  'terminal-background',
  'empty-state',
] as const);

/**
 * The only declarations consumed by the product-owned slot stylesheet. A
 * package may carry other authoring metadata, but unknown declaration names
 * must never be presented as applied styling.
 */
export const VISUAL_SKIN_SLOT_PROPERTY_NAMES = Object.freeze([
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'foreground',
  'border',
  'shadow',
] as const);

/**
 * Common interaction states emitted by the Web UI appearance descriptors and
 * the design-system controls. Unknown state ids remain valid when they follow
 * the bounded identifier contract, but these ids get their native ARIA/HTML
 * affordances as well as the product data-state selector.
 */
export const VISUAL_SKIN_STATE_IDS = Object.freeze([
  'hover',
  'pressed',
  'focus',
  'focus-within',
  'selected',
  'disabled',
  'checked',
  'indeterminate',
  'expanded',
  'collapsed',
  'open',
  'closed',
  'active',
  'loading',
  'busy',
  'changing',
  'dragging',
  'transitioning',
  'error',
  'warning',
  'success',
  'invalid',
  'valid',
  'readonly',
  'required',
  'empty',
  'fullscreen',
  'toolbar',
  'connected',
  'disconnected',
  'local',
  'remote',
  'pending',
  'running',
  'completed',
  'failed',
] as const);

export const VISUAL_SKIN_TOKEN_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  ...themeCssVariables,
  ...Object.fromEntries(Object.entries(systemCssVariables).filter(([name]) => name.startsWith('color.') || name.startsWith('shadow.'))),
});

export function tokenVariable(name: string): string | null {
  const variable = VISUAL_SKIN_TOKEN_VARIABLES[name];
  return typeof variable === 'string' ? variable : null;
}

export function isVisualSkinSurfaceId(value: string): boolean {
  return (VISUAL_SKIN_SURFACE_IDS as readonly string[]).includes(value);
}

export function isVisualSkinSlotId(value: string): boolean {
  return (VISUAL_SKIN_SLOT_IDS as readonly string[]).includes(value);
}

export function isVisualSkinSlotPropertyName(value: string): boolean {
  return (VISUAL_SKIN_SLOT_PROPERTY_NAMES as readonly string[]).includes(value as typeof VISUAL_SKIN_SLOT_PROPERTY_NAMES[number]);
}

export function stateSelector(state: VisualSkinStateName): string {
  switch (state) {
    case 'hover':
      return ':is(:hover,[data-openbitfun-state~="hover"])';
    case 'pressed':
      return ':is(:active,[data-openbitfun-state~="pressed"])';
    case 'focus':
      return ':is(:focus-visible,[data-openbitfun-state~="focus"])';
    case 'focus-within':
      return ':is(:focus-within,[data-openbitfun-state~="focus-within"])';
    case 'selected':
      return ':is([aria-selected="true"],[aria-pressed="true"],[aria-current]:not([aria-current="false"]),[data-openbitfun-state~="selected"])';
    case 'disabled':
      return ':is(:disabled,[aria-disabled="true"],[data-disabled="true"],:has(>input[role="switch"]:disabled),[data-openbitfun-state~="disabled"])';
    case 'checked':
      return ':is(:checked,[aria-checked="true"],:has(>input[role="switch"]:checked),[data-openbitfun-state~="checked"])';
    case 'indeterminate':
      return ':is(:indeterminate,[aria-checked="mixed"],[data-openbitfun-state~="indeterminate"])';
    case 'expanded':
      return ':is([aria-expanded="true"],[data-openbitfun-state~="expanded"])';
    case 'collapsed':
      return ':is([aria-expanded="false"],[data-openbitfun-state~="collapsed"])';
    case 'open':
      return ':is([open],[data-openbitfun-state~="open"])';
    case 'closed':
      return ':is([aria-expanded="false"],[data-openbitfun-state~="closed"])';
    case 'invalid':
      return ':is(:invalid,[aria-invalid="true"],[data-invalid="true"],[data-openbitfun-state~="invalid"])';
    case 'valid':
      return ':is(:valid,[aria-invalid="false"],[data-openbitfun-state~="valid"])';
    case 'readonly':
      return ':is(input:read-only,textarea:read-only,select:read-only,[aria-readonly="true"],[data-openbitfun-state~="readonly"])';
    case 'required':
      return ':is(:required,[aria-required="true"],[data-openbitfun-state~="required"])';
    case 'busy':
      return ':is([aria-busy="true"],[data-openbitfun-state~="busy"])';
    case 'error':
      return '[data-openbitfun-state~="error"]';
    case 'warning':
      return '[data-openbitfun-state~="warning"]';
    case 'success':
      return '[data-openbitfun-state~="success"]';
    default:
      // State ids are data, never selectors. The validator constrains their
      // shape and this attribute selector keeps generated CSS deterministic.
      return `[data-openbitfun-state~="${state.replace(/[^a-z0-9_-]/gi, '')}"]`;
  }
}

export function isVisualSkinTokenName(value: string): value is VisualSkinTokenName {
  return Object.prototype.hasOwnProperty.call(VISUAL_SKIN_TOKEN_VARIABLES, value);
}
