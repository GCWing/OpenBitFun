/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { TokenUsageStatisticsUnavailableError, type UsageStatistics } from '@/infrastructure/api/tokenUsageStatisticsApi';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import type { SkillInfo, SkillScanReport } from '@/infrastructure/config/types';
import { usePersonalOverview } from './usePersonalOverview';

const mocks = vi.hoisted(() => ({
  usage: vi.fn(), modes: vi.fn(), subagents: vi.fn(),
  miniApps: vi.fn(), workers: vi.fn(), skills: vi.fn(),
  fileMetadata: vi.fn(), workspaceFileMetadata: vi.fn(),
  workspace: { id: 'same-workspace' },
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: vi.fn(), listen: vi.fn(() => vi.fn()) } }));
vi.mock('@/infrastructure/api/service-api/MiniAppAPI', () => ({ miniAppAPI: { listMiniApps: mocks.miniApps, workerListRunning: mocks.workers } }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getSkillScanReport: mocks.skills } }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({ workspaceAPI: { getFileMetadata: mocks.fileMetadata, getWorkspaceFileMetadata: mocks.workspaceFileMetadata } }));
vi.mock('@/infrastructure/api/tokenUsageStatisticsApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/tokenUsageStatisticsApi')>(),
  tokenUsageStatisticsApi: { getStatistics: mocks.usage },
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getAvailableModes: mocks.modes } }));
vi.mock('@/infrastructure/api/service-api/SubagentAPI', () => ({ SubagentAPI: { listSubagents: mocks.subagents } }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: mocks.workspace }) }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { on: vi.fn(), off: vi.fn() } }));

const statistics = (totalTokens: number): UsageStatistics => ({
  totalTokens, totalRequests: 1, totalInputTokens: totalTokens, totalOutputTokens: 0,
  totalCachedTokens: 0, totalCacheWriteTokens: 0, totalCacheReportedInputTokens: 0,
  byModel: [], byGroup: [], byEndpoint: [], trend: [], granularity: 'day',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof usePersonalOverview>;
function Harness({ active = true }: { active?: boolean }) {
  latest = usePersonalOverview('Asia/Shanghai', active);
  return <div data-usage={latest.usage.status} data-agents={latest.agents.status} />;
}
const render = (active = true) => act(async () => { root.render(<Harness active={active} />); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  mocks.usage.mockReset().mockResolvedValue(statistics(10));
  mocks.modes.mockReset().mockResolvedValue([]);
  mocks.subagents.mockReset().mockResolvedValue([]);
  mocks.miniApps.mockReset().mockResolvedValue([]);
  mocks.workers.mockReset().mockResolvedValue([]);
  mocks.skills.mockReset().mockResolvedValue({ skills: [], diagnostics: [], diagnosticsAvailable: true });
  mocks.fileMetadata.mockReset().mockResolvedValue({ modified: 10 });
  mocks.workspaceFileMetadata.mockReset().mockResolvedValue({ modified: 20 });
  mocks.workspace = { id: 'same-workspace' };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
});

describe('personal overview data isolation', () => {
  it('loads through the shared APIs with workspace identity and the selected time zone', async () => {
    await render();
    expect(mocks.usage).toHaveBeenCalledWith({ timeRange: 'all', granularity: 'day', timeZone: 'Asia/Shanghai', includeSubagent: true });
    expect(mocks.modes).toHaveBeenCalledWith({ workspaceId: 'same-workspace' });
    expect(mocks.subagents).toHaveBeenCalledWith({ workspaceId: 'same-workspace' });
    expect(mocks.skills).toHaveBeenCalledWith({ workspaceId: 'same-workspace' });
    expect(latest.miniApps).toEqual({ status: 'ready', data: { apps: [], runningWorkerIds: [] } });
    expect(latest.skills.status).toBe('ready');
    expect(latest.agents).toEqual({ status: 'ready', data: [] });
  });

  it('keeps unsupported old-host statistics distinct from an empty successful result', async () => {
    mocks.usage.mockRejectedValue(new TokenUsageStatisticsUnavailableError());
    await render();
    expect(latest.usage.status).toBe('unsupported');
    expect(latest.agents.status).toBe('ready');
  });

  it('keeps failed catalogs retryable without discarding independent usage data', async () => {
    mocks.subagents.mockRejectedValue(new Error('Host offline'));
    await render();
    expect(latest.agents.status).toBe('failed');
    expect(latest.usage.status).toBe('ready');
    mocks.subagents.mockResolvedValue([]);
    await act(async () => latest.refresh());
    expect(latest.agents.status).toBe('ready');
  });

  it('discards a late local response after switching to a peer with the same workspace ID', async () => {
    const pending = deferred<UsageStatistics>();
    mocks.usage.mockReturnValueOnce(pending.promise).mockResolvedValue(statistics(99));
    await render();
    await act(async () => { activateSurface('peer-host'); });
    expect(latest.usage.status === 'ready' && latest.usage.data.stats.totalTokens).toBe(99);
    await act(async () => pending.resolve(statistics(12345)));
    expect(latest.usage.status === 'ready' && latest.usage.data.stats.totalTokens).toBe(99);
  });

  it('does not restore a previous local snapshot during an A → B → A activation', async () => {
    await render();
    mocks.usage.mockReturnValue(new Promise(() => undefined));
    await act(async () => { activateSurface('peer-host'); activateSurface('local'); });
    expect(latest.usage.status).toBe('loading');
  });

  it('discards in-flight catalog results when the workspace changes', async () => {
    const pending = deferred<never[]>();
    mocks.subagents.mockReturnValueOnce(pending.promise).mockRejectedValue(new Error('Remote workspace unavailable'));
    await render();
    mocks.workspace = { id: 'remote-workspace' };
    await render();
    expect(latest.agents.status).toBe('failed');
    await act(async () => pending.resolve([]));
    expect(latest.agents.status).toBe('failed');
  });

  it('defers reads while hidden and refreshes when the overview becomes active again', async () => {
    await render(false);
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.miniApps).not.toHaveBeenCalled();
    expect(mocks.skills).not.toHaveBeenCalled();
    await render(true);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    await render(false);
    await render(true);
    expect(mocks.usage).toHaveBeenCalledTimes(2);
  });

  it('does not present failed MiniApp or Skill reads as empty catalogs, and retries independently of usage', async () => {
    mocks.miniApps.mockRejectedValue(new Error('Peer offline'));
    mocks.skills.mockRejectedValue(new Error('Remote workspace unavailable'));
    await render();
    expect(latest.miniApps.status).toBe('failed');
    expect(latest.skills.status).toBe('failed');
    expect(latest.usage.status).toBe('ready');
    mocks.miniApps.mockResolvedValue([]);
    mocks.skills.mockResolvedValue({ skills: [], diagnostics: [], diagnosticsAvailable: false });
    await act(async () => latest.refresh());
    expect(latest.miniApps.status).toBe('ready');
    expect(latest.skills).toEqual({ status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: false } });
  });

  it('drops late MiniApp and Skill results from the previous device', async () => {
    const apps = deferred<MiniAppMeta[]>();
    const skills = deferred<SkillScanReport>();
    mocks.miniApps.mockReturnValueOnce(apps.promise).mockRejectedValue(new Error('Peer offline'));
    mocks.skills.mockReturnValueOnce(skills.promise).mockRejectedValue(new Error('Peer offline'));
    await render();
    await act(async () => { activateSurface('peer-host'); });
    await act(async () => {
      apps.resolve([]);
      skills.resolve({ skills: [], diagnostics: [], diagnosticsAvailable: true });
    });
    expect(latest.miniApps.status).toBe('failed');
    expect(latest.skills.status).toBe('failed');
  });

  it('drops a late Skill report from the previous workspace', async () => {
    const pending = deferred<SkillScanReport>();
    mocks.skills.mockReturnValueOnce(pending.promise).mockRejectedValue(new Error('Remote workspace unavailable'));
    await render();
    mocks.workspace = { id: 'remote-workspace' };
    await render();
    await act(async () => pending.resolve({ skills: [], diagnostics: [], diagnosticsAvailable: true }));
    expect(mocks.skills).toHaveBeenLastCalledWith({ workspaceId: 'remote-workspace' });
    expect(latest.skills.status).toBe('failed');
  });

  it.each(['local', 'peer-host'])('loads skill counts without probing individual files on %s', async surface => {
    activateSurface(surface);
    const user: SkillInfo = {
      key: 'user', name: 'user', description: '', path: '/host/skills/user',
      level: 'user', sourceSlot: 'openbitfun-user', dirName: 'user', isBuiltin: false,
    };
    const project: SkillInfo = { ...user, key: 'project', level: 'project', path: '/remote/work/.agents/skills/project' };
    const report = { skills: [user, project], diagnostics: [], diagnosticsAvailable: true };
    mocks.skills.mockResolvedValue(report);
    await render();
    expect(mocks.skills).toHaveBeenCalledWith({ workspaceId: 'same-workspace' });
    expect(latest.skills).toEqual({ status: 'ready', data: report });
    expect(mocks.fileMetadata).not.toHaveBeenCalled();
    expect(mocks.workspaceFileMetadata).not.toHaveBeenCalled();
  });
});
