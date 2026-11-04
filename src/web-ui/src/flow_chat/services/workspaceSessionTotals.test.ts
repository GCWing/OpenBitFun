import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_VIEW_KEY,
  forgetSurfaceSessionTotals,
  knownWorkspaceSessionTotal,
  presentedSessionTotal,
  rememberWorkspaceSessionTotal,
} from './workspaceSessionTotals';

describe('workspaceSessionTotals', () => {
  it('keeps the last settled total while a catalog reader restarts', () => {
    // Reader restarted: only the 5 seeded rows are countable.
    expect(presentedSessionTotal(false, 5, 8)).toBe(8);
    // A settled read is authoritative, also when the total shrank.
    expect(presentedSessionTotal(true, 6, 8)).toBe(6);
    expect(presentedSessionTotal(false, 5, undefined)).toBe(5);
  });

  it('remembers totals per device, workspace and view', () => {
    rememberWorkspaceSessionTotal('peer-a', 'w', DEFAULT_SESSION_VIEW_KEY, 8);
    rememberWorkspaceSessionTotal('peer-b', 'w', DEFAULT_SESSION_VIEW_KEY, 3);
    expect(knownWorkspaceSessionTotal('peer-a', 'w', DEFAULT_SESSION_VIEW_KEY)).toBe(8);
    expect(knownWorkspaceSessionTotal('peer-a', 'w', 'filtered')).toBeUndefined();
    forgetSurfaceSessionTotals('peer-a');
    expect(knownWorkspaceSessionTotal('peer-a', 'w', DEFAULT_SESSION_VIEW_KEY)).toBeUndefined();
    expect(knownWorkspaceSessionTotal('peer-b', 'w', DEFAULT_SESSION_VIEW_KEY)).toBe(3);
  });
});
