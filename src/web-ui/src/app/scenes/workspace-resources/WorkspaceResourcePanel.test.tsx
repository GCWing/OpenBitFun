/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { useNavSceneStore } from '../../stores/navSceneStore';
import WorkspaceResourcePanel from './WorkspaceResourcePanel';

const fixtures = vi.hoisted(() => ({ workspaces: new Map(), files: vi.fn() }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ activeWorkspace: fixtures.workspaces.get('project'), openedWorkspaces: fixtures.workspaces }),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('../../components/panels/FilesPanel', () => ({ default: (props: unknown) => {
  fixtures.files(props);
  return null;
} }));
vi.mock('../../components/panels/TerminalEditModal', () => ({ default: () => null }));
vi.mock('../shell/hooks', () => ({ useShellEntries: () => ({ entries: [] }) }));
vi.mock('@/tools/terminal/services/TerminalService', () => ({ getTerminalService: () => ({ getAvailableShells: async () => [] }) }));
vi.mock('./WorkspaceTerminals', () => ({ default: ({ onReveal }: { onReveal: (path: string) => void }) => (
  <button onClick={() => onReveal('/repo/src')}>Reveal terminal directory</button>
) }));

it('browses a linked SSH directory on its peer and can return to the project tree from a terminal', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const directoryPath = '/reference/docs\\api';
  const workspace: WorkspaceInfo = {
    id: 'project', rootPath: '/repo', name: 'Project', workspaceKind: WorkspaceKind.Remote, connectionId: 'ssh-a',
    relatedPaths: [{ path: directoryPath }], workspaceType: WorkspaceType.SingleProject,
    languages: [], tags: [], openedAt: '', lastAccessed: '',
  };
  fixtures.workspaces.set(workspace.id, workspace);
  const container = document.createElement('div');
  const root = createRoot(container);
  const nav = useNavSceneStore.getState();
  activateSurface('peer:project');
  try {
    nav.openWorkspaceResources(workspace.id, directoryPath);
    await act(async () => root.render(<WorkspaceResourcePanel />));
    expect(fixtures.files).toHaveBeenLastCalledWith(expect.objectContaining({ workspace, workspacePath: directoryPath }));

    await act(async () => [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Reveal terminal directory')!.click());
    expect(fixtures.files).toHaveBeenLastCalledWith(expect.objectContaining({
      workspace, workspacePath: workspace.rootPath, revealDirectoryPath: '/repo/src',
    }));

    await act(async () => nav.openWorkspaceResources(workspace.id, directoryPath));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="actions.switchToSearch"]')!.click());
    expect(fixtures.files).toHaveBeenLastCalledWith(expect.objectContaining({ workspacePath: workspace.rootPath, viewMode: 'search' }));

    await act(async () => nav.openWorkspaceResources(workspace.id, directoryPath));
    fixtures.files.mockClear();
    await act(async () => { activateSurface('local'); });
    expect(fixtures.files).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    nav.closeNavScene();
    resetDeviceSurfaceForTest();
  }
});
