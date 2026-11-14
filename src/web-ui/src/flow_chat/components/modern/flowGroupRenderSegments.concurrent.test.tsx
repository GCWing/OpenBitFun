// @vitest-environment jsdom
import React, { act, Suspense, startTransition, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { FlowItem, FlowToolItem } from '../../types/flow-chat';
import { buildFlowGroupRenderSegments, type FlowGroupRenderSegment } from './flowGroupRenderSegments';

it('keeps retained render callbacks on committed members while an append suspends', async () => {
  const read = (index: number): FlowToolItem => ({
    id: `call-${index}`, type: 'tool', toolName: 'Read', timestamp: 1, status: 'completed',
    toolCall: { id: `call-${index}`, input: {} },
  } as FlowToolItem);
  const initial: FlowItem[] = [read(0)];
  let update!: (items: FlowItem[]) => void;
  let committedRender!: () => string[];
  let attempted = false;
  const pending = new Promise<void>(() => {});

  function Group({ items }: { items: FlowItem[] }) {
    const previous = useRef<readonly FlowGroupRenderSegment[]>([]);
    const segments = useMemo(() => buildFlowGroupRenderSegments(items, previous.current), [items]);
    useLayoutEffect(() => {
      previous.current = segments;
      // DeferredContent retains a render closure over the source segment.
      committedRender = () => segments[0].items.map(item => item.id);
    }, [segments]);
    if (items.length === 2) {
      attempted = true;
      throw pending;
    }
    return <div>{items.length} committed</div>;
  }
  function Host() {
    const [items, setItems] = useState(initial);
    update = setItems;
    return <Suspense fallback="loading"><Group items={items} /></Suspense>;
  }

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Host />); });
    await act(async () => { startTransition(() => update([...initial, read(1)])); });
    expect(attempted).toBe(true);
    expect(container.textContent).toBe('1 committed');
    expect(committedRender()).toEqual(['call-0']);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
