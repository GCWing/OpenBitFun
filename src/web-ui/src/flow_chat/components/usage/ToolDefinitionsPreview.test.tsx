// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDefinitionsPreview } from './ToolDefinitionsPreview';
import { parseToolDefinitionsDocument } from './toolDefinitionsDocument';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  i18nService: { formatNumber: (value: number) => String(value) },
}));
vi.mock('@/infrastructure/markdown', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

const definitions = [
  { name: 'searchFiles', description: 'Search repository files.', parameters: {
    type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'Text to search for.' },
      limit: { type: 'integer', default: 5, enum: [5, 10], minimum: 1 },
    }, additionalProperties: false,
  } },
  { name: 'writeFile', description: 'Write file content.', parameters: {
    type: 'object', properties: { files: { type: 'array', items: {
      type: 'object', properties: { overwrite: { type: 'boolean', default: false } },
    } } },
  } },
];
const content = `# Calling tools\n\nUse the recorded definitions.\n\n---\n\n\`\`\`json\n${JSON.stringify(definitions, null, 2)}\n\`\`\``;

describe('tool definition documents', () => {
  it('reads the saved capture and keeps tool-calling instructions separate', () => {
    expect(parseToolDefinitionsDocument(content)).toEqual({ tools: definitions, notes: '# Calling tools\n\nUse the recorded definitions.', invalid: false });
    expect(parseToolDefinitionsDocument(JSON.stringify(definitions)).tools).toEqual(definitions);
  });

  it('supports fences containing Markdown examples inside descriptions without truncating definitions', () => {
    const tools = [{ ...definitions[0], description: 'Example: ```json\n{}\n```' }];
    expect(parseToolDefinitionsDocument(`\`\`\`\`json\n${JSON.stringify(tools)}\n\`\`\`\``).tools).toEqual(tools);
  });

  it('distinguishes empty snapshots, instructions-only captures and invalid schemas', () => {
    expect(parseToolDefinitionsDocument('[]')).toEqual({ tools: [], notes: '', invalid: false });
    expect(parseToolDefinitionsDocument('Call tools using PTC.')).toEqual({ tools: [], notes: 'Call tools using PTC.', invalid: false });
    expect(parseToolDefinitionsDocument('```json\n[{broken}]\n```')).toEqual({ tools: [], notes: '', invalid: true });
    expect(parseToolDefinitionsDocument('[{broken}]')).toEqual({ tools: [], notes: '', invalid: true });
    expect(parseToolDefinitionsDocument('```json\n[{"name":"Missing schema"}]\n```').invalid).toBe(true);
  });
});

describe('tool definitions reader', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (value = content) => act(() => root.render(<ToolDefinitionsPreview content={value} />));
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(label))!;

  it('renders typed parameter rows with descriptions, required markers and constraints using shared controls', () => {
    render();
    expect(button('searchFiles').getAttribute('aria-expanded')).toBe('true');
    expect(button('writeFile').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Text to search for.');
    expect(container.textContent).toContain('string');
    expect(container.textContent).toContain('usage.toolDefinitions.required');
    expect(container.textContent).toContain('usage.toolDefinitions.optional');
    expect(container.textContent).toContain('usage.toolDefinitions.enum');
    expect(container.textContent).toContain('usage.toolDefinitions.default');
    expect(container.querySelector('[data-openbitfun-component="field-group"]')).not.toBeNull();
    expect(container.querySelector('pre, textarea, [contenteditable="true"]')).toBeNull();
    expect(container.textContent).not.toContain('"parameters":');
    act(() => button('writeFile').click());
    act(() => button('usage.toolDefinitions.items').click());
    expect(container.textContent).toContain('overwrite');
    expect(container.textContent).toContain('boolean');
  });

  it('searches parameter names, handles no matches, and clears the filter', () => {
    render();
    const writeFile = button('writeFile');
    act(() => writeFile.click());
    const input = container.querySelector('input')!;
    const search = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    search('overwrite');
    expect(button('writeFile')).toBe(writeFile);
    expect(writeFile.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).not.toContain('searchFiles');
    expect(container.textContent).toContain('writeFile');
    search('absent-tool');
    expect(container.textContent).toContain('usage.toolDefinitions.noMatches');
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="usage.toolDefinitions.clearSearch"]')!.click());
    expect(button('searchFiles')).toBeDefined();
    expect(button('writeFile')).toBeDefined();
  });

  it('renders empty and unreadable snapshots without displaying the JSON payload', () => {
    render('[]');
    expect(container.textContent).toContain('usage.toolDefinitions.empty');
    render('```json\n[{broken}]\n```');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('usage.toolDefinitions.unavailable');
    expect(container.textContent).not.toContain('[{broken}]');
  });

  it('shows union schemas and local references without recursively following cyclic references', () => {
    render(JSON.stringify([{ name: 'recursive', description: '', parameters: {
      type: 'object', properties: { node: { $ref: '#/$defs/node' }, mode: { oneOf: [{ const: 'fast' }, { const: 'safe' }] } },
      $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
    } }]));
    expect(container.textContent).toContain('#/$defs/node');
    act(() => button('usage.toolDefinitions.oneOf').click());
    expect(container.textContent).toContain('fast');
    expect(container.textContent).toContain('safe');
    act(() => button('usage.toolDefinitions.definitions').click());
    expect(container.textContent).toContain('child');
  });
});
