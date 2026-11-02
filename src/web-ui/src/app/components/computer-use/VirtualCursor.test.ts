import { describe, expect, it } from 'vitest';
import { VirtualCursor } from './VirtualCursor';
import reference from './cursor-reference.json';

describe('computer-use-rust cursor parity', () => {
  it('matches the unmodified Rust implementation through short/long/edge moves, interruption, hide, resize and reduced motion', () => {
    const cursor = new VirtualCursor(...reference.viewport as [number, number]);
    for (const [index, sample] of reference.samples.entries()) {
      const op = sample.operation;
      switch (op.kind) {
        case 'move': cursor.moveTo({ x: op.x!, y: op.y! }, op.sequence!, op.animate!); break;
        case 'advance': cursor.advance(op.dt!); break;
        case 'hide': cursor.hide(); break;
        case 'resize': cursor.resize(op.width!, op.height!); break;
        case 'reset': cursor.reset(); break;
        default: throw new Error(`Unknown reference operation ${op.kind}`);
      }
      const p = cursor.position(), v = cursor.visual();
      const values = [p.x, p.y, v.opacity, v.scaleX, v.scaleY, v.rotation, v.axisRotation, v.axisScale, v.blur];
      values.forEach((value, component) => expect(value, `sample ${index}, component ${component}`).toBeCloseTo(sample.values[component], 7));
      expect(cursor.takeArrival() ?? null).toBe(sample.arrival);
      expect(cursor.needsAnimation()).toBe(sample.animating);
    }
  });
  it('rejects malformed/stale movement before changing state and retains sequence across reset', () => {
    const cursor = new VirtualCursor(300, 200);
    cursor.moveTo({ x: 10, y: 20 }, 1);
    cursor.moveTo({ x: 270, y: 160 }, 2);
    const previous = cursor.target();
    expect(() => cursor.moveTo({ x: Infinity, y: 1 }, 3)).toThrow('invalid_cursor_geometry');
    expect(() => cursor.resize(NaN, 200)).toThrow();
    expect(() => cursor.advance(-1)).toThrow();
    expect(cursor.target()).toEqual(previous);
    cursor.reset();
    expect(() => cursor.moveTo({ x: 1, y: 2 }, 2)).toThrow('stale_cursor_sequence');
    expect(cursor.takeArrival()).toBeUndefined();
    expect(cursor.visual().opacity).toBe(0);
  });
  it('does not depend on frame partition and never emits an obsolete visual arrival', () => {
    const a = new VirtualCursor(1200, 800), b = new VirtualCursor(1200, 800);
    for (const c of [a, b]) { c.moveTo({ x: 100, y: 100 }, 1); c.takeArrival(); c.moveTo({ x: 1100, y: 650 }, 2); }
    a.advance(0.2); for (let i = 0; i < 24; i++) b.advance(1 / 120);
    expect(a.position().x).toBeCloseTo(b.position().x, 8);
    a.moveTo({ x: 500, y: 500 }, 3); a.hide(); a.advance(1);
    expect(a.takeArrival()).toBeUndefined();
  });
});
