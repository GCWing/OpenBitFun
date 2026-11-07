import { describe, expect, it } from 'vitest';
import { GEOMETRY, IDLE_WAVE_MODES, idleWaveLines, MARK, MARK_RADIUS, SOURCE_PATHS, toPolyline, TRANSITION_SPRING, workingCoreStrokeWidth, workingHoverLines } from './geometry';
import { LivingLineEngine } from './engine';

describe('LivingLine geometry and engine', () => {
  it('uses the approved v0.4 SVG paths and fixed anchors', () => {
    expect(SOURCE_PATHS.working).toContain('M60.5,84L76,84L83,80L90,84');
    expect(SOURCE_PATHS.question).toMatch(/^M60.5,84C/);
    expect(SOURCE_PATHS.question).toContain('149,53.25');
    expect(SOURCE_PATHS.error).toContain('128,36');
    expect(GEOMETRY.working[0].x).toBe(60.5);
    expect(GEOMETRY.working.at(-1)?.x).toBe(195.5);
    for (const state of ['working', 'question', 'error'] as const) {
      expect(GEOMETRY[state][0]).toEqual({ x: 60.5, y: 84 });
      expect(GEOMETRY[state].at(-1)).toEqual({ x: 195.5, y: 84 });
    }
  });
  it('flattens the approved paths to shared M/L vertices while retaining landmarks', () => {
    const lengths = new Set(Object.values(GEOMETRY).map(points => points.length));
    expect(lengths.size).toBe(1);
    expect(GEOMETRY.working.length).toBeGreaterThan(128);
    const d = toPolyline(GEOMETRY.working);
    expect(d.match(/[A-Z]/g)).toEqual(['M', ...Array(GEOMETRY.working.length - 1).fill('L')]);
    expect(GEOMETRY.working).toContainEqual({ x: 116, y: 58 });
    expect(GEOMETRY.working).toContainEqual({ x: 123, y: 95 });
  });
  it('uses matching hollow-ring sizes and a fixed center from the approved assets', () => {
    expect(MARK).toMatchObject({ cx: 128, cy: 106, questionRadius: 4.2, errorRadius: 4.8, strokeWidth: 3.2 });
    expect(MARK_RADIUS).toMatchObject({ idle: 0, working: 0, question: 4.2, error: 4.8 });
  });
  it('generates varied idle waves with fixed anchors and optional second line', () => {
    const single = idleWaveLines(GEOMETRY.idle, 0.8, IDLE_WAVE_MODES[0]);
    const layered = idleWaveLines(GEOMETRY.idle, 0.8, IDLE_WAVE_MODES[1]);
    const split = idleWaveLines(GEOMETRY.idle, 0.8, IDLE_WAVE_MODES[1], true);
    expect(single).toHaveLength(1);
    expect(layered).toHaveLength(2);
    expect(split).toHaveLength(3);
    expect(new Set(split.map(toPolyline)).size).toBe(3);
    for (const line of [...single, ...layered, ...split]) {
      expect(line[0]).toEqual(GEOMETRY.idle[0]);
      expect(line.at(-1)).toEqual(GEOMETRY.idle.at(-1));
    }
    expect(new Set(IDLE_WAVE_MODES.map(mode => `${mode.cycles}:${mode.amplitude}`)).size).toBeGreaterThan(1);
    const sparse = idleWaveLines([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 0.8, IDLE_WAVE_MODES[1])[0];
    const dense = idleWaveLines([{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 50, y: 0 }, { x: 88, y: 0 }, { x: 100, y: 0 }], 0.8, IDLE_WAVE_MODES[1])[0];
    expect(sparse[1].y).toBeCloseTo(dense[2].y, 8);
  });
  it('thickens the working core continuously as split lines merge', () => {
    expect(workingCoreStrokeWidth(1)).toBeCloseTo(1.792, 3);
    expect(workingCoreStrokeWidth(0.5)).toBeCloseTo(2.496, 3);
    expect(workingCoreStrokeWidth(0)).toBe(3.2);
    expect(workingCoreStrokeWidth(-1)).toBe(3.2);
    expect(workingCoreStrokeWidth(2)).toBeCloseTo(1.792, 3);
  });
  it('creates three distinct M/L hover ECGs with matching endpoints', () => {
    const paths = workingHoverLines(GEOMETRY.working, 0.8);
    expect(paths).toHaveLength(3);
    expect(new Set(paths.map(toPolyline)).size).toBe(3);
    for (const points of paths) {
      expect(points[0]).toEqual(GEOMETRY.working[0]);
      expect(points.at(-1)).toEqual(GEOMETRY.working.at(-1));
      expect(toPolyline(points)).not.toMatch(/[CQASTZ]/i);
    }
  });
  it('uses a slower transition spring while preserving its damped response', () => {
    expect(TRANSITION_SPRING).toEqual({ stiffness: 66.7, damping: 16 });
    const engine = new LivingLineEngine();
    engine.setState('working');
    for (let i = 0; i < 30; i++) engine.step(1 / 60);
    expect(engine.settled).toBe(false);
    for (let i = 0; i < 900; i++) engine.step(1 / 60);
    expect(engine.settled).toBe(true);
  });
  it('keeps both endpoints fixed during updates', () => {
    const engine = new LivingLineEngine();
    const before = engine.getPoints();
    engine.setState('working');
    const after = engine.step(1 / 60);
    expect(after[0]).toEqual(before[0]);
    expect(after.at(-1)).toEqual(before.at(-1));
  });
  it('eases the hollow dot from invisible center to its approved radius', () => {
    const engine = new LivingLineEngine();
    expect(engine.getMarkRadius()).toBe(0);
    engine.setState('question');
    engine.step(1 / 60);
    expect(engine.getMarkRadius()).toBeGreaterThan(0);
    expect(engine.getMarkRadius()).toBeLessThan(MARK.questionRadius);
    for (let i = 0; i < 600; i++) engine.step(1 / 60);
    expect(engine.getMarkRadius()).toBeCloseTo(MARK.questionRadius, 2);
  });
  it('springs the fixed-center ring back to an invisible point on exit', () => {
    const engine = new LivingLineEngine();
    engine.setState('error');
    for (let i = 0; i < 240; i++) engine.step(1 / 60);
    expect(engine.getMarkRadius()).toBeCloseTo(MARK.errorRadius, 2);
    engine.setState('idle');
    expect(engine.getMarkRadius()).toBeGreaterThan(0);
    for (let i = 0; i < 240; i++) engine.step(1 / 60);
    expect(engine.getMarkRadius()).toBe(0);
  });
  it('jumps directly to targets when reduced motion is enabled', () => {
    const engine = new LivingLineEngine();
    engine.setReducedMotion(true);
    engine.setState('error');
    expect(engine.settled).toBe(true);
    expect(engine.getMarkRadius()).toBe(MARK.errorRadius);
    expect(engine.step(1 / 60)).toEqual(engine.getPoints());
  });
});
