/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import ProjectResourcesScene from './ProjectResourcesScene';
import { projectResourceSceneId } from './projectResourceTarget';

const mocks = vi.hoisted(() => ({
  workspaces: new Map(), active: null as unknown, load: vi.fn(), openFile: vi.fn(), browse: vi.fn(),
  activate: vi.fn(), refresh: vi.fn(), agentDialog: vi.fn(), skillDialog: vi.fn(),
  grants: vi.fn(), rules: vi.fn(), iconDialog: vi.fn(), directoryDialog: vi.fn(), jobsDialog: vi.fn(),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String, formatDate: String }) }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ openedWorkspaces: mocks.workspaces, activeWorkspace: mocks.active, setActiveWorkspace: mocks.activate }),
}));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@/infrastructure/api/service-api/PermissionAPI', () => ({ permissionAPI: {
  listProjectGrants: mocks.grants, getProjectRules: mocks.rules,
} }));
vi.mock('./useProjectResources', () => ({ useProjectResources: mocks.load }));
vi.mock('@/shared/services/FileTabManager', () => ({ fileTabManager: { openFile: mocks.openFile } }));
vi.mock('@/app/stores/navSceneStore', () => ({ useNavSceneStore: { getState: () => ({ openWorkspaceResources: mocks.browse, closeNavScene: vi.fn() }) } }));
vi.mock('../agents/components/CreateAgentDialog', () => ({ default: (props: unknown) => { mocks.agentDialog(props); return <div data-testid="agent-dialog" />; } }));
vi.mock('../skills/components/AddSkillDialog', () => ({ StandaloneAddSkillDialog: (props: unknown) => { mocks.skillDialog(props); return <div data-testid="skill-dialog" />; } }));
vi.mock('@/infrastructure/workspace-icons/useWorkspaceIcon', () => ({ useWorkspaceIcon: () => ({
  snapshot: { icon: { color: 'blue' }, imageData: 'data:image/png;base64,project-icon' },
}) }));
vi.mock('@/infrastructure/workspace-icons/workspaceIcons', () => ({ iconColorStyle: () => undefined }));
vi.mock('@/app/components/WorkspaceIcon/WorkspaceIconDialog', () => ({ default: (props: { onClose: () => void }) => {
  mocks.iconDialog(props);
  return <button onClick={props.onClose}>close-icon-editor</button>;
} }));
vi.mock('@/app/components/scheduled-jobs/ScheduledJobsModal', () => ({ default: (props: { onClose: () => void }) => {
  mocks.jobsDialog(props);
  return <button onClick={props.onClose}>close-jobs</button>;
} }));
vi.mock('@/app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog', () => ({ default: (props: { onClose: () => void }) => {
  mocks.directoryDialog(props);
  return <button onClick={props.onClose}>close-directory-editor</button>;
} }));

const workspace: WorkspaceInfo = { id: 'a', name: 'Project A', rootPath: '/a', workspaceKind: WorkspaceKind.Normal,
  workspaceType: WorkspaceType.SingleProject, languages: [], tags: [], openedAt: '', lastAccessed: '' };
const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
let container: HTMLDivElement;
let root: Root;
async function render(surfaceId = 'local', workspaceId = 'a') {
  await act(async () => root.render(<ProjectResourcesScene sceneId={projectResourceSceneId({ surfaceId, workspaceId })} isActive />));
  await act(async () => { await vi.dynamicImportSettled(); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  await act(async () => { await vi.dynamicImportSettled(); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.workspaces = new Map([['a', workspace]]);
  mocks.active = { ...workspace, id: 'b', name: 'Project B', rootPath: '/b' };
  mocks.load.mockReturnValue({
    agents: ready([{ key: 'project-agent', id: 'project-agent', name: 'Project agent', description: 'Project work', source: 'project', path: '/a/agent.md' },
      { key: 'user-agent', id: 'user-agent', name: 'Personal agent', description: 'Personal work', source: 'user' }]),
    skills: ready({ skills: [], diagnostics: [], diagnosticsAvailable: true }), jobs: ready([]), refresh: mocks.refresh,
    sessionCount: ready({ count: 42, partial: false }),
    git: ready({ current_branch: 'main', staged: [{ path: 'same.ts' }], unstaged: [{ path: 'same.ts' }, { path: 'other.ts' }],
      untracked: ['new.ts'], conflicts: [], ahead: 2, behind: 1 }),
  });
  mocks.grants.mockResolvedValue([]);
  mocks.rules.mockResolvedValue({ rules: [], revision: 'v1' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); resetDeviceSurfaceForTest(); });

it('renders four sections with inline project permissions without activating the project', async () => {
  await render();
  expect(container.querySelector('h1')?.textContent).toBe('Project A');
  expect(container.querySelector('header')?.textContent).not.toContain('/a');
  expect(container.querySelector('[data-metric="changes"] .project-resources__metric-value')?.textContent).toBe('3');
  expect(container.querySelector('[data-metric="sessions"] .project-resources__metric-value')?.textContent).toBe('42');
  expect([...container.querySelectorAll('h2')].map(item => item.textContent)).toEqual([
    'directories.title', 'automation.title', 'projectPermissions.title', 'capabilities.title',
  ]);
  const permissions = container.querySelector('[data-openbitfun-part="permissions"]')!;
  expect(permissions.textContent).toContain('projectPermissions.addAuthorization');
  expect(container.textContent).not.toContain('projectPermissions.description');
  expect(container.textContent).not.toContain('instructions.title');
  expect(container.textContent).not.toContain('capabilities.description');
  expect(permissions.querySelector('.project-resource-summary__value')?.textContent).toBe('0');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.grants).toHaveBeenCalledWith('a');
  expect(mocks.rules).toHaveBeenCalledWith('a');
  expect(container.textContent).toContain('Project agent');
  expect(container.textContent).not.toContain('Personal agent');
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('opens files with the project and SSH identity rather than the current conversation', async () => {
  mocks.workspaces.set('a', { ...workspace, workspaceKind: WorkspaceKind.Remote, connectionId: 'ssh-a' });
  await render();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.project-resource-list__row')].find(button => button.textContent?.includes('Project agent'))!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'capabilities.openDefinition')!.click());
  expect(mocks.openFile).toHaveBeenCalledWith({ filePath: '/a/agent.md', scope: {
    surfaceId: 'local', workspaceId: 'a', workspacePath: '/a', remoteConnectionId: 'ssh-a',
  } });
  const directory = container.querySelector<HTMLButtonElement>('button[aria-label="directories.openDirectory"]')!;
  await act(async () => directory.click());
  expect(mocks.browse).toHaveBeenCalledWith('a');
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('starts project-scoped creation dialogs without switching the active workspace', async () => {
  await render();
  const icon = container.querySelector<HTMLButtonElement>('button[aria-label="nav.workspaces.icon.title"]')!;
  expect(icon.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,project-icon');
  await act(async () => icon.click());
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(mocks.iconDialog).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
  expect(mocks.activate).not.toHaveBeenCalled();
  await click('close-icon-editor');
  await click('directories.add');
  expect(mocks.directoryDialog).toHaveBeenCalledWith(expect.objectContaining({ workspace, initialAdd: true }));
  await click('close-directory-editor');
  await click('directories.manage');
  expect(mocks.directoryDialog).toHaveBeenLastCalledWith(expect.objectContaining({ workspace, initialAdd: false }));
  await click('close-directory-editor');
  await click('capabilities.createAgent');
  expect(mocks.agentDialog).toHaveBeenCalledWith(expect.objectContaining({ workspace, initialLevel: 'project' }));
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('never falls back to the active project for a closed or other-device destination', async () => {
  await render('peer:elsewhere');
  expect(container.textContent).toContain('unavailable');
  expect(mocks.load).not.toHaveBeenCalled();
  await render('local', 'closed');
  expect(mocks.load).not.toHaveBeenCalled();
});


it('opens project-owned task creation from the empty action and the full list from its count', async () => {
  await render();
  const section = container.querySelector('[data-openbitfun-part="automation"]')!;
  const pane = section.querySelector('.project-resource-summary__pane:not(button)')!;
  expect(pane.textContent).toBe('automation.add');
  expect(pane.querySelector('.project-resource-summary__title')).toBeNull();
  expect(section.querySelector('.project-resources__section-header button')?.textContent).toBe('automation.manage');
  expect(section.querySelector('.project-resources__action-divider')).toBeNull();
  await act(async () => pane.querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(mocks.jobsDialog).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'a', targetKind: 'workspace', initialCreate: true, listPresentation: 'table' }));
  await click('close-jobs');
  await act(async () => section.querySelector<HTMLButtonElement>('.project-resource-summary__pane--action')!.click());
  expect(mocks.jobsDialog).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'a', initialCreate: false }));
  expect(mocks.activate).not.toHaveBeenCalled();
  await click('close-jobs');
  mocks.load.mockReturnValue({ ...mocks.load.mock.results.at(-1)!.value,
    jobs: ready([{ id: 'first-job', name: 'Daily check', enabled: true, state: {} }]),
  });
  await render();
  expect(section.querySelector('.project-resource-summary__empty')).toBeNull();
  expect([...section.querySelectorAll('.project-resources__section-header button')].map(button => button.textContent)).toEqual(['automation.add', 'automation.manage']);
  expect(section.querySelector('.project-resources__action-divider')).not.toBeNull();
  await click('automation.manage');
  expect(mocks.jobsDialog).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'a', initialCreate: false }));
});


it('keeps an add item in populated capability lists and opens overflow without expanding the cards', async () => {
  const resources = mocks.load.getMockImplementation()!();
  mocks.load.mockReturnValue({ ...resources,
    agents: ready(Array.from({ length: 5 }, (_, index) => ({ key: `agent-${index}`, name: `Agent ${index}`, description: 'Work', source: 'project', path: `/a/${index}.md` }))),
    skills: ready({ skills: [{ key: 'skill', name: 'Review', description: 'Review work', level: 'project', path: '/a/skills/review' }], diagnostics: [], diagnosticsAvailable: true }),
  });
  await render();
  const lists = container.querySelectorAll('[data-openbitfun-part="capabilities"] .project-resource-list');
  expect(lists).toHaveLength(2);
  expect(lists[0].querySelector('.project-resource-list__add')?.textContent).toBe('capabilities.createAgent');
  expect(lists[1].querySelector('.project-resource-list__add')?.textContent).toBe('capabilities.addSkill');
  await act(async () => lists[0].querySelector<HTMLButtonElement>('.project-resource-list__more')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll('.project-resource-list__name')).toHaveLength(5);
  await act(async () => dialog.querySelector<HTMLButtonElement>('.project-resource-list__add')!.click());
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(mocks.agentDialog).toHaveBeenCalledWith(expect.objectContaining({ workspace, initialLevel: 'project' }));
});


it('scrolls and focuses the matching resource section from its metric with reduced motion', async () => {
  const scroll = vi.fn();
  const previousScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  try {
    await render();
    for (const [metric, label] of [['jobs', 'automation.title'], ['agents', 'capabilities.agents'], ['skills', 'capabilities.skills']]) {
      const target = container.querySelector<HTMLElement>(`[aria-label="${label}"][tabindex="-1"]`)!;
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-metric="${metric}"] button`)!.click());
      expect(scroll.mock.instances.at(-1)).toBe(target);
      expect(scroll).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' });
      expect(document.activeElement).toBe(target);
    }
  } finally {
    HTMLElement.prototype.scrollIntoView = previousScroll;
    vi.unstubAllGlobals();
  }
});
