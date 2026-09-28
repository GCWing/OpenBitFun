/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Product adapter for every collection category, in whole-round or inline placement.
 */

import { FlowGroup, type FlowGroupProps } from '@openbitfun/ui/flow-chat';
import { Icon } from '@openbitfun/ui';
import React, { useMemo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DeferredContent } from '@openbitfun/flow-chat-presentation/deferred-content';

import { useI18n } from '@/infrastructure/i18n';
import type { FlowItem, FlowToolItem, FlowTextItem, FlowThinkingItem, ToolRejectOptions } from '../../types/flow-chat';
import { getFlowGroupCategory, getFlowGroupDisclosureChoice, isFlowGroupExpanded, type FlowGroupCategory, type FlowGroupData } from '../../grouping/types';
import { TypewriterRevealGateProvider } from '../../hooks/TypewriterRevealGate';
import { useCreateTypewriterRevealGate, useTypewriterRevealGate } from '../../hooks/typewriterRevealGateContext';
import { flowGroupPolicies } from '../../grouping/policies';
import { isFlowGroupMemberActive } from '../../grouping/lifecycle';
import { filterFlowGroupItems, flowGroupToolCounts, flowGroupToolLabels, type FlowGroupStatusFilter } from '../../grouping/browse';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { useToolCardHeightContract } from '../../tool-cards/useToolCardHeightContract';
import { isFlowItemVisible } from '../../utils/flowItemVisibility';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { toolCapsuleStateKey } from '../../tool-cards/toolCapsuleModel';
import { isToolCapsule } from '../../tool-cards/toolCardMetadata';
import { getConcurrentCapsuleRows, type ConcurrentCapsuleRow } from '../../tool-cards/toolCapsuleLayout';
import { useFlowChatContext, useFlowChatVolatileContext } from './FlowChatContext';
import { buildFlowGroupRenderSegments, estimateFlowGroupItemsHeight } from './flowGroupRenderSegments';
import './ExploreRegion.scss';

export interface FlowGroupRendererProps {
  data: FlowGroupData;
  turnId: string;
  expandedThinkingItemIds?: readonly string[];
  placement?: 'standalone' | 'inline';
}

interface FlowGroupView {
  render: (props: FlowGroupProps & React.RefAttributes<HTMLDivElement>) => React.ReactNode;
  Item: React.ComponentType<React.HTMLAttributes<HTMLDivElement>>;
}

// Semantic adapters keep installed Appearance identities explicit. All use the
// same public anatomy; adding a category does not fork disclosure or motion.
// The legacy explore identity now owns every exploration/execution collection.
const flowGroupViews = {
  explore: {
    render: props => <FlowGroup {...props} leading={<Icon name="route" size="sm" />}
      data-openbitfun-component="explore-group" data-openbitfun-part="root" data-testid="chat-explore-group" />,
    Item: props => <div {...props} data-openbitfun-component="explore-group" data-openbitfun-part="item" />,
  },
  context: {
    render: props => <FlowGroup {...props} leading={<Icon name="layers-plus" size="sm" />}
      data-openbitfun-component="context-load-group" data-openbitfun-part="root" data-testid="chat-context-load-group" />,
    Item: props => <div {...props} data-openbitfun-component="context-load-group" data-openbitfun-part="item" />,
  },
  interface: {
    render: props => <FlowGroup {...props} leading={<Icon name="scan-eye" size="sm" />}
      data-openbitfun-component="interface-observation-group" data-openbitfun-part="root" data-testid="chat-interface-observation-group" />,
    Item: props => <div {...props} data-openbitfun-component="interface-observation-group" data-openbitfun-part="item" />,
  },
} satisfies Record<FlowGroupCategory, FlowGroupView>;

export const FlowGroupRenderer: React.FC<FlowGroupRendererProps> = React.memo(({
  data,
  turnId,
  expandedThinkingItemIds,
  placement,
}) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const category = getFlowGroupCategory(data);
  const policy = flowGroupPolicies[category];
  const view = flowGroupViews[category];

  const {
    onGroupToggle,
    onExploreGroupToggle,
    onCollapseGroup,
    onExpandGroup,
    sessionId,
  } = useFlowChatContext();
  const { groupStates, exploreGroupStates, expandedToolCapsules, groupReceiveFeedback, pendingPermissionToolCallIds } = useFlowChatVolatileContext();

  const {
    groupId,
    allItems: recordedItems,
    isGroupStreaming,
    isLastGroupInTurn,
  } = data;
  const revealGate = useCreateTypewriterRevealGate();
  const parentRevealGate = useTypewriterRevealGate();
  const reportParent = parentRevealGate?.report;
  const reportLocal = revealGate.report;
  const report = useCallback((key: string, revealing: boolean) => {
    reportLocal(key, revealing);
    reportParent?.(key, revealing);
  }, [reportLocal, reportParent]);
  const groupRevealGate = useMemo(() => ({ ...revealGate, report }), [revealGate, report]);
  const allItems = useMemo(() => recordedItems.filter(isFlowItemVisible), [recordedItems]);
  const parallelRows = useMemo(() => getConcurrentCapsuleRows(allItems), [allItems]);
  const renderSegments = useMemo(() => buildFlowGroupRenderSegments(allItems), [allItems]);
  const toolItemCount = useMemo(() => allItems.filter(item => item.type === 'tool').length, [allItems]);
  const [query, setQuery] = useState('');
  const [toolFilter, setToolFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<FlowGroupStatusFilter>('all');
  const deferredQuery = useDeferredValue(query);
  const toolLabels = useMemo(() => flowGroupToolLabels(t), [t]);
  const toolCounts = useMemo(() => flowGroupToolCounts(allItems), [allItems]);
  const browse = useMemo(() => filterFlowGroupItems(allItems,
    { tool: toolFilter, status: statusFilter, query: deferredQuery }, toolLabels, pendingPermissionToolCallIds),
  [allItems, toolFilter, statusFilter, deferredQuery, toolLabels, pendingPermissionToolCallIds]);
  const browsing = browse.filtering || Boolean(query.trim());
  const {
    cardRootRef,
    dispatchToolCardToggle,
  } = useToolCardHeightContract({
    toolId: groupId,
    toolName: policy.component,
  });

  const disclosureChoice = getFlowGroupDisclosureChoice(data, groupStates ?? exploreGroupStates);
  const defaultExpanded = isFlowGroupExpanded(data, groupStates ?? exploreGroupStates);
  // Collection preserves the reader's explicit disclosure choice.
  const hasOpenCapsule = allItems.some(item => item.type === 'tool'
    && isToolCapsule(getEffectiveToolName(item as FlowToolItem))
    && expandedToolCapsules?.has(toolCapsuleStateKey(sessionId, turnId, item.id)));
  const hasPendingPermission = allItems.some(item => item.type === 'tool'
    && pendingPermissionToolCallIds?.has((item as FlowToolItem).toolCall.id));
  const isExpanded = hasOpenCapsule || hasPendingPermission || defaultExpanded
    || (disclosureChoice === undefined && revealGate.isAnyRevealing);
  const previousExpanded = useRef(isExpanded);
  useLayoutEffect(() => {
    if (previousExpanded.current !== isExpanded) dispatchToolCardToggle();
    previousExpanded.current = isExpanded;
  }, [dispatchToolCardToggle, isExpanded]);
  useEffect(() => {
    if (hasOpenCapsule && disclosureChoice !== true) onExpandGroup?.(groupId);
  }, [disclosureChoice, groupId, hasOpenCapsule, onExpandGroup]);
  const summaryPresentation = useMemo(
    () => policy.summarize(allItems, t, formatNumber),
    [policy, allItems, t, formatNumber],
  );

  const handleExpandedChange = useCallback((nextExpanded: boolean) => {
    if (nextExpanded) (onExpandGroup ?? onGroupToggle ?? onExploreGroupToggle)?.(groupId);
    else (onCollapseGroup ?? onGroupToggle ?? onExploreGroupToggle)?.(groupId);
  }, [groupId, onCollapseGroup, onExpandGroup, onGroupToggle, onExploreGroupToggle]);

  const resetFilters = useCallback(() => {
    setQuery(''); setToolFilter('all'); setStatusFilter('all');
  }, []);
  const revealItem = useCallback((itemId: string) => {
    if (browse.visibleIds.has(itemId)) return false;
    resetFilters();
    return true;
  }, [browse.visibleIds, resetFilters]);

  if (allItems.length === 0) return null;

  const groupProps = {
    ref: cardRootRef, placement, 'data-tool-card-id': groupId, expanded: isExpanded,
    streaming: isGroupStreaming, itemCount: toolItemCount,
    'data-flow-group-phase': data.phase,
    ...summaryPresentation, ...policy.attributes(allItems), onExpandedChange: handleExpandedChange,
    // The transcript owns scrolling; individual completions do not close or pulse the group.
    receiveFeedback: data.phase === undefined ? groupReceiveFeedback?.get(groupId) : undefined,
    browser: {
      query, onQueryChange: setQuery,
      searchLabel: t('groupBrowser.search'), clearSearchLabel: t('groupBrowser.clearSearch'),
      filterLabel: t('groupBrowser.filters'),
      tools: { label: t('groupBrowser.toolsLabel'), value: toolFilter,
        options: [{ value: 'all', label: t('groupBrowser.allTools'), count: formatNumber(toolItemCount) },
          ...toolCounts.map(({ name, count }) => ({ value: name, label: toolLabels.get(name) ?? name, count: formatNumber(count) }))],
        onValueChange: setToolFilter },
      status: { label: t('groupBrowser.statusLabel'), value: statusFilter,
        options: [{ value: 'all', label: t('groupBrowser.allStatuses') },
          { value: 'active', label: t('groupBrowser.active') }, { value: 'attention', label: t('groupBrowser.attention') }],
        onValueChange: (value: string) => setStatusFilter(value as FlowGroupStatusFilter) },
      resultLabel: t('groupBrowser.matches', { count: formatNumber(browse.matchingCount) }),
      notice: browse.pinnedCount ? t('groupBrowser.pinned', { count: formatNumber(browse.pinnedCount) }) : undefined,
      filtering: browsing, pending: query !== deferredQuery, empty: browse.visibleIds.size === 0,
      emptyLabel: t('groupBrowser.empty'), resetLabel: t('groupBrowser.reset'),
      onReset: resetFilters,
    },
  };
  const renderItem = (item: FlowItem, idx: number) => (
    <FlowGroupItemRenderer
      key={item.id}
      item={item}
      capsuleRow={parallelRows.get(item.id)}
      turnId={turnId}
      isLastItem={isLastGroupInTurn && idx === allItems.length - 1}
      hidden={!browse.visibleIds.has(item.id)}
      forceThinkingExpanded={expandedThinkingItemIds?.includes(item.id) || browse.matchingThinkingIds.has(item.id)}
      Item={view.Item}
    />
  );
  const startAtTail = !browsing && disclosureChoice !== true && (data.phase === 'collecting' || data.phase === 'settling' || isGroupStreaming);
  const visibleSegments = renderSegments.filter(segment => segment.items.some(item => browse.visibleIds.has(item.id)));
  const initialSegments = new Set((startAtTail ? visibleSegments.slice(-2) : visibleSegments.slice(0, 2)).map(segment => segment.key));
  const segments = renderSegments.map(segment => ({
    ...segment,
    memberIds: segment.items.map(item => item.id),
    estimatedHeightPx: browse.filtering
      ? estimateFlowGroupItemsHeight(segment.items.filter(item => browse.visibleIds.has(item.id))) : segment.estimatedHeightPx,
    hidden: !segment.items.some(item => browse.visibleIds.has(item.id)),
    eager: initialSegments.has(segment.key)
      || segment.items.some(item => browse.visibleIds.has(item.id) && (isFlowGroupMemberActive(item)
        || expandedThinkingItemIds?.includes(item.id)
        || (item.type === 'tool' && (pendingPermissionToolCallIds?.has((item as FlowToolItem).toolCall.id)
          || (isToolCapsule(getEffectiveToolName(item as FlowToolItem))
            && expandedToolCapsules?.has(toolCapsuleStateKey(sessionId, turnId, item.id))))))),
    render: () => segment.items.map((item, offset) => renderItem(item, segment.startIndex + offset)),
  }));
  return view.render({ ...groupProps, children: <TypewriterRevealGateProvider value={groupRevealGate}>
    <DeferredContent segments={segments} segmentClassName="flow-group-content-segment"
      onRevealItem={revealItem}
      label={summaryPresentation.summaryDescription ?? summaryPresentation.summary} />
  </TypewriterRevealGateProvider> });
});

/**
 * Native card rendering inside a collection.
 * Uses React.memo to avoid unnecessary re-renders.
 */
interface FlowGroupItemRendererProps {
  item: FlowItem;
  turnId: string;
  isLastItem?: boolean;
  forceThinkingExpanded?: boolean;
  hidden?: boolean;
  capsuleRow?: ConcurrentCapsuleRow;
  Item: FlowGroupView['Item'];
}

const FlowGroupItemRenderer = React.memo<FlowGroupItemRendererProps>(({ item, turnId, isLastItem, forceThinkingExpanded, hidden, capsuleRow, Item }) => {
  const {
    onToolConfirm,
    onToolReject,
    onFileViewRequest,
    onTabOpen,
    sessionId,
  } = useFlowChatContext();

  const handleConfirm = useCallback(async (toolId: string, permissionOptionId?: string, approve?: boolean) => {
    if (onToolConfirm) {
      await onToolConfirm(toolId, permissionOptionId, approve);
    }
  }, [onToolConfirm]);

  const handleReject = useCallback(async (toolId: string, options?: ToolRejectOptions) => {
    if (onToolReject) {
      await onToolReject(toolId, options);
    }
  }, [onToolReject]);

  const handleOpenInEditor = useCallback((filePath: string) => {
    if (onFileViewRequest) {
      onFileViewRequest(filePath, filePath.split(/[/\\]/).pop() || filePath);
    }
  }, [onFileViewRequest]);

  const handleOpenInPanel = useCallback((_panelType: string, data: any) => {
    if (onTabOpen) {
      onTabOpen(data, sessionId);
    }
  }, [onTabOpen, sessionId]);

  switch (item.type) {
    case 'text':
      return (
        <FlowTextBlock
          textItem={item as FlowTextItem}
          hidden={hidden}
        />
      );

    case 'thinking': {
      const thinkingItem = item as FlowThinkingItem;
      return (
        <ModelThinkingDisplay thinkingItem={thinkingItem} hidden={hidden} withinGroup isLastItem={isLastItem} forceExpanded={forceThinkingExpanded} />
      );
    }

    case 'tool':
      return (
        <>
          <Item hidden={hidden} className="flowchat-flow-item" data-thinking-continuation="" data-flow-item-id={item.id} data-flow-item-type="tool">
            <FlowToolCard
              toolItem={item as FlowToolItem}
              parallel={capsuleRow !== undefined}
              isLastItem={isLastItem}
              onConfirm={handleConfirm}
              onReject={handleReject}
              onOpenInEditor={handleOpenInEditor}
              onOpenInPanel={handleOpenInPanel}
              sessionId={sessionId}
              turnId={turnId}
            />
          </Item>
          {capsuleRow === 'end' && <span hidden={hidden} aria-hidden="true" className="flowchat-capsule-row-break" />}
        </>
      );

    default:
      return null;
  }
});

FlowGroupRenderer.displayName = 'FlowGroupRenderer';
