import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { SessionControlToolCard } from './SessionControlToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => [
      key,
      values?.session,
      values?.name,
    ].filter(Boolean).join('|'),
  }),
}));

vi.mock('./useToolCardHeightContract', () => ({
  useToolCardHeightContract: () => ({
    cardRootRef: { current: null },
    applyExpandedState: vi.fn(),
  }),
}));

function renameToolItem(status: FlowToolItem['status']): FlowToolItem {
  return {
    id: 'rename-session-tool',
    type: 'tool',
    toolName: 'SessionControl',
    status,
    timestamp: Date.now(),
    toolCall: {
      id: 'rename-session-call',
      input: {
        action: 'rename',
        session_id: 'worker-1',
        session_name: 'Release review',
      },
    },
    toolResult: status === 'completed' ? {
      success: true,
      result: {
        success: true,
        action: 'rename',
        session_id: 'worker-1',
        session_name: 'Release review',
      },
    } : undefined,
  };
}

describe('SessionControlToolCard', () => {
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

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('renders a completed rename instead of falling back to list', () => {
    act(() => {
      root.render(
        <SessionControlToolCard
          toolItem={renameToolItem('completed')}
          config={{} as ToolCardConfig}
        />
      );
    });

    expect(container.textContent).toContain(
      'toolCards.sessionControl.renamedSession|worker-1|Release review'
    );
    expect(container.textContent).not.toContain('toolCards.sessionControl.listedSessions');
  });

  it('renders rename progress instead of list progress', () => {
    act(() => {
      root.render(
        <SessionControlToolCard
          toolItem={renameToolItem('running')}
          config={{} as ToolCardConfig}
        />
      );
    });

    expect(container.textContent).toContain(
      'toolCards.sessionControl.renamingSession|worker-1|Release review'
    );
    expect(container.textContent).not.toContain('toolCards.sessionControl.listingSessions');
  });
});
