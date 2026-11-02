import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { GetFileDiffDisplay } from './GetFileDiffDisplay';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
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

vi.mock('../components/InlineDiffPreview', () => ({
  InlineDiffPreview: () => <div data-testid="inline-diff-preview" />,
}));

const config: ToolCardConfig = {
  toolName: 'GetFileDiff',
  displayName: 'File Diff',
  icon: 'DIFF',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  description: 'Get file diffs',
  displayMode: 'compact',
};

describe('GetFileDiffDisplay', () => {
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

  it('shows only the file name and file-edit change summary in the completed header', () => {
    const toolItem = {
      id: 'tool-diff-1',
      type: 'tool',
      toolName: 'GetFileDiff',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-diff-1',
        input: {
          file_path: 'src/app.tsx',
        },
      },
      toolResult: {
        success: true,
        result: {
          file_path: 'src/app.tsx',
          diff_type: 'git',
          diff_content: '- old\n+ new',
          stats: {
            additions: 12,
            deletions: 0,
          },
        },
      },
    } as FlowToolItem;

    act(() => {
      root.render(<GetFileDiffDisplay toolItem={toolItem} config={config} />);
    });

    expect(container.querySelector('[data-openbitfun-part="action"]')?.textContent).toBe('Diff:');
    expect(container.querySelector('[data-openbitfun-part="path"]')?.textContent).toBe('app.tsx');
    expect(container.querySelector('[data-openbitfun-part="path"]')?.getAttribute('data-path')).toBe('src/app.tsx');
    expect(container.querySelector('[data-openbitfun-part="path"]')?.getAttribute('data-overflow-text')).toBe('src/app.tsx');
    expect(container.querySelector('[data-openbitfun-part="changeSummary"]')?.textContent).toBe('+12-0');
    expect(container.querySelector('[data-openbitfun-part="changeSummary"]')?.getAttribute('aria-label')).toBe(
      '12 additions and 0 deletions',
    );
    expect(container.querySelector('[data-openbitfun-tool-card="file-diff"]')?.getAttribute('data-diff-type')).toBe('git');
    expect(container.textContent).not.toContain('Git HEAD');
  });
});
