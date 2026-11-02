// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { SessionControlToolCard } from './SessionControlToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
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
    applyExpandedState: (_current: boolean, next: boolean, set: (value: boolean) => void) => set(next),
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
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
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

    expect(container.querySelector('[data-openbitfun-part="target"]')?.textContent).toBe('Release review');
    expect(container.textContent).toContain('toolCards.interaction.renamed');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    act(() => container.querySelector<HTMLElement>('[data-openbitfun-part="result"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('worker-1');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Release review');
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

    expect(container.querySelector('[data-operation]')?.getAttribute('data-operation')).toBe('rename');
    expect(container.textContent).toContain('toolCards.interaction.renaming');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.textContent).not.toContain('toolCards.sessionControl.listingSessions');
  });
});
