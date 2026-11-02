import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { componentRegistry } from '@openbitfun/ui/registry';
import { compatibilityToolPresentationOwners, dedicatedToolNames, genericToolNames, productOwnedToolNames, toolPresentationRegistry, toolsForComponent } from '../src/registry';
import { execScenarios } from '../src/scenarios';
import { FlowChatComponentPreview, flowChatPreviewRegistry } from '../../../design-system/apps/design-lab/src/preview/FlowChatPreviewRegistry';
import { I18nContext } from '../../../design-system/apps/design-lab/src/i18n/I18nProvider';
import { messages } from '../../../design-system/apps/design-lab/src/i18n/messages';
import { translateFromCatalog } from '../../../design-system/apps/design-lab/src/i18n/core.mjs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function productionAdapterNames(name: string): string[] {
  const source = ts.createSourceFile('index.ts', read('../../../src/web-ui/src/flow_chat/tool-cards/index.ts'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) !== name || !declaration.initializer) continue;
      let expression = declaration.initializer;
      while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
      if (!ts.isObjectLiteralExpression(expression)) throw new Error(`Unexpected adapter declaration: ${name}`);
      return expression.properties.map((property) => property.name?.getText(source).replace(/['"]/g, '') ?? '').sort();
    }
  }
  throw new Error(`Missing production adapter registry: ${name}`);
}

it('the catalog matches production adapter owners and real public exports', () => {
  const standard = Object.entries(toolPresentationRegistry).filter(([, entry]) => entry.owner === 'standard');
  const compatibility = Object.entries(compatibilityToolPresentationOwners);
  expect(compatibility.map(([name]) => name).filter(name => dedicatedToolNames.has(name))).toEqual([]);
  expect(productionAdapterNames('STANDARD_TOOL_CARD_ADAPTERS')).toEqual([
    ...standard.map(([name]) => name),
    ...compatibility.filter(([, owner]) => owner === 'standard').map(([name]) => name),
  ].sort());
  expect(productionAdapterNames('PRODUCT_OWNED_TOOL_CARD_COMPONENTS')).toEqual([
    ...productOwnedToolNames,
    ...compatibility.filter(([, owner]) => owner === 'product').map(([name]) => name),
  ].sort());
  expect([...dedicatedToolNames].sort()).toEqual([...standard.map(([name]) => name), ...productOwnedToolNames].sort());
  const published = new Set(componentRegistry.map(({ name }) => name));
  for (const entry of Object.values(toolPresentationRegistry)) {
    if (entry.component) expect(published.has(entry.component)).toBe(true);
  }
  const labTools = flowChatPreviewRegistry.flatMap(({ definition }) => definition.specimens.map(({ tool }) => tool));
  expect(labTools.sort()).toEqual(standard.map(([name]) => name).sort());
  expect(new Set(labTools).size).toBe(labTools.length);
  expect([...new Set(execScenarios.map(({ toolName }) => toolName))].sort()).toEqual(toolsForComponent('CommandToolCard').sort());
});

it('every built-in backend tool has a current, compatibility, generic or deferred gateway presentation', () => {
  const backend = read('../../../src/crates/assembly/core/src/agentic/tools/product_runtime/materialization.rs');
  const registry = backend.match(/const PRODUCT_TOOL_REGISTRATION_ORDER:[\s\S]*?= &\[([\s\S]*?)\];/);
  expect(registry).not.toBeNull();
  const names = [...registry![1].matchAll(/"([^\"]+)"/g)].map(match => match[1]);
  expect(names.length).toBeGreaterThan(50);
  const compatibilityNames = new Set(Object.keys(compatibilityToolPresentationOwners));
  expect([...genericToolNames].filter(name => dedicatedToolNames.has(name) || compatibilityNames.has(name))).toEqual([]);
  expect(names.filter(name => !dedicatedToolNames.has(name) && !compatibilityNames.has(name)).sort())
    .toEqual([...genericToolNames, 'CallDeferredTool'].sort());
});

it('the private presentation layer has no application, store or transport dependency', () => {
  for (const path of ['exec/ExecProcessPresentation.tsx', 'exec/model.ts', 'thinking.ts', 'explore.ts', 'terminal/TerminalOutputRenderer.tsx', 'registry.ts']) {
    expect(read(`../src/${path}`)).not.toMatch(/from\s+['"](?:@\/|.*web-ui|.*tauri|zustand)/);
  }
  expect(read('../../../src/web-ui/src/flow_chat/tool-cards/ExecProcessToolCardView.tsx')).toContain('<ExecProcessPresentation');
  expect(read('../../../design-system/apps/design-lab/src/preview/FlowChatScenarios.tsx')).toContain('<ExecProcessPresentation');
  expect(read('../src/terminal/LazyTerminalOutputRenderer.tsx')).toContain("import('./TerminalOutputRenderer')");
});

describe.each(['en-US', 'zh-CN', 'zh-TW'] as const)('public component fixture coverage (%s)', (locale) => {
  it.each(toolsForComponent('ImageAnalysisToolCard'))('%s has a localized image-tool action', (tool) => {
    const key = `flowChat.builtin.tools.${tool}`;
    const label = messages[locale][key as keyof typeof messages[typeof locale]];
    expect(label).toBeTruthy();
    const html = renderToString(<I18nContext.Provider value={{ locale, setLocale: () => {}, t: (message, params) => translateFromCatalog(messages, locale, message, params) }}>
      <FlowChatComponentPreview componentName="ImageAnalysisToolCard" state="default" specimen={{ tool }} />
    </I18nContext.Provider>);
    expect(html).toContain(label);
    expect(html).not.toContain(key);
  });

  for (const { component, definition } of flowChatPreviewRegistry) {
    it.each(component.states)(`${component.name} / %s renders the actual registered component`, (state) => {
      const error = console.error;
      const spy = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
        if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) error(message, ...args);
      });
      try {
        const html = renderToString(<I18nContext.Provider value={{ locale, setLocale: () => {}, t: (key, params) => translateFromCatalog(messages, locale, key, params) }}>
          <FlowChatComponentPreview componentName={component.name} state={state} specimen={definition.specimens[0]} />
        </I18nContext.Provider>);
        expect(html).toContain('data-openbitfun-');
        expect(html).not.toContain('undefined');
        if (component.name === 'CommandToolCard' && state === 'hover') {
          expect(html).toContain('data-openbitfun-preview-state="hover"');
        }
      } finally { spy.mockRestore(); }
    });
  }
});
