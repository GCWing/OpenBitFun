import { sessionWorkspaceIdRequest } from './legacyWorkspaceCompatibility';

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  DialogTurnData,
  SessionMetadata,
  SessionActivitySummary,
} from '@/shared/types/session-history';

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}

export type UiSessionMetadataField =
  | 'sessionName'
  | 'tags'
  | 'todos'
  | 'reviewActionState'
  | 'unreadCompletion'
  | 'needsUserAttention'
  | 'titleMetadata';

export interface SessionMetadataPageRequest {
  workspaceId: string;
  limit: number;
  cursor?: string;
  /** Read only these summaries (max 128), without returning metadata rows. */
  sessionIds?: string[];
}

export interface SessionMetadataPage {
  sessions: SessionMetadata[];
  totalTopLevelCount: number;
  loadedTopLevelCount: number;
  nextCursor?: string;
  hasMore: boolean;
  /** Absent on older hosts; never interpret absence as an empty snapshot. */
  activities?: SessionActivitySummary[];
}

export interface SessionLineageRequest {
  sessionId: string;
  workspaceId: string;
}

export interface SessionLineageSnapshot {
  rootSessionId: string;
  sessions: SessionLineageEntry[];
}

export interface SessionLineageEntry {
  sessionId: string;
  sessionName: string;
  agentType: string;
  createdAtMs: number;
  status: 'active' | 'archived' | 'completed';
  activeTurnId?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  subagentType?: string;
  agentId?: string;
  /** Owning workspace ID; authoritative when present. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  unreadCompletion?: 'completed' | 'error' | 'interrupted';
  needsUserAttention?: 'ask_user' | 'tool_confirm';
}

export interface SessionReferenceCandidate {
  sessionId: string;
  sessionName: string;
  /** Owning workspace ID; the reference identity sent back with the turn. */
  workspaceId: string;
  /** Display/IO projection of the owning workspace root. */
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  workspaceLabel: string;
  lastActivityAt: number;
}

export type SessionSearchHitKind = 'session' | 'message';

export type SessionSearchMatchField =
  | 'title'
  | 'tags'
  | 'user_message'
  | 'assistant_message';

export interface SessionSearchHit {
  kind: SessionSearchHitKind;
  matchedField: SessionSearchMatchField;
  sessionId: string;
  sessionTitle: string;
  turnId?: string;
  /** Zero-based visible Turn ordinal returned by the product-search service. */
  turnIndex?: number;
  snippet: string;
  archived: boolean;
  updatedAtMs: number;
  score: number;
}

export interface SessionSearchDiagnostic {
  code: 'session_unreadable' | 'session_index_stale';
  sessionId?: string;
  message: string;
}

export interface SessionContentSearchRequest {
  workspaceId: string;
  /** Legacy IO projection for peers that predate workspace IDs. */
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  query: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface SessionContentSearchResponse {
  hits: SessionSearchHit[];
  truncated: boolean;
  diagnostics?: SessionSearchDiagnostic[];
}

export interface SessionUsageReportRequest {
  sessionId: string;
  workspaceId: string;
  includeHiddenSubagents?: boolean;
}

export type UsageModelIdentitySource = 'recorded' | 'inferred_session_model' | 'legacy_missing';

export interface SessionUsageReport {
  schemaVersion: number;
  reportId: string;
  sessionId: string;
  generatedAt: number;
  generatedFromAppVersion?: string;
  workspace: {
    kind: 'local' | 'remote_ssh' | 'unknown';
    pathLabel?: string;
    workspaceId?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
  };
  scope: {
    kind: 'entire_session' | 'turn_range';
    turnCount: number;
    fromTurnId?: string;
    toTurnId?: string;
    includesSubagents: boolean;
  };
  coverage: {
    level: 'complete' | 'partial' | 'minimal';
    available: string[];
    missing: string[];
    notes: string[];
  };
  time: {
    accounting: 'approximate' | 'exact' | 'unavailable';
    denominator: 'session_wall_time' | 'active_turn_time' | 'unavailable';
    wallTimeMs?: number;
    activeTurnMs?: number;
    modelMs?: number;
    toolMs?: number;
    idleGapMs?: number;
  };
  tokens: {
    source: 'token_usage_records' | 'unavailable';
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    cacheCoverage: 'available' | 'partial' | 'unavailable';
    /** `cached / input` over records that explicitly report cached tokens. Range 0–1. */
    cacheHitRate?: number;
  };
  models: Array<{
    modelId: string;
    modelIdSource?: UsageModelIdentitySource;
    callCount: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    /** Per-model hit rate. Same semantic as `tokens.cacheHitRate`. */
    cacheHitRate?: number;
    durationMs?: number;
    sampleTurnId?: string;
    sampleTurnIndex?: number;
  }>;
  tools: Array<{
    toolName: string;
    category?: 'git' | 'shell' | 'file' | 'other';
    callCount: number;
    successCount: number;
    errorCount: number;
    durationMs?: number;
    p95DurationMs?: number;
    queueWaitMs?: number;
    preflightMs?: number;
    confirmationWaitMs?: number;
    executionMs?: number;
    sampleTurnId?: string;
    sampleTurnIndex?: number;
    sampleItemId?: string;
    redacted: boolean;
  }>;
  files: {
    scope: 'snapshot_summary' | 'tool_inputs_only' | 'unavailable';
    changedFiles?: number;
    addedLines?: number;
    deletedLines?: number;
    files: Array<{
      pathLabel: string;
      operationCount: number;
      addedLines?: number;
      deletedLines?: number;
      sessionId?: string;
      turnIndexes?: number[];
      operationIds?: string[];
      redacted: boolean;
    }>;
  };
  compression: {
    compactionCount: number;
    manualCompactionCount: number;
    automaticCompactionCount: number;
    savedTokens?: number;
  };
  errors: {
    totalErrors: number;
    toolErrors: number;
    modelErrors: number;
    examples: Array<{
      label: string;
      count: number;
      sampleTurnId?: string;
      sampleTurnIndex?: number;
      sampleItemId?: string;
      redacted: boolean;
    }>;
  };
  slowest: Array<{
    label: string;
    kind: 'model' | 'tool' | 'turn';
    durationMs: number;
    redacted: boolean;
    turnId?: string;
    turnIndex?: number;
    itemId?: string;
    inputSummary?: string;
    status?: string;
    timeoutSeconds?: number;
    exitCode?: number;
    timedOut?: boolean;
    errorSummary?: string;
    queueWaitMs?: number;
    preflightMs?: number;
    confirmationWaitMs?: number;
    executionMs?: number;
    modelIdSource?: UsageModelIdentitySource;
  }>;
  privacy: {
    promptContentIncluded: boolean;
    toolInputsIncluded: boolean;
    commandOutputsIncluded: boolean;
    fileContentsIncluded: boolean;
    redactedFields: string[];
  };
}

export class SessionAPI {
  async searchSessionContent(
    request: SessionContentSearchRequest,
    signal?: AbortSignal,
  ): Promise<SessionContentSearchResponse> {
    try {
      return await api.invoke('search_session_content', {
        request: {
          workspaceId: request.workspaceId,
          workspacePath: request.workspacePath,
          ...(request.remoteConnectionId
            ? { remoteConnectionId: request.remoteConnectionId }
            : {}),
          ...(request.remoteSshHost ? { remoteSshHost: request.remoteSshHost } : {}),
          query: request.query,
          limit: request.limit ?? 40,
          includeArchived: request.includeArchived ?? false,
        },
      }, { signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw createTauriCommandError('search_session_content', error, {
        queryLength: Array.from(request.query).length,
        remote: Boolean(request.remoteConnectionId || request.remoteSshHost),
        includeArchived: request.includeArchived ?? false,
      });
    }
  }

  async searchReferenceableSessions(
    query: string,
    limit = 30,
  ): Promise<SessionReferenceCandidate[]> {
    try {
      return await api.invoke('search_referenceable_sessions', {
        request: { query, limit },
      });
    } catch (error) {
      throw createTauriCommandError('search_referenceable_sessions', error, { query, limit });
    }
  }

  async forkSession(
    sourceSessionId: string,
    sourceTurnId: string,
    workspaceId: string
  ): Promise<{ sessionId: string; sessionName: string; agentType: string }> {
    try {
      return await api.invoke('fork_session', {
        request: {
          source_session_id: sourceSessionId,
          source_turn_id: sourceTurnId,
          ...await sessionWorkspaceIdRequest(workspaceId),
        }
      });
    } catch (error) {
      throw createTauriCommandError('fork_session', error, {
        sourceSessionId,
        sourceTurnId,
        workspaceId,
      });
    }
  }

  async listSessions(workspaceId: string): Promise<SessionMetadata[]> {
    return api.invoke('list_persisted_sessions', {
      request: await sessionWorkspaceIdRequest(workspaceId),
    });
  }

  async listSessionsPage(
    request: SessionMetadataPageRequest
  ): Promise<SessionMetadataPage> {
    try {
      return await api.invoke('list_persisted_sessions_page', {
        request: {
          ...await sessionWorkspaceIdRequest(request.workspaceId),
          limit: request.limit,
          ...(request.cursor ? { cursor: request.cursor } : {}),
          ...(request.sessionIds ? { session_ids: request.sessionIds } : {}),
        }
      });
    } catch (error) {
      throw createTauriCommandError('list_persisted_sessions_page', error, {
        workspaceId: request.workspaceId,
        limit: request.limit,
        cursor: request.cursor,
      });
    }
  }

  async getSessionLineage(
    request: SessionLineageRequest
  ): Promise<SessionLineageSnapshot | null> {
    try {
      return await api.invoke('get_session_lineage', {
        request: {
          session_id: request.sessionId,
          ...await sessionWorkspaceIdRequest(request.workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('get_session_lineage', error, {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
      });
    }
  }

  async loadSessionTurns(
    sessionId: string,
    workspaceId: string,
    limit?: number
  ): Promise<DialogTurnData[]> {
    try {
      const request: Record<string, unknown> = {
        session_id: sessionId,
        ...await sessionWorkspaceIdRequest(workspaceId),

      };

      if (limit !== undefined) {
        request.limit = limit;
      }

      return await api.invoke('load_session_turns', {
        request
      });
    } catch (error) {
      throw createTauriCommandError('load_session_turns', error, { sessionId, workspaceId, limit });
    }
  }

  async saveSessionTurn(
    turnData: DialogTurnData,
    workspaceId: string
  ): Promise<void> {
    try {
      await api.invoke('save_session_turn', {
        request: {
          turn_data: turnData,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('save_session_turn', error, { turnData, workspaceId });
    }
  }

  async saveSessionMetadata(
    metadata: SessionMetadata,
    workspaceId: string,
    fields: UiSessionMetadataField[]
  ): Promise<void> {
    try {
      await api.invoke('save_session_metadata', {
        request: {
          metadata,
          fields,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('save_session_metadata', error, { metadata, workspaceId });
    }
  }

  async deleteSession(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    try {
      await api.invoke('delete_persisted_session', {
        request: {
          session_id: sessionId,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('delete_persisted_session', error, { sessionId, workspaceId });
    }
  }

  async touchSessionActivity(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    try {
      await api.invoke('touch_session_activity', {
        request: {
          session_id: sessionId,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('touch_session_activity', error, { sessionId, workspaceId });
    }
  }

  async loadSessionMetadata(
    sessionId: string,
    workspaceId: string
  ): Promise<SessionMetadata | null> {
    try {
      return await api.invoke('load_persisted_session_metadata', {
        request: {
          session_id: sessionId,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('load_persisted_session_metadata', error, { sessionId, workspaceId });
    }
  }

  async getSessionUsageReport(
    request: SessionUsageReportRequest
  ): Promise<SessionUsageReport> {
    try {
      return await api.invoke('get_session_usage_report', {
        request: {
          session_id: request.sessionId,
          ...await sessionWorkspaceIdRequest(request.workspaceId),
          include_hidden_subagents: request.includeHiddenSubagents ?? true,

        }
      });
    } catch (error) {
      throw createTauriCommandError('get_session_usage_report', error, {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
      });
    }
  }

  async archiveSession(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    try {
      await api.invoke('archive_session', {
        request: {
          session_id: sessionId,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('archive_session', error, { sessionId, workspaceId });
    }
  }

  async unarchiveSession(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    try {
      await api.invoke('unarchive_session', {
        request: {
          session_id: sessionId,
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('unarchive_session', error, { sessionId, workspaceId });
    }
  }

  async archiveAllSessions(
    workspaceId: string
  ): Promise<number> {
    try {
      return await api.invoke('archive_all_sessions', {
        request: {
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('archive_all_sessions', error, { workspaceId });
    }
  }

  async listArchivedSessions(
    workspaceId: string
  ): Promise<SessionMetadata[]> {
    try {
      return await api.invoke('list_archived_sessions', {
        request: {
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('list_archived_sessions', error, { workspaceId });
    }
  }

  async deleteAllArchivedSessions(
    workspaceId: string
  ): Promise<number> {
    try {
      return await api.invoke('delete_all_archived_sessions', {
        request: {
          ...await sessionWorkspaceIdRequest(workspaceId),

        }
      });
    } catch (error) {
      throw createTauriCommandError('delete_all_archived_sessions', error, { workspaceId });
    }
  }
}

export const sessionAPI = new SessionAPI();
