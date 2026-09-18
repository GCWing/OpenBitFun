import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAPI } from './SessionAPI';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

describe('SessionAPI paged metadata reads', () => {
  let sessionAPI: SessionAPI;

  beforeEach(() => {
    sessionAPI = new SessionAPI();
    invokeMock.mockReset();
  });

  it.each(['local-project', 'remote-loopback', 'remote-project'])('reads %s by ID without path or SSH hints', async workspaceId => {
    const page = { sessions: [], hasMore: false };
    invokeMock.mockResolvedValueOnce(page);
    await expect(sessionAPI.listSessionsPage({ workspaceId, limit: 5, cursor: '0' })).resolves.toBe(page);
    expect(invokeMock).toHaveBeenCalledWith('list_persisted_sessions_page', {
      request: { workspace_id: workspaceId, limit: 5, cursor: '0' },
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
