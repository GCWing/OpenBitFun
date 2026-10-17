import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSessionModelSelection } from './modelSync';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatContext } from '../services/flow-chat-manager/types';

const mocks = vi.hoisted(() => ({ target: vi.fn(), select: vi.fn(), supported: vi.fn(), update: vi.fn(), configs: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ModelPoolAPI', () => ({
  modelPoolAPI: { target: mocks.target, select: mocks.select }, supportsModelPools: mocks.supported,
}));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { updateSessionModel: mocks.update } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { getConfigs: mocks.configs } }));

function fixture(config: Record<string, unknown> = {}, internal = false) {
  const session = { sessionId: 's', agentBackedTransient: internal, config: { modelName: 'primary', ...config }, workspaceId: 'w', workspacePath: '/project' };
  const pool = vi.fn();
  const context = { flowChatStore: { getState: () => ({ sessions: new Map([['s', session]]) }), updateSessionModelPool: pool,
    updateSessionModelName: vi.fn(), updateSessionMaxContextTokens: vi.fn() } } as unknown as FlowChatContext;
  return { context, pool };
}

beforeEach(() => { vi.resetAllMocks(); resetDeviceSurfaceForTest(); mocks.supported.mockReturnValue(true); });

describe('model pool send synchronization', () => {
  it('rehydrates pool intent without writing a legacy primary selection', async () => {
    const { context, pool } = fixture();
    mocks.target.mockResolvedValue({ sessionId: 's', selection: { kind: 'pool', pool_id: 'p' } });
    await syncSessionModelSelection(context, 's', 'Standard');
    expect(pool).toHaveBeenCalledWith('s', 'p', undefined);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.configs).not.toHaveBeenCalled();
  });

  it('commits a draft pool after the backend session is materialized', async () => {
    const { context, pool } = fixture({ modelPoolId: 'p', modelPoolSelectionPending: true });
    const binding = { poolId: 'p', modelId: 'a', configurationFingerprint: 'v1', generation: 1 };
    mocks.select.mockResolvedValue({ sessionId: 's', selection: { kind: 'pool', pool_id: 'p' }, binding });
    await syncSessionModelSelection(context, 's', 'Standard');
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', workspaceId: 'w' }), { kind: 'pool', pool_id: 'p' });
    expect(pool).toHaveBeenCalledWith('s', 'p', binding);
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not replace pool intent after transport or storage failure', async () => {
    const { context, pool } = fixture({ modelPoolId: 'p' });
    mocks.target.mockRejectedValue(new Error('storage unavailable'));
    await expect(syncSessionModelSelection(context, 's', 'Standard')).rejects.toThrow('storage unavailable');
    expect(pool).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects pool selection on an old host without invoking a fixed model', async () => {
    mocks.supported.mockReturnValue(false);
    const { context } = fixture({ modelPoolId: 'p' });
    await expect(syncSessionModelSelection(context, 's', 'Standard')).rejects.toThrow('model_pool_selection_v1');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps a fixed-model change from another controller after leaving a pool', async () => {
    const { context, pool } = fixture({ modelPoolId: 'p' });
    mocks.target.mockResolvedValue({ selection: { kind: 'model', model_ref: 'b' } });
    mocks.configs.mockResolvedValue({ 'ai.models': [{ id: 'b', model_name: 'model-b', enabled: true }], 'ai.default_models': {} });
    await syncSessionModelSelection(context, 's', 'Standard');
    expect(pool).toHaveBeenCalledWith('s', undefined);
    expect(context.flowChatStore.updateSessionModelName).toHaveBeenCalledWith('s', 'b');
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'b' }));
  });

  it('addresses established BTW sessions as internal sessions for pool and manual synchronization', async () => {
    const { context } = fixture({}, true);
    mocks.target.mockResolvedValue({ selection: { kind: 'pool', pool_id: 'p' } });
    await syncSessionModelSelection(context, 's', 'Standard');
    expect(mocks.target).toHaveBeenCalledWith(expect.objectContaining({ includeInternal: true }));
    mocks.target.mockResolvedValue({ selection: { kind: 'model', model_ref: 'b' } });
    mocks.configs.mockResolvedValue({ 'ai.models': [{ id: 'b', model_name: 'model-b', enabled: true }], 'ai.default_models': {} });
    await syncSessionModelSelection(context, 's', 'Standard');
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ includeInternal: true }));
  });

  it('drops a reply from a previous device activation', async () => {
    const { context, pool } = fixture();
    const scope = getActiveSurfaceScope();
    mocks.target.mockImplementation(async () => {
      activateSurface('peer');
      return { selection: { kind: 'pool', pool_id: 'foreign' } };
    });
    await expect(syncSessionModelSelection(context, 's', 'Standard', scope)).rejects.toThrow('Device surface changed');
    expect(pool).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
});
