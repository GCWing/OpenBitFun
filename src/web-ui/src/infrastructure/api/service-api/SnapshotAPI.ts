import { invokePrepared } from './invokePrepared';
 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { workspaceIdRequest } from './legacyWorkspaceCompatibility';

const log = createLogger('SnapshotAPI');

const requireWorkspaceId = (workspaceId?: string): string => {
  if (!workspaceId) throw new Error('workspaceId is required for snapshot operations');
  return workspaceId;
};

interface SnapshotSessionScope { workspaceId: string }

const requireSessionSnapshotScope = (
  sessionId: string, workspaceId?: string,
): SnapshotSessionScope => {
  const session = flowChatStore.getState().sessions.get(sessionId);
  const ownerId = session?.workspaceId || session?.config?.workspaceId;
  if (workspaceId && ownerId && workspaceId !== ownerId) {
    throw new Error(`Snapshot workspace ID does not match session: ${sessionId}`);
  }
  return { workspaceId: requireWorkspaceId(ownerId || workspaceId) };
};

const snapshotScopeKey = (scope: SnapshotSessionScope): string => scope.workspaceId;

/** Only call inside an invokePrepared preparation, which owns the device scope. */
const snapshotWorkspaceRequest = (workspaceId: string) => workspaceIdRequest(workspaceId, 'workspacePath');



export interface SandboxSessionModifications {
  hasModifications: boolean;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  modifiedFiles: Array<{
    filePath: string;
    toolName: string;
    operationType: string;
    additions: number;
    deletions: number;
  }>;
}

export interface SandboxOperationDiff {
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  diff?: string;
  operationType?: string;
  toolName?: string;
  anchorLine?: number | null;
}

export interface SessionFileDiffStats {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  approximate: boolean;
  changeKind: 'create' | 'modify' | 'delete';
}

export interface GetSessionModificationsRequest {
  sessionId: string;
}

export interface GetOperationDiffRequest {
  sessionId: string;
  filePath: string;
  operationId?: string;
}

export interface GetBaselineSnapshotDiffRequest {
  filePath: string;
}

export interface SandboxOperationSummary {
  operationId: string;
  sessionId: string;
  turnIndex?: number | null;
  seqInTurn?: number | null;
  filePath?: string | null;
  operationType?: string | null;
  toolName?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
}

export interface GetOperationSummaryRequest {
  sessionId: string;
  operationId: string;
}

export interface AcceptSessionModificationsRequest {
  sessionId: string;
}

export interface RejectSessionModificationsRequest {
  sessionId: string;
}

export interface AcceptFileModificationsRequest {
  sessionId: string;
  filePath: string;
}

export interface RejectFileModificationsRequest {
  sessionId: string;
  filePath: string;
}

export interface AcceptDiffBlockRequest {
  sessionId: string;
  filePath: string;
  blockIndex: number;
}

export interface RejectDiffBlockRequest {
  sessionId: string;
  filePath: string;
  blockIndex: number;
}

export interface AcceptOperationRequest {
  sessionId: string;
  operationId: string;
}

export interface RejectOperationRequest {
  sessionId: string;
  operationId: string;
}

export interface RollbackSessionRequest {
  sessionId: string;
}

export interface CleanupSandboxDataRequest {
  maxAgeDays: number;
}

export class SnapshotAPI {
  private readonly inFlightRequests = new Map<string, Promise<unknown>>();

  private dedupeInFlight<T>(requestKey: string, load: () => Promise<T>): Promise<T> {
    const scope = getActiveSurfaceScope();
    const key = scope.key(scope.epoch, requestKey);
    const existing = this.inFlightRequests.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const request = load().finally(() => {
      if (this.inFlightRequests.get(key) === request) {
        this.inFlightRequests.delete(key);
      }
    });
    this.inFlightRequests.set(key, request);
    return request;
  }

   
  async getSessionStats(sessionId: string, workspaceId?: string): Promise<{
    session_id: string;
    total_files: number;
    total_turns: number;
    total_changes: number;
  }> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      const key = `get_session_stats:${snapshotScopeKey(scope)}:${sessionId}`;
      return await this.dedupeInFlight(key, async () => invokePrepared('get_session_stats', async () => ({
        request: { session_id: sessionId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      })));
    } catch (error) {
      throw createTauriCommandError('get_session_stats', error, { sessionId, workspaceId });
    }
  }

   
  async getSessionFiles(sessionId: string, workspaceId?: string): Promise<string[]> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      const key = `get_session_files:${snapshotScopeKey(scope)}:${sessionId}`;
      return await this.dedupeInFlight(key, async () => invokePrepared('get_session_files', async () => ({
        request: { session_id: sessionId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      })));
    } catch (error) {
      throw createTauriCommandError('get_session_files', error, { sessionId, workspaceId });
    }
  }

   
  async getOperationDiff(
    sessionId: string,
    filePath: string,
    operationId?: string,
    workspaceId?: string,
  ): Promise<SandboxOperationDiff> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      return await invokePrepared('get_operation_diff', async () => ({
        request: { sessionId, filePath, operationId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_operation_diff', error, {
        sessionId,
        filePath,
        operationId,
        workspaceId,
      });
    }
  }

  async getSessionFileDiffStats(
    sessionId: string,
    filePath: string,
    workspaceId?: string,
  ): Promise<SessionFileDiffStats> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      const key = `get_session_file_diff_stats:${snapshotScopeKey(scope)}:${sessionId}:${filePath}`;
      return await this.dedupeInFlight(key, async () => invokePrepared('get_session_file_diff_stats', async () => ({
        request: { sessionId, filePath, ...await snapshotWorkspaceRequest(scope.workspaceId) },
      })));
    } catch (error) {
      throw createTauriCommandError('get_session_file_diff_stats', error, {
        sessionId,
        filePath,
        workspaceId,
      });
    }
  }

  async getOperationSummary(
    sessionId: string,
    operationId: string,
    workspaceId?: string,
  ): Promise<SandboxOperationSummary> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      const key = `get_operation_summary:${snapshotScopeKey(scope)}:${sessionId}:${operationId}`;
      return await this.dedupeInFlight(key, async () => invokePrepared('get_operation_summary', async () => ({
        request: { sessionId, operationId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      })));
    } catch (error) {
      throw createTauriCommandError('get_operation_summary', error, {
        sessionId,
        operationId,
        workspaceId,
      });
    }
  }

   
  async getBaselineSnapshotDiff(
    filePath: string,
    workspaceId?: string,
  ): Promise<SandboxOperationDiff> {
    try {
      const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
      return await invokePrepared('get_baseline_snapshot_diff', async () => ({
        request: { filePath, ...await snapshotWorkspaceRequest(resolvedWorkspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_baseline_snapshot_diff', error, { filePath, workspaceId });
    }
  }



   
  async acceptSessionModifications(sessionId: string, workspaceId?: string): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('accept_session', async () => ({
        request: { sessionId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('accept_session', error, { sessionId, workspaceId });
    }
  }

   
  async rejectSessionModifications(sessionId: string, workspaceId?: string): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('rollback_session', async () => ({
        request: { sessionId, deleteSession: true, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('rollback_session', error, { sessionId, workspaceId });
    }
  }

   
  async acceptFileModifications(
    sessionId: string,
    filePath: string,
    workspaceId?: string,
  ): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('accept_file', async () => ({
        request: { sessionId, filePath, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('accept_file', error, { sessionId, filePath, workspaceId });
    }
  }

   
  async rejectFileModifications(
    sessionId: string,
    filePath: string,
    workspaceId?: string,
  ): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('reject_file', async () => ({
        request: { sessionId, filePath, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('reject_file', error, { sessionId, filePath, workspaceId });
    }
  }

   
  async acceptDiffBlock(sessionId: string, filePath: string, blockIndex: number): Promise<void> {
    try {
      await api.invoke('accept_diff_block', { 
        request: { sessionId, filePath, blockId: blockIndex.toString() } 
      });
    } catch (error) {
      throw createTauriCommandError('accept_diff_block', error, { sessionId, filePath, blockIndex });
    }
  }

   
  async rejectDiffBlock(sessionId: string, filePath: string, blockIndex: number): Promise<void> {
    try {
      await api.invoke('reject_diff_block', { 
        request: { sessionId, filePath, blockId: blockIndex.toString() } 
      });
    } catch (error) {
      throw createTauriCommandError('reject_diff_block', error, { sessionId, filePath, blockIndex });
    }
  }

   
  async acceptOperation(
    sessionId: string,
    operationId: string,
    workspaceId?: string,
  ): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('accept_operation', async () => ({
        request: { sessionId, operationId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('accept_operation', error, { sessionId, operationId, workspaceId });
    }
  }

   
  async rejectOperation(
    sessionId: string,
    operationId: string,
    workspaceId?: string,
  ): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('reject_operation', async () => ({
        request: { sessionId, operationId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('reject_operation', error, { sessionId, operationId, workspaceId });
    }
  }

   
  async rollbackSession(sessionId: string, workspaceId?: string): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('rollback_session', async () => ({
        request: { sessionId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('rollback_session', error, { sessionId, workspaceId });
    }
  }

  async cleanupEmptySessions(): Promise<any> {
    try {
      return await api.invoke('cleanup_empty_sessions', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('cleanup_empty_sessions', error);
    }
  }

   
  async getSnapshotStats(
    workspaceId?: string,
  ): Promise<any> {
    try {
      const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
      return await invokePrepared('get_snapshot_system_stats', async () => ({
        request: { ...await snapshotWorkspaceRequest(resolvedWorkspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_snapshot_system_stats', error, { workspaceId });
    }
  }

   
  async getSnapshotSessions(
    workspaceId?: string,
  ): Promise<any> {
    try {
      const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
      return await invokePrepared('get_snapshot_sessions', async () => ({
        request: { ...await snapshotWorkspaceRequest(resolvedWorkspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_snapshot_sessions', error, { workspaceId });
    }
  }

   
  async getSessionOperations(sessionId: string, workspaceId?: string): Promise<any> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      return await invokePrepared('get_session_operations', async () => ({
        request: { sessionId, ...await snapshotWorkspaceRequest(scope.workspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_session_operations', error, { sessionId, workspaceId });
    }
  }

  

   
  async recordTurnSnapshot(
    sessionId: string,
    turnIndex: number,
    modifiedFiles: string[],
    workspaceId?: string,
  ): Promise<void> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      await invokePrepared('record_turn_snapshot', async () => ({
        session_id: sessionId,
        turn_index: turnIndex,
        modified_files: modifiedFiles,
        ...await snapshotWorkspaceRequest(scope.workspaceId),
      }));
    } catch (error) {
      throw createTauriCommandError('record_turn_snapshot', error, {
        sessionId,
        turnIndex,
        modifiedFiles,
        workspaceId,
      });
    }
  }

   
  async rollbackEntireSession(
    sessionId: string,
    deleteSession: boolean = true,
    workspaceId?: string,
  ): Promise<string[]> {
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      return await invokePrepared('rollback_session', async () => ({
        request: {
          session_id: sessionId,
          delete_session: deleteSession,
          ...await snapshotWorkspaceRequest(scope.workspaceId),
        }
      }));
    } catch (error) {
      throw createTauriCommandError('rollback_session', error, { sessionId, workspaceId });
    }
  }

   
  async getSessionTurnSnapshots(
    sessionId: string,
    workspaceId?: string,
  ): Promise<TurnSnapshot[]> {
    const surface = getActiveSurfaceScope();
    try {
      const scope = requireSessionSnapshotScope(sessionId, workspaceId);
      
      const turnIndices: number[] = await invokePrepared('get_session_turns', async () => ({
        request: {
          session_id: sessionId,
          ...await snapshotWorkspaceRequest(scope.workspaceId),
        }
      }));

      
      const turnSnapshots: TurnSnapshot[] = [];
      for (const turnIndex of turnIndices) {
        surface.assertCurrent('read session turn snapshots');
        try {
          const files: string[] = await invokePrepared('get_turn_files', async () => ({
            request: {
              session_id: sessionId,
              turn_index: turnIndex,
              ...await snapshotWorkspaceRequest(scope.workspaceId),
            }
          }));
          surface.assertCurrent('read session turn snapshots');

          turnSnapshots.push({
            sessionId,
            turnIndex,
            modifiedFiles: files,
            timestamp: Date.now() / 1000, 
          });
        } catch (error) {
          if (isSurfaceChangedError(error)) throw error;
          surface.assertCurrent('read session turn snapshots');
          log.warn('Failed to get turn files', { sessionId, turnIndex, error });
          // Continue processing the remaining turns.
          turnSnapshots.push({
            sessionId,
            turnIndex,
            modifiedFiles: [],
            timestamp: Date.now() / 1000,
          });
        }
      }

      surface.assertCurrent('read session turn snapshots');
      return turnSnapshots;
    } catch (error) {
      throw createTauriCommandError('get_session_turns', error, { sessionId, workspaceId });
    }
  }

   
  async getFileChangeHistory(
    filePath: string,
    workspaceId?: string,
  ): Promise<FileChangeEntry[]> {
    try {
      const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
      const result = await invokePrepared('get_file_change_history', async () => ({
        request: { file_path: filePath, ...await snapshotWorkspaceRequest(resolvedWorkspaceId) }
      }));
      return result as FileChangeEntry[];
    } catch (error) {
      throw createTauriCommandError('get_file_change_history', error, { filePath, workspaceId });
    }
  }

   
  async getAllModifiedFiles(
    workspaceId?: string,
  ): Promise<string[]> {
    try {
      const resolvedWorkspaceId = requireWorkspaceId(workspaceId);
      return await invokePrepared('get_all_modified_files', async () => ({
        request: { ...await snapshotWorkspaceRequest(resolvedWorkspaceId) }
      }));
    } catch (error) {
      throw createTauriCommandError('get_all_modified_files', error, { workspaceId });
    }
  }
}


export interface TurnSnapshot {
  sessionId: string;
  turnIndex: number;
  modifiedFiles: string[];
  timestamp: number;
}


export interface FileChangeEntry {
  session_id: string;
  turn_index: number;
  snapshot_id: string;
  timestamp: {
    secs_since_epoch: number;
    nanos_since_epoch: number;
  };
  operation_type: string;
  tool_name: string;
}


export const snapshotAPI = new SnapshotAPI();
