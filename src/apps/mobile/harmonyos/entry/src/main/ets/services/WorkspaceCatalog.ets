import { AssistantEntry, RecentWorkspaceEntry, RecentWorkspaceListResponse } from '../model/RemoteModels';
import { RemoteResponseMapper } from './RemoteResponseMapper';

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
    const key = JSON.stringify([row.remoteConnectionId || null, row.remoteSshHost || null, row.path]);
    if (!row.path || seen.has(key)) return;
    seen.add(key);
    const assistant = !row.remoteConnectionId && !row.remoteSshHost ?
      assistants.find((item: AssistantEntry): boolean => item.path === row.path && item.name.trim().length > 0) : undefined;
    workspaces.push({
      path: row.path, name: assistant ? assistant.name : row.name,
      lastOpened: row.lastOpened, workspaceKind: assistant ? 'assistant' : row.workspaceKind,
      remoteConnectionId: row.remoteConnectionId, remoteSshHost: row.remoteSshHost
    });
  });
  return { workspaces, recentWorkspaces: recent, source: opened ? 'opened' : 'recent' };
}

export function mergeLegacyWorkspaces(recent: RecentWorkspaceEntry[], assistants: AssistantEntry[]): RecentWorkspaceEntry[] {
  const rows: RecentWorkspaceEntry[] = assistants.map((item: AssistantEntry): RecentWorkspaceEntry => ({
    path: item.path, name: item.name, lastOpened: '', workspaceKind: 'assistant'
  }));
  recent.forEach((item: RecentWorkspaceEntry) => {
    if (!rows.some((row: RecentWorkspaceEntry): boolean => row.path === item.path &&
      (row.remoteConnectionId || '') === (item.remoteConnectionId || '') &&
      (row.remoteSshHost || '') === (item.remoteSshHost || ''))) rows.push(item);
  });
  return rows;
}
