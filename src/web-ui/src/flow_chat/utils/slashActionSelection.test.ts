import { describe, expect, it } from 'vitest';
import { resolveSlashActionInputValue } from './slashActionSelection';

describe('resolveSlashActionInputValue', () => {
  it('fills review with a trailing space so arguments can be added', () => {
    expect(resolveSlashActionInputValue('review', '/', false)).toBe('/review ');
  });

  it('preserves argument-bearing action input behavior', () => {
    expect(resolveSlashActionInputValue('btw', '/', false)).toBe('/btw ');
    expect(resolveSlashActionInputValue('btw', '/btw explain this', false)).toBe('/btw explain this');
    expect(resolveSlashActionInputValue('btw', '/', true)).toBeNull();
    expect(resolveSlashActionInputValue('goal', '/', false)).toBe('/goal ');
    expect(resolveSlashActionInputValue('goal', '/goal ship it', false)).toBe('/goal ship it');
  });

  it.each([
    ['compact', '/compact'],
    ['usage', '/usage'],
    ['model', '/model'],
    ['init', '/init'],
    ['reload', '/reload'],
  ] as const)('fills the %s action', (actionId, expected) => {
    expect(resolveSlashActionInputValue(actionId, '/', false)).toBe(expected);
  });
});
