import { AssistantEntry, RecentWorkspaceEntry, RecentWorkspaceListResponse } from '../model/RemoteModels';
import { RemoteResponseMapper } from './RemoteResponseMapper';
import { remoteWorkspaceKey } from './RemoteSessionIdentity';

export type WorkspaceCatalogSource = 'opened' | 'recent';

export interface WorkspaceCatalog {
  workspaces: RecentWorkspaceEntry[];
  recentWorkspaces: RecentWorkspaceEntry[];
  source: WorkspaceCatalogSource;
}

/** Membership comes from the host; assistant metadata only enriches local rows. */
export function projectWorkspaceCatalog(
  response: RecentWorkspaceListResponse,
  assistants: AssistantEntry[]
): WorkspaceCatalog {
  const recent = RemoteResponseMapper.recentWorkspaces(response.workspaces || []);
  const opened = Array.isArray(response.opened_workspaces);
  const rows = opened ? RemoteResponseMapper.recentWorkspaces(response.opened_workspaces || []) :
    mergeLegacyWorkspaces(recent, assistants);
  const seen: Set<string> = new Set<string>();
  const workspaces: RecentWorkspaceEntry[] = [];
  rows.forEach((row: RecentWorkspaceEntry) => {
    // Rows with an ID dedup by ID alone; only pre-ID rows fall back to the legacy triple.
    const key = remoteWorkspaceKey(row);
    if (!row.path || seen.has(key)) return;
    seen.add(key);
    const assistant = !row.remoteConnectionId && !row.remoteSshHost ?
      assistants.find((item: AssistantEntry): boolean => (row.workspaceId ? item.workspace_id === row.workspaceId : !item.workspace_id && item.path === row.path) && item.name.trim().length > 0) : undefined;
    workspaces.push({
      workspaceId: row.workspaceId,
      path: row.path, name: assistant ? assistant.name : row.name,
      lastOpened: row.lastOpened, workspaceKind: assistant ? 'assistant' : row.workspaceKind,
      remoteConnectionId: row.remoteConnectionId, remoteSshHost: row.remoteSshHost
    });
  });
  return { workspaces, recentWorkspaces: recent, source: opened ? 'opened' : 'recent' };
}

/**
 * Upgrade-only merge for hosts without `opened_workspaces`.
 *
 * Assistant rows come first; a recent row is skipped when a row with the same
 * key exists, where the key is the workspace ID when present and the legacy
 * (connection, ssh host, path) triple otherwise.
 */
export function mergeLegacyWorkspaces(recent: RecentWorkspaceEntry[], assistants: AssistantEntry[]): RecentWorkspaceEntry[] {
  const rows: RecentWorkspaceEntry[] = assistants.map((item: AssistantEntry): RecentWorkspaceEntry => ({
    workspaceId: item.workspace_id,
    path: item.path, name: item.name, lastOpened: '', workspaceKind: 'assistant'
  }));
  const seen: Set<string> = new Set<string>();
  rows.forEach((row: RecentWorkspaceEntry) => seen.add(remoteWorkspaceKey(row)));
  recent.forEach((item: RecentWorkspaceEntry) => {
    const key = remoteWorkspaceKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(item);
  });
  return rows;
}
