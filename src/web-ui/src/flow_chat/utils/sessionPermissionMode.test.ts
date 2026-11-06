import { describe, expect, it } from 'vitest';
import type { Session } from '../types/flow-chat';
import {
  canTreatMissingPermissionModeAsDefault,
  isSessionNotFoundError,
} from './sessionPermissionMode';

const emptyNewSession = {
  dialogTurns: [],
  historyState: 'new' as const,
  isHistorical: false,
  persistedTurnCount: undefined,
};

describe('session permission mode lifecycle', () => {
  it('does not classify a missing projection as a host-record failure', () => {
    expect(canTreatMissingPermissionModeAsDefault(undefined)).toBe(false);
  });

  it('treats an empty new local projection as inheriting the default', () => {
    expect(canTreatMissingPermissionModeAsDefault(emptyNewSession)).toBe(true);
  });

  it.each([
    ['a historical session', { ...emptyNewSession, isHistorical: true }],
    ['a hydrated session', { ...emptyNewSession, historyState: 'ready' as const }],
    ['a session with persisted turns', { ...emptyNewSession, persistedTurnCount: 1 }],
    ['a session with projected turns', {
      ...emptyNewSession,
      dialogTurns: [{ id: 'turn-1' }] as Session['dialogTurns'],
    }],
  ])('does not hide missing records for %s', (_label, session) => {
    expect(canTreatMissingPermissionModeAsDefault(session)).toBe(false);
  });

  it('requires the specific missing-session error before suppressing the notification', () => {
    expect(isSessionNotFoundError(new Error('Not found: Session not found: session-1'))).toBe(true);
    expect(isSessionNotFoundError(new Error('Host offline'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Permission denied'))).toBe(false);
  });
});
