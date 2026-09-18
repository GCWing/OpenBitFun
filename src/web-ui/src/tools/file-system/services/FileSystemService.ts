import { FileSystemNode, FileSystemOptions, IFileSystemService, FileSystemChangeEvent } from '../types';
import { workspaceAPI } from '@/infrastructure/api';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createLogger } from '@/shared/utils/logger';
import { normalizePath } from '@/shared/utils/pathUtils';

const log = createLogger('FileSystemService');

interface FileWatchEvent {
  path: string;
  kind: string;
  timestamp: number;
  from?: string;
  to?: string;
}

class FileSystemService implements IFileSystemService {
  async loadFileTree(workspaceId: string, rootPath: string, options: FileSystemOptions = {}): Promise<FileSystemNode[]> {
    try {
      const rawFileTree = await workspaceAPI.getFileTree(workspaceId, rootPath);
      const fileTree = this.transformRawFileTree(rawFileTree);
      return this.sortFileTree(fileTree, options.sortBy, options.sortOrder);
    } catch (error) {
      log.error('Failed to load file tree', { rootPath, error });
      throw new Error(`Failed to load file tree: ${error}`);
    }
  }

  async searchFiles(workspaceId: string, _query: string): Promise<FileSystemNode[]> {
    try {
      const results = await workspaceAPI.searchFilenamesOnly(workspaceId, _query);
      return results.map((result) => ({
        path: result.path,
        name: result.name,
        isDirectory: result.isDirectory,
      }));
    } catch (error) {
      log.error('Failed to search files', { workspaceId, query: _query, error });
      throw new Error(`Failed to search files: ${error}`);
    }
  }

  async getDirectoryChildren(workspaceId: string, dirPath: string): Promise<FileSystemNode[]> {
    try {
      const rawChildren = await workspaceAPI.explorerGetChildren(workspaceId, dirPath);
      const children = rawChildren.map((node: any) => this.transformRawNode(node));
      return this.sortFileTree(children);
    } catch (error) {
      log.error('Failed to get directory children', { dirPath, error });
      throw new Error(`Failed to get directory contents: ${error}`);
    }
  }

  async getDirectoryChildrenPaginated(
    workspaceId: string,
    dirPath: string, 
    offset: number = 0, 
    limit: number = 100
  ): Promise<{
    children: FileSystemNode[];
    total: number;
    hasMore: boolean;
    offset: number;
    limit: number;
  }> {
    try {
      const result = await workspaceAPI.getDirectoryChildrenPaginated(workspaceId, dirPath, offset, limit);
      const children = result.children.map((node: any) => this.transformRawNode(node));
      
      return {
        children: this.sortFileTree(children),
        total: result.total,
        hasMore: result.hasMore,
        offset: result.offset,
        limit: result.limit,
      };
    } catch (error) {
      log.error('Failed to get directory children (paginated)', { dirPath, offset, limit, error });
      throw new Error(`Failed to get directory contents: ${error}`);
    }
  }

  watchFileChanges(rootPath: string, callback: (event: FileSystemChangeEvent) => void): () => void {
    let unlisten: (() => void) | null = null;
    let isActive = true;

    const normalizeForCompare = (p: string) =>
      normalizePath(p).replace(/\\/g, '/').replace(/\/+$/, '');

    const logicalRoot = normalizeForCompare(rootPath);

    const initWatcher = async () => {
      try {
        let resolvedRoot = logicalRoot;
        try {
          const metadata = await workspaceAPI.getFileMetadata(rootPath);
          if (!isActive) return;
          if (typeof metadata.resolvedPath === 'string' && metadata.resolvedPath.trim()) {
            resolvedRoot = normalizeForCompare(metadata.resolvedPath);
          }
        } catch (error) {
          log.debug('Falling back to watch root without metadata resolution', {
            rootPath,
            error,
          });
        }

        const toLogicalPath = (path: string | undefined) => {
          if (!path) return path;
          const normalizedPath = normalizeForCompare(path);
          if (normalizedPath === resolvedRoot) {
            return logicalRoot;
          }
          if (normalizedPath.startsWith(`${resolvedRoot}/`)) {
            const suffix = normalizedPath.slice(resolvedRoot.length).replace(/^\/+/, '');
            return suffix ? `${logicalRoot}/${suffix}` : logicalRoot;
          }
          return normalizePath(path);
        };

        unlisten = api.listen<FileWatchEvent[]>('file-system-changed', (events) => {
          if (!isActive) return;

          const isUnderRoot = (absPath: string) =>
            absPath === resolvedRoot || absPath.startsWith(`${resolvedRoot}/`);

          events.forEach((fileEvent) => {
            const normalizedEventPath = normalizeForCompare(fileEvent.path);
            const normalizedFrom = fileEvent.from
              ? normalizeForCompare(fileEvent.from)
              : '';

            const relevant =
              isUnderRoot(normalizedEventPath) ||
              (fileEvent.kind === 'rename' && normalizedFrom !== '' && isUnderRoot(normalizedFrom));

            if (!relevant) {
              return;
            }

            const fsEvent: FileSystemChangeEvent = {
              type: this.mapEventKind(fileEvent.kind),
              path: toLogicalPath(fileEvent.path) ?? fileEvent.path,
              oldPath: toLogicalPath(fileEvent.from),
              timestamp: new Date(fileEvent.timestamp * 1000)
            };

            callback(fsEvent);
          });
        });
      } catch (error) {
        log.error('Failed to start file watcher', { rootPath, error });
      }
    };

    initWatcher();

    return () => {
      isActive = false;
      if (unlisten) {
        unlisten();
      }
    };
  }

  private mapEventKind(kind: string): FileSystemChangeEvent['type'] {
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

  async getFileContent(workspaceId: string, filePath: string): Promise<string> {
    try {
      return await workspaceAPI.readWorkspaceFile(workspaceId, filePath);
    } catch (error) {
      log.error('Failed to read file content', { workspaceId, filePath, error });
      throw new Error(`Failed to read file: ${error}`);
    }
  }

  async getFileStats(_filePath: string): Promise<{ size: number; lastModified: Date }> {
    return {
      size: 0,
      lastModified: new Date()
    };
  }

  private transformRawFileTree(rawNodes: any[]): FileSystemNode[] {
    return rawNodes.map(node => this.transformRawNode(node));
  }

  private transformRawNode(rawNode: any): FileSystemNode {
    const node: FileSystemNode = {
      path: rawNode.path,
      name: rawNode.name,
      isDirectory: rawNode.isDirectory,
      size: rawNode.size,
      extension: rawNode.extension,
      lastModified: rawNode.lastModified ? new Date(rawNode.lastModified) : undefined
    };

    if (rawNode.children && Array.isArray(rawNode.children)) {
      node.children = rawNode.children.map((child: any) => this.transformRawNode(child));
    }

    return node;
  }

  private sortFileTree(
    nodes: FileSystemNode[], 
    sortBy: FileSystemOptions['sortBy'] = 'name',
    sortOrder: FileSystemOptions['sortOrder'] = 'asc'
  ): FileSystemNode[] {
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      let comparison = 0;

      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
          break;
        case 'size': {
          comparison = (a.size || 0) - (b.size || 0);
          break;
        }
        case 'lastModified': {
          const aTime = a.lastModified?.getTime() || 0;
          const bTime = b.lastModified?.getTime() || 0;
          comparison = aTime - bTime;
          break;
        }
        case 'type': {
          const aExt = a.extension || '';
          const bExt = b.extension || '';
          comparison = aExt.localeCompare(bExt);
          break;
        }
        default:
          comparison = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return sortedNodes.map(node => ({
      ...node,
      children: node.children ? this.sortFileTree(node.children, sortBy, sortOrder) : undefined
    }));
  }
}

export const fileSystemService = new FileSystemService();
