import { workspaceScopedRequest } from './legacyWorkspaceCompatibility';
 

import { api } from './ApiClient';
import { workspaceIdRequest, workspaceSearchRequest, workspaceWatchRequest } from './legacyWorkspaceCompatibility';
import { globalEventBus } from '@/infrastructure/event-bus';
import { getActiveSurfaceId, getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import type { FileResourceRenamedEvent } from '@/shared/types/contentResource';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  ExplorerChildrenPageDto,
  ExplorerNodeDto,
  FileSearchResponse,
  FileSearchResult,
  FileSearchCompleteEvent,
  FileSearchErrorEvent,
  FileSearchProgressEvent,
  FileSearchResultGroup,
  FileSearchStreamKind,
  FileSearchStreamStartResponse,
  WorkspaceSearchIndexStatus,
  WorkspaceSearchIndexTaskHandle,
} from './tauri-commands';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('WorkspaceAPI');

const FILE_SEARCH_PROGRESS_EVENT = 'file-search://progress';
const FILE_SEARCH_COMPLETE_EVENT = 'file-search://complete';
const FILE_SEARCH_ERROR_EVENT = 'file-search://error';

interface FileSearchStreamCallbacks {
  onProgress?: (event: FileSearchProgressEvent) => void;
}

export interface FileMetadata {
  path: string;
  resolvedPath?: string;
  modified: number;
  size: number;
  isFile: boolean;
  isDir: boolean;
  isSymlink?: boolean;
  isRemote?: boolean;
  isRuntimeArtifact?: boolean;
}

interface WorkspaceSearchRepoStatusRaw {
  repoId: string;
  repoPath: string;
  storageRoot: string;
  baseSnapshotRoot: string;
  workspaceOverlayRoot: string;
  phase: WorkspaceSearchIndexStatus['repoStatus']['phase'];
  snapshotKey?: string | null;
  baseHeadCommit?: string | null;
  workspaceHeadCommit?: string | null;
  baseAdvanceInProgress: boolean;
  baseAdvanceTargetHead?: string | null;
  baseDeltaDepth: number;
  baseCompactionRecommended: boolean;
  lastProbeUnixSecs?: number | null;
  lastRebuildUnixSecs?: number | null;
  dirtyFiles: {
    modified: number;
    deleted: number;
    new: number;
  };
  activeTaskId?: string | null;
  probeHealthy: boolean;
  workspaceProbePending?: boolean;
  lastError?: string | null;
  lastMaintenanceError?: string | null;
  overlay?: WorkspaceSearchIndexStatus['repoStatus']['overlay'] | null;
}

interface WorkspaceSearchTaskStatusRaw {
  taskId: string;
  workspaceId: string;
  kind: NonNullable<WorkspaceSearchIndexStatus['activeTask']>['kind'];
  state: NonNullable<WorkspaceSearchIndexStatus['activeTask']>['state'];
  phase?: NonNullable<WorkspaceSearchIndexStatus['activeTask']>['phase'] | null;
  message: string;
  processed: number;
  total?: number | null;
  startedUnixSecs: number;
  updatedUnixSecs: number;
  finishedUnixSecs?: number | null;
  cancellable: boolean;
  error?: string | null;
}

interface WorkspaceSearchAutoIndexStatusRaw {
  decision: NonNullable<WorkspaceSearchIndexStatus['autoIndex']>['decision'];
  threshold: number;
  indexableFiles?: number | null;
  reason?: string | null;
}

interface WorkspaceSearchIndexStatusRaw {
  repoStatus: WorkspaceSearchRepoStatusRaw;
  activeTask?: WorkspaceSearchTaskStatusRaw | null;
  autoIndex?: WorkspaceSearchAutoIndexStatusRaw | null;
}

interface WorkspaceSearchIndexTaskHandleRaw {
  task: WorkspaceSearchTaskStatusRaw;
  repoStatus: WorkspaceSearchRepoStatusRaw;
}

function groupSearchResultsByFile(results: FileSearchResult[]): FileSearchResultGroup[] {
  const groups = new Map<string, FileSearchResultGroup>();

  for (const result of results) {
    const existing = groups.get(result.path);
    if (existing) {
      if (result.matchType === 'fileName') {
        existing.fileNameMatch = result;
      } else {
        existing.contentMatches.push(result);
      }
      continue;
    }

    groups.set(result.path, {
      path: result.path,
      name: result.name,
      isDirectory: result.isDirectory,
      fileNameMatch: result.matchType === 'fileName' ? result : undefined,
      contentMatches: result.matchType === 'content' ? [result] : [],
    });
  }

  return Array.from(groups.values());
}

function mapWorkspaceSearchRepoStatus(raw: WorkspaceSearchRepoStatusRaw): WorkspaceSearchIndexStatus['repoStatus'] {
  return {
    repoId: raw.repoId,
    repoPath: raw.repoPath,
    storageRoot: raw.storageRoot,
    baseSnapshotRoot: raw.baseSnapshotRoot,
    workspaceOverlayRoot: raw.workspaceOverlayRoot,
    phase: raw.phase,
    snapshotKey: raw.snapshotKey ?? null,
    baseHeadCommit: raw.baseHeadCommit ?? null,
    workspaceHeadCommit: raw.workspaceHeadCommit ?? null,
    baseAdvanceInProgress: raw.baseAdvanceInProgress,
    baseAdvanceTargetHead: raw.baseAdvanceTargetHead ?? null,
    baseDeltaDepth: raw.baseDeltaDepth,
    baseCompactionRecommended: raw.baseCompactionRecommended,
    lastProbeUnixSecs: raw.lastProbeUnixSecs ?? null,
    lastRebuildUnixSecs: raw.lastRebuildUnixSecs ?? null,
    dirtyFiles: raw.dirtyFiles,
    activeTaskId: raw.activeTaskId ?? null,
    probeHealthy: raw.probeHealthy,
    workspaceProbePending: raw.workspaceProbePending ?? false,
    lastError: raw.lastError ?? null,
    lastMaintenanceError: raw.lastMaintenanceError ?? null,
    overlay: raw.overlay ?? null,
  };
}

function mapWorkspaceSearchTaskStatus(
  raw: WorkspaceSearchTaskStatusRaw
): NonNullable<WorkspaceSearchIndexStatus['activeTask']> {
  return {
    taskId: raw.taskId,
    workspaceId: raw.workspaceId,
    kind: raw.kind,
    state: raw.state,
    phase: raw.phase ?? null,
    message: raw.message,
    processed: raw.processed,
    total: raw.total ?? null,
    startedUnixSecs: raw.startedUnixSecs,
    updatedUnixSecs: raw.updatedUnixSecs,
    finishedUnixSecs: raw.finishedUnixSecs ?? null,
    cancellable: raw.cancellable,
    error: raw.error ?? null,
  };
}

function mapWorkspaceSearchAutoIndexStatus(
  raw: WorkspaceSearchAutoIndexStatusRaw
): NonNullable<WorkspaceSearchIndexStatus['autoIndex']> {
  return {
    decision: raw.decision,
    threshold: raw.threshold,
    indexableFiles: raw.indexableFiles ?? null,
    reason: raw.reason ?? null,
  };
}

function mapWorkspaceSearchIndexStatus(raw: WorkspaceSearchIndexStatusRaw): WorkspaceSearchIndexStatus {
  return {
    repoStatus: mapWorkspaceSearchRepoStatus(raw.repoStatus),
    activeTask: raw.activeTask ? mapWorkspaceSearchTaskStatus(raw.activeTask) : null,
    autoIndex: raw.autoIndex ? mapWorkspaceSearchAutoIndexStatus(raw.autoIndex) : null,
  };
}

function mapWorkspaceSearchIndexTaskHandle(
  raw: WorkspaceSearchIndexTaskHandleRaw
): WorkspaceSearchIndexTaskHandle {
  return {
    task: mapWorkspaceSearchTaskStatus(raw.task),
    repoStatus: mapWorkspaceSearchRepoStatus(raw.repoStatus),
  };
}

export class WorkspaceAPI {
   
  async closeWorkspace(): Promise<void> {
    try {
      await api.invoke('close_workspace', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('close_workspace', error);
    }
  }

   
  async readWorkspaceFile(workspaceId: string, filePath: string, encoding?: string): Promise<string> {
    const surface = getActiveSurfaceScope();
    const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
    surface.assertCurrent('read workspace file');
    const content = await api.invoke<string>('read_file_content', { request: { ...reference, filePath, encoding } });
    surface.assertCurrent('read workspace file');
    return content;
  }

  async writeWorkspaceFile(workspaceId: string, filePath: string, content: string): Promise<void> {
    const surface = getActiveSurfaceScope();
    const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
    surface.assertCurrent('write workspace file');
    await api.invoke('write_file_content', { request: { ...reference, filePath, content } });
    surface.assertCurrent('write workspace file');
  }

  /**
   * ID-first file mutations. The workspace ID routes the command to the
   * owning host and connection; `path` is the IO operand inside that
   * workspace. Pre-ID peers receive the negotiated legacy projection.
   */
  private async invokeWorkspaceFileCommand<T>(
    command: string,
    action: string,
    workspaceId: string,
    request: Record<string, unknown>,
  ): Promise<T> {
    const surface = getActiveSurfaceScope();
    const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
    surface.assertCurrent(action);
    try {
      const result = await api.invoke<T>(command, { request: { ...reference, ...request } });
      surface.assertCurrent(action);
      return result;
    } catch (error) {
      if (isSurfaceChangedError(error)) throw error;
      throw createTauriCommandError(command, error, { workspaceId, ...request });
    }
  }

  async createWorkspaceFile(workspaceId: string, path: string): Promise<void> {
    await this.invokeWorkspaceFileCommand<void>('create_file', 'create workspace file', workspaceId, { path });
  }

  async deleteWorkspaceFile(workspaceId: string, path: string): Promise<void> {
    await this.invokeWorkspaceFileCommand<void>('delete_file', 'delete workspace file', workspaceId, { path });
  }

  async createWorkspaceDirectory(workspaceId: string, path: string): Promise<void> {
    await this.invokeWorkspaceFileCommand<void>(
      'create_directory', 'create workspace directory', workspaceId, { path },
    );
  }

  async deleteWorkspaceDirectory(workspaceId: string, path: string, recursive: boolean = true): Promise<void> {
    await this.invokeWorkspaceFileCommand<void>(
      'delete_directory', 'delete workspace directory', workspaceId, { path, recursive },
    );
  }

  async renameWorkspaceFile(workspaceId: string, oldPath: string, newPath: string): Promise<void> {
    const surfaceId = getActiveSurfaceId();
    await this.invokeWorkspaceFileCommand<void>(
      'rename_file', 'rename workspace file', workspaceId, { oldPath, newPath },
    );
    globalEventBus.emit<FileResourceRenamedEvent>('workspace:file-renamed', { surfaceId, workspaceId, oldPath, newPath });
  }

  async compressWorkspacePath(workspaceId: string, path: string): Promise<string> {
    return this.invokeWorkspaceFileCommand<string>('compress_path', 'compress workspace path', workspaceId, { path });
  }

  async decompressWorkspacePath(workspaceId: string, path: string): Promise<string> {
    return this.invokeWorkspaceFileCommand<string>(
      'decompress_path', 'decompress workspace path', workspaceId, { path },
    );
  }

  async getWorkspaceFileMetadata(workspaceId: string, path: string): Promise<FileMetadata> {
    const surface = getActiveSurfaceScope();
    const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
    surface.assertCurrent('read workspace file metadata');
    const raw = await api.invoke<Record<string, unknown>>('get_file_metadata', { request: { ...reference, path } });
    surface.assertCurrent('read workspace file metadata');
    return this.fileMetadataFromRaw(raw, path);
  }

  async writeFileContent(
    workspacePath: string,
    filePath: string,
    content: string,
    remoteConnectionId?: string,
  ): Promise<void> {
    try {
      await api.invoke('write_file_content', {
        request: { workspacePath, filePath, content, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('write_file_content', error, {
        workspacePath,
        filePath,
        content,
        remoteConnectionId,
      });
    }
  }

  async resetWorkspacePersonaFiles(workspaceId: string): Promise<void> {
    const reference = await workspaceIdRequest(workspaceId, 'workspacePath');
    try {
      await api.invoke('reset_workspace_persona_files', { request: reference });
    } catch (error) {
      throw createTauriCommandError('reset_workspace_persona_files', error, { workspaceId });
    }
  }

   
  async createFile(path: string, remoteConnectionId?: string): Promise<void> {
    try {
      await api.invoke('create_file', {
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('create_file', error, { path });
    }
  }

   
  async deleteFile(path: string, remoteConnectionId?: string): Promise<void> {
    try {
      await api.invoke('delete_file', {
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('delete_file', error, { path });
    }
  }

   
  async createDirectory(path: string, remoteConnectionId?: string): Promise<void> {
    try {
      await api.invoke('create_directory', {
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('create_directory', error, { path });
    }
  }

   
  async deleteDirectory(path: string, recursive: boolean = true, remoteConnectionId?: string): Promise<void> {
    try {
      await api.invoke('delete_directory', {
        request: { path, recursive, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('delete_directory', error, { path, recursive });
    }
  }

  /**
   * Compress a file or directory into an archive in the same parent directory.
   * Local workspaces produce `.zip`; remote workspaces try `zip` then `tar.gz`.
   * Returns the path of the created archive.
   */
  async compressPath(path: string, remoteConnectionId?: string): Promise<string> {
    try {
      return await api.invoke<string>('compress_path', {
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('compress_path', error, { path });
    }
  }

  /**
   * Decompress an archive into a new folder named after the archive (without
   * extension) in the same parent directory.
   * Supports `.zip`, `.tar.gz`, `.tgz`, `.tar`.
   * Returns the path of the created folder.
   */
  async decompressPath(path: string, remoteConnectionId?: string): Promise<string> {
    try {
      return await api.invoke<string>('decompress_path', {
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('decompress_path', error, { path });
    }
  }

   
  async getFileTree(workspaceId: string, path: string, maxDepth?: number): Promise<ExplorerNodeDto[]> {
    try {
      const surface = getActiveSurfaceScope();
      const scope = await workspaceIdRequest(workspaceId, 'workspacePath');
      surface.assertCurrent('access workspace files');
      return await api.invoke('get_file_tree', {
        request: { ...scope, path, maxDepth }
      });
    } catch (error) {
      throw createTauriCommandError('get_file_tree', error, { path, maxDepth });
    }
  }

   
  /** Device filesystem browser: an explicit connection is required; empty means host-local IO. */
  async getDirectoryChildren(
    path: string,
    remoteConnectionId: string,
  ): Promise<ExplorerNodeDto[]> {
    try {
      return await api.invoke('get_directory_children', { 
        request: { path, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('get_directory_children', error, {
        path,
        remoteConnectionId,
      });
    }
  }

   
  async getDirectoryChildrenPaginated(
    workspaceId: string,
    path: string, 
    offset: number = 0, 
    limit: number = 100
  ): Promise<ExplorerChildrenPageDto> {
    try {
      const surface = getActiveSurfaceScope();
      const scope = await workspaceIdRequest(workspaceId, 'workspacePath');
      surface.assertCurrent('access workspace files');
      return await api.invoke('get_directory_children_paginated', {
        request: { ...scope, path, offset, limit }
      });
    } catch (error) {
      throw createTauriCommandError('get_directory_children_paginated', error, { path, offset, limit });
    }
  }

  async explorerGetChildren(workspaceId: string, path: string): Promise<ExplorerNodeDto[]> {
    if (!workspaceId) throw new Error('A workspace ID is required to browse workspace files');
    try {
      const surface = getActiveSurfaceScope();
      const scope = await workspaceIdRequest(workspaceId, 'workspacePath');
      surface.assertCurrent('access workspace files');
      return await api.invoke('explorer_get_children', {
        request: { ...scope, path }
      });
    } catch (error) {
      throw createTauriCommandError('explorer_get_children', error, { workspaceId, path });
    }
  }

   
  async readFileContent(
    filePath: string,
    encoding?: string,
    remoteConnectionId?: string,
  ): Promise<string> {
    try {
      return await api.invoke('read_file_content', { 
        request: { filePath, encoding, remoteConnectionId }
      });
    } catch (error) {
      throw createTauriCommandError('read_file_content', error, {
        filePath,
        encoding,
        remoteConnectionId,
      });
    }
  }

  async getFileMetadata(path: string, remoteConnectionId?: string): Promise<FileMetadata> {
    try {
      const raw = await api.invoke<Record<string, unknown>>('get_file_metadata', {
        request: { path, remoteConnectionId }
      });
      return this.fileMetadataFromRaw(raw, path);
    } catch (error) {
      throw createTauriCommandError('get_file_metadata', error, { path });
    }
  }

  private fileMetadataFromRaw(raw: Record<string, unknown>, path: string): FileMetadata {
      return {
        path: String(raw.path ?? path),
        resolvedPath: typeof raw.resolvedPath === 'string' ? raw.resolvedPath : undefined,
        modified: Number(raw.modified ?? 0),
        size: Number(raw.size ?? 0),
        isFile: raw.isFile === true,
        isDir: raw.isDir === true,
        isSymlink: typeof raw.isSymlink === 'boolean' ? raw.isSymlink : undefined,
        isRemote: typeof raw.isRemote === 'boolean' ? raw.isRemote : undefined,
        isRuntimeArtifact:
          typeof raw.isRuntimeArtifact === 'boolean' ? raw.isRuntimeArtifact : undefined,
      };
  }

  private createSearchId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async cancelSearch(searchId: string): Promise<void> {
    if (!searchId) {
      return;
    }

    try {
      await api.invoke('cancel_search', {
        request: { searchId }
      });
    } catch (error) {
      log.warn('Failed to cancel search', { searchId, error });
    }
  }

  private async raceCancelable<T>(
    commandName: string,
    resultPromise: Promise<T>,
    searchId: string,
    signal?: AbortSignal
  ): Promise<T> {
    if (!signal) {
      return resultPromise;
    }

    if (signal.aborted) {
      await this.cancelSearch(searchId);
      throw new DOMException('Search aborted', 'AbortError');
    }

    // Remove the abort listener once the race settles, so a long-lived
    // AbortSignal does not keep accumulating dead handlers (mirrors the
    // cleanup pattern in runSearchStream below).
    let handleAbort: (() => void) | null = null;

    const abortPromise = new Promise<T>((_, reject) => {
      handleAbort = () => {
        void this.cancelSearch(searchId);
        reject(new DOMException(`${commandName} aborted`, 'AbortError'));
      };
      signal.addEventListener('abort', handleAbort, { once: true });
    });

    try {
      return await Promise.race([resultPromise, abortPromise]);
    } finally {
      // No-op if the listener already fired ({ once: true }).
      if (handleAbort) {
        signal.removeEventListener('abort', handleAbort);
      }
    }
  }

  private supportsSearchStreamEvents(): boolean {
    return api.getAdapter().supportsSearchStreamEvents?.() === true;
  }

  private async runSearchStream(
    commandName: 'start_search_filenames_stream' | 'start_search_file_contents_stream',
    searchKind: FileSearchStreamKind,
    request: {
      workspaceId: string;
      pattern: string;
      searchId: string;
      caseSensitive: boolean;
      useRegex: boolean;
      wholeWord: boolean;
      maxResults?: number;
      includeDirectories?: boolean;
    },
    callbacks: FileSearchStreamCallbacks = {},
    signal?: AbortSignal
  ): Promise<FileSearchCompleteEvent> {
    if (!this.supportsSearchStreamEvents()) {
      throw new Error(`Search streaming is unavailable for ${searchKind} searches outside Tauri`);
    }

    if (signal?.aborted) {
      await this.cancelSearch(request.searchId);
      throw new DOMException(`${commandName} aborted`, 'AbortError');
    }

    return await new Promise<FileSearchCompleteEvent>((resolve, reject) => {
      let settled = false;

      const cleanupCallbacks: Array<() => void> = [];
      const cleanup = () => {
        while (cleanupCallbacks.length > 0) {
          const callback = cleanupCallbacks.pop();
          try {
            callback?.();
          } catch (error) {
            log.warn('Failed to cleanup search stream listener', {
              searchId: request.searchId,
              searchKind,
              error,
            });
          }
        }
      };

      const settleResolve = (event: FileSearchCompleteEvent) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(event);
      };

      const settleReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const handleAbort = () => {
        void this.cancelSearch(request.searchId);
        settleReject(new DOMException(`${commandName} aborted`, 'AbortError'));
      };

      if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
        cleanupCallbacks.push(() => {
          signal.removeEventListener('abort', handleAbort);
        });
      }

      void (async () => {
        cleanupCallbacks.push(api.listen<FileSearchProgressEvent>(FILE_SEARCH_PROGRESS_EVENT, (event) => {
          if (event.searchId !== request.searchId || event.searchKind !== searchKind) {
            return;
          }

          callbacks.onProgress?.(event);
        }));

        cleanupCallbacks.push(api.listen<FileSearchCompleteEvent>(FILE_SEARCH_COMPLETE_EVENT, (event) => {
          if (event.searchId !== request.searchId || event.searchKind !== searchKind) {
            return;
          }

          settleResolve(event);
        }));

        cleanupCallbacks.push(api.listen<FileSearchErrorEvent>(FILE_SEARCH_ERROR_EVENT, (event) => {
          if (event.searchId !== request.searchId || event.searchKind !== searchKind) {
            return;
          }

          settleReject(new Error(event.error));
        }));

        await api.waitForListenerRegistrations();
        if (settled || signal?.aborted) {
          return;
        }
        const wireRequest = await workspaceSearchRequest(request);
        if (settled || signal?.aborted) return;
        await api.invoke<FileSearchStreamStartResponse>(commandName, { request: wireRequest });
      })().catch((error) => {
        settleReject(
          createTauriCommandError(commandName, error, {
            workspaceId: request.workspaceId,
            pattern: request.pattern,
            searchId: request.searchId,
            searchKind,
          })
        );
      });
    });
  }

  async searchFiles(
    workspaceId: string,
    pattern: string, 
    searchContent: boolean = true,
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchId?: string,
    maxResults?: number,
    includeDirectories?: boolean,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    const effectiveSearchId = searchId ?? this.createSearchId(searchContent ? 'legacy-content' : 'legacy-filenames');

    try {
      const resultPromise = api.invoke<FileSearchResult[]>('search_files', { 
        request: await workspaceSearchRequest({
          workspaceId,
          pattern, 
          searchContent,
          searchId: effectiveSearchId,
          caseSensitive,
          useRegex,
          wholeWord,
          maxResults,
          includeDirectories,
        })
      });

      return await this.raceCancelable('search_files', resultPromise, effectiveSearchId, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw createTauriCommandError('search_files', error, {
        workspaceId,
        pattern,
        searchContent,
        searchId: effectiveSearchId,
        caseSensitive,
        useRegex,
        wholeWord,
        maxResults,
        includeDirectories,
      });
    }
  }

  async searchFilenamesOnly(
    workspaceId: string,
    pattern: string, 
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    includeDirectories: boolean = true,
    signal?: AbortSignal,
  ): Promise<FileSearchResult[]> {
    const response = await this.searchFilenamesOnlyDetailed(
      workspaceId,
      pattern,
      caseSensitive,
      useRegex,
      wholeWord,
      searchIdOrSignal,
      maxResults,
      includeDirectories,
      signal,
    );
    return response.results;
  }

  async searchFilenamesOnlyDetailed(
    workspaceId: string,
    pattern: string,
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    includeDirectories: boolean = true,
    signal?: AbortSignal,
  ): Promise<FileSearchResponse> {
    const effectiveSignal = searchIdOrSignal instanceof AbortSignal ? searchIdOrSignal : signal;
    const effectiveSearchId =
      typeof searchIdOrSignal === 'string' ? searchIdOrSignal : this.createSearchId('filenames');

    if (effectiveSignal?.aborted) {
      throw new DOMException('search_filenames aborted', 'AbortError');
    }

    try {
      const resultPromise = api.invoke<FileSearchResponse>('search_filenames', {
        request: await workspaceSearchRequest({
          workspaceId,
          pattern,
          searchId: effectiveSearchId,
          caseSensitive,
          useRegex,
          wholeWord,
          maxResults,
          includeDirectories,
        })
      });

      return await this.raceCancelable('search_filenames', resultPromise, effectiveSearchId, effectiveSignal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      throw createTauriCommandError('search_filenames', error, {
        workspaceId,
        pattern,
        searchId: effectiveSearchId,
        caseSensitive,
        useRegex,
        wholeWord,
        maxResults,
        includeDirectories,
      });
    }
  }

  async searchFilenamesOnlyStreamDetailed(
    workspaceId: string,
    pattern: string,
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    includeDirectories: boolean = true,
    callbacks: FileSearchStreamCallbacks = {},
    signal?: AbortSignal,
  ): Promise<FileSearchCompleteEvent> {
    const effectiveSignal = searchIdOrSignal instanceof AbortSignal ? searchIdOrSignal : signal;
    const effectiveSearchId =
      typeof searchIdOrSignal === 'string' ? searchIdOrSignal : this.createSearchId('filenames');

    if (!this.supportsSearchStreamEvents()) {
      const response = await this.searchFilenamesOnlyDetailed(
        workspaceId,
        pattern,
        caseSensitive,
        useRegex,
        wholeWord,
        effectiveSearchId,
        maxResults,
        includeDirectories,
        effectiveSignal,
      );
      const groupedResults = groupSearchResultsByFile(response.results);
      const event: FileSearchCompleteEvent = {
        searchId: effectiveSearchId,
        searchKind: 'filenames',
        limit: response.limit,
        truncated: response.truncated,
        totalResults: groupedResults.length,
      };
      if (groupedResults.length > 0) {
        callbacks.onProgress?.({
          searchId: effectiveSearchId,
          searchKind: 'filenames',
          results: groupedResults,
        });
      }
      return event;
    }

    return await this.runSearchStream(
      'start_search_filenames_stream',
      'filenames',
      {
        workspaceId,
        pattern,
        searchId: effectiveSearchId,
        caseSensitive,
        useRegex,
        wholeWord,
        maxResults,
        includeDirectories,
      },
      callbacks,
      effectiveSignal
    );
  }

  async searchContentOnly(
    workspaceId: string,
    pattern: string, 
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    const response = await this.searchContentOnlyDetailed(
      workspaceId,
      pattern,
      caseSensitive,
      useRegex,
      wholeWord,
      searchIdOrSignal,
      maxResults,
      signal
    );
    return response.results;
  }

  async searchContentOnlyDetailed(
    workspaceId: string,
    pattern: string,
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResponse> {
    const effectiveSignal = searchIdOrSignal instanceof AbortSignal ? searchIdOrSignal : signal;
    const effectiveSearchId =
      typeof searchIdOrSignal === 'string' ? searchIdOrSignal : this.createSearchId('content');

    try {
      const resultPromise = api.invoke<FileSearchResponse>('search_file_contents', { 
        request: await workspaceSearchRequest({
          workspaceId,
          pattern, 
          searchId: effectiveSearchId,
          caseSensitive,
          useRegex,
          wholeWord,
          maxResults,
        })
      });

      return await this.raceCancelable('search_file_contents', resultPromise, effectiveSearchId, effectiveSignal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      throw createTauriCommandError('search_file_contents', error, {
        workspaceId,
        pattern,
        searchId: effectiveSearchId,
        caseSensitive,
        useRegex,
        wholeWord,
        maxResults,
      });
    }
  }

  async searchContentOnlyStreamDetailed(
    workspaceId: string,
    pattern: string,
    caseSensitive: boolean = false,
    useRegex: boolean = false,
    wholeWord: boolean = false,
    searchIdOrSignal?: string | AbortSignal,
    maxResults?: number,
    callbacks: FileSearchStreamCallbacks = {},
    signal?: AbortSignal
  ): Promise<FileSearchCompleteEvent> {
    const effectiveSignal = searchIdOrSignal instanceof AbortSignal ? searchIdOrSignal : signal;
    const effectiveSearchId =
      typeof searchIdOrSignal === 'string' ? searchIdOrSignal : this.createSearchId('content');

    if (!this.supportsSearchStreamEvents()) {
      const response = await this.searchContentOnlyDetailed(
        workspaceId,
        pattern,
        caseSensitive,
        useRegex,
        wholeWord,
        effectiveSearchId,
        maxResults,
        effectiveSignal
      );
      const groupedResults = groupSearchResultsByFile(response.results);
      const event: FileSearchCompleteEvent = {
        searchId: effectiveSearchId,
        searchKind: 'content',
        limit: response.limit,
        truncated: response.truncated,
        totalResults: groupedResults.length,
        searchMetadata: response.searchMetadata,
      };
      if (groupedResults.length > 0) {
        callbacks.onProgress?.({
          searchId: effectiveSearchId,
          searchKind: 'content',
          results: groupedResults,
        });
      }
      return event;
    }

    return await this.runSearchStream(
      'start_search_file_contents_stream',
      'content',
      {
        workspaceId,
        pattern,
        searchId: effectiveSearchId,
        caseSensitive,
        useRegex,
        wholeWord,
        maxResults,
      },
      callbacks,
      effectiveSignal
    );
  }

  async getSearchRepoStatus(workspaceId: string): Promise<WorkspaceSearchIndexStatus> {
    if (!workspaceId) throw new Error('Workspace ID is required for search indexing');
    const request = await workspaceIdRequest(workspaceId, 'rootPath');
    try {
      const raw = await api.invoke<WorkspaceSearchIndexStatusRaw>('search_get_repo_status', { request });
      return mapWorkspaceSearchIndexStatus(raw);
    } catch (error) {
      throw createTauriCommandError('search_get_repo_status', error, { workspaceId });
    }
  }

  async buildSearchIndex(workspaceId: string): Promise<WorkspaceSearchIndexTaskHandle> {
    if (!workspaceId) throw new Error('Workspace ID is required for search indexing');
    const request = await workspaceIdRequest(workspaceId, 'rootPath');
    try {
      const raw = await api.invoke<WorkspaceSearchIndexTaskHandleRaw>('search_build_index', { request });
      return mapWorkspaceSearchIndexTaskHandle(raw);
    } catch (error) {
      throw createTauriCommandError('search_build_index', error, { workspaceId });
    }
  }

  async rebuildSearchIndex(workspaceId: string): Promise<WorkspaceSearchIndexTaskHandle> {
    if (!workspaceId) throw new Error('Workspace ID is required for search indexing');
    const request = await workspaceIdRequest(workspaceId, 'rootPath');
    try {
      const raw = await api.invoke<WorkspaceSearchIndexTaskHandleRaw>('search_rebuild_index', { request });
      return mapWorkspaceSearchIndexTaskHandle(raw);
    } catch (error) {
      throw createTauriCommandError('search_rebuild_index', error, { workspaceId });
    }
  }

   
  async renameFile(oldPath: string, newPath: string, remoteConnectionId?: string): Promise<void> {
    const surfaceId = getActiveSurfaceId();
    try {
      await api.invoke('rename_file', {
        request: { oldPath, newPath, remoteConnectionId }
      });
      globalEventBus.emit<FileResourceRenamedEvent>('workspace:file-renamed', { surfaceId, remoteConnectionId, oldPath, newPath });
    } catch (error) {
      throw createTauriCommandError('rename_file', error, { oldPath, newPath });
    }
  }

  /**
   * Copy a local file to another local path (binary-safe).
   */
  async exportLocalFileToPath(sourcePath: string, destinationPath: string, workspaceId?: string): Promise<void> {
    try {
      await api.invoke('export_local_file_to_path', {
        request: await workspaceScopedRequest({ sourcePath, destinationPath, workspaceId, controllerLocal: workspaceId === undefined }),
      });
    } catch (error) {
      throw createTauriCommandError('export_local_file_to_path', error, {
        sourcePath,
        destinationPath,
      });
    }
  }

   
  async revealInExplorer(path: string): Promise<void> {
    try {
      await api.invoke('reveal_in_explorer', { 
        request: { path } 
      });
    } catch (error) {
      throw createTauriCommandError('reveal_in_explorer', error, { path });
    }
  }

   
  async startFileWatch(workspaceId: string, path: string, recursive?: boolean): Promise<void> {
    await api.invoke('start_file_watch', await workspaceWatchRequest(workspaceId, path, recursive));
  }

  async stopFileWatch(workspaceId: string, path: string): Promise<void> {
    await api.invoke('stop_file_watch', await workspaceWatchRequest(workspaceId, path));
  }

  async getWatchedPaths(): Promise<string[]> {
    try {
      return await api.invoke('get_watched_paths', {});
    } catch (error) {
      throw createTauriCommandError('get_watched_paths', error);
    }
  }

   
  async getClipboardFiles(): Promise<{ files: string[]; isCut: boolean }> {
    try {
      return await api.invoke('get_clipboard_files');
    } catch (error) {
      throw createTauriCommandError('get_clipboard_files', error);
    }
  }

  async resolveBrowserDroppedFilePaths(token: string, fileCount: number): Promise<string[]> {
    try {
      return await api.invoke('resolve_browser_dropped_file_paths', {
        request: { token, fileCount },
      });
    } catch (error) {
      throw createTauriCommandError('resolve_browser_dropped_file_paths', error, {
        token,
        fileCount,
      });
    }
  }

   
  async pasteFiles(
    sourcePaths: string[],
    targetDirectory: string,
    isCut: boolean = false,
    workspaceId?: string,
  ): Promise<{ successCount: number; directoryCount: number; failedFiles: Array<{ path: string; error: string }> }> {
    try {
      return await api.invoke('paste_files', {
        request: await workspaceScopedRequest({
          sourcePaths, targetDirectory, isCut, workspaceId, controllerLocal: workspaceId === undefined,
        })
      });
    } catch (error) {
      throw createTauriCommandError('paste_files', error, { sourcePaths, targetDirectory, isCut });
    }
  }
}


export const workspaceAPI = new WorkspaceAPI();
