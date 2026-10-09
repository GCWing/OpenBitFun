// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import { WelcomePanel } from './WelcomePanel';
import { welcomePanelAppearanceDescriptor } from './WelcomePanel.appearance';
import { ChatInputWorkspaceStrip } from './ChatInputWorkspaceStrip';
import { useSessionWorkspaceSelection } from '../hooks/useSessionWorkspaceSelection';
import type { Session } from '../types/flow-chat';
import type { WorkspaceInfo } from '@/shared/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const gitApiMock = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getRepositoryBasic: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  currentWorkspace: { id: 'workspace-1', name: 'OpenBitFun', rootPath: 'D:/workspace/OpenBitFun', workspaceKind: 'normal' },
  openedWorkspaces: new Map<string, WorkspaceInfo>(),
  selectDraftWorkspace: vi.fn(),
  openWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
  switchLeftPanelTab: vi.fn(),
  gitScopes: [] as string[],
}));

vi.mock('../services/FlowChatManager', () => ({
  FlowChatManager: { getInstance: () => workspaceMocks },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.count ?? key,
  }),
}));

vi.mock('../../infrastructure/api', () => ({
  gitAPI: gitApiMock,
}));

vi.mock('../../app/hooks/useApp', () => ({
  useApp: () => ({
    switchLeftPanelTab: workspaceMocks.switchLeftPanelTab,
  }),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  getWorkspaceDisplayName: (workspace: WorkspaceInfo) => workspace.name,
  useWorkspaceContext: () => ({
    hasWorkspace: true,
    currentWorkspace: workspaceMocks.currentWorkspace,
    openedWorkspaces: workspaceMocks.openedWorkspaces,
    openedWorkspacesList: [...workspaceMocks.openedWorkspaces.values()],
    openWorkspace: workspaceMocks.openWorkspace,
    switchWorkspace: workspaceMocks.switchWorkspace,
  }),
}));

vi.mock('./CoworkExampleCards', () => ({
  default: () => null,
}));

vi.mock('@/app/scenes/my-agent/useAgentIdentityDocument', () => ({
  useAgentIdentityDocument: () => ({ document: { name: '' } }),
}));

// WelcomePanel now reads Git state through useGitState (which subscribes to
// the shared GitStateManager and participates in its 2 s polling interval)
// instead of hitting gitAPI directly. Return deterministic state so the
// render tests do not race against real timers or Tauri APIs.
vi.mock('@/tools/git/hooks/useGitState', () => ({
  useGitState: ({ repositoryPath, debugSource }: { repositoryPath: { workspaceId: string }; debugSource: string }) => {
    const workspaceId = repositoryPath.workspaceId;
    if (debugSource === 'welcome_panel') workspaceMocks.gitScopes.push(workspaceId);
    return {
    state: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    refreshBasic: vi.fn(),
    refreshStatus: vi.fn(),
    refreshDetailed: vi.fn(),
    isRepository: !!workspaceId,
    repositoryTrustRequired: false,
    currentBranch: workspaceId === 'workspace-2' ? 'feature/other' : 'main',
    ahead: 0,
    behind: 0,
    hasChanges: false,
    staged: [],
    unstaged: workspaceId === 'workspace-2' ? [{ path: 'changed.ts' }] : [],
    untracked: [],
    conflicts: [],
    branches: undefined,
    commits: undefined,
    };
  },
}));

function newDraft(): Session {
  return {
    sessionId: 'draft-session', mode: 'Standard', workspaceId: 'workspace-1',
    workspacePath: workspaceMocks.currentWorkspace.rootPath,
    config: { workspaceId: 'workspace-1' }, historyState: 'new', dialogTurns: [],
    status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
    draft: { workspaceId: 'workspace-1', phase: 'editing', turnId: 'first-turn' },
  };
}

/** Exercise the two real controls with the shared session selection adapter. */
function DraftWorkspaceSurfaces() {
  const [session, setSession] = useState(newDraft);
  const { selectedWorkspace, workspaceControl } = useSessionWorkspaceSelection(session);
  workspaceMocks.selectDraftWorkspace.mockImplementation((sessionId: string, workspaceId: string) => {
    expect(sessionId).toBe(session.sessionId);
    setSession(current => ({ ...current, draft: { ...current.draft!, workspaceId } }));
  });
  return <>
    <WelcomePanel key={`${session.sessionId}:${session.draft?.workspaceId ?? ''}`} session={session} />
    <ChatInputWorkspaceStrip workspaceId={workspaceControl.selectedId}
      repositoryPath={selectedWorkspace?.rootPath ?? ''} workspaceLabel={selectedWorkspace?.name ?? ''}
      workspaceControl={workspaceControl} />
    <output data-testid="canonical-workspace">{session.workspaceId}</output>
  </>;
}

describe('WelcomePanel Git summary loading', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMocks.selectDraftWorkspace.mockReset();
    workspaceMocks.gitScopes.length = 0;
    workspaceMocks.openedWorkspaces = new Map([
      ['workspace-1', workspaceMocks.currentWorkspace as WorkspaceInfo],
      ['workspace-2', { id: 'workspace-2', name: 'Other project', rootPath: 'D:/workspace/Other', workspaceKind: 'normal' } as WorkspaceInfo],
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    document.head.querySelector('style[data-welcome-appearance-test]')?.remove();
    document.documentElement.removeAttribute('data-openbitfun-appearance');
    document.documentElement.removeAttribute('data-openbitfun-appearance-revision');
    container.remove();
  });

  it('renders the git branch chip when a workspace is open', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode='Standard' />);
    });

    expect(container.querySelector('[data-openbitfun-product-part="workspaceAction"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="gitAction"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="gitAction"]')?.textContent).toContain('main');
  });

  it('does not render the retired panda mascot', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode="claw" workspacePath="D:/workspace/Assistant" />);
    });

    expect(container.querySelector('[data-openbitfun-product-part="mascot"]')).toBeNull();
    expect(container.querySelector('img[src^="/panda_full_"]')).toBeNull();
  });

  it('keeps the welcome copy, Git scope and strip selection in sync without activating a workspace', async () => {
    await act(async () => root.render(<DraftWorkspaceSurfaces />));
    const welcomeTrigger = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!;
    const stripTrigger = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-trigger"]')!;
    await act(async () => stripTrigger().click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-option-workspace-2"]')!.click());

    expect(welcomeTrigger().textContent).toContain('Other project');
    expect(welcomeTrigger().title).toBe('D:/workspace/Other');
    expect(stripTrigger().textContent).toContain('Other project');
    expect(container.querySelector('[data-openbitfun-product-part="gitAction"]')?.textContent).toContain('feature/other');
    expect(workspaceMocks.gitScopes.at(-1)).toBe('workspace-2');
    expect(container.querySelector('[data-openbitfun-product-part="narrative"]')?.textContent).toContain('welcome.waitingToStage');
    // A preview of B must not navigate to the shell's Git panel for A.
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="gitAction"]')?.disabled).toBe(true);

    await act(async () => welcomeTrigger().click());
    const menu = document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')!;
    expect(menu.textContent).not.toContain('header.newProject');
    expect(menu.querySelector('[aria-checked="true"]')?.textContent).toContain('Other project');
    await act(async () => menu.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceItem"]')!.click());

    expect(welcomeTrigger().textContent).toContain('OpenBitFun');
    expect(stripTrigger().textContent).toContain('OpenBitFun');
    expect(workspaceMocks.gitScopes.at(-1)).toBe('workspace-1');
    expect(container.querySelector('[data-testid="canonical-workspace"]')?.textContent).toBe('workspace-1');
    expect(workspaceMocks.selectDraftWorkspace.mock.calls).toEqual([
      ['draft-session', 'workspace-2'], ['draft-session', 'workspace-1'],
    ]);
    expect(workspaceMocks.switchWorkspace).not.toHaveBeenCalled();
    expect(workspaceMocks.openWorkspace).not.toHaveBeenCalled();
    expect(workspaceMocks.switchLeftPanelTab).not.toHaveBeenCalled();
  });

  it('closes the welcome selector when first submission binds the draft', async () => {
    const session = newDraft();
    await act(async () => root.render(<WelcomePanel session={session} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!.click());
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')).not.toBeNull();
    await act(async () => root.render(<WelcomePanel session={{ ...session, draft: { ...session.draft!, phase: 'creating' } }} />));
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')?.disabled).toBe(true);
    expect(workspaceMocks.switchWorkspace).not.toHaveBeenCalled();
  });

  it('shows an unavailable draft target without displaying the active project or its Git state', async () => {
    const session = newDraft();
    session.draft!.workspaceId = 'closed-workspace';
    await act(async () => root.render(<WelcomePanel session={session} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!;
    expect(trigger.textContent).toContain('workspaceStrip.unavailableLabel');
    expect(trigger.disabled).toBe(false);
    expect(container.querySelector('[data-openbitfun-product-part="gitAction"]')).toBeNull();
    expect(workspaceMocks.gitScopes.at(-1)).toBe('');
  });

  it('keeps an existing empty session bound to its own workspace', async () => {
    const session = { ...newDraft(), draft: undefined, workspaceId: 'workspace-2' };
    await act(async () => root.render(<WelcomePanel session={session} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!;
    expect(trigger.textContent).toContain('Other project');
    expect(trigger.disabled).toBe(true);
    expect(workspaceMocks.gitScopes.at(-1)).toBe('workspace-2');
  });

  it('portals the workspace menu outside the scrollable welcome panel', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode='Standard' />);
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]');
    expect(trigger?.getAttribute('data-openbitfun-component')).toBe('button');
    expect(trigger?.querySelector('[data-overflow-behavior]')).toBeNull();
    await act(async () => trigger?.querySelector<HTMLElement>('[data-openbitfun-part="label"]')?.click());

    const menu = document.querySelector<HTMLElement>('[data-openbitfun-product-part="workspaceMenu"]');
    expect(menu?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(menu?.style.visibility).toBe('visible');

    await act(async () => trigger?.querySelector<HTMLElement>('[data-openbitfun-part="trailing-icon"]')?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')).toBeNull();
  });

  it('keeps saved welcome action styles targeting the migrated Button', async () => {
    const legacyPackage: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.welcome', name: 'Welcome', version: '1.0.0', mode: 'dark',
      components: {
        'welcome-panel': { parts: {
          workspaceAction: { base: { opacity: { kind: 'number', value: 0.6 } } },
        } },
      },
    };
    const serialized = JSON.stringify(legacyPackage);
    const restored = JSON.parse(serialized) as AppearancePackage;
    const registry = new AppearanceRegistry().registerComponent(welcomePanelAppearanceDescriptor);
    const snapshot = new AppearanceCompiler(registry).compile(restored, 1);
    expect(JSON.stringify(restored)).toBe(serialized);
    document.documentElement.setAttribute('data-openbitfun-appearance', snapshot.id);
    document.documentElement.setAttribute('data-openbitfun-appearance-revision', String(snapshot.revision));
    const style = document.createElement('style');
    style.setAttribute('data-welcome-appearance-test', '');
    style.textContent = snapshot.cssText;
    document.head.appendChild(style);

    await act(async () => root.render(<WelcomePanel sessionMode="Standard" />));

    const rule = Array.from(style.sheet!.cssRules).find(candidate =>
      candidate instanceof CSSStyleRule && candidate.style.opacity === '0.6',
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(document.querySelector(rule!.selectorText)).toBe(
      container.querySelector('[data-openbitfun-product-part="workspaceAction"]'),
    );
  });
});
