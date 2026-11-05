// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BTW_CLOSE_CONFIRMATION_STORAGE_KEY,
  setConfirmBtwClose,
  shouldConfirmBtwClose,
} from './btwCloseConfirmation';

describe('BTW close confirmation preference', () => {
  beforeEach(() => localStorage.clear());

  it('confirms by default', () => {
    expect(shouldConfirmBtwClose()).toBe(true);
  });

  it('persists the disabled state and restores it', () => {
    setConfirmBtwClose(false);
    expect(localStorage.getItem(BTW_CLOSE_CONFIRMATION_STORAGE_KEY)).toBe('true');
    expect(shouldConfirmBtwClose()).toBe(false);

    setConfirmBtwClose(true);
    expect(localStorage.getItem(BTW_CLOSE_CONFIRMATION_STORAGE_KEY)).toBeNull();
    expect(shouldConfirmBtwClose()).toBe(true);
  });
});
