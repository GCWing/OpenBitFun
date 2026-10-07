import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { WebFetchCard } from './WebFetchCard';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const openExternalMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    useTranslation: () => ({
      t: createTestI18nT('flow-chat'),
    }),
  };
});

vi.mock('@openbitfun/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  IconButton: ({
    children,
    tooltip,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: React.ReactNode }) => (
    <button
      type="button"
      aria-label={typeof tooltip === 'string' ? tooltip : undefined}
      {...props}
    >
      {children}
    </button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../infrastructure/api', () => ({
  systemAPI: {
    openExternal: openExternalMock,
  },
}));

vi.mock('@/shared/utils/textSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/utils/textSelection')>();
  return {
    ...actual,
    copyTextToClipboard: vi.fn(async () => true),
  };
});

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const config: ToolCardConfig = {
  toolName: 'WebFetch',
  displayName: 'Read Webpage',
  icon: 'WF',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  description: 'Fetch webpage content',
  displayMode: 'standard',
};

function buildCompletedToolItem(): FlowToolItem {
  return {
    id: 'tool-webfetch-1',
    type: 'tool',
    toolName: 'WebFetch',
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-webfetch-1',
      input: {
        url: 'https://example.com/article',
        format: 'text',
      },
    },
    toolResult: {
      success: true,
      result: {
        url: 'https://example.com/article',
        title: 'Example Article Title',
        format: 'text',
        content: 'Fetched body content',
        content_length: 20,
      },
    },
  };
}

describe('WebFetchCard', () => {
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
    vi.mocked(copyTextToClipboard).mockClear();

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    openExternalMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('renders a compact fetch summary and expands fetched content', () => {
    act(() => {
      root.render(
        <WebFetchCard
          toolItem={buildCompletedToolItem()}
          config={config}
        />,
      );
    });

    expect(container.textContent).toContain('Read Webpage:');
    expect(container.textContent).toContain('Example Article Title');
    expect(container.textContent).not.toContain('"https://example.com/article"');
    expect(container.textContent).not.toContain('(text, 20 chars)');
    expect(container.textContent).not.toContain('20 chars');
    expect(container.textContent).not.toContain('Fetched body content');

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    expect(card).not.toBeNull();

    act(() => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Fetched body content');
    expect(container.textContent).toContain('text');
    expect(container.textContent).toContain('20 chars');
    expect(container.querySelector('button[aria-label="Copy result"]')).not.toBeNull();

    const detailPills = Array.from(container.querySelectorAll(
      '[data-openbitfun-tool-card="web-fetch"] [data-openbitfun-part="detail"]',
    ))
      .map((node) => node.textContent?.trim());
    expect(detailPills).toEqual(expect.arrayContaining(['text', '20 chars']));
  });

  it('opens the fetched URL from the inline icon without toggling the card', () => {
    act(() => {
      root.render(
        <WebFetchCard
          toolItem={buildCompletedToolItem()}
          config={config}
        />,
      );
    });

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    act(() => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const linkRow = container.querySelector('button[aria-label="Click to open link"]');
    expect(linkRow).not.toBeNull();

    act(() => {
      linkRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/article');
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('copies fetched content from the expanded action area', async () => {
    act(() => {
      root.render(
        <WebFetchCard
          toolItem={buildCompletedToolItem()}
          config={config}
        />,
      );
    });

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="ambient"]',
    );
    act(() => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy result"]');
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith('Fetched body content');
  });
});
