import React, { useEffect, useMemo } from 'react';
import type { VirtualItem } from '../types/flow-chat-projection';
import { useI18n } from '@/infrastructure/i18n';
import { getFlowGroupCategory } from '../grouping/types';
import { FileEditGroupContext } from '../grouping/FileEditGroupContext';
import { getConcurrentCapsuleRows } from '../tool-cards/toolCapsuleLayout';
import { FlowGroupItemRenderer } from '../components/modern/FlowGroupRenderer';
import { useCreateTypewriterRevealGate } from '../hooks/typewriterRevealGateContext';
import { TypewriterRevealGateProvider } from '../hooks/TypewriterRevealGate';
import { useFlowChatReaderStore, useTimelineReveal } from './readerState';
import { useFlowChatContext } from '../components/modern/FlowChatContext';
import { getModelRoundItemClassName } from '../components/modern/modelRoundItemClassName';
import './TimelineContentBlock.scss';

const GroupMember: React.FC<React.HTMLAttributes<HTMLDivElement>> = props => <div {...props} />;

/** The same keyed renderer owns a leaf before, during and after collection. */
export function TimelineContentBlock({ item }: { item: Extract<VirtualItem, { type: 'model-round' }> }) {
  const { t, formatNumber } = useI18n('flow-chat');
  const block = item.timeline!;
  const group = block.group;
  const groupId = group?.groupId;
  const { activeSessionOverride } = useFlowChatContext();
  const reader = useFlowChatReaderStore();
  const gate = useCreateTypewriterRevealGate();
  useTimelineReveal(item.turnId, block.key, gate.isAnyRevealing);
  useEffect(() => {
    if (gate.isAnyRevealing && groupId) return reader?.holdGroup(groupId, `reveal:${block.key}`);
  }, [gate.isAnyRevealing, reader, groupId, block.key]);
  const parallel = useMemo(() => getConcurrentCapsuleRows(item.data.items), [item.data.items]);
  const revisions = useMemo(() => {
    if (!group || getFlowGroupCategory(group) !== 'file-edit') return undefined;
    return {
      revisionLabels: new Map(item.data.items.filter(member => member.type === 'tool')
        .map((member, index) => [member.id, t('fileEditGroup.revision', { count: formatNumber((block.memberOrdinal ?? 0) + index + 1) })])),
      // Each visible card owns its on-demand diff stats. The header separately
      // reads the same snapshot service; no invisible member card is mounted.
      diffStats: new Map(),
    };
  }, [group, item.data.items, block.memberOrdinal, t, formatNumber]);
  return <FileEditGroupContext.Provider value={revisions}>
    <TypewriterRevealGateProvider value={gate}>
      <div className={group ? 'explore-region explore-region--collapsible explore-region--expanded flowchat-timeline-members' : 'flowchat-timeline-content'}
        data-timeline-group-id={group?.groupId} data-group-first={block.first} data-group-last={block.last}>
        <div className={[group ? 'explore-region__content' : getModelRoundItemClassName({ isVisuallyStreaming: item.data.isStreaming || gate.isAnyRevealing }),
          block.layout === 'agent-cards' && 'flowchat-agent-card-grid'].filter(Boolean).join(' ')}
          data-agent-card-grid={block.layout === 'agent-cards' ? '' : undefined}
          data-flow-item-stack="" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="root"
          data-testid="chat-assistant-message" data-turn-id={item.turnId} data-round-id={item.data.id}
          data-status={item.data.status} data-openbitfun-status={item.data.status}
          data-model-config-id={item.data.modelConfigId || ''} data-effective-model-name={item.data.effectiveModelName || ''}
          data-streaming={item.data.isStreaming || gate.isAnyRevealing ? 'true' : 'false'}>
          {item.data.items.map((member, index) => <FlowGroupItemRenderer key={member.id} item={member}
            turnId={item.turnId} roundId={item.data.id} withinGroup={Boolean(group)} Item={GroupMember} capsuleRow={parallel.get(member.id)}
            isLastItem={(group ? group.isLastGroupInTurn && block.last : item.isLastRound) && index === item.data.items.length - 1}
            forceThinkingExpanded={activeSessionOverride?.sessionKind !== 'subagent' && (item.layoutHints?.expandedThinkingItemIds.includes(member.id) || block.revealThinkingIds?.includes(member.id))}
            revealStreamingContent={block.revealThinkingIds?.includes(member.id)}
            retainForGroupCollapse={group?.phase === 'settled'} />)}
        </div>
      </div>
    </TypewriterRevealGateProvider>
  </FileEditGroupContext.Provider>;
}
