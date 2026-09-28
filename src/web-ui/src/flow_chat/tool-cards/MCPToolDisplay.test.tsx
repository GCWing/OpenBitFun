import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { MCPToolDisplay } from './MCPToolDisplay';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mcpMocks = vi.hoisted(() => ({
  getCachedToolInfo: vi.fn(),
  getMCPToolUiUri: vi.fn(),
  fetchMCPAppResource: vi.fn(),
  sendMCPAppMessage: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    useTranslation: () => ({
      t: createTestI18nT('flow-chat'),
    }),
  };
});
vi.mock('@/infrastructure/mcp/toolInfoCache', () => ({
  getCachedToolInfo: mcpMocks.getCachedToolInfo,
}));

vi.mock('@/infrastructure/api/service-api/MCPAPI', () => ({
  MCP_APPS_PROTOCOL_VERSION: '2026-01-26',
  MCPAPI: {
    getMCPToolUiUri: mcpMocks.getMCPToolUiUri,
    fetchMCPAppResource: mcpMocks.fetchMCPAppResource,
    sendMCPAppMessage: mcpMocks.sendMCPAppMessage,
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
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
  toolName: 'mcp__example__search',
  displayName: 'Search',
  icon: 'MCP',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  description: 'Search through an MCP server',
  displayMode: 'compact',
};

function toolItem(overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id: 'tool-mcp-1',
    type: 'tool',
    toolName: config.toolName,
    status: 'completed',
    timestamp: Date.now(),
    toolCall: {
      id: 'call-mcp-1',
      input: {
        query: 'OpenBitFun',
        limit: 5,
        _early_detection: false,
      },
    },
    toolResult: {
      success: true,
      result: {
        content: [{ type: 'text', text: 'Search result' }],
      },
    },
    ...overrides,
  };
}

describe('MCPToolDisplay', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mcpMocks.getCachedToolInfo.mockReset().mockImplementation(() => new Promise(() => {}));
    mcpMocks.getMCPToolUiUri.mockReset().mockImplementation(() => new Promise(() => {}));
    mcpMocks.fetchMCPAppResource.mockReset();
    mcpMocks.sendMCPAppMessage.mockReset();
    vi.mocked(copyTextToClipboard).mockClear();

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
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

  it('keeps invocation parameters collapsed until their nested toggle is used', () => {
    act(() => {
      root.render(<MCPToolDisplay toolItem={toolItem()} config={config} />);
    });

    expect(container.querySelector('.mcp-input-code')).toBeNull();

    act(() => {
      container.querySelector('[data-testid="mcp-tool-card-toggle"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    const input = container.querySelector('.content-item-input');
    const result = container.querySelector('.content-item-text');
    expect(input?.textContent).toContain('Input Parameters');
    expect(container.querySelector('.mcp-input-code')).toBeNull();
    expect(result?.textContent).toContain('Search result');
    expect(result?.compareDocumentPosition(input as Node) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => {
      container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(input?.textContent).toContain('"query": "OpenBitFun"');
    expect(input?.textContent).toContain('"limit": 5');
    expect(input?.textContent).not.toContain('_early_detection');
    expect(container.querySelector('[data-openbitfun-component="mcp-tool-display"]')?.getAttribute('data-openbitfun-state')).toContain('expanded');
  });

  it('can expand a completed call that has parameters but no result content', () => {
    const item = toolItem({
      toolCall: {
        id: 'call-mcp-2',
        input: '{"query":"input only"}',
      },
      toolResult: {
        success: true,
        result: { content: [] },
      },
    });

    act(() => {
      root.render(<MCPToolDisplay toolItem={item} config={config} />);
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="affordanceButton"]');
    expect(toggle).not.toBeNull();

    act(() => {
      toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.mcp-input-code')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(container.querySelector('.mcp-input-code')?.textContent).toContain('"query": "input only"');
  });

  it('copies the displayed input parameters and each text result', async () => {
    act(() => {
      root.render(<MCPToolDisplay toolItem={toolItem()} config={config} />);
    });

    act(() => {
      container.querySelector('[data-testid="mcp-tool-card-toggle"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    const resultCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy text result"]',
    );
    expect(resultCopyButton).not.toBeNull();
    expect(container.querySelector('button[aria-label="Copy input parameters"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    const inputCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy input parameters"]',
    );
    expect(inputCopyButton).not.toBeNull();

    await act(async () => {
      inputCopyButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenLastCalledWith(
      '{\n  "query": "OpenBitFun",\n  "limit": 5\n}',
    );

    await act(async () => {
      resultCopyButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(copyTextToClipboard).toHaveBeenLastCalledWith('Search result');
  });

  it('keeps failed calls collapsed until the user expands their parameters', () => {
    const item = toolItem({
      status: 'error',
      toolResult: {
        success: false,
        result: null,
        error: 'MCP server rejected the request',
      },
    });

    act(() => {
      root.render(<MCPToolDisplay toolItem={item} config={config} />);
    });

    expect(container.querySelector('.mcp-input-code')).toBeNull();
    expect(container.textContent).toContain('MCP server rejected the request');
    expect(container.querySelector('[data-openbitfun-component="mcp-tool-display"]')?.getAttribute('data-openbitfun-state')).toBe('error');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(container.querySelector('[data-openbitfun-component="mcp-tool-display"]')?.getAttribute('data-openbitfun-state')).toContain('expanded');
    expect(container.querySelector('.mcp-input-code')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(container.querySelector('.mcp-input-code')?.textContent).toContain('"query": "OpenBitFun"');
  });

  it('does not expose incomplete streaming parameters as expandable details', () => {
    const item = toolItem({
      status: 'streaming',
      isParamsStreaming: true,
      toolResult: undefined,
    });

    act(() => {
      root.render(<MCPToolDisplay toolItem={item} config={config} />);
    });

    expect(container.querySelector('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="affordanceButton"]')).toBeNull();
    expect(container.querySelector('.mcp-input-code')).toBeNull();
  });

  it('auto-expands an MCP App with input collapsed and resets input when the parent closes', async () => {
    const resourceUri = 'ui://example/search';
    mcpMocks.getCachedToolInfo.mockReset().mockResolvedValue({
      dynamic_info: {
        mcp: {
          serverId: 'example',
          toolName: 'search',
        },
      },
    });
    mcpMocks.fetchMCPAppResource.mockResolvedValue({
      contents: [{
        uri: resourceUri,
        content: '<!doctype html><html><body>MCP App</body></html>',
      }],
    });

    const item = toolItem({
      toolResult: {
        success: true,
        result: {
          content: [{
            type: 'resource',
            resource: { uri: resourceUri },
          }],
        },
      },
    });

    await act(async () => {
      root.render(<MCPToolDisplay toolItem={item} config={config} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cardRoot = container.querySelector('[data-openbitfun-component="mcp-tool-display"]');
    expect(container.querySelector('.mcp-app-iframe')).not.toBeNull();
    expect(cardRoot?.getAttribute('data-openbitfun-state')).toContain('expanded');
    expect(container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.mcp-input-code')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(cardRoot?.getAttribute('data-openbitfun-state')).toContain('expanded');
    expect(container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.mcp-input-code')).not.toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(cardRoot?.getAttribute('data-openbitfun-state') ?? '').not.toContain('expanded');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(cardRoot?.getAttribute('data-openbitfun-state')).toContain('expanded');
    expect(container.querySelector<HTMLButtonElement>('.mcp-input-disclosure button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.mcp-input-code')).toBeNull();
  });

  it('previews a result image on click without collapsing the card', () => {
    const item = toolItem({
      toolResult: {
        success: true,
        result: {
          content: [{ type: 'image', data: 'aW1n', mime_type: 'image/png' }],
        },
      },
    });

    act(() => {
      root.render(<MCPToolDisplay toolItem={item} config={config} />);
    });

    act(() => {
      container.querySelector('[data-testid="mcp-tool-card-toggle"]')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('.image-content-preview');
    expect(trigger).not.toBeNull();
    expect(container.querySelector('.image-content')?.getAttribute('data-openbitfun-part')).toBe('image');

    act(() => {
      trigger?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const overlay = dom.window.document.querySelector<HTMLElement>('.image-lightbox');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('data-openbitfun-native-webview-occlusion')).toBe('true');
    expect(overlay?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aW1n');
    expect(container.querySelector('[data-openbitfun-component="mcp-tool-display"]')?.getAttribute('data-openbitfun-state')).toContain('expanded');

    act(() => {
      dom.window.document.querySelector<HTMLButtonElement>('.image-lightbox-close')?.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });

    expect(dom.window.document.querySelector('.image-lightbox')).toBeNull();
  });
});
