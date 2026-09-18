import { GitWorkspaceScope, gitWorkspaceKey } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git service layer - interacts with backend Tauri commands
 */

import { gitAPI } from '@/infrastructure/api';
import { isGitRepositoryUntrustedError } from '@/infrastructure/api/errors/TauriCommandError';
import { createLogger } from '@/shared/utils/logger';
import { measureAsync } from '@/shared/utils/timing';
import { i18nService } from '@/infrastructure/i18n';
import { describeGitTrustFailure } from '@/shared/services/gitTrustService';
import { gitStateManager } from '../state/GitStateManager';

export { describeGitTrustFailure } from '@/shared/services/gitTrustService';

const log = createLogger('GitService');
export type { 
  GitRepository, 
  GitStatus, 
  GitCommit, 
  GitBranch, 
  GitOperationResult,
  GitAddParams,
  GitCommitParams,
  GitPushParams,
  GitPullParams,
  GitDiffParams,
  GitLogParams,
  GitGraph,
  GitGraphNode,
  GitGraphRef
} from '@/infrastructure/api/service-api/GitAPI';

import { 
  GitRepository, 
  GitStatus, 
  GitCommit, 
  GitBranch, 
  GitOperationResult,
  GitAddParams,
  GitCommitParams,
  GitPushParams,
  GitPullParams,
  GitDiffParams,
  GitLogParams
} from '../types';

export class GitService {
  private static instance: GitService;
  
  private nonGitRepositoryCache: Set<string> = new Set();
  private readonly CACHE_EXPIRE_TIME = 5 * 60 * 1000;
  private cacheTimestamps: Map<string, number> = new Map();

  private constructor() {}

  public static getInstance(): GitService {
    if (!GitService.instance) {
      GitService.instance = new GitService();
    }
    return GitService.instance;
  }

  private clearExpiredCache(): void {
    const now = Date.now();
    const expiredPaths: string[] = [];
    
    this.cacheTimestamps.forEach((timestamp, path) => {
      if (now - timestamp > this.CACHE_EXPIRE_TIME) {
        expiredPaths.push(path);
      }
    });
    
    expiredPaths.forEach(path => {
      this.nonGitRepositoryCache.delete(path);
      this.cacheTimestamps.delete(path);
    });
  }

  private async ensureFreshOperationState(repositoryPath: GitWorkspaceScope): Promise<void> {
    await gitStateManager.refresh(repositoryPath, {
      force: true,
      layers: ['basic', 'status'],
      reason: 'operation',
      silent: true,
    });
  }

  private isInNonGitCache(path: GitWorkspaceScope): boolean {
    this.clearExpiredCache();
    return this.nonGitRepositoryCache.has(gitWorkspaceKey(path));
  }

  private addToNonGitCache(path: GitWorkspaceScope): void {
    this.nonGitRepositoryCache.add(gitWorkspaceKey(path));
    this.cacheTimestamps.set(gitWorkspaceKey(path), Date.now());
  }

  /**
   * Records a failed read as "not a repository" — unless Git refused it on
   * ownership grounds.
   *
   * That refusal says the repository is there, and the negative cache is
   * consulted before the call is even attempted: caching it would keep
   * returning `null` for minutes, outliving a trust decision the user just
   * made and hiding the error the recovery flow needs to see.
   */
  private cacheFailureAsNonGit(path: GitWorkspaceScope, error: unknown): void {
    if (isGitRepositoryUntrustedError(error)) {
      return;
    }
    this.addToNonGitCache(path);
  }

  /** Turns whatever a mutation failed with into something the user can act on. */
  private describeOperationFailure(failure: unknown, fallbackKey: string): string {
    const trustFailure = describeGitTrustFailure(failure);
    if (trustFailure) {
      return trustFailure;
    }
    if (typeof failure === 'string' && failure.trim().length > 0) {
      return failure;
    }
    return failure instanceof Error ? failure.message : i18nService.t(fallbackKey);
  }

  /** Same translation for a failure the backend returned rather than threw. */
  private explainOperationResult(
    result: GitOperationResult,
    fallbackKey: string
  ): GitOperationResult {
    if (result.success || !isGitRepositoryUntrustedError(result.error)) {
      return result;
    }
    return { ...result, error: this.describeOperationFailure(result.error, fallbackKey) };
  }

  private removeFromNonGitCache(path: GitWorkspaceScope): void {
    this.nonGitRepositoryCache.delete(gitWorkspaceKey(path));
    this.cacheTimestamps.delete(gitWorkspaceKey(path));
  }

  private adaptRepository(apiRepo: import('@/infrastructure/api/service-api/GitAPI').GitRepository): GitRepository {
    const status: GitStatus = {
      current_branch: apiRepo.branch || 'main',
      staged: [],
      unstaged: [],
      untracked: [],
      ahead: 0,
      behind: 0
    };

    return {
      rootPath: apiRepo.path,
      name: apiRepo.name,
      status: status,
      branches: [],
      remotes: [],
      recentCommits: [],
      isRepository: true
    };
  }

  private adaptStatus(apiStatus: import('@/infrastructure/api/service-api/GitAPI').GitStatus): GitStatus {
    return {
      current_branch: apiStatus.current_branch || 'main',
      staged: apiStatus.staged || [],
      unstaged: apiStatus.unstaged || [],
      untracked: apiStatus.untracked || [],
      ahead: apiStatus.ahead || 0,
      behind: apiStatus.behind || 0
    };
  }

  private adaptBranches(apiBranches: import('@/infrastructure/api/service-api/GitAPI').GitBranch[]): GitBranch[] {
    return apiBranches.map(branch => ({
      name: branch.name,
      current: branch.current,
      remote: branch.remote,
      lastCommit: branch.lastCommit,
      ahead: branch.ahead || 0,
      behind: branch.behind || 0,
      hasChanges: false,
      isProtected: false,
      upstreamBranch: branch.remote ? `origin/${branch.name}` : undefined
    }));
  }

  private adaptCommits(apiCommits: import('@/infrastructure/api/service-api/GitAPI').GitCommit[]): GitCommit[] {
    return apiCommits.map(commit => {
      const adaptedFiles = (commit.files || []).map(filePath => ({
        path: filePath,
        status: 'modified' as const,
        staged: false
      }));

      return {
        hash: commit.hash,
        shortHash: commit.hash.substring(0, 7),
        message: commit.message,
        author: commit.author,
        authorEmail: '',
        date: new Date(commit.date),
        parents: [],
        files: adaptedFiles
      };
    });
  }

  async isGitRepository(path: GitWorkspaceScope): Promise<boolean> {
    try {
      if (this.isInNonGitCache(path)) {
        return false;
      }

      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Check repository timeout')), 5000)
      );
      
      const result = await Promise.race([
        gitAPI.isGitRepository(path),
        timeoutPromise
      ]);
      
      if (!result) {
        this.addToNonGitCache(path);
      } else {
        this.removeFromNonGitCache(path);
      }
      
      return result;
    } catch (error) {
      log.error('Failed to check git repository', error);
      this.cacheFailureAsNonGit(path, error);
      return false;
    }
  }

  async getRepository(path: GitWorkspaceScope): Promise<GitRepository | null> {
    try {
      if (this.isInNonGitCache(path)) {
        return null;
      }

      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Get repository timeout')), 8000)
      );
      
      const result = await measureAsync(() => Promise.race([
        gitAPI.getRepository(path),
        timeoutPromise
      ]));
      
      log.debug('Repository info retrieved', { path, durationMs: result.durationMs });
      
      this.removeFromNonGitCache(path);
      
      return this.adaptRepository(result.value);
    } catch (error) {
      log.error('Failed to get repository info', error);
      this.cacheFailureAsNonGit(path, error);
      return null;
    }
  }

  async getStatus(repositoryPath: GitWorkspaceScope): Promise<GitStatus | null> {
    try {
      if (this.isInNonGitCache(repositoryPath)) {
        return null;
      }

      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Get git status timeout')), 6000)
      );
      
      const result = await Promise.race([
        gitAPI.getStatus(repositoryPath, 'git_service'),
        timeoutPromise
      ]);
      
      this.removeFromNonGitCache(repositoryPath);
      
      return this.adaptStatus(result);
    } catch (error) {
      log.error('Failed to get git status', error);
      this.cacheFailureAsNonGit(repositoryPath, error);
      return null;
    }
  }

  async getBranches(repositoryPath: GitWorkspaceScope, includeRemote: boolean = false): Promise<GitBranch[]> {
    try {
      const result = await gitAPI.getBranches(repositoryPath, includeRemote);
      return this.adaptBranches(result);
    } catch (error) {
      log.error('Failed to get branches', error);
      return [];
    }
  }

  async getCommits(repositoryPath: GitWorkspaceScope, params: GitLogParams = {}): Promise<GitCommit[]> {
    try {
      const result = await gitAPI.getCommits(repositoryPath, params);
      return this.adaptCommits(result);
    } catch (error) {
      log.error('Failed to get commits', error);
      return [];
    }
  }

  /**
   * Stage files.
   */
  async addFiles(repositoryPath: GitWorkspaceScope, params: GitAddParams): Promise<GitOperationResult> {
    try {
      const result = await gitAPI.addFiles(repositoryPath, params);
      return this.explainOperationResult(result, 'panels/git:errors.addFailed');
    } catch (error) {
      log.error('Failed to add files', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.addFailed')
      };
    }
  }

  /**
   * Commit changes.
   */
  async commit(repositoryPath: GitWorkspaceScope, params: GitCommitParams): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.commit(repositoryPath, params);
      return this.explainOperationResult(result, 'panels/git:errors.commitFailed');
    } catch (error) {
      log.error('Failed to commit', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.commitFailed')
      };
    }
  }

  /**
   * Push to remote.
   */
  async push(repositoryPath: GitWorkspaceScope, params: GitPushParams = {}): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.push(repositoryPath, params);
      return this.explainOperationResult(result, 'panels/git:errors.pushFailed');
    } catch (error) {
      log.error('Failed to push', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.pushFailed')
      };
    }
  }

  /**
   * Pull from remote.
   */
  async pull(repositoryPath: GitWorkspaceScope, params: GitPullParams = {}): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.pull(repositoryPath, params);
      return this.explainOperationResult(result, 'panels/git:errors.pullFailed');
    } catch (error) {
      log.error('Failed to pull', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.pullFailed')
      };
    }
  }

  /**
   * Checkout a branch.
   */
  async checkoutBranch(repositoryPath: GitWorkspaceScope, branchName: string): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.checkoutBranch(repositoryPath, branchName);
      return this.explainOperationResult(result, 'panels/git:errors.checkoutFailed');
    } catch (error) {
      log.error('Failed to checkout branch', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.checkoutFailed')
      };
    }
  }

  /**
   * Create a branch.
   */
  async createBranch(repositoryPath: GitWorkspaceScope, branchName: string, startPoint?: string): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.createBranch(repositoryPath, branchName, startPoint);
      return this.explainOperationResult(result, 'panels/git:errors.createBranchFailed');
    } catch (error) {
      log.error('Failed to create branch', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.createBranchFailed')
      };
    }
  }

  /**
   * Delete a branch.
   */
  async deleteBranch(repositoryPath: GitWorkspaceScope, branchName: string, force: boolean = false): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.deleteBranch(repositoryPath, branchName, force);
      return this.explainOperationResult(result, 'panels/git:errors.deleteBranchFailed');
    } catch (error) {
      log.error('Failed to delete branch', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.deleteBranchFailed')
      };
    }
  }

  /**
   * Get diff output.
   */
  async getDiff(repositoryPath: GitWorkspaceScope, params: GitDiffParams): Promise<string> {
    try {
      const result = await gitAPI.getDiff(repositoryPath, params);
      return result;
    } catch (error) {
      log.error('Failed to get diff', error);
      return '';
    }
  }

  /**
   * Reset changes for one or more files.
   */
  async resetFiles(repositoryPath: GitWorkspaceScope, files: string[], staged: boolean = false): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.resetFiles(repositoryPath, files, staged);
      return this.explainOperationResult(result, 'panels/git:errors.resetFilesFailed');
    } catch (error) {
      log.error('Failed to reset files', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.resetFilesFailed')
      };
    }
  }

  /**
   * Reset to a commit.
   */
  async resetToCommit(repositoryPath: GitWorkspaceScope, commitHash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.resetToCommit(repositoryPath, commitHash, mode);
      return this.explainOperationResult(result, 'panels/git:errors.resetCommitFailed');
    } catch (error) {
      log.error('Failed to reset to commit', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.resetCommitFailed')
      };
    }
  }

  /**
   * Get file content at a commit (defaults to current HEAD if provided by backend).
   */
  async getFileContent(repositoryPath: GitWorkspaceScope, filePath: string, commit?: string): Promise<string> {
    try {
      const result = await gitAPI.getFileContent(repositoryPath, filePath, commit);
      return result;
    } catch (error) {
      log.error('Failed to get file content', error);
      return '';
    }
  }

  /**
   * Get enhanced branch list (falls back to basic list on failure).
   */
  async getEnhancedBranches(repositoryPath: GitWorkspaceScope, includeRemote: boolean = false): Promise<GitBranch[]> {
    try {
      const result = await gitAPI.getEnhancedBranches(repositoryPath, includeRemote);
      return this.adaptBranches(result);
    } catch (error) {
      log.error('Failed to get enhanced branches', error);

      return this.getBranches(repositoryPath, includeRemote);
    }
  }

  /**
   * Cherry-pick a commit onto the current branch.
   */
  async cherryPick(repositoryPath: GitWorkspaceScope, commitHash: string, noCommit: boolean = false): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.cherryPick(repositoryPath, commitHash, noCommit);
      return this.explainOperationResult(result, 'panels/git:errors.cherryPickFailed');
    } catch (error) {
      log.error('Failed to cherry-pick', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.cherryPickFailed')
      };
    }
  }

  /**
   * Abort an in-progress cherry-pick.
   */
  async cherryPickAbort(repositoryPath: GitWorkspaceScope): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.cherryPickAbort(repositoryPath);
      return this.explainOperationResult(result, 'panels/git:errors.cherryPickAbortFailed');
    } catch (error) {
      log.error('Failed to abort cherry-pick', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.cherryPickAbortFailed')
      };
    }
  }

  /**
   * Continue an in-progress cherry-pick.
   */
  async cherryPickContinue(repositoryPath: GitWorkspaceScope): Promise<GitOperationResult> {
    try {
      await this.ensureFreshOperationState(repositoryPath);
      const result = await gitAPI.cherryPickContinue(repositoryPath);
      return this.explainOperationResult(result, 'panels/git:errors.cherryPickContinueFailed');
    } catch (error) {
      log.error('Failed to continue cherry-pick', error);
      return {
        success: false,
        error: this.describeOperationFailure(error, 'panels/git:errors.cherryPickContinueFailed')
      };
    }
  }

}


export const gitService = GitService.getInstance();
