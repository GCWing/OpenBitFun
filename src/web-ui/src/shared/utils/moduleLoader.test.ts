import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModuleLoader, importWithRetry, isModuleLoadError } from './moduleLoader';

afterEach(() => vi.useRealTimers());

describe('module loading', () => {
  it('recognizes module fetch and CSS preload failures without treating generic fetch/render errors as imports', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: http://localhost:1422/view.tsx',
      'Importing a module script failed.',
      'error loading dynamically imported module: https://example.test/assets/view.js',
    ]) expect(isModuleLoadError(new TypeError(message))).toBe(true);
    expect(isModuleLoadError(new Error('Unable to preload CSS for /assets/view.css'))).toBe(true);
    for (const error of [
      new TypeError('Failed to fetch'),
      new TypeError('Load failed'),
      new SyntaxError('Unexpected token'),
      new Error('Cannot read properties of undefined'),
      'Failed to fetch dynamically imported module',
    ]) expect(isModuleLoadError(error)).toBe(false);
  });

  it('shares concurrent and successful loads, recovering a transient import without extra work', async () => {
    vi.useFakeTimers();
    const module = { value: 1 };
    const fetchModule = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue(module);
    const load = createModuleLoader(fetchModule);
    const first = load();
    expect(load()).toBe(first);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchModule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe(module);
    expect(load()).toBe(first);
    expect(fetchModule).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and releases the rejected promise for a later user attempt', async () => {
    vi.useFakeTimers();
    const error = new TypeError('Importing a module script failed.');
    const fetchModule = vi.fn().mockRejectedValue(error);
    const load = createModuleLoader(fetchModule);
    const first = load();
    const rejected = expect(first).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetchModule).toHaveBeenCalledTimes(3);
    fetchModule.mockResolvedValue('recovered');
    const retry = load();
    expect(retry).not.toBe(first);
    expect(await retry).toBe('recovered');
  });

  it('does not automatically repeat module execution errors, including synchronous throws', async () => {
    const error = new SyntaxError('Invalid source');
    const load = vi.fn(() => { throw error; });
    await expect(importWithRetry(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledOnce();
  });
});
