/**
 * Virtual item renderer.
 * Renders user messages, model rounds, explore groups, or image-analyzing indicators by type.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { UserMessageItem } from './UserMessageItem';
import { ModelRoundItem } from './ModelRoundItem';
import { FlowGroupRenderer } from './FlowGroupRenderer';
import { AmbientToolCard, AmbientToolCardHeader } from '@openbitfun/ui/flow-chat';
import { useFlowChatVolatileContext } from './FlowChatContext';
import { TurnCompletionNoticeItem } from './TurnCompletionNoticeItem';
import { TurnFailureNoticeItem } from './TurnFailureNoticeItem';
import './VirtualItemRenderer.scss';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { useFlowChatSearchPresentation } from './useFlowChatSearchPresentation';
import { ConversationExcerptMarkers } from '../../selection/ConversationExcerptMarkers';
import { getKnownVirtualItemHeightPx } from './virtualItemHeightEstimators';
import { Icon } from '@openbitfun/ui';
import { TimelineContentBlock } from '../../timeline/TimelineContentBlock';
import { useTurnFooterInteraction } from './useTurnFooterInteraction';

interface VirtualItemRendererProps {
  item: VirtualItem;
  index: number;
  isLatestTurn?: boolean;
  /** Stable projection facts used for spacing across virtual-row boundaries. */
  endsBeforeUserTurn?: boolean;
  continuesAmbientToolRunAfter?: boolean;
  /**
   * Ref callback the virtualizer measures this item through.
   *
   * It reads `data-virtual-index` back off the element, so the attribute below
   * and this callback have to land on the same node.
   */
  measureRef?: (element: HTMLElement | null) => void;
}

export const VirtualItemRenderer = React.memo<VirtualItemRendererProps>(
  ({ item, index, isLatestTurn = false, endsBeforeUserTurn = false, continuesAmbientToolRunAfter = false, measureRef }) => {
    const turnInteraction = useTurnFooterInteraction(item.turnId);
    const { searchQuery, searchMatchesByVirtualIndex, searchCurrentMatch } = useFlowChatVolatileContext();
    const sourceIndex = item.timeline?.sourceIndex ?? index;
    const ownsMatch = (match: { flowItemId?: string }) => !item.timeline || !match.flowItemId || item.timeline.memberIds.includes(match.flowItemId);
    const matches = searchMatchesByVirtualIndex?.get(sourceIndex)?.filter(ownsMatch);
    const currentMatch = searchCurrentMatch?.virtualItemIndex === sourceIndex && ownsMatch(searchCurrentMatch) ? searchCurrentMatch : undefined;
    const isSearchMatch = Boolean(matches?.length);
    const isSearchCurrent = Boolean(currentMatch);
    const isCollectedEmpty = getKnownVirtualItemHeightPx(item) === 0;
    const [wrapper, setWrapper] = React.useState<HTMLDivElement | null>(null);
    const rowRef = React.useCallback((element: HTMLDivElement | null) => {
      setWrapper(element);
      measureRef?.(element);
    }, [measureRef]);
    const searchLine = useFlowChatSearchPresentation(wrapper, searchQuery, matches, currentMatch);

    const content = (() => {
      switch (item.type) {
        case 'user-message':
          return (
            <UserMessageItem
              message={item.data}
              turnId={item.turnId}
              absoluteTurnIndex={item.absoluteTurnIndex}
              turnStatus={item.turnStatus}
              submissionPhase={item.submissionPhase}
              submissionError={item.submissionError}
            />
          );

        case 'user-steering-message':
          return (
            <UserMessageItem
              message={item.data}
              turnId={item.turnId}
              steeringStatus={item.steeringStatus}
            />
          );
        
        case 'model-round':
          if (item.timeline?.kind === 'group-header') return <FlowGroupRenderer data={item.timeline.group!}
            turnId={item.turnId} placement="standalone" timelineExpanded={item.timeline.expanded} />;
          if (item.timeline?.kind === 'group-members' || item.timeline?.kind === 'content') return <TimelineContentBlock item={item} />;
          return (
            <ModelRoundItem 
              blockPart={item.timeline ? item.timeline.kind === 'round-header' ? 'header' : item.timeline.kind === 'round-footer' ? 'footer' : 'content' : undefined}
              round={item.data} 
              projectedGroups={item.projectedGroups}
              turnId={item.turnId} 
              isLastRound={item.isLastRound}
              isLatestTurn={isLatestTurn}
              isTurnComplete={item.isTurnComplete}
              turnStartedAt={item.turnStartedAt}
              turnEndedAt={item.turnEndedAt}
              turnDurationMs={item.turnDurationMs}
              turnTokenUsage={item.turnTokenUsage}
              canvasArtifactItems={item.canvasArtifactItems}
              expandedThinkingItemIds={item.layoutHints?.expandedThinkingItemIds ?? []}
            />
          );
        
        case 'explore-group':
          return (
            <FlowGroupRenderer
              data={item.data}
              turnId={item.turnId}
            />
          );

        case 'turn-completion-notice':
          return <TurnCompletionNoticeItem notice={item.data} />;

        case 'turn-failure-notice':
          return <TurnFailureNoticeItem error={item.data.error} errorDetail={item.data.errorDetail} />;

        case 'image-analyzing':
          return (
            <div data-openbitfun-component="virtual-item" data-openbitfun-part="imageAnalyzing" className="model-round-item model-round-item--streaming">
              <AmbientToolCard
                status="running"
                header={
                  <AmbientToolCardHeader
                    icon={<Icon glyph={Loader2} size="md" className="animate-spin" />}
                    content="Analyzing image with image understanding model..."
                  />
                }
              />
            </div>
          );

        default:
          return <div data-openbitfun-component="virtual-item" data-openbitfun-part="placeholder" style={{ minHeight: '1px' }} />;
      }
    })();
    
    // A4-like layout: wrap with a max-width container.
    // Keep the keyed wrapper; only collected rows with no visible content collapse to zero.
    // data-turn-id is used for long-image export.
    return (
      <div
        {...turnInteraction}
        ref={rowRef}
        data-openbitfun-component="virtual-item"
        data-openbitfun-part="root"
        data-openbitfun-state={[isSearchMatch && 'searchMatch', isSearchCurrent && 'searchCurrent'].filter(Boolean).join(' ')}
        className="virtual-item-wrapper"
        data-testid="flowchat-message-item"
        data-turn-id={item.turnId}
        data-item-type={item.type}
        data-timeline-kind={item.timeline?.kind}
        data-timeline-group-id={item.timeline?.group?.groupId}
        data-collected-empty={isCollectedEmpty ? 'true' : undefined}
        data-turn-boundary-after={endsBeforeUserTurn ? 'true' : undefined}
        data-ambient-tool-run-continuation-after={continuesAmbientToolRunAfter ? 'true' : undefined}
        data-virtual-item-key={getVirtualItemStableKey(item)}
        data-virtual-index={index}
        data-item-index={index}
      >
        {content || <div style={{ minHeight: '1px' }} />}
        <ConversationExcerptMarkers wrapper={wrapper} turnId={item.turnId} />
        <span
          aria-hidden="true"
          hidden={!searchLine}
          className="flowchat-search-line"
          data-openbitfun-component="virtual-item"
          data-openbitfun-part="searchLine"
          style={searchLine ?? undefined}
        />
      </div>
    );
  },
  (prev, next) => (
    prev.item === next.item &&
    prev.index === next.index &&
    prev.isLatestTurn === next.isLatestTurn &&
    prev.endsBeforeUserTurn === next.endsBeforeUserTurn &&
    prev.continuesAmbientToolRunAfter === next.continuesAmbientToolRunAfter &&
    prev.measureRef === next.measureRef
  )
);
VirtualItemRenderer.displayName = 'VirtualItemRenderer';
