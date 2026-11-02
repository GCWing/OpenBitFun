// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavResize } from './useNavResize';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('navigation resize interaction', () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let now: number;
  let reducedMotion: boolean;
  let preferenceChanged: () => void;
  let committed: ReturnType<typeof vi.fn>;
  let collapse: ReturnType<typeof vi.fn>;
  let captured: Set<number>;

  function Harness({ collapsed = false }: { collapsed?: boolean }) {
    const [width, setWidth] = useState(300);
    const areaRef = useRef<HTMLDivElement>(null);
    const dividerRef = useRef<HTMLDivElement>(null);
    const gripRef = useRef<SVGPathElement>(null);
    const handlers = useNavResize({
      areaRef, dividerRef, gripRef, width, minWidth: 216, maxWidth: 480,
      collapseThreshold: 64, collapsed,
      onWidthChange: value => { committed(value); setWidth(value); }, onCollapse: collapse,
    });
    return <>
      <div data-testid="area" ref={areaRef} style={{ '--nav-width': `${width}px` } as React.CSSProperties} />
      {!collapsed && <div data-testid="divider" ref={dividerRef} {...handlers} style={{ '--nav-width': `${width}px` } as React.CSSProperties}>
        <svg><path ref={gripRef} d="M 24 44 L 24 76" strokeWidth="3" /></svg>
      </div>}
    </>;
  }

  const area = () => container.querySelector<HTMLElement>('[data-testid="area"]')!;
  const divider = () => container.querySelector<HTMLElement>('[data-testid="divider"]')!;
  const grip = () => container.querySelector('path')!;
  const geometry = () => grip().getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const shape = () => {
    const points = geometry();
    return {
      centerX: points.length === 4 ? (points[0] + points[2]) / 2
        : (points[0] + 3 * points[2] + 3 * points[4] + points[6]) / 8,
      endX: points[0],
      height: points.at(-1)! - points[1],
      thickness: Number(grip().getAttribute('stroke-width')),
    };
  };
  const render = (collapsed = false) => act(() => root.render(<Harness collapsed={collapsed} />));
  function pointer(type: string, x: number, pointerId = 1, button = 0) {
    act(() => {
      const event = new MouseEvent(type, { clientX: x, button, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      (type === 'pointerdown' || type === 'lostpointercapture' ? divider() : window).dispatchEvent(event);
    });
  }
  const key = (value: string, shiftKey = false) => act(() => divider().dispatchEvent(
    new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }),
  ));
  const paint = (count = 1, interval = 16) => act(() => {
    for (let i = 0; i < count; i++) {
      now += interval;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(now));
    }
  });

  beforeEach(() => {
    frames = new Map(); nextFrame = 0; now = 0; reducedMotion = false;
    committed = vi.fn(); collapse = vi.fn(); captured = new Set();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback); return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return reducedMotion; },
      addEventListener: (_event: string, callback: () => void) => { preferenceChanged = callback; },
      removeEventListener: vi.fn(),
    }));
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    render();
    Object.assign(divider(), {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    });
  });

  afterEach(() => {
    act(() => root.unmount()); container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.userSelect = '';
  });

  it('keeps width under the pointer while the grip bends, then springs back and stops scheduling frames', () => {
    pointer('pointerdown', 300); pointer('pointermove', 370); paint();
    expect(area().style.getPropertyValue('--nav-width')).toBe('370px');
    expect(divider().style.getPropertyValue('--nav-width')).toBe('370px');
    expect(shape().centerX).toBeGreaterThan(24);
    expect(committed).not.toHaveBeenCalled();
    pointer('pointerup', 382);
    expect(committed).toHaveBeenCalledExactlyOnceWith(382);
    expect(divider().getAttribute('data-resize-feedback')).toBe('settling');
    paint(100);
    expect(shape().centerX).toBe(24);
    expect(shape().height).toBe(32);
    expect(shape().thickness).toBe(3);
    expect(divider().hasAttribute('data-resize-feedback')).toBe(false);
    expect(frames.size).toBe(0);
    expect(captured.size).toBe(0);
  });

  it.each([-1, 1])('starts on the boundary and separates progressively toward a %s pull, including reversals', direction => {
    expect(shape().centerX).toBe(24);
    expect(shape().endX).toBe(24);
    pointer('pointerdown', 300);
    paint(6);
    expect(shape().centerX).toBe(24);
    expect(shape().endX).toBe(24);
    let firstSeparation = 0;
    for (let i = 1; i <= 6; i++) {
      now += 16;
      pointer('pointermove', 300 + direction * i * 10);
      paint();
      if (i === 1) firstSeparation = (shape().endX - 24) * direction;
    }
    expect(firstSeparation).toBeGreaterThan(0);
    expect((shape().endX - 24) * direction).toBeGreaterThan(firstSeparation);
    expect((shape().endX - 24) * direction).toBeGreaterThan(1);
    expect((shape().centerX - 24) * direction).toBeGreaterThan(1.5);
    expect(Math.abs(shape().centerX - 24)).toBeLessThan(8);
    for (let i = 1; i <= 6; i++) {
      now += 16;
      pointer('pointermove', 300 + direction * (60 - i * 10));
      paint();
    }
    expect((shape().centerX - 24) * direction).toBeLessThan(-1.5);
    expect(committed).not.toHaveBeenCalled();
    pointer('pointerup', 300); paint(100);
    expect(shape().endX).toBe(24);
    expect(shape().centerX).toBe(24);
    expect(frames.size).toBe(0);
  });

  it('gives a visible stretch and a small release recoil, with a constant stroke width', () => {
    pointer('pointerdown', 300);
    for (let i = 1; i <= 10; i++) {
      now += 16;
      pointer('pointermove', 300 + i * 12);
      paint();
      expect(shape().thickness).toBe(3);
    }
    expect(shape().height).toBeGreaterThan(50);
    expect(shape().height).toBeLessThanOrEqual(74);
    paint(90);
    expect(shape().centerX).toBe(24);
    expect(shape().height).toBe(32);
    expect(shape().thickness).toBe(3);

    // Releasing a fresh pull gives a small recoil, capped at two pixels.
    pointer('pointermove', 460); paint(5);
    const pulledHeight = shape().height;
    pointer('pointerup', 460);
    const heights: number[] = [];
    for (let i = 0; i < 100; i++) {
      paint(); heights.push(shape().height);
      expect(shape().thickness).toBe(3);
    }
    expect(pulledHeight).toBeGreaterThan(40);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(30);
    expect(Math.min(...heights)).toBeLessThan(31.8);
    expect(Math.max(...heights)).toBeLessThanOrEqual(74);
    expect(shape().height).toBe(32);
    expect(shape().thickness).toBe(3);
    expect(frames.size).toBe(0);
  });

  it('gives the same pull feedback when pointer events are coalesced or delivered more frequently', () => {
    const drag = (samplesPerFrame: number) => {
      pointer('pointerdown', 300);
      for (let frame = 0; frame < 10; frame++) {
        for (let sample = 1; sample <= samplesPerFrame; sample++) {
          now += 16 / samplesPerFrame;
          pointer('pointermove', 300 + (frame + sample / samplesPerFrame) * 8);
        }
        paint(1, 0);
      }
      const result = shape();
      pointer('pointercancel', 380);
      return result;
    };
    const coalesced = drag(1);
    const frequent = drag(4);
    expect(frequent.centerX).toBeCloseTo(coalesced.centerX, 5);
    expect(frequent.height).toBeCloseTo(coalesced.height, 5);
    expect(frequent.thickness).toBeCloseTo(coalesced.thickness, 5);
  });

  it('flushes the final release and a return to the old width even between animation frames', () => {
    pointer('pointerdown', 300); pointer('pointermove', 360); paint();
    pointer('pointerup', 300);
    expect(area().style.getPropertyValue('--nav-width')).toBe('300px');
    expect(divider().style.getPropertyValue('--nav-width')).toBe('300px');
    expect(committed).toHaveBeenCalledExactlyOnceWith(300);
    pointer('pointerdown', 300); pointer('pointerup', 410);
    expect(committed).toHaveBeenLastCalledWith(410);
    expect(area().style.getPropertyValue('--nav-width')).toBe('410px');
  });

  it('adds bounded elastic resistance at both limits and preserves drag-to-collapse', () => {
    pointer('pointerdown', 300); pointer('pointermove', 10000); paint(100);
    expect(area().style.getPropertyValue('--nav-width')).toBe('480px');
    expect(shape().centerX).toBeGreaterThan(24);
    expect(shape().centerX).toBeLessThan(44.4);
    pointer('pointermove', 180); paint(100);
    expect(area().style.getPropertyValue('--nav-width')).toBe('216px');
    expect(shape().centerX).toBeLessThan(24);
    expect(collapse).not.toHaveBeenCalled();
    pointer('pointermove', 152); pointer('pointerup', 100);
    expect(collapse).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledExactlyOnceWith(216);
    expect(frames.size).toBe(0);
  });

  it.each(['pointercancel', 'lostpointercapture', 'Escape', 'blur', 'resize', 'collapse', 'unmount'])(
    'restores geometry, selection and capture without committing when interrupted by %s', reason => {
      document.body.style.userSelect = 'text';
      pointer('pointerdown', 300); pointer('pointermove', 380); paint();
      if (reason === 'Escape') key('Escape');
      else if (reason === 'blur' || reason === 'resize') act(() => window.dispatchEvent(new Event(reason)));
      else if (reason === 'collapse') render(true);
      else if (reason === 'unmount') act(() => root.render(null));
      else pointer(reason, 380);
      if (reason !== 'unmount') expect(area().style.getPropertyValue('--nav-width')).toBe('300px');
      expect(committed).not.toHaveBeenCalled();
      expect(collapse).not.toHaveBeenCalled();
      expect(document.body.style.userSelect).toBe('text');
      expect(document.body.classList.contains('openbitfun-is-resizing-nav')).toBe(false);
      expect(document.body.classList.contains('openbitfun-is-dragging-nav-collapse')).toBe(false);
      expect(captured.size).toBe(0);
      expect(frames.size).toBe(0);
      pointer('pointerup', 400);
      expect(committed).not.toHaveBeenCalled();
    },
  );

  it('ignores secondary buttons and other pointers throughout an active drag', () => {
    pointer('pointerdown', 300, 1, 2);
    expect(captured.size).toBe(0);
    pointer('pointerdown', 300);
    pointer('pointerdown', 200, 2); pointer('pointermove', 100, 2);
    pointer('pointercancel', 100, 2); pointer('pointerup', 100, 2);
    expect(committed).not.toHaveBeenCalled();
    expect(captured.has(1)).toBe(true);
    pointer('pointerup', 340);
    expect(committed).toHaveBeenCalledExactlyOnceWith(340);
  });

  it('can reverse rapidly and re-grab during the release spring without stale commits', () => {
    pointer('pointerdown', 300);
    for (const x of [440, 220, 460, 240, 400]) {
      pointer('pointermove', x); paint();
      expect(shape().centerX).toBeGreaterThanOrEqual(3.6);
      expect(shape().centerX).toBeLessThanOrEqual(44.4);
    }
    pointer('pointerup', 400); paint(2);
    pointer('pointerdown', 400); pointer('pointerup', 360); paint(100);
    expect(committed.mock.calls).toEqual([[400], [360]]);
    expect(area().style.getPropertyValue('--nav-width')).toBe('360px');
    expect(frames.size).toBe(0);
  });

  it('keeps resizing available with reduced motion and settles immediately when the preference changes', () => {
    pointer('pointerdown', 300); pointer('pointermove', 360); paint();
    reducedMotion = true; act(() => preferenceChanged());
    expect(frames.size).toBe(0);
    expect(shape().centerX).toBe(24);
    pointer('pointermove', 390); pointer('pointerup', 390);
    expect(committed).toHaveBeenCalledExactlyOnceWith(390);
    expect(area().style.getPropertyValue('--nav-width')).toBe('390px');
    expect(frames.size).toBe(0);
  });

  it('supports keyboard width changes without decorative motion', () => {
    key('ArrowLeft'); expect(committed).toHaveBeenLastCalledWith(290);
    key('ArrowRight', true); expect(committed).toHaveBeenLastCalledWith(330);
    key('Home'); expect(committed).toHaveBeenLastCalledWith(216);
    key('ArrowLeft'); expect(committed).toHaveBeenLastCalledWith(216);
    key('End'); expect(committed).toHaveBeenLastCalledWith(480);
    expect(frames.size).toBe(0);
  });
});
