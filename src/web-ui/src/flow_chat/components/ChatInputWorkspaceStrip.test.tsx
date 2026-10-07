/**
 * @vitest-environment jsdom
 */

import { act, cloneElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatInputWorkspaceStrip } from './ChatInputWorkspaceStrip';
import type { WorkspaceInfo } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  refreshBasic: vi.fn(async () => undefined),
  setActiveWorkspace: vi.fn(async () => undefined),
  useGitState: vi.fn(() => ({
    currentBranch: 'main',
    isRepository: true,
    refreshBasic: vi.fn(async () => undefined),
  })),
  // The strip only switches workspaces when more than one is open; bare
  // mounts in this suite default to "no provider", and the switcher tests
  // override this per case.
  useOptionalWorkspaceContext: vi.fn((): object | null => null),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    // Mapped keys resolve like the real catalogs do, placeholders included, so
    // a case can assert the string the user reads instead of the key.
    t: (key: string, options?: Record<string, unknown>) => {
      const template = ({
        'deepReviewConsent.strategyLabels.normal': 'Standard',
        'reasoningSelector.auto': 'Auto',
        'chatInput.permissionMode.ask.label': 'Ask',
        'strip.newWorktree': 'New Worktree',
        'threadGoal.stripOpenWithGoal': 'Open thread goal',
        'threadGoal.stripPauseGoal': 'Pause goal',
        'threadGoal.stripResumeGoal': 'Resume goal',
        'threadGoal.stripClearGoal': 'Clear goal',
        'threadGoal.stripTooltipWithGoal': '{{status}}: {{objective}}',
        'threadGoal.status.active': 'Active',
        'threadGoal.status.paused': 'Paused',
        'usage.duration.seconds': '{{value}}s',
        'usage.duration.minutes': '{{value}}m',
        'usage.duration.hoursMinutes': '{{hours}}h {{minutes}}m',
        'workspaceStrip.primaryAssistant': 'Primary assistant',
        'workspaceStrip.personalAssistant': 'Personal assistant',
      } as Record<string, string>)[key] ?? (options?.defaultValue as string | undefined) ?? key;
      return template.replace(
        /\{\{(\w+)\}\}/g,
        (placeholder, name: string) => (
          options?.[name] === undefined ? placeholder : String(options[name])
        ),
      );
    },
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  // Forwards the rest of the props so state carried on data attributes stays
  // observable; `variant`/`size` are the library's own and have no DOM meaning.
  IconButton: ({
    children,
    variant: _variant,
    size: _size,
    ...rest
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...rest}>{children}</button>
  ),
  Tooltip: ({
    children,
    content,
  }: {
    children: React.ReactElement;
    content: React.ReactNode;
  }) => cloneElement(children, {
    'data-tooltip': typeof content === 'string' ? content : undefined,
  } as React.HTMLAttributes<HTMLElement>),
}));

vi.mock('@/tools/git/hooks/useGitState', () => ({
  useGitState: mocks.useGitState,
}));

vi.mock('@/tools/git/components/BranchQuickSwitch', () => ({
  BranchQuickSwitch: ({
    currentBranch,
    isOpen,
  }: {
    currentBranch: string;
    isOpen: boolean;
  }) => isOpen ? (
    <div
      data-testid="branch-quick-switch"
      data-current-branch={currentBranch}
    />
  ) : null,
}));

// The real picker pulls in account state, SSH dialogs and a lazy remote-connect
// route. This suite observes the strip-to-picker contract through a lightweight
// stand-in; picker behavior itself stays covered in its focused suite.
vi.mock('@/features/dispatch/DispatchTargetPicker', () => ({
  DispatchTargetPicker: ({
    locked,
    localWorktreeControl,
  }: {
    locked: boolean;
    localWorktreeControl?: {
      enabled: boolean;
      locked: boolean;
      label: string;
      onChange: (enabled: boolean) => void;
    };
  }) => (
    <div
      data-testid="chat-input-dispatch-trigger"
      data-locked={locked ? 'true' : 'false'}
      data-worktree-enabled={localWorktreeControl?.enabled ? 'true' : 'false'}
      data-worktree-label={localWorktreeControl?.label}
    >
      {localWorktreeControl ? (
        <button
          type="button"
          data-testid="dispatch-target-new-worktree-option"
          disabled={localWorktreeControl.locked}
          onClick={() => localWorktreeControl.onChange(true)}
        >
          {localWorktreeControl.label}
        </button>
      ) : null}
    </div>
  ),
}));

// The workspace switcher is the only thing the strip asks of the workspace
// context; the display-name helper is trivial and stays real-shaped.
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useOptionalWorkspaceContext: mocks.useOptionalWorkspaceContext,
  getWorkspaceDisplayName: (workspace: { name?: string; path?: string }) => (
    workspace.name ?? workspace.path ?? ''
  ),
}));

describe('ChatInputWorkspaceStrip git refresh behavior', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.useGitState.mockClear();
    mocks.useGitState.mockReturnValue({
      currentBranch: 'main',
      isRepository: true,
      refreshBasic: mocks.refreshBasic,
    });
    mocks.useOptionalWorkspaceContext.mockReturnValue(null);
    mocks.setActiveWorkspace.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    vi.clearAllMocks();
  });

  it('uses cached git state without passive refresh while historical restore is pending', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          deferPassiveGitRefresh
        />
      );
    });

    expect(mocks.useGitState).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/OpenBitFun' },
      layers: ['basic'],
      isActive: false,
      refreshOnMount: false,
      refreshOnActive: false,
    }));
    expect(container.textContent).toContain('OpenBitFun');
  });

  it('keeps passive git refresh enabled for normal sessions', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
        />
      );
    });

    expect(mocks.useGitState).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: { workspaceId: 'workspace-1', repositoryPath: 'D:/workspace/OpenBitFun' },
      isActive: true,
      refreshOnMount: true,
      refreshOnActive: false,
    }));
  });

  it('keeps the workspace an inert fact when there is nothing to switch to', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
        />
      );
    });

    // No provider, one workspace — same outcome: the name is a span, not a
    // trigger, and no menu can appear.
    const workspace = container.querySelector('[data-openbitfun-part="workspace"]');
    expect(workspace?.tagName).toBe('SPAN');
    expect(container.querySelector('[data-testid="chat-input-workspace-trigger"]')).toBeNull();
  });

  it('opens the branch picker from the ordinary workspace branch chip', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-branch-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      trigger?.click();
    });

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="branch-quick-switch"]')
        ?.getAttribute('data-current-branch'),
    ).toBe('main');
  });

  it('selects the draft target without switching the global workspace', async () => {
    const options = [
        {
          id: 'ws-1',
          name: 'OpenBitFun',
          rootPath: 'D:/workspace/OpenBitFun',
          workspaceKind: 'normal',
        },
        {
          id: 'ws-2',
          name: 'Other',
          rootPath: 'D:/workspace/Other',
          workspaceKind: 'normal',
        },
        {
          id: 'ws-3',
          name: 'Primary',
          rootPath: 'D:/internal/assistants/ws-3',
          workspaceKind: 'assistant',
        },
        {
          id: 'ws-4',
          name: 'Personal',
          rootPath: 'D:/internal/assistants/ws-4',
          workspaceKind: 'assistant',
          assistantId: 'assistant-4',
        },
      ] as WorkspaceInfo[];
    const onSelect = vi.fn();

    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          workspaceControl={{ selectedId: 'ws-1', options, locked: false, onSelect }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-workspace-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');

    await act(async () => {
      trigger?.click();
    });

    const menu = document.querySelector('[data-testid="chat-input-workspace-menu"]');
    expect(menu).not.toBeNull();
    // The active workspace is marked and is not re-selected.
    expect(
      menu?.querySelector('[data-testid="chat-input-workspace-option-ws-1"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      menu?.querySelector('[data-testid="chat-input-workspace-option-ws-1"]')?.textContent,
    ).toContain('D:/workspace/OpenBitFun');
    expect(
      menu?.querySelector('[data-testid="chat-input-workspace-option-ws-2"]')?.textContent,
    ).toContain('D:/workspace/Other');
    expect(
      menu?.querySelector('[data-testid="chat-input-workspace-option-ws-3"]')?.textContent,
    ).toContain('Primary assistant');
    expect(
      menu?.querySelector('[data-testid="chat-input-workspace-option-ws-4"]')?.textContent,
    ).toContain('Personal assistant');
    expect(menu?.textContent).not.toContain('D:/internal/assistants/');

    const other = menu?.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-workspace-option-ws-2"]',
    );
    await act(async () => {
      other?.click();
    });

    expect(onSelect).toHaveBeenCalledWith('ws-2');
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="chat-input-workspace-menu"]')).toBeNull();
  });

  it('closes a stale directory menu when first submission locks its target', async () => {
    const options = ['a', 'b'].map(id => ({ id, name: id, workspaceKind: 'normal' })) as WorkspaceInfo[];
    const onSelect = vi.fn();
    const render = (locked: boolean) => <ChatInputWorkspaceStrip workspaceId="a" repositoryPath="/a"
      workspaceLabel="A" workspaceControl={{ selectedId: 'a', options, locked, onSelect }} />;
    await act(async () => { root.render(render(false)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-trigger"]')?.click(); });
    expect(document.querySelector('[data-testid="chat-input-workspace-menu"]')).not.toBeNull();
    await act(async () => { root.render(render(true)); });
    expect(container.querySelector('[data-testid="chat-input-workspace-trigger"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-input-workspace-menu"]')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('can replace a closed target with the only remaining workspace', async () => {
    const onSelect = vi.fn();
    const options = [{ id: 'a', name: 'A', rootPath: '/a', workspaceKind: 'normal' }] as WorkspaceInfo[];
    await act(async () => root.render(
      <ChatInputWorkspaceStrip workspaceId="closed" repositoryPath="" workspaceLabel="Unavailable"
        workspaceControl={{ selectedId: 'closed', options, locked: false, onSelect }} />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-option-a"]')?.click();
    });
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(mocks.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('splits the situation from the contract for the next turn', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          worktreeControl={{ enabled: false, locked: false, onChange: vi.fn() }}
          permissionControl={{ mode: 'auto', onChange: vi.fn() }}
          usageReport={{ visible: true, currentTokens: 480, maxTokens: 4000, onOpen: vi.fn() }}
        />
      );
    });

    const context = container.querySelector<HTMLElement>('[data-openbitfun-part="context"]');
    const next = container.querySelector<HTMLElement>('[data-openbitfun-part="next"]');
    expect(context).not.toBeNull();
    expect(next).not.toBeNull();

    // Where the session runs, and whether it runs there in isolation, read as
    // one situation.
    expect(context?.querySelector('[data-openbitfun-part="workspace"]')).not.toBeNull();
    expect(context?.querySelector('[data-openbitfun-part="branch"]')).not.toBeNull();
    expect(context?.querySelector('[data-testid="chat-input-worktree-toggle"]')).not.toBeNull();

    // What the next submission runs with reads as one contract.
    const permissionTrigger = next?.querySelector<HTMLElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(permissionTrigger?.textContent).toContain('chatInput.permissionMode.auto.label');
    // The ring carries the reading on its own; the number is not repeated.
    expect(next?.querySelector('[data-openbitfun-part="usageAction"]')).not.toBeNull();
    expect(next?.querySelector('.openbitfun-chat-input-workspace-strip__usage-ring')).not.toBeNull();
    expect(next?.querySelector('[data-openbitfun-part="usageAction"]')?.getAttribute('data-tooltip'))
      .toBe('480/4K 12%');
    expect(container.textContent).not.toContain('12%');

    // The harness and the reasoning strength live in the capsule now, so the
    // strip must not grow a second home for either.
    expect(container.querySelector('[data-testid="harness-profile-selector"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="harness"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="runtime"]')).toBeNull();
  });

  it('keeps an ask-mode permission entry visible and switches without a hide action', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{ mode: 'ask', onChange }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]');
    expect(trigger?.dataset.permissionMode).toBe('ask');
    expect(trigger?.textContent).toContain('Ask');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const permissionMenu = document.querySelector<HTMLElement>(
      '[data-testid="chat-input-permission-menu"]',
    );
    expect(permissionMenu).not.toBeNull();
    expect(permissionMenu?.style.visibility).toBe('visible');
    expect(
      permissionMenu?.querySelector('[data-testid="chat-input-permission-hide-control"]'),
    ).toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-option-auto"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
    expect(document.querySelector('[data-testid="chat-input-permission-menu"]')).toBeNull();
  });

  it('keeps session selection primary and opens one-off choices as a second level', async () => {
    const onChange = vi.fn();
    const onChangeForNextTurn = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'ask',
            nextTurnMode: null,
            onChange,
            onChangeForNextTurn,
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The row body is the session scope.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-option-auto"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
    expect(onChangeForNextTurn).not.toHaveBeenCalled();

    // One-off scope is a named second level, not an unexplained checkbox on
    // every session row.
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-turn-scope"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-permission-next-turn-full_access"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangeForNextTurn).toHaveBeenCalledWith('full_access');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('labels one-off choices as current-turn updates while a turn is active', async () => {
    const onChangeForNextTurn = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'ask',
            activeTurn: true,
            nextTurnMode: null,
            scopeLabel: 'This session',
            onChange: vi.fn(),
            onChangeForNextTurn,
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionActiveTurn).toBe('true');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('This session');
    expect(
      document.querySelector('[data-testid="chat-input-permission-turn-scope"]')?.textContent,
    ).toContain('chatInput.permissionMode.activeTurnSettings');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-turn-scope"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const oneOff = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-next-turn-auto"]',
    );
    expect(oneOff?.getAttribute('aria-label')).toBe(
      'chatInput.permissionMode.activeTurnOnly',
    );
    expect(oneOff?.getAttribute('role')).toBe('menuitemradio');
    expect(document.body.textContent).toContain('chatInput.permissionMode.activeTurnScope');

    await act(async () => {
      oneOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangeForNextTurn).toHaveBeenCalledWith('auto');
  });

  it('clears a one-off override through the explicit follow-session choice', async () => {
    const onChangeForNextTurn = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'auto',
            nextTurnMode: 'full_access',
            onChange: vi.fn(),
            onChangeForNextTurn,
          }}
        />
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-turn-scope"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const followSession = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-follow-session"]',
    );
    expect(followSession?.getAttribute('role')).toBe('menuitemradio');
    expect(followSession?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      followSession?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangeForNextTurn).toHaveBeenCalledWith('full_access');
    expect(document.querySelector('[data-testid="chat-input-permission-menu"]')).toBeNull();
  });

  it('opens the one-off level on click or Right Arrow, never on hover', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'ask',
            onChange: vi.fn(),
            onChangeForNextTurn: vi.fn(),
          }}
        />
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const scope = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-turn-scope"]',
    );
    await act(async () => {
      scope?.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="chat-input-permission-follow-session"]'))
      .toBeNull();

    await act(async () => {
      scope?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="chat-input-permission-follow-session"]'))
      .not.toBeNull();
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(
      document
        .querySelector('[data-testid="chat-input-permission-turn-back"]')
        ?.getAttribute('aria-label'),
    ).toBe('chatInput.permissionMode.backToSessionSettings');

    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-input-permission-menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="chat-input-permission-turn-scope"]'))
      .not.toBeNull();
  });

  it('keeps the mode descriptions out of the row and in the accessible name', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{ mode: 'ask', onChange: vi.fn(), onChangeForNextTurn: vi.fn() }}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const option = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-option-ask"]',
    );
    // The row itself stays single-line; the description lives in the tooltip.
    expect(option?.textContent).toBe('Ask');
    expect(option?.getAttribute('aria-label')).toContain(
      'chatInput.permissionMode.ask.description',
    );
  });

  it('marks the armed one-off mode and omits the affordance without a handler', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'full_access',
            nextTurnMode: 'full_access',
            overridden: true,
            onChange: vi.fn(),
            onChangeForNextTurn: vi.fn(),
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionOverridden).toBe('true');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-input-permission-turn-scope"]')?.textContent,
    ).toContain('chatInput.permissionMode.fullAccess.label');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-turn-scope"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document
        .querySelector('[data-testid="chat-input-permission-next-turn-full_access"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document
        .querySelector('[data-testid="chat-input-permission-next-turn-ask"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false');

    // Surfaces without a one-off handler (dispatch, ACP) keep the plain rows.
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{ mode: 'ask', onChange: vi.fn() }}
        />
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="chat-input-permission-turn-scope"]'),
    ).toBeNull();
  });

  it('separates the session checkmark from an armed one-off override', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            // Session runs on auto; only the next message is full access.
            mode: 'auto',
            nextTurnMode: 'full_access',
            overridden: true,
            onChange: vi.fn(),
            onChangeForNextTurn: vi.fn(),
          }}
        />
      );
    });

    // The trigger reports what the next submission will run with.
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionMode).toBe('full_access');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The checkmark stays on the session's own mode, not the armed one.
    expect(
      document.querySelector('[data-testid="chat-input-permission-selected-auto"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="chat-input-permission-selected-full_access"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-input-permission-next-turn-full_access"]'),
    ).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-turn-scope"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document
        .querySelector('[data-testid="chat-input-permission-next-turn-full_access"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('marks a session-scoped override and offers a reset to the default', async () => {
    const onResetToDefault = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'full_access',
            overridden: true,
            scopeLabel: 'This session',
            onChange: vi.fn(),
            onResetToDefault,
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionOverridden).toBe('true');
    // A session-level choice is not pending, so it gets no dot; the trigger
    // label already names the mode it runs with.
    expect(
      container.querySelector('[data-testid="chat-input-permission-next-turn-dot"]'),
    ).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('This session');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-reset-default"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onResetToDefault).toHaveBeenCalledOnce();
  });

  it('dots the trigger only while a one-off override is pending', async () => {
    const onOpenDefaultSettings = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'auto',
            nextTurnMode: 'full_access',
            overridden: true,
            onChange: vi.fn(),
            onChangeForNextTurn: vi.fn(),
            onResetToDefault: vi.fn(),
            onOpenDefaultSettings,
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionNextTurn).toBe('true');
    expect(
      container.querySelector('[data-testid="chat-input-permission-next-turn-dot"]'),
    ).not.toBeNull();

    // The reset row reaches the settings page that owns the default.
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-permission-open-default-settings"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDefaultSettings).toHaveBeenCalledOnce();
  });

  it('hides the override affordances when the session follows the default', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            mode: 'ask',
            overridden: false,
            onChange: vi.fn(),
            onResetToDefault: vi.fn(),
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionOverridden).toBeUndefined();
    expect(
      container.querySelector('[data-testid="chat-input-permission-next-turn-dot"]'),
    ).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="chat-input-permission-reset-default"]'),
    ).toBeNull();
  });

  it('reports an unreadable session mode instead of passing the default off as its own', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath=""
          workspaceLabel=""
          permissionControl={{
            // The read failed, so this is the user-level default, not a choice
            // the Session made.
            mode: 'ask',
            overridden: false,
            unread: true,
            onChange: vi.fn(),
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionUnread).toBe('true');
    expect(trigger?.getAttribute('data-tooltip')).toBe('chatInput.permissionMode.unreadTooltip');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // No radio is marked, because the Session's own mode is unknown; the notice
    // says why the list is bare.
    expect(
      document.querySelector('[data-testid="chat-input-permission-selected-ask"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-input-permission-unread-notice"]'),
    ).not.toBeNull();
  });

  it('shows ACP ownership without exposing native permission choices', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          permissionControl={{ mode: 'acp' }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-permission-trigger"]');
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.dataset.permissionMode).toBe('acp');
    expect(container.querySelector('[data-testid="chat-input-permission-menu"]')).toBeNull();
  });

  it('keeps both rails present whatever the session happens to expose', async () => {
    // The two rails are the layout. A session with fewer controls empties a
    // rail rather than switching the strip to a different arrangement, so the
    // remaining controls cannot drift sideways between sessions.
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          permissionControl={{ mode: 'acp' }}
          usageReport={{ visible: true, currentTokens: 1680, maxTokens: 4000, onOpen: vi.fn() }}
        />
      );
    });

    const strip = container.querySelector<HTMLElement>('[data-testid="chat-input-workspace-strip"]');
    expect(strip?.className).toBe('openbitfun-chat-input-workspace-strip');
    expect(strip?.children.length).toBe(2);
    expect(strip?.children[0]?.getAttribute('data-openbitfun-part')).toBe('context');
    expect(strip?.children[1]?.getAttribute('data-openbitfun-part')).toBe('next');

    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="D:/workspace/OpenBitFun"
          workspaceLabel="OpenBitFun"
          permissionControl={{ mode: 'acp' }}
        />
      );
    });

    const withoutUsage = container.querySelector<HTMLElement>(
      '[data-testid="chat-input-workspace-strip"]',
    );
    expect(withoutUsage?.className).toBe('openbitfun-chat-input-workspace-strip');
    expect(withoutUsage?.children.length).toBe(2);
    expect(withoutUsage?.querySelector('[data-openbitfun-part="usageAction"]')).toBeNull();
  });

  it('reuses the permission control with dispatch-scoped choices', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          permissionControl={{
            mode: 'reject',
            options: ['ask', 'auto', 'reject'],
            scopeLabel: 'This dispatched session',
            onChange,
          }}
        />
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-permission-trigger"]',
    );
    expect(trigger?.dataset.permissionMode).toBe('reject');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('This dispatched session');
    expect(document.querySelector(
      '[data-testid="chat-input-permission-option-full_access"]',
    )).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="chat-input-permission-option-auto"]',
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('offers the worktree toggle for a Git workspace and reports the new state', async () => {
    const onChange = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: false, locked: false, onChange }}
        />
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-worktree-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.dataset.worktreeEnabled).toBe('false');
    expect(toggle?.disabled).toBe(false);

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('updates repeated clicks optimistically without waiting for Git work', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: false, locked: false, onChange }}
        />
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-worktree-toggle"]');
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it('shows an armed worktree as checked before it is materialized', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: true, locked: false, onChange: vi.fn() }}
        />
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-worktree-toggle"]');
    expect(toggle?.dataset.worktreeEnabled).toBe('true');
    expect(toggle?.dataset.worktreeMaterialized).toBe('false');
  });

  it('shows the toggle as on inside a worktree and asks to turn it off', async () => {
    const onChange = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/worktrees/wt-1"
          workspaceLabel="wt-1"
          executionTarget={{
            kind: 'managedWorktree',
            worktreeId: 'wt-1',
            rootPath: '/worktrees/wt-1',
            baseCommit: '0123456789abcdef',
            branch: 'openbitfun/isolated',
            lifecycle: 'managed',
          }}
          worktreeControl={{ enabled: true, locked: false, onChange }}
        />
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-worktree-toggle"]');
    expect(toggle?.dataset.worktreeEnabled).toBe('true');
    expect(container.textContent).toContain('openbitfun/isolated');
    expect(container.querySelector('[data-testid="chat-input-branch-trigger"]')).toBeNull();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('locks the toggle once the session has a transcript', async () => {
    const onChange = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: false, locked: true, onChange }}
        />
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-input-worktree-toggle"]');
    expect(toggle?.disabled).toBe(true);

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refetches Git state when the execution root moves into a worktree', async () => {
    const onChange = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: false, locked: false, onChange }}
        />
      );
    });
    expect(mocks.refreshBasic).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/worktrees/wt-1"
          workspaceLabel="repo"
          executionTarget={{
            kind: 'managedWorktree',
            worktreeId: 'wt-1',
            rootPath: '/worktrees/wt-1',
            lifecycle: 'managed',
          }}
          worktreeControl={{ enabled: true, locked: false, onChange }}
        />
      );
    });

    expect(mocks.refreshBasic).toHaveBeenCalled();
  });

  it('omits the toggle when the session cannot host a worktree', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-input-worktree-toggle"]')).toBeNull();
  });

  it('orders workspace and branch before the target and nests worktree under local', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{ enabled: false, locked: false, onChange }}
          dispatchControl={{
            target: { kind: 'local' },
            locked: false,
            onSelectTarget: vi.fn(),
          }}
        />
      );
    });

    const context = container.querySelector<HTMLElement>('[data-openbitfun-part="context"]');
    const location = context?.querySelector('.openbitfun-chat-input-workspace-strip__location');
    const dispatchTrigger = context?.querySelector<HTMLElement>(
      '[data-testid="chat-input-dispatch-trigger"]',
    );
    expect(context).not.toBeNull();
    expect(location).not.toBeNull();
    expect(dispatchTrigger).not.toBeNull();
    expect(Array.from(context?.children ?? []).indexOf(location as Element))
      .toBeLessThan(Array.from(context?.children ?? []).indexOf(dispatchTrigger as Element));
    expect(container.querySelector('[data-testid="chat-input-worktree-toggle"]')).toBeNull();
    expect(dispatchTrigger?.dataset.worktreeEnabled).toBe('false');
    expect(dispatchTrigger?.dataset.worktreeLabel).toBe('New Worktree');

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="dispatch-target-new-worktree-option"]',
    )?.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the dispatched branch instead of the source branch once dispatch is locked', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          worktreeControl={{
            enabled: true,
            locked: true,
            lockedReason: 'dispatch',
            onChange: vi.fn(),
          }}
          dispatchControl={{
            target: {
              kind: 'ssh',
              connectionId: 'ssh-1',
              workspacePath: '',
              displayName: 'build-host',
            },
            locked: true,
            branch: 'openbitfun/dispatch/job-1',
            onSelectTarget: vi.fn(),
          }}
        />
      );
    });

    expect(container.textContent).toContain('openbitfun/dispatch/job-1');
    expect(container.textContent).not.toContain('main');
    expect(container.querySelector('[data-testid="chat-input-branch-trigger"]')).toBeNull();
  });

  it('keeps the local execution breadcrumb visible but omits Git branch info outside a Git workspace', async () => {
    mocks.useGitState.mockReturnValue({
      currentBranch: '',
      isRepository: false,
      refreshBasic: mocks.refreshBasic,
    });

    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/plain-folder"
          workspaceLabel="plain-folder"
          worktreeControl={{ enabled: false, locked: false, onChange: vi.fn() }}
          dispatchControl={{
            target: { kind: 'local' },
            locked: false,
            onSelectTarget: vi.fn(),
          }}
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-input-worktree-toggle"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="branch"]')).toBeNull();
    expect(container.querySelector('.openbitfun-chat-input-workspace-strip__chip--branch')).toBeNull();
    const dispatchTrigger = container.querySelector<HTMLElement>(
      '[data-testid="chat-input-dispatch-trigger"]',
    );
    expect(dispatchTrigger).not.toBeNull();
    expect(dispatchTrigger?.dataset.locked).toBe('true');
  });

  // The goal entry appears only while a goal exists, so "no goal" is the
  // absence of the control rather than a control that says so.
  it('omits the goal control while the session has no goal', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
        />
      );
    });

    expect(container.querySelector('[data-openbitfun-part="goal"]')).toBeNull();
  });

  it('reads the goal as its state and its elapsed time, not as its objective', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: {
              objective: 'Ship the goal entry',
              status: 'active',
              timeUsedSeconds: 5_400,
            },
            onOpen: vi.fn(),
          }}
        />
      );
    });

    const control = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-thread-goal"]',
    );
    expect(control).not.toBeNull();
    expect(control?.dataset.openbitfunPart).toBe('goal');
    expect(control?.dataset.openbitfunState).toBe('active');
    expect(control?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control?.getAttribute('aria-label')).toBe('Open thread goal');
    expect(control?.textContent).toContain('Active');
    expect(control?.textContent).toContain('1h 30m');
    // The objective is long-form, so it stays in the tooltip rather than
    // competing with the state for the width of the track.
    expect(control?.textContent).not.toContain('Ship the goal entry');
    expect(control?.dataset.tooltip).toContain('Ship the goal entry');
  });

  // A goal that has not driven a turn yet has nothing to report, and "0s"
  // would read as a stalled goal rather than a new one.
  it('omits the elapsed time until the goal has driven a turn', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'active', timeUsedSeconds: 0 },
            onOpen: vi.fn(),
          }}
        />
      );
    });

    const control = container.querySelector('[data-testid="chat-input-thread-goal"]');
    expect(control?.textContent).toContain('Active');
    expect(control?.textContent).not.toContain('0s');
  });

  // A goal that stopped driving turns must not look like one that is running:
  // the state channel is the tone, so the runtime's five non-running statuses
  // have to land on the three tones this track can show.
  it.each([
    ['paused', 'paused'],
    ['blocked', 'blocked'],
    ['usageLimited', 'blocked'],
    ['budgetLimited', 'blocked'],
    ['complete', 'complete'],
  ])('carries %s as the %s state', async (status, tone) => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{ goal: { objective: 'Ship the goal entry', status }, onOpen: vi.fn() }}
        />
      );
    });

    expect(
      container.querySelector('[data-testid="chat-input-thread-goal"]')?.getAttribute(
        'data-openbitfun-state',
      ),
    ).toBe(tone);
  });

  it('opens the goal from the control', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{ goal: { objective: 'Ship the goal entry', status: 'active' }, onOpen }}
        />
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-input-thread-goal"]')?.click();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('closes the rail to the right of the execution target', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'active' },
            onOpen: vi.fn(),
          }}
          dispatchControl={{
            target: { kind: 'local' },
            locked: false,
            onSelectTarget: vi.fn(),
          }}
        />
      );
    });

    const children = Array.from(
      container.querySelector('[data-openbitfun-part="context"]')?.children ?? [],
    );
    const locationIndex = children.indexOf(
      container.querySelector('.openbitfun-chat-input-workspace-strip__location') as Element,
    );
    const goalIndex = children.indexOf(
      container.querySelector('[data-testid="chat-input-thread-goal"]') as Element,
    );
    const dispatchIndex = children.indexOf(
      container.querySelector('[data-testid="chat-input-dispatch-trigger"]') as Element,
    );

    expect(locationIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeGreaterThan(locationIndex);
    expect(goalIndex).toBeGreaterThan(dispatchIndex);
  });

  // The runtime accounts the goal's wall clock at turn accounting points, so the
  // value arrives in steps. A goal that is running keeps spending time between
  // those snapshots, so the track counts on instead of standing still.
  it('counts the goal elapsed time while the goal runs', async () => {
    const readout = () => container
      .querySelector('[data-testid="chat-input-thread-goal"]')
      ?.textContent;

    vi.useFakeTimers();
    try {
      act(() => {
        root.render(
          <ChatInputWorkspaceStrip workspaceId="workspace-1"
            repositoryPath="/repo"
            workspaceLabel="repo"
            threadGoal={{
              goal: { objective: 'Ship the goal entry', status: 'active', timeUsedSeconds: 5 },
              actions: ['edit', 'pause', 'clear'],
              onOpen: vi.fn(),
              onAction: vi.fn(),
            }}
          />
        );
      });

      expect(readout()).toContain('5s');

      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      expect(readout()).toContain('8s');
    } finally {
      vi.useRealTimers();
    }
  });

  // A goal that stopped running is not spending time, so its readout holds the
  // accounted value even though it is the same track.
  it('freezes the elapsed time while the goal is not running', async () => {
    const readout = () => container
      .querySelector('[data-testid="chat-input-thread-goal"]')
      ?.textContent;

    vi.useFakeTimers();
    try {
      act(() => {
        root.render(
          <ChatInputWorkspaceStrip workspaceId="workspace-1"
            repositoryPath="/repo"
            workspaceLabel="repo"
            threadGoal={{
              goal: { objective: 'Ship the goal entry', status: 'paused', timeUsedSeconds: 5 },
              actions: ['edit', 'resume', 'clear'],
              onOpen: vi.fn(),
              onAction: vi.fn(),
            }}
          />
        );
      });

      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      expect(readout()).toContain('5s');
    } finally {
      vi.useRealTimers();
    }
  });

  // A paused goal is one the user has to release, so the run control becomes the
  // action that releases it — the same list the menu is built from.
  it('offers resume in place of pause while the goal waits on the user', async () => {
    const onAction = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'paused' },
            actions: ['edit', 'resume', 'clear'],
            onOpen: vi.fn(),
            onAction,
          }}
        />
      );
    });

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-thread-goal-run"]',
    );
    expect(run?.getAttribute('aria-label')).toBe('Resume goal');

    await act(async () => {
      run?.click();
    });

    expect(onAction).toHaveBeenCalledWith('resume');
  });

  it('runs the goal actions the menu offers from the track', async () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'active' },
            actions: ['edit', 'pause', 'clear'],
            onOpen,
            onAction,
          }}
        />
      );
    });

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-thread-goal-run"]',
    );
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-thread-goal-clear"]',
    );
    expect(run?.dataset.openbitfunPart).toBe('goalRun');
    expect(run?.getAttribute('aria-label')).toBe('Pause goal');
    expect(clear?.dataset.openbitfunPart).toBe('goalClear');
    expect(clear?.getAttribute('aria-label')).toBe('Clear goal');

    await act(async () => {
      run?.click();
    });
    await act(async () => {
      clear?.click();
    });

    expect(onAction.mock.calls.map(([action]) => action)).toEqual(['pause', 'clear']);
    // Acting on the goal is not opening it, so the readout stays untouched.
    expect(onOpen).not.toHaveBeenCalled();
  });

  // A finished or budget-limited goal has nothing left to stop: only the exit.
  it('offers no run control for a goal that no longer runs', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'complete' },
            actions: ['edit', 'clear'],
            onOpen: vi.fn(),
            onAction: vi.fn(),
          }}
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-input-thread-goal-run"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input-thread-goal-clear"]')).not.toBeNull();
  });

  // A surface that cannot run goal actions gets the fact, not a control that
  // would do nothing when pressed.
  it('keeps the quick controls away where the surface cannot run them', async () => {
    await act(async () => {
      root.render(
        <ChatInputWorkspaceStrip workspaceId="workspace-1"
          repositoryPath="/repo"
          workspaceLabel="repo"
          threadGoal={{
            goal: { objective: 'Ship the goal entry', status: 'active' },
            actions: ['edit', 'pause', 'clear'],
            onOpen: vi.fn(),
          }}
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-input-thread-goal-run"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-input-thread-goal-clear"]')).toBeNull();
  });
});
