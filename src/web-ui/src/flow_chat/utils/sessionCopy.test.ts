import { describe, expect, it } from 'vitest';
import { isSessionEmptyForCopy } from './sessionCopy';

type CopySession = Parameters<typeof isSessionEmptyForCopy>[0];
const session = (overrides: Partial<CopySession> = {}): CopySession => ({
  dialogTurns: [], historyState: 'metadata-only', ...overrides,
});

describe('isSessionEmptyForCopy', () => {
  it('disables newly created and fully hydrated empty sessions', () => {
    expect(isSessionEmptyForCopy(session({ historyState: 'new' }))).toBe(true);
    expect(isSessionEmptyForCopy(session({ historyState: 'ready' }))).toBe(true);
  });

  it('uses persisted counts instead of unloaded transcript arrays', () => {
    expect(isSessionEmptyForCopy(session({ persistedTurnCount: 0 }))).toBe(true);
    expect(isSessionEmptyForCopy(session({ persistedTurnCount: 5 }))).toBe(false);
    expect(isSessionEmptyForCopy(session())).toBe(false);
    expect(isSessionEmptyForCopy(session({ historyState: 'failed' }))).toBe(false);
  });

  it('does not classify a partial empty preview as a fully loaded empty history', () => {
    expect(isSessionEmptyForCopy(session({ historyState: 'ready', isPartial: true }))).toBe(false);
  });

  it('lets newer history counts override stale empty metadata', () => {
    expect(isSessionEmptyForCopy(session({ persistedTurnCount: 0, totalTurnCount: 3 }))).toBe(false);
    expect(isSessionEmptyForCopy(session({ persistedTurnCount: 3, totalTurnCount: 0 }))).toBe(true);
    expect(isSessionEmptyForCopy(session({
      persistedTurnCount: 0, dialogTurns: [{}] as CopySession['dialogTurns'],
    }))).toBe(false);
  });
});
