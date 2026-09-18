import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git event types
 */

import { GitRepository, GitStatus, GitFileChange, GitCommit, GitBranch } from './repository';
import { GitOperationType, GitOperationResult } from './operations';

export type GitEventType = 
  | 'repository:opened'
  | 'repository:closed'
  | 'repository:changed'
  | 'status:changed'
  | 'files:changed'
  | 'branch:changed'
  | 'branch:created'
  | 'branch:deleted'
  | 'commit:created'
  | 'operation:started'
  | 'operation:completed'
  | 'operation:failed'
  | 'conflict:detected'
  | 'conflict:resolved'
  | 'merge:started'
  | 'merge:completed'
  | 'push:started'
  | 'push:completed'
  | 'pull:started'
  | 'pull:completed'
  | 'state:refreshing'
  | 'state:refreshed'
  | 'state:error';

export interface GitEventData {
  repositoryPath: GitWorkspaceScope;
  timestamp: Date;
  source?: string;
}

export interface GitRepositoryEventData extends GitEventData {
  repository: GitRepository;
}

export interface GitStatusChangedEventData extends GitEventData {
  status: GitStatus;
  changedFiles?: GitFileChange[];
}

export interface GitFilesChangedEventData extends GitEventData {
  files: GitFileChange[];
  changeType: 'added' | 'modified' | 'deleted' | 'staged' | 'unstaged';
}

export interface GitBranchEventData extends GitEventData {
  branch: GitBranch;
  previousBranch?: string;
}

export interface GitCommitEventData extends GitEventData {
  commit: GitCommit;
  files: GitFileChange[];
}

export interface GitOperationEventData extends GitEventData {
  operationType: GitOperationType;
  description: string;
  result?: GitOperationResult;
  progress?: number;
}

export interface GitConflictEventData extends GitEventData {
  conflictedFiles: string[];
  conflictType: 'merge' | 'rebase' | 'cherry-pick';
  conflicts: Array<{
    file: string;
    sections: Array<{
      start: number;
      end: number;
      ours: string;
      theirs: string;
    }>;
  }>;
}

export interface GitMergeEventData extends GitEventData {
  sourceBranch: string;
  targetBranch: string;
  result?: {
    success: boolean;
    conflicts?: string[];
    mergeCommit?: string;
  };
}

export interface GitSyncEventData extends GitEventData {
  remote: string;
  branch: string;
  syncType: 'push' | 'pull' | 'fetch';
  result?: {
    success: boolean;
    transferred?: number;
    total?: number;
    message?: string;
  };
}

export interface GitStateRefreshEventData extends GitEventData {
  layers: ('basic' | 'status' | 'detailed')[];
  reason: 'mount' | 'visibility' | 'manual' | 'operation' | 'file-change' | 'window-focus' | 'interval';
}

export interface GitStateRefreshedEventData extends GitStateRefreshEventData {
  summary: {
    isRepository: boolean;
    currentBranch: string | null;
    hasChanges: boolean;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
  };
}

export interface GitStateErrorEventData extends GitEventData {
  error: string;
  operation: string;
}

export type GitEvent = 
  | { type: 'repository:opened'; data: GitRepositoryEventData }
  | { type: 'repository:closed'; data: GitEventData }
  | { type: 'repository:changed'; data: GitRepositoryEventData }
  | { type: 'status:changed'; data: GitStatusChangedEventData }
  | { type: 'files:changed'; data: GitFilesChangedEventData }
  | { type: 'branch:changed'; data: GitBranchEventData }
  | { type: 'branch:created'; data: GitBranchEventData }
  | { type: 'branch:deleted'; data: GitBranchEventData }
  | { type: 'commit:created'; data: GitCommitEventData }
  | { type: 'operation:started'; data: GitOperationEventData }
  | { type: 'operation:completed'; data: GitOperationEventData }
  | { type: 'operation:failed'; data: GitOperationEventData }
  | { type: 'conflict:detected'; data: GitConflictEventData }
  | { type: 'conflict:resolved'; data: GitConflictEventData }
  | { type: 'merge:started'; data: GitMergeEventData }
  | { type: 'merge:completed'; data: GitMergeEventData }
  | { type: 'push:started'; data: GitSyncEventData }
  | { type: 'push:completed'; data: GitSyncEventData }
  | { type: 'pull:started'; data: GitSyncEventData }
  | { type: 'pull:completed'; data: GitSyncEventData }
  | { type: 'state:refreshing'; data: GitStateRefreshEventData }
  | { type: 'state:refreshed'; data: GitStateRefreshedEventData }
  | { type: 'state:error'; data: GitStateErrorEventData };

export type GitEventListener<T extends GitEventType = GitEventType> = (
  event: Extract<GitEvent, { type: T }>
) => void | Promise<void>;

export interface IGitEventEmitter {
  on<T extends GitEventType>(eventType: T, listener: GitEventListener<T>): () => void;
  once<T extends GitEventType>(eventType: T, listener: GitEventListener<T>): () => void;
  off<T extends GitEventType>(eventType: T, listener: GitEventListener<T>): void;
  emit<T extends GitEventType>(eventType: T, data: Extract<GitEvent, { type: T }>['data']): void;
  removeAllListeners(eventType?: GitEventType): void;
}

export interface GitEventSubscriptionOptions {
  once?: boolean;
  filter?: (data: any) => boolean;
  repositoryPath?: GitWorkspaceScope;
}