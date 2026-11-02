import { describe, expect, it } from 'vitest';
import { parseGlobalSearchQuery, scoreTextMatch } from './searchMatching';

describe('global search query grammar', () => {
  it('uses a leading chevron as an explicit command scope', () => {
    expect(parseGlobalSearchQuery('  > terminal  ', 'content')).toEqual({
      query: 'terminal',
      scope: 'actions',
      scopeForcedByPrefix: true,
    });
  });

  it('preserves the selected scope for ordinary text', () => {
    expect(parseGlobalSearchQuery('  readme  ', 'content')).toEqual({
      query: 'readme',
      scope: 'content',
      scopeForcedByPrefix: false,
    });
  });
});

describe('scoreTextMatch', () => {
  it('accepts consecutive initials without assembling acronyms from scattered prose', () => {
    expect(scoreTextMatch('gs', ['Global Search'])).toBeGreaterThan(0);
    expect(scoreTextMatch('pet', ['Publish the example after completing checks and tests'])).toBe(0);
    expect(scoreTextMatch('mascot', ['Move an app; select controls only when observed, then operate them'])).toBe(0);
  });

  it('prioritizes exact, prefix, word-prefix, and contains matches', () => {
    expect(scoreTextMatch('term', ['term'])).toBeGreaterThan(scoreTextMatch('term', ['terminal']));
    expect(scoreTextMatch('term', ['open terminal'])).toBeGreaterThan(scoreTextMatch('term', ['preterminal panel']));
    expect(scoreTextMatch('missing', ['terminal'])).toBe(0);
  });

  it('matches natural multi-term queries across bilingual catalog fields', () => {
    expect(scoreTextMatch('Hooks 设置', ['Hooks', '自动化设置'])).toBeGreaterThan(0);
  });

  it('treats bilingual alternatives as accumulated evidence instead of a strict AND query', () => {
    expect(scoreTextMatch(
      '宠物 pet mascot 桌面宠物',
      ['桌面宠物', 'desktop pet', 'Agent companion'],
    )).toBeGreaterThan(0);
    expect(scoreTextMatch(
      'pet mascot appearance',
      ['Companion settings', 'desktop pet'],
    )).toBeGreaterThan(0);
  });
});
