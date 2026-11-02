// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import { WelcomeModeSelector, WelcomePanel } from './WelcomePanel';
import { welcomePanelAppearanceDescriptor } from './WelcomePanel.appearance';
import { ChatInputWorkspaceStrip } from './ChatInputWorkspaceStrip';
import { useSessionWorkspaceSelection } from '../hooks/useSessionWorkspaceSelection';
import type { Session } from '../types/flow-chat';
import type { WorkspaceInfo } from '@/shared/types';
import { FlowChatStore } from '../store/FlowChatStore';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { chatInputModePreferenceService } from '../services/ChatInputModePreferenceService';
import type { HarnessId } from '@/shared/agents/identity';
import * as deviceSurface from '@/infrastructure/peer-device/deviceSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const gitApiMock = vi.hoisted(() => ({
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getRepositoryBasic: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  hasWorkspace: true,
  currentWorkspace: { id: 'workspace-1', name: 'OpenBitFun', rootPath: 'D:/workspace/OpenBitFun', workspaceKind: 'normal' },
  openedWorkspaces: new Map<string, WorkspaceInfo>(),
  selectDraftWorkspace: vi.fn(),
  createChatDraft: vi.fn(),
  openMainSession: vi.fn(),
  openWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
  switchLeftPanelTab: vi.fn(),
  gitScopes: [] as string[],
}));

vi.mock('../services/FlowChatManager', () => ({
  FlowChatManager: { getInstance: () => workspaceMocks },
}));

vi.mock('../services/sessionActivation', () => ({
  openMainSession: workspaceMocks.openMainSession,
  activateMainSession: vi.fn(),
}));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  const { createInstance } = await import('i18next');
  const { default: copy } = await import('@/locales/zh-CN/flow-chat.json');
  const { default: sharedCopy } = await import('../../../../shared/i18n/resources/shared/zh-CN/terms.json');
  const i18n = createInstance();
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { 'flow-chat': copy, shared: sharedCopy } },
    defaultNS: 'flow-chat',
    interpolation: { escapeValue: false },
  });
  return {
    ...actual,
    initReactI18next: { type: '3rdParty', init: () => {} },
    Trans: (props: React.ComponentProps<typeof actual.Trans>) => (
      <actual.Trans {...props} i18n={i18n} t={i18n.getFixedT('zh-CN', 'flow-chat')} />
    ),
    useTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) => key.startsWith('shared:agents.')
        ? i18n.t(key) : values?.count ?? key,
    }),
  };
});

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
    hasWorkspace: workspaceMocks.hasWorkspace,
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

// The composer still reads Git state; the welcome panel must not subscribe.
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

/** Keep draft selection in the composer while the welcome panel is visible. */
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

describe('WelcomePanel empty session presentation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMocks.hasWorkspace = true;
    workspaceMocks.selectDraftWorkspace.mockReset();
    workspaceMocks.createChatDraft.mockResolvedValue('selected-workspace-draft');
    workspaceMocks.openMainSession.mockReset();
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the caption measured and mounted while inline modes expand and the pane resizes', async () => {
    let captionWidth = 248;
    let notifyResize = () => {};
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('welcome-panel__caption-content')
        ? new DOMRect(0, 0, captionWidth, 32) : originalRect.call(this);
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    await act(async () => root.render(<WelcomePanel session={newDraft()} />));
    const caption = container.querySelector<HTMLElement>('[data-openbitfun-product-part="caption"]')!;
    const workspaceTrigger = container.querySelector('[data-openbitfun-product-part="workspaceAction"]');
    expect(caption.style.getPropertyValue('--_welcome-caption-width')).toBe('248px');
    const mode = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="modeOption"][aria-pressed="true"]')!;
    await act(async () => mode.click());
    expect(caption.getAttribute('aria-hidden')).toBe('true');
    captionWidth = 180;
    act(() => notifyResize());
    expect(caption.style.getPropertyValue('--_welcome-caption-width')).toBe('180px');
    await act(async () => {
      mode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(caption.getAttribute('aria-hidden')).toBe('false');
    expect(container.querySelector('[data-openbitfun-product-part="caption"]')).toBe(caption);
    expect(container.querySelector('[data-openbitfun-product-part="workspaceAction"]')).toBe(workspaceTrigger);
  });

  it('expands four named modes and gathers the same icons around the new selection', async () => {
    const onSelect = vi.fn();
    function Modes() {
      const [profile, setProfile] = useState<HarnessId>('Standard');
      return <WelcomeModeSelector profile={profile} disabled={false} pending={false}
        onSelect={next => { onSelect(next); setProfile(next); }} />;
    }
    await act(async () => root.render(<Modes />));
    const modeButtons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-product-part="modeOption"]')];
    const originalButtons = modeButtons();
    const choices = () => container.querySelector('[data-openbitfun-product-part="modeChoices"]')!;
    expect(originalButtons.filter(button => !button.disabled).map(button => button.textContent)).toEqual(['标准']);
    await act(async () => originalButtons[1].click());
    expect(choices().getAttribute('data-expanded')).toBe('true');
    expect(modeButtons().map(button => button.textContent)).toEqual(['极简', '标准', '极致', '创造']);
    expect(modeButtons().every(button => !button.disabled)).toBe(true);
    expect(modeButtons()).toEqual(originalButtons);
    await act(async () => originalButtons[3].click());
    expect(onSelect).toHaveBeenCalledWith('Creative');
    expect(choices().getAttribute('data-expanded')).toBe('false');
    expect(modeButtons()).toEqual(originalButtons);
    expect(modeButtons().filter(button => !button.disabled).map(button => button.textContent)).toEqual(['创造']);
  });

  it('opens modes with arrow keys and returns focus on Escape', async () => {
    await act(async () => root.render(<WelcomeModeSelector profile="Standard" disabled={false} pending={false} onSelect={vi.fn()} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-product-part="modeOption"]')];
    act(() => buttons[1].focus());
    await act(async () => {
      buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[2]);
    await act(async () => {
      buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(container.querySelector('[data-expanded="true"]')).toBeNull();
  });

  it.each([true, false])('commits an explicit mode to the owning session (draft=%s)', async draft => {
    const initialSession: Session = {
      ...newDraft(),
      ...(draft ? {} : { draft: undefined }),
      remoteConnectionId: 'ssh-host', remoteSshHost: 'dev-host',
      projectWorkspacePath: '/projects/owned',
    };
    let liveSession = initialSession;
    let publish: (mode: string) => void = () => {};
    function SessionSurface() {
      const [current, setCurrent] = useState(initialSession);
      liveSession = current;
      publish = mode => setCurrent(value => ({ ...value, mode }));
      return <WelcomePanel session={current} />;
    }
    const store = FlowChatStore.getInstance();
    const initialState = store.getState();
    vi.spyOn(store, 'getState').mockImplementation(() => ({
      ...initialState, sessions: new Map([[liveSession.sessionId, liveSession]]),
    }));
    const update = vi.spyOn(store, 'updateSessionMode').mockImplementation((_id, mode) => publish(mode));
    const hostUpdate = vi.spyOn(agentAPI, 'updateSessionMode').mockResolvedValue(undefined);
    const remember = vi.spyOn(chatInputModePreferenceService, 'rememberMode').mockResolvedValue({
      strategy: 'follow_last', fixedModeId: null, lastModeId: 'Ultimate',
    });
    await act(async () => root.render(<SessionSurface />));
    const caption = container.querySelector('[data-openbitfun-product-part="caption"]')!;
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-product-part="modeOption"]')];
    await act(async () => buttons[1].click());
    expect(caption.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-openbitfun-product-part="greeting"]')?.getAttribute('data-mode-expanded')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')?.disabled).toBe(true);
    await act(async () => buttons[2].click());
    expect(update).toHaveBeenCalledWith('draft-session', 'Ultimate');
    expect(remember).toHaveBeenCalledWith('Ultimate');
    expect(container.querySelector('[data-expanded="true"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="caption"]')).toBe(caption);
    expect(caption.getAttribute('aria-hidden')).toBe('false');
    if (draft) {
      expect(hostUpdate).not.toHaveBeenCalled();
    } else {
      expect(hostUpdate).toHaveBeenCalledWith({
        sessionId: 'draft-session', modeId: 'Ultimate', workspacePath: '/projects/owned',
        remoteConnectionId: 'ssh-host', remoteSshHost: 'dev-host',
      });
    }
  });

  it('does not apply a mode click captured on a previous device surface', async () => {
    let currentSurface = true;
    const scope = deviceSurface.getActiveSurfaceScope();
    vi.spyOn(deviceSurface, 'getActiveSurfaceScope').mockReturnValue({ ...scope, isCurrent: () => currentSurface });
    const update = vi.spyOn(FlowChatStore.getInstance(), 'updateSessionMode');
    await act(async () => root.render(<WelcomePanel session={newDraft()} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-product-part="modeOption"]')];
    await act(async () => buttons[1].click());
    currentSurface = false;
    await act(async () => buttons[2].click());
    expect(update).not.toHaveBeenCalled();
  });

  it('includes the project in the greeting without the workspace and Git summary', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode="Standard" />);
    });

    expect(container.querySelector('[data-openbitfun-product-part="heading"]')?.textContent).toBe('在 OpenBitFun，开工。');
    expect(container.querySelector('[data-openbitfun-product-part="narrative"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="divider"]')).toBeNull();
    expect(container.querySelector('.welcome-panel__details')).toBeNull();
    expect(workspaceMocks.gitScopes).toEqual([]);
    expect(gitApiMock.getStatus).not.toHaveBeenCalled();
  });

  it('does not render the retired panda mascot', async () => {
    await act(async () => {
      root.render(<WelcomePanel sessionMode="claw" workspacePath="D:/workspace/Assistant" />);
    });

    expect(container.querySelector('[data-openbitfun-product-part="mascot"]')).toBeNull();
    expect(container.querySelector('img[src^="/panda_full_"]')).toBeNull();
  });

  it('keeps the welcome selector and composer in sync without activating a workspace', async () => {
    await act(async () => root.render(<DraftWorkspaceSurfaces />));
    const welcomeTrigger = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!;
    const stripTrigger = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-trigger"]')!;
    expect(welcomeTrigger().textContent).toBe('OpenBitFun');
    expect(welcomeTrigger().querySelector('[data-openbitfun-part="trailing-icon"]')).toBeNull();
    await act(async () => {
      container.querySelector('[data-openbitfun-product-part="heading"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')).toBeNull();
    await act(async () => welcomeTrigger().click());
    const menu = document.querySelector<HTMLElement>('[data-openbitfun-product-part="workspaceMenu"]')!;
    expect(container.contains(menu)).toBe(false);
    expect(menu.closest('[data-openbitfun-overlay-host]')).not.toBeNull();
    const otherProject = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(item => item.textContent?.includes('Other project'))!;
    await act(async () => otherProject.click());

    expect(stripTrigger().textContent).toContain('Other project');
    expect(container.querySelector('[data-openbitfun-product-part="heading"]')?.textContent).toBe('在 Other project，开工。');
    expect(container.querySelector('[data-openbitfun-product-part="narrative"]')).toBeNull();
    expect(workspaceMocks.gitScopes).toEqual([]);
    expect(container.querySelector('[data-testid="canonical-workspace"]')?.textContent).toBe('workspace-1');
    expect(workspaceMocks.selectDraftWorkspace.mock.calls).toEqual([
      ['draft-session', 'workspace-2'],
    ]);
    await act(async () => stripTrigger().click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="chat-input-workspace-option-workspace-1"]')!.click());
    expect(welcomeTrigger().textContent).toContain('OpenBitFun');
    expect(workspaceMocks.selectDraftWorkspace.mock.calls).toEqual([
      ['draft-session', 'workspace-2'], ['draft-session', 'workspace-1'],
    ]);
    expect(workspaceMocks.switchWorkspace).not.toHaveBeenCalled();
    expect(workspaceMocks.openWorkspace).not.toHaveBeenCalled();
    expect(workspaceMocks.switchLeftPanelTab).not.toHaveBeenCalled();
  });

  it('does not substitute the active project for an unavailable draft target', async () => {
    const session = newDraft();
    session.draft!.workspaceId = 'closed-workspace';
    await act(async () => root.render(<WelcomePanel session={session} />));

    expect(container.querySelector('[data-openbitfun-product-part="narrative"]')).toBeNull();
    expect(container.textContent).not.toContain('OpenBitFun');
    expect(workspaceMocks.gitScopes).toEqual([]);
  });

  it('allows an existing empty session to enter another workspace without changing its owner', async () => {
    const session = { ...newDraft(), draft: undefined, workspaceId: 'workspace-2' };
    workspaceMocks.openMainSession.mockImplementation(async (_id, options) => {
      await options.activateWorkspace(options.workspaceId);
    });
    await act(async () => root.render(<WelcomePanel session={session} />));

    expect(container.querySelector('[data-openbitfun-product-part="narrative"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="heading"]')?.textContent).toBe('在 Other project，开工。');
    const trigger = container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!;
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    const menu = document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')!;
    const option = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(item => item.textContent?.includes('OpenBitFun'))!;
    await act(async () => option.click());
    expect(workspaceMocks.createChatDraft).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', workspacePath: 'D:/workspace/OpenBitFun',
    }, 'Standard');
    expect(workspaceMocks.openMainSession).toHaveBeenCalledWith('selected-workspace-draft', {
      workspaceId: 'workspace-1', activateWorkspace: expect.any(Function), isCurrent: expect.any(Function),
    });
    expect(workspaceMocks.switchWorkspace).toHaveBeenCalledWith(workspaceMocks.currentWorkspace);
    expect(workspaceMocks.selectDraftWorkspace).not.toHaveBeenCalled();
    expect(session.workspaceId).toBe('workspace-2');
    expect(workspaceMocks.gitScopes).toEqual([]);
  });

  it('opens the shared project directory flow for other local or remote sources', async () => {
    const onNewProject = vi.fn();
    window.addEventListener('nav:new-project', onNewProject);
    try {
      await act(async () => root.render(<WelcomePanel session={newDraft()} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!.click());
      const menu = document.querySelector('[data-openbitfun-product-part="workspaceMenu"]')!;
      const openOther = [...menu.querySelectorAll<HTMLButtonElement>('button')]
        .find(item => item.textContent?.includes('welcome.openOtherProject'))!;
      await act(async () => openOther.click());
      expect(onNewProject).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.openWorkspace).not.toHaveBeenCalled();
      expect(workspaceMocks.selectDraftWorkspace).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('nav:new-project', onNewProject);
    }
  });

  it('closes and locks the directory menu when submission starts', async () => {
    const session = newDraft();
    await act(async () => root.render(<WelcomePanel session={session} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')!.click());
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
    await act(async () => root.render(<WelcomePanel session={{ ...session, draft: { ...session.draft!, phase: 'creating' } }} />));
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-product-part="workspaceAction"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-openbitfun-product-part="workspaceMenu"][data-state="open"]')).toBeNull();
    expect(workspaceMocks.selectDraftWorkspace).not.toHaveBeenCalled();
  });

  it('keeps saved open-workspace action styles targeting the Button', async () => {
    const legacyPackage: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.welcome', name: 'Welcome', version: '1.0.0', mode: 'dark',
      components: {
        'welcome-panel': { parts: {
          openWorkspaceAction: { base: { opacity: { kind: 'number', value: 0.6 } } },
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

    workspaceMocks.hasWorkspace = false;
    await act(async () => root.render(<WelcomePanel sessionMode="Standard" />));

    expect(container.textContent).toContain('welcome.noWorkspaceHint');
    const rule = Array.from(style.sheet!.cssRules).find(candidate =>
      candidate instanceof CSSStyleRule && candidate.style.opacity === '0.6',
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(document.querySelector(rule!.selectorText)).toBe(
      container.querySelector('[data-openbitfun-product-part="openWorkspaceAction"]'),
    );
  });
});
