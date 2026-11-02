/** @vitest-environment jsdom */
import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, onSurfaceActivated, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { useProjectResources } from './useProjectResources';

const mocks = vi.hoisted(() => ({ modes: vi.fn(), subagents: vi.fn(), skills: vi.fn(), jobs: vi.fn(), stop: vi.fn(),
  git: vi.fn(), sessionCount: vi.fn() }));
vi.mock('@/infrastructure/api', () => ({
  agentAPI: { getAvailableModes: mocks.modes }, configAPI: { getSkillScanReport: mocks.skills },
  cronAPI: { listJobs: mocks.jobs, onJobsChanged: () => mocks.stop },
}));
vi.mock('@/infrastructure/api/service-api/SubagentAPI', () => ({ SubagentAPI: { listSubagents: mocks.subagents } }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { on: vi.fn(), off: vi.fn() } }));
vi.mock('./projectResourceStats', () => ({ loadProjectGit: mocks.git, loadProjectSessionCount: mocks.sessionCount }));
vi.mock('@/app/components/scheduled-jobs/scheduledJobDraft', () => ({ SCHEDULED_JOBS_CHANGED_EVENT: 'test-jobs-changed' }));

const workspace: WorkspaceInfo = { id: 'project-a', name: 'A', rootPath: '/repo', workspaceKind: WorkspaceKind.Normal,
  workspaceType: WorkspaceType.SingleProject, languages: [], tags: [], openedAt: '', lastAccessed: '' };
let latest: ReturnType<typeof useProjectResources>;
let root: Root;
let container: HTMLDivElement;
function Harness({ target = workspace, active = true }: { target?: WorkspaceInfo; active?: boolean }) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope);
  latest = useProjectResources(target, scope, active);
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.modes.mockReset().mockResolvedValue([]);
  mocks.subagents.mockReset().mockResolvedValue([]);
  mocks.skills.mockReset().mockResolvedValue({ skills: [], diagnostics: [], diagnosticsAvailable: true });
  mocks.jobs.mockReset().mockResolvedValue([]);
  mocks.git.mockReset().mockResolvedValue(null);
  mocks.sessionCount.mockReset().mockResolvedValue({ count: 0, partial: false });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); resetDeviceSurfaceForTest(); });

it('reads the selected project explicitly and keeps an unsupported section separate from empty data', async () => {
  mocks.jobs.mockRejectedValue(new Error('This host does not support schedules'));
  await act(async () => root.render(<Harness />));
  expect(mocks.modes).toHaveBeenCalledWith({ workspaceId: 'project-a' });
  expect(mocks.subagents).toHaveBeenCalledWith({ workspaceId: 'project-a' });
  expect(mocks.skills).toHaveBeenCalledWith({ workspaceId: 'project-a' });
  expect(mocks.jobs).toHaveBeenCalledWith({ workspaceId: 'project-a', targetKind: 'workspace' });
  expect(mocks.sessionCount).toHaveBeenCalledWith('project-a');
  expect(latest.jobs.status).toBe('failed');
  expect(latest.skills.status).toBe('ready');
  mocks.jobs.mockResolvedValue([]);
  await act(async () => latest.refresh());
  expect(latest.jobs).toEqual({ status: 'ready', data: [] });
});

it('ignores a late response from another device, even with the same project ID', async () => {
  let complete!: (value: unknown) => void;
  let completeCount!: (value: unknown) => void;
  mocks.skills.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  mocks.sessionCount.mockReturnValueOnce(new Promise(resolve => { completeCount = resolve; }));
  await act(async () => root.render(<Harness />));
  await act(async () => activateSurface('peer:other'));
  await act(async () => complete({ skills: [{ name: 'old device secret' }], diagnostics: [] }));
  await act(async () => completeCount({ count: 999, partial: false }));
  expect(latest.skills).toEqual({ status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: true } });
  expect(mocks.stop).toHaveBeenCalled();
  expect(latest.sessionCount).toEqual({ status: 'ready', data: { count: 0, partial: false } });
});

it('ignores a late response from a previously browsed project', async () => {
  let complete!: (value: unknown) => void;
  mocks.skills.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<Harness target={{ ...workspace, id: 'project-b', rootPath: '/b' }} />));
  await act(async () => complete({ skills: [{ name: 'Old project skill' }], diagnostics: [] }));
  expect(latest.skills).toEqual({ status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: true } });
});

it('does not load hidden pages and refreshes when returning to the page', async () => {
  await act(async () => root.render(<Harness active={false} />));
  expect(mocks.skills).not.toHaveBeenCalled();
  expect(mocks.sessionCount).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness />));
  expect(mocks.skills).toHaveBeenCalledTimes(1);
  expect(mocks.sessionCount).toHaveBeenCalledTimes(1);
});

it('preserves independent statistics failures', async () => {
  mocks.git.mockRejectedValue(new Error('Git host unavailable'));
  await act(async () => root.render(<Harness />));
  expect(latest.git).toEqual({ status: 'failed', error: 'Git host unavailable' });
  expect(latest.sessionCount).toEqual({ status: 'ready', data: { count: 0, partial: false } });
});
