import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import type { WorkspaceInfo } from '@/shared/types';
import type {
  GlobalSearchItem,
  GlobalSearchProvider,
  GlobalSearchProviderDiagnostic,
} from '../types';

function sessionHitItem(
  workspace: WorkspaceInfo,
  hit: Awaited<ReturnType<typeof sessionAPI.searchSessionContent>>['hits'][number],
  t: (key: string, options?: Record<string, unknown>) => string,
): GlobalSearchItem {
  const message = hit.kind === 'message';
  return {
    id: `session:${workspace.id}:${hit.sessionId}:${hit.turnId ?? hit.matchedField}`,
    providerId: 'session-content',
    group: message ? 'messages' : 'sessions',
    title: hit.sessionTitle,
    subtitle: hit.snippet || t('nav.search.sessionWorkspaceHint', { workspace: workspace.name }),
    context: workspace.name,
    badge: message
      ? t(hit.matchedField === 'user_message'
          ? 'nav.search.badges.userMessage'
          : 'nav.search.badges.assistantMessage')
      : undefined,
    score: hit.score,
    target: {
      kind: 'session',
      sessionId: hit.sessionId,
      workspaceId: workspace.id,
      workspacePath: workspace.rootPath,
      remoteConnectionId: workspace.connectionId,
      remoteSshHost: workspace.sshHost,
      turnId: hit.turnId,
      turnIndex: hit.turnIndex === undefined ? undefined : hit.turnIndex + 1,
    },
  };
}

export const sessionContentSearchProvider: GlobalSearchProvider = {
  id: 'session-content',
  groups: ['messages', 'sessions'],
  search: async (request, signal) => {
    if (request.scope === 'actions' || !request.query) return { items: [] };

    const results = await Promise.allSettled(request.workspaces.map(async (workspace) => ({
      workspace,
      response: await sessionAPI.searchSessionContent({
        workspaceId: workspace.id,
        workspacePath: workspace.rootPath,
        remoteConnectionId: workspace.connectionId,
        remoteSshHost: workspace.sshHost,
        query: request.query,
        limit: request.limitPerGroup,
      }, signal),
    })));
    if (signal.aborted) throw new DOMException('Search aborted', 'AbortError');

    const items: GlobalSearchItem[] = [];
    const diagnostics: GlobalSearchProviderDiagnostic[] = [];
    let truncated = false;

    results.forEach((result, index) => {
      const workspace = request.workspaces[index];
      if (result.status === 'rejected') {
        diagnostics.push({
          providerId: 'session-content',
          code: 'workspace_unavailable',
          message: `${workspace?.name ?? 'Workspace'}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        });
        return;
      }
      truncated ||= result.value.response.truncated;
      items.push(...result.value.response.hits.map((hit) =>
        sessionHitItem(result.value.workspace, hit, request.tCommon)
      ));
      diagnostics.push(...(result.value.response.diagnostics ?? []).map((diagnostic) => ({
        providerId: 'session-content',
        code: diagnostic.code,
        message: diagnostic.message,
      })));
    });

    return { items, diagnostics, truncated };
  },
};
