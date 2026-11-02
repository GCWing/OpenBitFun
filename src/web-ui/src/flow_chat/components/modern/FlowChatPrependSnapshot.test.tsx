// @vitest-environment jsdom
import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FlowChatPrependSnapshot } from './FlowChatPrependSnapshot';

it('captures current pre-mutation geometry only for a prepend, before parent layout effects', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const scrollerRef = { current: null as HTMLDivElement | null };
  const snapshotRef = { current: null as { firstKey: string; scrollHeight: number } | null };
  const reads = vi.fn(() => Number(scrollerRef.current?.dataset.height));
  const observed: unknown[] = [];
  function List({ keys, height }: { keys: string[]; height: number }) {
    useLayoutEffect(() => { observed.push(snapshotRef.current); });
    return <FlowChatPrependSnapshot itemKeys={keys} scrollerRef={scrollerRef} snapshotRef={snapshotRef}>
      <div ref={scrollerRef} data-height={height} />
    </FlowChatPrependSnapshot>;
  }
  try {
    act(() => root.render(<List keys={['b', 'c']} height={100} />));
    Object.defineProperty(scrollerRef.current, 'scrollHeight', { get: reads });
    act(() => root.render(<List keys={['b', 'c']} height={150} />));
    act(() => root.render(<List keys={['b', 'c', 'd']} height={200} />));
    expect(reads).not.toHaveBeenCalled();
    // A layout change between React commits must be reflected in the baseline.
    scrollerRef.current!.dataset.height = '225';
    act(() => root.render(<List keys={['a', 'b', 'c', 'd']} height={400} />));
    expect(reads).toHaveBeenCalledOnce();
    expect(observed.at(-1)).toEqual({ firstKey: 'b', scrollHeight: 225 });
    expect(scrollerRef.current!.dataset.height).toBe('400');
    act(() => root.render(<List keys={['b', 'c', 'd']} height={200} />));
    expect(observed.at(-1)).toBeNull();
    act(() => root.render(<List keys={['x', 'y']} height={300} />));
    expect(reads).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
