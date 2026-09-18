/**
 * File operation tool card on the shared prominent FlowChat framework.
 * Supports Write/Edit/Delete file operations
 *
 * Card height changes reflow naturally. Expanded-state changes use
 * `useToolCardHeightContract.applyExpandedState(...)` only to notify the virtualizer
 * that it should remeasure the card after the transition.
 */

import React, { useEffect, useCallback, useMemo, useState, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import path from 'path-browserify';
import type { ToolCardProps } from '../types/flow-chat';
import {
  FileOperationToolCard as FileOperationCardView,
} from '@openbitfun/ui/flow-chat';
import { useSnapshotState } from '../../tools/snapshot_system/hooks/useSnapshotState';
import { SnapshotEventBus, SNAPSHOT_EVENTS } from '../../tools/snapshot_system/core/SnapshotEventBus';
import { useOptionalCurrentWorkspace } from '../../infrastructure/contexts/WorkspaceContext';
import { createDiffEditorTab } from '../../shared/utils/tabUtils';
import { fileTabManager } from '../../shared/services/FileTabManager';
import { CodePreview } from '../components/CodePreview';
import { InlineDiffPreview } from '../components/InlineDiffPreview';
import { diffLines } from 'diff';
import { createLogger } from '@/shared/utils/logger';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { useToolCardCompletionGracePeriod } from './useToolCardCompletionGracePeriod';
import { useTypewriter } from '../hooks/useTypewriter';
import { useReportTypewriterReveal } from '../hooks/typewriterRevealGateContext';
import { hasNonFileUriScheme } from '@/shared/utils/pathUtils';
import {
  displayFileToolGuidanceMessage,
  isFileToolGuidanceResult,
} from './fileToolGuidance';
import { extractFilePathFromJsonBuffer, splitFilePathAndContent } from '@/shared/utils/partialJsonParser';
import { i18nService } from '@/infrastructure/i18n';
import { WritePlanDisplay } from './WritePlanDisplay';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { hasSessionFileProvider, openFileThroughSession } from '../session-drivers/sessionFileNavigation';

const log = createLogger('FileOperationToolCard');
const FILE_OPERATION_STREAMING_MAX_HEIGHT = 4 * 22; // 88px – compact while streaming
const FILE_OPERATION_DIFF_MAX_HEIGHT = 15 * 22;     // 330px – comfortable diff reading when expanded

function stringPath(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function firstStringValue(source: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const value = stringPath(source[key]);
    if (value) return value;
  }
  return '';
}

function pathFromAcpLocations(locations: unknown): string {
  if (!Array.isArray(locations)) return '';
  for (const location of locations) {
    const object = objectValue(location);
    const filePath = firstStringValue(object, ['path', 'file_path', 'filePath', 'uri']);
    if (filePath) return filePath;
  }
  return '';
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

function resolveOpenFilePath(filePath: string, workspacePath?: string): string {
  if (!filePath || hasNonFileUriScheme(filePath) || isWindowsAbsolutePath(filePath) || path.isAbsolute(filePath)) {
    return filePath;
  }

  return workspacePath ? path.join(workspacePath, filePath) : filePath;
}

function fileOperationPath(toolItem: ToolCardProps['toolItem']): string {
  const result = toolItem.toolResult?.result;
  const resultPath = stringPath(result?.file_path) || stringPath(result?.filePath);
  if (resultPath) return resultPath;

  const resultLocationPath = pathFromAcpLocations(result?.locations);
  if (resultLocationPath) return resultLocationPath;

  const params = objectValue(toolItem.partialParams || toolItem.toolCall?.input);
  if (!params || Object.keys(params).length === 0) return '';

  const combinedParts = splitFilePathAndContent(params.payload);
  return combinedParts?.filePath || firstStringValue(params, [
    'file_path',
    'filePath',
    'filepath',
    'target_file',
    'targetFile',
    'path',
    'filename',
  ]) || extractFilePathFromJsonBuffer(toolItem._paramsBuffer || '');
}

function writeOperationContent(toolItem: ToolCardProps['toolItem']): string {
  const params = objectValue(toolItem.partialParams || toolItem.toolCall?.input);
  if (!params) return '';
  const combinedParts = splitFilePathAndContent(params.payload);
  if (combinedParts) return combinedParts.content;
  return stringPath(params.content) || stringPath(params.contents);
}

function isFailedFileOperation(toolItem: ToolCardProps['toolItem']): boolean {
  return toolItem.toolResult?.success === false
    || toolItem.status === 'error'
    || toolItem.status === 'cancelled'
    || toolItem.status === 'rejected';
}

interface FileOperationToolCardProps extends ToolCardProps {
  sessionId?: string;
}

const GenericFileOperationToolCard: React.FC<FileOperationToolCardProps> = ({
  toolItem,
  config,
  sessionId,
  onOpenInEditor,
  isLastItem,
}) => {
  const { t } = useTranslation('flow-chat');
  const {
    toolCall,
    toolResult,
    status,
    isParamsStreaming,
    partialParams,
    requiresConfirmation,
    userConfirmed,
  } = toolItem;
  const toolId = toolItem.id ?? toolCall?.id;
  const isFailed = status === 'error' || (toolResult && 'success' in toolResult && !toolResult.success);
  
  const [isContentExpanded, setIsContentExpanded] = useState(status !== 'completed' && !isFailed);
  const [isFailureExpanded, setIsFailureExpanded] = useState(false);
  const [retainLiveCompletionPreview, setRetainLiveCompletionPreview] = useState(false);
  const [operationDiffStats, setOperationDiffStats] = useState<{ surfaceEpoch: number; additions: number; deletions: number } | null>(null);
  
  const hasInitializedCompletionEffectRef = useRef(false);
  const previousCompletionEndTimeRef = useRef<number | null>(toolItem.endTime ?? null);
  const userToggledContentRef = useRef(false);
  const {
    cardRootRef,
    applyExpandedState: applyHeightContractExpandedState,
  } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });
  
  const {
    surfaceEpoch,
    snapshotsAvailable,
    error,
    clearError
  } = useSnapshotState(sessionId);
  // A recorded operation is viewable even when older Session history has no
  // complete snapshot coverage. Absence preserves compatibility with old hosts.
  const isDispatchSession = hasSessionFileProvider(sessionId);
  const operationSnapshotAvailable = !isDispatchSession
    && (snapshotsAvailable || toolResult?.result?.snapshot_recorded === true);
  const eventBus = SnapshotEventBus.getInstance();
  const { workspace: currentWorkspace } = useOptionalCurrentWorkspace();

  const getFilePath = useCallback((): string => {
    const result = toolResult?.result;
    const resultPath = stringPath(result?.file_path) || stringPath(result?.filePath);
    if (resultPath) {
      return resultPath;
    }
    const resultLocationPath = pathFromAcpLocations(result?.locations);
    if (resultLocationPath) {
      return resultLocationPath;
    }

    const params = objectValue(partialParams || toolCall?.input);
    if (!params) return '';
    
    if (Object.keys(params).length === 0) return '';
    
    const combinedParts = splitFilePathAndContent(params.payload);
    return combinedParts?.filePath || firstStringValue(params, [
      'file_path',
      'filePath',
      'filepath',
      'target_file',
      'targetFile',
      'path',
      'filename',
    ]) || extractFilePathFromJsonBuffer(toolItem._paramsBuffer || '');
  }, [toolCall, partialParams, toolResult, toolItem._paramsBuffer]);

  const currentFilePath = getFilePath();
  const openFilePath = useMemo(
    () => resolveOpenFilePath(currentFilePath, currentWorkspace?.rootPath),
    [currentFilePath, currentWorkspace?.rootPath],
  );

  const getOldString = useCallback((): string => {
    const params = partialParams || toolCall?.input;
    if (!params) return '';
    return params.old_string || '';
  }, [toolCall, partialParams]);

  const getNewString = useCallback((): string => {
    const params = partialParams || toolCall?.input;
    if (!params) return '';
    return params.new_string || '';
  }, [toolCall, partialParams]);

  const getContent = useCallback((): string => {
    const params = partialParams || toolCall?.input;
    if (!params) return '';
    const combinedParts = splitFilePathAndContent(params.payload);
    if (combinedParts) return combinedParts.content;
    if (typeof params.payload === 'string') return params.payload;
    return params.content || params.contents || '';
  }, [toolCall, partialParams]);

  const oldStringContent = getOldString();
  const newStringContent = getNewString();
  const contentPreview = getContent();

  const isWriteContentAnimating =
    toolItem.toolName === 'Write'
    && Boolean(isParamsStreaming)
    && status !== 'completed'
    && status !== 'error'
    && status !== 'cancelled'
    && status !== 'rejected';
  const isEditContentAnimating =
    toolItem.toolName === 'Edit'
    && Boolean(isParamsStreaming)
    && status !== 'completed'
    && status !== 'error'
    && status !== 'cancelled'
    && status !== 'rejected';

  const writeTypewriter = useTypewriter(
    toolItem.toolName === 'Write' ? contentPreview : '',
    isWriteContentAnimating,
  );
  const editTypewriter = useTypewriter(
    toolItem.toolName === 'Edit' ? newStringContent : '',
    isEditContentAnimating,
  );
  useReportTypewriterReveal(`${toolId ?? 'file-op'}:write`, writeTypewriter.isRevealing);
  useReportTypewriterReveal(`${toolId ?? 'file-op'}:edit`, editTypewriter.isRevealing);

  const writeDisplayContent = (isWriteContentAnimating || writeTypewriter.isRevealing)
    ? writeTypewriter.displayText
    : contentPreview;
  const editDisplayContent = (isEditContentAnimating || editTypewriter.isRevealing)
    ? editTypewriter.displayText
    : newStringContent;
  const writeVisuallyStreaming = isWriteContentAnimating || writeTypewriter.isRevealing;
  const editVisuallyStreaming = isEditContentAnimating || editTypewriter.isRevealing;

  const writeContentCharCount = toolItem.toolName === 'Write' ? contentPreview.length : 0;
  const writeContentStatusText = useMemo(() => {
    if (toolItem.toolName !== 'Write' || writeContentCharCount <= 0) return null;

    const formattedCount = i18nService.formatNumber(writeContentCharCount);
    if (status === 'completed') {
      return `${formattedCount} chars written`;
    }
    return `${formattedCount} chars received`;
  }, [status, toolItem.toolName, writeContentCharCount]);
  
  const {
    begin: beginCompletionPreview,
    isActive: isCompletionPreviewActive,
  } = useToolCardCompletionGracePeriod({
    eligible:
      status === 'completed' &&
      !isFailed &&
      isLastItem === true &&
      isContentExpanded &&
      !userToggledContentRef.current,
    isRevealing: writeTypewriter.isRevealing || editTypewriter.isRevealing,
  });
  const rawErrorMessage = (() => {
    if (toolResult && 'error' in toolResult) {
      return toolResult.error;
    }
    if (error) {
      return error;
    }
    return undefined;
  })();
  const isFileGuidanceBlocked =
    (toolItem.toolName === 'Write' || toolItem.toolName === 'Edit')
    && isFileToolGuidanceResult(rawErrorMessage, toolResult?.result);
  const showConfirmationActions = Boolean(
    requiresConfirmation &&
    !userConfirmed &&
    status !== 'completed' &&
    status !== 'cancelled' &&
    status !== 'rejected' &&
    status !== 'error'
  );
  
  const isWriteStreamingWithoutPath =
    toolItem.toolName === 'Write'
    && !currentFilePath
    && Boolean(isParamsStreaming)
    && (writeContentCharCount > 0 || status === 'receiving');

  const fileName = currentFilePath ?
    (currentFilePath.split(/[/\\]/).pop() || t('context.file')) :
    (isFailed ? t('toolCards.file.unknownFile') :
      (isWriteStreamingWithoutPath
        ? t('toolCards.file.receivingContent')
        : t('toolCards.file.parsingPath')));
  
  useEffect(() => {
    const completionEndTime = toolItem.endTime ?? null;
    const isCompletedSuccess = status === 'completed' && Boolean(toolResult?.success);

    if (!hasInitializedCompletionEffectRef.current) {
      hasInitializedCompletionEffectRef.current = true;
      previousCompletionEndTimeRef.current = completionEndTime;
      return;
    }

    const shouldEmitCompletionEvent =
      snapshotsAvailable &&
      isCompletedSuccess &&
      completionEndTime !== null &&
      previousCompletionEndTimeRef.current !== completionEndTime &&
      Boolean(sessionId) &&
      Boolean(currentFilePath);

    previousCompletionEndTimeRef.current = completionEndTime;

    if (!shouldEmitCompletionEvent || !sessionId || !currentFilePath) {
      return;
    }

    eventBus.emit(SNAPSHOT_EVENTS.FILE_OPERATION_COMPLETED, {
      toolName: toolItem.toolName,
      toolResult
    }, sessionId, currentFilePath);
  }, [snapshotsAvailable, status, toolResult, sessionId, currentFilePath, toolItem.toolName, toolItem.endTime, eventBus]);

  const toolDisplayName = {
    Write: t('toolCards.file.write'),
    Edit: t('toolCards.file.edit'),
    Delete: t('toolCards.file.delete'),
  }[toolItem.toolName] ?? config.displayName;

  const applyContentExpandedState = useCallback((
    nextExpanded: boolean,
    reason: 'manual' | 'auto',
  ) => {
    if (reason === 'manual') {
      userToggledContentRef.current = true;
      setRetainLiveCompletionPreview(false);
    }
    applyHeightContractExpandedState(
      isContentExpanded,
      nextExpanded,
      setIsContentExpanded,
    );
  }, [applyHeightContractExpandedState, isContentExpanded]);

  useEffect(() => {
    if (error) {
      log.error('File operation error', { filePath: currentFilePath, error });
      setTimeout(clearError, 3000);
    }
  }, [error, clearError, currentFilePath]);

  useLayoutEffect(() => {
    if (!isFailed && isFailureExpanded) {
      setIsFailureExpanded(false);
    }
  }, [isFailed, isFailureExpanded]);

  useLayoutEffect(() => {
    if (isFailed) {
      setRetainLiveCompletionPreview(false);
      applyContentExpandedState(false, 'auto');
      return;
    }

    if (userToggledContentRef.current) {
      return;
    }

    if (status === 'completed' && !isFailed) {
      if (isLastItem === true && isContentExpanded) {
        if (beginCompletionPreview()) {
          setRetainLiveCompletionPreview(true);
          return;
        }
      }

      setRetainLiveCompletionPreview(false);
      applyContentExpandedState(false, 'auto');
      return;
    }

    setRetainLiveCompletionPreview(false);
    applyContentExpandedState(true, 'auto');
  }, [
    applyContentExpandedState,
    beginCompletionPreview,
    isCompletionPreviewActive,
    isContentExpanded,
    isFailed,
    isLastItem,
    status,
  ]);

  const localDiffStats = useMemo(() => {
    if (status !== 'completed' || isFailed) return null;
    if (toolItem.toolName === 'Write' && contentPreview) {
      const lines = contentPreview.split('\n');
      const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      return { additions: count, deletions: 0 };
    }
    if (toolItem.toolName === 'Edit' && (oldStringContent || newStringContent)) {
      const changes = diffLines(oldStringContent, newStringContent);
      let additions = 0;
      let deletions = 0;
      for (const change of changes) {
        const lineCount = change.count ?? 0;
        if (change.added) additions += lineCount;
        else if (change.removed) deletions += lineCount;
      }
      return { additions, deletions };
    }
    return null;
  }, [toolItem.toolName, contentPreview, oldStringContent, newStringContent, status, isFailed]);

  const currentFileDiffStats = useMemo(() => {
    return (operationDiffStats?.surfaceEpoch === surfaceEpoch ? operationDiffStats : null)
      ?? localDiffStats ?? { additions: 0, deletions: 0 };
  }, [operationDiffStats, localDiffStats, surfaceEpoch]);

  useEffect(() => {
    setOperationDiffStats(null);
    if (!operationSnapshotAvailable || !sessionId || !toolCall?.id || status !== 'completed' || isFailed) return;
    const scope = getActiveSurfaceScope();
    let cancelled = false;

    (async () => {
      try {
        // The snapshot service persists this summary with the operation. Keep
        // the chat-history payload small and resolve that static value lazily.
        const { snapshotAPI } = await import('../../infrastructure/api');
        if (cancelled || !scope.isCurrent()) return;
        const summary = await snapshotAPI.getOperationSummary(sessionId, toolCall.id);
        if (cancelled || !scope.isCurrent()) return;
        setOperationDiffStats({
          surfaceEpoch,
          additions: summary.linesAdded ? Number(summary.linesAdded) : 0,
          deletions: summary.linesRemoved ? Number(summary.linesRemoved) : 0
        });
      } catch (error) {
        if (cancelled || !scope.isCurrent()) return;
        log.warn('Failed to load operation summary', { sessionId, toolCallId: toolCall.id, error });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [operationSnapshotAvailable, sessionId, toolCall?.id, status, isFailed, surfaceEpoch]);

  const isLoading = status === 'preparing' || status === 'streaming' || status === 'running';
  /*
   * Auto-managed completed cards must keep their compact streaming preview
   * from the first completed render through the collapse commit. Waiting for
   * the grace-period layout effect to set its state briefly renders the large
   * diff preview, and follow-output can treat that transient height as output.
   * A manually expanded card marks itself as user-owned and still gets the
   * full diff preview.
   */
  const keepAutoCompletionPreview =
    status === 'completed' &&
    !isFailed &&
    !userToggledContentRef.current;
  const keepCompactCompletionPreview =
    retainLiveCompletionPreview || keepAutoCompletionPreview;
  const shouldUseExpandedDiffPreviewHeight =
    status === 'completed' &&
    isContentExpanded &&
    !keepCompactCompletionPreview;
  const keepLiveEditPreview =
    keepCompactCompletionPreview &&
    toolItem.toolName === 'Edit' &&
    Boolean(newStringContent);
  const keepLiveWritePreview =
    keepCompactCompletionPreview &&
    toolItem.toolName === 'Write' &&
    Boolean(contentPreview);
  const previewVariant = useMemo(() => {
    if (toolItem.toolName === 'Edit') {
      // Keep streaming-code until typewriter drains so completion does not snap
      // the remaining characters into the diff view.
      if ((status !== 'completed' || editTypewriter.isRevealing || keepLiveEditPreview) && newStringContent) {
        return 'streaming-code';
      }
      if (
        status === 'completed'
        && !isParamsStreaming
        && !editTypewriter.isRevealing
        && !keepLiveEditPreview
        && (oldStringContent || newStringContent)
      ) {
        return 'completed-diff';
      }
    }

    if (toolItem.toolName === 'Write') {
      if ((status !== 'completed' || writeTypewriter.isRevealing || keepLiveWritePreview) && contentPreview) {
        return 'streaming-code';
      }
      if (
        status === 'completed'
        && !isParamsStreaming
        && !writeTypewriter.isRevealing
        && !keepLiveWritePreview
        && contentPreview
      ) {
        return 'completed-diff';
      }
    }

    return 'none';
  }, [
    contentPreview,
    editTypewriter.isRevealing,
    isParamsStreaming,
    keepLiveEditPreview,
    keepLiveWritePreview,
    newStringContent,
    oldStringContent,
    status,
    toolItem.toolName,
    writeTypewriter.isRevealing,
  ]);

  const getErrorMessage = () => {
    if (rawErrorMessage !== undefined) {
      return rawErrorMessage;
    }
    return t('error.unknown');
  };

  const getDisplayMessage = () => {
    const message = getErrorMessage();
    if (isFileGuidanceBlocked) {
      return displayFileToolGuidanceMessage(message);
    }
    return message;
  };

  const handleOpenInCodeEditor = useCallback(async () => {
    if (openFileThroughSession(sessionId, currentFilePath, fileName)) {
      return;
    }
    if (!currentFilePath) return;
    const scope = getActiveSurfaceScope();

    if (!operationSnapshotAvailable || !sessionId || !openFilePath || hasNonFileUriScheme(openFilePath)) {
      fileTabManager.openFile({
        filePath: openFilePath,
        fileName,
        mode: 'agent',
      });
      return;
    }

    try {
      const { snapshotAPI } = await import('../../infrastructure/api');
      if (!scope.isCurrent()) return;
      const diffData = await snapshotAPI.getOperationDiff(sessionId, openFilePath, toolCall?.id);
      if (!scope.isCurrent()) return;
      const jumpToLine = diffData.anchorLine ? Number(diffData.anchorLine) : undefined;

      if (toolItem.toolName === 'Delete' || !snapshotsAvailable) {
        window.dispatchEvent(new CustomEvent('expand-right-panel'));
        setTimeout(() => {
          if (!scope.isCurrent()) return;
          createDiffEditorTab(
            openFilePath,
            fileName,
            diffData.originalContent || '',
            diffData.modifiedContent || '',
            true,
            'agent',
            undefined,
            jumpToLine,
            true
          );
        }, 250);
        return;
      }

      fileTabManager.openFile({
        filePath: openFilePath,
        fileName,
        jumpToLine,
        mode: 'agent',
      });
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to open in CodeEditor', { sessionId, filePath: openFilePath, error });
      if (toolItem.toolName === 'Delete') {
        window.dispatchEvent(new CustomEvent('expand-right-panel'));
        setTimeout(() => {
          if (!scope.isCurrent()) return;
          createDiffEditorTab(
            openFilePath,
            fileName,
            '',
            '',
            true,
            'agent'
          );
        }, 250);
        return;
      }

      fileTabManager.openFile({
        filePath: openFilePath,
        fileName,
        mode: 'agent',
      });
    }
  }, [snapshotsAvailable, operationSnapshotAvailable, sessionId, currentFilePath, openFilePath, toolCall?.id, fileName, toolItem.toolName]);

  const canOpenFullCode =
    !isFailed &&
    toolItem.toolName !== 'Delete' &&
    status === 'completed' &&
    Boolean(currentFilePath) &&
    Boolean(sessionId || onOpenInEditor);

  const handleOpenFullCodeClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!canOpenFullCode || !currentFilePath) {
      return;
    }

    if (sessionId) {
      handleOpenInCodeEditor();
      return;
    }

    onOpenInEditor?.(currentFilePath);
  }, [
    canOpenFullCode,
    currentFilePath,
    handleOpenInCodeEditor,
    onOpenInEditor,
    sessionId,
  ]);

  const handleCodeLineClick = useCallback(async (lineNumber: number, filePath?: string) => {
    if (!filePath) return;
    if (openFileThroughSession(sessionId, filePath, fileName, { start: lineNumber })) {
      return;
    }
    
    try {
      fileTabManager.openFileAndJump(filePath, lineNumber, 1);
    } catch (error) {
      log.error('Failed to jump to line', { filePath, lineNumber, error });
    }
  }, [sessionId, fileName]);

  const renderExpandedContent = () => {
    if (isFailed) return null;

    const previewMaxHeight = shouldUseExpandedDiffPreviewHeight
      ? FILE_OPERATION_DIFF_MAX_HEIGHT
      : FILE_OPERATION_STREAMING_MAX_HEIGHT;

    if (toolItem.toolName === 'Edit') {
      if (previewVariant === 'streaming-code') {
        return (
          <div data-testid="chat-file-change-preview">
            <CodePreview
              content={editDisplayContent}
              filePath={currentFilePath}
              isStreaming={editVisuallyStreaming}
              showLineNumbers={isContentExpanded}
              maxHeight={previewMaxHeight}
              autoScrollToBottom={false}
              onLineClick={handleCodeLineClick}
            />
          </div>
        );
      }
      
      if (previewVariant === 'completed-diff') {
        return (
          <div data-testid="chat-file-change-preview">
            <InlineDiffPreview
              originalContent={oldStringContent}
              modifiedContent={newStringContent}
              filePath={currentFilePath}
              maxHeight={previewMaxHeight}
              showLineNumbers={isContentExpanded}
              lineNumberMode="dual"
              showPrefix={false}
              contextLines={-1}
            />
          </div>
        );
      }
    }

    if (toolItem.toolName === 'Write') {
      if (previewVariant === 'streaming-code') {
        return (
          <div data-testid="chat-file-change-preview">
            <CodePreview
              content={writeDisplayContent}
              filePath={currentFilePath}
              isStreaming={writeVisuallyStreaming}
              showLineNumbers={isContentExpanded}
              maxHeight={previewMaxHeight}
              autoScrollToBottom={false}
              onLineClick={handleCodeLineClick}
            />
          </div>
        );
      }
      
      if (previewVariant === 'completed-diff') {
        return (
          <div data-testid="chat-file-change-preview">
            <InlineDiffPreview
              originalContent=""
              modifiedContent={contentPreview}
              filePath={currentFilePath}
              maxHeight={previewMaxHeight}
              showLineNumbers={isContentExpanded}
              lineNumberMode="single"
              showPrefix={true}
              contextLines={-1}
            />
          </div>
        );
      }
    }

    return null;
  };

  const isDeleteTool = toolItem.toolName === 'Delete';
  const fileChangeAction =
    toolItem.toolName === 'Write'
      ? 'create'
      : toolItem.toolName === 'Edit'
        ? 'modify'
        : toolItem.toolName === 'Delete'
          ? 'delete'
          : toolItem.toolName.toLowerCase();

  const expandedContent = renderExpandedContent();
  const hasExpandableContent =
    !isDeleteTool &&
    (isFailed || Boolean(expandedContent));

  const isCardContentExpanded =
    !isDeleteTool &&
    (isFailed ? isFailureExpanded : isContentExpanded);

  const operation = isDeleteTool
    ? 'delete'
    : toolItem.toolName === 'Edit'
      ? 'edit'
      : 'write';
  const hasDiffStats =
    currentFileDiffStats.additions > 0 || currentFileDiffStats.deletions > 0;
  const headerStatusText = status === 'completed'
    ? undefined
    : writeContentStatusText ?? (
      isParamsStreaming && (status === 'preparing' || status === 'streaming')
        ? (currentFilePath ? t('toolCards.file.receivingParams') : t('toolCards.file.analyzing'))
        : undefined
    );
  const showChangeSummary =
    !isDeleteTool && !isFailed && !isParamsStreaming && !isLoading && hasDiffStats;
  const formattedAdditions = i18nService.formatNumber(currentFileDiffStats.additions);
  const formattedDeletions = i18nService.formatNumber(currentFileDiffStats.deletions);
  const actionLabel = isDeleteTool
    ? `${t('toolCards.file.delete')}${isFailed ? t('toolCards.file.failed') : ''}`
    : isFailed
      ? isFileGuidanceBlocked
        ? `${toolDisplayName}:`
        : `${toolDisplayName}${t('toolCards.file.failed')}`
      : `${toolDisplayName}:`;

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="file-operation-tool-card"
      data-testid="chat-file-change-card"
      data-tool-card-id={toolId ?? ''}
      data-status={status}
      data-action={fileChangeAction}
      data-path={currentFilePath}
      data-expanded={isCardContentExpanded ? 'true' : 'false'}
    >
      <FileOperationCardView
        actionLabel={actionLabel}
        actionTestId="chat-file-change-action"
        changeSummary={showChangeSummary ? {
          additions: formattedAdditions,
          deletions: formattedDeletions,
          label: t('toolCards.file.changeSummary', {
            additions: formattedAdditions,
            deletions: formattedDeletions,
          }),
        } : undefined}
        error={isFailed && !isDeleteTool ? {
          guidance: isFileGuidanceBlocked,
          message: getDisplayMessage(),
          title: isFileGuidanceBlocked
            ? undefined
            : `${toolDisplayName}${t('toolCards.file.failed')}`,
        } : undefined}
        isExpanded={isCardContentExpanded}
        onOpenFile={canOpenFullCode ? {
          label: t('toolCards.file.openFullCodeHint'),
          onPress: handleOpenFullCodeClick,
          testId: 'chat-file-change-open-file',
        } : undefined}
        onToggle={hasExpandableContent
          ? isFailed
            ? () => applyHeightContractExpandedState(
              isFailureExpanded,
              !isFailureExpanded,
              setIsFailureExpanded,
            )
            : () => applyContentExpandedState(!isContentExpanded, 'manual')
          : undefined}
        operation={operation}
        path={currentFilePath}
        pathLabel={fileName}
        pathTestId="chat-file-change-path"
        preview={expandedContent}
        requiresConfirmation={showConfirmationActions}
        status={isFailed ? 'error' : status}
        statusDetail={headerStatusText}
      />
    </div>
  );
};

export const FileOperationToolCard: React.FC<FileOperationToolCardProps> = (props) => {
  const { workspace: currentWorkspace } = useOptionalCurrentWorkspace();
  const targetPath = fileOperationPath(props.toolItem);
  const planFilePath = resolveOpenFilePath(targetPath, currentWorkspace?.rootPath);
  const isPlanWrite = props.toolItem.toolName === 'Write'
    && !isFailedFileOperation(props.toolItem)
    && planFilePath.replace(/\\/g, '/').toLowerCase().endsWith('.plan.md');

  if (isPlanWrite) {
    return (
      <WritePlanDisplay
        toolItem={props.toolItem}
        planFilePath={planFilePath}
        initialContent={writeOperationContent(props.toolItem)}
        workspaceId={currentWorkspace?.id}
        workspacePath={currentWorkspace?.rootPath}
        remoteConnectionId={currentWorkspace?.connectionId}
      />
    );
  }

  return <GenericFileOperationToolCard {...props} />;
};
