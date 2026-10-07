// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  claimSubmittedMessageScrollIntent,
  finishSubmittedMessageScrollIntent,
  registerSubmittedMessageScrollIntent,
} from '../../services/submittedMessageScrollIntent';
import { FlowChatReaderState } from '../../timeline/readerState';
import { useTimelineInteraction } from '../../timeline/useTimelineInteraction';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatViewportOwner, type FlowChatViewportOwnerApi } from './useFlowChatViewportOwner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
type Controller = ReturnType<typeof useFlowChatFollowOutput>;

describe('desktop follow ownership and lifecycle (supplied geometry, not visual evidence)', () => {
  let root: Root, host: HTMLDivElement, scroller: HTMLDivElement, controller: Controller, owner: FlowChatViewportOwnerApi;
  let frames: Map<number, FrameRequestCallback>, frameId: number, now: number;
  let normalTarget: number, floor: number | null, sentTop: number, output: boolean, renderable: boolean;
  let cancelledPlacements: number;
  let props: { session: string; active: boolean; suspended: boolean; opening: boolean; count: number; startAtTail: boolean; streaming: boolean };
  let reader: FlowChatReaderState;
  const placements: string[] = [];
  const readbacks: number[] = [];
  function Harness() {
    const ref = React.useRef<HTMLElement | null>(scroller);
    owner = useFlowChatViewportOwner(ref);
    controller = useFlowChatFollowOutput({
      activeSessionId: props.session, virtualItemCount: props.count,
      isViewportActive: props.active, isViewportSuspended: () => props.suspended,
      isStreaming: props.streaming, startAtTailOnMount: props.startAtTail,
      scrollerRef: ref, viewportOwner: owner, viewportId: 1,
      isOpeningViewport: () => props.opening, onViewportOffset: value => readbacks.push(value),
      readLayoutTarget: () => Math.max(normalTarget, floor ?? 0),
      placeSubmittedMessage: intent => {
        if (!renderable) return null;
        floor = sentTop;
        if (!owner.write({ owner: 'follow-output', topPx: sentTop })) return null;
        placements.push(intent.turnId);
        return sentTop;
      },
      hasRenderedOutput: () => output,
      cancelPendingPlacement: () => { cancelledPlacements += 1; }, cancelNavigation: () => {},
    });
    useTimelineInteraction(ref, reader, controller.isFollowingOutputNow, undefined,
      () => controller.exitFollowOutput('reader-interaction'));
    return null;
  }
  const render = () => act(() => root.render(<Harness />));
  const signal = () => act(() => controller.scheduleFollowToLatest());
  const submit = (turn = 'turn-2') => act(() => registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), props.session, turn, `user-${turn}`));
  function tick(ms = 16) {
    now += ms;
    const callbacks = [...frames.values()]; frames.clear();
    act(() => callbacks.forEach(fn => fn(now)));
  }
  function settle() { for (let i = 0; i < 100 && frames.size; i++) tick(); }
  function depart(direction: 'before' | 'after' = 'before') {
    act(() => { owner.claim('user-gesture', { holdForMs: 200 }); controller.handleUserScrollIntent(direction); });
  }
  beforeEach(() => {
    activateSurface('local');
    host = document.createElement('div'); scroller = document.createElement('div');
    document.body.append(host, scroller); root = createRoot(host);
    normalTarget = 1000; floor = null; sentTop = 1400; output = false; renderable = true;
    cancelledPlacements = 0;
    props = { session: 'session', active: true, suspended: false, opening: false, count: 2, startAtTail: true, streaming: true };
    reader = new FlowChatReaderState();
    frames = new Map(); frameId = 0; now = 0; placements.length = 0; readbacks.length = 0;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => props.suspended ? 0 : 800 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => Math.max(normalTarget, floor ?? 0) + 800 });
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); scroller.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); activateSurface('local');
  });

  it('opens at the one physical bottom and sleeps once settled even while streaming', () => {
    props.opening = true; render(); settle();
    expect(scroller.scrollTop).toBe(1000); expect(readbacks).toContain(1000);
    expect(frames.size).toBe(0); expect(controller.isFollowingOutputNow()).toBe(true);
    normalTarget = 1250; signal(); expect(scroller.scrollTop).toBe(1250);
  });
  it('places a submitted user message once, waits at top until output crosses the reading line, then eases monotonically', () => {
    render(); submit(); expect(scroller.scrollTop).toBe(1400);
    output = true; normalTarget = 1350; signal(); settle();
    expect(scroller.scrollTop).toBe(1400); expect(placements).toEqual(['turn-2']);
    normalTarget = 1500; signal(); expect(scroller.scrollTop).toBe(1400);
    tick(); expect(scroller.scrollTop).toBeGreaterThan(1400); expect(scroller.scrollTop).toBeLessThan(1500);
    let previous = scroller.scrollTop;
    while (frames.size) { tick(); expect(scroller.scrollTop).toBeGreaterThanOrEqual(previous); previous = scroller.scrollTop; }
    expect(scroller.scrollTop).toBeCloseTo(1500, 0); expect(floor).toBe(1400);
  });
  it('does not place the same message again when completion notifies in a microtask', async () => {
    render(); submit();
    await act(async () => { await Promise.resolve(); });
    expect(placements).toEqual(['turn-2']);
    expect(controller.isFollowingOutputNow()).toBe(true);
  });
  it('does not let a tall user message start following before assistant output exists', () => {
    render(); submit(); normalTarget = 2100; signal(); settle(); expect(scroller.scrollTop).toBe(1400);
    output = true; signal(); settle(); expect(scroller.scrollTop).toBe(2100);
  });
  it('publishes live follow travel before native scroll delivery, not only during opening', () => {
    render(); readbacks.length = 0;
    normalTarget = 1400; signal(); tick();
    expect(readbacks).toEqual([scroller.scrollTop]);
    expect(readbacks[0]).toBeGreaterThan(1000);
    settle(); expect(readbacks.at(-1)).toBe(1400);
    depart(); readbacks.length = 0; normalTarget = 1800; signal(); settle();
    expect(readbacks).toEqual([]);
  });
  it('sleeps at the reachable physical endpoint when layout clamps before the resize notification', () => {
    render(); normalTarget = 1600; signal(); tick();
    // Model native clamping independently from the last cached layout target.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1700 });
    scroller.scrollTop = 900;
    tick(); expect(scroller.scrollTop).toBe(900); expect(frames.size).toBe(0);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    normalTarget = 1200; signal(); settle();
    expect(scroller.scrollTop).toBe(1200); expect(frames.size).toBe(0);
  });
  it.each(['complete', 'stop', 'error'])('keeps a short reply top-aligned on %s and explicit bottom navigation', () => {
    render(); submit(); output = true; normalTarget = 1200; props.streaming = false; render(); settle();
    expect(scroller.scrollTop).toBe(1400); expect(floor).toBe(1400);
    act(() => controller.enterFollowOutput('jump-to-latest')); settle();
    expect(scroller.scrollTop).toBe(1400); expect(floor).toBe(1400);
  });
  it('does not treat replay, hydration or ledger growth as a submission', () => {
    render(); depart(); scroller.scrollTop = 500;
    props.count = 20; normalTarget = 3000; render(); settle();
    expect(placements).toEqual([]); expect(scroller.scrollTop).toBe(500); expect(controller.isFollowingOutputNow()).toBe(false);
  });
  it('waits for the exact submitted row to materialize without a timeout or moving history first', () => {
    render(); renderable = false; submit(); now += 2000; render(); expect(scroller.scrollTop).toBe(1000);
    renderable = true; signal(); expect(scroller.scrollTop).toBe(1400); expect(placements).toEqual(['turn-2']);
  });
  it('cancels a pending placement on manual input', () => {
    render(); renderable = false; submit(); depart(); renderable = true; signal(); settle();
    expect(placements).toEqual([]); expect(controller.isFollowingOutputNow()).toBe(false);
  });
  it('releases a cancelled submission before its row has rendered', async () => {
    render(); renderable = false; submit();
    cancelledPlacements = 0;
    const intent = claimSubmittedMessageScrollIntent(props.session, 1, true)!;
    await act(async () => {
      finishSubmittedMessageScrollIntent(intent);
      await Promise.resolve();
    });
    renderable = true; normalTarget = 1800; signal(); settle();
    expect(cancelledPlacements).toBe(1);
    expect(placements).toEqual([]);
    expect(scroller.scrollTop).toBe(1000);
    expect(controller.isFollowingOutputNow()).toBe(false);
  });
  it('a gesture interrupts animation immediately, and later output cannot regain control', () => {
    render(); normalTarget = 1400; signal(); tick(); depart();
    scroller.scrollTop = 600; normalTarget = 2600; signal(); settle(); now += 10000; signal();
    expect(scroller.scrollTop).toBe(600); expect(frames.size).toBe(0);
  });
  it('selection or disclosure releases follow until a fresh explicit action', () => {
    render(); act(() => controller.exitFollowOutput('reader-interaction'));
    normalTarget = 1300; signal(); settle(); expect(scroller.scrollTop).toBe(1000);
    act(() => controller.enterFollowOutput('jump-to-latest')); settle(); expect(scroller.scrollTop).toBe(1300);
  });
  it.each([false, true])('preserves follow intent through an answer and subsequent output (reader took over: %s)', reading => {
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'question';
    row.dataset.flowchatInteraction = 'response';
    const answer = document.createElement('input'); answer.type = 'radio';
    row.append(answer); scroller.append(row);
    render(); submit(); output = true; signal(); settle();
    if (reading) { depart(); scroller.scrollTop = 900; }
    act(() => { answer.focus(); answer.click(); });
    expect(controller.isFollowingOutputNow()).toBe(!reading);
    act(() => { row.replaceChildren(document.createTextNode('Answered')); delete row.dataset.flowchatInteraction; });
    normalTarget = 1300; signal(); settle();
    expect(scroller.scrollTop).toBe(reading ? 900 : 1400);
    // Text and new card rows arrive later. Completion/growth does not repair
    // lost intent, and may not override a genuine reader either.
    props.count += 3; normalTarget = 2200; render(); signal(); settle();
    expect(scroller.scrollTop).toBe(reading ? 900 : 2200);
    expect(controller.isFollowingOutputNow()).toBe(!reading);
  });
  it('resumes only on deliberate downward arrival at bottom, not content catching a reader', () => {
    render(); depart(); scroller.scrollTop = 600; normalTarget = 600; signal();
    act(() => controller.handleScroll()); expect(controller.isFollowingOutputNow()).toBe(false);
    normalTarget = 1000; depart('after'); scroller.scrollTop = 1000;
    act(() => controller.handleScroll()); expect(controller.isFollowingOutputNow()).toBe(true);
    now += 250; normalTarget = 1100; signal(); settle(); expect(scroller.scrollTop).toBe(1100);
  });
  it('downward input at the physical edge resumes even without a scroll event', () => {
    render(); depart(); depart('after'); expect(controller.isFollowingOutputNow()).toBe(true);
  });
  it('does not invent a reverse jump on completion or restart', () => {
    render(); normalTarget = 1200; signal(); props.streaming = false; render(); settle();
    expect(scroller.scrollTop).toBe(1200); props.streaming = true; render(); expect(scroller.scrollTop).toBe(1200);
  });
  it('returns to the Turn top after a tall card folds, then waits for output to fill again', () => {
    render(); submit(); output = true; normalTarget = 1700; signal(); settle();
    normalTarget = 900; signal(); settle(); expect(scroller.scrollTop).toBe(1400);
    normalTarget = 1300; signal(); settle(); expect(scroller.scrollTop).toBe(1400);
    normalTarget = 1600; signal(); tick();
    expect(scroller.scrollTop).toBeGreaterThan(1400); expect(scroller.scrollTop).toBeLessThan(1600);
    settle(); expect(scroller.scrollTop).toBe(1600); expect(floor).toBe(1400);
  });
  it('manual collection folding keeps reader ownership even when short content reaches the physical end', () => {
    render(); submit(); output = true; normalTarget = 1700; signal(); settle();
    act(() => controller.exitFollowOutput('reader-interaction'));
    normalTarget = 900; scroller.scrollTop = 1400; // Browser clamps to the persistent Turn floor.
    signal(); act(() => controller.handleScroll()); settle();
    expect(controller.isFollowingOutputNow()).toBe(false);
    normalTarget = 1800; signal(); settle(); expect(scroller.scrollTop).toBe(1400);
    act(() => controller.enterFollowOutput('jump-to-latest')); settle(); expect(scroller.scrollTop).toBe(1800);
  });
  it('deliberate bottom arrival on a short Turn preserves its top alignment', () => {
    render(); submit(); output = true; normalTarget = 1000; signal();
    depart(); scroller.scrollTop = 1200;
    depart('after'); scroller.scrollTop = 1400;
    act(() => controller.handleScroll()); now += 250; settle();
    expect(controller.isFollowingOutputNow()).toBe(true); expect(scroller.scrollTop).toBe(1400);
    normalTarget = 1300; signal(); settle(); expect(scroller.scrollTop).toBe(1400);
  });
  it('leaves history navigation and restored history snapshots under reader control', () => {
    props.startAtTail = false; scroller.scrollTop = 400; render(); signal(); settle();
    expect(scroller.scrollTop).toBe(400); expect(controller.isFollowingOutputNow()).toBe(false);
    submit(); expect(scroller.scrollTop).toBe(1400);
  });
  it('initializes after empty hydration but cannot reacquire after subsequent reader interaction', () => {
    props.count = 0; render(); props.count = 2; render(); expect(scroller.scrollTop).toBe(1000);
    depart(); scroller.scrollTop = 500; props.count = 0; render(); props.count = 2; render();
    expect(scroller.scrollTop).toBe(500);
  });
  it('keeps reader top position during viewport resizing', () => {
    render(); depart(); scroller.scrollTop = 500; normalTarget = 1500;
    act(() => controller.handleViewportResize({ viewportHeightDeltaPx: -200, wasAtTail: false }));
    expect(scroller.scrollTop).toBe(500);
  });
  it('suspends without discarding ownership, resumes from usable geometry', () => {
    render(); props.suspended = true; normalTarget = 1400; render(); settle(); expect(scroller.scrollTop).toBe(1000);
    props.suspended = false; render(); settle(); expect(scroller.scrollTop).toBe(1400);
  });
  it('does not write into an inactive viewport', () => {
    props.active = false; render(); expect(scroller.scrollTop).toBe(0);
    props.active = true; render(); expect(scroller.scrollTop).toBe(1000);
  });
  it('cancels a deferred send across session or device changes', () => {
    render(); renderable = false; submit(); props.session = 'other'; render(); renderable = true; signal();
    expect(placements).toEqual([]);
    renderable = false; submit(); act(() => activateSurface('peer')); renderable = true; signal();
    expect(placements).toEqual([]); expect(controller.isFollowingOutputNow()).toBe(false);
  });
  it('rollbacks are explicit tail navigation, never new-message placement', () => {
    render(); depart(); normalTarget = 400;
    act(() => controller.handleTurnsRolledBack()); settle(); expect(scroller.scrollTop).toBe(400); expect(placements).toEqual([]);
  });
  it('finishes already pending follow travel after completion without an extra target', () => {
    render(); normalTarget = 1060; signal(); tick(); props.streaming = false; render(); settle();
    expect(scroller.scrollTop).toBe(1060); expect(frames.size).toBe(0);
  });
  it('honors reduced motion', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    render(); normalTarget = 1200; signal(); tick(); expect(scroller.scrollTop).toBe(1200);
  });
});
