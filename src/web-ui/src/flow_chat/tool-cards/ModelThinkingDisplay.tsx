/**
 * Model thinking display component.
 * Ordinary reasoning defaults expanded while this is still the active last
 * step; reasoning summaries use their compact collapsed presentation by
 * default.
 * If the component mounts after later content already appeared
 * (for example after a parent remount), start collapsed directly
 * to avoid a visible expand-then-collapse flash.
 * Applies typewriter effect during streaming. Header activation opens a details
 * panel independently of this automatic inline presentation.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ThinkingBlock } from '@openbitfun/ui/flow-chat';
import { defaultThinkingExpanded, useThinkingDisclosure } from '@openbitfun/flow-chat-presentation/thinking';
import { useTranslation } from 'react-i18next';
import type { FlowThinkingItem } from '../types/flow-chat';
import { useTypewriter } from '../hooks/useTypewriter';
import { useReportTypewriterReveal } from '../hooks/typewriterRevealGateContext';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { useContainedTailFollow } from '@openbitfun/flow-chat-presentation/scroll';
import {
  isTailFollowDiagnosticsEnabled,
  noteTailFollowStep,
} from '@/infrastructure/diagnostics/flowChatTailFollowDiagnostics';
import { latestReasoningSummaryPreview } from '../utils/reasoningSummaryPresentation';
import { ThinkingMarkdownRenderer } from '@/infrastructure/markdown';
import { useFlowChatContext } from '../components/modern/FlowChatContext';
import { openThinkingPanel } from '../services/openThinkingPanel';
import './ModelThinkingDisplay.scss';

interface ModelThinkingDisplayProps {
  thinkingItem: FlowThinkingItem;
  /** Whether this is the last item in the current round. */
  isLastItem?: boolean;
  forceExpanded?: boolean;
  displayContext?: 'default' | 'subagent-projection';
  withinGroup?: boolean;
  hidden?: boolean;
  /** Original session for reasoning projected into another conversation. */
  sourceSessionId?: string;
}

export const ModelThinkingDisplay: React.FC<ModelThinkingDisplayProps> = ({
  thinkingItem,
  isLastItem = true,
  forceExpanded = false,
  displayContext = 'default',
  withinGroup = false,
  hidden,
  sourceSessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { sessionId, workspaceId, workspacePath, remoteConnectionId, activeSessionOverride } = useFlowChatContext();
  const { content, isStreaming, status } = thinkingItem;
  const isSummary = thinkingItem.reasoningKind === 'summary';
  const isActive = isStreaming || status === 'streaming';
  const isSubagentSurface = displayContext === 'subagent-projection'
    || activeSessionOverride?.sessionKind === 'subagent';
  const shouldDefaultExpanded = defaultThinkingExpanded({
    isSummary,
    isActive,
    isLastItem: !withinGroup && isLastItem,
    forceExpanded,
    displayContext,
    compactByDefault: isSubagentSurface,
  });
  const [retainClosingContent, setRetainClosingContent] = useState(shouldDefaultExpanded);
  const expandContainerRef = useRef<HTMLDivElement>(null);
  const { displayText: displayContent, isRevealing } = useTypewriter(
    isSummary ? '' : content,
    isActive && !isSummary,
    // Keep playback through the closing transition, then release the reveal
    // gate and track current content without animating an invisible backlog.
    { revealImmediately: !retainClosingContent },
  );
  useReportTypewriterReveal(thinkingItem.id, isRevealing);
  const { cardRootRef, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId: thinkingItem.id,
    toolName: 'thinking',
  });
  const { expanded: isExpanded } = useThinkingDisclosure({
    // Opening a collection does not open its completed reasoning, including its tail.
    isSummary,
    isActive,
    isRevealing,
    isLastItem: !withinGroup && isLastItem,
    forceExpanded,
    displayContext,
    compactByDefault: isSubagentSurface,
  }, dispatchToolCardToggle);
  const shouldMountContent = isExpanded || retainClosingContent;

  // Historical reasoning starts without inline Markdown. Retain a streamed or
  // forced body through its closing transition, then release it.
  useLayoutEffect(() => {
    if (isExpanded) {
      setRetainClosingContent(true);
      return;
    }
    if (!retainClosingContent) return;
    const transitions = expandContainerRef.current?.getAnimations?.().filter(animation => (
      'transitionProperty' in animation && animation.transitionProperty === 'grid-template-rows'
    )) ?? [];
    if (transitions.length === 0) {
      setRetainClosingContent(false);
      return;
    }
    let cancelled = false;
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (!cancelled) setRetainClosingContent(false);
    });
    return () => { cancelled = true; };
  }, [isExpanded, retainClosingContent]);

  // Keep rendering the typewriter output while it drains after the stream
  // ends. Snapping to full `content` here would make the drain invisible
  // while `isRevealing` still holds the reveal gate, delaying the round
  // footer for no visible reason.
  const renderedContent = !isSummary && isRevealing ? displayContent : content;
  // Cover the whole reveal with Markdown streaming mode so the Prism upgrade
  // does not land mid-drain.
  const isVisuallyStreaming = isActive || isRevealing;

  const { contentRef, contentProps, scrollState } = useContainedTailFollow({
    // Collections grow naturally; reasoning still owns a bounded inner viewport.
    enabled: isExpanded, active: isVisuallyStreaming, contentVersion: renderedContent,
    onStep: step => {
      if (isTailFollowDiagnosticsEnabled()) noteTailFollowStep('thinking', step);
    },
  });

  const contentLengthText = useMemo(() => {
    return t('toolCards.think.thinkingCharacters', { count: Array.from(content).length });
  }, [content, t]);

  const summaryPreview = useMemo(
    // Ordinary reasoning never displays this preview. Avoid splitting and
    // stripping its potentially large body on every streaming update.
    () => isSummary ? latestReasoningSummaryPreview(content) : '',
    [content, isSummary],
  );

  const headerLabel = isSummary
    ? (isExpanded
      ? t('toolCards.think.thinkingSummary')
      : summaryPreview || t('toolCards.think.thinkingSummary'))
    : (isExpanded
      ? (isActive ? t('toolCards.think.thinking') : t('toolCards.think.thinkingProcess'))
      : contentLengthText).replace(/ /g, '\u00A0');

  return (
    <ThinkingBlock
      hidden={hidden}
      ref={cardRootRef}
      data-tool-card-id={thinkingItem.id}
      status={status}
      streaming={isActive}
      visuallyStreaming={isVisuallyStreaming}
      expanded={isExpanded}
      collapseIntoNext={!isLastItem && !forceExpanded}
      scrollOwner="self"
      reasoningKind={thinkingItem.reasoningKind}
      context={displayContext}
      label={headerLabel}
      capsuleLabel={contentLengthText}
      onOpenDetails={() => {
        const root = cardRootRef.current;
        // A projected thought belongs to the child stream, while its visible
        // location belongs to the enclosing task in the left conversation.
        const location = displayContext === 'subagent-projection'
          ? root?.parentElement?.closest<HTMLElement>('[data-flow-item-id]')
          : root;
        openThinkingPanel({
          thinkingItem,
          sessionId: sourceSessionId ?? thinkingItem.subagentSessionId ?? sessionId,
          workspaceId,
          workspacePath,
          remoteConnectionId,
          navigationTarget: sessionId ? {
            sessionId,
            turnId: root?.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId,
            itemId: location?.dataset.flowItemId ?? thinkingItem.id,
          } : undefined,
          title: isSummary ? t('toolCards.think.thinkingSummary') : t('toolCards.think.thinkingProcess'),
        });
      }}
      contentRef={contentRef}
      expandContainerRef={expandContainerRef}
      mountContent={shouldMountContent}
      scrollState={scrollState}
      contentProps={contentProps}
    >
      <ThinkingMarkdownRenderer content={renderedContent} isStreaming={isVisuallyStreaming} className="thinking-markdown" />
    </ThinkingBlock>
  );
};
