import { createHash } from 'node:crypto';
import {
  cssVariables as systemCssVariables,
  tokens as systemTokens,
} from '@openbitfun/design-tokens';
import { themeCssVariables } from '@openbitfun/theme-openbitfun';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { widgetAppearanceAdapter } from '@/infrastructure/appearance/adapters/WidgetAppearanceAdapter';
import {
  WIDGET_APPEARANCE_FALLBACK_VARS,
  WIDGET_APPEARANCE_VAR_NAMES,
  WIDGET_TYPOGRAPHY_VARIABLE_NAMES,
  createWidgetAppearanceFallbackCss,
  readWidgetAppearancePayload,
} from './appearancePayload';

const CANONICAL_THEME_VARIABLE_NAMES = Object.values(themeCssVariables);
const SHARED_THEME_VARIABLE_NAMES_HASH = '208ee459d220e280ec9f60089c51d353ee8e51846d1976f8c73e08f2c182b2a8';
// Button owns these state colors independently of the existing shared actions.
// Keep the original shared contract intact and enumerate this addition exactly.
const BUTTON_THEME_VARIABLE_NAMES = [
  '--openbitfun-component-button-content',
  '--openbitfun-component-button-fill-background',
  '--openbitfun-component-button-fill-background-hover',
  '--openbitfun-component-button-fill-background-pressed',
  '--openbitfun-component-button-outline-border',
  '--openbitfun-component-button-outline-border-interactive',
  '--openbitfun-component-button-primary-background',
  '--openbitfun-component-button-primary-background-hover',
  '--openbitfun-component-button-primary-background-pressed',
  '--openbitfun-component-button-primary-content-disabled',
  '--openbitfun-component-button-text-content',
  '--openbitfun-component-button-text-content-disabled',
  '--openbitfun-component-button-text-content-hover',
] as const;
// Field editing borders and hints have dedicated semantics; preserve the shared
// contract fingerprint while asserting these two additions by their exact names.
const FIELD_STATE_THEME_VARIABLE_NAMES = [
  '--openbitfun-color-field-border-active',
  '--openbitfun-color-field-placeholder',
] as const;
// Grouped forms own a translucent fill independently of opaque tertiary surfaces
// and transient subtle feedback; keep this addition outside the shared fingerprint.
const FIELD_GROUP_THEME_VARIABLE_NAME = '--openbitfun-color-field-group-background';
// Menu and navigation captions own their final contrast independently of body
// descriptions and field hints; assert this addition without changing the shared baseline.
const CAPTION_THEME_VARIABLE_NAME = '--openbitfun-color-content-caption';
// Persistent action cards own their fill independently of transient feedback
// and form groups; keep the shared contract fingerprint unchanged.
const ACTION_CARD_THEME_VARIABLE_NAME = '--openbitfun-color-action-card-background';
// Compact indicators own badge fill and key-hint contrast independently of
// shared action surfaces and muted prose; enumerate only these additions.
const INDICATOR_THEME_VARIABLE_NAMES = [
  '--openbitfun-color-key-hint-content',
  '--openbitfun-color-number-badge-background',
] as const;
// Composer and ChatComposer share editor borders and context tint independently
// of form fields and transient surfaces; enumerate these additions exactly.
const COMPOSER_THEME_VARIABLE_NAMES = [
  '--openbitfun-color-composer-border',
  '--openbitfun-color-composer-context-background',
] as const;
// Read-only diffs need distinct line, gutter, marker, word, and syntax roles.
// Generic added/removed colors cannot express those layered surfaces.
const CODE_DIFF_THEME_VARIABLE_NAMES = [
  '--openbitfun-color-code-diff-added-gutter',
  '--openbitfun-color-code-diff-added-line',
  '--openbitfun-color-code-diff-added-marker',
  '--openbitfun-color-code-diff-added-word',
  '--openbitfun-color-code-diff-foreground',
  '--openbitfun-color-code-diff-gutter-border',
  '--openbitfun-color-code-diff-line-number',
  '--openbitfun-color-code-diff-removed-gutter',
  '--openbitfun-color-code-diff-removed-line',
  '--openbitfun-color-code-diff-removed-marker',
  '--openbitfun-color-code-diff-removed-word',
  '--openbitfun-color-code-diff-syntax-comment',
  '--openbitfun-color-code-diff-syntax-declaration',
  '--openbitfun-color-code-diff-syntax-function',
  '--openbitfun-color-code-diff-syntax-keyword',
  '--openbitfun-color-code-diff-syntax-number',
  '--openbitfun-color-code-diff-syntax-operator',
  '--openbitfun-color-code-diff-syntax-property',
  '--openbitfun-color-code-diff-syntax-punctuation',
  '--openbitfun-color-code-diff-syntax-string',
  '--openbitfun-color-code-diff-syntax-variable',
] as const;
const RETIRED_WIDGET_VARIABLE_NAMES = [
  '--background-primary',
  '--bg-primary',
  '--text-primary',
  '--accent-primary',
  '--openbitfun-appearance-token-color-bg-primary',
  '--openbitfun-appearance-token-color-text-primary',
  '--openbitfun-appearance-token-color-accent-500',
  '--openbitfun-appearance-token-btn-primary-bg',
  '--openbitfun-color-accent-default-rgb',
  '--openbitfun-color-status-success-content-bg',
  '--openbitfun-color-status-success-content-border',
  '--openbitfun-color-status-warning-content-bg',
  '--openbitfun-color-status-warning-content-border',
  '--openbitfun-color-status-danger-content-bg',
  '--openbitfun-color-status-danger-content-border',
] as const;

function readPayloadWithHostValues(hostValues: Record<string, string> = {}) {
  widgetAppearanceAdapter.apply({
    id: 'test-appearance',
    mode: 'dark',
    vars: hostValues,
  }, undefined, { revision: 1, mode: 'dark', assets: {} });

  return readWidgetAppearancePayload();
}

function hashNames(names: readonly string[]): string {
  return createHash('sha256')
    .update(names.join('\n'))
    .digest('hex');
}

describe('generated widget appearance payload contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives its complete host payload allowlist from the canonical theme package', () => {
    expect(WIDGET_APPEARANCE_VAR_NAMES).toEqual(CANONICAL_THEME_VARIABLE_NAMES);
    expect(new Set(WIDGET_APPEARANCE_VAR_NAMES).size).toBe(WIDGET_APPEARANCE_VAR_NAMES.length);
    const buttonNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => name.startsWith('--openbitfun-component-button-'));
    const fieldStateNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => FIELD_STATE_THEME_VARIABLE_NAMES.some(fieldName => fieldName === name));
    const indicatorNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => INDICATOR_THEME_VARIABLE_NAMES.some(indicatorName => indicatorName === name));
    const composerNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => COMPOSER_THEME_VARIABLE_NAMES.some(composerName => composerName === name));
    const codeDiffNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => name.startsWith('--openbitfun-color-code-diff-'));
    const sharedNames = WIDGET_APPEARANCE_VAR_NAMES.filter(name => (
      !name.startsWith('--openbitfun-component-button-')
      && !FIELD_STATE_THEME_VARIABLE_NAMES.some(fieldName => fieldName === name)
      && name !== FIELD_GROUP_THEME_VARIABLE_NAME
      && name !== CAPTION_THEME_VARIABLE_NAME
      && name !== ACTION_CARD_THEME_VARIABLE_NAME
      && !INDICATOR_THEME_VARIABLE_NAMES.some(indicatorName => indicatorName === name)
      && !COMPOSER_THEME_VARIABLE_NAMES.some(composerName => composerName === name)
      && !name.startsWith('--openbitfun-color-code-diff-')
    ));
    expect(buttonNames).toEqual(BUTTON_THEME_VARIABLE_NAMES);
    expect(fieldStateNames).toEqual(FIELD_STATE_THEME_VARIABLE_NAMES);
    expect(indicatorNames).toEqual(INDICATOR_THEME_VARIABLE_NAMES);
    expect(composerNames).toEqual(COMPOSER_THEME_VARIABLE_NAMES);
    expect(codeDiffNames.sort()).toEqual(CODE_DIFF_THEME_VARIABLE_NAMES);
    expect(WIDGET_APPEARANCE_VAR_NAMES).toContain(FIELD_GROUP_THEME_VARIABLE_NAME);
    expect(WIDGET_APPEARANCE_VAR_NAMES).toContain(CAPTION_THEME_VARIABLE_NAME);
    expect(WIDGET_APPEARANCE_VAR_NAMES).toContain(ACTION_CARD_THEME_VARIABLE_NAME);
    expect({
      count: sharedNames.length,
      hash: hashNames(sharedNames),
      first: sharedNames[0],
      last: sharedNames[sharedNames.length - 1],
    }).toEqual({
      count: 128,
      hash: SHARED_THEME_VARIABLE_NAMES_HASH,
      first: '--openbitfun-color-accent-border',
      last: '--openbitfun-shadow-xs',
    });
  });

  it('uses the builtin canonical theme as the payload fallback', () => {
    const payload = readPayloadWithHostValues();

    expect(payload?.vars).toMatchObject(WIDGET_APPEARANCE_FALLBACK_VARS);
    expect(Object.keys(WIDGET_APPEARANCE_FALLBACK_VARS)).toEqual(WIDGET_APPEARANCE_VAR_NAMES);
    expect(Object.keys(payload?.vars ?? {}).sort()).toEqual([
      ...WIDGET_APPEARANCE_VAR_NAMES,
      ...WIDGET_TYPOGRAPHY_VARIABLE_NAMES,
    ].sort());
    expect(WIDGET_APPEARANCE_FALLBACK_VARS['--openbitfun-color-surface-canvas']).toBe('transparent');
  });

  it('exports canonical state and status semantics without legacy aliases', () => {
    expect(WIDGET_APPEARANCE_VAR_NAMES).toEqual(expect.arrayContaining([
      '--openbitfun-color-action-primary-background',
      '--openbitfun-color-action-primary-hover',
      '--openbitfun-color-action-primary-pressed',
      '--openbitfun-color-code-change-added',
      '--openbitfun-color-code-change-removed',
      '--openbitfun-color-status-info-emphasis',
      '--openbitfun-color-status-success-emphasis',
      '--openbitfun-color-status-warning-emphasis',
      '--openbitfun-color-status-danger-emphasis',
      '--openbitfun-color-status-success-content',
      '--openbitfun-color-status-success-surface',
      '--openbitfun-color-status-success-border',
      '--openbitfun-color-status-warning-surface',
      '--openbitfun-color-status-danger-surface',
      '--openbitfun-color-status-info-surface',
    ]));
    expect(WIDGET_APPEARANCE_VAR_NAMES).not.toEqual(
      expect.arrayContaining(RETIRED_WIDGET_VARIABLE_NAMES),
    );
    expect(WIDGET_APPEARANCE_VAR_NAMES.some(name => name.startsWith('--openbitfun-appearance-token-')))
      .toBe(false);
  });

  it('passes canonical host overrides through unchanged', () => {
    const hostValues = {
      '--openbitfun-color-action-primary-background': 'linear-gradient(test-primary)',
      '--openbitfun-color-action-primary-content': '#101010',
      '--openbitfun-color-action-primary-hover': 'linear-gradient(test-hover)',
      '--openbitfun-color-action-primary-pressed': '#202020',
      '--openbitfun-color-action-card-background': 'rgba(0, 0, 0, 0.07)',
      '--openbitfun-color-composer-border': 'rgba(0, 0, 0, 0.14)',
      '--openbitfun-color-composer-context-background': 'rgba(0, 0, 0, 0.06)',
      '--openbitfun-color-content-caption': 'rgba(0, 0, 0, 0.45)',
      '--openbitfun-component-button-primary-background': '#303030',
      '--openbitfun-component-button-fill-background': 'rgba(0, 0, 0, 0.08)',
      '--openbitfun-color-field-border-active': 'rgba(0, 0, 0, 0.20)',
      '--openbitfun-color-field-group-background': 'rgba(0, 0, 0, 0.03)',
      '--openbitfun-color-field-placeholder': 'rgba(0, 0, 0, 0.40)',
      '--openbitfun-color-key-hint-content': 'rgba(0, 0, 0, 0.55)',
      '--openbitfun-color-number-badge-background': 'rgba(0, 0, 0, 0.09)',
      '--openbitfun-color-status-danger-surface': 'rgba(200, 0, 0, 0.12)',
      '--openbitfun-color-status-danger-border': '#303030',
      '--openbitfun-shadow-raised': '0 1px 2px #404040',
    };

    expect(readPayloadWithHostValues(hostValues)?.vars).toMatchObject(hostValues);
  });

  it('renders one self-contained fallback scope from canonical theme and system tokens', () => {
    const css = createWidgetAppearanceFallbackCss();

    for (const [name, value] of Object.entries(WIDGET_APPEARANCE_FALLBACK_VARS)) {
      expect(css).toContain(`      ${name}: ${value};`);
    }
    for (const [tokenName, value] of Object.entries(systemTokens)) {
      const variableName = systemCssVariables[tokenName as keyof typeof systemCssVariables];
      expect(css).toContain(`      ${variableName}: ${String(value)};`);
    }
    for (const retiredName of RETIRED_WIDGET_VARIABLE_NAMES) {
      expect(css).not.toContain(`${retiredName}:`);
    }
  });
});
