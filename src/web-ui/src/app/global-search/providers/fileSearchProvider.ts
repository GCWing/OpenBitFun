import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import type { FileSearchResult } from '@/infrastructure/api/service-api/tauri-commands';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import type {
  GlobalSearchItem,
  GlobalSearchProvider,
  GlobalSearchProviderDiagnostic,
} from '../types';

function displayPath(filePath: string, rootPath: string): string {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : filePath;
}

function fileItem(
  workspace: WorkspaceInfo,
  result: FileSearchResult,
  kind: 'name' | 'content',
): GlobalSearchItem {
  const pathLabel = displayPath(result.path, workspace.rootPath);
  const contentPreview = [result.previewBefore, result.previewInside, result.previewAfter]
    .filter(Boolean)
    .join('') || result.matchedContent;
  const baseScore = kind === 'name' ? 92 : 72;
  return {
    id: `file:${workspace.id}:${result.path}:${kind}:${result.lineNumber ?? 0}`,
    providerId: 'files',
    group: 'files',
    title: result.name,
    subtitle: kind === 'content' && contentPreview ? contentPreview : pathLabel,
    context: kind === 'content' ? `${workspace.name} · ${pathLabel}` : workspace.name,
    badge: result.lineNumber ? `L${result.lineNumber}` : undefined,
    score: baseScore,
    target: {
      kind: 'file',
      workspaceId: workspace.id,
      workspacePath: workspace.rootPath,
      filePath: result.path,
      fileName: result.name,
      lineNumber: result.lineNumber,
    },
  };
}

export const fileSearchProvider: GlobalSearchProvider = {
  id: 'files',
  groups: ['files'],
  search: async (request, signal) => {
    if (request.scope === 'actions' || request.query.length < 2) return { items: [] };

    // Remote content search remains an explicit unsupported capability.
    const remoteWorkspaces = request.workspaces.filter(isRemoteWorkspace);
    const searchableWorkspaces = request.workspaces.filter(workspace => !isRemoteWorkspace(workspace));
    const results = await Promise.allSettled(searchableWorkspaces.map(async (workspace) => {
      const [names, contents] = await Promise.all([
        workspaceAPI.searchFilenamesOnlyDetailed(
          workspace.id,
          request.query,
          false,
          false,
          false,
          signal,
          request.limitPerGroup,
          false,
        ),
        workspaceAPI.searchContentOnlyDetailed(
          workspace.id,
          request.query,
          false,
          false,
          false,
          signal,
          request.limitPerGroup,
        ),
      ]);
      return { workspace, names, contents };
    }));
    if (signal.aborted) throw new DOMException('Search aborted', 'AbortError');

    const items: GlobalSearchItem[] = [];
    const diagnostics: GlobalSearchProviderDiagnostic[] = remoteWorkspaces.map(workspace => ({
      providerId: 'files',
      code: 'remote_workspace_unsupported',
      message: request.tCommon('nav.search.errors.remoteFileSearchUnavailable', {
        workspace: workspace.name,
      }),
    }));
    let truncated = false;
    results.forEach((result, index) => {
      const workspace = searchableWorkspaces[index];
      if (result.status === 'rejected') {
        diagnostics.push({
          providerId: 'files',
          code: 'workspace_unavailable',
          message: `${workspace?.name ?? 'Workspace'}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        });
        return;
      }
      truncated ||= result.value.names.truncated || result.value.contents.truncated;
      items.push(...result.value.names.results
        .filter((entry) => !entry.isDirectory)
        .map((entry) => fileItem(result.value.workspace, entry, 'name')));
      items.push(...result.value.contents.results
        .filter((entry) => !entry.isDirectory)
        .map((entry) => fileItem(result.value.workspace, entry, 'content')));
    });

    return { items, diagnostics, truncated };
  },
};
