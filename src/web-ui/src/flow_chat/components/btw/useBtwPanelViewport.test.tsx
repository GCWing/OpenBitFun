// @vitest-environment jsdom
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBtwPanelViewport } from './useBtwPanelViewport';
import { createBtwPanelViewState } from './btwPanelViewState';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowChatVirtualizer } from '../modern/useFlowChatVirtualizer';
import type { FlowChatViewportOwnerApi } from '../modern/useFlowChatViewportOwner';
import { useExploreGroupState } from '../modern/useExploreGroupState';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('embedded panel reading position', () => {
  let root: Root;
  let host: HTMLDivElement;
  let scroller: HTMLDivElement;
  let window: HTMLDivElement;
  let state: ReturnType<typeof createBtwPanelViewState>;
  let owner: FlowChatViewportOwnerApi;
  let virtualizer: FlowChatVirtualizer;
  const item = (id: string) => ({ type: 'image-analyzing', turnId: id } as VirtualItem);
  function Harness({ items = [item('saved')] }: { items?: VirtualItem[] }) {
    useBtwPanelViewport(state, items, useRef(scroller), useRef(window), virtualizer, owner);
    return null;
  }
  function row() {
    const element = document.createElement('div');
    element.setAttribute('data-virtual-item-key', 'image-analyzing:saved');
    element.getBoundingClientRect = () => ({ top: 100, bottom: 400, height: 300 } as DOMRect);
    window.appendChild(element);
    return element;
  }
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    host = document.createElement('div');
    scroller = document.createElement('div');
    window = document.createElement('div');
    scroller.appendChild(window);
    document.body.append(host, scroller);
    Object.defineProperty(scroller, 'clientHeight', { value: 500 });
    scroller.getBoundingClientRect = () => ({ top: 150 } as DOMRect);
    root = createRoot(host);
    state = createBtwPanelViewState();
    state.followTail = false;
    owner = { write: vi.fn(() => true) } as unknown as FlowChatViewportOwnerApi;
    virtualizer = { getItemBounds: vi.fn(() => ({ startPx: 600, endPx: 900 })) } as unknown as FlowChatVirtualizer;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove(); scroller.remove();
    vi.unstubAllGlobals();
  });

  it('captures a stable item and intra-row offset, then restores after history grows', () => {
    row();
    act(() => root.render(<Harness />));
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(state.anchor).toEqual({ key: 'image-analyzing:saved', offsetPx: 50 });
    act(() => root.render(null));
    window.replaceChildren();
    state.restoring = true;
    act(() => root.render(<Harness items={[item('prepended'), item('saved')]} />));
    expect(virtualizer.getItemBounds).toHaveBeenLastCalledWith(1);
    expect(owner.write).toHaveBeenLastCalledWith({ owner: 'one-shot-navigation', topPx: 650, holdForMs: 0 });
    scroller.scrollTop = 650;
    row();
    act(() => root.render(<Harness items={[item('prepended'), item('saved')]} />));
    expect(owner.write).toHaveBeenLastCalledWith({ owner: 'one-shot-navigation', topPx: 650, holdForMs: 0 });
    expect(state.restoring).toBe(false);
  });

  it('does not restore an old anchor when following the tail, and cleans up on unmount', () => {
    state.followTail = true;
    state.anchor = { key: 'image-analyzing:saved', offsetPx: 50 };
    row();
    act(() => root.render(<Harness />));
    expect(owner.write).not.toHaveBeenCalled();
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(state.anchor).toBeNull();
    act(() => root.render(null));
    state.followTail = false;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(state.anchor).toBeNull();
  });

  it('abandons restoration when the user takes over or the saved item is absent', () => {
    state.anchor = { key: 'image-analyzing:saved', offsetPx: 50 };
    state.restoring = true;
    act(() => root.render(<Harness />));
    act(() => scroller.dispatchEvent(new Event('wheel')));
    vi.mocked(owner.write).mockClear();
    row();
    act(() => root.render(<Harness />));
    expect(owner.write).not.toHaveBeenCalled();
    act(() => root.render(null));
    state.restoring = true;
    act(() => root.render(<Harness items={[item('replacement')]} />));
    expect(state.restoring).toBe(false);
    expect(state.anchor).toBeNull();
  });

  it('restores exploration expansion after content remount without retaining items', () => {
    let exploration: ReturnType<typeof useExploreGroupState>;
    function ExpansionHarness() {
      exploration = useExploreGroupState([], state.exploreGroupStates, 'child', state.expandedToolCapsules);
      const groups = exploration.exploreGroupStates;
      useEffect(() => { state.exploreGroupStates = groups; }, [groups]);
      const capsules = exploration.expandedToolCapsules;
      useEffect(() => { state.expandedToolCapsules = capsules; }, [capsules]);
      return null;
    }
    act(() => root.render(<ExpansionHarness />));
    act(() => exploration.onExpandGroup('group'));
    act(() => exploration.onToolCapsuleExpandedChange('capsule', true));
    act(() => root.render(null));
    act(() => root.render(<ExpansionHarness />));
    expect(exploration!.exploreGroupStates.get('group')).toBe(true);
    expect(exploration!.expandedToolCapsules.has('capsule')).toBe(true);
    act(() => root.render(null));
    state = createBtwPanelViewState();
    act(() => root.render(<ExpansionHarness />));
    expect(exploration!.exploreGroupStates.size).toBe(0);
    expect(exploration!.expandedToolCapsules.size).toBe(0);
  });
});
