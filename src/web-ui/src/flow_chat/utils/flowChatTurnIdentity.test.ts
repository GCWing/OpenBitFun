import { describe, expect, it } from 'vitest';

import { nextStorageTurnIndex } from './flowChatTurnIdentity';
import type { DialogTurn } from '../types/flow-chat';

const SESSION_ID = 'acp_dsh_session';

function turn(id: string, storageTurnIndex?: number): DialogTurn {
  return {
    id,
    sessionId: SESSION_ID,
    userMessage: { id: `user-${id}`, content: 'hi', timestamp: 1 },
    modelRounds: [],
    status: 'completed',
    startTime: 1,
    storageTurnIndex,
  };
}

function session(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: SESSION_ID,
    dialogTurns: [],
    ...overrides,
  };
}

describe('nextStorageTurnIndex', () => {
  it('gives the first turn of an empty session slot zero', () => {
    expect(nextStorageTurnIndex(session())).toBe(0);
  });

  it('continues after the highest slot already projected', () => {
    expect(
      nextStorageTurnIndex(session({ dialogTurns: [turn('a', 0), turn('b', 1)] })),
    ).toBe(2);
  });

  it('continues after the catalog when the loaded window is only the tail', () => {
    expect(
      nextStorageTurnIndex(session({
        dialogTurns: [turn('e', 4)],
        isPartial: true,
        totalTurnCount: 5,
        turnCatalog: {
          sessionId: SESSION_ID,
          totalTurnCount: 5,
          entries: [
            { turnId: 'a', ordinal: 0, storageTurnIndex: 0 },
            { turnId: 'e', ordinal: 4, storageTurnIndex: 4 },
          ],
        },
      })),
    ).toBe(5);
  });

  it('ignores a catalog belonging to another session', () => {
    expect(
      nextStorageTurnIndex(session({
        dialogTurns: [turn('a', 0)],
        turnCatalog: {
          sessionId: 'some-other-session',
          totalTurnCount: 9,
          entries: [{ turnId: 'x', ordinal: 8, storageTurnIndex: 8 }],
        },
      })),
    ).toBe(1);
  });

  it('reads the slot of a turn restored under the deprecated field', () => {
    const restored = turn('a');
    restored.backendTurnIndex = 3;
    expect(nextStorageTurnIndex(session({ dialogTurns: [restored] }))).toBe(4);
  });

  it('refuses to guess while persisted turns are not projected yet', () => {
    expect(
      nextStorageTurnIndex(session({
        dialogTurns: [],
        isPartial: true,
        totalTurnCount: 3,
      })),
    ).toBeUndefined();
  });
});
