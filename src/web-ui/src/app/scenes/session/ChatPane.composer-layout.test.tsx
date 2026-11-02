// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ChatPane from './ChatPane';

vi.mock('@/flow_chat/components/modern/ModernFlowChatContainer', () => ({
  ModernFlowChatContainer: ({ resizeSuspended = false }: { resizeSuspended?: boolean }) => (
    <div data-testid="transcript" data-resize-suspended={String(resizeSuspended)} />
  ),
}));
vi.mock('@/flow_chat/components/ChatInput', () => ({
  ChatInput: ({ layoutResizeSuspended }: { layoutResizeSuspended: boolean }) => (
    <textarea data-testid="composer" data-resize-suspended={layoutResizeSuspended} defaultValue="draft" />
  ),
}));
vi.mock('./ChatFileDropOverlay', () => ({ ChatFileDropOverlay: () => null }));
vi.mock('@/flow_chat/contexts/ConversationViewProvider', () => ({
  ConversationViewProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/shared/utils/tabUtils', () => ({ createTab: vi.fn() }));
vi.mock('@/shared/services/workbenchContentService', () => ({ openWorkbenchContent: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: {} }));
vi.mock('@/flow_chat/session-drivers/sessionFileNavigation', () => ({ sessionWorkspaceId: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('docks only the composer and forwards resize suspension without remounting the transcript or draft', () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ChatPane width={0} isFullscreen={false} showChatInput />));
    const transcript = container.querySelector('[data-testid="transcript"]')!;
    const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')!;
    const dock = container.querySelector('[data-openbitfun-part="primaryDock"]')!;
    expect(dock.contains(composer)).toBe(true);
    expect(dock.contains(transcript)).toBe(false);
    composer.value = 'unsent';
    // Both the drag itself and the settle window two frames after it: the
    // transcript stops measuring for either, the composer only for the drag.
    for (const [isDragging, resizeSuspended] of [[true, true], [false, false], [false, true]] as const) {
      act(() => root.render(<ChatPane width={0} isFullscreen={false} showChatInput
        isDragging={isDragging} resizeSuspended={resizeSuspended} />));
      expect(container.querySelector('[data-testid="transcript"]')).toBe(transcript);
      expect(container.querySelector('[data-testid="composer"]')).toBe(composer);
      expect(composer.value).toBe('unsent');
      expect(composer.dataset.resizeSuspended).toBe(String(isDragging));
      expect(transcript.dataset.resizeSuspended).toBe(String(resizeSuspended));
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
