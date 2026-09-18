import { themeCssVariables } from '@openbitfun/theme-openbitfun';

import type {
  AppearanceThemeScopeId,
  AppearanceThemeTokenName,
} from './types';

const domainTokenSuffixes = [
  'context-compression',
  'generative-ui',
  'mini-app',
  'mermaid-diagram',
  'tool-search',
  'tool-web-search',
  'tool-git',
  'tool-terminal',
  'tool-mcp',
  'tool-assistant-action',
  'tool-review-summary',
  'capability-docs',
  'capability-testing',
  'capability-creative',
  'capability-ops',
  'insights-positive',
  'insights-time',
  'insights-neutral',
  'insights-issue',
  'progress-compacting',
  'template-memories',
  'review-member-default',
  'review-worker',
  'review-judge',
  'teal-action',
  'todo',
  'git-branch',
  'git-branch-background',
  'git-branch-background-hover',
  'git-changes',
  'git-added',
  'git-deleted',
  'git-staged',
  ...Array.from({ length: 8 }, (_, index) => `git-lane-${index}` as const),
  ...Array.from({ length: 5 }, (_, index) => `text-stroke-${index}` as const),
  'inspector-active-border',
  'inspector-active-background',
  'inspector-active-border-subtle',
  'inspector-selected-border',
  'inspector-selected-background',
  'inspector-browser-tooltip-background',
  'inspector-main-tooltip-background',
  'inspector-tooltip-text',
  'inspector-tooltip-shadow',
] as const;

const languageTokenSuffixes = [
  'blue',
  'cyan',
  'yellow',
  'orange',
  'red',
  'green',
  'purple',
  'slate',
] as const;

const prismTokenSuffixes = [
  'light-foreground',
  'light-comment',
  'light-keyword',
  'light-string',
  'light-function',
  'light-number',
  'light-tag',
  'light-punctuation',
  'light-property',
  'dark-foreground',
  'dark-comment',
  'dark-keyword',
  'dark-string',
  'dark-function',
  'dark-number',
  'dark-tag',
  'dark-punctuation',
  'dark-property',
] as const;

const componentTokenSuffixes = [
  'conversation-excerpt-accent',
  'config-page-section-background',
  'config-page-section-border',
  'config-page-section-border-width',
  'config-page-section-shadow',
  'config-page-divider',
  'config-page-row-hover-background',
  'scene-viewport-border-width',
  'badge-padding-block',
] as const;

function prefix<const Values extends readonly string[]>(
  values: Values,
  tokenPrefix: string,
): AppearanceThemeTokenName[] {
  return values.map(value => `${tokenPrefix}${value}` as AppearanceThemeTokenName);
}

export const APPEARANCE_DOMAIN_TOKEN_NAMES = Object.freeze([
  ...prefix(domainTokenSuffixes, '--openbitfun-domain-'),
  ...prefix(languageTokenSuffixes, '--openbitfun-domain-language-'),
  ...prefix(prismTokenSuffixes, '--openbitfun-domain-prism-'),
]);

export const APPEARANCE_COMPONENT_TOKEN_NAMES = Object.freeze(
  [
    // Public component colors are theme-owned; product-only component tokens stay above.
    ...Object.values(themeCssVariables).filter(name => name.startsWith('--openbitfun-component-')),
    ...prefix(componentTokenSuffixes, '--openbitfun-component-'),
  ],
);

export const APPEARANCE_ROOT_THEME_TOKEN_NAMES = Object.freeze(
  Object.values(themeCssVariables) as AppearanceThemeTokenName[],
);

export const APPEARANCE_ROOT_TOKEN_NAMES = Object.freeze([...new Set([
  ...APPEARANCE_ROOT_THEME_TOKEN_NAMES,
  ...APPEARANCE_DOMAIN_TOKEN_NAMES,
  ...APPEARANCE_COMPONENT_TOKEN_NAMES,
])]);

export const APPEARANCE_SCOPED_TOKEN_NAMES = APPEARANCE_ROOT_THEME_TOKEN_NAMES;

export const APPEARANCE_THEME_SCOPE_SELECTORS: Readonly<Record<AppearanceThemeScopeId, string>> = {
  chrome: '[data-openbitfun-theme-scope="chrome"]',
};

export type AppearanceDomainTokenName = typeof APPEARANCE_DOMAIN_TOKEN_NAMES[number];
export type AppearanceComponentTokenName = typeof APPEARANCE_COMPONENT_TOKEN_NAMES[number];
