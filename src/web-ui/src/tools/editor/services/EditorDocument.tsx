import { createContext, useContext } from 'react';
import { getActiveSurfaceId, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { ContentResourceScope } from '@/shared/types/contentResource';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { upgradeLegacyEditorWorkspaceId, workspaceIdRequest } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import { monacoModelManager } from './MonacoModelManager';
import { resourcePathKey } from '@/shared/utils/resourcePath';
import { isFileMissingFromMetadata } from '@/shared/utils/fsErrorUtils';

export interface DocumentSnapshot { content: string; isDirty: boolean; savedContent: string }

/** Document state survives view placement, resource renames and surface switches. */
export class EditorDocument {
  snapshot?: DocumentSnapshot;
  viewState?: unknown;
  markdownMode?: 'ir' | 'source';
  save?: () => Promise<unknown>;
  readonly modelKey: string;
  // Disk observations survive view remounts/transfers, but are never inferred
  // from a buffer or persisted tab flags. Each path belongs to this origin.
  private readonly observedFiles = new Set<string>();
  isFileDeletedFromDisk(path: string | undefined, missing: boolean): boolean {
    return missing && !!path && this.observedFiles.has(resourcePathKey(path, this.scope));
  }
  constructor(readonly id: string, readonly scope: ContentResourceScope, filePath?: string) {
    this.modelKey = `openbitfun-document://model/${encodeURIComponent(id)}/${encodeURIComponent(filePath?.split(/[/\\]/).pop() ?? 'document')}`;
  }
  capture(content: string, isDirty: boolean, savedContent?: string): void {
    this.snapshot = { content, isDirty,
      savedContent: savedContent ?? (isDirty ? this.snapshot?.savedContent ?? content : content) };
  }
  isCurrent(): boolean { return getActiveSurfaceId() === this.scope.surfaceId; }
  private async run<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    const scope = getActiveSurfaceScope();
    if (getActiveSurfaceId() !== this.scope.surfaceId) throw new Error('The document is on an inactive device.');
    scope.assertCurrent('access document');
    const value = await operation(() => scope.assertCurrent('access document'));
    scope.assertCurrent('access document');
    return value;
  }
  private resolvedWorkspaceId?: string;
  private async workspaceId(): Promise<string> {
    if (this.scope.workspaceId) return this.scope.workspaceId;
    if (this.resolvedWorkspaceId) return this.resolvedWorkspaceId;
    const id = await upgradeLegacyEditorWorkspaceId(this.scope);
    this.resolvedWorkspaceId = id;
    return id;
  }
  readonly files = {
    readFileContent: async (path: string, encoding?: string) => {
      const content = await this.run(async assertCurrent => {
        const workspaceId = await this.workspaceId();
        assertCurrent();
        return workspaceAPI.readWorkspaceFile(workspaceId, path, encoding);
      });
      this.observedFiles.add(resourcePathKey(path, this.scope));
      return content;
    },
    getFileMetadata: async (path: string) => {
      const metadata = await this.run(async assertCurrent => {
        const workspaceId = await this.workspaceId();
        assertCurrent();
        return workspaceAPI.getWorkspaceFileMetadata(workspaceId, path);
      });
      if (!isFileMissingFromMetadata(metadata)) this.observedFiles.add(resourcePathKey(path, this.scope));
      return metadata;
    },
    writeFileContent: async (_workspace: string, path: string, content: string) => {
      const result = await this.run(async assertCurrent => {
        const workspaceId = await this.workspaceId();
        assertCurrent();
        return workspaceAPI.writeWorkspaceFile(workspaceId, path, content);
      });
      this.observedFiles.add(resourcePathKey(path, this.scope));
      return result;
    },
  };
  readonly invoke = <T,>(command: string, args: { request: Record<string, unknown> }): Promise<T> =>
    this.run(async assertCurrent => {
      const workspaceId = await this.workspaceId();
      assertCurrent();
      const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
      assertCurrent();
      const { workspacePath: _legacyRoot, remoteConnectionId: _legacyConnection, workspaceId: _callerId, ...request } = args.request;
      return api.invoke<T>(command, { ...args, request: { ...request, ...reference } });
    });
}

const documents = new Map<string, EditorDocument>();
export function getEditorDocument(id: string, scope: ContentResourceScope, filePath?: string): EditorDocument {
  let document = documents.get(id);
  if (!document) { document = new EditorDocument(id, scope, filePath); documents.set(id, document); }
  return document;
}
export function releaseEditorDocument(id: string): void {
  const document = documents.get(id);
  if (document) monacoModelManager.releaseDocumentModel(document.modelKey);
  documents.delete(id);
}
export const EditorDocumentContext = createContext<EditorDocument | null>(null);
export const useEditorDocument = () => useContext(EditorDocumentContext);
