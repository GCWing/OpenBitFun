import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
import { useState, useCallback, useRef } from 'react';
import { 
  GitOperationResult,
  GitAddParams,
  GitCommitParams,
  GitPushParams,
  GitPullParams,
  GitOperationType
} from '../types';
import { gitService, gitEventService } from '../services';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';
import { useStableGitWorkspaceScope } from './useStableGitWorkspaceScope';

const log = createLogger('useGitOperations');

interface UseGitOperationsOptions {
  repositoryPath: GitWorkspaceScope;
  autoRefresh?: boolean;
}

interface UseGitOperationsReturn {
  isOperating: boolean;
  currentOperation: GitOperationType | null;
  error: string | null;
  addFiles: (params: GitAddParams) => Promise<GitOperationResult>;
  commit: (params: GitCommitParams) => Promise<GitOperationResult>;
  push: (params?: GitPushParams) => Promise<GitOperationResult>;
  pull: (params?: GitPullParams) => Promise<GitOperationResult>;
  checkoutBranch: (branchName: string) => Promise<GitOperationResult>;
  createBranch: (branchName: string, startPoint?: string) => Promise<GitOperationResult>;
  deleteBranch: (branchName: string, force?: boolean) => Promise<GitOperationResult>;
  resetFiles: (files: string[], staged?: boolean) => Promise<GitOperationResult>;
  clearError: () => void;
}

export function useGitOperations(options: UseGitOperationsOptions): UseGitOperationsReturn {
  const repositoryPath = useStableGitWorkspaceScope(options.repositoryPath);
  const [isOperating, setIsOperating] = useState(false);
  const [currentOperation, setCurrentOperation] = useState<GitOperationType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n('panels/git');

  const operationIdRef = useRef(0);

  const executeOperation = useCallback(async <T extends GitOperationResult>(
    operationType: GitOperationType,
    operationFn: () => Promise<T>,
    description: string,
    errorLabel: string
  ): Promise<T> => {
    const operationId = ++operationIdRef.current;
    
    setIsOperating(true);
    setCurrentOperation(operationType);
    setError(null);

    gitEventService.emit('operation:started', {
      repositoryPath,
      operationType,
      description,
      timestamp: new Date()
    });

    try {
      const result = await operationFn();

      gitEventService.emit('operation:completed', {
        repositoryPath,
        operationType,
        description,
        result,
        timestamp: new Date()
      });

      if (!result.success && result.error) {
        setError(result.error);
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : `${errorLabel} failed`;
      setError(errorMessage);

      gitEventService.emit('operation:failed', {
        repositoryPath,
        operationType,
        description,
        result: {
          success: false,
          error: errorMessage
        },
        timestamp: new Date()
      });

      return {
        success: false,
        error: errorMessage
      } as T;
    } finally {
      if (operationIdRef.current === operationId) {
        setIsOperating(false);
        setCurrentOperation(null);
      }
    }
  }, [repositoryPath]);

  const addFiles = useCallback(async (params: GitAddParams): Promise<GitOperationResult> => {
    return executeOperation(
      'add',
      () => gitService.addFiles(repositoryPath, params),
      t('operations.addFilesTitle'),
      'Add files'
    );
  }, [repositoryPath, executeOperation, t]);

  const commit = useCallback(async (params: GitCommitParams): Promise<GitOperationResult> => {
    return executeOperation(
      'commit',
      () => gitService.commit(repositoryPath, params),
      t('operations.commitChangesTitle'),
      'Commit changes'
    );
  }, [repositoryPath, executeOperation, t]);

  /**
   * Push to remote
   */
  const push = useCallback(async (params: GitPushParams = {}): Promise<GitOperationResult> => {
    const progressTitle = params.force ? t('operations.pushTitleForce') : t('operations.pushTitle');
    const operationDescription = params.force ? 'Push changes (force)' : 'Push changes';
    

    const progress = notificationService.progress({
      title: progressTitle,
      message: t('operations.pushProgress'),
      cancellable: false
    });

    try {

      const pushParams = { ...params };
      

      if (!pushParams.remote || !pushParams.branch) {
        try {
          const status = await gitService.getStatus(repositoryPath);
          

          if (status && !pushParams.branch && status.current_branch) {
            pushParams.branch = status.current_branch;
          }
          

          if (!pushParams.remote) {
            pushParams.remote = 'origin';
          }
          

          if (status && status.ahead > 0 && status.behind === 0 && pushParams.setUpstream === undefined) {
            pushParams.setUpstream = true;
          }
        } catch (statusError) {
          log.warn('Failed to get status, using default params', { repositoryPath, error: statusError });
        }
      }
      
      const result = await executeOperation(
        'push',
        () => gitService.push(repositoryPath, pushParams),
        progressTitle,
        operationDescription
      );
      
      if (!result.success && result.error && result.error.includes('no upstream branch')) {
        log.debug('No upstream branch detected, retrying with upstream setup', { repositoryPath });
        pushParams.setUpstream = true;
        
        const retryResult = await executeOperation(
          'push',
          () => gitService.push(repositoryPath, pushParams),
          progressTitle,
          operationDescription
        );
        
        if (retryResult.success) {
          progress.complete(t('notifications.pushUpstreamSuccess'));
        } else {
          progress.fail(retryResult.error || t('errors.pushFailed'));
          notificationService.error(
            retryResult.error || t('errors.pushFailedWithCheck'),
            { duration: 5000 }
          );
        }
        
        return retryResult;
      }
      
      if (result.success) {

        progress.complete(params.force ? t('notifications.pushForceSuccess') : t('notifications.pushSuccess'));
      } else {

        progress.fail(result.error || t('errors.pushFailed'));
        notificationService.error(
          result.error || t('errors.pushFailedWithCheck'),
          { duration: 5000 }
        );
      }
      
      return result;
    } catch (error) {

      const errorMessage = error instanceof Error ? error.message : t('errors.pushFailed');
      progress.fail(errorMessage);
      notificationService.error(errorMessage, { duration: 5000 });
      return {
        success: false,
        error: errorMessage
      };
    }
  }, [repositoryPath, executeOperation, t]);

  /**
   * Pull from remote.
   */
  const pull = useCallback(async (params: GitPullParams = {}): Promise<GitOperationResult> => {
    const progressTitle = t('operations.pullTitle');
    const operationDescription = 'Pull changes';
    

    const progress = notificationService.progress({
      title: progressTitle,
      message: t('operations.pullProgress'),
      cancellable: false
    });

    try {
      const result = await executeOperation(
        'pull',
        () => gitService.pull(repositoryPath, params),
        progressTitle,
        operationDescription
      );
      
      if (result.success) {

        progress.complete(t('notifications.pullSuccess'));
      } else {

        progress.fail(result.error || t('errors.pullFailed'));
        notificationService.error(
          result.error || t('errors.pullFailedWithCheck'),
          { duration: 5000 }
        );
      }
      
      return result;
    } catch (error) {

      const errorMessage = error instanceof Error ? error.message : t('errors.pullFailed');
      progress.fail(errorMessage);
      notificationService.error(errorMessage, { duration: 5000 });
      return {
        success: false,
        error: errorMessage
      };
    }
  }, [repositoryPath, executeOperation, t]);

  /**
   * Checkout a branch.
   */
  const checkoutBranch = useCallback(async (branchName: string): Promise<GitOperationResult> => {
    const progressTitle = t('operations.checkoutTitle', { branch: branchName });
    const operationDescription = `Switch to branch ${branchName}`;
    const result = await executeOperation(
      'checkout',
      () => gitService.checkoutBranch(repositoryPath, branchName),
      progressTitle,
      operationDescription
    );
    
    if (result.success) {
      notificationService.success(t('notifications.checkoutSuccess', { branch: branchName }), { duration: 3000 });
      

      gitEventService.emit('branch:changed', {
        repositoryPath,
        branch: {
          name: branchName,
          current: true,
          remote: false,
          ahead: 0,
          behind: 0,
        },
        timestamp: new Date(),
      });
    } else if (result.error) {

      let errorMessage = result.error;
      if (result.error.includes('local changes')) {
        errorMessage = t('errors.checkoutLocalChanges');
      } else if (result.error.includes('resolve your current index first')) {
        errorMessage = t('errors.checkoutIndexConflict');
      } else if (result.error.includes('did not match')) {
        errorMessage = t('errors.branchNotFound', { branch: branchName });
      }
      notificationService.error(errorMessage, { 
        title: t('errors.checkoutFailedTitle'),
        duration: 5000 
      });
    }
    
    return result;
  }, [repositoryPath, executeOperation, t]);

  /**
   * Create a branch.
   */
  const createBranch = useCallback(async (branchName: string, startPoint?: string): Promise<GitOperationResult> => {
    const progressTitle = t('operations.createBranchTitle', { branch: branchName });
    const operationDescription = `Create branch ${branchName}`;
    const result = await executeOperation(
      'branch',
      () => gitService.createBranch(repositoryPath, branchName, startPoint),
      progressTitle,
      operationDescription
    );
    
    if (result.success) {
      notificationService.success(t('notifications.createBranchSuccess', { branch: branchName }), { duration: 3000 });
    } else if (result.error) {

      let errorMessage = result.error;
      if (result.error.includes('resolve your current index first')) {
        errorMessage = t('errors.checkoutIndexConflict');
      } else if (result.error.includes('already exists')) {
        errorMessage = t('errors.branchAlreadyExists', { branch: branchName });
      }
      notificationService.error(errorMessage, { 
        title: t('errors.createBranchFailedTitle'),
        duration: 5000 
      });
    }
    
    return result;
  }, [repositoryPath, executeOperation, t]);

  /**
   * Delete a branch.
   */
  const deleteBranch = useCallback(async (branchName: string, force: boolean = false): Promise<GitOperationResult> => {
    const progressTitle = t('operations.deleteBranchTitle', { branch: branchName });
    const operationDescription = `Delete branch ${branchName}`;
    const result = await executeOperation(
      'branch',
      () => gitService.deleteBranch(repositoryPath, branchName, force),
      progressTitle,
      operationDescription
    );
    
    if (result.success) {
      notificationService.success(t('notifications.deleteBranchSuccess', { branch: branchName }), { duration: 3000 });
    } else if (result.error) {

      let errorMessage = result.error;
      if (result.error.includes('not fully merged')) {
        errorMessage = t('errors.branchNotMerged', { branch: branchName });
      } else if (result.error.includes('checked out')) {
        errorMessage = t('errors.cannotDeleteCurrentBranch', { branch: branchName });
      }
      notificationService.error(errorMessage, { 
        title: t('errors.deleteBranchFailedTitle'),
        duration: 5000 
      });
    }
    
    return result;
  }, [repositoryPath, executeOperation, t]);

  /**
   * Reset files.
   */
  const resetFiles = useCallback(async (files: string[], staged: boolean = false): Promise<GitOperationResult> => {
    return executeOperation(
      'reset',
      () => gitService.resetFiles(repositoryPath, files, staged),
      t('operations.resetFilesTitle'),
      'Reset files'
    );
  }, [repositoryPath, executeOperation, t]);

  /**
   * Clear the last error.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isOperating,
    currentOperation,
    error,
    addFiles,
    commit,
    push,
    pull,
    checkoutBranch,
    createBranch,
    deleteBranch,
    resetFiles,
    clearError
  };
}
