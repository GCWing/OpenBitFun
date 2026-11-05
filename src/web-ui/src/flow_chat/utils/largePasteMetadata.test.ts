import { describe, expect, it } from 'vitest';
import {
  expandLargePastes,
  pickReferencedLargePastes,
  readLargePastesMetadata,
  splitLargePasteText,
} from './largePasteMetadata';

const base = '[Pasted 5 chars]';
const second = '[Pasted 5 chars] #2';

describe('largePasteMetadata', () => {
  it('expands same-length placeholders without corrupting the longer one', () => {
    const pastes = { [base]: 'aaaaa', [second]: 'bbbbb' };
    expect(expandLargePastes(`${base} and ${second}`, pastes)).toBe('aaaaa and bbbbb');
    expect(splitLargePasteText(`x${second}`, pastes)).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'paste', placeholder: second },
    ]);
  });

  it('never rescans an inserted body for placeholders', () => {
    expect(expandLargePastes(base, { [base]: `${second}`, [second]: 'nested' })).toBe(second);
  });

  it('keeps only referenced pastes', () => {
    expect(pickReferencedLargePastes({ [base]: 'deleted', [second]: 'kept' }, second)).toEqual({ [second]: 'kept' });
    expect(pickReferencedLargePastes({ [second]: 'b', '[Other]': 'c' }, `hi ${second}`)).toEqual({ [second]: 'b' });
    expect(pickReferencedLargePastes({ '[Other]': 'c' }, 'hi')).toBeNull();
    expect(pickReferencedLargePastes(undefined, 'hi')).toBeNull();
  });

  it('tolerates missing and malformed metadata from other host versions', () => {
    expect(readLargePastesMetadata(undefined)).toBeNull();
    expect(readLargePastesMetadata({ largePastes: ['x'] })).toBeNull();
    expect(readLargePastesMetadata({ largePastes: { [base]: 1, '': 'x', [second]: 'ok' } })).toEqual({ [second]: 'ok' });
  });
});
