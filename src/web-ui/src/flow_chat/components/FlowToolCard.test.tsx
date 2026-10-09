// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem } from '../types/flow-chat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));

vi.mock('../tool-cards', async () => {
  const ReactModule = await import('react');
  const { useToolCapsulePresentation } = await import('@openbitfun/ui/flow-chat');
  return {
    getToolCardComponent: (toolName: string) => ({
      toolItem,
      isLastItem,
    }: {
      toolItem: FlowToolItem;
      isLastItem?: boolean;
    }) => {
      const capsule = useToolCapsulePresentation();
      return ReactModule.createElement('div', {
        'data-selected-card': toolName,
        'data-card-tool-name': toolItem.toolName,
        'data-is-last-item': String(isLastItem === true),
        'data-capsule-has-fallback': String(Boolean(capsule?.fallbackContent)),
      });
    },
  };
});

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

  it('keeps agent wait identities on a full row even when timing overlaps', () => {
    const tool: FlowToolItem = {
      id: 'wait', type: 'tool', toolName: 'AgentWait',
      toolCall: { id: 'wait', input: { agent_ids: ['agent'] } }, status: 'completed', timestamp: 1,
    };
    act(() => root.render(<FlowToolCard toolItem={tool} />));
    const card = container.querySelector('.flow-tool-card-wrapper');
    expect(card?.hasAttribute('data-capsule-row')).toBe(false);
    expect(card?.hasAttribute('data-capsule-parallel')).toBe(false);

    act(() => root.render(<FlowToolCard toolItem={tool} parallel />));
    expect(container.querySelector('.flow-tool-card-wrapper')).toBe(card);
    expect(card?.hasAttribute('data-capsule-parallel')).toBe(false);

    act(() => root.render(<FlowToolCard toolItem={tool} parallel={false} />));
    expect(card?.hasAttribute('data-capsule-parallel')).toBe(false);
    expect(card?.hasAttribute('data-capsule-row')).toBe(false);
  });

  it('keeps AgentWait as a relationship row without capsule expansion', () => {
    const tool: FlowToolItem = {
      id: 'wait-static', type: 'tool', toolName: 'AgentWait',
      toolCall: { id: 'wait-static', input: { bg_task_ids: ['a1_bg1'] } },
      status: 'running', timestamp: 1,
    };
    act(() => root.render(<FlowToolCard toolItem={tool} />));
    expect(container.querySelector('[data-selected-card="AgentWait"]')?.getAttribute('data-capsule-has-fallback')).toBe('false');
    expect(container.querySelector('.flow-tool-card-wrapper')?.getAttribute('data-capsule-expanded')).toBeNull();
    expect(container.querySelector('.flow-tool-card-wrapper')?.getAttribute('data-openbitfun-presentation')).toBe('relation');
  });

  it.each(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'view_image', 'Skill', 'GetToolSpec'])('uses the native %s card for direct and deferred calls', toolName => {
    const tool: FlowToolItem = {
      id: 'native', type: 'tool', toolName,
      toolCall: { id: 'native', input: {} }, status: 'completed', timestamp: 1,
    };
    for (const item of [tool, {
      ...tool, toolName: 'CallDeferredTool',
      toolCall: { ...tool.toolCall, input: { tool_name: toolName, args: {} } },
    }]) {
      act(() => root.render(<FlowToolCard toolItem={item} parallel />));
      expect(container.querySelector(`[data-selected-card="${toolName}"]`)).not.toBeNull();
      expect(container.querySelector('[data-tool-capsule]')).toBeNull();
      expect(container.querySelector('[data-capsule-row]')).toBeNull();
      expect(container.querySelector('[data-capsule-parallel]')).toBeNull();
    }
  });

  it.each(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'view_image'])('hides failed %s cards while keeping approvals and interruption notes', toolName => {
    const tool: FlowToolItem = {
      id: 'hidden', type: 'tool', toolName,
      toolCall: { id: 'hidden', input: {} }, status: 'running', timestamp: 1,
    };
    act(() => root.render(<FlowToolCard toolItem={tool} />));
    expect(container.querySelector('.flow-tool-card-wrapper')).not.toBeNull();

    act(() => root.render(<FlowToolCard toolItem={{ ...tool, status: 'error' }} parallel />));
    expect(container.childElementCount).toBe(0);

    act(() => root.render(<FlowToolCard toolItem={{ ...tool, status: 'completed', toolResult: { success: false, result: null } }} />));
    expect(container.childElementCount).toBe(0);

    act(() => root.render(<FlowToolCard toolItem={{ ...tool, status: 'pending_confirmation' }} parallel />));
    expect(container.querySelector('.flow-tool-card-wrapper--permission-pending')).not.toBeNull();
    expect(container.querySelector('[data-tool-capsule="true"]')).toBeNull();
    expect(container.querySelector('[data-capsule-parallel="true"]')).toBeNull();

    act(() => root.render(<FlowToolCard toolItem={{ ...tool, status: 'cancelled', interruptionReason: 'app_restart' }} />));
    expect(container.querySelector('[role="note"]')?.textContent).toBe('toolCards.common.interruptedByRestart');
  });
});
