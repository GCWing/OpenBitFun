import { describe, expect, it } from 'vitest';
import { LIVING_LINE_PET, isLivingLinePet } from './livingLinePetIdentity';

describe('LivingLine pet identity', () => {
  it('recognizes only the bundled preset identity', () => {
    expect(isLivingLinePet(LIVING_LINE_PET)).toBe(true);
    expect(isLivingLinePet({ ...LIVING_LINE_PET, source: 'user' })).toBe(false);
    expect(isLivingLinePet({ ...LIVING_LINE_PET, packagePath: '/other/living-line' })).toBe(false);
    expect(isLivingLinePet(null)).toBe(false);
  });
});
