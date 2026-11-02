// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { syncFlowChatScrollbarMask } from './flowChatScrollbarMask';

function scrollerBox(clientWidth: number, clientLeft: number, clientHeight = 800): HTMLElement {
  const scroller = document.createElement('div');
  Object.defineProperties(scroller, {
    clientWidth: { value: clientWidth },
    clientLeft: { value: clientLeft },
    clientHeight: { value: clientHeight },
  });
  return scroller;
}

describe('FlowChat idle scrollbar mask', () => {
  it.each([
    { name: 'symmetric reserved gutters', width: 986, left: 7 },
    { name: 'a right-side native scrollbar', width: 986, left: 0 },
    { name: 'a left-side native scrollbar', width: 986, left: 14 },
    { name: 'an overlay scrollbar', width: 1000, left: 0 },
  ])('preserves the whole client box with $name', ({ width, left }) => {
    const scroller = scrollerBox(width, left);
    scroller.style.overflowY = 'scroll';
    scroller.style.scrollbarGutter = 'stable both-edges';

    syncFlowChatScrollbarMask(scroller, false);

    expect(scroller.style.maskSize).toBe(`${width}px 100%`);
    expect(scroller.style.maskPosition).toBe(`${left}px 0px`);
    expect(scroller.style.overflowY).toBe('scroll');
    expect(scroller.style.scrollbarGutter).toBe('stable both-edges');
    expect(scroller.scrollTop).toBe(0);
    const write = vi.spyOn(scroller.style, 'setProperty');
    syncFlowChatScrollbarMask(scroller, false);
    expect(write).not.toHaveBeenCalled();
  });

  it('restores the full-width fade and native scrollbar as soon as content overflows', () => {
    const scroller = scrollerBox(986, 7);
    scroller.style.maskImage = 'linear-gradient(transparent, black)';
    syncFlowChatScrollbarMask(scroller, false);
    scroller.scrollTop = 250;

    syncFlowChatScrollbarMask(scroller, true);

    for (const property of ['mask-size', '-webkit-mask-size', 'mask-position', '-webkit-mask-position']) {
      expect(scroller.style.getPropertyValue(property)).toBe('');
    }
    expect(scroller.style.maskImage).toBe('linear-gradient(transparent, black)');
    expect(scroller.scrollTop).toBe(250);
  });

  it.each([[0, 800], [986, 0]])('leaves an unmeasurable %s × %s viewport uncropped', (width, height) => {
    const scroller = scrollerBox(width, 7, height);
    syncFlowChatScrollbarMask(scroller, false);
    expect(scroller.style.maskSize).toBe('');
    expect(scroller.style.maskPosition).toBe('');
  });
});
