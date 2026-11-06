import { afterEach, describe, expect, it } from 'vitest';
import {
  isManualCompactionPending,
  markManualCompactionPending,
  resetManualCompactionStateForTest,
  settleManualCompaction,
} from './manualCompactionState';

describe('manualCompactionState', () => {
  afterEach(() => resetManualCompactionStateForTest());

  it('keeps a pending admission across turn-id assignment', () => {
    markManualCompactionPending('session-1');
    expect(isManualCompactionPending('session-1')).toBe(true);

    markManualCompactionPending('session-1', 'turn-1');
    settleManualCompaction('session-1', 'other-turn');
    expect(isManualCompactionPending('session-1')).toBe(true);

    settleManualCompaction('session-1', 'turn-1');
    expect(isManualCompactionPending('session-1')).toBe(false);
  });

  it('keeps independent sessions isolated', () => {
    markManualCompactionPending('session-1', 'turn-1');
    markManualCompactionPending('session-2', 'turn-2');

    settleManualCompaction('session-1', 'turn-1');
    expect(isManualCompactionPending('session-1')).toBe(false);
    expect(isManualCompactionPending('session-2')).toBe(true);
  });
});
