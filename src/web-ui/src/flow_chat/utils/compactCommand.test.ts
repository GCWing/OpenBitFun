import { describe, expect, it } from 'vitest';
import { parseCompactCommand } from './compactCommand';

describe('parseCompactCommand', () => {
  it('keeps normal compaction and accepts only the explicit force argument', () => {
    expect(parseCompactCommand('/compact')).toEqual({ kind: 'compact', force: false });
    expect(parseCompactCommand(' /COMPACT \tFORCE\n')).toEqual({ kind: 'compact', force: true });
    for (const command of ['/compact --force', '/compact force extra', '/compact forced']) {
      expect(parseCompactCommand(command)).toEqual({ kind: 'invalid' });
    }
  });

  it('does not intercept ordinary messages or other command names', () => {
    for (const command of ['hello /compact force', '/compactor', '/compact-force', '']) {
      expect(parseCompactCommand(command)).toBeNull();
    }
  });
});
