import { describe, expect, it } from 'vitest';
import { parseCompactCommand } from './compactCommand';

describe('parseCompactCommand', () => {
  it('accepts a bare command', () => {
    expect(parseCompactCommand('/compact')).toEqual({ followUp: '' });
    expect(parseCompactCommand('  /COMPACT  ')).toEqual({ followUp: '' });
  });

  it('keeps everything after the command as the follow-up message', () => {
    expect(parseCompactCommand('/compact continue the fix'))
      .toEqual({ followUp: 'continue the fix' });
    expect(parseCompactCommand('/compact   first line\nsecond line  '))
      .toEqual({ followUp: 'first line\nsecond line' });
  });

  it('preserves the original casing and markdown of the follow-up', () => {
    expect(parseCompactCommand('/compact Review `Foo.tsx` next'))
      .toEqual({ followUp: 'Review `Foo.tsx` next' });
  });

  it('leaves unrelated prompts on the ordinary message path', () => {
    expect(parseCompactCommand('/compacted')).toBeNull();
    expect(parseCompactCommand('/compact-run')).toBeNull();
    expect(parseCompactCommand('please /compact')).toBeNull();
    expect(parseCompactCommand('')).toBeNull();
  });
});
