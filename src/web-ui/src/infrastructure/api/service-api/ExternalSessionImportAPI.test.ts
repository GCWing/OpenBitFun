import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./ExternalSourcesAPI', () => ({ invokeExternalSourceCommand: mocks.invoke }));
import { externalSessionImportAPI } from './ExternalSessionImportAPI';

describe('removed external sessions', () => {
  beforeEach(() => mocks.invoke.mockReset());

  it('validates the source and workspace identities of removal records', async () => {
    const entry = { ecosystemId: 'codex', sessionId: 'removed', sessionName: 'Name', workspaceId: 'owner', workspaceName: 'Project' };
    mocks.invoke.mockResolvedValueOnce([entry]).mockResolvedValueOnce([{ ...entry, ecosystemId: 'zcode' }]);
    expect(await externalSessionImportAPI.listRemoved('codex')).toEqual([entry]);
    await expect(externalSessionImportAPI.listRemoved('codex')).rejects.toThrow('Invalid removed source');
  });

  it('restores by stable host-owned workspace and source identifiers', async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await externalSessionImportAPI.restoreRemoved('removed', 'owner', 'zcode');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('restore_removed_external_session', {
      request: { sessionId: 'removed', targetWorkspaceId: 'owner', ecosystemId: 'zcode' },
    });
  });
});
