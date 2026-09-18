import { api } from './ApiClient';

export type SessionExecutionTargetRequest =
  | { kind: 'local' }
  | { kind: 'newManagedWorktree'; baseRef?: string; copyLocalChanges?: boolean }
  | { kind: 'existingWorktree'; worktreeId: string };

export type WorktreeLifecycle = 'managed' | 'permanent' | 'external';

export interface WorktreeSettings {
  rootPath: string;
  branchPrefix: string;
  copyLocalChanges: boolean;
  autoDeleteEnabled: boolean;
  autoDeleteLimit: number;
}

export interface SessionExecutionTarget {
  kind: 'local' | 'managedWorktree' | 'existingWorktree';
  worktreeId?: string;
  rootPath: string;
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  lifecycle?: WorktreeLifecycle;
}

export interface WorktreeSessionSummary {
  workspaceId?: string;
  sessionId: string;
  sessionName: string;
  status: string;
  archived: boolean;
}

export interface WorktreeSummary {
  workspaceId?: string;
  worktreeId: string;
  projectWorkspacePath: string;
  path: string;
  head: string;
  branch?: string;
  lifecycle: WorktreeLifecycle;
  isMain: boolean;
  dirty: boolean;
  locked: boolean;
  missing: boolean;
  hasUnpublishedCommits: boolean;
  associatedSessionCount: number;
  runningSessionCount: number;
  sessions: WorktreeSessionSummary[];
}

export interface WorktreeProjectSummary {
  /** Workspace ID of the open workspace rooted at the project's main worktree. */
  projectWorkspaceId?: string;
  projectWorkspacePath: string;
  worktrees: WorktreeSummary[];
}

/**
 * Locates the project that owns a managed worktree. The workspace ID is the
 * identity; the path is the Git IO operand and the only locator a pre-ID
 * client or an unopened project can supply.
 */
export interface WorktreeProjectLocator {
  projectWorkspaceId?: string;
  projectWorkspacePath: string;
}

export type WorktreeErrorCode =
  | 'remote_unsupported'
  | 'not_git_repository'
  | 'repository_untrusted'
  | 'unborn_repo'
  | 'invalid_base_ref'
  | 'worktree_not_found'
  | 'worktree_busy'
  | 'worktree_locked'
  | 'dirty_worktree'
  | 'unpublished_commits'
  | 'copy_conflict'
  | 'invalid_path'
  | 'branch_exists'
  | 'request_conflict'
  | 'rollback_incomplete'
  | 'git_failed'
  | 'io_failed';

interface WorktreeErrorPayload {
  code: WorktreeErrorCode;
  message: string;
  recoveryPath?: string;
}

export class WorktreeCommandError extends Error {
  constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
    public readonly recoveryPath?: string,
  ) {
    super(message);
    this.name = 'WorktreeCommandError';
  }
}

export interface WorktreeCreateRequest {
  requestId: string;
  projectWorkspaceId?: string;
  projectWorkspacePath: string;
  sourceWorkspacePath?: string;
  baseRef?: string;
  copyLocalChanges?: boolean;
}

export interface WorktreeCreateResult {
  worktree: WorktreeSummary;
  executionTarget: SessionExecutionTarget;
  created: boolean;
}

export interface WorktreeMutationResult {
  worktree: WorktreeSummary;
}

export interface WorktreeChangedEvent {
  projectWorkspacePath: string;
}

export interface WorktreeSessionBindingResult {
  projectWorkspaceId?: string;
  sessionId: string;
  workspacePath: string;
  projectWorkspacePath: string;
  workspaceId?: string;
  executionTarget: SessionExecutionTarget;
  /** Set when a released worktree was kept because it still held local work. */
  retainedWorktreePath?: string;
}

const WORKTREE_ERROR_CODES = new Set<WorktreeErrorCode>([
  'remote_unsupported',
  'not_git_repository',
  'repository_untrusted',
  'unborn_repo',
  'invalid_base_ref',
  'worktree_not_found',
  'worktree_busy',
  'worktree_locked',
  'dirty_worktree',
  'unpublished_commits',
  'copy_conflict',
  'invalid_path',
  'branch_exists',
  'request_conflict',
  'rollback_incomplete',
  'git_failed',
  'io_failed',
]);

function isWorktreeErrorCode(value: unknown): value is WorktreeErrorCode {
  return typeof value === 'string' && WORKTREE_ERROR_CODES.has(value as WorktreeErrorCode);
}

function fallbackErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
    try {
      return JSON.stringify(error) || 'Unknown worktree command error';
    } catch {
      return 'Unknown worktree command error';
    }
  }
  return String(error);
}

export function toWorktreeCommandError(error: unknown): WorktreeCommandError {
  const candidates: unknown[] = [error];
  const visited = new Set<object>();
  while (candidates.length > 0) {
    let value = candidates.shift();
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    }
    if (value && typeof value === 'object') {
      if (visited.has(value)) continue;
      visited.add(value);
      const payload = value as Partial<WorktreeErrorPayload> & Record<string, unknown>;
      if (isWorktreeErrorCode(payload.code) && typeof payload.message === 'string') {
        return new WorktreeCommandError(
          payload.code,
          payload.message,
          payload.recoveryPath,
        );
      }
      const details = payload.details;
      candidates.push(
        payload.data,
        payload.cause,
        payload.originalError,
        payload.error,
        payload.message,
        details && typeof details === 'object'
          ? (details as Record<string, unknown>).originalError
          : undefined,
        details,
      );
    }
  }
  return new WorktreeCommandError('git_failed', fallbackErrorMessage(error));
}

function projectLocatorRequest(project: WorktreeProjectLocator): WorktreeProjectLocator {
  const projectWorkspaceId = project.projectWorkspaceId?.trim();
  return {
    ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
    projectWorkspacePath: project.projectWorkspacePath,
  };
}

async function invokeWorktree<T>(command: string, request: unknown): Promise<T> {
  try {
    return await api.invoke<T>(command, { request });
  } catch (error) {
    throw toWorktreeCommandError(error);
  }
}

export class WorktreeAPI {
  list(project: WorktreeProjectLocator): Promise<WorktreeSummary[]> {
    return invokeWorktree('worktree_list', projectLocatorRequest(project));
  }

  listProjects(): Promise<WorktreeProjectSummary[]> {
    return invokeWorktree('worktree_list_projects', {});
  }

  create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult> {
    return invokeWorktree('worktree_create', request);
  }

  createBranch(
    project: WorktreeProjectLocator,
    worktreeId: string,
    branch: string,
    requestId: string,
  ): Promise<WorktreeMutationResult> {
    return invokeWorktree('worktree_create_branch', {
      ...projectLocatorRequest(project),
      worktreeId,
      branch,
      requestId,
    });
  }

  promote(
    project: WorktreeProjectLocator,
    worktreeId: string,
    requestId: string,
  ): Promise<WorktreeMutationResult> {
    return invokeWorktree('worktree_promote', {
      ...projectLocatorRequest(project),
      worktreeId,
      requestId,
    });
  }

  remove(
    project: WorktreeProjectLocator,
    worktreeId: string,
    requestId: string,
    force = false,
  ): Promise<{ worktreeId: string; removed: boolean }> {
    return invokeWorktree('worktree_remove', {
      ...projectLocatorRequest(project),
      worktreeId,
      requestId,
      force,
    });
  }

  recreate(
    project: WorktreeProjectLocator,
    worktreeId: string,
    requestId: string,
  ): Promise<WorktreeMutationResult> {
    return invokeWorktree('worktree_recreate', {
      ...projectLocatorRequest(project),
      worktreeId,
      requestId,
    });
  }

  /**
   * Materialize an empty session's requested execution root. Composer controls
   * call this only after the first prompt has been submitted.
   */
  bindSession(
    sessionId: string,
    enabled: boolean,
    requestId: string,
    project: WorktreeProjectLocator,
  ): Promise<WorktreeSessionBindingResult> {
    return invokeWorktree('worktree_bind_session', {
      sessionId,
      enabled,
      requestId,
      ...projectLocatorRequest(project),
    });
  }

  onChanged(callback: (event: WorktreeChangedEvent) => void): () => void {
    return api.listen<WorktreeChangedEvent>('worktree://changed', callback);
  }
}

export const worktreeAPI = new WorktreeAPI();
