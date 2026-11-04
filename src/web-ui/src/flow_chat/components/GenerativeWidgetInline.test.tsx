// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem } from '../types/flow-chat';
import type { GenerativeWidgetProjection } from '../utils/generativeWidgetProjection';

const openContentInBestTarget = vi.hoisted(() => vi.fn());
const projectGenerativeWidgetTool = vi.hoisted(() => vi.fn());
const findGenerativeWidgetProjection = vi.hoisted(() => vi.fn());

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: new Map([['session-1', { sessionId: 'session-1' }]]) }),
  },
}));

vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceId: () => 'local',
}));

vi.mock('../utils/generativeWidgetProjection', () => ({
  projectGenerativeWidgetTool,
  findGenerativeWidgetProjection,
}));

vi.mock('@/shared/services/workbenchContentService', () => ({
  openContentInBestTarget,
}));

vi.mock('@/tools/generative-widget/GenerativeWidgetPanel', () => ({
  default: ({ onExpand, origin }: {
    onExpand?: (value: { origin: unknown; app: unknown; appState?: unknown; widgetId: string }) => void;
    origin: unknown;
  }) => (
    <div data-testid="inline-panel">
      {onExpand ? <button
        type="button"
        onClick={() => onExpand?.({
          origin,
          app: { schemaVersion: 2, id: 'app-1', title: 'Inline app' },
          appState: { selected: 'one' },
          widgetId: 'widget-1',
        })}
      >Expand</button> : null}
    </div>
  ),
}));

import GenerativeWidgetInline from './GenerativeWidgetInline';

describe('GenerativeWidgetInline', () => {
  let container: HTMLDivElement;
  let root: Root;

  const item: FlowToolItem = {
    id: 'genui-inline',
    type: 'tool',
    toolName: 'GenerativeUI',
    toolCall: { id: 'genui-inline', input: {} },
    status: 'completed',
    timestamp: 1,
  };

  const projection = {
    origin: {
      type: 'tool-call',
      toolName: 'GenerativeUI',
      surfaceId: 'local',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'genui-inline',
      toolItemId: 'genui-inline',
      scope: { surfaceId: 'local', workspaceId: 'workspace-1' },
    },
    widgetId: 'widget-1',
    title: 'Inline app',
    app: { schemaVersion: 2, id: 'app-1', title: 'Inline app' },
    appState: { selected: 'one' },
    deliveryMode: 'transient',
    status: 'completed',
    isStreaming: false,
    isComplete: true,
    isFailed: false,
    sourceAvailable: true,
    readOnly: false,
  } satisfies GenerativeWidgetProjection;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    projectGenerativeWidgetTool.mockReturnValue(projection);
    openContentInBestTarget.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    projectGenerativeWidgetTool.mockReset();
    findGenerativeWidgetProjection.mockReset();
  });

  it('renders inline in FlowChat and expands through the workbench only on request', () => {
    projectGenerativeWidgetTool.mockReturnValue({ ...projection, status: 'streaming', isStreaming: true, isComplete: false });
    act(() => root.render(<GenerativeWidgetInline toolItem={item} sessionId="session-1" turnId="turn-1" />));

    expect(container.querySelector('[data-openbitfun-component="generative-widget-inline"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-component="generative-widget-inline"]')
      ?.getAttribute('data-thinking-handoff-priority')).toBe('immediate');
    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.flow-tool-card-wrapper')).toBeNull();
    expect(container.querySelector('[data-openbitfun-component="tool-card"]')).toBeNull();

    expect(openContentInBestTarget).not.toHaveBeenCalled();
  });

  it('offers workbench expansion only for an explicit Harmony delivery', () => {
    projectGenerativeWidgetTool.mockReturnValue({ ...projection, deliveryMode: 'delivery' });
    act(() => root.render(<GenerativeWidgetInline toolItem={item} sessionId="session-1" turnId="turn-1" />));
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(openContentInBestTarget).toHaveBeenCalledTimes(1);
  });

  it('removes failed candidates from the answer and lets the subsequent retry render', () => {
    projectGenerativeWidgetTool.mockReturnValue({ ...projection, isFailed: true, status: 'error' });
    act(() => root.render(<GenerativeWidgetInline toolItem={item} sessionId="session-1" turnId="turn-1" />));
    expect(container.innerHTML).toBe('');
    expect(openContentInBestTarget).not.toHaveBeenCalled();

    projectGenerativeWidgetTool.mockReturnValue({ ...projection, isFailed: false, status: 'rejected' });
    act(() => root.render(<GenerativeWidgetInline toolItem={item} sessionId="session-1" turnId="turn-1" />));
    expect(container.innerHTML).toBe('');

    projectGenerativeWidgetTool.mockReturnValue({ ...projection, isStreaming: true, isComplete: false, status: 'streaming' });
    act(() => root.render(<GenerativeWidgetInline toolItem={{ ...item, id: 'retry' }} sessionId="session-1" turnId="turn-1" />));
    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();
  });
});
