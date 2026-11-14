import { describe, expect, it } from 'vitest';
import { browserFixtureFlags } from './browser-fixture.test-support';

describe('browser fixture sandbox policy', () => {
  it('supports the hosted Linux CI runner', () => {
    expect(browserFixtureFlags('linux', { CI: 'true' })).toEqual(['--no-sandbox']);
  });

  it.each([undefined, 'false', ''])('retains the local Linux sandbox when CI is %s', ci => {
    expect(browserFixtureFlags('linux', { CI: ci })).toEqual([]);
  });

  it.each(['win32', 'darwin'] as const)('does not change %s CI browser flags', platform => {
    expect(browserFixtureFlags(platform, { CI: 'true' })).toEqual([]);
  });
});
