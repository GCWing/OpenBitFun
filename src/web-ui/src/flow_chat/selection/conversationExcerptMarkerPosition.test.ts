import { describe, expect, it } from 'vitest';
import { computeExcerptMarkerPosition } from './conversationExcerptMarkerPosition';

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});
const wrapper = rect(100, 200, 600, 300);
const badge = { width: 20, height: 20 };

describe('annotation selection bounds', () => {
  it('overlaps the selection upper-right corner', () => {
    const selection = rect(120, 260, 230, 18);
    expect(computeExcerptMarkerPosition(wrapper, selection, wrapper, badge))
      .toEqual({ left: 244, top: 46 });
  });

  it('anchors to the top right of the whole multiline selection', () => {
    const selection = rect(120, 260, 450, 78);
    expect(computeExcerptMarkerPosition(wrapper, selection, wrapper, badge))
      .toEqual({ left: 464, top: 46 });
  });

  it('keeps the corner position when surrounding text is dense', () => {
    const selection = rect(120, 280, 230, 18);
    expect(computeExcerptMarkerPosition(wrapper, selection, wrapper, badge))
      .toEqual({ left: 244, top: 66 });
  });

  it('keeps a wide badge inside the visible right edge', () => {
    const selection = rect(120, 280, 580, 18);
    expect(computeExcerptMarkerPosition(wrapper, selection, wrapper, { width: 68, height: 20 }))
      .toEqual({ left: 532, top: 66 });
  });

  it('uses the right gutter for selections at the first line without covering their text', () => {
    const selection = rect(120, 200, 230, 18);
    expect(computeExcerptMarkerPosition(wrapper, selection, wrapper, badge))
      .toEqual({ left: 244, top: 0 });
  });

  it('keeps partially clipped selections visible and rejects fully clipped or unmeasured markers', () => {
    const clip = rect(100, 270, 250, 60);
    expect(computeExcerptMarkerPosition(wrapper, rect(120, 260, 100, 18), clip, badge))
      .toEqual({ left: 114, top: 70 });
    expect(computeExcerptMarkerPosition(wrapper, rect(120, 300, 280, 18), clip, badge))
      .toEqual({ left: 230, top: 86 });
    expect(computeExcerptMarkerPosition(wrapper, rect(120, 240, 100, 18), clip, badge)).toBeNull();
    expect(computeExcerptMarkerPosition(wrapper, rect(120, 300, 100, 18), clip, { width: 0, height: 0 })).toBeNull();
  });
});
