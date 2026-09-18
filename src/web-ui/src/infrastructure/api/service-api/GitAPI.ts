 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { workspaceIdRequest } from './legacyWorkspaceCompatibility';
import { startupTrace } from '@/shared/utils/startupTrace';

const log = createLogger('GitAPI');
const REPOSITORY_PROBE_CACHE_TTL_MS = 1000;

/** Workspace identity is mandatory; repositoryPath is a display/evidence projection only. */
export interface GitWorkspaceScope {
  workspaceId: string;
  repositoryPath?: string;
}

export function gitWorkspaceKey(scope: GitWorkspaceScope): string {
  if (!scope.workspaceId) throw new Error('Git requires a workspace ID');
  return JSON.stringify([getActiveSurfaceScope().surfaceId, scope.workspaceId]);
}

async function gitWorkspaceRequest(scope: GitWorkspaceScope) {
  const wire = await workspaceIdRequest(scope.workspaceId, 'repositoryPath');
  return wire;
}

export interface GitRepository {
  path: string;
  name: string;
  current_branch: string;
  is_bare: boolean;
  has_changes: boolean;
  remotes: string[];
  
  branch?: string;
  remote?: string;
  lastCommit?: string;
}


export interface GitFileStatusDetail {
   
  path: string;
   
  status: string;
   
  index_status?: string;
   
  workdir_status?: string;
}

export interface GitStatus {
  staged: GitFileStatusDetail[];
  unstaged: GitFileStatusDetail[];
  untracked: string[];
  conflicts: string[];
  current_branch: string;
  ahead: number;
  behind: number;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  files?: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  lastCommit?: string;
  ahead?: number;
  behind?: number;
}

export interface GitOperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface GitAddParams {
  files: string[];
  all?: boolean;
}

export interface GitCommitParams {
  message: string;
  amend?: boolean;
  signoff?: boolean;
}

export interface GitPushParams {
  remote?: string;
  branch?: string;
  force?: boolean;
  setUpstream?: boolean;
}

export interface GitPullParams {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitDiffParams {
  source?: string;
  target?: string;
  files?: string[];
  stat?: boolean;
  filePath?: string;
  staged?: boolean;
  commit?: string;
  /** Use the bounded, non-interactive path reserved for Review evidence. */
  reviewSafe?: boolean;
}

export interface GitChangedFilesParams {
  source?: string;
  target?: string;
  staged?: boolean;
  /** Use the bounded, non-interactive path reserved for Review evidence. */
  reviewSafe?: boolean;
}

export type GitChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unknown';

export interface GitChangedFile {
  path: string;
  old_path?: string;
  status: GitChangedFileStatus;
}

export interface GitLogParams {
  maxCount?: number;
  since?: string;
  until?: string;
  author?: string;
}

export interface GitOperationParams {
  repositoryPath: string;
  command: string;
  args?: string[];
}


export interface GitGraphRef {
  name: string;
  refType: 'branch' | 'remote' | 'tag';
  isCurrent: boolean;
  isHead: boolean;
}

export interface GitGraphNode {
  hash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
  children: string[];
  refs: GitGraphRef[];
  lane: number;
  forkingLanes: number[];
  mergingLanes: number[];
  passingLanes: number[];
}

export interface GitGraph {
  nodes: GitGraphNode[];
  maxLane: number;
  currentBranch?: string;
}


export interface GitWorktreeInfo {
   
  path: string;
   
  branch: string | null;
  /** HEAD commit hash */
  head: string;
   
  isMain: boolean;
   
  isLocked: boolean;
   
  isPrunable: boolean;
}

/**
 * Whether Git will operate on a repository, and why not when it refuses.
 *
 * `trust_required` means the repository exists but its directory is owned by
 * another user, so Git blocks it until the path is listed in `safe.directory`.
 */
export type GitTrustState = 'trusted' | 'trust_required' | 'not_a_repository';

export interface GitTrustReport {
  state: GitTrustState;
  /** Path Git reported, normalized to the shape it compares against. */
  repositoryPath: string | null;
  /** Git's own diagnostic, kept for support and for the manual path. */
  detail: string | null;
  /** Command the user can run themselves when we cannot apply the change. */
  manualCommand: string | null;
}

export interface GitTrustOutcome {
  state: GitTrustState;
  repositoryPath: string | null;
  alreadyTrusted: boolean;
  /** `safe.directory` entries added by this call; empty when nothing changed. */
  addedEntries: string[];
  detail: string | null;
  manualCommand: string | null;
}

export class GitAPI {
  private repositoryProbeCache = new Map<string, {
    value: boolean;
    expiresAt: number;
  }>();
  private repositoryProbeInFlight = new Map<string, Promise<boolean>>();


  async isGitRepository(workspace: GitWorkspaceScope): Promise<boolean> {
    // Host and workspace identity isolate probes even when repository paths match.
    const key = gitWorkspaceKey(workspace);
    const now = Date.now();
    const cached = this.repositoryProbeCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inFlight = this.repositoryProbeInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }

    const probe = gitWorkspaceRequest(workspace)
      .then(request => api.invoke<boolean>('git_is_repository', { request }))
      .then((value) => {
        this.repositoryProbeCache.set(key, {
          value,
          expiresAt: Date.now() + REPOSITORY_PROBE_CACHE_TTL_MS,
        });
        return value;
      })
      .catch((error) => {
        throw createTauriCommandError('git_is_repository', error, { workspace });
      })
      .finally(() => {
        this.repositoryProbeInFlight.delete(key);
      });

    this.repositoryProbeInFlight.set(key, probe);
    return probe;
  }

  /** Reads whether Git trusts the repository's ownership. Never writes. */
  async getRepositoryTrust(workspace: GitWorkspaceScope): Promise<GitTrustReport> {
    try {
      const report: GitTrustReport = await api.invoke('git_get_repository_trust', {
        request: { ...await gitWorkspaceRequest(workspace) },
      });
      // Trust can be granted outside this product — the user runs the manual
      // command in a terminal, or the repository's owner fixes it. Whoever
      // learns that first has to drop the `false` the probe cached while the
      // repository was still refused, or the caller replays against it.
      if (report.state === 'trusted') {
        this.dropRepositoryProbe(workspace);
      }
      return report;
    } catch (error) {
      throw createTauriCommandError('git_get_repository_trust', error, { workspace });
    }
  }

  private dropRepositoryProbe(workspace: GitWorkspaceScope): void {
    this.repositoryProbeCache.delete(gitWorkspaceKey(workspace));
  }

  /**
   * Grants ownership trust for a repository. Call this only after the user
   * confirmed it: it writes a `safe.directory` exception to their global Git
   * configuration.
   *
   * Consent is enforced by the frontend only: this method is reached solely
   * from the interactive confirmation flow, and the backend carries no
   * separate consent token. That single-location guard matches the project's
   * existing convention for write-gated operations, so no backend mechanism
   * is introduced here.
   */
  async trustRepository(workspace: GitWorkspaceScope): Promise<GitTrustOutcome> {
    try {
      const outcome = await api.invoke<GitTrustOutcome>('git_trust_repository', {
        request: { ...await gitWorkspaceRequest(workspace) },
      });
      // The probe cache may hold the `false` this repository returned while it
      // was still refused; a granted decision must not wait it out.
      if (outcome.state === 'trusted') {
        this.dropRepositoryProbe(workspace);
      }
      return outcome;
    } catch (error) {
      throw createTauriCommandError('git_trust_repository', error, { workspace });
    }
  }


  async getRepository(workspace: GitWorkspaceScope): Promise<GitRepository> {
    try {
      return await api.invoke('git_get_repository', { 
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_repository', error, { workspace });
    }
  }


  async getRepositoryBasic(workspace: GitWorkspaceScope): Promise<GitRepository> {
    try {
      return await api.invoke('git_get_repository_basic', {
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_repository_basic', error, { workspace });
    }
  }

  async resolveRevision(workspace: GitWorkspaceScope, revision: string): Promise<string> {
    try {
      return await api.invoke('git_resolve_revision', {
        request: { ...await gitWorkspaceRequest(workspace), revision },
      });
    } catch (error) {
      throw createTauriCommandError('git_resolve_revision', error, {
        workspace,
        revision,
      });
    }
  }

   
  async getStatus(workspace: GitWorkspaceScope, traceSource = 'unknown'): Promise<GitStatus> {
    try {
      if (globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ === true) {
        startupTrace.markPhase('git_status_request', { source: traceSource });
      }
      return await api.invoke('git_get_status', { 
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_status', error, { workspace });
    }
  }

   
  async getBranches(workspace: GitWorkspaceScope, includeRemote: boolean = false): Promise<GitBranch[]> {
    try {
      return await api.invoke('git_get_branches', { 
        request: { ...await gitWorkspaceRequest(workspace), includeRemote }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_branches', error, { workspace, includeRemote });
    }
  }

   
  async getEnhancedBranches(workspace: GitWorkspaceScope, includeRemote: boolean = false): Promise<GitBranch[]> {
    try {
      return await api.invoke('git_get_enhanced_branches', { 
        request: { ...await gitWorkspaceRequest(workspace), includeRemote }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_enhanced_branches', error, { workspace, includeRemote });
    }
  }

   
  async getCommits(workspace: GitWorkspaceScope, params: GitLogParams = {}): Promise<GitCommit[]> {
    try {
      return await api.invoke('git_get_commits', { 
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_commits', error, { workspace, params });
    }
  }

   
  async addFiles(workspace: GitWorkspaceScope, params: GitAddParams): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_add_files', { 
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_add_files', error, { workspace, params });
    }
  }

   
  async commit(workspace: GitWorkspaceScope, params: GitCommitParams): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_commit', { 
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_commit', error, { workspace, params });
    }
  }

   
  async push(workspace: GitWorkspaceScope, params: GitPushParams = {}): Promise<GitOperationResult> {
    try {
      
      const backendParams = {
        remote: params.remote,
        branch: params.branch,
        force: params.force,
        set_upstream: params.setUpstream
      };
      
      return await api.invoke('git_push', { 
        request: { ...await gitWorkspaceRequest(workspace), params: backendParams }
      });
    } catch (error) {
      throw createTauriCommandError('git_push', error, { workspace, params });
    }
  }

   
  async pull(workspace: GitWorkspaceScope, params: GitPullParams = {}): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_pull', { 
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_pull', error, { workspace, params });
    }
  }

   
  async checkoutBranch(workspace: GitWorkspaceScope, branchName: string): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_checkout_branch', { 
        request: { ...await gitWorkspaceRequest(workspace), branchName }
      });
    } catch (error) {
      throw createTauriCommandError('git_checkout_branch', error, { workspace, branchName });
    }
  }

   
  async createBranch(workspace: GitWorkspaceScope, branchName: string, startPoint?: string): Promise<GitOperationResult> {
    try {
      
      const effectiveStartPoint = startPoint && startPoint.trim() ? startPoint : undefined;
      return await api.invoke('git_create_branch', { 
        request: { ...await gitWorkspaceRequest(workspace), branchName, startPoint: effectiveStartPoint }
      });
    } catch (error) {
      throw createTauriCommandError('git_create_branch', error, { workspace, branchName, startPoint });
    }
  }

   
  async deleteBranch(workspace: GitWorkspaceScope, branchName: string, force: boolean = false): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_delete_branch', { 
        request: { ...await gitWorkspaceRequest(workspace), branchName, force }
      });
    } catch (error) {
      throw createTauriCommandError('git_delete_branch', error, { workspace, branchName, force });
    }
  }

   
  async resetToCommit(workspace: GitWorkspaceScope, commitHash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_reset_to_commit', { 
        request: { ...await gitWorkspaceRequest(workspace), commitHash, mode }
      });
    } catch (error) {
      throw createTauriCommandError('git_reset_to_commit', error, { workspace, commitHash, mode });
    }
  }

   
  async getDiff(workspace: GitWorkspaceScope, params: GitDiffParams): Promise<string> {
    try {
      return await api.invoke('git_get_diff', { 
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_diff', error, { workspace, params });
    }
  }

   
  async getChangedFiles(workspace: GitWorkspaceScope, params: GitChangedFilesParams): Promise<GitChangedFile[]> {
    try {
      return await api.invoke('git_get_changed_files', {
        request: { ...await gitWorkspaceRequest(workspace), params }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_changed_files', error, { workspace, params });
    }
  }


  async resetFiles(workspace: GitWorkspaceScope, files: string[], staged: boolean = false): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_reset_files', { 
        request: { ...await gitWorkspaceRequest(workspace), files, staged }
      });
    } catch (error) {
      throw createTauriCommandError('git_reset_files', error, { workspace, files, staged });
    }
  }

   
  async getFileContent(workspace: GitWorkspaceScope, filePath: string, commit?: string): Promise<string> {
    try {
      return await api.invoke('git_get_file_content', { 
        request: { ...await gitWorkspaceRequest(workspace), filePath, commit }
      });
    } catch (error) {
      throw createTauriCommandError('git_get_file_content', error, { workspace, filePath, commit });
    }
  }
   
  async getGraph(workspace: GitWorkspaceScope, maxCount?: number, branchName?: string): Promise<GitGraph> {
    try {
      const result = await api.invoke<GitGraph>('git_get_graph', { 
        ...await gitWorkspaceRequest(workspace),
        maxCount: maxCount || null,
        branchName: branchName || null
      });
      return result;
    } catch (error) {
      log.error('Failed to get git graph', { workspace, maxCount, branchName, error });
      throw createTauriCommandError('git_get_graph', error, { workspace, maxCount, branchName });
    }
  }

   
  async cherryPick(workspace: GitWorkspaceScope, commitHash: string, noCommit: boolean = false): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_cherry_pick', { 
        request: { ...await gitWorkspaceRequest(workspace), commitHash, noCommit }
      });
    } catch (error) {
      throw createTauriCommandError('git_cherry_pick', error, { workspace, commitHash, noCommit });
    }
  }

   
  async cherryPickAbort(workspace: GitWorkspaceScope): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_cherry_pick_abort', { 
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_cherry_pick_abort', error, { workspace });
    }
  }

   
  async cherryPickContinue(workspace: GitWorkspaceScope): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_cherry_pick_continue', { 
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_cherry_pick_continue', error, { workspace });
    }
  }

  

   
  async listWorktrees(workspace: GitWorkspaceScope): Promise<GitWorktreeInfo[]> {
    try {
      return await api.invoke('git_list_worktrees', { 
        request: { ...await gitWorkspaceRequest(workspace) }
      });
    } catch (error) {
      throw createTauriCommandError('git_list_worktrees', error, { workspace });
    }
  }

   
  async addWorktree(workspace: GitWorkspaceScope, branch: string, createBranch: boolean = false): Promise<GitWorktreeInfo> {
    try {
      return await api.invoke('git_add_worktree', { 
        request: { ...await gitWorkspaceRequest(workspace), branch, createBranch }
      });
    } catch (error) {
      throw createTauriCommandError('git_add_worktree', error, { workspace, branch, createBranch });
    }
  }

   
  async removeWorktree(workspace: GitWorkspaceScope, worktreePath: string, force: boolean = false): Promise<GitOperationResult> {
    try {
      return await api.invoke('git_remove_worktree', { 
        request: { ...await gitWorkspaceRequest(workspace), worktreePath, force }
      });
    } catch (error) {
      throw createTauriCommandError('git_remove_worktree', error, { workspace, worktreePath, force });
    }
  }
}


export const gitAPI = new GitAPI();
