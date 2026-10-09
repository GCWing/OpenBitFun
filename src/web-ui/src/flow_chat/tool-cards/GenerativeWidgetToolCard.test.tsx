// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerativeWidgetToolCard } from './GenerativeWidgetToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import type { GenerativeWidgetFrameProps } from '@/tools/generative-widget/GenerativeWidgetFrame';
import { exportGenerativeWidgetHtml } from '@/tools/generative-widget/widgetHtmlExport';
import { notificationService } from '@/shared/notification-system';
import { createTab } from '@/shared/utils/tabUtils';

const frameState = vi.hoisted(() => ({ props: null as GenerativeWidgetFrameProps | null }));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { ...actual, useTranslation: () => ({ t: createTestI18nT('flow-chat') }) };
});
vi.mock('@/infrastructure/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/infrastructure/i18n')>();
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return { ...actual, useI18n: () => ({ t: createTestI18nT('flow-chat'), currentLanguage: 'en-US' }) };
});
vi.mock('@/tools/generative-widget/widgetHtmlExport', () => ({ exportGenerativeWidgetHtml: vi.fn() }));
vi.mock('@/tools/generative-widget/GenerativeWidgetFrame', () => ({
  default: (props: GenerativeWidgetFrameProps) => { frameState.props = props; return null; },
}));
vi.mock('@/tools/generative-widget/GenerativeWidgetStaticRenderer', () => ({ default: () => null }));
vi.mock('@/tools/generative-widget/useGenerativeWidgetPromptMenu', () => ({ useGenerativeWidgetPromptMenu: () => vi.fn() }));
vi.mock('@/tools/generative-widget/widgetInteraction', () => ({ handleWidgetBridgeEvent: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/utils/tabUtils', () => ({ createTab: vi.fn() }));
vi.mock('../utils/captureElementToDownloadsPng', () => ({ captureElementToDownloadsPng: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); frameState.props = null; });

it('shows image export after the final streamed content is applied without remounting', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const partialCode = '<p>Partial</p>';
  const finalCode = '<p>Complete</p>';
  const item: FlowToolItem = {
    id: 'streamed-widget', type: 'tool', toolName: 'GenerativeUI', timestamp: 1,
    status: 'streaming', isParamsStreaming: true, partialParams: { widget_code: partialCode },
    toolCall: { id: 'streamed-widget', input: {} },
  };
  const render = (value: FlowToolItem) => act(() => root.render(
    <GenerativeWidgetToolCard toolItem={value} config={{} as ToolCardConfig} />));
  const rendered = (widgetCode: string) => act(() => frameState.props?.onWidgetEvent?.({
    source: 'openbitfun-widget', type: 'openbitfun-widget:rendered',
    widgetId: 'streamed-widget', widgetCode,
  }));
  const exportAction = () => container.querySelector('[data-openbitfun-part="exportAction"]');
  try {
    render(item);
    const card = container.querySelector('[data-openbitfun-part="root"]');
    act(() => frameState.props?.onWidgetEvent?.({ source: 'openbitfun-widget', type: 'openbitfun-widget:ready' }));
    rendered(partialCode);
    expect(exportAction()).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="htmlExportAction"]')).toBeNull();
    render({ ...item, status: 'completed', isParamsStreaming: false,
      toolCall: { id: 'streamed-widget', input: { widget_code: finalCode } },
      toolResult: { success: true, result: { widget_code: finalCode } },
    });
    expect(exportAction()).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="htmlExportAction"]')).not.toBeNull();
    // A shell-ready event must not mark unapplied final content as ready.
    act(() => frameState.props?.onWidgetEvent?.({ source: 'openbitfun-widget', type: 'openbitfun-widget:ready' }));
    expect(exportAction()).toBeNull();
    rendered(partialCode);
    expect(exportAction()).toBeNull();
    rendered(finalCode);
    expect(exportAction()).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="root"]')).toBe(card);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('opens source details only from the dedicated button, not the header or its title', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const code = '<p>Widget content</p>';
  const item: FlowToolItem = { id: 'details-widget', type: 'tool', toolName: 'GenerativeUI', timestamp: 1,
    status: 'completed', toolCall: { id: 'details-widget', input: { widget_code: code, title: 'Chart' } },
    toolResult: { success: true },
  };
  try {
    act(() => root.render(<GenerativeWidgetToolCard toolItem={item} sessionId="session-1" config={{} as ToolCardConfig} />));
    const header = container.querySelector<HTMLElement>('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"]')!;
    expect(header.getAttribute('data-openbitfun-interactive')).toBe('false');
    expect(container.querySelector('.generative-widget-card')?.getAttribute('title')).toBeNull();
    act(() => header.click());
    act(() => container.querySelector<HTMLElement>('[data-openbitfun-part="title"]')!.click());
    expect(createTab).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('button[data-openbitfun-affordance="open-panel-right"]')!.click());
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'generative-widget', title: 'Chart',
      data: expect.objectContaining({ widgetCode: code,
        _source: expect.objectContaining({ sessionId: 'session-1', toolCallId: 'details-widget' }),
      }),
    }));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('exports completed source without preview readiness and handles cancellation, success and failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const code = '<p>Export me</p>';
  const item: FlowToolItem = { id: 'html-widget', type: 'tool', toolName: 'GenerativeUI', timestamp: 1,
    status: 'completed', toolCall: { id: 'html-widget', input: { widget_code: code, title: 'Chart' } },
    toolResult: { success: true },
  };
  const exportHtml = vi.mocked(exportGenerativeWidgetHtml);
  exportHtml.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('Write failed'));
  try {
    act(() => root.render(<GenerativeWidgetToolCard toolItem={item} config={{} as ToolCardConfig} />));
    const button = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="htmlExportAction"] button')!;
    await act(async () => button().click());
    expect(exportHtml).toHaveBeenCalledWith({
      widgetCode: code, title: 'Chart', language: 'en-US', dialogTitle: 'Export HTML',
      hostUnavailableMessage: 'This action requires OpenBitFun and is unavailable in the exported HTML.',
    });
    expect(notificationService.success).not.toHaveBeenCalled();
    expect(notificationService.error).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(notificationService.success).toHaveBeenCalledWith('HTML exported');
    await act(async () => button().click());
    expect(notificationService.error).toHaveBeenCalledWith('Failed to export HTML');
    expect(button().disabled).toBe(false);
    expect(createTab).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

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
