 

import { i18nService } from '@/infrastructure/i18n';
import { fileTabManager } from '@/shared/services/FileTabManager';
import type { FileTabOptions } from '@/shared/services/FileTabManager';
import { useBottomTerminalCanvasStore } from '@/app/components/panels/content-canvas/stores';
import type { PanelContentType } from '@/app/components/panels/base/types';
import { openCanvasContent, openContentInBestTarget } from '@/shared/services/workbenchContentService';
type OpenSource = 'default' | 'project-nav';
import { TAB_EVENTS } from '@/app/components/panels/content-canvas/types';
import { parseCanvasArtifactReference } from '@/shared/utils/canvasArtifactReference';
import type { ContentResourceScope } from '@/shared/types/contentResource';
export type TabTargetMode = 'agent' | 'project' | 'git';

export interface TabCreationOptions {
  type: string;
  title: string;
  data: any;
  metadata?: Record<string, any>;
  checkDuplicate?: boolean;
  duplicateCheckKey?: string;
  replaceExisting?: boolean;
  /** Git explicitly selects its inline host; agent/project use the session-first default. */
  mode?: TabTargetMode;
  /** Check the originating operation before committing a resource or inline view. */
  isCurrent?: () => boolean;
}

interface CreateTerminalTabOptions {
  sceneJustOpened?: boolean;
  scope?: ContentResourceScope;
}

export interface CreateReviewPlatformPullRequestDetailTabOptions {
  workspaceId: string;
  workspacePath?: string;
  remoteId?: string;
  pullRequestId?: string;
  pullRequestUrl?: string;
  title?: string;
}

export interface OpenCanvasArtifactTabOptions {
  workspaceId?: string;
  artifactReference: string;
  title?: string;
  source?: string;
  status?: string;
  diagnostics?: unknown[];
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  sourceMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}


 
export function createTab(options: TabCreationOptions): void {
  if (options.isCurrent && !options.isCurrent()) return;
  const {
    type,
    title,
    data,
    metadata = {},
    duplicateCheckKey,
    replaceExisting = false,
    mode = 'agent' 
  } = options;

  const content = { type: type as PanelContentType, title, data, metadata: { ...metadata, duplicateCheckKey: duplicateCheckKey ?? metadata.duplicateCheckKey } };
  const openOptions = { resourceKey: duplicateCheckKey, replaceExisting, isCurrent: options.isCurrent };
  if (mode === 'git') openCanvasContent('git', content, openOptions);
  else openContentInBestTarget(content, openOptions);
}

/** Open a persisted Canvas artifact through the same panel path as Canvas tool cards. */
export function openCanvasArtifactTab(options: OpenCanvasArtifactTabOptions): boolean {
  const artifactReference = options.artifactReference.trim();
  if (!options.workspaceId || !parseCanvasArtifactReference(artifactReference)) {
    return false;
  }

  const duplicateCheckKey = JSON.stringify(['openbitfun-canvas', options.workspaceId, artifactReference]);
  createTab({
    type: 'openbitfun-canvas',
    title: options.title?.trim() || 'OpenBitFun Canvas',
    data: {
      artifactReference,
      source: options.source,
      status: options.status,
      diagnostics: options.diagnostics,
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      remoteConnectionId: options.remoteConnectionId,
      remoteSshHost: options.remoteSshHost,
      ...(options.sourceMetadata ? { _source: options.sourceMetadata } : {}),
    },
    metadata: {
      duplicateCheckKey,
      artifactReference,
      ...options.metadata,
    },
    checkDuplicate: true,
    duplicateCheckKey,
    replaceExisting: true,
    mode: 'agent',
  });
  return true;
}

 
export function createFileViewerTab(
  filePath: string, 
  fileName: string, 
  content: string,
  mode: 'agent' | 'project' = 'project'
): void {
  createTab({
    type: 'file-viewer',
    title: fileName,
    data: { filePath, fileName, initialContent: content },
    metadata: { filePath, fileName },
    checkDuplicate: true,
    duplicateCheckKey: filePath,
    replaceExisting: false,
    mode
  });
}

 
export function createCodeEditorTab(
  filePath: string,
  fileName: string,
  options?: {
    language?: string;
    readOnly?: boolean;
    showLineNumbers?: boolean;
    showMinimap?: boolean;
    jumpToLine?: number;
    jumpToColumn?: number;
  },
  mode: 'agent' | 'project' = 'agent'
): void {
  createTab({
    type: 'code-editor',
    title: fileName,
    data: {
      filePath,
      fileName,
      language: options?.language,
      readOnly: options?.readOnly ?? false,
      showLineNumbers: options?.showLineNumbers ?? true,
      showMinimap: options?.showMinimap ?? true,
      jumpToLine: options?.jumpToLine,
      jumpToColumn: options?.jumpToColumn
    },
    metadata: { filePath, fileName },
    checkDuplicate: true,
    duplicateCheckKey: `code-editor:${filePath}`,
    replaceExisting: true,
    mode
  });
}

export function createDiffEditorTab(
  filePath: string,
  fileName: string,
  originalCode: string,
  modifiedCode: string,
  readOnly: boolean = false,
  mode: TabTargetMode = 'agent',
  repositoryPath?: string,
  revealLine?: number,
  replaceExisting?: boolean,
  options?: {
    titleKind?: 'git-diff' | 'diff' | 'fix-preview';
    duplicateKeyPrefix?: 'git-diff' | 'diff' | 'fix-diff';
    /** Owning workspace ID; saves from the diff are routed by it. `repositoryPath` is only the IO root. */
    workspaceId?: string;
  }
): void {
  const titleKind = options?.titleKind ?? (repositoryPath ? 'git-diff' : 'fix-preview');
  const duplicateKeyPrefix = options?.duplicateKeyPrefix ?? (repositoryPath ? 'git-diff' : 'fix-diff');
  const duplicateKey = repositoryPath
    ? `${duplicateKeyPrefix}:${repositoryPath}:${filePath}`
    : `${duplicateKeyPrefix}:${filePath}`;
  const titleSuffix =
    titleKind === 'git-diff'
      ? i18nService.getT()('common:tabs.gitDiff')
      : titleKind === 'diff'
        ? i18nService.getT()('common:tabs.diff')
        : i18nService.getT()('common:tabs.fixPreview');

  createTab({
    type: 'diff-code-editor',
    title: `${fileName} - ${titleSuffix}`,
    data: {
      fileName,
      filePath,
      language: 'typescript',
      originalCode,
      modifiedCode,
      readOnly,
      repositoryPath,
      workspaceId: options?.workspaceId,
      revealLine,
    },
    metadata: { filePath, repositoryPath, duplicateCheckKey: duplicateKey },
    checkDuplicate: true,
    duplicateCheckKey: duplicateKey,
    replaceExisting: replaceExisting ?? false,
    mode,
  });
}

/**
 * Open a Git diff tab in the Git scene canvas (mode 'git').
 * Use from Git scene only; keeps diff editing inside the Git context.
 */
export function createGitDiffEditorTab(
  filePath: string,
  fileName: string,
  originalCode: string,
  modifiedCode: string,
  repositoryPath: string,
  readOnly: boolean = false,
  replaceExisting?: boolean,
  workspaceId?: string
): void {
  createDiffEditorTab(
    filePath,
    fileName,
    originalCode,
    modifiedCode,
    readOnly,
    'git',
    repositoryPath,
    undefined,
    replaceExisting,
    workspaceId ? { workspaceId } : undefined
  );
}

/**
 * Open a code editor tab in the Git scene canvas (e.g. for untracked files).
 */
export function createGitCodeEditorTab(
  filePath: string,
  fileName: string,
  options?: Parameters<typeof createCodeEditorTab>[2]
): void {
  createTab({
    type: 'code-editor',
    title: fileName,
    data: {
      filePath,
      fileName,
      language: options?.language,
      readOnly: options?.readOnly ?? false,
      showLineNumbers: options?.showLineNumbers ?? true,
      showMinimap: options?.showMinimap ?? true,
      jumpToLine: options?.jumpToLine,
      jumpToColumn: options?.jumpToColumn,
    },
    metadata: { filePath, fileName },
    checkDuplicate: true,
    duplicateCheckKey: `code-editor:${filePath}`,
    replaceExisting: true,
    mode: 'git',
  });
}

 
export function createMarkdownEditorTab(
  title: string,
  initialContent: string,
  filePath?: string,
  workspacePath?: string,
  mode: 'agent' | 'project' = 'agent'
): void {
  const timestamp = Date.now();
  const duplicateKey = filePath || `markdown-editor-${timestamp}`;
  
  createTab({
    type: 'markdown-editor',
    title,
    data: {
      initialContent,
      filePath,
      fileName: title,
      workspacePath,
      readOnly: false
    },
    metadata: {
      duplicateCheckKey: duplicateKey,
      timestamp
    },
    checkDuplicate: !filePath, 
    duplicateCheckKey: duplicateKey,
    replaceExisting: false,
    mode
  });
}

 
export function createConfigCenterTab(
  _initialTab: 'models' | 'agents' = 'models',
  _mode: 'agent' | 'project' = 'agent'
): void {
  // Settings is now an independent scene — open via event bus.
  window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'settings' } }));
}

export function createReviewPlatformTab(workspaceId: string, workspacePath?: string): void {
  const detail = {
    type: 'review-platform',
    title: i18nService.getT()('common:tabs.pullRequests'),
    data: { workspaceId, workspacePath },
    metadata: {
      workspacePath,
      duplicateCheckKey: `review-platform:${workspaceId}`,
    },
    checkDuplicate: true,
    duplicateCheckKey: `review-platform:${workspaceId}`,
    replaceExisting: true,
  };

  createTab(detail);
}

export function createBackgroundCommandOutputTab(options: {
  execSessionKey: string;
  execSessionId: number;
  remote: boolean;
  title?: string;
  command?: string;
  mockKind?: string;
}): void {
  const title = options.title || i18nService.getT()('flow-chat:backgroundCommandOutput.title');
  const duplicateKey = `background-command-output:${options.execSessionKey}`;
  const detail = {
    type: 'background-command-output',
    title,
    data: {
      execSessionKey: options.execSessionKey,
      execSessionId: options.execSessionId,
      remote: options.remote,
      title,
      command: options.command,
      mockKind: options.mockKind,
    },
    metadata: {
      execSessionKey: options.execSessionKey,
      execSessionId: options.execSessionId,
      duplicateCheckKey: duplicateKey,
      contentRole: 'background-command-output',
    },
    checkDuplicate: true,
    duplicateCheckKey: duplicateKey,
    replaceExisting: true,
  };

  createTab(detail);
}

export function createReviewPlatformPullRequestDetailTab(options: CreateReviewPlatformPullRequestDetailTabOptions): void {
  const pullRequestLabel = options.pullRequestId ? `#${options.pullRequestId}` : 'Pull Request';
  const title = options.title || pullRequestLabel;
  const duplicateKey = [
    'review-platform-pr-detail',
    options.workspaceId,
    options.remoteId || 'auto',
    options.pullRequestId || options.pullRequestUrl || 'unknown',
  ].join(':');
  const detail = {
    type: 'review-platform-pr-detail',
    title,
    data: {
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      remoteId: options.remoteId,
      pullRequestId: options.pullRequestId,
      pullRequestUrl: options.pullRequestUrl,
    },
    metadata: {
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      remoteId: options.remoteId,
      pullRequestId: options.pullRequestId,
      pullRequestUrl: options.pullRequestUrl,
      duplicateCheckKey: duplicateKey,
    },
    checkDuplicate: true,
    duplicateCheckKey: duplicateKey,
    replaceExisting: true,
  };

  createTab(detail);
}

export function createTerminalTab(
  sessionId: string,
  sessionName: string,
  mode: 'agent' | 'project' | 'bottom-terminal' = 'agent',
  options: CreateTerminalTabOptions = {}
): void {
  const detail = {
    type: 'terminal',
    title: sessionName,
    data: { sessionId, sessionName },
    metadata: {
      isTerminal: true,
      sessionId,
      duplicateCheckKey: `terminal-${sessionId}`,
      terminalCloseBehavior: 'detach',
    },
    checkDuplicate: true,
    duplicateCheckKey: `terminal-${sessionId}`,
    replaceExisting: false,
  };

  if (mode === 'bottom-terminal') {
    const store = useBottomTerminalCanvasStore.getState();
    const existing = store.findTabByMetadata({ duplicateCheckKey: detail.duplicateCheckKey });
    if (existing) store.switchToTab(existing.tab.id, existing.groupId);
    else store.addTab({ ...detail, type: 'terminal' }, 'active');
    window.dispatchEvent(new CustomEvent(TAB_EVENTS.EXPAND_BOTTOM_TERMINAL_PANEL));
    return;
  }
  openContentInBestTarget({ ...detail, type: 'terminal' }, { scope: options.scope });

}

type OpenFileInBestTargetOptions = Omit<FileTabOptions, 'mode'>;
interface OpenFileTargetContext {
  source?: OpenSource;
}

/** Open near the owning conversation, falling back to a main resource tab. */
export function openFileInBestTarget(
  options: OpenFileInBestTargetOptions,
  _context: OpenFileTargetContext = {}
): void {
  fileTabManager.openFile(options);
}
