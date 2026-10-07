import { describe, expect, it } from 'vitest';
import {
  estimateTextHeightFromLength,
  describeVirtualItemEstimate,
  estimateVirtualMessageItemHeightWithContext,
  estimateVirtualMessageItemHeight,
  getVirtualMessageDefaultItemHeight,
  selectInitialHistoryRenderWindow,
} from './virtualMessageListLayout';
import { estimateFlowGroupHeight, estimateToolHeight } from './virtualItemHeightEstimators';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowThinkingItem, FlowToolItem } from '../../types/flow-chat';
import type { FlowGroupBase } from '../../grouping/types';

describe('getVirtualMessageDefaultItemHeight', () => {
  it('keeps compact historical projections on the small row estimate', () => {
    expect(getVirtualMessageDefaultItemHeight({
      isHistorical: false,
      hasCompactHistoricalProjection: true,
      hasInitialHistoryModelRoundProjection: true,
    })).toBe(72);
  });

  it('uses a taller initial estimate for partial historical model rounds', () => {
    expect(getVirtualMessageDefaultItemHeight({
      isHistorical: false,
      hasCompactHistoricalProjection: false,
      hasInitialHistoryModelRoundProjection: true,
    })).toBeGreaterThan(200);
  });

  it('prioritizes the taller estimate when a historical initial projection contains model rounds', () => {
    expect(getVirtualMessageDefaultItemHeight({
      isHistorical: true,
      hasCompactHistoricalProjection: false,
      hasInitialHistoryModelRoundProjection: true,
    })).toBeGreaterThan(200);
  });

  it('keeps live sessions on the legacy estimate', () => {
    expect(getVirtualMessageDefaultItemHeight({
      isHistorical: false,
      hasCompactHistoricalProjection: false,
      hasInitialHistoryModelRoundProjection: false,
    })).toBe(200);
  });
});

describe('estimateVirtualMessageItemHeight', () => {
  it('estimates text height directly from length', () => {
    expect(estimateTextHeightFromLength(0, 72, 30)).toBe(102);
    expect(estimateTextHeightFromLength(60, 72, 30)).toBe(102);
    expect(estimateTextHeightFromLength(61, 72, 30)).toBe(132);
  });

  it('uses content-aware estimates for large historical model rounds', () => {
    const item = {
      type: 'model-round',
      turnId: 'turn-1',
      isLastRound: true,
      isTurnComplete: true,
      data: {
        id: 'round-1',
        status: 'completed',
        isStreaming: false,
        items: [{
          id: 'text-1',
          type: 'text',
          content: 'x'.repeat(3600),
          status: 'completed',
          timestamp: 1,
        }],
      },
    } as VirtualItem;

    expect(estimateVirtualMessageItemHeight(item)).toBeGreaterThan(1000);
  });

  it('uses the shared collapsed hint for completed thinking rounds', () => {
    const item = {
      type: 'model-round',
      turnId: 'turn-1',
      isLastRound: false,
      isTurnComplete: true,
      layoutHints: { expandedThinkingItemIds: [] },
      data: {
        id: 'round-thinking',
        status: 'completed',
        isStreaming: false,
        items: [{
          id: 'thinking-1',
          type: 'thinking',
          content: 'x'.repeat(13_016),
          status: 'completed',
          timestamp: 1,
        }],
      },
    } as VirtualItem;

    expect(estimateVirtualMessageItemHeight(item)).toBe(200);

    expect(estimateVirtualMessageItemHeight({
      ...item,
      layoutHints: { expandedThinkingItemIds: ['thinking-1'] },
    })).toBeGreaterThan(1000);
  });

  it('keeps compact user-only rows small enough for partial history tails', () => {
    const item = {
      type: 'user-message',
      turnId: 'turn-1',
      data: {
        id: 'user-1',
        content: 'short prompt',
        timestamp: 1,
      },
    } as VirtualItem;

    expect(estimateVirtualMessageItemHeight(item)).toBeLessThanOrEqual(160);
  });

  it('estimates collapsed exploration within a mixed round from its disclosure state', () => {
    const item = {
      type: 'model-round', turnId: 'turn', isLastRound: true, isTurnComplete: true,
      data: {
        id: 'mixed', status: 'completed', isStreaming: false,
        items: [
          { id: 'intro', type: 'text', content: 'Inspecting', status: 'completed', timestamp: 1 },
          ...Array.from({ length: 120 }, (_, index) => ({
            id: `search-${index}`, type: 'tool', toolName: 'Grep', status: 'completed', timestamp: index + 2,
            toolCall: { id: `search-${index}`, input: {} },
          })),
        ],
      },
    } as VirtualItem;
    const collapsed = estimateVirtualMessageItemHeightWithContext(item);
    const expanded = estimateVirtualMessageItemHeightWithContext(item, {
      exploreGroupStates: new Map([['mixed:explore:search-0', true]]),
    });
    expect(expanded).toBeGreaterThan(collapsed);
    expect(expanded).toBeGreaterThan(3600);
    expect(collapsed).toBeLessThan(300);
  });

  it('uses tool-owned data to distinguish compact and expanded Write estimates', () => {
    const tool = {
      id: 'write-1',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      timestamp: 1,
      toolCall: {
        id: 'call-1',
        input: { content: 'x'.repeat(600) },
      },
    } as FlowToolItem;

    const completed = estimateToolHeight(tool);
    const running = estimateToolHeight({
      ...tool,
      status: 'running',
    } as FlowToolItem);

    expect(completed.heightPx).toBeLessThan(running.heightPx);
    expect(running.kind).toBe('tool-write');
  });

  it('uses layout width and explicit Explore state for unmeasured rows', () => {
    const textItem = {
      type: 'model-round',
      turnId: 'turn-1',
      isLastRound: true,
      isTurnComplete: true,
      data: {
        id: 'round-width',
        status: 'completed',
        isStreaming: false,
        items: [{
          id: 'text-width',
          type: 'text',
          content: 'x'.repeat(600),
          status: 'completed',
          timestamp: 1,
        }],
      },
    } as VirtualItem;
    expect(estimateVirtualMessageItemHeightWithContext(textItem, { availableWidthPx: 360 }))
      .toBeGreaterThan(estimateVirtualMessageItemHeightWithContext(textItem, { availableWidthPx: 1200 }));

    const exploreItem = {
      type: 'explore-group',
      turnId: 'turn-1',
      data: {
        groupId: 'group-1',
        allItems: [{
          id: 'tool-1',
          type: 'tool',
          toolName: 'Write',
          status: 'running',
          timestamp: 1,
          toolCall: { id: 'call-1', input: { content: 'x'.repeat(300) } },
        }],
        stats: { readCount: 0, searchCount: 0, commandCount: 0 },
        rounds: [],
        isGroupStreaming: false,
        isLastGroupInTurn: true,
        wasCutByCritical: false,
      },
    } as VirtualItem;
    const collapsed = estimateVirtualMessageItemHeightWithContext(exploreItem, {
      exploreGroupStates: new Map([['group-1', false]]),
    });
    const defaultHeight = estimateVirtualMessageItemHeightWithContext(exploreItem);
    const expanded = estimateVirtualMessageItemHeightWithContext(exploreItem, {
      exploreGroupStates: new Map([['group-1', true]]),
    });
    expect(describeVirtualItemEstimate(exploreItem)).toMatchObject({ defaultExpanded: false });
    expect(defaultHeight).toBe(collapsed);
    expect(expanded).toBeGreaterThan(collapsed);
  });
});

it('keeps live thinking estimates compact regardless of content length', () => {
  const read: FlowToolItem = { id: 'read', type: 'tool', toolName: 'Read', status: 'completed',
    timestamp: 1, toolCall: { id: 'read', input: {} } };
  const thinking: FlowThinkingItem = { id: 'thought', type: 'thinking', content: 'Checking the result.',
    timestamp: 1, status: 'streaming', isStreaming: true, isCollapsed: false };
  const data: FlowGroupBase = { groupId: 'group', rounds: [], allItems: [read, thinking],
    phase: 'collecting', isGroupStreaming: true, isLastGroupInTurn: true, wasCutByCritical: false };
  const short = estimateFlowGroupHeight(data).heightPx;
  const long = estimateFlowGroupHeight({ ...data, allItems: [read, { ...thinking, content: 'x'.repeat(5000) } as FlowThinkingItem] }).heightPx;
  const longer = estimateFlowGroupHeight({ ...data, allItems: [read, { ...thinking, content: 'x'.repeat(10000) } as FlowThinkingItem] }).heightPx;
  const closed = estimateFlowGroupHeight(data, { groupStates: new Map([['group', false]]) }).heightPx;
  expect(short).toBeGreaterThan(closed);
  expect(short).toBe(long);
  expect(longer).toBe(long);
  expect(estimateFlowGroupHeight(data, { expandedThinkingItemIds: [thinking.id] }).heightPx).toBe(short);
  const completed: FlowThinkingItem = { ...thinking, content: 'x'.repeat(5000), status: 'completed', isStreaming: false };
  const settledContent = { ...data, allItems: [read, completed] };
  expect(estimateFlowGroupHeight(settledContent).heightPx).toBe(short);
  expect(estimateFlowGroupHeight(settledContent, { expandedThinkingItemIds: [thinking.id] }).heightPx).toBeGreaterThan(long);
});

describe('selectInitialHistoryRenderWindow', () => {
  function userItem(turnIndex: number): VirtualItem {
    const id = `turn-${turnIndex}`;
    return {
      type: 'user-message',
      turnId: id,
      data: {
        id: `user-${id}`,
        content: `prompt ${turnIndex}`,
        timestamp: turnIndex,
      },
    } as VirtualItem;
  }

  function modelItem(turnIndex: number, textLength = 2000): VirtualItem {
    const id = `turn-${turnIndex}`;
    return {
      type: 'model-round',
      turnId: id,
      isLastRound: turnIndex === 7,
      isTurnComplete: true,
      data: {
        id: `round-${id}`,
        status: 'completed',
        isStreaming: false,
        items: [{
          id: `text-${id}`,
          type: 'text',
          content: 'x'.repeat(textLength),
          status: 'completed',
          timestamp: turnIndex,
        }],
      },
    } as VirtualItem;
  }

  function exploreItem(turnIndex: number): VirtualItem {
    const id = `turn-${turnIndex}`;
    return {
      type: 'explore-group',
      turnId: id,
      data: {
        allItems: [{ id: `explore-${id}`, label: `Explore ${turnIndex}` }],
        timestamp: turnIndex,
      },
    } as VirtualItem;
  }

  it('keeps only the latest render window on large partial history tails', () => {
    const items = Array.from({ length: 8 }, (_, index) => [
      userItem(index),
      modelItem(index),
    ]).flat();

    const window = selectInitialHistoryRenderWindow(items);

    expect(window.startIndex).toBeGreaterThan(0);
    expect(window.items.length).toBeLessThan(items.length);
    expect(window.items[0]?.turnId).toBe('turn-6');
    expect(window.items.at(-1)?.turnId).toBe('turn-7');
    expect(window.omittedEstimatedHeightPx).toBeGreaterThan(0);
  });

  it('keeps an extra previous turn when the latest turn is user-only', () => {
    const items = [
      ...Array.from({ length: 7 }, (_, index) => [
        userItem(index),
        exploreItem(index),
        modelItem(index),
      ]).flat(),
      userItem(7),
    ];

    const window = selectInitialHistoryRenderWindow(items);
    const renderedTurnIds = Array.from(new Set(window.items.map(item => item.turnId)));

    expect(renderedTurnIds).toEqual(['turn-5', 'turn-6', 'turn-7']);
    expect(window.items[0]?.turnId).toBe('turn-5');
    expect(window.omittedEstimatedHeightPx).toBeGreaterThan(0);
  });

  it('keeps all items when the partial history tail is already small', () => {
    const items = [userItem(0), modelItem(0), userItem(1), modelItem(1)];

    const window = selectInitialHistoryRenderWindow(items);

    expect(window.startIndex).toBe(0);
    expect(window.items).toHaveLength(items.length);
    expect(window.omittedEstimatedHeightPx).toBe(0);
  });
});
