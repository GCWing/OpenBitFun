import { describe, expect, it, vi } from 'vitest';
import { BoundedResourceCache } from './BoundedResourceCache';

describe('derived resource residency', () => {
  it('evicts least recently read entries by bytes, then by count, and disposes once', () => {
    const dispose = vi.fn();
    const cache = new BoundedResourceCache<string, string>(10, 2, dispose);
    cache.set('a', 'A', 4).set('b', 'B', 4);
    cache.get('a');
    cache.set('c', 'C', 4);
    expect(cache.has('b')).toBe(false);
    expect(dispose.mock.calls).toEqual([['B']]);
    cache.set('d', 'D', 8);
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(8);
    cache.clear();
    expect(dispose.mock.calls.flat()).toEqual(['B', 'A', 'C', 'D']);
    expect(cache.byteSize).toBe(0);
  });
});
