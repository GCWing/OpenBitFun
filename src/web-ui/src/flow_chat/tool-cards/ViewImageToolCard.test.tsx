import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCardProps } from '../types/flow-chat';
import { ViewImageToolCard } from './ViewImageToolCard';

vi.mock('@/infrastructure/i18n', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    useI18n: () => ({ t: createTestI18nT('flow-chat') }),
  };
});

function makeProps(mimeType = 'image/png'): ToolCardProps {
  return {
    toolItem: {
      id: 'tool-image-1',
      type: 'tool',
      toolName: 'view_image',
      timestamp: 1,
      status: 'completed',
      toolCall: {
        id: 'tool-image-1',
        input: { path: 'screenshots/preview.png' },
      },
      toolResult: {
        success: true,
        result: {
          path: '/workspace/screenshots/preview.png',
          width: 899,
          height: 949,
          mime_type: 'image/png',
        },
        imageAttachments: [{
          mime_type: mimeType,
          data_base64: 'AAAA',
        }],
      },
    },
    config: {
      toolName: 'view_image',
      displayName: 'View Image',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      displayMode: 'compact',
    },
  };
}

describe('ViewImageToolCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps completed image attachments compact until requested', () => {
    const html = renderToStaticMarkup(<ViewImageToolCard {...makeProps()} />);

    expect(html).not.toContain('<img');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('preview.png');
    expect(html).not.toContain('toolCards.viewImage.viewedImages');
    expect(html).toContain('data-openbitfun-tool-card="view-image"');
    expect(html).not.toContain('data-openbitfun-part="imagePreview"');
  });

  it('preserves manual disclosure when an image arrives or updates', () => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);
    const props = makeProps();
    const render = (next: ToolCardProps) => act(() => root.render(<ViewImageToolCard {...next} />));
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    try {
      render({ ...props, toolItem: { ...props.toolItem, status: 'running', toolResult: undefined } });
      render(props);
      expect(container.querySelector('img')).toBeNull();
      act(() => toggle().click());
      const image = container.querySelector('img');
      expect(image?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      expect(image?.width).toBe(899);
      expect(image?.height).toBe(949);
      render({ ...props, toolItem: { ...props.toolItem, toolResult: { ...props.toolItem.toolResult!,
        imageAttachments: [{ mime_type: 'image/png', data_base64: 'BBBB' }] } } });
      expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
      act(() => toggle().click());
      render(props);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
    } finally {
      act(() => root.unmount());
      dom.window.close();
    }
  });

  it('does not render an unsupported attachment type', () => {
    const html = renderToStaticMarkup(<ViewImageToolCard {...makeProps('image/svg+xml')} />);

    expect(html).not.toContain('data:image/svg+xml');
    expect(html).not.toContain('<img');
  });
});
