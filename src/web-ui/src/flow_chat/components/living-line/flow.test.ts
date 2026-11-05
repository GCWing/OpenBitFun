import { describe, expect, it } from 'vitest';
import { approachFlowOpacity, polylineLength, sliceFlowHighlight } from './flow';

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

describe('arc-length flow highlight', () => {
  it('measures the rendered path rather than its vertex count', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 13, y: 4 }])).toBe(15);
  });
  it('moves a fixed-length segment at equal arc distance across unequal edges', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 9 }];
    const first = sliceFlowHighlight(path, 0.2, 2);
    const second = sliceFlowHighlight(path, 0.4, 2);
    expect(polylineLength(first)).toBeCloseTo(2, 3);
    expect(polylineLength(second)).toBeCloseTo(2, 3);
    expect(first.at(-1)!.x).toBeGreaterThan(0);
    expect(second.at(-1)!.y).toBeGreaterThan(first.at(-1)!.y);
  });
  it('leaves the path empty during the full off-path loop gap', () => {
    const path = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
    expect(sliceFlowHighlight(path, 0, 5)).toEqual([]);
    expect(sliceFlowHighlight(path, 0.9, 5)).toEqual([]);
    expect(sliceFlowHighlight(path, 0.5, 5).length).toBeGreaterThan(0);
  });
  it('fades streamlines smoothly when the active line count changes', () => {
    const entering = approachFlowOpacity(0, true, 1 / 60);
    const leaving = approachFlowOpacity(1, false, 1 / 60);
    expect(entering).toBeGreaterThan(0);
    expect(entering).toBeLessThan(1);
    expect(leaving).toBeGreaterThan(0);
    expect(leaving).toBeLessThan(1);
    expect(approachFlowOpacity(entering, true, 1 / 60)).toBeGreaterThan(entering);
  });
  it('returns nothing for degenerate paths and hotspot lengths', () => {
    expect(sliceFlowHighlight([{ x: 1, y: 1 }], 0.5, 5)).toEqual([]);
    expect(sliceFlowHighlight([{ x: 0, y: 0 }, { x: 0, y: 0 }], 0.5, 5)).toEqual([]);
    expect(sliceFlowHighlight([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.5, 0)).toEqual([]);
  });
});
