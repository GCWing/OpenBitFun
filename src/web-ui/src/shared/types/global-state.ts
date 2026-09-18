/**
 * Global state and app-level API types.
 */
import { globalAPI } from '@/infrastructure/api';
import { workspaceAPI } from '@/infrastructure/api';
import type {
  ApplicationState as APIApplicationState,
  AppStatus as APIAppStatus,
  RemoteWorkspaceSnapshot as APIRemoteWorkspaceSnapshot,
  WorkspaceStartupStateSnapshot as APIWorkspaceStartupStateSnapshot,
  WorkspaceInfo as APIWorkspaceInfo,
} from '@/infrastructure/api/service-api/GlobalAPI';
import { createLogger } from '../utils/logger';
import { normalizePath } from '../utils/pathUtils';

const logger = createLogger('GlobalStateAPI');

declare global {
  // Native startup may inject this once to avoid a first-window IPC waterfall.
  var __OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__:
    | APIWorkspaceStartupStateSnapshot
    | undefined;
}


export enum AppStatus {
  Initializing = 'initializing',
  Running = 'running',
  Processing = 'processing',
  Idle = 'idle',
  Error = 'error',
}


export interface UserSettings {
  language: string;
  autoSaveInterval: number;
  maxCachedGraphs: number;
  debugMode: boolean;
  customSettings: Record<string, any>;
}


export interface ApplicationState {
  appId: string;
  startupTime: string;
  version: string;
  userSettings: UserSettings;
  status: AppStatus;
  lastActivity: string;
}


export enum WorkspaceType {
  SingleProject = 'singleProject',
  MultiProject = 'multiProject',
  Documentation = 'documentation',
  Other = 'other',
}

export enum WorkspaceKind {
  Normal = 'normal',
  Assistant = 'assistant',
  Remote = 'remote',
}


export interface ProjectStatistics {
  totalFiles: number;
  totalLines: number;
  totalSize: number;
  filesByLanguage: Record<string, number>;
  filesByExtension: Record<string, number>;
  lastUpdated: string;
}

export interface WorkspaceIdentity {
  name?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
  emoji?: string;
}

export interface WorkspaceWorktreeInfo {
  mainWorkspaceId?: string;
  path: string;
  branch?: string | null;
  mainRepoPath: string;
  isMain: boolean;
}

export interface RelatedPath {
  path: string;
  description?: string;
}


export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  workspaceType: WorkspaceType;
  workspaceKind: WorkspaceKind;
  assistantId?: string | null;
  languages: string[];
  openedAt: string;
  lastAccessed: string;
  description?: string;
  tags: string[];
  statistics?: ProjectStatistics;
  identity?: WorkspaceIdentity | null;
  worktree?: WorkspaceWorktreeInfo | null;
  relatedPaths?: RelatedPath[];
  connectionId?: string;
  connectionName?: string;
  /**
   * Logical workspace host for stable scoping: `{sshHost}:{rootPath}`.
   * Local / assistant workspaces use `localhost` (from backend); remote uses SSH config host.
   */
  sshHost?: string;
}

export interface RemoteWorkspaceSnapshot {
  connectionId: string;
  connectionName: string;
  remotePath: string;
  sshHost?: string;
}

function summarizeWorkspacesForLog(workspaces: WorkspaceInfo[]) {
  return workspaces.reduce(
    (summary, workspace) => {
      summary.total += 1;
      if (workspace.workspaceKind === WorkspaceKind.Assistant) {
        summary.assistant += 1;
      } else if (workspace.workspaceKind === WorkspaceKind.Remote) {
        summary.remote += 1;
      } else {
        summary.normal += 1;
      }
      return summary;
    },
    { total: 0, normal: 0, assistant: 0, remote: 0 }
  );
}

export function isRemoteWorkspace(workspace: WorkspaceInfo | null | undefined): boolean {
  return workspace?.workspaceKind === WorkspaceKind.Remote;
}

export function isLinkedWorktreeWorkspace(workspace: WorkspaceInfo | null | undefined): boolean {
  return Boolean(workspace?.worktree && !workspace.worktree.isMain);
}

/** MiniApp storage root shared by every platform: `<userRoot>/data/miniapps/`. */
const MINIAPP_DATA_PATH_SEGMENT = '/data/miniapps/';

/**
 * MiniApp agent runs work inside directories the MiniApp owns under the app data
 * dir (`<userRoot>/data/miniapps/<appId>/...`, drafts included). They are MiniApp
 * storage rather than user projects, so they never belong in workspace history.
 */
export function isMiniAppWorkspace(workspace: WorkspaceInfo | null | undefined): boolean {
  const rootPath = workspace?.rootPath;
  if (!rootPath) {
    return false;
  }
  return normalizePath(rootPath).includes(MINIAPP_DATA_PATH_SEGMENT);
}

/** Temporary or app-owned workspaces that must not pollute the recent list. */
function isExcludedFromRecentWorkspaces(workspace: WorkspaceInfo): boolean {
  return isLinkedWorktreeWorkspace(workspace) || isMiniAppWorkspace(workspace);
}


export enum WorkspaceAction {
  Opened = 'opened',
  Closed = 'closed',
  Switched = 'switched',
  Scanned = 'scanned',
  GraphBuilt = 'graphBuilt',
}


export interface WorkspaceHistoryEntry {
  workspaceId: string;
  action: WorkspaceAction;
  timestamp: string;
  description?: string;
}


export enum GraphStatus {
  Building = 'building',
  Ready = 'ready',
  Stale = 'stale',
  Error = 'error',
}


export enum CacheStrategy {
  LRU = 'lru',
  LFU = 'lfu',
  FIFO = 'fifo',
}


export interface CacheStatistics {
  totalCachedGraphs: number;
  cacheHitRate: number;
  totalMemoryUsage: number;
  oldestCacheAge?: string;
}

export interface WorkspaceStartupState {
  cleanupRemovedCount: number;
  currentWorkspace: WorkspaceInfo | null;
  recentWorkspaces: WorkspaceInfo[];
  openedWorkspaces: WorkspaceInfo[];
  primaryAssistantWorkspaceId: string | null;
  legacyRemoteWorkspace: RemoteWorkspaceSnapshot | null;
}

 
export interface GlobalStateAPI {
  
  initializeWorkspaceStartupState(): Promise<WorkspaceStartupState>;
  
  
  getAppState(): Promise<ApplicationState>;
  updateAppStatus(status: AppStatus): Promise<void>;

  
  openWorkspace(path: string): Promise<WorkspaceInfo>;
  openWorkspaceById(workspaceId: string): Promise<WorkspaceInfo>;
  openRemoteWorkspace(
    remotePath: string,
    connectionId: string,
    connectionName: string,
    sshHost?: string
  ): Promise<WorkspaceInfo>;
  createAssistantWorkspace(): Promise<WorkspaceInfo>;
  getPrimaryAssistantWorkspace(): Promise<WorkspaceInfo | null>;
  setPrimaryAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo>;
  deleteAssistantWorkspace(workspaceId: string): Promise<void>;
  resetAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo>;
  closeWorkspace(workspaceId: string): Promise<void>;
  setActiveWorkspace(workspaceId: string): Promise<WorkspaceInfo>;
  reorderOpenedWorkspaces(workspaceIds: string[]): Promise<void>;
  updateWorkspaceInfo(
    workspaceId: string,
    updates: {
      name?: string;
      description?: string | null;
      tags?: string[];
      relatedPaths?: RelatedPath[];
    }
  ): Promise<WorkspaceInfo>;
  getCurrentWorkspace(): Promise<WorkspaceInfo | null>;
  getOpenedWorkspaces(): Promise<WorkspaceInfo[]>;
  getRecentWorkspaces(): Promise<WorkspaceInfo[]>;
  removeWorkspaceFromRecent(workspaceId: string): Promise<void>;
  cleanupInvalidWorkspaces(): Promise<number>;
  scanWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null>;
  
  
  startFileWatch(workspaceId: string, path: string, recursive?: boolean): Promise<void>;
  stopFileWatch(workspaceId: string, path: string): Promise<void>;
  getWatchedPaths(): Promise<string[]>;
}

function mapAppStatusToApi(status: AppStatus): APIAppStatus {
  switch (status) {
    case AppStatus.Initializing:
      return { isInitialized: false, hasError: false };
    case AppStatus.Error:
      return { isInitialized: true, hasError: true, errorMessage: 'Application error' };
    default:
      return { isInitialized: true, hasError: false };
  }
}

function mapApiStatus(status: APIAppStatus): AppStatus {
  if (status.hasError) return AppStatus.Error;
  if (!status.isInitialized) return AppStatus.Initializing;
  return AppStatus.Running;
}

function createDefaultUserSettings(): UserSettings {
  return {
    language: 'en-US',
    autoSaveInterval: 0,
    maxCachedGraphs: 0,
    debugMode: false,
    customSettings: {},
  };
}

function mapWorkspaceType(workspaceType: APIWorkspaceInfo['workspaceType']): WorkspaceType {
  switch (workspaceType) {
    case WorkspaceType.SingleProject:
      return WorkspaceType.SingleProject;
    case WorkspaceType.MultiProject:
      return WorkspaceType.MultiProject;
    case WorkspaceType.Documentation:
      return WorkspaceType.Documentation;
    default:
      return WorkspaceType.Other;
  }
}

function mapWorkspaceKind(workspaceKind: APIWorkspaceInfo['workspaceKind']): WorkspaceKind {
  switch (workspaceKind) {
    case WorkspaceKind.Assistant:
      return WorkspaceKind.Assistant;
    case WorkspaceKind.Remote:
      return WorkspaceKind.Remote;
    default:
      return WorkspaceKind.Normal;
  }
}

function mapWorkspaceIdentity(
  identity: APIWorkspaceInfo['identity']
): WorkspaceIdentity | null | undefined {
  if (!identity) {
    return identity;
  }

  return {
    name: identity.name ?? undefined,
    creature: identity.creature ?? undefined,
    vibe: identity.vibe ?? undefined,
    avatar: identity.avatar ?? undefined,
    emoji: identity.emoji ?? undefined,
  };
}

function mapWorkspaceWorktree(
  worktree: APIWorkspaceInfo['worktree']
): WorkspaceWorktreeInfo | null | undefined {
  if (!worktree) {
    return worktree;
  }

  return {
    path: worktree.path,
    branch: worktree.branch ?? undefined,
    mainRepoPath: worktree.mainRepoPath,
    mainWorkspaceId: worktree.mainWorkspaceId,
    isMain: worktree.isMain,
  };
}

function mapWorkspaceInfo(workspace: APIWorkspaceInfo): WorkspaceInfo {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPath: workspace.rootPath,
    workspaceType: mapWorkspaceType(workspace.workspaceType),
    workspaceKind: mapWorkspaceKind(workspace.workspaceKind),
    assistantId: workspace.assistantId ?? undefined,
    languages: workspace.languages,
    openedAt: workspace.openedAt,
    lastAccessed: workspace.lastAccessed,
    description: workspace.description ?? undefined,
    tags: workspace.tags,
    statistics: workspace.statistics
      ? {
          totalFiles: workspace.statistics.totalFiles,
          totalLines: workspace.statistics.totalLines,
          totalSize: workspace.statistics.totalSize,
          filesByLanguage: workspace.statistics.filesByLanguage,
          filesByExtension: workspace.statistics.filesByExtension,
          lastUpdated: workspace.statistics.lastUpdated,
        }
      : undefined,
    identity: mapWorkspaceIdentity(workspace.identity),
    worktree: mapWorkspaceWorktree(workspace.worktree),
    relatedPaths: (workspace.relatedPaths ?? []).map(path => ({
      path: path.path,
      description: path.description ?? undefined,
    })),
    connectionId: workspace.connectionId,
    connectionName: workspace.connectionName,
    sshHost:
      workspace.sshHost ??
      (workspace.workspaceKind?.toLowerCase() !== 'remote' ? 'localhost' : undefined),
  };
}

function mapRemoteWorkspaceSnapshot(
  workspace: APIRemoteWorkspaceSnapshot | null | undefined
): RemoteWorkspaceSnapshot | null {
  if (!workspace) {
    return null;
  }

  return {
    connectionId: workspace.connectionId,
    connectionName: workspace.connectionName,
    remotePath: workspace.remotePath,
    sshHost: workspace.sshHost?.trim() || undefined,
  };
}

function mapApplicationState(state: APIApplicationState): ApplicationState {
  const now = new Date().toISOString();
  return {
    appId: 'openbitfun',
    startupTime: new Date(Date.now() - state.uptime).toISOString(),
    version: state.version,
    userSettings: createDefaultUserSettings(),
    status: mapApiStatus(state.status),
    lastActivity: now,
  };
}

function mapWorkspaceStartupStateSnapshot(
  snapshot: APIWorkspaceStartupStateSnapshot
): WorkspaceStartupState {
  const recentWorkspaces = snapshot.recentWorkspaces
    .map(mapWorkspaceInfo)
    .filter(ws => !isExcludedFromRecentWorkspaces(ws));
  return {
    cleanupRemovedCount: snapshot.cleanupRemovedCount,
    currentWorkspace: snapshot.currentWorkspace ? mapWorkspaceInfo(snapshot.currentWorkspace) : null,
    recentWorkspaces,
    openedWorkspaces: snapshot.openedWorkspaces.map(mapWorkspaceInfo),
    primaryAssistantWorkspaceId: snapshot.primaryAssistantWorkspaceId ?? null,
    legacyRemoteWorkspace: mapRemoteWorkspaceSnapshot(snapshot.legacyRemoteWorkspace),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkspaceStartupStateSnapshot(
  value: unknown
): value is APIWorkspaceStartupStateSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.cleanupRemovedCount === 'number' &&
    (value.currentWorkspace === null || isRecord(value.currentWorkspace)) &&
    Array.isArray(value.recentWorkspaces) &&
    Array.isArray(value.openedWorkspaces) &&
    (
      value.primaryAssistantWorkspaceId === undefined ||
      value.primaryAssistantWorkspaceId === null ||
      typeof value.primaryAssistantWorkspaceId === 'string'
    ) &&
    (
      value.legacyRemoteWorkspace === undefined ||
      value.legacyRemoteWorkspace === null ||
      isRecord(value.legacyRemoteWorkspace)
    )
  );
}

function consumeBootstrapWorkspaceStartupStateSnapshot():
  | APIWorkspaceStartupStateSnapshot
  | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      globalThis,
      '__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__'
    )
  ) {
    return undefined;
  }

  const snapshot = globalThis.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__;
  delete globalThis.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__;

  if (!isWorkspaceStartupStateSnapshot(snapshot)) {
    logger.warn('Ignored invalid bootstrap workspace startup state snapshot');
    return undefined;
  }

  return snapshot;
}

 
export function createGlobalStateAPI(): GlobalStateAPI {
  return {
    
    async initializeWorkspaceStartupState(): Promise<WorkspaceStartupState> {
      const bootstrapSnapshot = consumeBootstrapWorkspaceStartupStateSnapshot();
      if (bootstrapSnapshot) {
        try {
          const mappedSnapshot = mapWorkspaceStartupStateSnapshot(bootstrapSnapshot);
          logger.debug(
            'initializeWorkspaceStartupState returned from bootstrap',
            summarizeWorkspacesForLog(mappedSnapshot.recentWorkspaces)
          );
          return mappedSnapshot;
        } catch (error) {
          logger.warn('Failed to map bootstrap workspace startup state snapshot', { error });
        }
      }

      const snapshot = await globalAPI.initializeWorkspaceStartupState();
      const mappedSnapshot = mapWorkspaceStartupStateSnapshot(snapshot);
      logger.debug(
        'initializeWorkspaceStartupState returned',
        summarizeWorkspacesForLog(mappedSnapshot.recentWorkspaces)
      );
      return mappedSnapshot;
    },

    
    async getAppState(): Promise<ApplicationState> {
      return mapApplicationState(await globalAPI.getAppState());
    },

    async updateAppStatus(status: AppStatus): Promise<void> {
      return await globalAPI.updateAppStatus(mapAppStatusToApi(status));
    },

    
    async openWorkspace(path: string): Promise<WorkspaceInfo> {
      logger.debug('openWorkspace called with', {
        path,
        pathType: typeof path,
        pathLength: path?.length,
        isEmpty: !path || path.trim() === ''
      });
      
      if (!path || path.trim() === '') {
        throw new Error('Path parameter is required and cannot be empty');
      }
      
      return mapWorkspaceInfo(await globalAPI.createLocalWorkspace(path));
    },

    async openWorkspaceById(workspaceId: string): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(await globalAPI.openWorkspaceById(workspaceId));
    },

    async openRemoteWorkspace(
      remotePath: string,
      connectionId: string,
      connectionName: string,
      sshHost?: string
    ): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(
        await globalAPI.openRemoteWorkspace(remotePath, connectionId, connectionName, sshHost)
      );
    },

    async createAssistantWorkspace(): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(await globalAPI.createAssistantWorkspace());
    },

    async getPrimaryAssistantWorkspace(): Promise<WorkspaceInfo | null> {
      const workspace = await globalAPI.getPrimaryAssistantWorkspace();
      return workspace ? mapWorkspaceInfo(workspace) : null;
    },

    async setPrimaryAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(await globalAPI.setPrimaryAssistantWorkspace(workspaceId));
    },

    async deleteAssistantWorkspace(workspaceId: string): Promise<void> {
      return await globalAPI.deleteAssistantWorkspace(workspaceId);
    },

    async resetAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(await globalAPI.resetAssistantWorkspace(workspaceId));
    },

    async closeWorkspace(workspaceId: string): Promise<void> {
      return await globalAPI.closeWorkspace(workspaceId);
    },

    async setActiveWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(await globalAPI.setActiveWorkspace(workspaceId));
    },

    async reorderOpenedWorkspaces(workspaceIds: string[]): Promise<void> {
      return await globalAPI.reorderOpenedWorkspaces(workspaceIds);
    },

    async updateWorkspaceInfo(
      workspaceId: string,
      updates: {
        name?: string;
        description?: string | null;
        tags?: string[];
        relatedPaths?: RelatedPath[];
      }
    ): Promise<WorkspaceInfo> {
      return mapWorkspaceInfo(
        await globalAPI.updateWorkspaceInfo({
          workspaceId,
          ...updates,
        })
      );
    },

    async getCurrentWorkspace(): Promise<WorkspaceInfo | null> {
      const workspace = await globalAPI.getCurrentWorkspace();
      return workspace ? mapWorkspaceInfo(workspace) : null;
    },

    async getOpenedWorkspaces(): Promise<WorkspaceInfo[]> {
      return (await globalAPI.getOpenedWorkspaces()).map(mapWorkspaceInfo);
    },

    async getRecentWorkspaces(): Promise<WorkspaceInfo[]> {
      const workspaces = (await globalAPI.getRecentWorkspaces())
        .map(mapWorkspaceInfo)
        .filter(ws => !isExcludedFromRecentWorkspaces(ws));
      logger.debug('getRecentWorkspaces returned', summarizeWorkspacesForLog(workspaces));
      return workspaces;
    },

    async removeWorkspaceFromRecent(workspaceId: string): Promise<void> {
      await globalAPI.removeRecentWorkspace(workspaceId);
    },

    async cleanupInvalidWorkspaces(): Promise<number> {
      return await globalAPI.cleanupInvalidWorkspaces();
    },

    async scanWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null> {
      const workspace = await globalAPI.scanWorkspaceInfo(workspaceId);
      return workspace ? mapWorkspaceInfo(workspace) : null;
    },

    
    async startFileWatch(workspaceId: string, path: string, recursive?: boolean): Promise<void> {
      return await workspaceAPI.startFileWatch(workspaceId, path, recursive);
    },

    async stopFileWatch(workspaceId: string, path: string): Promise<void> {
      return await workspaceAPI.stopFileWatch(workspaceId, path);
    },

    async getWatchedPaths(): Promise<string[]> {
      return await workspaceAPI.getWatchedPaths();
    },
  };
}


export const globalStateAPI = createGlobalStateAPI();
