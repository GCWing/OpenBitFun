import { getActiveSurfaceId, getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { workspaceAPI } from '@/infrastructure/api';
import type { ExplorerNodeDto } from '@/infrastructure/api/service-api/tauri-commands';
import { createLogger } from '@/shared/utils/logger';
import type { FileSystemChangeEvent, FileSystemNode, FileSystemOptions } from '@/tools/file-system/types';
import type { ExplorerChildrenRequest, ExplorerFileSystemProvider, ExplorerWatchOptions } from '../types/explorer';

const log = createLogger('TauriExplorerProvider');

interface FileWatchEvent {
  path: string;
  kind: string;
  timestamp: number;
  from?: string;
}

function transformRawNode(rawNode: ExplorerNodeDto): FileSystemNode {
  const node: FileSystemNode = {
    path: rawNode.path,
    name: rawNode.name,
    isDirectory: rawNode.isDirectory,
    size: rawNode.size ?? undefined,
    extension: rawNode.extension ?? undefined,
    lastModified: rawNode.lastModified ? new Date(rawNode.lastModified) : undefined,
  };

  if (Array.isArray(rawNode.children)) {
    node.children = rawNode.children.map((child) => transformRawNode(child));
  }

  return node;
}

function sortNodes(
  nodes: FileSystemNode[],
  sortBy: FileSystemOptions['sortBy'] = 'name',
  sortOrder: FileSystemOptions['sortOrder'] = 'asc'
): FileSystemNode[] {
  const sortedNodes = [...nodes].sort((left, right) => {
    if (left.isDirectory && !right.isDirectory) return -1;
    if (!left.isDirectory && right.isDirectory) return 1;

    let comparison = 0;

    switch (sortBy) {
      case 'size':
        comparison = (left.size || 0) - (right.size || 0);
        break;
      case 'lastModified':
        comparison = (left.lastModified?.getTime() || 0) - (right.lastModified?.getTime() || 0);
        break;
      case 'type':
        comparison = (left.extension || '').localeCompare(right.extension || '');
        break;
      case 'name':
      default:
        comparison = left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
        break;
    }

    return sortOrder === 'desc' ? -comparison : comparison;
  });

  return sortedNodes.map((node) => ({
    ...node,
    children: node.children ? sortNodes(node.children, sortBy, sortOrder) : undefined,
  }));
}

function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

interface BackendWatchRef {
  scope: SurfaceScope;
  workspaceId: string;
  count: number;
  rootPath: string;
  recursiveCount: number;
  backendRecursive: boolean | null;
  syncInProgress: boolean;
  syncRequested: boolean;
}

interface BackendWatchLease {
  key: string;
  recursive: boolean;
}

const backendWatchRefs = new Map<string, BackendWatchRef>();

function normalizeForWatchKey(path: string): string {
  const normalized = normalizeForCompare(path);
  const isWindowsLike = /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//');
  return isWindowsLike ? normalized.toLowerCase() : normalized;
}

function toBackendWatchKey(workspaceId: string, path: string): string {
  return JSON.stringify([getActiveSurfaceId(), workspaceId, normalizeForWatchKey(path)]);
}

function diagnosticWatchKey(path: string): string {
  const normalized = normalizeForWatchKey(path);
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return `watch:${Math.abs(hash).toString(36)}`;
}

function isSameOrUnderRoot(targetPath: string, normalizedRoot: string): boolean {
  return targetPath === normalizedRoot || targetPath.startsWith(`${normalizedRoot}/`);
}

function isSameOrDirectChildOfRoot(targetPath: string, normalizedRoot: string): boolean {
  if (targetPath === normalizedRoot) {
    return true;
  }

  if (!targetPath.startsWith(`${normalizedRoot}/`)) {
    return false;
  }

  const relativePath = targetPath.slice(normalizedRoot.length + 1);
  return relativePath !== '' && !relativePath.includes('/');
}

function isRelevantWatchEventPath(targetPath: string, normalizedRoot: string, recursive: boolean): boolean {
  return recursive
    ? isSameOrUnderRoot(targetPath, normalizedRoot)
    : isSameOrDirectChildOfRoot(targetPath, normalizedRoot);
}

function desiredBackendRecursive(ref: BackendWatchRef): boolean | null {
  if (ref.count <= 0) {
    return null;
  }
  return ref.recursiveCount > 0;
}

function requestBackendWatchSync(key: string, ref: BackendWatchRef): void {
  ref.syncRequested = true;
  if (ref.syncInProgress) {
    return;
  }

  ref.syncInProgress = true;

  void (async () => {
    try {
      while (ref.syncRequested) {
        ref.syncRequested = false;

        if (backendWatchRefs.get(key) !== ref) {
          return;
        }

        if (!ref.scope.isCurrent()) {
          backendWatchRefs.delete(key);
          return;
        }
        const desiredRecursive = desiredBackendRecursive(ref);
        if (desiredRecursive === ref.backendRecursive) {
          if (desiredRecursive === null) {
            backendWatchRefs.delete(key);
          }
          continue;
        }

        if (desiredRecursive === null) {
          await workspaceAPI.stopFileWatch(ref.workspaceId, ref.rootPath);
          ref.backendRecursive = null;
          if (ref.count <= 0) {
            backendWatchRefs.delete(key);
          }
          continue;
        }

        await workspaceAPI.startFileWatch(ref.workspaceId, ref.rootPath, desiredRecursive);
        ref.backendRecursive = desiredRecursive;
      }
    } catch (error) {
      log.warn('Failed to synchronize backend file watch', {
        watchKey: diagnosticWatchKey(ref.rootPath),
        error,
      });
    } finally {
      ref.syncInProgress = false;
      if (ref.syncRequested) {
        requestBackendWatchSync(key, ref);
      } else if (ref.count <= 0 && ref.backendRecursive === null) {
        backendWatchRefs.delete(key);
      }
    }
  })();
}

function retainBackendWatch(workspaceId: string, rootPath: string, recursive: boolean): BackendWatchLease {
  const key = toBackendWatchKey(workspaceId, rootPath);
  let ref = backendWatchRefs.get(key);
  if (ref && !ref.scope.isCurrent()) ref = undefined;
  if (!ref) {
    ref = {
      scope: getActiveSurfaceScope(),
      workspaceId,
      count: 0,
      rootPath,
      recursiveCount: 0,
      backendRecursive: null,
      syncInProgress: false,
      syncRequested: false,
    };
    backendWatchRefs.set(key, ref);
  }

  ref.count += 1;
  if (recursive) {
    ref.recursiveCount += 1;
  }
  requestBackendWatchSync(key, ref);

  return { key, recursive };
}

function releaseBackendWatch(lease: BackendWatchLease): void {
  const existing = backendWatchRefs.get(lease.key);
  if (!existing) {
    return;
  }

  existing.count -= 1;
  if (lease.recursive) {
    existing.recursiveCount = Math.max(0, existing.recursiveCount - 1);
  }

  requestBackendWatchSync(lease.key, existing);
}

function mapEventKind(kind: string): FileSystemChangeEvent['type'] {
  switch (kind) {
    case 'create':
      return 'created';
    case 'modify':
      return 'modified';
    case 'remove':
      return 'deleted';
    case 'rename':
      return 'renamed';
    default:
      return 'modified';
  }
}

export class TauriExplorerFileSystemProvider implements ExplorerFileSystemProvider {
  async getChildren(request: ExplorerChildrenRequest): Promise<FileSystemNode[]> {
    const rawChildren = await workspaceAPI.explorerGetChildren(request.workspaceId ?? '', request.path);
    return sortNodes(
      rawChildren.map((node) => transformRawNode(node)),
      request.options?.sortBy,
      request.options?.sortOrder
    );
  }

  watch(
    rootPath: string,
    callback: (event: FileSystemChangeEvent) => void,
    options: ExplorerWatchOptions = {}
  ): () => void {
    let unlisten: (() => void) | null = null;
    let active = true;
    const recursive = options.recursive ?? true;
    const normalizedRoot = normalizeForCompare(rootPath);
    if (!options.workspaceId) throw new Error('Workspace ID is required to watch workspace files');
    const backendWatchLease = retainBackendWatch(options.workspaceId, rootPath, recursive);

    const start = async () => {
      try {
        unlisten = api.listen<FileWatchEvent[]>('file-system-changed', (events) => {
          if (!active) {
            return;
          }

          for (const fileEvent of events) {
            const normalizedPath = normalizeForCompare(fileEvent.path);
            const normalizedFrom = fileEvent.from ? normalizeForCompare(fileEvent.from) : '';
            const relevant =
              isRelevantWatchEventPath(normalizedPath, normalizedRoot, recursive) ||
              (fileEvent.kind === 'rename' &&
                normalizedFrom !== '' &&
                isRelevantWatchEventPath(normalizedFrom, normalizedRoot, recursive));

            if (!relevant) {
              continue;
            }

            callback({
              type: mapEventKind(fileEvent.kind),
              path: fileEvent.path,
              oldPath: fileEvent.from,
              timestamp: new Date(fileEvent.timestamp * 1000),
            });
          }
        });
      } catch (error) {
        log.error('Failed to start explorer file watcher', { rootPath, error });
      }
    };

    void start();

    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (unlisten) {
        unlisten();
      }
      releaseBackendWatch(backendWatchLease);
    };
  }
}

export const tauriExplorerFileSystemProvider = new TauriExplorerFileSystemProvider();
