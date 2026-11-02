import { describe, expect, it, vi } from 'vitest';
import {
  createCompanionWindowResizer,
  isCompanionViewportShort,
  type CompanionWindowSize,
} from './agentCompanionWindowResize';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('createCompanionWindowResizer', () => {
  it('keeps one request in flight and sends only the latest size afterwards', async () => {
    const calls: Array<{ size: CompanionWindowSize; done: ReturnType<typeof deferred> }> = [];
    const send = vi.fn((size: CompanionWindowSize) => {
      const done = deferred();
      calls.push({ size, done });
      return done.promise;
    });
    const resizer = createCompanionWindowResizer(send, vi.fn());

    resizer.request({ width: 96, height: 110 });
    resizer.request({ width: 288, height: 110 });
    resizer.request({ width: 96, height: 110 });
    resizer.request({ width: 288, height: 120 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(resizer.target()).toEqual({ width: 288, height: 120 });

    calls[0].done.resolve();
    await flush();
    // The stale intermediate sizes never reach the host, so none can land last.
    expect(send.mock.calls.map(([size]) => size)).toEqual([
      { width: 96, height: 110 },
      { width: 288, height: 120 },
    ]);

    calls[1].done.resolve();
    await flush();
    resizer.request({ width: 96, height: 110 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('keeps draining after a failed request', async () => {
    const first = deferred();
    const send = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const resizer = createCompanionWindowResizer(send, onError);

    resizer.request({ width: 96, height: 110 });
    resizer.request({ width: 288, height: 110 });
    first.reject(new Error('host busy'));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ width: 288, height: 110 });
  });
});

describe('isCompanionViewportShort', () => {
  it('ignores sub-pixel rounding but flags a viewport the dock overflows', () => {
    const target = { width: 288, height: 110 };
    expect(isCompanionViewportShort({ width: 287.2, height: 109.6 }, target)).toBe(false);
    expect(isCompanionViewportShort({ width: 300, height: 120 }, target)).toBe(false);
    expect(isCompanionViewportShort({ width: 96, height: 110 }, target)).toBe(true);
    expect(isCompanionViewportShort({ width: 288, height: 96 }, target)).toBe(true);
  });
});
