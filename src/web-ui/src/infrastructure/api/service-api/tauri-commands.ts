 



export interface OpenWorkspaceRequest {
  path: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  workspaceType: string;
  workspaceKind: string;
  assistantId?: string | null;
  languages: string[];
  openedAt: string;
  lastAccessed: string;
  description?: string | null;
  tags: string[];
  statistics?: {
    totalFiles: number;
    totalLines: number;
    totalSize: number;
    filesByLanguage: Record<string, number>;
    filesByExtension: Record<string, number>;
    lastUpdated: string;
  } | null;
  identity?: {
    name?: string | null;
    creature?: string | null;
    vibe?: string | null;
    emoji?: string | null;
  } | null;
  relatedPaths?: Array<{
    path: string;
    description?: string | null;
  }>;
  connectionId?: string;
  connectionName?: string;
}

export interface FileOperationRequest {
  path: string;
}

export interface WriteFileRequest {
  path: string;
  content: string;
}



export interface GetConfigRequest {
  path?: string;
}

export interface SetConfigRequest {
  path: string;
  value: any;
}

export interface ResetConfigRequest {
  path?: string;
}

export interface ImportConfigRequest {
  configData: any;
}



export interface GetModelInfoRequest {
  modelId: string;
}

export interface TestConnectionRequest {
  config: any;
}

export interface SendMessageRequest {
  message: string;
  context?: any;
}

export interface GetToolInfoRequest {
  toolName: string;
}

export interface ExecuteToolRequest {
  toolName: string;
  parameters: any;
  workspaceId?: string;
}

export interface ValidateToolInputRequest {
  toolName: string;
  input: any;
  workspaceId?: string;
}



export interface AnalyzeProjectRequest {
  path: string;
  options?: any;
}

export interface SearchCodeRequest {
  query: string;
  options?: any;
}



export interface OpenExternalRequest {
  url: string;
}

export interface ShowInFolderRequest {
  path: string;
}

export interface SetClipboardRequest {
  text: string;
}



export interface ComputeDiffRequest {
  oldContent: string;
  newContent: string;
  options?: any;
}

export interface ApplyPatchRequest {
  content: string;
  patch: string;
}



export interface SearchFilesRequest {
  rootPath: string;
  pattern: string;
  searchContent?: boolean;
  searchId?: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
  includeDirectories?: boolean;
}

export interface SearchFilenamesRequest {
  rootPath: string;
  pattern: string;
  remoteConnectionId?: string;
  searchId?: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
  includeDirectories?: boolean;
}

export interface SearchFileContentsRequest {
  rootPath: string;
  pattern: string;
  searchId?: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
}

export interface CancelSearchRequest {
  searchId: string;
}

export interface SearchRepoIndexRequest {
  workspaceId: string;
}

export type SearchMatchType = 'fileName' | 'content';

export interface FileSearchResult {
  path: string;
  name: string;
  isDirectory: boolean;
  matchType: SearchMatchType;
  lineNumber?: number;
  matchedContent?: string;
  previewBefore?: string;
  previewInside?: string;
  previewAfter?: string;
}

export interface FileSearchResponse {
  results: FileSearchResult[];
  limit: number;
  truncated: boolean;
  searchMetadata?: SearchMetadata;
}

export interface FileSearchResultGroup {
  path: string;
  name: string;
  isDirectory: boolean;
  fileNameMatch?: FileSearchResult;
  contentMatches: FileSearchResult[];
}

export type FileSearchStreamKind = 'filenames' | 'content';

export interface FileSearchStreamStartResponse {
  searchId: string;
  limit: number;
}

export interface FileSearchProgressEvent {
  searchId: string;
  searchKind: FileSearchStreamKind;
  results: FileSearchResultGroup[];
}

export interface FileSearchCompleteEvent {
  searchId: string;
  searchKind: FileSearchStreamKind;
  limit: number;
  truncated: boolean;
  totalResults: number;
  searchMetadata?: SearchMetadata;
}

export interface FileSearchErrorEvent {
  searchId: string;
  searchKind: FileSearchStreamKind;
  error: string;
}

export type SearchBackendKind =
  | 'indexed'
  | 'indexed_workspace'
  | 'text_fallback'
  | 'scan_fallback';

export interface SearchMetadata {
  backend: SearchBackendKind | string;
  repoPhase: WorkspaceSearchRepoPhase | string;
  baseAdvanceInProgress: boolean;
  /**
   * True when the daemon still owed a worktree reconcile at query time, so these results describe the
   * worktree as of the last observation. Interactive search accepts that on purpose rather than
   * blocking the panel on a worktree walk.
   */
  workspaceProbePending: boolean;
  candidateDocs: number;
  matchedLines: number;
  matchedOccurrences: number;
}

export type WorkspaceSearchRepoPhase =
  | 'preparing'
  | 'needs_index'
  | 'building'
  | 'ready'
  | 'tracking_changes'
  | 'refreshing'
  | 'limited';

export type WorkspaceSearchTaskKind =
  | 'build'
  | 'rebuild'
  | 'advance'
  | 'compact'
  | 'refresh';

export type WorkspaceSearchTaskState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkspaceSearchTaskPhase =
  | 'discovering'
  | 'processing'
  | 'persisting'
  | 'finalizing'
  | 'refreshing';

export interface WorkspaceSearchDirtyFiles {
  modified: number;
  deleted: number;
  new: number;
}

export interface WorkspaceSearchRepoStatus {
  repoId: string;
  repoPath: string;
  storageRoot: string;
  baseSnapshotRoot: string;
  workspaceOverlayRoot: string;
  phase: WorkspaceSearchRepoPhase;
  snapshotKey?: string | null;
  baseHeadCommit?: string | null;
  workspaceHeadCommit?: string | null;
  /** True while the daemon is advancing the base snapshot toward a newer commit. */
  baseAdvanceInProgress: boolean;
  baseAdvanceTargetHead?: string | null;
  baseDeltaDepth: number;
  baseCompactionRecommended: boolean;
  lastProbeUnixSecs?: number | null;
  lastRebuildUnixSecs?: number | null;
  dirtyFiles: WorkspaceSearchDirtyFiles;
  activeTaskId?: string | null;
  probeHealthy: boolean;
  /**
   * True while the daemon still owes a worktree reconcile, which makes `dirtyFiles` and `phase` the
   * last observed state rather than the current one. Search results stay usable; they just describe
   * a worktree from a moment ago.
   */
  workspaceProbePending: boolean;
  lastError?: string | null;
  /**
   * Failure of the daemon's last background base-maintenance task. Survives the worktree probes
   * that clear `lastError`, so status polling can actually observe it.
   */
  lastMaintenanceError?: string | null;
  overlay?: WorkspaceSearchOverlayStatus | null;
}

export interface WorkspaceSearchOverlayStatus {
  baseManifestId?: string | null;
  committedSeqNo: number;
  lastSeqNo: number;
  uncommittedOps: number;
  pendingDocs: number;
  activeSegments: number;
  activeDeleteSegments: number;
  mergeRequested: boolean;
  mergeRunning: boolean;
  mergeAttempts: number;
  mergeCompleted: number;
  mergeFailed: number;
  lastMergeError?: string | null;
}

export interface WorkspaceSearchTaskStatus {
  taskId: string;
  workspaceId: string;
  kind: WorkspaceSearchTaskKind;
  state: WorkspaceSearchTaskState;
  phase?: WorkspaceSearchTaskPhase | null;
  message: string;
  processed: number;
  total?: number | null;
  startedUnixSecs: number;
  updatedUnixSecs: number;
  finishedUnixSecs?: number | null;
  cancellable: boolean;
  error?: string | null;
}

/**
 * Outcome of OpenBitFun's automatic-index policy. The daemon reports `needs_index` both while the
 * policy is still evaluating a workspace and after it deliberately declined to index one, so the
 * daemon phase alone cannot explain to the user why nothing is happening.
 */
export type WorkspaceSearchAutoIndexDecision =
  | 'pending'
  | 'eligible'
  | 'belowThreshold'
  | 'unsupported';

export interface WorkspaceSearchAutoIndexStatus {
  decision: WorkspaceSearchAutoIndexDecision;
  threshold: number;
  /**
   * Exact for `belowThreshold`. For `eligible` the count stops as soon as the threshold is
   * reached, so it is only a lower bound there. Absent for `pending` and `unsupported`.
   */
  indexableFiles?: number | null;
  reason?: string | null;
}

export interface WorkspaceSearchIndexStatus {
  repoStatus: WorkspaceSearchRepoStatus;
  activeTask?: WorkspaceSearchTaskStatus | null;
  /** Absent on transports without a OpenBitFun-side auto-index policy (remote SSH workspaces). */
  autoIndex?: WorkspaceSearchAutoIndexStatus | null;
}

export interface WorkspaceSearchIndexTaskHandle {
  task: WorkspaceSearchTaskStatus;
  repoStatus: WorkspaceSearchRepoStatus;
}

export interface ExplorerNodeDto {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number | null;
  extension?: string | null;
  lastModified?: number | null;
  children?: ExplorerNodeDto[];
}

export interface ExplorerChildrenPageDto {
  children: ExplorerNodeDto[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}
