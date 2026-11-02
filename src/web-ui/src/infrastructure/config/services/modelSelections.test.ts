import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveModelSelections, readModelSelections, rememberModeSelection } from './modelSelections';
import type { AgentModelDefaultsConfig } from '../types';
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), supports: vi.fn(() => true), scope: vi.fn(() => ({ surfaceId: 'local', assertCurrent: vi.fn() })) }));
vi.mock('./ConfigManager', () => ({ configManager: { getOptionalConfig: mocks.get, setConfig: mocks.set } }));
vi.mock('@/infrastructure/api/service-api/ModelPoolAPI', () => ({ supportsModelPools: mocks.supports }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: mocks.scope }));
const legacy: AgentModelDefaultsConfig = { mode: 'a', subagents: { default: { kind: 'fixed', model_id: 'fast' }, builtin: { ResearchSpecialist: { kind: 'inherit' } }, fork: { kind: 'inherit' } } };
beforeEach(() => { vi.clearAllMocks(); mocks.supports.mockReturnValue(true); mocks.scope.mockReturnValue({ surfaceId: 'local', assertCurrent: vi.fn() }); mocks.set.mockResolvedValue(undefined); });
describe('typed model preferences', () => {
  it('converts all old defaults without modifying their persisted shape', () => {
    const result = effectiveModelSelections(legacy, 'ai.agent_model_defaults');
    expect(result.mode).toEqual({ kind: 'model', model_ref: 'a' });
    expect(result.subagents.default).toEqual({ kind: 'model', model_ref: 'fast' });
    expect(result.subagents.builtin.ResearchSpecialist).toEqual({ kind: 'inherit' });
    expect(legacy.mode).toBe('a');
  });
  it('rejects malformed selections and read failures instead of falling back', async () => {
    expect(() => effectiveModelSelections({} as any)).toThrow('Invalid');
    mocks.get.mockRejectedValue(new Error('offline'));
    await expect(readModelSelections()).rejects.toThrow('offline');
  });
  it.each([null, { mode: 'legacy' }])('rejects malformed new records: %j', async (value) => {
    mocks.get.mockResolvedValue(value);
    await expect(readModelSelections()).rejects.toThrow();
  });
  it('uses new settings on a local host even without pool UI support', async () => {
    mocks.supports.mockReturnValue(false);
    const selections = effectiveModelSelections(legacy, 'ai.agent_model_defaults');
    mocks.get.mockResolvedValue(selections);
    await expect(readModelSelections()).resolves.toEqual(selections);
    expect(mocks.get).toHaveBeenCalledWith('ai.agent_model_selections');
    await rememberModeSelection({ kind: 'model', model_ref: 'a' });
    expect(mocks.set).toHaveBeenCalledWith('ai.agent_model_selections.mode', { kind: 'model', model_ref: 'a' });
  });
  it('rejects a completed read from a superseded device', async () => {
    const scope = { surfaceId: 'local', assertCurrent: vi.fn(() => { throw new Error('surface changed'); }) };
    mocks.scope.mockReturnValue(scope);
    mocks.get.mockResolvedValue(effectiveModelSelections(legacy, 'ai.agent_model_defaults'));
    await expect(readModelSelections()).rejects.toThrow('surface changed');
  });
  it('keeps old hosts on their single-model path and rejects pools', async () => {
    mocks.supports.mockReturnValue(false);
    mocks.scope.mockReturnValue({ surfaceId: 'peer:old', assertCurrent: vi.fn() });
    await rememberModeSelection({ kind: 'model', model_ref: 'b' });
    expect(mocks.set).toHaveBeenCalledWith('ai.agent_model_defaults.mode', 'b');
    await expect(rememberModeSelection({ kind: 'pool', pool_id: 'p' })).rejects.toThrow('model_pool_selection_v1');
  });
});
