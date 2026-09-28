// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import {
  buildFlowChatSearchMatches,
  useFlowChatSearch,
  type UseFlowChatSearchReturn,
} from './useFlowChatSearch';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function searchableItems(count: number): VirtualItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'user-message',
    turnId: `turn-${index}`,
    data: {
      id: `message-${index}`,
      content: `needle ${index}`,
    },
  })) as VirtualItem[];
}

function SearchHarness({
  items,
  onController,
}: {
  items: VirtualItem[];
  onController: (controller: UseFlowChatSearchReturn) => void;
}) {
  onController(useFlowChatSearch(items));
  return null;
}

describe('buildFlowChatSearchMatches', () => {
  it('keeps the concrete model text source used for exact navigation', () => {
    const virtualItems = [{
      type: 'model-round',
      turnId: 'turn-1',
      isLastRound: true,
      isTurnComplete: true,
      data: {
        id: 'round-1',
        items: [
          { id: 'text-1', type: 'text', content: 'unrelated' },
          { id: 'text-2', type: 'text', content: 'The precise keyword is here.' },
        ],
      },
    }] as VirtualItem[];

    expect(buildFlowChatSearchMatches(virtualItems, 'KEYWORD')).toEqual([{
      virtualItemIndex: 0,
      turnId: 'turn-1',
      type: 'model-round',
      flowItemId: 'text-2',
      occurrenceIndex: 0,
      expandableIds: undefined,
    }]);
  });

  it('reports every occurrence within a single source', () => {
    const virtualItems = [{
      type: 'model-round',
      turnId: 'turn-1',
      isLastRound: true,
      isTurnComplete: true,
      data: {
        id: 'round-1',
        items: [
          { id: 'text-1', type: 'text', content: 'needle one, needle two, needle three' },
        ],
      },
    }] as VirtualItem[];

    expect(buildFlowChatSearchMatches(virtualItems, 'needle')).toEqual([
      expect.objectContaining({ flowItemId: 'text-1', occurrenceIndex: 0 }),
      expect.objectContaining({ flowItemId: 'text-1', occurrenceIndex: 1 }),
      expect.objectContaining({ flowItemId: 'text-1', occurrenceIndex: 2 }),
    ]);
  });

  it('counts non-overlapping occurrences only', () => {
    const virtualItems = [{
      type: 'user-message',
      turnId: 'turn-1',
      data: { id: 'user-1', content: 'aaa' },
    }] as VirtualItem[];

    expect(buildFlowChatSearchMatches(virtualItems, 'aa')).toHaveLength(1);
  });

  it('records collapsed containers from outermost to innermost', () => {
    const virtualItems = [{
      type: 'explore-group',
      turnId: 'turn-1',
      data: {
        groupId: 'group-1',
        allItems: [{
          id: 'thinking-1',
          type: 'thinking',
          content: 'hidden needle',
        }],
      },
    }] as VirtualItem[];

    expect(buildFlowChatSearchMatches(virtualItems, 'needle')[0]).toMatchObject({
      flowItemId: 'thinking-1',
      expandableIds: ['group-1', 'thinking-1'],
    });
  });

  it('opens the collection before the reasoning disclosure when locating a folded thought', () => {
    const virtualItems = [{
      type: 'model-round', turnId: 'turn-1', isLastRound: true, isTurnComplete: true,
      data: {
        id: 'mixed', index: 0, startTime: 1, status: 'completed', isComplete: true, isStreaming: false,
        items: [
          { id: 'text', type: 'text', content: 'Visible narrative', status: 'completed', timestamp: 1, isStreaming: false },
          { id: 'thinking', type: 'thinking', content: 'hidden needle', status: 'completed', timestamp: 2, isStreaming: false, isCollapsed: true },
          { id: 'grep', type: 'tool', toolName: 'Grep', status: 'completed', timestamp: 3, toolCall: { id: 'grep', input: {} } },
        ],
      },
    }] as VirtualItem[];
    expect(buildFlowChatSearchMatches(virtualItems, 'needle')[0]).toMatchObject({
      flowItemId: 'thinking', expandableIds: ['mixed:explore:grep', 'thinking'],
    });
  });

  it('keeps separate matches for each item in the same turn', () => {
    const virtualItems = [
      {
        type: 'user-steering-message',
        turnId: 'turn-1',
        steeringId: 'steering-1',
        steeringStatus: 'completed',
        data: { id: 'user-1', content: 'needle in steering' },
      },
      {
        type: 'model-round',
        turnId: 'turn-1',
        isLastRound: true,
        isTurnComplete: true,
        data: {
          id: 'round-1',
          items: [{ id: 'text-1', type: 'text', content: 'needle again' }],
        },
      },
    ] as VirtualItem[];

    expect(buildFlowChatSearchMatches(virtualItems, 'needle')).toEqual([
      expect.objectContaining({ virtualItemIndex: 0, type: 'user-steering-message', occurrenceIndex: 0 }),
      expect.objectContaining({ virtualItemIndex: 1, type: 'model-round', flowItemId: 'text-1', occurrenceIndex: 0 }),
    ]);
  });
});

describe('useFlowChatSearch navigation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let controller: UseFlowChatSearchReturn | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    controller = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(items: VirtualItem[]): void {
    act(() => {
      root.render(React.createElement(SearchHarness, {
        items,
        onController: nextController => {
          controller = nextController;
        },
      }));
    });
  }

  function selectLastOfFive(): void {
    render(searchableItems(5));
    act(() => controller?.onSearchChange('needle'));
    act(() => controller?.goToPrev());
    expect(controller?.currentMatchIndex).toBe(4);
  }

  it('marks only matching blocks, leaving other blocks in the same turn undecorated', () => {
    render([
      {
        type: 'user-message',
        turnId: 'turn-1',
        data: { id: 'user-1', content: 'unrelated prompt' },
      },
      {
        type: 'model-round',
        turnId: 'turn-1',
        data: {
          id: 'round-1',
          items: [{ id: 'text-1', type: 'text', content: 'needle and another needle' }],
        },
      },
      {
        type: 'explore-group',
        turnId: 'turn-1',
        data: {
          groupId: 'group-1',
          allItems: [{ id: 'thinking-1', type: 'thinking', content: 'unrelated reasoning' }],
        },
      },
      {
        type: 'user-message',
        turnId: 'turn-2',
        data: { id: 'user-2', content: 'needle in a different turn' },
      },
    ] as VirtualItem[]);

    act(() => controller?.onSearchChange('needle'));
    expect(controller?.matches).toHaveLength(3);
    expect(controller?.matchIndices).toEqual(new Set([1, 3]));
    expect(controller?.matchesByVirtualIndex.get(1)).toEqual([
      expect.objectContaining({ flowItemId: 'text-1', occurrenceIndex: 0 }),
      expect.objectContaining({ flowItemId: 'text-1', occurrenceIndex: 1 }),
    ]);
    expect(controller?.matchesByVirtualIndex.has(0)).toBe(false);
    expect(controller?.matchesByVirtualIndex.has(2)).toBe(false);
    expect(controller?.currentMatchVirtualIndex).toBe(1);

    act(() => controller?.onSearchChange('missing'));
    expect(controller?.matchIndices.size).toBe(0);
    expect(controller?.currentMatchVirtualIndex).toBe(-1);

    act(() => controller?.onSearchChange('reasoning'));
    expect(controller?.matchIndices).toEqual(new Set([2]));
    expect(controller?.currentMatchVirtualIndex).toBe(2);

    act(() => controller?.clearSearch());
    expect(controller?.matchIndices.size).toBe(0);
    expect(controller?.currentMatchVirtualIndex).toBe(-1);
  });

  it('moves next from the resolved index after matches shrink', () => {
    selectLastOfFive();
    render(searchableItems(3));

    expect(controller?.currentMatchIndex).toBe(2);
    act(() => controller?.goToNext());

    expect(controller?.currentMatchIndex).toBe(0);
  });

  it('moves previous from the resolved index after matches shrink', () => {
    selectLastOfFive();
    render(searchableItems(3));

    expect(controller?.currentMatchIndex).toBe(2);
    act(() => controller?.goToPrev());

    expect(controller?.currentMatchIndex).toBe(1);
  });
});
