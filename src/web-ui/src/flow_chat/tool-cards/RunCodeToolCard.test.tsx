import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { RunCodeToolCard } from './RunCodeToolCard';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    }),
  };
});

// Prism loads asynchronously and paints nothing under jsdom; the plain fallback
// is what the assertions below read.
vi.mock('@/shared/utils/syntaxHighlighterLoader', () => ({
  getLoadedPrismSyntaxHighlighter: () => null,
  loadPrismSyntaxHighlighter: () => Promise.resolve(null),
}));

const config: ToolCardConfig = {
  toolName: 'RunCode',
  displayName: 'Run Code',
  icon: 'CODE',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  description: 'Run a program and show what it printed',
  displayMode: 'standard',
};

const PROGRAM = 'const listing = await tools.bash({ command: "ls -la" });\nconsole.log(listing.stdout);';

function runCodeItem(overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id: 'tool-run-code-1',
    type: 'tool',
    toolName: 'RunCode',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-run-code-1',
      input: {
        code: PROGRAM,
        description: 'Explore project root structure',
      },
    },
    toolResult: {
      success: true,
      result: { output: 'total 0\ndrwxr-xr-x  4 user  staff' },
    },
    ...overrides,
  };
}

describe('RunCodeToolCard', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  function render(item: FlowToolItem) {
    act(() => {
      root.render(<RunCodeToolCard toolItem={item} config={config} />);
    });
  }

  function expand() {
    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    expect(card).not.toBeNull();
    act(() => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  }

  it('summarizes the call by what the program was for', () => {
    render(runCodeItem());

    expect(container.textContent).toContain('Explore project root structure');
  });

  it('renders imported Codex programs through the same code card with failure output', () => {
    const original = runCodeItem({
      importedSource: 'codex', toolName: 'exec',
      toolCall: { id: 'codex-call', input: 'text(await tools.exec_command({cmd: "pwd"}));' },
      toolResult: { success: true, result: [{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\npermission denied' }] },
    });
    render(projectEffectiveToolItem(original));
    expand();
    expect(container.querySelector('[data-openbitfun-adapter="run-code-tool-card"]')).not.toBeNull();
    expect(container.textContent).toContain('text(await tools.exec_command');
    expect(container.textContent).toContain('permission denied');
    expect(container.querySelector('[data-openbitfun-status="error"]')).not.toBeNull();
    expect(original.toolName).toBe('exec');
  });

  it('falls back to the first real line of the program when there is no description', () => {
    render(runCodeItem({
      toolCall: {
        id: 'call-run-code-1',
        input: { code: `// gather the listing\n\n${PROGRAM}` },
      },
    }));

    expect(container.textContent).toContain('const listing = await tools.bash');
  });

  it('shows the program and its output once expanded', () => {
    render(runCodeItem());
    expand();

    expect(container.textContent).toContain('console.log(listing.stdout);');
    expect(container.textContent).toContain('drwxr-xr-x  4 user  staff');
  });

  it('reads output out of a result that only carries stdout', () => {
    render(runCodeItem({
      toolResult: { success: true, result: { stdout: 'hello from the program' } },
    }));
    expand();

    expect(container.textContent).toContain('hello from the program');
  });

  it('shows the failure instead of an empty output section', () => {
    render(runCodeItem({
      status: 'error',
      toolResult: { success: false, error: 'ReferenceError: tools is not defined' },
    }));
    expand();

    expect(container.textContent).toContain('ReferenceError: tools is not defined');
  });
});
