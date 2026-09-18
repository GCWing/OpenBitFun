/**
 * Snapshot system data hook.
 */

import { useState, useCallback } from 'react';
import { snapshotAPI } from '../../infrastructure/api';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';

const log = createLogger('useSnapshot');

// Data types
export interface AgentInfo {
  agent_type: string;
  model_name: string;
  description?: string;
}

export interface SnapshotSession {
  session_id: string;
  agent_info: AgentInfo;
  start_time: string;
  operations: FileOperation[];
  status: 'Active' | 'Reviewed' | 'PartiallyAccepted' | 'FullyAccepted' | 'RolledBack' | 'Completed';
}

export interface FileOperation {
  operation_id: string;
  operation_type: 'create' | 'modify' | 'delete' | 'rename';
  file_path: string;
  tool_name: string;
  status: 'applied' | 'accepted' | 'rejected';
  timestamp: string;
  diff_summary?: {
    lines_added: number;
    lines_removed: number;
    blocks_changed: number;
  };
}

export interface SnapshotStats {
  git_isolated: boolean;
  total_sessions: number;
  active_sessions: number;
  storage_stats: {
    total_snapshots: number;
    total_size_mb: number;
    oldest_snapshot: string;
  };
}

export interface UseSnapshotReturn {
  // Data state
  sessions: SnapshotSession[];
  operations: FileOperation[];
  stats: SnapshotStats | null;
  
  // Loading state
  loading: boolean;
  error: string | null;
  
  // Actions
  updateSnapshotSession: (session: SnapshotSession) => void;  // Update snapshot session info (called on backend create)
  loadStats: () => Promise<void>;  // Manually refresh stats
  loadSessions: () => Promise<void>;  // Manually refresh sessions
  loadSessionOperations: (sessionId: string) => Promise<FileOperation[]>;
  getOperationDiff: (sessionId: string, filePath: string) => Promise<any>;
  acceptOperation: (sessionId: string, operationId: string) => Promise<void>;
  rejectOperation: (sessionId: string, operationId: string) => Promise<void>;
  rollbackSession: (sessionId: string) => Promise<void>;
  
  // Utilities
  clearError: () => void;
}

export const useSnapshot = (): UseSnapshotReturn => {
  const { t } = useI18n('errors');
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id;
  const [sessions, setSessions] = useState<SnapshotSession[]>([]);
  const [operations, setOperations] = useState<FileOperation[]>([]);
  const [stats, setStats] = useState<SnapshotStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load snapshot stats
  const loadStats = useCallback(async () => {
    try {
      setError(null);
      const statsData = await snapshotAPI.getSnapshotStats(
        workspaceId || undefined,
      );
      setStats(statsData);
    } catch (err) {
      log.error('Failed to load snapshot stats', err);
      setError(t('snapshot.loadStatsFailed'));
      setStats(null);
    }
  }, [t, workspaceId]);

  // Load snapshot sessions
  const loadSessions = useCallback(async () => {
    try {
      setError(null);
      const sessionsData = await snapshotAPI.getSnapshotSessions(
        workspaceId || undefined,
      );
      setSessions(sessionsData || []);
    } catch (err) {
      log.error('Failed to load snapshot sessions', err);
      setError(t('snapshot.loadSessionsFailed'));
      setSessions([]);
    }
  }, [t, workspaceId]);

  // Load session operations
  const loadSessionOperations = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      setOperations([]);
      return [];
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const operationsData = await snapshotAPI.getSessionOperations(sessionId, workspaceId || undefined);
      const operations = operationsData || [];
      setOperations(operations);
      return operations;
    } catch (err) {
      log.error('Failed to load session operations', err);
      setError(t('snapshot.loadOperationsFailed'));
      setOperations([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [t, workspaceId]);

  // Fetch operation diff
  const getOperationDiff = useCallback(async (sessionId: string, filePath: string) => {
    try {
      setError(null);
      const diffData = await snapshotAPI.getOperationDiff(sessionId, filePath, undefined, workspaceId || undefined);
      return diffData;
    } catch (err) {
      log.error('Failed to get operation diff', err);
      setError(t('snapshot.getDiffFailed'));
      throw err;
    }
  }, [t, workspaceId]);

  // Accept operation
  const acceptOperation = useCallback(async (sessionId: string, operationId: string) => {
    try {
      setError(null);
      await snapshotAPI.acceptOperation(sessionId, operationId, workspaceId || undefined);
      
      // Reload data
      await Promise.all([
        loadSessionOperations(sessionId),
        loadStats(),
        loadSessions()
      ]);
    } catch (err) {
      log.error('Failed to accept operation', err);
      setError(t('snapshot.acceptOperationFailed'));
    }
  }, [loadSessionOperations, loadStats, loadSessions, t, workspaceId]);

  // Reject operation
  const rejectOperation = useCallback(async (sessionId: string, operationId: string) => {
    try {
      setError(null);
      await snapshotAPI.rejectOperation(sessionId, operationId, workspaceId || undefined);
      
      // Reload data
      await Promise.all([
        loadSessionOperations(sessionId),
        loadStats(),
        loadSessions()
      ]);
    } catch (err) {
      log.error('Failed to reject operation', err);
      setError(t('snapshot.rejectOperationFailed'));
    }
  }, [loadSessionOperations, loadStats, loadSessions, t, workspaceId]);

  // Roll back the session
  const rollbackSession = useCallback(async (sessionId: string) => {
    try {
      setError(null);
      await snapshotAPI.rollbackSession(sessionId, workspaceId || undefined);
      
      // Reload data
      await Promise.all([
        loadSessionOperations(sessionId),
        loadStats(),
        loadSessions()
      ]);
    } catch (err) {
      log.error('Failed to rollback session', err);
      setError(t('snapshot.rollbackSessionFailed'));
    }
  }, [loadSessionOperations, loadStats, loadSessions, t, workspaceId]);

  // Update snapshot session info (called on backend create)
  const updateSnapshotSession = useCallback((session: SnapshotSession) => {
    setSessions(prevSessions => {
      const existingIndex = prevSessions.findIndex(s => s.session_id === session.session_id);
      if (existingIndex >= 0) {
        // Update existing session
        const newSessions = [...prevSessions];
        newSessions[existingIndex] = session;
        return newSessions;
      } else {
        // Add new session
        return [...prevSessions, session];
      }
    });
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Note: snapshot info is returned by the backend on session creation.
  // Call loadStats() and loadSessions() to refresh manually.

  return {
    // Data state
    sessions,
    operations,
    stats,
    
    // Loading state
    loading,
    error,
    
    // Actions
    updateSnapshotSession,  // Use backend snapshot session payload
    loadStats,  // Manual stats refresh
    loadSessions,  // Manual session list refresh
    loadSessionOperations,
    getOperationDiff,
    acceptOperation,
    rejectOperation,
    rollbackSession,
    
    // Utilities
    clearError
  };
};
