import { describe, expect, it, vi } from 'vitest';
import { cancelOverflowMeasurement, scheduleOverflowMeasurement } from '../../../../../design-system/packages/ui/src/primitives/OverflowText/overflowMeasurementQueue';

function harness() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const errors: Array<() => void> = [];
  const view = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (key: number) => frames.delete(key),
    setTimeout: (callback: () => void) => { errors.push(callback); return errors.length; },
  } as unknown as Window;
  const flush = () => {
    const batch = [...frames.values()];
    frames.clear();
    batch.forEach(callback => callback(0));
  };
  return { view, frames, errors, flush };
}

describe('overflow measurement scheduling', () => {
  it('preserves a reentrant request and discards its superseded result', () => {
    const h = harness();
    const publish = vi.fn();
    let reads = 0;
    const read = () => {
      if (++reads === 1) scheduleOverflowMeasurement(h.view, read);
      return publish;
    };
    scheduleOverflowMeasurement(h.view, read);
    h.flush();
    expect(publish).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(reads).toBe(2);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('retains requests scheduled while publishing results', () => {
    const h = harness();
    let published = 0;
    const read = () => () => {
      if (++published === 1) scheduleOverflowMeasurement(h.view, read);
    };
    scheduleOverflowMeasurement(h.view, read);
    h.flush();
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(published).toBe(2);
  });

  it('cancels an already-read result and a next-frame request', () => {
    const h = harness();
    const publish = vi.fn();
    const first = () => publish;
    scheduleOverflowMeasurement(h.view, first);
    scheduleOverflowMeasurement(h.view, () => {
      scheduleOverflowMeasurement(h.view, first);
      cancelOverflowMeasurement(h.view, first);
      return undefined;
    });
    h.flush();
    expect(publish).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(0);
  });

  it('isolates read and publication errors without suppressing reporting', () => {
    const h = harness();
    const good = vi.fn();
    scheduleOverflowMeasurement(h.view, () => { throw new Error('read failed'); });
    scheduleOverflowMeasurement(h.view, () => () => { throw new Error('publish failed'); });
    scheduleOverflowMeasurement(h.view, () => good);
    h.flush();
    expect(good).toHaveBeenCalledOnce();
    expect(h.errors).toHaveLength(2);
    expect(h.errors[0]).toThrow('read failed');
    expect(h.errors[1]).toThrow('publish failed');
    scheduleOverflowMeasurement(h.view, () => good);
    h.flush();
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('keeps document windows independent', () => {
    const a = harness();
    const b = harness();
    const publish = vi.fn();
    const read = () => publish;
    scheduleOverflowMeasurement(a.view, read);
    scheduleOverflowMeasurement(b.view, read);
    cancelOverflowMeasurement(a.view, read);
    b.flush();
    expect(publish).toHaveBeenCalledOnce();
  });
});
