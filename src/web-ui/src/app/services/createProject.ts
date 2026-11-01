import { systemAPI, workspaceAPI } from '@/infrastructure/api';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { sshApi } from '@/features/ssh-remote/sshApi';
import type { WorkspaceInfo } from '@/shared/types';

import { AssistantProjectFolderError, defaultProjectDirectory, projectFolderKey, type ProjectDraft, type ProjectFolder } from '../utils/projectDraft';
export type { ProjectDraft, ProjectFolder } from '../utils/projectDraft';

/** Persist one workspace with a primary root and the remaining associated folders. */
export async function createProject(
  draft: ProjectDraft,
  openRemote?: (folder: ProjectFolder) => Promise<WorkspaceInfo | null>,
): Promise<boolean> {
  const surface = getActiveSurfaceScope();
  const name = draft.name.trim();
  const uniqueFolders = new Map<string, ProjectFolder>();
  for (const folder of draft.folders) {
    const key = projectFolderKey(folder);
    if (!uniqueFolders.has(key)) uniqueFolders.set(key, folder);
  }
  const folders = [...uniqueFolders.values()];
  if (!name && folders.length !== 1) throw new Error('A project name is required.');
  if (!folders.length && (/[\\/]/.test(name) || name === '.' || name === '..')) {
    throw new Error('The new project name must be a single folder name.');
  }
  const primary = folders[0];
  if (folders.some(folder => folder.remote?.connectionId !== primary.remote?.connectionId)) {
    throw new Error('All project folders must belong to the same host.');
  }

  let workspace: WorkspaceInfo | null;
  if (primary?.remote) {
    if (!openRemote) throw new Error('Remote folder selection is unavailable on this surface.');
    workspace = await openRemote(primary);
    if (!workspace) return false;
  } else if (primary) {
    workspace = await workspaceManager.openWorkspace(primary.path);
  } else {
    const { remote } = draft;
    if (remote && !openRemote) throw new Error('Remote folder selection is unavailable on this surface.');
    const home = remote
      ? (await sshApi.getServerInfo(remote.connectionId))?.homeDir
      : (await systemAPI.getSystemInfo()).homeDir;
    surface.assertCurrent('resolve project directory');
    const parent = defaultProjectDirectory(home, Boolean(remote));
    const projectPath = `${parent}/${name}`;
    if (remote) await workspaceAPI.createDirectory(projectPath, remote.connectionId);
    else await workspaceAPI.createDirectory(projectPath);
    surface.assertCurrent('open created project');
    workspace = remote
      ? await openRemote!({ path: projectPath, remote })
      : await workspaceManager.openWorkspace(projectPath);
    if (!workspace) return false;
  }
  surface.assertCurrent('configure project');
  // Opening a reserved assistant root returns the assistant, not a new project.
  // Do not report success or rename/attach folders to that identity.
  if (workspace.workspaceKind === 'assistant') throw new AssistantProjectFolderError();

  // Keep existing associations when a previously registered primary root is reused.
  const relatedPaths = [...(workspace.relatedPaths ?? [])];
  const seen = new Set([workspace.rootPath, ...relatedPaths.map(folder => folder.path)]
    .map(path => projectFolderKey({ path, remote: primary?.remote })));
  for (const folder of folders.slice(1)) {
    const key = projectFolderKey(folder);
    if (!seen.has(key)) {
      relatedPaths.push({ path: folder.path });
      seen.add(key);
    }
  }
  if ((name && workspace.name !== name) || relatedPaths.length !== (workspace.relatedPaths ?? []).length) {
    await workspaceManager.updateWorkspaceInfo(workspace.id, {
      ...(name ? { name } : {}),
      ...(folders.length > 1 ? { relatedPaths } : {}),
    });
    surface.assertCurrent('finish project setup');
  }
  return true;
}
