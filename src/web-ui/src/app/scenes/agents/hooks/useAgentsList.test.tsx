// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { useAgentsList } from './useAgentsList';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  workspace: { id: 'workspace-a' },
  peer: { peerMode: { active: false, deviceId: 'peer-a' }, currentPeerCapabilities: null },
  modes: vi.fn(), pools: vi.fn(), counts: vi.fn(), skills: vi.fn(), tools: vi.fn(), manageable: vi.fn(), selected: null as string | null,
  t: (key: string) => key,
}));
vi.mock('@/infrastructure/config/services/modelSelections', () => ({
  modelSelectionsConfigPath: () => 'ai.agent_model_selections',
  effectiveModelSelections: () => ({ subagents: { builtin: {} } }),
}));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {} }));
vi.mock('@/infrastructure/api/service-api/ModelPoolAPI', () => ({
  modelPoolAPI: { list: mocks.pools }, readableModelPools: () => [], supportsModelPools: () => true,
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getAvailableModes: mocks.modes } }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.tools } }));
vi.mock('@/infrastructure/api/service-api/SubagentAPI', () => ({
  SubagentAPI: { listSubagents: async () => [], listManageableSubagents: mocks.manageable },
}));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: {
  getAgentProfileConfigs: async () => ({}), getConfigs: async () => ({}), getModeSkillConfigs: mocks.skills, getModeSkillCounts: mocks.counts,
} }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspace: mocks.workspace, workspacePath: '/project' }),
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => mocks.peer }));
vi.mock('@/infrastructure/peer-device/peerCapabilityResolution', () => ({ canQueryToolCatalogOnSurface: () => true }));
vi.mock('@/shared/services/reviewTeamService', () => ({ loadDefaultReviewTeamDefinition: async () => undefined }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({}) }));
vi.mock('@/infrastructure/event-bus', () => ({ globalEventBus: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/shared/agents/identity', () => ({ primaryAgentKind: () => 'agent', agentName: (mode: { name: string }) => mode.name }));
vi.mock('../utils', () => ({ enrichCapabilities: (agent: unknown) => agent }));

const mode = { id: 'review', name: 'Review', description: 'Review code', configProfileId: 'review', defaultTools: [] };
let current: ReturnType<typeof useAgentsList>;
let root: Root;
let container: HTMLDivElement;
function Harness() {
  current = useAgentsList({ selectedAgentId: mocks.selected, searchQuery: '', filterLevel: 'all', filterType: 'all', t: mocks.t as TFunction<'scenes/agents'> });
  return <span>{current.loading ? 'loading' : 'ready'}</span>;
}
beforeEach(() => {
  resetDeviceSurfaceForTest();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.selected = null;
  mocks.counts.mockReset().mockResolvedValue({ review: 2 });
  mocks.skills.mockReset().mockResolvedValue([]);
  mocks.tools.mockReset().mockResolvedValue([]);
  mocks.manageable.mockReset().mockResolvedValue([]);
  mocks.workspace.id = 'workspace-a';
  mocks.peer.peerMode.active = false;
  mocks.peer.peerMode.deviceId = 'peer-a';
  mocks.modes.mockReset().mockResolvedValue([mode]);
  mocks.pools.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
});

describe('retained agent catalog refresh', () => {
  it.each([{ entries: [mode] }, { entries: [] }])('keeps a loaded catalog visible until the background result arrives: $entries.length entries', async ({ entries }) => {
    mocks.modes.mockResolvedValueOnce(entries);
    await act(async () => root.render(<Harness />));
    const previous = current.allAgents;
    let finish!: (modes: typeof entries) => void;
    mocks.modes.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let refresh!: Promise<void>;
    await act(async () => { refresh = current.loadAgents({ background: true }); });
    expect(current.loading).toBe(false);
    expect(current.allAgents).toBe(previous);
    await act(async () => { finish([{ ...mode, name: 'Updated' }]); await refresh; });
    expect(current.allAgents[0].name).toBe('Updated');
  });

  it.each(['workspace', 'peer'] as const)('does not reuse a background snapshot after a %s switch', async (owner) => {
    await act(async () => root.render(<Harness />));
    let finishOld!: (modes: typeof mode[]) => void;
    mocks.modes.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    let oldRefresh!: Promise<void>;
    await act(async () => { oldRefresh = current.loadAgents({ background: true }); });
    let finishNew!: (modes: typeof mode[]) => void;
    mocks.modes.mockReturnValue(new Promise(resolve => { finishNew = resolve; }));
    if (owner === 'workspace') mocks.workspace.id = 'workspace-b';
    else { mocks.peer.peerMode.active = true; mocks.peer.peerMode.deviceId = 'peer-b'; }
    await act(async () => root.render(<Harness />));
    await act(async () => { void current.loadAgents({ background: true }); });
    expect(current.loading).toBe(true);
    await act(async () => { finishOld([{ ...mode, name: 'Stale' }]); await oldRefresh; });
    expect(current.loading).toBe(true);
    expect(current.allAgents.some(agent => agent.name === 'Stale')).toBe(false);
    await act(async () => { finishNew([{ ...mode, name: 'Current' }]); });
    expect(current.loading).toBe(false);
    expect(current.allAgents[0].name).toBe('Current');
  });

  it('requires a fresh load after an A → B → A activation with unchanged workspace and peer context', async () => {
    await act(async () => root.render(<Harness />));
    mocks.modes.mockReturnValue(new Promise(() => {}));
    await act(async () => { activateSurface('peer-b'); activateSurface('local'); });
    await act(async () => { void current.loadAgents({ background: true }); });
    expect(current.loading).toBe(true);
  });
});


describe('progressive Agent catalog', () => {
  it('discards an older detail read after catalog refresh and keeps loaded details mounted while retrying', async () => {
    mocks.selected = 'review';
    mocks.modes.mockResolvedValue([{ ...mode, defaultTools: ['Skill'], manageableSubagentCount: 0 }]);
    let finishOld!: (skills: { key: string; effectiveEnabled: boolean }[]) => void;
    mocks.skills.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValue([{ key: 'current', effectiveEnabled: true }]);
    await act(async () => root.render(<Harness />));
    expect(current.detailsLoading).toBe(true);
    await act(async () => { await current.loadAgents({ background: true, force: true }); });
    expect(current.detailsLoaded).toBe(true);
    expect(current.getAgentSkills('review')[0].key).toBe('current');
    await act(async () => { finishOld([{ key: 'stale', effectiveEnabled: false }]); });
    expect(current.getAgentSkills('review')[0].key).toBe('current');
    let retry!: (skills: { key: string; effectiveEnabled: boolean }[]) => void;
    mocks.skills.mockReturnValueOnce(new Promise(resolve => { retry = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = current.loadAgentDetails('review', true); });
    expect(current.detailsLoading).toBe(false);
    expect(current.detailsLoaded).toBe(true);
    await act(async () => { retry([{ key: 'refreshed', effectiveEnabled: true }]); await pending; });
    expect(current.getAgentSkills('review')[0].key).toBe('refreshed');
  });

  it('renders the catalog before summaries and only loads complete capabilities on detail open', async () => {
    let finish!: (counts: Record<string, number>) => void;
    mocks.counts.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mocks.modes.mockResolvedValue([{ ...mode, defaultTools: ['Skill', 'AgentSpawn'], manageableSubagentCount: 3 }]);
    await act(async () => root.render(<Harness />));
    expect(current.loading).toBe(false);
    expect(current.allAgents).toHaveLength(1);
    expect(current.countsLoading).toBe(true);
    expect(current.getAgentSkillCount('review')).toBe(null);
    expect(current.getAgentSubagentCount('review')).toBe(3);
    expect(mocks.skills).not.toHaveBeenCalled();
    expect(mocks.tools).not.toHaveBeenCalled();
    expect(mocks.manageable).not.toHaveBeenCalled();
    mocks.selected = 'review';
    await act(async () => root.render(<Harness />));
    expect(current.detailsLoaded).toBe(true);
    expect(mocks.skills).toHaveBeenCalledTimes(1);
    expect(mocks.tools).toHaveBeenCalledTimes(1);
    expect(mocks.manageable).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ review: 2 }); });
    expect(current.getAgentSkillCount('review')).toBe(2);
  });

  it('coalesces concurrent catalog reloads and language-only rendering', async () => {
    let finish!: (modes: typeof mode[]) => void;
    mocks.modes.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Harness />));
    await act(async () => { void current.loadAgents({ background: true }); void current.loadAgents(); });
    expect(mocks.modes).toHaveBeenCalledTimes(1);
    await act(async () => { finish([mode]); });
    const oldTranslate = mocks.t;
    mocks.t = key => key + '-translated';
    await act(async () => root.render(<Harness />));
    expect(mocks.modes).toHaveBeenCalledTimes(1);
    mocks.t = oldTranslate;
  });

  it('keeps the list usable and reports a summary failure for retry', async () => {
    mocks.counts.mockRejectedValue(new Error('offline summary'));
    await act(async () => root.render(<Harness />));
    expect(current.loading).toBe(false);
    expect(current.allAgents).toHaveLength(1);
    expect(current.countsError).toContain('offline summary');
    mocks.counts.mockResolvedValue({ review: 4 });
    await act(async () => { await current.loadAgents({ background: true, force: true }); });
    expect(current.countsError).toBe(null);
    expect(current.getAgentSkillCount('review')).toBe(4);
  });
});
