// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { claimSubmittedMessageScrollIntent, registerSubmittedMessageScrollIntent } from '../../services/submittedMessageScrollIntent';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatVirtualizer } from './useFlowChatVirtualizer';
import { useFlowChatViewportOwner } from './useFlowChatViewportOwner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); activateSurface('local'); });

// Real follow, virtualizer and ownership hooks. Supplied DOM heights reproduce
// synchronous resizeItem notifications, not native WebView rendering.
it('places once through real measurement notifications and remains idle after deactivation', async () => {
  activateSurface('local');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const host = document.createElement('div');
  const scroller = document.createElement('div');
  const header = document.createElement('div');
  document.body.append(host, scroller);
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 }, clientWidth: { value: 800 },
    offsetHeight: { value: 500 }, offsetWidth: { value: 800 }, scrollHeight: { value: 1000 },
  });
  const root = createRoot(host);
  let active = true, renders = 0, placements = 0, reconciliations = 0;
  let materialized = true;
  let follow: ReturnType<typeof useFlowChatFollowOutput>;
  const items = ['message', 'answer'];
  function Harness() {
    renders++;
    const scrollerRef = useRef(scroller), headerRef = useRef(header);
    const owner = useFlowChatViewportOwner(scrollerRef);
    const reconcile = useRef<() => boolean>(() => false);
    const [, setPin] = useState<string | null>(null);
    const virtualizer = useFlowChatVirtualizer({
      items, scrollerRef, headerRef, getItemKey: String,
      estimateItemHeightPx: () => 100, scrollPaddingStartPx: 0,
      writeViewport: owner.write, shiftViewport: owner.shift,
      reconcileOpeningMeasurement: () => reconcile.current(),
    });
    follow = useFlowChatFollowOutput({
      activeSessionId: 'measurement-session', virtualItemCount: items.length,
      isViewportActive: active, isStreaming: true, startAtTailOnMount: false,
      scrollerRef, viewportOwner: owner, viewportId: 123,
      readLayoutTarget: () => 500, hasRenderedOutput: () => false,
      isOpeningViewport: () => true, cancelNavigation: virtualizer.cancelAim,
      cancelPendingPlacement: () => setPin(null),
      placeSubmittedMessage: intent => {
        if (!materialized) { setPin(intent.turnId); return null; }
        placements++;
        virtualizer.measureRenderedItems();
        owner.write({ owner: 'follow-output', topPx: 100 });
        virtualizer.syncViewportOffset(scroller.scrollTop);
        setPin(null);
        return scroller.scrollTop;
      },
    });
    reconcile.current = () => {
      if (!active || !follow.isFollowingOutputNow()) return false;
      reconciliations++;
      follow.scheduleFollowToLatest();
      return true;
    };
    return null;
  }
  try {
    act(() => root.render(<Harness />));
    // Attach after mount so the submission's measurement sees two real deltas.
    for (let index = 0; index < items.length; index++) {
      const row = document.createElement('div');
      row.dataset.virtualIndex = String(index);
      Object.defineProperty(row, 'offsetHeight', { value: 40 });
      scroller.append(row);
    }
    await act(async () => {
      registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'measurement-session', 'turn', 'message');
      await Promise.resolve();
    });
    expect(reconciliations).toBeGreaterThan(0);
    expect(placements).toBe(1);
    expect(scroller.scrollTop).toBe(100);
    expect(claimSubmittedMessageScrollIntent('measurement-session', 123)).toBeNull();

    materialized = false;
    act(() => { registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'measurement-session', 'next', 'next-message'); });
    active = false;
    await act(async () => { root.render(<Harness />); await Promise.resolve(); });
    expect(follow!.isFollowingOutputNow()).toBe(false);
    const settledRenders = renders;
    for (let i = 0; i < 5; i++) act(() => root.render(<Harness />));
    expect(renders - settledRenders).toBe(5);
    expect(placements).toBe(1);
  } finally {
    act(() => root.unmount()); host.remove(); scroller.remove();
  }
});
