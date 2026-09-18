// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_MISSING_TURN_ATTEMPTS,
  ANCHOR_SETTLE_FRAMES,
  USER_DRIVEN_SCROLL_WINDOW_MS,
} from './flowChatViewportAnchor';
import {
  useFlowChatViewportAnchor,
  type FlowChatViewportAnchorApi,
} from './useFlowChatViewportAnchor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The one trace here that is asserted on rather than merely tolerated. The rest
 * of the trail is coalesced and reports whatever the last of a series happened
 * to hold; this one fires once per wait and its numbers are the whole point of
 * it, so it is worth pinning that it fires exactly once and says the truth.
 */
const mocks = vi.hoisted(() => ({ traceViewport: vi.fn(), traceViewportRepeating: vi.fn() }));
vi.mock('@/infrastructure/diagnostics/flowChatViewportDiagnostics', async () => {
  const actual = await vi.importActual<
    typeof import('@/infrastructure/diagnostics/flowChatViewportDiagnostics')
  >('@/infrastructure/diagnostics/flowChatViewportDiagnostics');
  return { ...actual, traceViewport: mocks.traceViewport, traceViewportRepeating: mocks.traceViewportRepeating };
});

const VIEWPORT_HEIGHT = 500;
const TURN_HEIGHT = 40;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 800,
    width: 800,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

interface HarnessProps {
  scroller: HTMLElement;
  isViewportOwnedElsewhere: () => boolean;
  onApi: (api: FlowChatViewportAnchorApi) => void;
}

function Harness({ scroller, isViewportOwnedElsewhere, onApi }: HarnessProps) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  // The anchor no longer touches the scroller itself; the register does, and
  // here that is the plain displacement it used to apply.
  const shiftViewport = React.useCallback((byPx: number) => {
    scroller.scrollTop += byPx;
  }, []);
  onApi(useFlowChatViewportAnchor({ scrollerRef, isViewportOwnedElsewhere, shiftViewport }));
  return null;
}

describe('useFlowChatViewportAnchor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let isMounted: boolean;
  let scroller: HTMLDivElement;
  let api: FlowChatViewportAnchorApi;
  let frames: FrameRequestCallback[];
  let now: number;
  let isOwnedElsewhere: boolean;

  /**
   * Place Turns in the transcript's own coordinate space.
   *
   * Rects are read back relative to the viewport, so writing `scrollTop` moves
   * them exactly as a real scroller would — which is what makes a correction
   * observable, and a second correction a no-op.
   */
  function layoutTurns(turnTops: Record<string, number>) {
    scroller.replaceChildren();
    for (const [turnId, contentTop] of Object.entries(turnTops)) {
      const element = document.createElement('div');
      element.className = 'virtual-item-wrapper';
      element.dataset.itemType = 'user-message';
      element.dataset.turnId = turnId;
      element.getBoundingClientRect = () => rect(contentTop - scroller.scrollTop, TURN_HEIGHT);
      scroller.append(element);
    }
  }

  function runFrame() {
    const frame = frames.shift();
    expect(frame).toBeDefined();
    act(() => frame?.(16));
  }

  function unmount() {
    if (!isMounted) return;
    isMounted = false;
    act(() => root.unmount());
  }

  beforeEach(() => {
    mocks.traceViewport.mockReset();
    mocks.traceViewportRepeating.mockReset();
    container = document.createElement('div');
    scroller = document.createElement('div');
    document.body.append(container, scroller);
    scroller.getBoundingClientRect = () => rect(0, VIEWPORT_HEIGHT);
    // jsdom leaves this at 0, and the anchor uses it to tell a marker on screen
    // from one past the bottom edge.
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });
    frames = [];
    now = 10_000;
    isOwnedElsewhere = false;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    root = createRoot(container);
    isMounted = true;
    act(() => root.render(
      <Harness
        scroller={scroller}
        isViewportOwnedElsewhere={() => isOwnedElsewhere}
        onApi={next => { api = next; }}
      />,
    ));
  });

  afterEach(() => {
    unmount();
    container.remove();
    scroller.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('puts the anchored Turn back where the reader left it', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980, 'turn-4': 1440 });
    api.captureAnchor();

    // A late measurement above the viewport pushes everything down 880px.
    layoutTurns({ 'turn-3': 1860, 'turn-4': 2320 });

    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1880);
  });

  it('is idempotent, because it restores a relationship and not a delta', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();
    layoutTurns({ 'turn-3': 1860 });

    api.restoreAnchor();
    const settled = scroller.scrollTop;
    api.restoreAnchor();
    api.restoreAnchor();

    expect(scroller.scrollTop).toBe(settled);
  });

  it('reports that it could not answer when there is no anchor', () => {
    layoutTurns({ 'turn-3': 100 });
    // Nothing captured yet: the caller has to fall back on something coarser.
    expect(api.restoreAnchor()).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it('stays out of the way while another writer owns the viewport', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();
    layoutTurns({ 'turn-3': 1860 });

    isOwnedElsewhere = true;

    expect(api.restoreAnchor()).toBe(false);
    expect(scroller.scrollTop).toBe(1000);
  });

  it('keeps an anchor whose Turn is merely not rendered yet', () => {
    /*
     * One frame of absence is the normal case at a history junction: the
     * virtualizer windows from a scroll offset it learns from scroll events, so
     * the commit that prepends is still rendering the position the reader has
     * just been moved off. Dropping there loses the reading position one frame
     * before it could be used.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    layoutTurns({ 'turn-9': 980 });
    expect(api.restoreAnchor()).toBe(false);
    expect(scroller.scrollTop).toBe(1000);

    // The Turn arrives, and the anchor is still the one the reader had.
    layoutTurns({ 'turn-3': 1200, 'turn-9': 980 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1220);
  });

  it('drops an anchor whose Turn has stayed out of the rendered window', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    layoutTurns({ 'turn-9': 980 });
    for (let attempt = 0; attempt < ANCHOR_MISSING_TURN_ATTEMPTS; attempt += 1) {
      expect(api.restoreAnchor()).toBe(false);
    }
    expect(scroller.scrollTop).toBe(1000);

    // Dropped rather than kept: the next scroll anchors to a Turn that is
    // actually on screen, without waiting for an intent event to allow it.
    layoutTurns({ 'turn-9': 1200 });
    api.captureAnchorForScroll();
    layoutTurns({ 'turn-9': 1700 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1500);
  });

  it('carries the anchor through a scroll while its Turn is still unrendered', () => {
    /*
     * The junction case, measured. The anchor was owed 104px, then 140px, then
     * an amount never established; at each one a scroll 77ms later replaced it
     * with a Turn at its displaced position, and two of the three were never
     * corrected at all. The reader is always scrolling here — paging up is what
     * they are doing — so refusing the scroll outright is not an option either.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980, 'turn-9': 3000 });
    api.captureAnchor();

    // History arrives: the transcript has moved 140px further down than it was
    // compensated for, and the reader's own Turn is out of the rendered window,
    // so the displacement cannot be measured yet.
    layoutTurns({ 'turn-9': 3140 });
    expect(api.restoreAnchor()).toBe(false);

    // They keep scrolling up 200px while that repair is still owed. Re-reading
    // the anchor here takes whatever *is* rendered, at its already-displaced
    // position, and the 140px is gone for good.
    scroller.scrollTop = 800;
    api.markUserScrollIntent();
    api.captureAnchorForScroll();

    // Their Turn comes back, still 140px low. Nothing else has moved since, so
    // the whole correction is that 140 — and none of the 200 they scrolled.
    layoutTurns({ 'turn-3': 1120, 'turn-9': 3140 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(940);
  });

  it('reports what a wait for the anchored Turn cost, once, when it ends', async () => {
    /*
     * The wait is what decides whether a junction is seen: a correction that
     * shares the prepend's frame costs nothing, and one a frame later is a
     * visible jump. `attempts` cannot answer how long a wait ran — its trace is
     * coalesced, so only the first of a series is ever emitted — so the whole
     * of it is reported at the one moment it exists.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    layoutTurns({ 'turn-9': 980 });
    api.openSettleWindow();
    runFrame();
    runFrame();
    now += 48;

    layoutTurns({ 'turn-3': 1100, 'turn-9': 980 });
    runFrame();

    const waits = mocks.traceViewport.mock.calls
      .map(([probe]) => probe)
      .filter(probe => probe.location === 'anchor.turnReturned');
    expect(waits).toHaveLength(1);
    expect(waits[0].data()).toMatchObject({
      turnId: 'turn-3',
      outcome: 'returned',
      waitedForMs: 48,
      // Two settle frames ran and still did not find it; the third did.
      waitedFrames: 2,
    });

    // Ended, not merely reported: a second answered frame says nothing more.
    runFrame();
    expect(mocks.traceViewport.mock.calls
      .filter(([probe]) => probe.location === 'anchor.turnReturned')).toHaveLength(1);
  });

  it('re-anchors on a scroll the user drove, and not on one they did not', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980, 'turn-4': 2500 });
    api.captureAnchor();

    // The transcript moved under the reader, with no gesture behind it.
    layoutTurns({ 'turn-3': 1860, 'turn-4': 3380 });
    now += 5_000;
    api.captureAnchorForScroll();
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1880);

    // The reader scrolls on: the position they arrived at is the new anchor,
    // and turn-4 is what they are now looking at.
    scroller.scrollTop = 3400;
    api.markUserScrollIntent();
    now += USER_DRIVEN_SCROLL_WINDOW_MS - 1;
    api.captureAnchorForScroll();

    layoutTurns({ 'turn-3': 2360, 'turn-4': 3880 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(3900);
  });

  it('credits a scroll to the reader when its event arrives after the window', () => {
    /*
     * The window is measured from the *input* event and the scrolling it
     * authorises outlives it: a wheel notch smooth-scrolls for longer than the
     * window, and a busy main thread delivers the scroll event carrying the
     * whole travel after it has closed. Measured over 181 seconds: fourteen
     * gestures, one capture, and seven corrections between 308px and 618px that
     * each returned the viewport to exactly where its gesture had started.
     *
     * Nobody else can account for it — no owner holds the viewport — so it is
     * theirs, and the anchor goes with them rather than undoing them.
     */
    scroller.scrollTop = 1450;
    layoutTurns({ 'turn-3': 1500 });
    api.captureAnchor();

    api.markUserScrollIntent();
    now += USER_DRIVEN_SCROLL_WINDOW_MS * 2;
    scroller.scrollTop = 834;
    api.captureAnchorForScroll();

    // In place, not corrected: their 616px is where they asked to be.
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(834);
  });

  it('leaves a registered writer where it put the viewport, and still repairs', () => {
    /*
     * The other thing that changes `scrollTop`, and it is not drift either: a
     * writer that owns the viewport chose that position, which is the whole
     * point of the register. So its travel is taken out of the correction the
     * same way the reader's is, and what is left is the displacement — here the
     * 100px the transcript really moved while `scrollTop` stood still.
     */
    scroller.scrollTop = 1450;
    layoutTurns({ 'turn-3': 1500 });
    api.captureAnchor();

    isOwnedElsewhere = true;
    now += USER_DRIVEN_SCROLL_WINDOW_MS * 2;
    scroller.scrollTop = 834;
    api.captureAnchorForScroll();
    isOwnedElsewhere = false;

    layoutTurns({ 'turn-3': 1400 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(734);
  });

  it('does not undo a scroll the settle loop beat the scroll event to', () => {
    /*
     * The measured shape, and the one that survived two rounds of fixes. The
     * settle loop reads `scrollTop` from the DOM, a commit opens a window on
     * almost every frame, and the scroll event carrying the reader's travel is
     * delivered after all of that — so a correction runs against a reading
     * position agreed hundreds of pixels ago, with no capture in between.
     *
     * Measured: an anchor agreed at scrollTop 144.7 corrected by -515.8px with
     * the reader at 652.7, of which 7.8px was the transcript actually moving.
     */
    scroller.scrollTop = 144.7;
    layoutTurns({ 'turn-3': 303.5 });
    api.captureAnchor();

    // They scroll 508px and no scroll event has been delivered yet, so nothing
    // re-anchors. Meanwhile the transcript moves 7.8px up underneath them.
    scroller.scrollTop = 652.7;
    layoutTurns({ 'turn-3': 295.7 });

    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBeCloseTo(644.9, 6);
  });

  it('does not bank a frame with nothing to correct as a debt against the reader', () => {
    /*
     * The offset and the viewport position it was agreed at are two halves of
     * one fact, and a frame that advances only one of them leaves the anchor
     * claiming a repair it does not have. It is reached constantly: a frame in
     * which only the reader moved has a correction of exactly zero, so this is
     * the ordinary outcome of a settle rather than a rarity.
     *
     * Measured over one reproduction: a 32px scroll and an 81px scroll, each
     * reported back a frame later as a correction of exactly itself, with the
     * anchored Turn provably not having moved.
     */
    scroller.scrollTop = 414.7;
    layoutTurns({ 'turn-3': 603.9 });
    api.captureAnchor();

    // They scroll 32px. Nothing else moved, so there is nothing to correct.
    scroller.scrollTop = 446.7;
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBeCloseTo(446.7, 6);

    // And still nothing on the frame after it.
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBeCloseTo(446.7, 6);
  });

  it('does not credit a native viewport resume to the reader', () => {
    scroller.scrollTop = 1_000;
    layoutTurns({ 'turn-3': 1_100 });
    api.captureAnchor();

    // A minimized WebView can return with a transient viewport offset before
    // its scroll event arrives. This is host recovery, not a reader choice.
    scroller.scrollTop = 1_132;

    expect(api.restoreAnchorAfterViewportResume()).toBe(true);
    expect(scroller.scrollTop).toBe(1_000);

    // The recovery correction becomes the new baseline, so ordinary settles do
    // not borrow it back as an unclaimed scroll on their next frame.
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1_000);
  });

  it('does not re-owe a correction it has just made', () => {
    /*
     * The same two halves, on the other branch. The shift puts the Turn back at
     * the stored offset, so the position advances by the correction and the
     * offset stays. Get that pair wrong and the repair is read as movement on
     * the frame after it and undone — which only shows up when the reader has
     * travelled since the anchor was agreed, so it is the case a repair made
     * while they are scrolling always falls into.
     */
    scroller.scrollTop = 1_000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    // They scroll 100px with no scroll event delivered to re-anchor them, and
    // the transcript moves 40px down underneath them in the same frame.
    scroller.scrollTop = 1_100;
    layoutTurns({ 'turn-3': 1_020 });
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1_140);

    // Their 100px is theirs and the repair is not movement to undo.
    expect(api.restoreAnchor()).toBe(true);
    expect(scroller.scrollTop).toBe(1_140);
  });

  it('takes a new reading position from where a navigation landed', () => {
    /*
     * A navigation is not a displacement, and standing down for it only
     * postpones the correction. Measured over four clicks on one Turn: the aim
     * placed the viewport at 287px each time, and each time the anchor put it
     * back 1653px away on the first frame after the hold lapsed, still anchored
     * to the Turn the reader had jumped away from.
     */
    scroller.scrollTop = 1894;
    layoutTurns({ 'turn-9': 2295 });
    api.captureAnchor();

    api.reanchorAfterNavigation();
    // Nothing to restore in between, which is the point: the position being
    // left has stopped being the one to put back.
    expect(api.restoreAnchor()).toBe(false);
    expect(scroller.scrollTop).toBe(1894);

    // The aim lands, and the commit that renders it opens a settle window.
    scroller.scrollTop = 287;
    layoutTurns({ 'turn-1': 300, 'turn-9': 2295 });
    api.openSettleWindow();

    // A late measurement moves the transcript under the Turn they navigated to,
    // and the correction is that displacement — not the jump.
    layoutTurns({ 'turn-1': 400, 'turn-9': 2395 });
    runFrame();
    expect(scroller.scrollTop).toBe(387);
  });

  it('re-asserts the anchor across the frames a settle takes', () => {
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    api.openSettleWindow();
    // Nothing has moved yet on the first frame — the heights land later.
    runFrame();
    expect(scroller.scrollTop).toBe(1000);

    layoutTurns({ 'turn-3': 1860 });
    runFrame();
    expect(scroller.scrollTop).toBe(1880);

    // And again, for a second batch of measurements in the same settle.
    layoutTurns({ 'turn-3': 2500 });
    runFrame();
    expect(scroller.scrollTop).toBe(2520);
  });

  it('corrects in the caller\'s own frame, so the displacement is never painted', () => {
    /*
     * Measured at a history junction: the prepend compensation moved the
     * viewport 949px in a layout effect and the anchor took 177px back on the
     * next frame, so every page up was two visible movements. The caller is a
     * layout effect or a ResizeObserver callback — both still beat the paint.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    layoutTurns({ 'turn-3': 1157 });
    api.openSettleWindow();

    expect(scroller.scrollTop).toBe(1177);
    // The window still opens, for the measurements that land after this frame.
    expect(frames).toHaveLength(1);
  });

  it('opens one settle window at a time', () => {
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();

    api.openSettleWindow();
    api.openSettleWindow();
    api.openSettleWindow();

    expect(frames).toHaveLength(1);
  });

  it('winds the settle window down once there is no anchor to keep', () => {
    // No anchor was ever captured, so every frame is a wasted one and the
    // window has to end on its own rather than run forever.
    api.openSettleWindow();
    let ranFrames = 0;
    while (frames.length > 0 && ranFrames < 100) {
      runFrame();
      ranFrames += 1;
    }
    expect(ranFrames).toBeGreaterThan(1);
    expect(frames).toHaveLength(0);
  });

  it('winds the settle window down when the anchor stays in place', () => {
    /*
     * An in-place frame means the relationship is already stable. It spends
     * the remaining settle budget instead of refreshing it, so an open
     * transcript that nobody else is writing to does not keep a RAF loop alive.
     */
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    api.openSettleWindow();

    let ranFrames = 0;
    while (frames.length > 0 && ranFrames < 60) {
      runFrame();
      ranFrames += 1;
    }

    expect(ranFrames).toBe(ANCHOR_SETTLE_FRAMES);
    expect(frames).toHaveLength(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it('does not renew the frame budget for identical resize notifications', () => {
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    api.openSettleWindow('resize');
    for (let i = 0; i < ANCHOR_SETTLE_FRAMES; i += 1) {
      api.openSettleWindow('resize');
      runFrame();
    }
    expect(frames).toHaveLength(0);
    // Same total height does not mean the anchored content stayed put.
    layoutTurns({ 'turn-3': 120 });
    api.openSettleWindow('resize');
    expect(scroller.scrollTop).toBe(20);
    expect(frames).toHaveLength(1);
  });

  it('stops retrying a clamped correction until the geometry changes', () => {
    let top = 0;
    const writes = vi.fn((value: number) => { top = Math.max(0, value); });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true, get: () => top, set: writes,
    });
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    layoutTurns({ 'turn-3': 80 });
    api.openSettleWindow();
    for (let i = 0; i < ANCHOR_SETTLE_FRAMES; i += 1) runFrame();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    // A real displacement makes a new, now satisfiable correction.
    layoutTurns({ 'turn-3': 120 });
    api.openSettleWindow('resize');
    expect(scroller.scrollTop).toBe(20);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('continues partial corrections when they reduce the residual', () => {
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true, get: () => top,
      set: (value: number) => { top += (value - top) / 2; },
    });
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    layoutTurns({ 'turn-3': 108 });
    api.openSettleWindow();
    for (let i = 0; i < 4; i += 1) runFrame();
    expect(Math.abs(scroller.scrollTop - 8)).toBeLessThan(0.5);
  });

  it('reports reversals without suppressing valid late layout corrections', () => {
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    api.openSettleWindow('items');
    for (let i = 0; i < 30; i += 1) {
      layoutTurns({ 'turn-3': i % 2 === 0 ? 108 : 100 });
      runFrame();
    }
    expect(scroller.scrollTop).toBe(0);
    const results = mocks.traceViewportRepeating.mock.calls
      .map(([, probe]) => probe).filter(probe => probe.location === 'anchor.correctionResult');
    expect(results).toHaveLength(30);
    expect(results.at(-1)?.data()).toMatchObject({
      source: 'items', requestedPx: -8, appliedPx: -8, residualPx: 0,
      improved: true, correctionCount: 30, reversalCount: 29, cumulativeTravelPx: 240,
    });
    for (let i = 0; i < ANCHOR_SETTLE_FRAMES; i += 1) runFrame();
    expect(frames).toHaveLength(0);
  });

  it('winds the settle window down while another owner holds the viewport', () => {
    /*
     * Measured: 27 seconds of `anchor.stoodDown`, one per frame, with the
     * viewport parked at 985.3 and follow-output resting on it — which at the
     * tail is where it lives, not a transient. The loop read the missing-Turn
     * count left by the frame *before* the stand-down as evidence it was still
     * waiting for something, and refreshed its own budget on it; that count can
     * only advance on a frame that does not stand down, so the one condition
     * jammed the loop and made its only exit unreachable. It ended when the
     * reader scrolled, and not before.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    // The anchored Turn leaves the rendered window, and then another writer
    // takes the viewport — the order that left a stale count behind.
    layoutTurns({ 'turn-9': 980 });
    api.openSettleWindow();
    runFrame();
    isOwnedElsewhere = true;

    let ranFrames = 0;
    while (frames.length > 0 && ranFrames < 200) {
      runFrame();
      ranFrames += 1;
    }

    expect(ranFrames).toBeLessThanOrEqual(ANCHOR_SETTLE_FRAMES);
    expect(frames).toHaveLength(0);
    // Given up on nothing: the reader is still owed a correction, and the
    // carry that depends on this count still has to work when the owner lets
    // go and the transcript moves again.
    expect(scroller.scrollTop).toBe(1000);
  });

  it('does not count a frame it stood down on as a frame spent waiting', () => {
    /*
     * `waitedFrames` is read as painted frames the reader spent in the wrong
     * place. Frames the anchor never looked on are not that, and counting them
     * reported a 6609-frame wait for a reading position that was correct
     * throughout.
     */
    scroller.scrollTop = 1000;
    layoutTurns({ 'turn-3': 980 });
    api.captureAnchor();

    layoutTurns({ 'turn-9': 980 });
    api.openSettleWindow();
    runFrame();

    isOwnedElsewhere = true;
    for (let index = 0; index < 5; index += 1) runFrame();

    isOwnedElsewhere = false;
    layoutTurns({ 'turn-3': 1100, 'turn-9': 980 });
    runFrame();

    const waits = mocks.traceViewport.mock.calls
      .map(([probe]) => probe)
      .filter(probe => probe.location === 'anchor.turnReturned');
    expect(waits).toHaveLength(1);
    expect(waits[0].data()).toMatchObject({ waitedFrames: 1 });
  });

  it('stops re-asserting after the component goes away', () => {
    layoutTurns({ 'turn-3': 100 });
    api.captureAnchor();
    api.openSettleWindow();

    unmount();

    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
