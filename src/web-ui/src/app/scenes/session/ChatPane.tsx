/**
 * ChatPane — AI Agent scene left pane.
 * Hosts FlowChat conversation panel.
 *
 * Renamed from panels/CenterPanel. All logic preserved.
 */

import React, { useCallback, memo, useRef, useState, useMemo, useContext } from 'react';
import { ChatFileDropOverlay } from './ChatFileDropOverlay';
import type { FileDropPreview, FileDropPosition } from '@/shared/types/fileDropPreview';
import { ModernFlowChatContainer as FlowChatContainer } from '../../../flow_chat/components/modern/ModernFlowChatContainer';
import { ChatInput } from '../../../flow_chat/components/ChatInput';
import type { ChatInputRegistration } from '../../../flow_chat/components/chatInputRegistration';
import { createTab } from '@/shared/utils/tabUtils';
import { type LineRange } from '@/shared/editor/LineRange';
import path from 'path-browserify';
import { createLogger } from '@/shared/utils/logger';
import { hasNonFileUriScheme } from '@/shared/utils/pathUtils';
import { sessionWorkspaceId } from '../../../flow_chat/session-drivers/sessionFileNavigation';

import './ChatPane.scss';
import { ConversationViewProvider } from '@/flow_chat/contexts/ConversationViewProvider';
import { openWorkbenchContent } from '@/shared/services/workbenchContentService';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { ConversationSessionRef } from '@/flow_chat/contexts/conversationViewScope';
import { ConversationTextVisibilityContext } from '@/flow_chat/contexts/conversationViewScope';

const log = createLogger('ChatPane');
interface ChatPaneProps {
  sessionRef?: ConversationSessionRef;
  presentation?: 'standard' | 'compact';
  viewId?: string;
  width: number;
  isFullscreen: boolean;
  isSceneActive?: boolean;
  workspacePath?: string;
  isDragging?: boolean;
  showChatInput?: boolean;
  /** Whether the host-owned session right panel is open. */
  isRightPanelOpen?: boolean;
  /** Toggle the host-owned session right panel. */
  onToggleRightPanel?: () => void;
  /** Optional host-owned replacement for the empty-session welcome surface. */
  emptyState?: React.ReactNode;
  /**
   * Content/transport registered into the shared ChatInput. The owner may
   * customize these bounded extension points but cannot replace the composer.
   */
  chatInputRegistration?: ChatInputRegistration;
}

const ChatPaneInner: React.FC<ChatPaneProps> = ({
  sessionRef,
  width: _width,
  isFullscreen,
  isSceneActive: hostActive = true,
  workspacePath,
  isDragging: _isDragging = false,
  showChatInput = false,
  isRightPanelOpen = false,
  onToggleRightPanel,
  emptyState,
  chatInputRegistration,
}) => {
  const isSceneActive = useContext(ConversationTextVisibilityContext) && hostActive;
  const fileDropTargetRef = useRef<HTMLDivElement>(null);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [filePreview, setFilePreview] = useState<FileDropPreview | null>(null);
  const fileDragPosition = useRef<FileDropPosition | null>(null);
  const updateFileDragPosition = useCallback((position: FileDropPosition | null) => {
    fileDragPosition.current = position;
  }, []);

  const handleFileViewRequest = useCallback(async (
    filePath: string,
    fileName: string,
    lineRange?: LineRange
  ) => {
    log.info('File view request', { filePath, fileName, lineRange, workspacePath });

    if (!filePath) {
      log.warn('Invalid file path');
      return;
    }

    let absoluteFilePath = filePath;
    const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);
    const isProtocolPath = hasNonFileUriScheme(filePath);

    if (!isProtocolPath && !isWindowsAbsolutePath && !path.isAbsolute(filePath) && workspacePath) {
      absoluteFilePath = path.join(workspacePath, filePath);
      log.debug('Converting relative path to absolute', {
        relative: filePath,
        absolute: absoluteFilePath
      });
    }

    const { fileTabManager } = await import('@/shared/services/FileTabManager');
    fileTabManager.openFile({
      filePath: absoluteFilePath,
      fileName,
      // The conversation's session owns the referenced file.
      workspaceId: sessionWorkspaceId(flowChatStore.getActiveSession()?.sessionId),
      workspacePath,
      jumpToRange: lineRange,
      scope: sessionRef ? { surfaceId: sessionRef.surfaceId, workspacePath, remoteConnectionId: flowChatStore.getState().sessions.get(sessionRef.sessionId)?.remoteConnectionId } : undefined,
      mode: 'agent'
    });
  }, [workspacePath, sessionRef]);

  const handleTabOpen = useCallback((tabInfo: any) => {
    log.info('Opening tab', { tabInfo });
    if (!tabInfo || !tabInfo.type) {
      return;
    }

    if (sessionRef) {
      openWorkbenchContent({ type: tabInfo.type, title: tabInfo.title, data: { ...tabInfo.data, sessionId: sessionRef.sessionId } },
        { scope: { surfaceId: sessionRef.surfaceId, workspacePath, remoteConnectionId: flowChatStore.getState().sessions.get(sessionRef.sessionId)?.remoteConnectionId } });
      return;
    }
    createTab({ ...tabInfo, title: tabInfo.title || 'New Tab', mode: 'agent' });
  }, [sessionRef, workspacePath]);

  return (
    <div data-openbitfun-component="chat-pane" data-openbitfun-part="root"
      ref={fileDropTargetRef}
      className="openbitfun-chat-pane__content"
      data-shortcut-scope="chat"
      data-fullscreen={isFullscreen}
      data-testid="chat-pane"
    >
      <FlowChatContainer
        className="openbitfun-chat-pane__chat-container"
        isViewportActive={isSceneActive}
        isRightPanelOpen={isRightPanelOpen}
        onToggleRightPanel={onToggleRightPanel}
        emptyState={emptyState}
        onOpenVisualization={(type, data) => {
          log.info('Opening visualization', { type, data });
        }}
        onFileViewRequest={handleFileViewRequest}
        onTabOpen={handleTabOpen}
      />
      {showChatInput && (
        <ChatInput
          fileDropTargetRef={fileDropTargetRef}
          onFileDragOverChange={setIsFileDragOver}
          onFileDragPreviewChange={setFilePreview}
          onFileDragPositionChange={updateFileDragPosition}
          isSceneActive={isSceneActive}
          registration={chatInputRegistration}
        />
      )}
      {showChatInput && isSceneActive && isFileDragOver && (
        <ChatFileDropOverlay preview={filePreview} positionRef={fileDragPosition} />
      )}
    </div>
  );
};

const ChatPane = memo((props: ChatPaneProps) => {
  const sessionId = props.sessionRef?.sessionId;
  const surfaceId = props.sessionRef?.surfaceId;
  const scope = useMemo(() => sessionId !== undefined && surfaceId !== undefined
    ? { sessionId, surfaceId, viewId: props.viewId ?? 'floating', presentation: props.presentation ?? 'compact' } : null,
    [sessionId, surfaceId, props.viewId, props.presentation]);
  return scope ? <ConversationViewProvider scope={scope}><ChatPaneInner {...props} /></ConversationViewProvider> : <ChatPaneInner {...props} />;
});
ChatPane.displayName = 'ChatPane';

export default ChatPane;
