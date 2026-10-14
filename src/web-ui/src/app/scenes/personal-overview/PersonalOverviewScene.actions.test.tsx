/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useAgentsStore } from '../agents/agentsStore';
import { useSkillsSceneStore } from '../skills/skillsSceneStore';
import { useNurseryStore } from '../profile/nurseryStore';
import PersonalOverviewScene from './PersonalOverviewScene';

const mocks = vi.hoisted(() => ({
  openScene: vi.fn(), createAssistant: vi.fn(), createMiniApp: vi.fn(), error: vi.fn(),
  tabs: [],
}));
vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: Object.assign((selector: (state: unknown) => unknown) => selector({ openTabs: mocks.tabs }), {
    getState: () => ({ openScene: mocks.openScene }),
  }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ assistantWorkspaces: [{ id: 'assistant-1' }], loading: false, createAssistantWorkspace: mocks.createAssistant }),
}));
vi.mock('@/infrastructure/account-identity/useAccountIdentity', () => ({ useAccountIdentity: () => ({ resolved: true, status: 'signed-out', me: null }) }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String, resolvedTimeZone: 'Asia/Shanghai', currentLanguage: 'en-US' }),
}));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('@openbitfun/ui/brand', () => ({ useSubagentAvatarMotion: () => undefined }));
vi.mock('./OverviewAccountButton', () => ({ OverviewAccountButton: () => null }));
vi.mock('@/infrastructure/config/components/UsageActivityGrid', () => ({ UsageActivityGrid: () => null }));
vi.mock('../miniapps/hooks/useMiniAppCreation', () => ({ useMiniAppCreation: () => ({ creating: false, createMiniApp: mocks.createMiniApp }) }));
vi.mock('./usePersonalOverview', () => ({
  usePersonalOverview: () => ({
    usage: { status: 'loading' },
    agents: { status: 'ready', data: [{ source: 'builtin' }, { source: 'user' }] },
    miniApps: { status: 'ready', data: { apps: [], runningWorkerIds: [] } },
    skills: { status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: true } },
    refresh: vi.fn(),
  }),
}));

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => { root.render(<PersonalOverviewScene />); });
const click = (id: string) => act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  useAgentsStore.setState(useAgentsStore.getInitialState(), true);
  useSkillsSceneStore.setState(useSkillsSceneStore.getInitialState(), true);
  useNurseryStore.setState(useNurseryStore.getInitialState(), true);
  mocks.openScene.mockReset();
  mocks.createAssistant.mockReset().mockResolvedValue({ id: 'new-assistant' });
  mocks.createMiniApp.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
});

describe('overview catalog actions', () => {
  it('combines built-in and custom agents in one card and opens the full catalog', async () => {
    useAgentsStore.setState({ agentFilterLevel: 'builtin', agentFilterType: 'subagent', searchQuery: 'old' });
    await render();
    expect(container.querySelectorAll('.personal-overview__agent')).toHaveLength(2);
    expect(container.querySelector('[data-testid="personal-overview-agents"] .personal-overview__agent-count')?.textContent).toBe('2');
    await click('personal-overview-agents');
    expect(useAgentsStore.getState()).toMatchObject({ page: 'home', agentFilterLevel: 'all', agentFilterType: 'all', searchQuery: '' });
    expect(mocks.openScene).toHaveBeenCalledWith('agents');
  });

  it('opens the agent editor and the native skill addition form through their existing stores', async () => {
    await render();
    await click('personal-overview-create-agent');
    expect(useAgentsStore.getState().page).toBe('createAgent');
    useSkillsSceneStore.getState().openNativeSkills('discover');
    await click('personal-overview-add-skill');
    expect(useSkillsSceneStore.getState()).toMatchObject({ nativeNavigationTarget: 'installed', isAddFormOpen: true });
    expect(mocks.openScene).toHaveBeenLastCalledWith('skills');
  });

  it('creates an assistant then opens its own configuration and can return to the gallery', async () => {
    await render();
    await click('personal-overview-create-assistant');
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(useNurseryStore.getState()).toMatchObject({ page: 'assistant', activeWorkspaceId: 'new-assistant' });
    expect(mocks.openScene).toHaveBeenCalledWith('assistant');
    await click('personal-overview-assistants');
    expect(useNurseryStore.getState().page).toBe('gallery');
  });

  it('does not navigate to an assistant created on a previous device surface', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await click('personal-overview-create-assistant');
    await act(async () => { activateSurface('peer-host'); finish({ id: 'old-assistant' }); });
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
  });

  it('starts MiniApp creation through the shared entry', async () => {
    await render();
    await click('personal-overview-create-miniapp');
    expect(mocks.createMiniApp).toHaveBeenCalledOnce();
  });
});
