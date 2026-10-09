import { describe, expect, it } from 'vitest';
import {
  contentEndScrollTop, readingLinePxForViewport, tailSpacerPxForViewport,
  turnTopScrollTop, easeFollowOffset, isViewportAtTail, resolveAnimatedJumpBehavior,
  turnTopAlignmentEntersReservedBlank,
} from './flowChatTailFollow';

describe('desktop reading geometry', () => {
  it.each([[800, 160], [500, 100], [1100, 240]])('uses one physical endpoint at %i px with %i px of composer clearance', (height, footer) => {
    const line = readingLinePxForViewport(height, footer);
    const tail = tailSpacerPxForViewport(height, footer);
    const contentEnd = 3000;
    const physicalEnd = contentEndScrollTop({ scrollHeight: contentEnd + footer + tail, clientHeight: height });
    expect(contentEnd - physicalEnd).toBeCloseTo(line, 6);
    expect(line).toBe(8 + (height - footer - 8) * 0.618);
    expect(isViewportAtTail({ scrollTop: physicalEnd, contentEndScrollTop: physicalEnd, followTargetScrollTop: physicalEnd, thresholdPx: 2 })).toBe(true);
  });
  it('keeps the latest Turn top reachable before and after a tall card collapses', () => {
    const height = 800, footer = 160, turnStart = 2008;
    const floor = turnTopScrollTop(turnStart);
    const line = readingLinePxForViewport(height, footer);
    for (const turnHeight of [40, 200, 700, 1200, 120, 300, 900, 80]) {
      // CSS min-height supplies the floor; natural content plus the ordinary
      // tail supplies the other bound. Neither discards the Turn's identity.
      const scrollHeight = Math.max(floor + height,
        turnStart + turnHeight + footer + tailSpacerPxForViewport(height, footer));
      const end = contentEndScrollTop({ scrollHeight, clientHeight: height });
      if (turnHeight <= line - 8) expect(turnStart - end).toBe(8);
      else expect(turnStart + turnHeight - end).toBeCloseTo(line, 6);
    }
    expect(turnTopScrollTop(8)).toBe(0);
    expect(turnTopScrollTop(0)).toBe(0);
  });
  it('never produces negative spacer or scroll ranges for small windows', () => {
    expect(tailSpacerPxForViewport(0, 160)).toBe(0);
    expect(tailSpacerPxForViewport(100, 160)).toBe(0);
    expect(contentEndScrollTop({ scrollHeight: 100, clientHeight: 800 })).toBe(0);
  });
  it('clamps ordinary turn navigation only beyond the physical end', () => {
    expect(turnTopAlignmentEntersReservedBlank({ turnTopScrollTop: 100, contentEndScrollTop: 200 })).toBe(false);
    expect(turnTopAlignmentEntersReservedBlank({ turnTopScrollTop: 250, contentEndScrollTop: 200 })).toBe(true);
  });
});

describe('desktop follow motion', () => {
  it('has the same time response at 60 and 120 Hz without overshoot', () => {
    const advance = (hz: number) => {
      let offset = 0;
      for (let i = 0; i < hz / 10; i++) offset = easeFollowOffset(offset, 1000, 1000 / hz);
      return offset;
    };
    expect(advance(60)).toBeCloseTo(advance(120), 8);
    expect(advance(60)).toBeLessThan(1000);
    expect(easeFollowOffset(1000, 500, 16)).toBeGreaterThan(500);
  });
  it('settles subpixels and skips untrackable long navigation', () => {
    expect(easeFollowOffset(499.4, 500, 16)).toBe(500);
    expect(resolveAnimatedJumpBehavior({ fromPx: 0, targetPx: 1000, clientHeight: 500 })).toBe('smooth');
    expect(resolveAnimatedJumpBehavior({ fromPx: 0, targetPx: 5000, clientHeight: 500 })).toBe('auto');
    expect(resolveAnimatedJumpBehavior({ fromPx: 0, targetPx: 1, clientHeight: 0 })).toBe('auto');
  });
});
