/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceCallTranscript } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Scroll behavior contracts only; jsdom metrics are not visual verification.
describe('continuous transcript history scrolling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let viewport: HTMLDivElement;
  const load = vi.fn();
  const render = (ids: string[], onLoadEarlier: (() => void) | null = load) => root.render(
    <VoiceCallTranscript onLoadEarlier={onLoadEarlier ?? undefined} entries={ids.map(id => ({ id, role: 'assistant', content: id }))} />,
  );
  beforeEach(async () => {
    load.mockReset();
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => render(['a', 'b', 'c', 'd', 'e', 'f']));
    viewport = container.querySelector<HTMLDivElement>('[data-openbitfun-part="conversation"]')!;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true,
      get: () => viewport.querySelectorAll('[data-transcript-id]').length * 100 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 200 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = [...viewport.querySelectorAll('[data-transcript-id]')].indexOf(this);
      return { top: index * 100 - viewport.scrollTop, bottom: (index + 1) * 100 - viewport.scrollTop } as DOMRect;
    });
    await act(async () => render(['a', 'b', 'c', 'd', 'e', 'f']));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

  it('pages near the top only when moving up and holds the reading row after prepend', async () => {
    expect(viewport.scrollTop).toBe(400);
    expect(load).not.toHaveBeenCalled();
    viewport.scrollTop = 30;
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(load).toHaveBeenCalledOnce();
    await act(async () => render(['older-a', 'older-b', 'a', 'b', 'c', 'd', 'e', 'f']));
    expect(viewport.scrollTop).toBe(230);
    expect(viewport.querySelector('[data-transcript-id="a"]')!.getBoundingClientRect().top).toBe(-30);
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(load).toHaveBeenCalledOnce();
    await act(async () => render(['older-a', 'older-b', 'a', 'b', 'c', 'd', 'e', 'f', 'new']));
    expect(viewport.scrollTop).toBe(230);
  });

  it('can page upward with wheel or keyboard when the initial records fit the viewport', async () => {
    await act(async () => render(['a', 'b']));
    viewport.scrollTop = 0;
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true })));
    expect(load).toHaveBeenCalledOnce();
    await act(async () => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => render(['older-a', 'a', 'b']));
    expect(viewport.scrollTop).toBe(100);
  });

  it('does not request history while scrolling down or when the host suspends paging', async () => {
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true })));
    expect(load).not.toHaveBeenCalled();
    await act(async () => render(['a', 'b'], null));
    viewport.scrollTop = 0;
    await act(async () => viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true })));
    expect(load).not.toHaveBeenCalled();
  });

  it('reports leaving and returning to the start for the overlaid header', async () => {
    expect(viewport.dataset.scrolled).toBe('true');
    viewport.scrollTop = 0;
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(viewport.dataset.scrolled).toBeUndefined();
    load.mockClear();
    viewport.scrollTop = 40;
    await act(async () => viewport.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(viewport.dataset.scrolled).toBe('true');
    expect(load).not.toHaveBeenCalled();
  });

  it('removes transient activity without replacing the user message or its reading anchor', async () => {
    const renderActivity = (processing: boolean) => root.render(<VoiceCallTranscript entries={[{
      id: 'current:user', role: 'user', content: 'Keep this message',
      activity: processing ? <span role="status" aria-label="Processing" /> : undefined,
    }]} />);
    await act(async () => renderActivity(true));
    const entry = viewport.querySelector('[data-transcript-id="current:user"]')!;
    const bubble = entry.querySelector('[data-openbitfun-part="userTranscript"]')!;
    expect(entry.querySelector('[role="status"]')).not.toBeNull();
    expect(bubble.querySelector('[role="status"]')).toBeNull();
    await act(async () => renderActivity(false));
    expect(viewport.querySelector('[data-transcript-id="current:user"]')).toBe(entry);
    expect(entry.querySelector('[data-openbitfun-part="userTranscript"]')).toBe(bubble);
    expect(entry.querySelector('[role="status"]')).toBeNull();
  });
});
