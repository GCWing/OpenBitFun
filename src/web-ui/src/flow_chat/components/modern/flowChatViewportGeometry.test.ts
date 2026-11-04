// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { centerFlowChatExtent } from './flowChatViewportGeometry';

describe('transcript and composer panel axis', () => {
  it.each([0, 15])('centres a reverse-flex extent starting at %s without accumulating an offset', origin => {
    const scroller = document.createElement('div');
    const extent = document.createElement('div');
    scroller.getBoundingClientRect = () => ({ left: 200, width: 1000 }) as DOMRect;
    extent.getBoundingClientRect = () => ({ left: 200 + origin + (Number.parseFloat(extent.style.left) || 0), width: 970 }) as DOMRect;
    centerFlowChatExtent(scroller, extent);
    expect(extent.getBoundingClientRect().left + 970 / 2).toBe(700);
    centerFlowChatExtent(scroller, extent);
    expect(extent.getBoundingClientRect().left + 970 / 2).toBe(700);
    // Returning to normal flow restores the leading gutter in WebKit.
    extent.getBoundingClientRect = () => ({ left: 215 + (Number.parseFloat(extent.style.left) || 0), width: 970 }) as DOMRect;
    centerFlowChatExtent(scroller, extent);
    expect(extent.getBoundingClientRect().left + 970 / 2).toBe(700);
  });
});
