// @vitest-environment jsdom
import React, { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { productControlAPI } from '@/infrastructure/api/service-api/ProductControlAPI';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowToolItem } from '../types/flow-chat';
import { buildOpenBitFunControlCardModel } from './openBitFunControlCardModel';
import { useOpenBitFunControlDiscovery } from './useOpenBitFunControlDiscovery';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const all = Array.from({ length: 46 }, (_, index) => ({ id: `feature.${index}` }));
const item: FlowToolItem = {
  id: 'control', type: 'tool', toolName: 'OpenBitFunControl', timestamp: 0, status: 'completed',
  toolCall: { id: 'control-call', input: { action: 'search', query: 'appearance' } },
  toolResult: { success: true, result: { items: all.slice(0, 20), totalCount: 46, nextCursor: 20 } },
};

describe('discovery view state', () => {
  let root: Root;
  let container: HTMLDivElement;
  let output: ReturnType<typeof useOpenBitFunControlDiscovery>;
  const read = vi.spyOn(productControlAPI, 'discover');

  function Probe({ expanded, toolItem = item }: { expanded: boolean; toolItem?: FlowToolItem }) {
    const model = useMemo(() => buildOpenBitFunControlCardModel(toolItem, 'en-US'), [toolItem]);
    output = useOpenBitFunControlDiscovery(toolItem, model, expanded);
    return null;
  }

  beforeEach(() => {
    activateSurface('local');
    container = document.createElement('div');
    root = createRoot(container);
    read.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    activateSurface('local');
  });

  function servePages() {
    read.mockImplementation(async request => {
      const cursor = request.cursor ?? 0;
      return { items: all.slice(cursor, cursor + 20), totalCount: 46, cursor, nextCursor: cursor + 20 < 46 ? cursor + 20 : null };
    });
  }

  it('loads only after expansion and retains the complete list across collapse', async () => {
    servePages();
    await act(async () => root.render(<Probe expanded={false} />));
    expect(read).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe expanded />));
    expect(output.items).toHaveLength(46);
    expect(output.loading).toBe(false);
    await act(async () => root.render(<Probe expanded={false} />));
    await act(async () => root.render(<Probe expanded />));
    expect(read).toHaveBeenCalledTimes(3);
    expect(item.toolResult!.result.items).toHaveLength(20);
  });

  it('keeps the recorded results on failure and supports retry', async () => {
    read.mockRejectedValue(new Error('Host offline'));
    await act(async () => root.render(<Probe expanded />));
    expect(output.items).toHaveLength(20);
    expect(output.error).toBe('load-failed');
    expect(read).toHaveBeenCalledTimes(1);
    servePages();
    await act(async () => output.retry());
    expect(output.items).toHaveLength(46);
    expect(output.error).toBeUndefined();
  });

  it('stops pending pagination on collapse and resumes when expanded again', async () => {
    let resolve!: (page: { items: { id: string }[]; nextCursor: number }) => void;
    read.mockReturnValue(new Promise(done => { resolve = done; }));
    await act(async () => root.render(<Probe expanded />));
    await act(async () => root.render(<Probe expanded={false} />));
    await act(async () => { resolve({ items: all.slice(0, 20), nextCursor: 20 }); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(output.items).toHaveLength(20);
    expect(output.loading).toBe(false);

    servePages();
    await act(async () => root.render(<Probe expanded />));
    expect(output.items).toHaveLength(46);
  });

  it('discards a late response when the recorded result and query change', async () => {
    let resolve!: (page: { items: { id: string }[]; nextCursor: number }) => void;
    read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await act(async () => root.render(<Probe expanded />));

    const replacementItems = [{ id: 'shortcuts.first' }, { id: 'shortcuts.second' }];
    const replacement: FlowToolItem = {
      ...item,
      toolCall: { id: 'replacement-call', input: { action: 'search', query: 'shortcuts' } },
      toolResult: { success: true, result: { items: replacementItems.slice(0, 1), totalCount: 2, nextCursor: 1 } },
    };
    read.mockResolvedValue({ items: replacementItems, totalCount: 2, nextCursor: null });
    await act(async () => root.render(<Probe expanded toolItem={replacement} />));
    await act(async () => { resolve({ items: all.slice(0, 20), nextCursor: 20 }); });
    expect(output.items).toEqual(replacementItems);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({ action: 'search', query: 'shortcuts', cursor: 0 });
  });

  it('ignores late responses after switching devices and never follows their cursor on the new host', async () => {
    let resolve!: (page: { items: { id: string }[]; nextCursor: number }) => void;
    read.mockReturnValue(new Promise(done => { resolve = done; }));
    await act(async () => root.render(<Probe expanded />));
    await act(async () => { activateSurface('peer:another-device'); });
    await act(async () => { resolve({ items: all.slice(0, 20), nextCursor: 20 }); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(output.items).toHaveLength(20);
    expect(output.error).toBe('surface-changed');
  });
});
