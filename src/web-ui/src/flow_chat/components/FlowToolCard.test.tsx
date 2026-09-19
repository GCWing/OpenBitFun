// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem } from '../types/flow-chat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../tool-cards', async () => {
  const ReactModule = await import('react');
  return {
    getToolCardComponent: (toolName: string) => ({
      toolItem,
      isLastItem,
    }: {
      toolItem: FlowToolItem;
      isLastItem?: boolean;
    }) =>
      ReactModule.createElement('div', {
        'data-selected-card': toolName,
        'data-card-tool-name': toolItem.toolName,
        'data-is-last-item': String(isLastItem === true),
      }),
  };
});

vi.mock('../tool-cards/toolCardMetadata', () => ({
  getToolItemCardConfig: ({ toolName }: { toolName: string }) => ({
    toolName,
    displayName: toolName,
    icon: 'TOOL',
    requiresConfirmation: false,
    resultDisplayType: 'summary',
    description: toolName,
  }),
}));

vi.mock('./FlowToolCardErrorBoundary', () => ({
  FlowToolCardErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('./ToolApprovalBar', () => ({ ToolApprovalBar: () => null }));

const permissionContextMock = vi.hoisted(() => ({
  pendingPermissionToolCallIds: new Set<string>(),
}));

vi.mock('./modern/FlowChatContext', () => ({
  useFlowChatContext: () => ({}),
  useFlowChatVolatileContext: () => permissionContextMock,
}));

import { FlowToolCard } from './FlowToolCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('FlowToolCard deferred identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    permissionContextMock.pendingPermissionToolCallIds.clear();
  });

  it('switches to the effective card once the deferred tool name is available', () => {
    const base: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'CallDeferredTool',
      toolCall: { id: 'tool-1', input: {} },
      status: 'streaming',
      timestamp: 1,
    };

    act(() => root.render(<FlowToolCard toolItem={base} />));
    expect(container.querySelector('[data-selected-card="CallDeferredTool"]')).not.toBeNull();

    act(() => root.render(
      <FlowToolCard
        toolItem={{
          ...base,
          toolCall: {
            id: 'tool-1',
            input: {
              tool_name: 'CreatePlan',
            },
          },
        }}
      />,
    ));

    expect(container.querySelector('[data-selected-card="CreatePlan"]')).not.toBeNull();
    expect(container.querySelector('[data-card-tool-name="CreatePlan"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-name="CreatePlan"]')).not.toBeNull();
  });

  it('marks permission-pending cards for the shared warning highlight', () => {
    act(() => root.render(
      <FlowToolCard
        toolItem={{
          id: 'permission-tool',
          type: 'tool',
          toolName: 'Write',
          toolCall: { id: 'permission-tool', input: { file_path: 'src/main.rs' } },
          status: 'pending_confirmation',
          timestamp: 1,
        }}
      />,
    ));

    expect(container.querySelector('.flow-tool-card-wrapper--permission-pending')).not.toBeNull();
  });

  it('does not highlight a same-name card without a matching permission call ID', () => {
    act(() => root.render(
      <FlowToolCard
        toolItem={{
          id: 'running-command',
          type: 'tool',
          toolName: 'ExecCommand',
          toolCall: { id: 'running-command', input: { cmd: 'cargo check' } },
          status: 'running',
          timestamp: 1,
        }}
      />,
    ));

    expect(container.querySelector('.flow-tool-card-wrapper--permission-pending')).toBeNull();
  });

  it('highlights only the tool card matching a permission call ID', () => {
    permissionContextMock.pendingPermissionToolCallIds.add('pending-call');

    const tool = (id: string): FlowToolItem => ({
      id,
      type: 'tool',
      toolName: 'ExecCommand',
      toolCall: { id, input: { cmd: 'cargo check' } },
      status: 'running',
      timestamp: 1,
    });

    act(() => root.render(<FlowToolCard toolItem={tool('other-call')} />));
    expect(container.querySelector('.flow-tool-card-wrapper--permission-pending')).toBeNull();

    act(() => root.render(<FlowToolCard toolItem={tool('pending-call')} />));
    expect(container.querySelector('.flow-tool-card-wrapper--permission-pending')).not.toBeNull();
  });

  it('updates the card when it becomes or stops being the visual tail', () => {
    const tool: FlowToolItem = {
      id: 'tail-tool',
      type: 'tool',
      toolName: 'ExecCommand',
      toolCall: { id: 'tail-tool', input: { cmd: 'cargo check' } },
      status: 'completed',
      timestamp: 1,
    };

    act(() => root.render(<FlowToolCard toolItem={tool} isLastItem />));
    expect(container.querySelector('[data-is-last-item="true"]')).not.toBeNull();

    act(() => root.render(<FlowToolCard toolItem={tool} isLastItem={false} />));
    expect(container.querySelector('[data-is-last-item="false"]')).not.toBeNull();
  });
});
