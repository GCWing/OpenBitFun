import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { ContextCompressionDisplay } from './ContextCompressionDisplay';
import type { FlowToolItem } from '../types/flow-chat';

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

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat('en-US', options).format(value),
  },
}));

describe('ContextCompressionDisplay', () => {
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

  it('shows the recorded before and after token counts', () => {
    act(() => {
      root.render(
        <ContextCompressionDisplay
          compressionData={{
            session_id: 'session-1',
            compression_count: 3,
            has_summary: true,
            summary_source: 'model',
            tokens_before: 124_000,
            tokens_after: 31_000,
            compression_ratio: 0.25,
            trigger: 'manual',
          }}
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="action"]')?.textContent).toBe('Compress context:');
    expect(container.querySelector('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="content"]')?.textContent).toBe(
      '124,000 → 31,000 tokens',
    );
    expect(container.querySelector('[data-openbitfun-part="tokenChange"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="savings"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="meta"]')).toBeNull();
    expect(container.textContent).not.toContain('75%');
    expect(container.textContent).not.toContain('Compression #3');
  });

  it('shows a failure summary without opening error details', () => {
    const item: FlowToolItem = { id: 'compression', type: 'tool', toolName: 'ContextCompression',
      timestamp: 1, status: 'running', toolCall: { id: 'compression', input: {} } };
    act(() => root.render(<ContextCompressionDisplay toolItem={item} />));
    const failed = { ...item, status: 'error' as const, toolResult: { success: false, error: 'Provider unavailable' } };
    act(() => root.render(<ContextCompressionDisplay toolItem={failed} />));
    expect(container.textContent).not.toContain('Provider unavailable');
    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="affordanceButton"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(container.textContent).toContain('Provider unavailable');
    act(() => root.render(<ContextCompressionDisplay toolItem={{ ...failed, toolResult: { success: false, error: 'Retry failed' } }} />));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Retry failed');
  });
});
