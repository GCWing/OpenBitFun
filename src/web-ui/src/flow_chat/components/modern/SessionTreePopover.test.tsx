// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTreePopover } from './SessionTreePopover';
import {
  resolveSubagentAvatarPresentation,
} from '../../subagent-identity';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getSessionLineage: vi.fn(),
  sessions: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: {
    getSessionLineage: mocks.getSessionLineage,
  },
}));

vi.mock('../../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({ sessions: mocks.sessions }),
    subscribe: () => () => undefined,
  },
}));

vi.mock('@openbitfun/ui', async importOriginal => {
  const ReactModule = await import('react');

  return {
    ...await importOriginal<typeof import('@openbitfun/ui')>(),
    Spinner: () => <span data-testid="dot-matrix-loader" />,
    IconButton: ReactModule.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
      tooltip?: string;
    }>(({
      children,
      tooltip,
      ...props
    }, ref) => (
      <button ref={ref} type="button" title={tooltip} {...props}>{children}</button>
    )),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

function createSession(
  sessionId: string,
  sessionKind: 'main' | 'subagent',
  parentSessionId?: string,
): Record<string, unknown> {
  return {
    sessionId,
    sessionKind,
    parentSessionId,
    parentToolCallId: parentSessionId ? 'tool-1' : undefined,
    title: sessionId === 'root' ? 'Root session' : 'Running child',
    createdAt: sessionId === 'root' ? 1 : 2,
    workspaceId: 'workspace-main',
    workspacePath: '/workspace',
    mode: 'code',
    config: { agentType: 'worker' },
    subagentType: sessionKind === 'subagent' ? 'worker' : undefined,
    dialogTurns: sessionKind === 'subagent' ? [{ status: 'processing' }] : [],
  };
}

describe('SessionTreePopover', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.getSessionLineage.mockReset();
    mocks.getSessionLineage.mockResolvedValue(null);
    mocks.sessions.clear();
    mocks.sessions.set('root', createSession('root', 'main'));
    mocks.sessions.set('child', createSession('child', 'subagent', 'root'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    vi.restoreAllMocks();
  });

  it('filters inactive branches, retains ancestors, and restores all agents when disabled', async () => {
    mocks.sessions.set('child', { ...createSession('child', 'subagent', 'root'), dialogTurns: [] });
    mocks.sessions.set('grandchild', createSession('grandchild', 'subagent', 'child'));
    mocks.sessions.set('idle-sibling', { ...createSession('idle-sibling', 'subagent', 'root'), dialogTurns: [] });
    const render = async (activeOnly: boolean) => {
      await act(async () => {
        root.render(<SessionTreePopover sessionId="root" embedded open activeOnly={activeOnly} t={key => key} />);
      });
    };
    const nodeIds = () => Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .map(node => node.dataset.sessionId);

    await render(true);
    expect(nodeIds()).toEqual(['child', 'grandchild']);
    await render(false);
    expect(nodeIds()).toEqual(['child', 'grandchild', 'idle-sibling']);
    await render(true);
    expect(nodeIds()).toEqual(['child', 'grandchild']);
  });

  it('shows the active empty state when all agents are inactive', async () => {
    mocks.sessions.set('child', { ...createSession('child', 'subagent', 'root'), dialogTurns: [] });
    await act(async () => {
      root.render(<SessionTreePopover sessionId="root" embedded open activeOnly t={key => key} />);
    });
    expect(container.querySelector('[role="treeitem"]')).toBeNull();
    expect(container.textContent).toContain('flowChatHeader.agentTreeNoActive');
  });

  it('offers deletion for inactive agents without exposing cancellation or opening the session', async () => {
    mocks.sessions.set('child', { ...createSession('child', 'subagent', 'root'), dialogTurns: [] });
    const onDeleteSession = vi.fn().mockResolvedValue(true);
    const onSelectSession = vi.fn();
    await act(async () => {
      root.render(<SessionTreePopover sessionId="root" embedded open onDeleteSession={onDeleteSession} onSelectSession={onSelectSession} t={key => key} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="flowChatHeader.agentTreeActions"]')?.click();
    });
    const menu = document.querySelector('[data-testid="flowchat-header-session-tree-menu"]');
    expect(menu?.textContent).toContain('flowChatHeader.agentTreeDelete');
    expect(menu?.textContent).not.toContain('flowChatHeader.agentTreeCancel');
    await act(async () => {
      menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    });
    expect(onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child' }));
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(mocks.getSessionLineage).toHaveBeenCalledTimes(2);
  });

  it('offers non-cascading cancellation for running child sessions', async () => {
    const onCancelSession = vi.fn().mockResolvedValue(true);
    const t = (key: string) => key;

    await act(async () => {
      root.render(
        <SessionTreePopover
          sessionId="root"
          fallbackWorkspaceId="workspace-main"
          onCancelSession={onCancelSession}
          t={t}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-session-tree"]')?.click();
      await Promise.resolve();
    });

    const panel = document.querySelector<HTMLElement>('.session-tree-popover__panel');
    expect(panel?.parentElement?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(panel?.style.visibility).toBe('visible');
    const actionButton = panel?.querySelector<HTMLButtonElement>(
      '[aria-label="flowChatHeader.agentTreeActions"]',
    );
    expect(actionButton).not.toBeNull();
    const childNode = Array.from(panel?.querySelectorAll('[role="treeitem"]') ?? [])
      .find(node => node.textContent?.includes('Running child'));
    const status = childNode?.querySelector('.subagent-avatar__status');
    expect(childNode).not.toBeUndefined();
    expect(status).not.toBeNull();
    expect(childNode?.contains(status!)).toBe(true);

    await act(async () => {
      actionButton?.click();
    });

    const cancelButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-tree-menu"] [role="menuitem"]',
    );
    expect(cancelButton).not.toBeNull();

    await act(async () => {
      cancelButton?.click();
      await Promise.resolve();
    });

    expect(onCancelSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child',
      isRoot: false,
    }));
  });

  it('maps sibling avatars from session IDs and formats Runtime agent IDs as names', async () => {
    mocks.sessions.set('child-2', createSession('child-2', 'subagent', 'root'));
    mocks.sessions.set('child-3', createSession('child-3', 'subagent', 'root'));
    mocks.getSessionLineage.mockResolvedValue({
      rootSessionId: 'root',
      sessions: [
        { sessionId: 'root', sessionName: 'Root session', agentType: 'code', createdAtMs: 1, status: 'active' },
        { sessionId: 'child', sessionName: 'Running child', agentType: 'worker', createdAtMs: 2, status: 'active', parentSessionId: 'root', subagentType: 'worker', agentId: 'parser-review' },
        { sessionId: 'child-2', sessionName: 'Running child', agentType: 'worker', createdAtMs: 3, status: 'active', parentSessionId: 'root', subagentType: 'worker', agentId: 'test-runner' },
        { sessionId: 'child-3', sessionName: 'Running child', agentType: 'worker', createdAtMs: 4, status: 'active', parentSessionId: 'root', subagentType: 'worker', agentId: 'docs-audit' },
      ],
    });
    const t = (key: string) => key;

    await act(async () => {
      root.render(
        <SessionTreePopover
          sessionId="root"
          fallbackWorkspaceId="workspace-main"
          t={t}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="flowchat-header-session-tree"]')?.click();
      await Promise.resolve();
    });

    const subagentNodes = Array.from(document.querySelectorAll<HTMLElement>(
      '.session-tree-popover__panel [role="treeitem"]:not([data-session-id="root"])',
    ));
    subagentNodes.forEach((node) => {
      const sessionId = node.dataset.sessionId!;
      const avatar = node.querySelector<HTMLElement>(
        '[data-openbitfun-component="subagent-avatar"]',
      )!;
      const presentation = resolveSubagentAvatarPresentation(sessionId);

      expect(avatar.dataset.openbitfunAvatarId).toBe(presentation.avatarId);
      expect(avatar.dataset.openbitfunAvatarColorId).toBe(presentation.colorId);
    });

    expect(subagentNodes).toHaveLength(3);
    expect(subagentNodes.map(node => node.querySelector('.session-tree-popover__node-title')?.textContent))
      .toEqual(['Parser review', 'Test runner', 'Docs audit']);
    expect(subagentNodes.map(node => node.querySelector('.session-tree-popover__node-meta')?.textContent))
      .toEqual(['worker', 'worker', 'worker']);
  });

  it('closes a sibling action-menu portal and restores focus with the parent', async () => {
    const t = (key: string) => key;
    await act(async () => {
      root.render(
        <SessionTreePopover
          sessionId="root"
          fallbackWorkspaceId="workspace-main"
          onCancelSession={vi.fn().mockResolvedValue(true)}
          t={t}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-tree"]',
    );
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const panel = document.querySelector<HTMLElement>('.session-tree-popover__panel');
    const actionButton = panel?.querySelector<HTMLButtonElement>(
      '[aria-label="flowChatHeader.agentTreeActions"]',
    );
    await act(async () => {
      actionButton?.click();
    });

    const actionMenuItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="flowchat-header-session-tree-menu"] [role="menuitem"]',
    );
    actionMenuItem?.focus();
    expect(document.activeElement).toBe(actionMenuItem);

    await act(async () => {
      trigger?.click();
    });

    expect(document.querySelector('[data-testid="flowchat-header-session-tree-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(panel?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders as parent-owned content and closes the parent after selecting an Agent session', async () => {
    const onSelectSession = vi.fn();
    const onRequestClose = vi.fn();
    const t = (key: string) => key;
    mocks.getSessionLineage.mockResolvedValue({
      rootSessionId: 'root',
      sessions: [
        { sessionId: 'root', sessionName: 'Root session', agentType: 'code', createdAtMs: 1, status: 'active' },
        { sessionId: 'child', sessionName: 'Running child', agentType: 'worker', createdAtMs: 2, status: 'active', parentSessionId: 'root', subagentType: 'worker', agentId: 'parser-review' },
      ],
    });

    await act(async () => {
      root.render(
        <SessionTreePopover
          sessionId="root"
          fallbackWorkspaceId="workspace-main"
          onSelectSession={onSelectSession}
          embedded
          open
          onRequestClose={onRequestClose}
          t={t}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="flowchat-header-session-tree"]')).toBeNull();
    expect(container.querySelector('[data-testid="flowchat-header-session-tree-content"]')).not.toBeNull();
    expect(document.querySelector('.session-tree-popover__panel')).toBeNull();

    const childNode = container.querySelector<HTMLElement>('[role="treeitem"][data-session-id="child"]');
    await act(async () => {
      childNode?.querySelector<HTMLButtonElement>('.session-tree-popover__node-main')?.click();
    });

    expect(onSelectSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child',
      agentId: 'parser-review',
      displayTitle: 'Parser review',
      isRoot: false,
    }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });
});
