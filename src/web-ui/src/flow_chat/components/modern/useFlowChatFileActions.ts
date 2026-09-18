/**
 * File navigation actions for Modern FlowChat.
 */

import { useCallback } from 'react';
import path from 'path-browserify';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '@/shared/notification-system';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { type LineRange } from '@/shared/editor/LineRange';
import { hasNonFileUriScheme } from '@/shared/utils/pathUtils';
import { openFileThroughSession, sessionWorkspaceId } from '../../session-drivers/sessionFileNavigation';

const log = createLogger('useFlowChatFileActions');

interface UseFlowChatFileActionsOptions {
  sessionId?: string;
  workspacePath?: string;
  onFileViewRequest?: (filePath: string, fileName: string, lineRange?: LineRange) => void;
}

export function useFlowChatFileActions({
  sessionId,
  workspacePath,
  onFileViewRequest,
}: UseFlowChatFileActionsOptions) {
  const handleFileViewRequest = useCallback((
    filePath: string,
    fileName: string,
    lineRange?: LineRange,
  ) => {
    log.debug('File view request', {
      filePath,
      fileName,
      hasLineRange: !!lineRange,
      hasExternalCallback: !!onFileViewRequest,
    });

    if (openFileThroughSession(sessionId, filePath, fileName, lineRange)) {
      return;
    }
    if (onFileViewRequest) {
      onFileViewRequest(filePath, fileName, lineRange);
      return;
    }

    let absoluteFilePath = filePath;
    const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);
    const isProtocolPath = hasNonFileUriScheme(filePath);

    if (!isProtocolPath && !isWindowsAbsolutePath && !path.isAbsolute(filePath) && workspacePath) {
      absoluteFilePath = path.join(workspacePath, filePath);
      log.debug('Converted relative path to absolute', {
        relative: filePath,
        absolute: absoluteFilePath,
      });
    }

    try {
      fileTabManager.openFile({
        filePath: absoluteFilePath,
        fileName,
        workspaceId: sessionWorkspaceId(sessionId),
        workspacePath,
        jumpToRange: lineRange,
        mode: 'agent',
      });
    } catch (error) {
      log.error('File navigation failed', error);
      notificationService.error(`Unable to open file: ${absoluteFilePath}`);
    }
  }, [sessionId, onFileViewRequest, workspacePath]);

  return {
    handleFileViewRequest,
  };
}
