/**
 * Streaming text block component.
 * Applies an adaptive typewriter during streaming to smoothly drain
 * batched EventBatcher text updates. Supports a streaming cursor indicator.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import { type MarkdownTraceContext } from '@/infrastructure/markdown';
import type { FlowTextItem } from '../types/flow-chat';
import { useFlowChatContext } from './modern/FlowChatContext';
import { useTypewriter } from '../hooks/useTypewriter';
import { useReportTypewriterReveal } from '../hooks/typewriterRevealGateContext';
import { isStartupRenderTraceEnabled } from '@/shared/utils/startupTrace';
import { DeepResearchProtocolGroup } from '../deep-research/DeepResearchProtocolGroup';
import { parseDeepResearchContent } from '../deep-research/deepResearchProtocol';
import { hasSessionFileProvider, readImageThroughSession, downloadFileThroughSession } from '../session-drivers/sessionFileNavigation';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import './FlowTextBlock.scss';

// Idle timeout (ms) after content stops growing.
const CONTENT_IDLE_TIMEOUT = 500;

interface FlowTextBlockProps {
  textItem: FlowTextItem;
  className?: string;
  /**
   * Replay the whole text through the typewriter on mount. Off by default: the
   * message list is virtualized, so a streaming block that scrolls out and back
   * would otherwise restart from an empty string and re-grow, which reads as the
   * conversation refreshing itself. Only newly appended text is revealed.
   */
  replayStreamingOnMount?: boolean;
  traceContext?: MarkdownTraceContext;
  testId?: string;
  testAttributes?: Record<`data-${string}`, string | number | boolean | undefined>;
}

/**
 * Use React.memo to avoid unnecessary re-renders.
 * Re-render only when key textItem fields change.
 */
export const FlowTextBlock = React.memo<FlowTextBlockProps>(({
  textItem,
  className = '',
  replayStreamingOnMount = false,
  traceContext,
  testId,
  testAttributes,
}) => {
  const {
    sessionId,
    onFileViewRequest,
    onTabOpen,
    onHttpLinkClick,
    onOpenVisualization,
    activeSessionOverride,
    workspaceId: contextWorkspaceId,
    workspacePath: contextWorkspacePath,
    remoteConnectionId: contextRemoteConnectionId,
  } = useFlowChatContext();
  const markdownWorkspaceId = activeSessionOverride?.workspaceId
    || activeSessionOverride?.config?.workspaceId
    || contextWorkspaceId;
  const markdownBasePath = activeSessionOverride?.workspacePath
    || activeSessionOverride?.config?.workspacePath
    || contextWorkspacePath;
  const markdownRemoteConnectionId = activeSessionOverride?.remoteConnectionId
    || activeSessionOverride?.config?.remoteConnectionId
    || contextRemoteConnectionId;
  const markdownRemoteSshHost = activeSessionOverride?.remoteSshHost
    || activeSessionOverride?.config?.remoteSshHost;
  const isDispatchSession = activeSessionOverride
    ? resolveSessionDriverId(activeSessionOverride.sessionId, activeSessionOverride) === 'dispatch'
    : hasSessionFileProvider(sessionId);
  const fileSessionId = activeSessionOverride?.sessionId || sessionId;
  const readImage = useCallback((path: string, refresh?: boolean) => readImageThroughSession(fileSessionId, path, refresh), [fileSessionId]);
  const downloadFile = useCallback((path: string) => downloadFileThroughSession(fileSessionId, path), [fileSessionId]);
  // Stable callback so the memoized Markdown component is not re-rendered
  // (and re-parsed) just because this block re-rendered.
  const handleOpenVisualization = useCallback((visualization: any) => {
    onOpenVisualization?.(visualization?.type, visualization?.data);
  }, [onOpenVisualization]);

  // Normalize content to a string.
  const content = typeof textItem.content === 'string'
    ? textItem.content
    : String(textItem.content || '');

  const isStreaming = textItem.isStreaming &&
    (textItem.status === 'streaming' || textItem.status === 'running');
  const { displayText: displayContent, isRevealing } = useTypewriter(content, isStreaming, {
    replayOnMount: replayStreamingOnMount,
  });
  useReportTypewriterReveal(textItem.id, isRevealing);
  // Keep streaming render mode until the typewriter finishes draining so the
  // Markdown path does not flash when the model completes early.
  const isVisuallyStreaming = isStreaming || isRevealing;
  // Leave Markdown streaming mode one frame after visual settle so footer /
  // list layout commits first; avoids a same-frame Prism upgrade flash.
  const [markdownStreaming, setMarkdownStreaming] = useState(isVisuallyStreaming);
  useEffect(() => {
    if (isVisuallyStreaming) {
      setMarkdownStreaming(true);
      return;
    }
    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          setMarkdownStreaming(false);
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [isVisuallyStreaming]);
  
  // Heuristic: if content does not change for a while, streaming is done.
  const [isContentGrowing, setIsContentGrowing] = useState(isStreaming);
  const lastContentRef = useRef(content);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    const clearGrowthTimeout = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    if (!isStreaming) {
      lastContentRef.current = content;
      clearGrowthTimeout();
      setIsContentGrowing((wasGrowing) => (wasGrowing ? false : wasGrowing));
      return clearGrowthTimeout;
    }

    if (content !== lastContentRef.current) {
      lastContentRef.current = content;
      setIsContentGrowing(true);
      clearGrowthTimeout();
      
      timeoutRef.current = setTimeout(() => {
        setIsContentGrowing(false);
      }, CONTENT_IDLE_TIMEOUT);
    }
    
    return clearGrowthTimeout;
  }, [content, isStreaming]);
  
  // Keep streaming chrome while either the model is actively emitting or the
  // typewriter is still revealing leftover characters.
  const isActivelyStreaming = (isStreaming && isContentGrowing) || isRevealing;
  const markdownTraceContext = isStartupRenderTraceEnabled() ? traceContext : undefined;
  const parsedContent = useMemo(
    () => parseDeepResearchContent(displayContent),
    [displayContent],
  );

  const renderMarkdown = (markdownContent: string, key?: React.Key) => (
    <MarkdownRenderer
      key={key}
      content={markdownContent}
      workspaceId={markdownWorkspaceId}
      basePath={markdownBasePath}
      remoteConnectionId={markdownRemoteConnectionId}
      remoteSshHost={markdownRemoteSshHost}
      // Prefer deferred visual streaming so Prism upgrade does not share a
      // frame with footer insertion / list scroll settlement.
      isStreaming={markdownStreaming}
      onFileViewRequest={onFileViewRequest}
      fileActionsViaCallbackOnly={isDispatchSession}
      onImageRead={isDispatchSession ? readImage : undefined}
      onFileDownload={isDispatchSession ? downloadFile : undefined}
      onTabOpen={onTabOpen}
      onHttpLinkClick={onHttpLinkClick}
      onOpenVisualization={handleOpenVisualization}
      traceContext={markdownTraceContext}
    />
  );

  const renderStructuredContent = () => (
    <div className="deep-research-protocol" data-openbitfun-component="flow-text-block" data-openbitfun-part="protocol">
      {parsedContent.segments.map((segment, index) => (
        segment.type === 'protocol'
          ? (
              <DeepResearchProtocolGroup
                key={`protocol:${index}`}
                kind={segment.kind}
                markers={segment.markers}
              />
            )
          : textItem.isMarkdown
            ? renderMarkdown(segment.content, `markdown:${index}`)
            : (
                <div
                  className="text-content"
                  data-openbitfun-component="flow-text-block"
                  data-openbitfun-part="protocolTextContent"
                  key={`text:${index}`}
                >
                  {segment.content}
                </div>
              )
      ))}
    </div>
  );

  return (
    <div data-openbitfun-component="flow-text-block" data-openbitfun-part="root" data-openbitfun-mode={textItem.isMarkdown ? 'markdown' : 'text'} data-openbitfun-state={isActivelyStreaming ? 'streaming' : ''}
      className={`flow-text-block ${className} ${isActivelyStreaming ? 'streaming flow-text-block--streaming' : ''}`}
      data-testid={testId}
      data-flow-item-id={textItem.id}
      data-status={textItem.status}
      data-streaming={isVisuallyStreaming ? 'true' : 'false'}
      {...testAttributes}
    >
      {parsedContent.hasProtocol ? (
        renderStructuredContent()
      ) : textItem.isMarkdown ? (
        renderMarkdown(displayContent)
      ) : (
        <div data-openbitfun-component="flow-text-block" data-openbitfun-part="textContent" className="text-content">
          {displayContent}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  const prev = prevProps.textItem;
  const next = nextProps.textItem;
  return (
    prev.id === next.id &&
    prev.content === next.content &&
    prev.isStreaming === next.isStreaming &&
    prev.status === next.status &&
    prevProps.className === nextProps.className &&
    prevProps.replayStreamingOnMount === nextProps.replayStreamingOnMount &&
    prevProps.traceContext === nextProps.traceContext &&
    prevProps.testId === nextProps.testId &&
    prevProps.testAttributes === nextProps.testAttributes
  );
});
