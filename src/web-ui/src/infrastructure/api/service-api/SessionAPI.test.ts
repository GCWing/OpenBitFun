import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAPI } from './SessionAPI';
import { activateSurface, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

const invokeMock = vi.hoisted(() => vi.fn());
const peerCapabilities = vi.hoisted(() => ({ workspaceIdReferencesV1: true }));

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({
  peerConnectionManager: { get: () => ({ getState: () => ({ capabilities: peerCapabilities }) }) },
}));

describe('SessionAPI paged metadata reads', () => {
  let sessionAPI: SessionAPI;

  beforeEach(() => {
    activateSurface('local');
    sessionAPI = new SessionAPI();
    invokeMock.mockReset();
    peerCapabilities.workspaceIdReferencesV1 = true;
  });

  it('does not send a local workspace request to an equal ID on a newly selected peer', async () => {
    const pending = sessionAPI.listSessionsPage({ workspaceId: 'same-workspace-id', limit: 5 });
    activateSurface('peer-with-the-same-workspace');

    await expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not delete an equal session ID on a peer selected during request preparation', async () => {
    const pending = sessionAPI.deleteSession('same-session-id', 'same-workspace-id');
    activateSurface('peer-with-the-same-workspace');

    await expect(pending).rejects.toSatisfy(isSurfaceChangedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(['local-project', 'remote-loopback', 'remote-project'])('reads %s by ID without path or SSH hints', async workspaceId => {
    const page = { sessions: [], hasMore: false };
    invokeMock.mockResolvedValueOnce(page);
    await expect(sessionAPI.listSessionsPage({ workspaceId, limit: 5, cursor: '0' })).resolves.toBe(page);
    expect(invokeMock).toHaveBeenCalledWith('list_persisted_sessions_page', {
      request: { workspace_id: workspaceId, limit: 5, cursor: '0' },
    });
  });

  it('preserves the selected SSH host when serializing for a peer without workspace ID support', async () => {
    peerCapabilities.workspaceIdReferencesV1 = false;
    activateSurface('legacy-peer');
    const records = [
      { id: 'local-id', rootPath: '/same/root', workspaceKind: 'normal' },
      { id: 'remote-id', rootPath: '/same/root', workspaceKind: 'remote', connectionId: 'ssh-id', sshHost: 'localhost' },
    ];
    invokeMock.mockImplementation(async (command: string) =>
      command === 'get_opened_workspaces' || command === 'get_recent_workspaces' ? records : []);

    await sessionAPI.listSessions('remote-id');

    expect(invokeMock).toHaveBeenCalledWith('list_persisted_sessions', {
      request: { workspace_path: '/same/root', remote_connection_id: 'ssh-id', remote_ssh_host: 'localhost' },
    });
  });

  it('loads the scoped hidden Session lineage without listing all internal Sessions', async () => {
    const snapshot = { rootSessionId: 'root', sessions: [] };
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(sessionAPI.getSessionLineage({
      sessionId: 'child',
      workspaceId: 'workspace-remote',
    })).resolves.toBe(snapshot);

    expect(invokeMock).toHaveBeenCalledWith('get_session_lineage', {
      request: {
        session_id: 'child',
        workspace_id: 'workspace-remote',
      },
    });
  });

  it('requests usage reports with explicit hidden subagent scope', async () => {
    const report = {
      reportId: 'usage-report-1',
      schemaVersion: 1,
      generatedAt: 1_778_347_200_000,
      sessionId: 'session-1',
      workspace: { kind: 'local' },
      scope: { kind: 'full_session', turnCount: 0 },
      coverage: { level: 'complete', available: [], missing: [], notes: [] },
      time: { accounting: 'unavailable', denominator: 'session_wall_time' },
      tokens: { source: 'unavailable', cacheCoverage: 'unavailable' },
      models: [],
      tools: [],
      files: { scope: 'unavailable', files: [] },
      compression: { compactionCount: 0, manualCompactionCount: 0, automaticCompactionCount: 0 },
      errors: { totalErrors: 0, toolErrors: 0, modelErrors: 0, examples: [] },
      slowest: [],
      privacy: {
        promptContentIncluded: false,
        toolInputsIncluded: false,
        commandOutputsIncluded: false,
        fileContentsIncluded: false,
        redactedFields: [],
      },
    };
    invokeMock.mockResolvedValueOnce(report);

    await expect(
      sessionAPI.getSessionUsageReport({
        sessionId: 'session-1',
        workspaceId: 'workspace-remote',
        includeHiddenSubagents: false,
      })
    ).resolves.toBe(report);

    expect(invokeMock).toHaveBeenCalledWith('get_session_usage_report', {
      request: {
        session_id: 'session-1',
        workspace_id: 'workspace-remote',
        include_hidden_subagents: false,
      },
    });
  });

  it('redacts workspace paths and search text from command-error diagnostics', async () => {
    invokeMock.mockRejectedValueOnce(new Error('search unavailable'));

    const error = await sessionAPI.searchSessionContent({
      workspaceId: 'workspace-1',
      workspacePath: '/private/customer/repository',
      remoteConnectionId: 'remote-1',
      query: 'confidential roadmap',
      includeArchived: true,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      context: {
        request: {
          queryLength: 20,
          remote: true,
          includeArchived: true,
        },
      },
    });
    expect(error.getFormattedMessage()).not.toContain('/private/customer/repository');
    expect(error.getFormattedMessage()).not.toContain('confidential roadmap');
  });

  it('preserves AbortError values without wrapping them as command failures', async () => {
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    invokeMock.mockRejectedValueOnce(abortError);

    await expect(sessionAPI.searchSessionContent({
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      query: 'cancelled search',
    })).rejects.toBe(abortError);
  });
});
