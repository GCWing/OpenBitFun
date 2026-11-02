// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowToolItem } from '../types/flow-chat';
import { getToolItemCardConfig } from './toolCardMetadata';
import { GenerateImageToolCard } from './GenerateImageToolCard';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function item(overrides: Partial<FlowToolItem> = {}): FlowToolItem {
  return {
    id: 'generate-image',
    type: 'tool',
    toolName: 'generate_image',
    status: 'completed',
    timestamp: 1,
    toolCall: { id: 'generate-image', input: { prompt: 'A red kite over the sea' } },
    toolResult: {
      success: true,
      result: { path: '/workspace/generated.png', count: 1, model: 'gpt-image-1' },
      imageAttachments: [{ mime_type: 'image/png', data_base64: image }],
    },
    ...overrides,
  };
}

describe('GenerateImageToolCard', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(toolItem: FlowToolItem = item()) {
    act(() => root.render(
      <GenerateImageToolCard toolItem={toolItem} config={getToolItemCardConfig(toolItem)} />,
    ));
  }

  it('keeps the image and metadata inside one collapsed card by default', () => {
    render();

    expect(host.querySelector('[data-openbitfun-expandable="true"]')).not.toBeNull();
    expect(host.querySelector('[data-openbitfun-expanded-shell="false"]')).not.toBeNull();
    expect(host.querySelector('[data-openbitfun-part="media"] img')).toBeNull();
  });

  it('reveals the image while keeping metadata folded when expanded', () => {
    render();

    const surface = host.querySelector<HTMLElement>('[data-openbitfun-part="surface"]');
    expect(surface).not.toBeNull();
    act(() => surface?.click());

    const imageElement = host.querySelector<HTMLImageElement>('[data-openbitfun-part="media"] img');
    expect(imageElement?.src).toBe(`data:image/png;base64,${image}`);
    expect(host.querySelector('[data-openbitfun-expanded-shell="true"]')).not.toBeNull();
    const details = host.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]');
    expect(details?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps failures visible while preserving the image card anatomy', () => {
    render(item({
      status: 'error',
      toolResult: { success: false, error: 'Image service unavailable', result: null },
    }));

    act(() => host.querySelector<HTMLElement>('[data-openbitfun-part="surface"]')?.click());
    expect(host.querySelector('[data-openbitfun-part="error"]')?.textContent).toContain('Image service unavailable');
    expect(host.querySelector('[data-openbitfun-part="surface"]')).not.toBeNull();
  });
});
