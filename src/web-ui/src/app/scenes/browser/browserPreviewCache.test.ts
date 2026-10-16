import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPreviewCache, type BrowserPreviewResponse } from './browserPreviewCache';

let cache: BrowserPreviewCache;
let capture: ReturnType<typeof vi.fn<(label: string) => Promise<BrowserPreviewResponse>>>;
let prepare: ReturnType<typeof vi.fn<(dataUrl: string) => Promise<void>>>;
let onFrame: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
const frame = (id: string): BrowserPreviewResponse => ({ status: 'ready', dataUrl: id });

beforeEach(() => {
  vi.useFakeTimers();
  capture = vi.fn(async () => frame('first'));
  prepare = vi.fn(async () => {});
  onFrame = vi.fn();
  onError = vi.fn();
  cache = new BrowserPreviewCache({ capture, prepare, onFrame, onError });
  cache.setTarget('browser-a');
  onFrame.mockClear();
});
afterEach(() => { cache.dispose(); vi.useRealTimers(); });

describe('browser preview cache', () => {
  it('samples only visible native pages and retains a decoded frame while hidden', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    expect(capture).not.toHaveBeenCalled();
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFrame).toHaveBeenLastCalledWith('first');
    expect(prepare).toHaveBeenCalledWith('first');
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledTimes(2);
    cache.setVisible(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenLastCalledWith('first');
  });

  it('never overlaps capture requests even across rapid hide/show transitions', async () => {
    let finish!: (value: BrowserPreviewResponse) => void;
    capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    cache.setVisible(false);
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledOnce();
    finish(frame('latest'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onFrame).toHaveBeenLastCalledWith('latest');
  });

  it('discards in-flight frames after navigation/resize and captures the new generation', async () => {
    let finish!: (value: BrowserPreviewResponse) => void;
    capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    cache.invalidate();
    finish(frame('obsolete'));
    await vi.advanceTimersByTimeAsync(1);
    expect(onFrame).not.toHaveBeenCalledWith('obsolete');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenLastCalledWith('first');
  });

  it('rejects frames decoded after switching targets or disposing', async () => {
    let finishDecode!: () => void;
    prepare.mockImplementationOnce(() => new Promise(resolve => { finishDecode = resolve; }));
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    cache.setTarget('browser-b');
    cache.dispose();
    finishDecode();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onFrame).not.toHaveBeenCalledWith('first');
    expect(capture).toHaveBeenCalledOnce();
  });

  it.each(['unsupported-platform', 'older-host'])('stops optional sampling for %s', async mode => {
    if (mode === 'older-host') capture.mockRejectedValue(new Error('Command browser_webview_capture_preview not found'));
    else capture.mockResolvedValue({ status: 'unsupported', reason: 'Unavailable on this platform' });
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    cache.setVisible(false);
    cache.setVisible(true);
    cache.invalidate();
    await vi.advanceTimersByTimeAsync(10000);
    expect(capture).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('keeps the cached frame on failure and backs off without flooding logs', async () => {
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    capture.mockRejectedValue(new Error('Capture timed out'));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(9000);
    expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenLastCalledWith('first');
  });

  it('backs off static frames to 30 seconds and decodes only changed images', async () => {
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(65_000);
    // Captures at 0, 5, 15, 35 and 65 seconds; only the first needs decoding.
    expect(capture).toHaveBeenCalledTimes(5);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    capture.mockResolvedValue(frame('changed'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onFrame).toHaveBeenLastCalledWith('changed');
    expect(prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(capture).toHaveBeenCalledTimes(7);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not turn rapid visibility toggles into a burst of captures', async () => {
    cache.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    for (let toggle = 0; toggle < 10; toggle++) {
      cache.setVisible(false);
      cache.setVisible(true);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
