import { useMemo, useSyncExternalStore } from 'react';
import { Button, ScrollArea } from '@openbitfun/ui';
import { useContainedTailFollow } from '@openbitfun/flow-chat-presentation/scroll';
import { useI18n } from '@/infrastructure/i18n';
import { ThinkingMarkdownRenderer } from '@/infrastructure/markdown';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import { FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest } from '../events/flowchatNavigation';
import { flowChatStore } from '../store/FlowChatStore';
import type { FlowChatState, FlowThinkingItem, Session } from '../types/flow-chat';
import type { ThinkingDetailPanelData } from '../services/openThinkingPanel';
import '../tool-cards/ModelThinkingDisplay.scss';

function findThinkingItem(turns: Session['dialogTurns'], itemId: string): FlowThinkingItem | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const rounds = turns[turnIndex].modelRounds;
    for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = rounds[roundIndex];
      const current = round.items.find(item => item.type === 'thinking' && item.id === itemId);
      if (current) return current as FlowThinkingItem;
      for (const attempt of round.attempts ?? []) {
        const previous = attempt.items.find(item => item.type === 'thinking' && item.id === itemId);
        if (previous) return previous as FlowThinkingItem;
      }
    }
  }
  return undefined;
}

/** The reader outlives its virtualized chat row and observes only its original source. */
export function ThinkingDetailPanel({ data }: { data: ThinkingDetailPanelData }) {
  const { t } = useI18n('flow-chat');
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const source = useMemo(() => {
    let snapshot = data.thinkingItem;
    let previousTurns: Session['dialogTurns'] | undefined;
    const select = (state: FlowChatState) => {
      if (!surface.isCurrent() || surface.surfaceId !== data.surfaceId) return undefined;
      const turns = data.sessionId ? state.sessions.get(data.sessionId)?.dialogTurns : undefined;
      if (turns !== previousTurns) {
        // Keep the latest text when history pages leave memory; never switch to
        // the active session or device just because the source is unavailable.
        snapshot = (turns && findThinkingItem(turns, data.thinkingItem.id)) ?? snapshot;
        previousTurns = turns;
      }
      return snapshot;
    };
    return {
      getSnapshot: () => select(flowChatStore.getState()),
      subscribe: (notify: () => void) => flowChatStore.subscribeSelector(select, notify),
    };
  }, [data, surface]);
  const item = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const isStreaming = Boolean(item && (item.isStreaming || item.status === 'streaming'));
  const { contentRef, contentProps } = useContainedTailFollow({
    enabled: Boolean(item), active: isStreaming, contentVersion: item?.content ?? '',
    followOnOpen: false,
  });

  return <div
    className="thinking-details-panel"
    data-openbitfun-component="model-thinking-display"
    data-openbitfun-part="details"
    data-openbitfun-state={isStreaming ? 'streaming' : undefined}
    data-testid="thinking-details-panel"
    role="region"
    aria-label={item?.reasoningKind === 'summary' ? t('toolCards.think.thinkingSummary') : t('toolCards.think.thinkingProcess')}
  >
    <div className="thinking-details-panel__actions"
      data-openbitfun-component="model-thinking-display" data-openbitfun-part="detailsActions">
      <Button size="sm" variant="outline" disabled={!item || !data.navigationTarget}
        onClick={() => {
          if (!surface.isCurrent() || surface.surfaceId !== data.surfaceId || !data.navigationTarget) return;
          void globalEventBus.emit<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, {
            ...data.navigationTarget, surfaceEpoch: surface.epoch,
          });
        }}>
        {t('selection.locate')}
      </Button>
    </div>
    <ScrollArea {...contentProps} ref={contentRef} className="thinking-details-panel__viewport" tabIndex={0}>
      {item && <ThinkingMarkdownRenderer
        content={item.content}
        isStreaming={isStreaming}
        workspaceId={data.workspaceId}
        basePath={data.workspacePath}
        remoteConnectionId={data.remoteConnectionId}
        className="thinking-details-markdown"
      />}
    </ScrollArea>
  </div>;
}
