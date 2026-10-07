// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { highlightFlowChatFocusTarget, useFlowChatSearchPresentation } from './useFlowChatSearchPresentation';
import { measureFlowChatSearchLine } from './flowChatSearchPresentation';
import type { SearchMatch } from './useFlowChatSearch';

vi.mock('./flowChatSearchPresentation', async importOriginal => ({
  ...await importOriginal<typeof import('./flowChatSearchPresentation')>(),
  // jsdom has no text layout. Check presentation ownership, not visual geometry.
  measureFlowChatSearchLine: vi.fn((_wrapper, source: HTMLElement) => ({
    top: source.dataset.flowItemId === 'located' ? 40 : 10, left: 0, width: 100, height: 20,
  })),
}));

const match: SearchMatch = { type: 'model-round', turnId: 'turn', virtualItemIndex: 0, flowItemId: 'searched', occurrenceIndex: 0 };
const matches = [match];
function Harness({ wrapper, search }: { wrapper: HTMLElement; search: boolean }) {
  const line = useFlowChatSearchPresentation(wrapper, search ? 'needle' : undefined,
    search ? matches : undefined, search ? match : undefined);
  return <output>{line?.top ?? 'none'}</output>;
}

describe('shared search and source-navigation presentation', () => {
  let wrapper: HTMLDivElement;
  let host: HTMLDivElement;
  let root: Root;
  const clears: Array<() => void> = [];
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    wrapper = document.createElement('div');
    wrapper.className = 'virtual-item-wrapper';
    wrapper.innerHTML = '<p data-flow-item-id="searched">needle</p><p data-flow-item-id="located">Source line</p>';
    host = document.createElement('div');
    document.body.append(wrapper, host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => { clears.splice(0).forEach(clear => clear()); root.unmount(); });
    wrapper.remove(); host.remove();
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
  });

  it('uses the search line without a query and clears it after the navigation timeout', () => {
    act(() => root.render(<Harness wrapper={wrapper} search={false} />));
    expect(host.textContent).toBe('none');
    const source = wrapper.children[1] as HTMLElement;
    act(() => { clears.push(highlightFlowChatFocusTarget(source)); });
    expect(host.textContent).toBe('40');
    expect(measureFlowChatSearchLine).toHaveBeenLastCalledWith(wrapper, source, expect.any(Range));
    expect(wrapper.textContent).toBe('needleSource line');
    act(() => vi.advanceTimersByTime(1600));
    expect(host.textContent).toBe('none');
  });

  it('restores the existing search marker when source navigation ends', () => {
    act(() => root.render(<Harness wrapper={wrapper} search />));
    expect(host.textContent).toBe('10');
    act(() => { clears.push(highlightFlowChatFocusTarget(wrapper.children[1] as HTMLElement)); });
    expect(host.textContent).toBe('40');
    act(() => clears[0]());
    expect(host.textContent).toBe('10');
  });
});
