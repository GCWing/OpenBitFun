import { describe, expect, it } from 'vitest';
import { leadingExtentFloor, type LeadingExtentAnchor } from './flowChatLeadingExtent';

describe('leading-edge collapse geometry', () => {
  const anchor: LeadingExtentAnchor = { key: 'card', offsetPx: 24, heightPx: 900 };
  it('holds the visible header while everything after a closing card moves upward', () => {
    const startPx = 2400;
    const offsets = [900, 700, 450, 200, 40].map(height => {
      const { floorPx } = leadingExtentFloor({ anchor, startPx, endPx: startPx + height, usesGroupHeader: false });
      return { header: startPx - floorPx, successor: startPx + height - floorPx };
    });
    expect(offsets.map(position => position.header)).toEqual([24, 24, 24, 24, 24]);
    expect(offsets.map(position => position.successor)).toEqual([924, 724, 474, 224, 64]);
  });
  it('does not bring a partly visible closing card down just because it fits the reading area', () => {
    const interior = { ...anchor, offsetPx: -200 };
    expect(leadingExtentFloor({ anchor: interior, startPx: 2400, endPx: 2640, usesGroupHeader: false }))
      .toEqual({ floorPx: 2600, offsetPx: -200 });
    // Only an entirely vanished reading position falls back to the compact top.
    expect(leadingExtentFloor({ anchor: interior, startPx: 2400, endPx: 2440, usesGroupHeader: false }))
      .toEqual({ floorPx: 2392, offsetPx: 8 });
  });
  it.each([[36, 36], [-500, 8]])('replaces a removed member with its group header at %i px', (before, after) => {
    expect(leadingExtentFloor({ anchor: { ...anchor, groupHeaderOffsetPx: before },
      startPx: 1800, endPx: 1840, usesGroupHeader: true }))
      .toEqual({ floorPx: 1800 - after, offsetPx: after });
  });
  it('follows semantic position changes above the anchor without accumulating removed heights', () => {
    for (const startPx of [2400, 3400, 1600, 2400]) {
      const { floorPx } = leadingExtentFloor({ anchor, startPx, endPx: startPx + 40, usesGroupHeader: false });
      expect(startPx - floorPx).toBe(24);
    }
  });
});
