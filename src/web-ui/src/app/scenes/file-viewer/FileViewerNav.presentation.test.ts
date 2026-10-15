// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'sass';
import { describe, expect, it } from 'vitest';

const navSource = readFileSync(resolve(__dirname, '../workspace-resources/WorkspaceResourcePanel.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const filesPanelSource = readFileSync(
  resolve(__dirname, '../../components/panels/FilesPanel.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

function compileRules(stylesheetPath: string): CSSStyleRule[] {
  const styleElement = document.createElement('style');
  styleElement.textContent = compile(stylesheetPath).css;
  document.head.appendChild(styleElement);
  const rules = Array.from(styleElement.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule,
  );
  styleElement.remove();
  return rules;
}

const navRules = compileRules(resolve(__dirname, 'FileViewerNav.scss'));
const filesPanelRules = compileRules(
  resolve(__dirname, '../../components/panels/FilesPanel.scss'),
);
const searchResultsRules = compileRules(
  resolve(__dirname, '../../../tools/file-system/components/FileSearchResults.scss'),
);

function declarations(rules: CSSStyleRule[], selector: string): CSSStyleDeclaration {
  const matches = rules.filter((entry) => entry.selectorText === selector);
  expect(matches.length, `Missing style rule: ${selector}`).toBeGreaterThan(0);
  const merged = document.createElement('div').style;
  for (const rule of matches) {
    for (let index = 0; index < rule.style.length; index += 1) {
      const property = rule.style.item(index);
      merged.setProperty(property, rule.style.getPropertyValue(property));
    }
  }
  return merged;
}

describe('FileViewerNav surface ownership', () => {
  it('hosts the files panel inside the shared NavigationPanel shell', () => {
    expect(navSource).toContain('<NavigationPanel');
    expect(navSource).toContain('className="openbitfun-file-viewer-nav"');
    expect(navSource).toMatch(
      /<NavigationPanelContent[^>]*>[\s\S]*?<FilesPanel[\s\S]*?<\/NavigationPanelContent>/,
    );
    expect(declarations(navRules, '.openbitfun-file-viewer-nav').background).toBe('transparent');
  });

  it('lets tree and search containers inherit the navigation background', () => {
    for (const selector of [
      '.openbitfun-files-panel',
      '.openbitfun-files-panel__content',
      '.openbitfun-files-panel__explorer',
      '.openbitfun-files-panel__search-results.openbitfun-search-results',
      '.openbitfun-files-panel__search-results.openbitfun-search-results .openbitfun-search-results__header',
    ]) {
      expect(declarations(filesPanelRules, selector).background).toBe('transparent');
    }
  });

  it('keeps only the terminal section divider below the project title', () => {
    const sectionDivider = declarations(
      navRules,
      '.openbitfun-file-viewer-nav__section--terminals::before',
    );

    expect(navRules.some(rule => rule.selectorText === '.openbitfun-file-viewer-nav__section::before')).toBe(false);
    expect(sectionDivider.getPropertyValue('inset-inline')).toBe('var(--openbitfun-space-2)');
    expect(sectionDivider.height).toBe('0.5px');
    expect(sectionDivider.background).toBe('var(--openbitfun-color-border-default)');
    expect(navSource).toContain(
      'className="openbitfun-file-viewer-nav__section openbitfun-file-viewer-nav__section--terminals"',
    );
  });

  it('insets the divider above search main content at each panel width', () => {
    expect(filesPanelSource).toContain(
      "viewMode === 'search' ? ' openbitfun-files-panel__main-content--search' : ''",
    );

    const searchDivider = declarations(
      filesPanelRules,
      '.openbitfun-files-panel__main-content--search::before',
    );
    expect(searchDivider.getPropertyValue('inset-inline')).toBe('var(--openbitfun-space-2)');
    expect(searchDivider.height).toBe('1px');
    expect(searchDivider.background).toBe('var(--openbitfun-color-border-default)');

    const searchContainer = declarations(filesPanelRules, '.openbitfun-files-panel__search');
    expect(searchContainer.borderBottomWidth).toBe('');
  });

  it('uses the same divider treatment for search controls, results, and terminals', () => {
    const dividers = [
      [declarations(filesPanelRules, '.openbitfun-files-panel__main-content--search::before'), '1px'],
      [declarations(searchResultsRules, '.openbitfun-search-results__header::after'), '1px'],
      [declarations(navRules, '.openbitfun-file-viewer-nav__section--terminals::before'), '0.5px'],
    ] as const;

    for (const [divider, height] of dividers) {
      expect(divider.getPropertyValue('inset-inline')).toBe('var(--openbitfun-space-2)');
      expect(divider.height).toBe(height);
      expect(divider.background).toBe('var(--openbitfun-color-border-default)');
      expect(divider.zIndex).toBe('var(--openbitfun-layer-decoration)');
      expect(divider.pointerEvents).toBe('none');
    }
  });

  it('compensates the bottom-pinned terminal divider for fractional pixel scaling', () => {
    const terminalDivider = declarations(
      navRules,
      '.openbitfun-file-viewer-nav__section--terminals::before',
    );

    expect(terminalDivider.height).toBe('0.5px');
  });
});
