import type { PanelContent } from './panelContent';

/** Immutable origin of a resource; never inferred again from the active workspace. */
export interface ContentResourceScope {
  surfaceId: string;
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
}

export type ContentResourceTarget =
  | { kind: 'file'; path: string }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'content'; key: string };

/** Compatibility payloads are normalized at the opening boundary. */
export interface ContentResource {
  id: string;
  key: string;
  scope: ContentResourceScope;
  target: ContentResourceTarget;
  content: PanelContent;
  documentId: string;
  isDirty: boolean;
  fileMissing: boolean;
}

export interface OpenContentOptions {
  scope?: ContentResourceScope;
  resourceKey?: string;
  focus?: boolean;
  replaceExisting?: boolean;
  documentId?: string;
}

/** Emitted by the filesystem adapter after a successful rename on the captured device. */
export interface FileResourceRenamedEvent {
  surfaceId: string;
  /** Owning workspace ID; authoritative when present. */
  workspaceId?: string;
  /** Legacy owner selector for renames issued without a workspace ID. */
  remoteConnectionId?: string;
  oldPath: string;
  newPath: string;
}
