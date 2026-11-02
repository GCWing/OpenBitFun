// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useEmbeddedTimelineFollow } from './useEmbeddedTimelineFollow';
import type { FlowChatViewportOwnerApi } from '../components/modern/useFlowChatViewportOwner';

it('hands a streaming embedded viewport to native text selection until the reader resumes', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0, resize = () => {};
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resize = cb; } observe() {} disconnect() {} });
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(0)); });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), followRef = { current: true }, cancelAim = vi.fn();
  const owner = { write: vi.fn(), release: vi.fn() } as unknown as FlowChatViewportOwnerApi;
  function View() {
    const scrollerRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLParagraphElement>(null);
    useEmbeddedTimelineFollow({ scrollerRef, contentRef, followRef, viewportOwner: owner, revision: 0, cancelAim });
    return <div ref={scrollerRef}><p ref={contentRef}>A growing answer to select and read</p></div>;
  }
  try {
    act(() => root.render(<View />));
    Object.defineProperty(host.firstChild!, 'clientHeight', { value: 400 });
    Object.defineProperty(host.firstChild!, 'scrollHeight', { value: 1200 });
    flush(); expect(owner.write).toHaveBeenCalledTimes(1);
    const range = document.createRange(); range.selectNodeContents(host.querySelector('p')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    expect(followRef.current).toBe(false); expect(cancelAim).toHaveBeenCalled();
    expect(owner.release).toHaveBeenCalledWith('follow-output');
    resize(); flush(); expect(owner.write).toHaveBeenCalledTimes(1);
    // A trailing scroll event must not undo the selection's takeover.
    followRef.current = true; resize(); flush(); expect(owner.write).toHaveBeenCalledTimes(1);
    followRef.current = false; selection.removeAllRanges();
    act(() => document.dispatchEvent(new Event('selectionchange')));
    resize(); flush(); expect(owner.write).toHaveBeenCalledTimes(1);
    followRef.current = true; resize(); flush(); expect(owner.write).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
