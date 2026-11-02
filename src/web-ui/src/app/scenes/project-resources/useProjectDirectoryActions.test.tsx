/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useProjectDirectoryActions } from './useProjectDirectoryActions';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), update: vi.fn(), reveal: vi.fn(), desktop: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({ workspaceAPI: { revealInExplorer: mocks.reveal } }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: mocks.desktop }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useWorkspaceContext: () => ({ updateWorkspaceRelatedPaths: mocks.update }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const workspace: WorkspaceInfo = { id: 'owned', name: 'Project', rootPath: '/repo', workspaceKind: WorkspaceKind.Remote,
  connectionId: 'ssh-a', workspaceType: WorkspaceType.SingleProject, languages: [], tags: [], openedAt: '', lastAccessed: '',
  relatedPaths: [{ path: '/reference', description: 'Reference' }, { path: '/keep' }] };
let latest: ReturnType<typeof useProjectDirectoryActions>;
let root: Root;
function Harness({ target, active }: { target: WorkspaceInfo; active: boolean }) {
  latest = useProjectDirectoryActions(target, getActiveSurfaceScope(), active);
  return null;
}
const render = async (target = workspace, active = true) => act(async () => root.render(<Harness target={target} active={active} />));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.update.mockResolvedValue(workspace);
  mocks.reveal.mockResolvedValue(undefined);
  mocks.desktop.mockReturnValue(true);
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); resetDeviceSurfaceForTest(); });

it('requires confirmation, protects the primary directory and removes only the requested association', async () => {
  await render();
  await act(async () => { await latest.remove('/repo'); await latest.remove('/missing'); });
  expect(mocks.confirm).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => latest.remove('/reference'));
  expect(mocks.update).not.toHaveBeenCalled();
  await act(async () => latest.remove('/reference'));
  expect(mocks.confirm).toHaveBeenLastCalledWith({ title: 'directories.removeTitle', message: 'directories.removeMessage',
    type: 'warning', confirmDanger: true, confirmText: 'directories.removeConfirm' });
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('owned', [{ path: '/keep' }]);
  expect(workspace.relatedPaths).toHaveLength(2);
  expect(latest.removingPath).toBeNull();
});

it('ignores repeated deletion clicks and preserves directories added while confirmation is pending', async () => {
  let decide!: (confirmed: boolean) => void;
  mocks.confirm.mockReturnValue(new Promise(resolve => { decide = resolve; }));
  await render();
  let pending!: Promise<void>;
  act(() => { pending = latest.remove('/reference'); });
  await act(async () => latest.remove('/keep'));
  expect(mocks.confirm).toHaveBeenCalledOnce();
  await render({ ...workspace, relatedPaths: [...workspace.relatedPaths!, { path: '/added-elsewhere' }] });
  await act(async () => { decide(true); await pending; });
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('owned', [{ path: '/keep' }, { path: '/added-elsewhere' }]);
});

it.each(['device', 'project', 'hidden'])('does not apply a confirmation after the %s changes', async change => {
  let decide!: (confirmed: boolean) => void;
  mocks.confirm.mockReturnValue(new Promise(resolve => { decide = resolve; }));
  await render();
  let pending!: Promise<void>;
  act(() => { pending = latest.remove('/reference'); });
  if (change === 'device') activateSurface('peer:other');
  await render(change === 'project' ? { ...workspace, id: 'other' } : workspace, change !== 'hidden');
  await act(async () => { decide(true); await pending; });
  expect(mocks.update).not.toHaveBeenCalled();
});

it('keeps failed removal visible and allows retry without optimistically dropping the directory', async () => {
  mocks.update.mockRejectedValueOnce(new Error('Host offline'));
  await render();
  await act(async () => latest.remove('/reference'));
  expect(latest.error).toBe('Host offline');
  expect(latest.removingPath).toBeNull();
  expect(workspace.relatedPaths?.[0].path).toBe('/reference');
  await act(async () => latest.remove('/reference'));
  expect(latest.error).toBeNull();
  expect(mocks.update).toHaveBeenCalledTimes(2);
});

const localWorkspace = { ...workspace, workspaceKind: WorkspaceKind.Normal, connectionId: undefined };

it('opens only the owning project directories and supplies their workspace identity', async () => {
  await render(localWorkspace);
  expect(latest.canReveal).toBe(true);
  await act(async () => { await latest.reveal('/repo'); await latest.reveal('/reference'); await latest.reveal('/unrelated'); });
  expect(mocks.reveal.mock.calls).toEqual([['/repo', 'owned'], ['/reference', 'owned']]);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each(['ssh', 'peer', 'web', 'hidden', 'stale'])('does not send native directory requests from %s views', async kind => {
  if (kind === 'peer') activateSurface('peer:host');
  if (kind === 'web') mocks.desktop.mockReturnValue(false);
  await render(kind === 'ssh' ? workspace : localWorkspace, kind !== 'hidden');
  if (['ssh', 'peer', 'web'].includes(kind)) expect(latest.canReveal).toBe(false);
  if (kind === 'stale') activateSurface('peer:other');
  await act(async () => latest.reveal('/repo'));
  expect(mocks.reveal).not.toHaveBeenCalled();
});

it('deduplicates pending opens, reports failures and clears loading after a hidden view completes', async () => {
  let reject!: (reason: Error) => void;
  mocks.reveal.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await render(localWorkspace);
  let pending!: Promise<void>;
  act(() => { pending = latest.reveal('/repo'); });
  expect(latest.revealingPath).toBe('/repo');
  await act(async () => latest.reveal('/reference'));
  expect(mocks.reveal).toHaveBeenCalledOnce();
  await act(async () => { reject(new Error('Directory unavailable')); await pending; });
  expect(latest.error).toBe('Directory unavailable');
  expect(latest.revealingPath).toBeNull();

  let complete!: () => void;
  mocks.reveal.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve; }));
  act(() => { pending = latest.reveal('/repo'); });
  await render(localWorkspace, false);
  await act(async () => { complete(); await pending; });
  await render(localWorkspace);
  expect(latest.revealingPath).toBeNull();
  expect(latest.error).toBeNull();
});

it('does not display a late native-open error on another device', async () => {
  let reject!: (reason: Error) => void;
  mocks.reveal.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await render(localWorkspace);
  let pending!: Promise<void>;
  act(() => { pending = latest.reveal('/repo'); });
  activateSurface('peer:other');
  await render(localWorkspace);
  await act(async () => { reject(new Error('Old device error')); await pending; });
  expect(latest.error).toBeNull();
});
