import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

  it('renders a completed image attachment inline with stable dimensions', () => {
    const html = renderToStaticMarkup(<ViewImageToolCard {...makeProps()} />);

    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('width="899"');
    expect(html).toContain('height="949"');
    expect(html).toContain('preview.png');
    expect(html).not.toContain('toolCards.viewImage.viewedImages');
    expect(html).toContain('data-openbitfun-tool-card="view-image"');
    expect(html).toContain('data-openbitfun-part="imagePreview"');
  });

  it('does not render an unsupported attachment type', () => {
    const html = renderToStaticMarkup(<ViewImageToolCard {...makeProps('image/svg+xml')} />);

    expect(html).not.toContain('data:image/svg+xml');
    expect(html).not.toContain('<img');
  });
});
