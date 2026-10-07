// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerativeWidgetToolCard } from './GenerativeWidgetToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { ...actual, useTranslation: () => ({ t: createTestI18nT('flow-chat') }) };
});
vi.mock('@/tools/generative-widget/GenerativeWidgetFrame', () => ({ default: () => null }));
vi.mock('@/tools/generative-widget/GenerativeWidgetStaticRenderer', () => ({ default: () => null }));
vi.mock('@/tools/generative-widget/useGenerativeWidgetPromptMenu', () => ({ useGenerativeWidgetPromptMenu: () => vi.fn() }));
vi.mock('@/tools/generative-widget/widgetInteraction', () => ({ handleWidgetBridgeEvent: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/utils/tabUtils', () => ({ createTab: vi.fn() }));
vi.mock('../utils/captureElementToDownloadsPng', () => ({ captureElementToDownloadsPng: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it('preserves the live preview disclosure on failure and keeps historical failures compact', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const item: FlowToolItem = { id: 'widget', type: 'tool', toolName: 'GenerativeUI', timestamp: 1,
    status: 'running', toolCall: { id: 'widget', input: {} } };
  const failed = { ...item, status: 'error' as const, toolResult: { success: false, error: 'Generation failed' } };
  const render = (value: FlowToolItem, key = 'live') => act(() => root.render(
    <GenerativeWidgetToolCard key={key} toolItem={value} config={{} as ToolCardConfig} />));
  const region = () => container.querySelector('[data-openbitfun-part="expandedCollapse"]')!;
  const toggle = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="affordanceButton"]')!;
  try {
    render(item);
    const liveRegion = region();
    expect(liveRegion.getAttribute('data-open')).toBe('true');
    render(failed);
    expect(region()).toBe(liveRegion);
    expect(region().getAttribute('data-open')).toBe('true');
    expect(container.textContent).toContain('Generation failed');
    act(() => toggle().click());
    render({ ...failed, toolResult: { success: false, error: 'Updated failure' } });
    expect(region().getAttribute('data-open')).toBe('false');
    render(failed, 'history');
    expect(region().getAttribute('data-open')).toBe('false');
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(region().getAttribute('aria-hidden')).toBe('false');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
