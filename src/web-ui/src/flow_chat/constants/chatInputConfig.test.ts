import { describe, expect, it } from 'vitest';
import { composerImageLimit } from './chatInputConfig';

describe('composer image admission', () => {
  it('uses the resolved model ceiling within the existing attachment budget', () => {
    expect(composerImageLimit(3)).toBe(3);
    expect(composerImageLimit(1)).toBe(1);
    expect(composerImageLimit(20)).toBe(5);
  });

  it('keeps the existing attachment budget for older or unusable model facts', () => {
    for (const limit of [undefined, 0, -1, 1.5, NaN, Infinity]) {
      expect(composerImageLimit(limit)).toBe(5);
    }
  });
});
