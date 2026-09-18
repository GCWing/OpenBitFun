/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenBitFunCanvasPanel } from './OpenBitFunCanvasPanel';
import { canvasAppearanceAdapter } from '@/infrastructure/appearance/adapters/CanvasAppearanceAdapter';

const canvasApiMock = vi.hoisted(() => ({
  loadArtifact: vi.fn(() => Promise.resolve({ canvas: null })),
  loadState: vi.fn(() => Promise.resolve({ state: null })),
  saveState: vi.fn(() => Promise.resolve({ state: null })),
  reportRuntimeError: vi.fn(() => Promise.resolve({ canvas: null })),
  reportRuntimeReady: vi.fn(() => Promise.resolve({ canvas: null })),
}));

const systemApiMock = vi.hoisted(() => ({
  setClipboard: vi.fn(() => Promise.resolve()),
}));

const flowChatStoreMock = vi.hoisted(() => ({
  getActiveSession: vi.fn(() => ({ workspacePath: '/repo' })),
  getState: vi.fn(() => ({
    sessions: new Map([
      ['session_1', { id: 'session_1', mode: 'Standard', workspacePath: '/repo' }],
    ]),
  })),
  switchSession: vi.fn(),
}));

const sendMessageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/infrastructure/api/service-api/CanvasAPI', () => ({
  canvasAPI: canvasApiMock,
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: systemApiMock,
}));

vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: flowChatStoreMock,
}));

vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      sendMessage: sendMessageMock,
    }),
  },
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { emit: vi.fn() },
}));

vi.mock('@/shared/services/workbenchContentService', () => ({
  captureContentScope: (input: { workspaceId: string }) => ({ surfaceId: 'local', ...input }),
}));

vi.mock('@/shared/services/FileTabManager', () => ({
  fileTabManager: {
    openFile: vi.fn(),
    openFileAndJump: vi.fn(),
  },
}));

vi.mock('@/tools/generative-widget/appearancePayload', () => ({
  readWidgetAppearancePayload: vi.fn(() => null),
}));

vi.mock('@/tools/editor/components/CodeEditor', () => ({
  default: () => null,
}));

describe('OpenBitFunCanvasPanel message boundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    canvasAppearanceAdapter.apply(
      {
        id: 'test.canvas',
        mode: 'dark',
        bg: '#111111',
        panel: '#222222',
        fg: '#eeeeee',
        muted: '#aaaaaa',
        border: '#444444',
        accent: '#6699ff',
        success: '#33aa77',
        warning: '#ddaa33',
        danger: '#dd4455',
        info: '#5599dd',
      },
      undefined,
      { revision: 1, appearanceId: 'test', mode: 'dark', globals: {}, assets: {} },
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Canvas HTML through an opaque-origin srcdoc iframe', async () => {
    await act(async () => {
      root.render(
        <OpenBitFunCanvasPanel
          workspaceId="canvas-workspace-id"
          artifactReference="openbitfun-canvas://session/session_1/canvas/canvas_1"
          html="<!doctype html><html><body>Canvas</body></html>"
        />,
      );
    });

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toBeNull();
    expect(iframe.getAttribute('srcdoc')).toContain('Canvas');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('ignores Canvas host actions from non-iframe message sources', async () => {
    await act(async () => {
      root.render(
        <OpenBitFunCanvasPanel
          workspaceId="canvas-workspace-id"
          artifactReference="openbitfun-canvas://session/session_1/canvas/canvas_1"
          html="<!doctype html><html><body>Canvas</body></html>"
        />,
      );
    });

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'openbitfun-canvas-action',
          requestId: 'forged-action',
          action: { type: 'copyText', text: 'forged clipboard write' },
        },
        source: window,
      }));
    });

    expect(systemApiMock.setClipboard).not.toHaveBeenCalled();
    expect(canvasApiMock.saveState).not.toHaveBeenCalled();
  });

  it('reports iframe runtime errors and queues a Canvas repair turn once', async () => {
    canvasApiMock.reportRuntimeError.mockResolvedValueOnce({
      canvas: {
        artifact: { status: 'runtime_failed' },
        diagnostics: [{ code: 'canvas.runtime.error', message: 'TypeError: failed' }],
      },
    });

    await act(async () => {
      root.render(
        <OpenBitFunCanvasPanel
          workspaceId="canvas-workspace-id"
          artifactReference="openbitfun-canvas://session/session_1/canvas/canvas_1"
          html={`<!doctype html><html><body><script data-revision="rev_1">window.OpenBitFunCanvasRuntime.mount(Canvas);</script></body></html>`}
          workspacePath="/repo"
        />,
      );
    });

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    const source = iframe.contentWindow;
    expect(source).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'openbitfun-canvas-runtime-error',
          message: "undefined is not an object (evaluating 'appearance.surface.primary')",
          name: 'TypeError',
          stack: 'LayerDiagram@blob:test:1:1',
        },
        source,
      }));
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    expect(canvasApiMock.reportRuntimeError).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0][1]).toBe('session_1');
    expect(sendMessageMock.mock.calls[0][0]).toContain('Read this Canvas artifact with ReadCanvas');
    expect(sendMessageMock.mock.calls[0][0]).toContain('appearance.surface.primary');

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'openbitfun-canvas-runtime-error',
          message: "undefined is not an object (evaluating 'appearance.surface.primary')",
          name: 'TypeError',
          stack: 'LayerDiagram@blob:test:1:1',
        },
        source,
      }));
      await new Promise(resolve => window.setTimeout(resolve, 0));
    });

    expect(canvasApiMock.reportRuntimeError).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
