/**
 * Model thinking display component.
 * Streaming reasoning shares one line with its icon; activation opens a
 * seven-line viewport. Completion folds that same viewport without enlarging
 * it; completed reasoning opens the details panel. History starts collapsed.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFlowChatReaderValue } from '../timeline/readerState';
import { ThinkingBlock } from '@openbitfun/ui/flow-chat';
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
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import './ModelThinkingDisplay.scss';

interface ModelThinkingDisplayProps {
  thinkingItem: FlowThinkingItem;
  /** Whether this is the last item in the current round. */
  isLastItem?: boolean;
  forceExpanded?: boolean;
  /** An explicit search match may reveal live content; automatic layout hints may not. */
  revealStreamingContent?: boolean;
  displayContext?: 'default' | 'subagent-projection';
  withinGroup?: boolean;
  /** Keep the outgoing body stable while an automatically completing group closes. */
  retainForGroupCollapse?: boolean;
  hidden?: boolean;
  /** Original session for reasoning projected into another conversation. */
  sourceSessionId?: string;
}

/** Model rounds are virtual rows. Keep reasoning in its source row while
 * resolving the first content of the next round, or the preceding card when
 * another reasoning block starts that round. The two controls then have
 * distinct hover owners instead of stacking beside the same answer. */
function resolveNextRoundContinuation(root: HTMLDivElement) {
  const stack = root.parentElement;
  if (!stack?.hasAttribute('data-flow-item-stack') || root.nextElementSibling) return null;
  const row = root.closest<HTMLElement>('.virtual-item-wrapper[data-item-type="model-round"]');
  const list = row?.parentElement;
  if (!row?.dataset.turnId || !list?.classList.contains('virtual-message-list__items')) return null;

  let peer = row.nextElementSibling as HTMLElement | null;
  while (peer?.matches('.virtual-item-wrapper[data-collected-empty="true"]')
    && peer.dataset.turnId === row.dataset.turnId) peer = peer.nextElementSibling as HTMLElement | null;

  const sameTurnRound = Boolean(peer?.matches('.virtual-item-wrapper[data-item-type="model-round"]')
    && peer?.dataset.turnId === row.dataset.turnId);
  // The desktop timeline adds a block wrapper around the source stack. Keep
  // legacy rounds and flattened leaves on the same continuation contract.
  const peerStack = sameTurnRound ? peer?.querySelector('[data-flow-item-stack]') : null;
  const first = peerStack?.hasAttribute('data-flow-item-stack') ? peerStack.firstElementChild : null;
  const previous = root.previousElementSibling;
  const previousCard = previous instanceof HTMLElement && previous.hasAttribute('data-thinking-continuation')
    ? previous : null;
  return {
    element: first instanceof HTMLElement && first.hasAttribute('data-thinking-continuation') ? first
      : first?.classList.contains('flow-thinking-item') ? previousCard : null,
    observeRoot: list,
    observeSubtree: sameTurnRound ? peer : null,
  };
}

export const ModelThinkingDisplay: React.FC<ModelThinkingDisplayProps> = ({
  thinkingItem,
  isLastItem = true,
  forceExpanded = false,
  revealStreamingContent: revealFromGroup = false,
  displayContext = 'default',
  retainForGroupCollapse = false,
  hidden,
  sourceSessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { sessionId, workspaceId, workspacePath, remoteConnectionId } = useFlowChatContext();
  // Search temporarily reveals the recorded source in place. Activating the
  // ordinary completed-thinking control opens its reader panel instead.
  const [navigationThinking] = useFlowChatReaderValue('navigation:thinking', '');
  const revealStreamingContent = revealFromGroup || navigationThinking === thinkingItem.id;
  const { content, isStreaming, status } = thinkingItem;
  const isSummary = thinkingItem.reasoningKind === 'summary';
  const isActive = isStreaming || status === 'streaming';
  const surface = getActiveSurfaceScope();
  const streamIdentity = JSON.stringify([
    surface.surfaceId, surface.epoch,
    sessionId, sourceSessionId, workspaceId, remoteConnectionId,
    thinkingItem.id, thinkingItem.attemptId, thinkingItem.attemptIndex,
  ]);
  const [retainedContent, setRetainedContent] = useState(() => ({
    identity: streamIdentity,
    mounted: (isActive && !isSummary) || forceExpanded || revealStreamingContent,
  }));
  const retainClosingContent = retainedContent.identity === streamIdentity && retainedContent.mounted;
  const [streamingChoice, setStreamingChoice] = useFlowChatReaderValue<string>(`thinking:${streamIdentity}:live`, 'auto');
  const [successor, setSuccessor] = useState<{ identity: string; ready: boolean; immediate: boolean; pending: boolean }>();
  const coordinateContinuation = !revealStreamingContent && (!forceExpanded || isActive);
  const successorReady = coordinateContinuation && successor?.identity === streamIdentity && successor.ready;
  const readerChoice = streamingChoice === 'auto' ? undefined : streamingChoice === 'open';
  // Compact previews yield as soon as real output exists. A reader who opened
  // seven lines can finish its reveal; attention states always take precedence.
  const yieldToSuccessor = successorReady && (!(readerChoice ?? revealStreamingContent) || successor.immediate);
  const lastPreview = useRef('');
  const expandContainerRef = useRef<HTMLDivElement>(null);
  const { displayText: displayContent, isRevealing } = useTypewriter(
    isSummary ? '' : content,
    isActive && !isSummary,
    // Keep playback through the closing transition, then release the reveal
    // gate and track current content without animating an invisible backlog.
    { revealImmediately: !retainClosingContent || yieldToSuccessor },
  );
  // Keep footer presentation behind the handoff as well. A parent-owned fold
  // must not wait for its own retained child to close (a circular reveal gate).
  useReportTypewriterReveal(thinkingItem.id, isRevealing
    || Boolean(successorReady && successor.pending && !retainForGroupCollapse));
  const { cardRootRef, dispatchToolCardToggle, applyExpandedState } = useToolCardHeightContract({
    toolId: thinkingItem.id,
    toolName: 'thinking',
  });
  const isVisuallyStreaming = !yieldToSuccessor && (isActive || isRevealing);
  useLayoutEffect(() => {
    if (!isVisuallyStreaming && streamingChoice !== 'auto') setStreamingChoice('auto');
  }, [isVisuallyStreaming, streamingChoice, setStreamingChoice]);
  const lastLiveIdentity = useRef<string>();
  useLayoutEffect(() => {
    if (isVisuallyStreaming) lastLiveIdentity.current = streamIdentity;
  }, [isVisuallyStreaming, streamIdentity]);
  // forceExpanded also comes from automatic trailing-item layout hints. Only a
  // reader action may turn the live one-line viewport into seven lines.
  const streamingViewportExpanded = isVisuallyStreaming && (readerChoice ?? revealStreamingContent);
  const previousExpanded = useRef({ identity: streamIdentity, expanded: retainClosingContent });
  const isContentExpanded = (forceExpanded && !yieldToSuccessor) || revealStreamingContent
    || (isVisuallyStreaming && (!isSummary || streamingViewportExpanded))
    || (retainForGroupCollapse && retainClosingContent
      && previousExpanded.current.identity === streamIdentity && previousExpanded.current.expanded);
  const shouldMountContent = isContentExpanded || retainClosingContent;
  useLayoutEffect(() => {
    if (previousExpanded.current.expanded !== isContentExpanded) dispatchToolCardToggle();
    previousExpanded.current = { identity: streamIdentity, expanded: isContentExpanded };
  }, [dispatchToolCardToggle, isContentExpanded, streamIdentity]);

  // Historical reasoning starts without inline Markdown. Retain a streamed or
  // forced body through its closing transition, then release it.
  useLayoutEffect(() => {
    if (isContentExpanded) {
      if (!retainClosingContent) setRetainedContent({ identity: streamIdentity, mounted: true });
      return;
    }
    if (!retainClosingContent) return;
    const transitions = expandContainerRef.current?.getAnimations?.().filter(animation => (
      'transitionProperty' in animation && ['grid-template-rows', 'opacity'].includes(String(animation.transitionProperty))
    )) ?? [];
    if (transitions.length === 0) {
      setRetainedContent({ identity: streamIdentity, mounted: false });
      return;
    }
    let cancelled = false;
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (!cancelled) setRetainedContent({ identity: streamIdentity, mounted: false });
    });
    return () => { cancelled = true; };
  }, [isContentExpanded, retainClosingContent, streamIdentity]);

  // Keep rendering the typewriter output while it drains after the stream
  // ends. Snapping to full `content` here would make the drain invisible
  // while `isRevealing` still holds the reveal gate, delaying the round
  // footer for no visible reason.
  const renderedContent = yieldToSuccessor && retainClosingContent ? lastPreview.current
    : !isSummary && isRevealing ? displayContent : content;
  useLayoutEffect(() => { if (!yieldToSuccessor) lastPreview.current = renderedContent; }, [renderedContent, yieldToSuccessor]);
  const previousStreamViewport = useRef({ identity: streamIdentity, expanded: false, active: false });
  const scrollViewportExpanded = isVisuallyStreaming ? streamingViewportExpanded
    : forceExpanded || revealStreamingContent || (retainForGroupCollapse
      && previousStreamViewport.current.identity === streamIdentity && previousStreamViewport.current.expanded);
  const { contentRef, contentProps, scrollState, resume } = useContainedTailFollow({
    // Compact output replaces its last typeset line without any scroll writer.
    // Only the expanded reading viewport follows the bounded inner tail.
    enabled: isContentExpanded && scrollViewportExpanded, active: isVisuallyStreaming, contentVersion: renderedContent,
    followOnOpen: !revealStreamingContent,
    onStep: step => {
      if (isTailFollowDiagnosticsEnabled()) noteTailFollowStep('thinking', step);
    },
  });
  useLayoutEffect(() => {
    const previous = previousStreamViewport.current;
    if (isVisuallyStreaming && streamingViewportExpanded && !revealStreamingContent
      && (!previous.expanded || !previous.active || previous.identity !== streamIdentity)) {
      resume();
    }
    previousStreamViewport.current = {
      identity: streamIdentity, active: isVisuallyStreaming,
      expanded: isVisuallyStreaming ? streamingViewportExpanded
        : previous.identity === streamIdentity && previous.expanded,
    };
  }, [isVisuallyStreaming, streamingViewportExpanded, revealStreamingContent, streamIdentity, resume]);

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
    ? (isContentExpanded
      ? t('toolCards.think.thinkingSummary')
      : summaryPreview || t('toolCards.think.thinkingSummary'))
    : (isContentExpanded
      ? (isVisuallyStreaming ? t('toolCards.think.thinking') : t('toolCards.think.thinkingProcess'))
      : contentLengthText).replace(/ /g, '\u00A0');

  return (
    <ThinkingBlock
      virtualized
      hidden={hidden}
      ref={cardRootRef}
      data-tool-card-id={thinkingItem.id}
      status={status}
      streaming={isActive}
      visuallyStreaming={isVisuallyStreaming}
      expanded={isContentExpanded}
      streamingExpanded={streamingViewportExpanded}
      retainStreamingViewport={retainForGroupCollapse}
      onStreamingExpandedChange={next => applyExpandedState(streamingViewportExpanded, next,
        expanded => setStreamingChoice(expanded ? 'open' : 'closed'))}
      collapseIntoNext={(!isLastItem || successorReady) && (!forceExpanded || isActive)}
      resolveContinuation={resolveNextRoundContinuation}
      coordinateContinuation={coordinateContinuation}
      handoffIdentity={streamIdentity}
      onContinuationReadyChange={(ready, immediate, pending) => setSuccessor(current => (
        current?.identity === streamIdentity && current.ready === ready && current.immediate === immediate && current.pending === pending
          ? current : { identity: streamIdentity, ready, immediate, pending }
      ))}
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
      <ThinkingMarkdownRenderer content={renderedContent} singleLinePreview
        isStreaming={isVisuallyStreaming || (retainClosingContent && lastLiveIdentity.current === streamIdentity
          && !forceExpanded && !revealStreamingContent)}
        className="thinking-markdown" />
    </ThinkingBlock>
  );
};
