import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { GetToolSpecCard } from './GetToolSpecCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    initReactI18next: {
      type: '3rdParty',
      init: vi.fn(),
    },
    useTranslation: () => ({
      t: createTestI18nT('flow-chat'),
    }),
  };
});

const config: ToolCardConfig = {
  toolName: 'GetToolSpec',
  displayName: 'Read Tool Spec',
  icon: 'SPEC',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  description: 'Read usage instructions and schema for a deferred tool',
  displayMode: 'compact',
};

function buildDetailItem(): FlowToolItem {
  return {
    id: 'tool-spec-1',
    type: 'tool',
    toolName: 'GetToolSpec',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-spec-1',
      input: {
        tool_name: 'Worktree',
      },
    },
    toolResult: {
      success: true,
      result: {
        tool_name: 'Worktree',
        description: 'Inspect and operate on the Git repository.',
        input_schema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
            },
          },
        },
      },
    },
  };
}

function buildAlreadyLoadedItem(): FlowToolItem {
  return {
    id: 'tool-spec-2',
    type: 'tool',
    toolName: 'GetToolSpec',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-spec-2',
      input: {
        tool_name: 'WebFetch',
      },
    },
    toolResult: {
      success: true,
      result: {
        tool_name: 'WebFetch',
        already_loaded: true,
      },
    },
  };
}

describe('GetToolSpecCard', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
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
    dom.window.close();
  });

  it('renders a compact summary without expanded detail affordance', () => {
    act(() => {
      root.render(
        <GetToolSpecCard
          toolItem={buildDetailItem()}
          config={config}
        />,
      );
    });

    expect(container.textContent).toContain('Read tool documentation');
    expect(container.textContent).toContain('Worktree');
    expect(container.textContent).not.toContain('Inspect and operate on the Git repository.');
    expect(container.textContent).not.toContain('"command"');

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-openbitfun-interactive')).toBe('false');
  });

  it('shows already-loaded summary without expanded detail affordance', () => {
    act(() => {
      root.render(
        <GetToolSpecCard
          toolItem={buildAlreadyLoadedItem()}
          config={config}
        />,
      );
    });

    expect(container.textContent).toContain('Read tool documentation: WebFetch');
    expect(container.textContent).not.toContain('already loaded');
    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    expect(card?.getAttribute('data-openbitfun-interactive')).toBe('false');
  });
});
