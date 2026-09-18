import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ExternalSourcesAPI', async (original) => ({
  ...await original<typeof import('./ExternalSourcesAPI')>(),
  invokeExternalSourceCommand: invoke,
}));
import { instructionSourcesAPI } from './InstructionSourcesAPI';

describe('instruction source inventory contract', () => {
  beforeEach(() => { invoke.mockReset(); });

  it('requests the selected workspace and tolerates additive response fields', async () => {
    invoke.mockResolvedValue({ schemaVersion: 1, entries: [{
      ecosystemId: 'shared', name: 'AGENTS.md', path: '/project/AGENTS.md', scope: 'project', pathPatterns: [], futureField: true,
    }], failedEcosystems: [], futureField: true });
    expect((await instructionSourcesAPI.getCatalog('/project')).entries).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('get_instruction_source_catalog', { request: { workspaceId: '/project' } });
  });

  it.each([null, {}, { schemaVersion: 2, entries: [], failedEcosystems: [] },
    { schemaVersion: 1, entries: [{ scope: 'unknown' }], failedEcosystems: [] },
  ])('rejects unknown or malformed inventories without reporting an empty success', async (response) => {
    invoke.mockResolvedValue(response);
    await expect(instructionSourcesAPI.getCatalog()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('preserves an older host unsupported response', async () => {
    invoke.mockRejectedValue({ code: 'host_unavailable', message: 'Unknown command' });
    await expect(instructionSourcesAPI.getCatalog()).rejects.toMatchObject({ code: 'host_unavailable' });
  });
});
