import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { createSettingsReadCache } from './SettingsReadCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('settings runtime read snapshots', () => {
  beforeEach(() => activateSurface('local'));

  it('deduplicates simultaneous reads and revalidates a warm snapshot', async () => {
    const cache = createSettingsReadCache<number>();
    const first = deferred<number>();
    const read = vi.fn(() => first.promise);
    const pending = cache.read(read);
    expect(cache.read(read)).toBe(pending);
    first.resolve(1);
    await pending;
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.peek()).toBe(1);
    await cache.read(async () => 2);
    expect(cache.peek()).toBe(2);
    await expect(cache.read(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(cache.peek()).toBe(2);
  });

  it('isolates different query identities and ignores superseded reads', async () => {
    const cache = createSettingsReadCache<number>();
    const old = deferred<number>();
    const pending = cache.read(() => old.promise, 'month');
    await cache.read(async () => 2, 'week');
    old.resolve(1);
    await pending;
    expect(cache.peek('month')).toBeUndefined();
    expect(cache.peek('week')).toBe(2);
  });

  it('does not reveal a previous device snapshot or accept its late response', async () => {
    const cache = createSettingsReadCache<number>();
    await cache.read(async () => 1);
    const old = deferred<number>();
    const pending = cache.read(() => old.promise);
    await Promise.resolve();
    activateSurface('peer');
    expect(cache.peek()).toBeUndefined();
    const rejection = expect(pending).rejects.toMatchObject({ isSurfaceChangedError: true });
    old.resolve(3);
    await rejection;
    await cache.read(async () => 2);
    expect(cache.peek()).toBe(2);
  });

  it('does not restore a snapshot invalidated during a read', async () => {
    const cache = createSettingsReadCache<number>();
    const old = deferred<number>();
    const pending = cache.read(() => old.promise);
    cache.invalidate();
    old.resolve(1);
    await pending;
    expect(cache.peek()).toBeUndefined();
  });
});
