import { create } from 'zustand';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { FileResourceRenamedEvent } from '@/shared/types/contentResource';
import type { PanelContent } from '../components/panels/base/types';
import type { ContentResource, ContentResourceScope, ContentResourceTarget } from '@/shared/types/contentResource';
import { resourceFilePath, resourcePathKey } from '@/shared/utils/resourcePath';
export { resourceFilePath } from '@/shared/utils/resourcePath';

const FILE_TYPES = new Set(['code-editor', 'code-viewer', 'file-viewer', 'text-viewer',
  'markdown-editor', 'image-viewer', 'pdf-viewer', 'html-preview']);
export const isFileResourceContent = (content: PanelContent): boolean =>
  FILE_TYPES.has(content.type) && typeof content.data?.filePath === 'string' && content.data.filePath.length > 0
    // Dispatch URLs identify supplied snapshots, not files on this surface.
    && !content.data.filePath.startsWith('dispatch-file://');

let sequence = 0;

/** Reopening is a navigation intent, never a replacement for an edited buffer. */
export function mergeContentOpenIntent(existing: PanelContent, input: PanelContent, replace = false, isDirty = false): PanelContent {
  if (!isFileResourceContent(existing)) return replace && !isDirty ? input : existing;
  const navigationFields = ['jumpToLine', 'jumpToColumn', 'jumpToRange', 'navigationToken'];
  const navigation = navigationFields.some(field => input.data?.[field] !== undefined)
    ? Object.fromEntries(navigationFields.map(field => [field, input.data[field]])) : {};
  return { ...existing, ...(replace ? { type: input.type } : {}), data: { ...existing.data, ...navigation } };
}

export function contentResourceIdentity(content: PanelContent, scope: ContentResourceScope, key?: string) {
  let target: ContentResourceTarget;
  if (isFileResourceContent(content)) {
    target = { kind: 'file', path: resourceFilePath(content.data.filePath, scope) };
  } else if (content.type === 'terminal' && typeof content.data?.sessionId === 'string') {
    target = { kind: 'terminal', sessionId: content.data.sessionId };
  } else {
    target = { kind: 'content', key: key ?? content.metadata?.duplicateCheckKey ?? `instance-${++sequence}` };
  }
  const identity = target.kind === 'file'
    ? resourcePathKey(target.path, scope)
    : target.kind === 'terminal' ? target.sessionId : target.key;
  // Ownership is (surface, workspace ID). The SSH connection is an IO detail of
  // a remote record and changes on reconnect; it only separates resources of
  // legacy scopes that never learned their workspace ID.
  const owner = scope.workspaceId ? ['workspace', scope.workspaceId] : ['legacy', scope.remoteConnectionId ?? ''];
  return { target, key: JSON.stringify([scope.surfaceId, owner, target.kind,
    target.kind === 'content' ? [content.type, scope.workspaceId ?? ''] : '', identity]) };
}

/** Two scopes own the same files when they name the same workspace on one surface. */
export function sameContentResourceOwner(left: ContentResourceScope, right: ContentResourceScope): boolean {
  if (left.surfaceId !== right.surfaceId) return false;
  if (left.workspaceId || right.workspaceId) return left.workspaceId === right.workspaceId;
  return left.remoteConnectionId === right.remoteConnectionId;
}

interface ResourceState {
  resources: Record<string, ContentResource>;
  open: (content: PanelContent, scope: ContentResourceScope, key?: string, replace?: boolean, documentId?: string) => string;
  update: (id: string, patch: Partial<Pick<ContentResource, 'content' | 'isDirty' | 'fileMissing'>>) => void;
  remove: (id: string) => void;
  renameFile: (scope: ContentResourceScope, oldPath: string, newPath: string) => void;
}

export const useContentResourceStore = create<ResourceState>((set, get) => ({
  resources: {},
  open: (input, scope, explicitKey, replace = false, documentId) => {
    const { target, key } = contentResourceIdentity(input, scope, explicitKey);
    const existing = Object.values(get().resources).find(resource => resource.key === key);
    if (existing) {
      const content = mergeContentOpenIntent(existing.content, input, replace, existing.isDirty);
      get().update(existing.id, { content });
      return existing.id;
    }
    const id = `resource-${++sequence}`;
    const content = { ...input, data: input.data !== null && typeof input.data === 'object' ? { ...input.data,
      ...(target.kind === 'file' ? { filePath: target.path } : {}),
      workspaceId: scope.workspaceId, workspacePath: scope.workspacePath, remoteConnectionId: scope.remoteConnectionId } : input.data };
    set(state => ({ resources: { ...state.resources,
      [id]: { id, key, scope, target, content, documentId: documentId ?? id, isDirty: false, fileMissing: false } } }));
    return id;
  },
  update: (id, patch) => set(state => {
    const resource = state.resources[id];
    if (!resource || Object.entries(patch).every(([key, value]) => resource[key as keyof ContentResource] === value)) return state;
    return { resources: { ...state.resources, [id]: { ...resource, ...patch } } };
  }),
  remove: id => set(state => {
    const resources = { ...state.resources };
    delete resources[id];
    return { resources };
  }),
  renameFile: (scope, oldPath, newPath) => set(state => {
    const resources = { ...state.resources };
    const oldRoot = resourceFilePath(oldPath, scope);
    for (const resource of Object.values(resources)) {
      if (!sameContentResourceOwner(resource.scope, scope) || resource.target.kind !== 'file') continue;
      const path = resource.target.path;
      const pathKey = resourcePathKey(path, scope);
      const rootKey = resourcePathKey(oldRoot, scope);
      if (pathKey !== rootKey && !pathKey.startsWith(`${rootKey}/`)) continue;
      const nextPath = resourceFilePath(newPath, scope) + path.slice(oldRoot.length);
      const title = nextPath.split('/').pop() ?? resource.content.title;
      const content = { ...resource.content, title, data: { ...resource.content.data, filePath: nextPath, fileName: title } };
      const identity = contentResourceIdentity(content, resource.scope);
      resources[resource.id] = { ...resource, ...identity, content, fileMissing: false };
    }
    return { resources };
  }),
}));

const stopRenameListener = globalEventBus.on<FileResourceRenamedEvent>('workspace:file-renamed', event => {
  useContentResourceStore.getState().renameFile(event, event.oldPath, event.newPath);
});
if (import.meta.hot) import.meta.hot.dispose(stopRenameListener);
