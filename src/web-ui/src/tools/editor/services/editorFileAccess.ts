import type { FileMetadata } from '@/infrastructure/api/service-api/WorkspaceAPI';

/**
 * File access shape shared by editors. `EditorDocument.files` implements it
 * for canvas tabs; `standaloneEditorFileAccess` covers editors rendered
 * without a document (embedded previews, dialogs, tests).
 */
export interface EditorFileAccess {
  readFileContent(path: string, encoding?: string): Promise<string>;
  getFileMetadata(path: string): Promise<FileMetadata>;
  /** The first argument is a legacy root projection and is ignored; the owner is the workspace ID. */
  writeFileContent(workspacePath: string, path: string, content: string): Promise<void>;
}

/**
 * ID-owned file access for an editor that has no `EditorDocument`.
 *
 * The owning workspace is the explicit `workspaceId` when the host passed one,
 * otherwise the workspace the surface is currently showing. A path is never
 * used to pick the workspace; when no ID can be resolved the operation fails
 * loudly instead of writing into an arbitrary root.
 *
 * Dependencies are loaded lazily so editor modules stay light for hosts that
 * only ever render them inside a document.
 */
export function standaloneEditorFileAccess(workspaceId?: string): EditorFileAccess {
  const requireWorkspaceId = async (): Promise<string> => {
    const explicit = workspaceId?.trim();
    if (explicit) return explicit;
    const { workspaceManager } = await import('@/infrastructure/services/business/workspaceManager');
    const current = workspaceManager.getState().currentWorkspace?.id;
    if (!current) {
      throw new Error('Workspace identity is unavailable for this editor');
    }
    return current;
  };
  const api = async () => (await import('@/infrastructure/api')).workspaceAPI;
  return {
    readFileContent: async (path, encoding) =>
      (await api()).readWorkspaceFile(await requireWorkspaceId(), path, encoding),
    getFileMetadata: async (path) =>
      (await api()).getWorkspaceFileMetadata(await requireWorkspaceId(), path),
    writeFileContent: async (_workspacePath, path, content) =>
      (await api()).writeWorkspaceFile(await requireWorkspaceId(), path, content),
  };
}
