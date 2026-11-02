/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { ConfirmDialogRenderer, useConfirmDialogStore } from '@/infrastructure/confirm-dialog';
import { useAgentsStore } from '../agents/agentsStore';
import { useSkillsSceneStore } from '../skills/skillsSceneStore';
import { useNurseryStore } from '../profile/nurseryStore';
import PersonalOverviewScene from './PersonalOverviewScene';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type { SceneTab } from '@/app/components/SceneBar/types';

const mocks = vi.hoisted(() => ({
  openScene: vi.fn(), createAssistant: vi.fn(), createMiniApp: vi.fn(), error: vi.fn(),
  addSkill: vi.fn(), refresh: vi.fn(), resetSkillForm: vi.fn(), skillFormOptions: vi.fn(),
  createAgent: vi.fn(), updateAgent: vi.fn(), getAgentDetail: vi.fn(), success: vi.fn(),
  desktop: true, remotePeer: false,
  tabs: [] as SceneTab[],
  runningWorkerIds: [] as string[],
  miniAppsStatus: 'ready' as 'ready' | 'loading' | 'failed',
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  miniApps: [] as MiniAppMeta[],
}));
vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: Object.assign((selector: (state: unknown) => unknown) => selector({ openTabs: mocks.tabs }), {
    getState: () => ({ openScene: mocks.openScene }),
  }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ assistantWorkspaces: [{ id: 'assistant-1' }], loading: false, createAssistantWorkspace: mocks.createAssistant }),
  useCurrentWorkspace: () => ({ workspace: { id: 'workspace-1', rootPath: '/project' }, hasWorkspace: true }),
}));
vi.mock('@/infrastructure/account-identity/useAccountIdentity', () => ({ useAccountIdentity: () => ({ resolved: true, status: 'signed-out', me: null }) }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: mocks.t, formatNumber: String, resolvedTimeZone: 'Asia/Shanghai', currentLanguage: 'en-US' }),
}));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error, success: mocks.success }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('@openbitfun/ui/brand', () => ({ useSubagentAvatarMotion: () => undefined }));
vi.mock('./OverviewAccountButton', () => ({ OverviewAccountButton: () => null }));
vi.mock('@/infrastructure/config/components/UsageActivityGrid', () => ({ UsageActivityGrid: () => null }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async original => ({
  ...await original<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: async () => ({ device_id: 'local', device_name: 'Workstation', mac_address: '' }) },
}));
vi.mock('../miniapps/hooks/useMiniAppCreation', () => ({ useMiniAppCreation: () => ({ creating: false, createMiniApp: mocks.createMiniApp }) }));
vi.mock('../miniapps/MiniAppGalleryScene', () => ({
  default: ({ initialDetailApp, onDetailBack, detailBackLabel }: any) => (
    <section data-testid="overview-miniapp-detail">
      <h1>{initialDetailApp.name}</h1>
      <button onClick={onDetailBack}>{detailBackLabel}</button>
    </section>
  ),
}));
vi.mock('@/infrastructure/api/service-api/CustomAgentAPI', () => ({
  CustomAgentAPI: { createCustomAgent: mocks.createAgent, updateCustomAgent: mocks.updateAgent, getCustomAgentDetail: mocks.getAgentDetail },
}));
vi.mock('@/infrastructure/api/service-api/ToolAPI', () => ({ toolAPI: { getAllToolsInfo: async () => [] } }));
vi.mock('../agents/components/useUserToolGroups', () => ({ useUserToolGroups: () => ({ groups: [], saveGroups: vi.fn() }) }));
vi.mock('../agents/components/ToolGroupPicker', () => ({ ToolGroupPicker: () => null, ToolGroupSummary: () => null }));
vi.mock('@/infrastructure/runtime', async original => ({
  ...await original<typeof import('@/infrastructure/runtime')>(),
  isTauriRuntime: () => mocks.desktop,
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', async original => ({
  ...await original<typeof import('@/infrastructure/peer-device/peerDeviceContextState')>(),
  usePeerDeviceModeOptional: () => ({ peerMode: mocks.remotePeer ? { active: true, deviceId: 'peer', deviceName: 'Peer' } : { active: false } }),
}));
vi.mock('../skills/hooks/useInstalledSkills', () => ({
  useInstalledSkills: (options: unknown) => {
    mocks.skillFormOptions(options);
    return {
      catalogContextKey: 'local-workspace', formLevel: 'user', formPath: '/skills/test',
      hasWorkspace: true, isRemoteWorkspace: false, workspacePath: '/project',
      validationResult: { valid: true, name: 'test-skill' }, isValidating: false, isAdding: false,
      setFormLevel: vi.fn(), setFormPath: vi.fn(), handleBrowse: vi.fn(),
      handleAdd: mocks.addSkill, resetForm: mocks.resetSkillForm,
    };
  },
}));
vi.mock('./usePersonalOverview', () => ({
  usePersonalOverview: () => ({
    usage: { status: 'loading' },
    agents: { status: 'ready', data: [{ source: 'builtin' }, { source: 'user' }] },
    miniApps: mocks.miniAppsStatus === 'ready'
      ? { status: 'ready', data: { apps: mocks.miniApps, runningWorkerIds: mocks.runningWorkerIds } }
      : { status: mocks.miniAppsStatus },
    skills: { status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: true } },
    refresh: mocks.refresh,
  }),
}));

let root: Root;
let container: HTMLDivElement;
const render = (isActive = true) => act(async () => {
  root.render(<><PersonalOverviewScene isActive={isActive} /><ConfirmDialogRenderer /></>);
});
const click = async (id: string) => {
  await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
  await act(async () => { await vi.dynamicImportSettled(); });
};
const clickDialogButton = (label: string) => act(async () => {
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === label)!.click();
});
const answerAssistantConfirmation = (confirm: boolean) => act(async () => {
  const label = confirm ? 'agents.createAssistant' : 'dialog.confirm.cancel';
  [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === label)!.click();
});
const fillAgentField = async (field: string, value: string, scope: ParentNode = document.querySelector('[role="dialog"]')!) => {
  if (field === 'prompt') {
    await act(async () => { await vi.dynamicImportSettled(); });
    const editor = scope.querySelector<HTMLElement & { editor: Editor }>('[id$="custom-agent-prompt"] .ProseMirror')!.editor;
    act(() => editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
    }));
    return;
  }
  await act(async () => {
    const control = scope.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id$="custom-agent-${field}"]`)!;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  resetDeviceSurfaceForTest();
  useConfirmDialogStore.setState({ isOpen: false, options: null, resolve: null });
  useAgentsStore.setState(useAgentsStore.getInitialState(), true);
  useSkillsSceneStore.setState(useSkillsSceneStore.getInitialState(), true);
  useNurseryStore.setState(useNurseryStore.getInitialState(), true);
  mocks.openScene.mockReset();
  mocks.miniApps = [];
  mocks.tabs = [];
  mocks.runningWorkerIds = [];
  mocks.miniAppsStatus = 'ready';
  mocks.t.mockClear();
  mocks.createAssistant.mockReset().mockResolvedValue({ id: 'new-assistant' });
  mocks.createMiniApp.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  mocks.success.mockReset();
  mocks.createAgent.mockReset().mockResolvedValue(undefined);
  mocks.updateAgent.mockReset();
  mocks.getAgentDetail.mockReset();
  mocks.addSkill.mockReset().mockResolvedValue(true);
  mocks.refresh.mockReset();
  mocks.resetSkillForm.mockReset();
  mocks.skillFormOptions.mockReset();
  mocks.desktop = true;
  mocks.remotePeer = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { useConfirmDialogStore.getState().cancel(); });
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
  vi.unstubAllGlobals();
});

describe('overview catalog actions', () => {
  it('combines built-in and custom agents in one card and opens the full catalog', async () => {
    useAgentsStore.setState({ agentFilterLevel: 'builtin', agentFilterType: 'subagent', searchQuery: 'old' });
    await render();
    expect(container.querySelectorAll('[data-openbitfun-part="agents"] .overview-split-card__pane')).toHaveLength(2);
    expect(container.querySelector('[data-testid="personal-overview-agents"] .overview-split-card__value')?.textContent).toBe('2');
    await click('personal-overview-agents');
    expect(useAgentsStore.getState()).toMatchObject({ page: 'home', agentFilterLevel: 'all', agentFilterType: 'all', searchQuery: '' });
    expect(mocks.openScene).toHaveBeenCalledWith('agents');
  });

  it('creates an agent in a home-page dialog without changing an existing agent editor', async () => {
    useAgentsStore.getState().openEditAgent('existing-agent');
    const agentsState = useAgentsStore.getState();
    await render();
    await click('personal-overview-create-agent');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('agentsOverview.form.title');
    expect(mocks.getAgentDetail).not.toHaveBeenCalled();
    expect(useAgentsStore.getState()).toBe(agentsState);
    expect(mocks.openScene).not.toHaveBeenCalled();
    await fillAgentField('name', 'New agent');
    await fillAgentField('description', 'A new agent');
    await clickDialogButton('agentsOverview.form.wizard.next');
    await fillAgentField('prompt', 'Help with the task.');
    const contextControls = document.querySelector('[role="dialog"] .th-create-panel__context-options')!;
    expect(contextControls.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    await clickDialogButton('agentsOverview.form.contextWorkspaceContext');
    await clickDialogButton('agentsOverview.form.contextProjectLayout');
    await clickDialogButton('agentsOverview.form.wizard.next');
    await clickDialogButton('agentsOverview.form.submit');
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^agent-[a-f0-9]{8}$/), kind: 'mode', description: 'A new agent', prompt: 'Help with the task.',
      userContextPolicy: ['workspace_instructions', 'project_layout'],
    }));
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useAgentsStore.getState()).toBe(agentsState);
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it('cancels agent creation on the home page without opening the Agents scene', async () => {
    await render();
    await click('personal-overview-create-agent');
    await clickDialogButton('agentsOverview.form.cancel');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it('submits the full-page form from its footer and retains the action label while saving', async () => {
    const { default: CreateAgentPage } = await import('../agents/components/CreateAgentPage');
    let finish!: () => void;
    mocks.createAgent.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { root.render(<CreateAgentPage />); });
    for (const [field, value] of [['name', 'Page agent'], ['description', 'Page agent'], ['prompt', 'Original prompt']]) {
      await fillAgentField(field, value, container);
    }
    const submit = container.querySelector<HTMLButtonElement>('.th-create-page__footer button[type="submit"]')!;
    await act(async () => { submit.click(); });
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^agent-[a-f0-9]{8}$/), name: 'Page agent', prompt: 'Original prompt' }));
    expect(submit.textContent).toBe('agentsOverview.form.submit');
    expect(submit.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish(); });
    expect(mocks.success).toHaveBeenCalledOnce();
  });

  it('does not close a replacement device form when an old agent creation finishes', async () => {
    let finish!: () => void;
    mocks.createAgent.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await click('personal-overview-create-agent');
    await fillAgentField('name', 'Old agent');
    await fillAgentField('description', 'Created on the original device');
    await clickDialogButton('agentsOverview.form.wizard.next');
    await fillAgentField('prompt', 'Original task');
    await clickDialogButton('agentsOverview.form.wizard.next');
    await clickDialogButton('agentsOverview.form.submit');
    expect(mocks.createAgent).toHaveBeenCalledOnce();
    await act(async () => { activateSurface('peer-host'); });
    await act(async () => { finish(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] [id$="custom-agent-id"]')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] [id$="custom-agent-name"]')?.value).toBe('');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it('adds a skill in a home-page dialog without opening or changing the Skills scene', async () => {
    useSkillsSceneStore.getState().openNativeSkills('discover');
    const skillsState = useSkillsSceneStore.getState();
    await render();
    await click('personal-overview-add-skill');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('form.title');
    expect(useSkillsSceneStore.getState()).toBe(skillsState);
    expect(mocks.openScene).not.toHaveBeenCalled();
    await clickDialogButton('form.actions.add');
    expect(mocks.addSkill).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it('cancels skill addition on the home page and ignores completion after leaving it', async () => {
    await render();
    await click('personal-overview-add-skill');
    await clickDialogButton('form.actions.cancel');
    expect(mocks.resetSkillForm).toHaveBeenCalledOnce();
    expect(mocks.addSkill).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    let finish!: (added: boolean) => void;
    mocks.addSkill.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await click('personal-overview-add-skill');
    await clickDialogButton('form.actions.add');
    await render(false);
    await act(async () => { finish(true); });
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it.each([
    { desktop: false, remotePeer: false, message: 'list.desktopUnavailable' },
    { desktop: true, remotePeer: true, message: 'list.remoteUnavailable' },
  ])('keeps the unsupported $message state in the dialog', async ({ desktop, remotePeer, message }) => {
    mocks.desktop = desktop;
    mocks.remotePeer = remotePeer;
    await render();
    await click('personal-overview-add-skill');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(message);
    expect(mocks.skillFormOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(mocks.addSkill).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
  });

  it('requires confirmation before creating an assistant and opening its configuration', async () => {
    await render();
    await click('personal-overview-create-assistant');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('agents.createAssistantConfirmMessage');
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
    await answerAssistantConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(useNurseryStore.getState()).toMatchObject({ page: 'assistant', activeWorkspaceId: 'new-assistant' });
    expect(mocks.openScene).toHaveBeenCalledWith('assistant');
    await click('personal-overview-assistants');
    expect(useNurseryStore.getState().page).toBe('gallery');
  });

  it('cancels assistant creation without creating or navigating and allows retry', async () => {
    await render();
    await click('personal-overview-create-assistant');
    await answerAssistantConfirmation(false);
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
    await click('personal-overview-create-assistant');
    await answerAssistantConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
  });

  it('does not create an assistant if the device changes while confirmation is open', async () => {
    await render();
    await click('personal-overview-create-assistant');
    await act(async () => { activateSurface('peer-host'); });
    await answerAssistantConfirmation(true);
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('creates only once when the entry and confirmation are clicked repeatedly', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-create-assistant"]')!;
      button.click();
      button.click();
    });
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    await act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'agents.createAssistant')!;
      button.click();
      button.click();
    });
    await click('personal-overview-create-assistant');
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    await act(async () => { finish({ id: 'new-assistant' }); });
    expect(mocks.openScene).toHaveBeenCalledOnce();
  });

  it('does not navigate to an assistant created on a previous device surface', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await click('personal-overview-create-assistant');
    await answerAssistantConfirmation(true);
    await act(async () => { activateSurface('peer-host'); finish({ id: 'old-assistant' }); });
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
  });

  it('starts MiniApp creation through the shared entry', async () => {
    await render();
    await click('personal-overview-create-miniapp');
    expect(mocks.createMiniApp).toHaveBeenCalledOnce();
  });

  it('opens homepage cards in details and keeps a separate launch icon', async () => {
    mocks.miniApps = [{ id: 'notes', name: 'Notes', description: 'Write notes', icon: 'box',
      category: 'utilities', tags: [], version: 1, permissions: {}, created_at: 1, updated_at: 1 }];
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="personal-overview-installed-miniapp"]')!;
    const card = trigger.closest('[data-openbitfun-component="action-card"]')!;
    const launch = card.querySelector<HTMLButtonElement>('[aria-label="miniApps.start"]')!;
    expect(card.querySelectorAll('[data-openbitfun-part="actions"] button')).toHaveLength(1);
    expect(launch.dataset.openbitfunVariant).toBe('glass');
    expect(launch.dataset.openbitfunShape).toBe('circle');
    expect(launch.dataset.size).toBe('standard');
    await act(async () => launch.click());
    expect(mocks.openScene).toHaveBeenCalledWith('miniapp:notes');
    expect(container.querySelector('[data-testid="overview-miniapp-detail"]')).toBeNull();
    mocks.openScene.mockClear();

    const scrollArea = container.querySelector<HTMLElement>('.personal-overview__scroll')!;
    scrollArea.scrollTop = 180;
    trigger.focus();
    await click('personal-overview-installed-miniapp');
    const detail = container.querySelector('[data-testid="overview-miniapp-detail"]')!;
    expect(detail.querySelector('h1')?.textContent).toBe('Notes');
    expect(mocks.openScene).not.toHaveBeenCalled();
    expect(trigger.closest('[hidden]')).not.toBeNull();
    await act(async () => detail.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[data-testid="overview-miniapp-detail"]')).toBeNull();
    expect(trigger.closest('[hidden]')).toBeNull();
    expect(scrollArea.scrollTop).toBe(180);
    expect(document.activeElement).toBe(trigger);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('dismisses a homepage app detail when the active device surface changes', async () => {
    mocks.miniApps = [{ id: 'notes', name: 'Notes', description: '', icon: 'box',
      category: 'utilities', tags: [], version: 1, permissions: {}, created_at: 1, updated_at: 1 }];
    await render();
    await click('personal-overview-installed-miniapp');
    expect(container.querySelector('[data-testid="overview-miniapp-detail"]')).not.toBeNull();
    await act(async () => { activateSurface('peer-host'); });
    expect(container.querySelector('[data-testid="overview-miniapp-detail"]')).toBeNull();
  });

  it('opens the MiniApp home from its summary and lists all installed logos', async () => {
    mocks.miniApps = ['old', 'latest', 'second', 'unused'].map(id => ({
      id, name: id, description: '', icon: 'box', category: 'utilities', tags: [],
      version: 1, permissions: {}, created_at: 1, updated_at: id === 'unused' ? 100 : 1,
    }));
    mocks.tabs = [{ id: 'miniapp:old', lastUsed: 1 }];
    mocks.runningWorkerIds = ['old', 'second', 'removed'];
    await render();
    expect(container.querySelector('[data-testid="personal-overview-miniapp-count"]')?.textContent).toBe('4');
    expect(mocks.t).toHaveBeenCalledWith('miniApps.runningCount', { count: '2' });
    expect([...container.querySelectorAll<HTMLElement>('[data-testid="personal-overview-installed-miniapp"]')]
      .map(card => card.dataset.miniappId)).toEqual(['old', 'latest', 'second', 'unused']);
    await click('personal-overview-miniapp-summary');
    expect(mocks.openScene).toHaveBeenCalledWith('miniapps');
  });

  it('shows an installed app before its first use and keeps the statistics entry usable', async () => {
    mocks.miniApps = [{ id: 'unused', name: 'Unused' } as MiniAppMeta];
    await render();
    expect(container.querySelectorAll('[data-testid="personal-overview-installed-miniapp"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="personal-overview-miniapp-count"]')?.textContent).toBe('1');
    await click('personal-overview-miniapp-summary');
    expect(mocks.openScene).toHaveBeenCalledWith('miniapps');
  });

  it.each(['loading', 'failed'] as const)('does not display a zero count while the catalog is %s', async status => {
    mocks.miniAppsStatus = status;
    await render();
    expect(container.querySelector('[data-testid="personal-overview-miniapp-count"]')?.textContent)
      .toBe(status === 'loading' ? 'loadingValue' : 'unavailableValue');
    expect(container.querySelector('[data-openbitfun-part="miniApps"] [role="status"]')?.textContent)
      .toContain(status === 'loading' ? 'miniApps.loading' : 'miniApps.failed');
  });
});
