import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { DefaultToolCard } from './DefaultToolCard';
import { getToolCardConfig } from './toolCardMetadata';
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

const config: ToolCardConfig = {
  toolName: 'WebFetch',
  displayName: 'WebFetch',
  icon: 'W',
  requiresConfirmation: false,
  resultDisplayType: 'summary',
  description: 'Fetch web content',
  displayMode: 'compact',
};

function completedWebFetchItem(result: unknown): FlowToolItem {
  return {
    id: 'tool-webfetch-1',
    type: 'tool',
    toolName: 'WebFetch',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-webfetch-1',
      input: {
        url: 'https://example.com/large',
      },
    },
    toolResult: {
      success: true,
      result,
    },
  };
}

describe('DefaultToolCard', () => {
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

  it('keeps cancelled ControlHub details toggleable without a text icon', () => {
    const toolItem: FlowToolItem = {
      ...completedWebFetchItem(undefined),
      toolName: 'ControlHub',
      status: 'cancelled',
      toolResult: undefined,
    };

    act(() => {
      root.render(<DefaultToolCard toolItem={toolItem} config={getToolCardConfig('ControlHub')} />);
    });

    for (const [index, expanded] of [false, true, false].entries()) {
      expect(container.textContent).not.toContain('TOOL');
      const button = container.querySelector<HTMLButtonElement>(
        '[data-openbitfun-part="iconAffordanceButton"]',
      );
      expect(button).not.toBeNull();
      expect(button?.getAttribute('aria-expanded')).toBe(String(expanded));
      if (index < 2) {
        act(() => {
          button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        });
      }
    }
  });

  it('does not stringify detailed result payloads while collapsed', () => {
    const result = {
      content: 'large fetched page content',
    };
    const toJSON = vi.fn(() => result);
    Object.defineProperty(result, 'toJSON', {
      enumerable: false,
      value: toJSON,
    });

    act(() => {
      root.render(
        <DefaultToolCard
          toolItem={completedWebFetchItem(result)}
          config={config}
        />
      );
    });

    expect(container.textContent).toContain('large fetched page content');
    expect(container.textContent).not.toContain('toolCards.default.completed');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('keeps missing error payloads accessible and hidden results out of the summary', () => {
    const failed = { ...completedWebFetchItem(undefined), status: 'error' as const, toolResult: undefined };
    act(() => root.render(<DefaultToolCard toolItem={failed} config={config} />));
    expect(container.querySelector('[aria-label^="toolCards.default.failed"]')).not.toBeNull();
    act(() => root.render(<DefaultToolCard toolItem={completedWebFetchItem({ title: 'Hidden result' })}
      config={{ ...config, resultDisplayType: 'hidden' }} />));
    expect(container.textContent).not.toContain('Hidden result');
    expect(container.querySelector('[data-openbitfun-part="resultSummary"]')).toBeNull();
  });

  it('stringifies detailed result payloads after the card is expanded', () => {
    const result = {
      content: 'large fetched page content',
    };
    const toJSON = vi.fn(() => result);
    Object.defineProperty(result, 'toJSON', {
      enumerable: false,
      value: toJSON,
    });

    act(() => {
      root.render(
        <DefaultToolCard
          toolItem={completedWebFetchItem(result)}
          config={config}
        />
      );
    });

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    expect(card).not.toBeNull();

    act(() => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(toJSON).toHaveBeenCalled();
    expect(container.textContent).toContain('large fetched page content');
  });
});
