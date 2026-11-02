// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkingCopyView from './WorkingCopyView';
import { useGitSceneStore } from '../gitSceneStore';
const mock = vi.hoisted(() => ({
  state: { currentBranch: 'main', staged: [] as Array<{ path: string; status: string }>,
    unstaged: [] as Array<{ path: string; status: string }>, untracked: [] as string[], conflicts: [] as string[],
    ahead: 0, behind: 0, error: null as string | null, state: { lastRefreshTime: { status: 123 } } },
  push: vi.fn(), pull: vi.fn(), refresh: vi.fn(), scope: vi.fn(),
}));
vi.mock('@/tools/git/hooks', () => ({
  useGitState: (options: unknown) => { mock.scope(options); return { ...mock.state, refresh: mock.refresh }; },
  useGitOperations: () => ({ isOperating: false, push: mock.push, pull: mock.pull }),
  useGitAgent: () => ({ isGeneratingCommit: false }),
}));
vi.mock('@/infrastructure/hooks/useShortcut', () => ({ useShortcut: vi.fn() }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({ useI18n: () => ({
  t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`, formatNumber: String,
}) }));
vi.mock('@/app/components/panels/content-canvas', () => ({ ContentCanvas: ({ emptyState }: { emptyState: React.ReactNode }) => <div>{emptyState}</div> }));
vi.mock('@/shared/utils/tabUtils', () => ({ createGitDiffEditorTab: vi.fn(), createGitCodeEditorTab: vi.fn() }));
vi.mock('@/tools/git/services', () => ({ gitService: {} }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mock.state, { staged: [], unstaged: [], untracked: [], conflicts: [], ahead: 0, behind: 0, error: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useGitSceneStore.getState().setActiveView('working-copy');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(<WorkingCopyView workspaceId="ssh-project" workspacePath="/srv/project" hostLabel="Build host" />)); };
it('shows clean status, repository identity and real history/branch actions without a commit form', async () => {
  await render();
  expect(host.textContent).toContain('workingCopy.clean');
  expect(host.textContent).toContain('Build host · /srv/project');
  expect(host.querySelector('textarea')).toBeNull();
  expect(mock.scope).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: { workspaceId: 'ssh-project', repositoryPath: '/srv/project' } }));
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find(button => button.textContent === label)!;
  await act(async () => button('tabs.commits').click());
  expect(useGitSceneStore.getState().activeView).toBe('graph');
  await act(async () => button('tabs.branches').click());
  expect(useGitSceneStore.getState().activeView).toBe('branches');
  expect(mock.push).not.toHaveBeenCalled();
});
it('distinguishes a clean tree from unpublished commits and only pushes on explicit action', async () => {
  mock.state.ahead = 2; mock.state.behind = 1;
  await render();
  expect(host.textContent).toContain('workingCopy.unpushed');
  expect(host.textContent).toContain('"ahead":"2","behind":"1"');
  expect(mock.push).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="actions.push"]')!.click());
  expect(mock.push).toHaveBeenCalledExactlyOnceWith({ force: false });
});
it.each(['untracked', 'conflicts'] as const)('never claims a clean tree with %s', async field => {
  mock.state[field] = ['new.txt'];
  await render();
  expect(host.textContent).not.toContain('workingCopy.clean');
  expect(host.querySelector('textarea')).not.toBeNull();
});
it('surfaces a failed status read instead of claiming a clean tree', async () => {
  mock.state.error = 'Peer disconnected';
  await render();
  expect(host.textContent).toContain('workingCopy.statusUnavailable');
  expect(host.textContent).toContain('Peer disconnected');
  expect(host.textContent).not.toContain('workingCopy.clean');
});
