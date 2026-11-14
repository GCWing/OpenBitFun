import { describe, expect, it, vi } from 'vitest';
import { isSessionWorkspaceBindingMismatch, sessionMutationFailureMessage } from './sessionMutationFailure';

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const bindingMismatch = new Error(
  'Failed to delete session: Validation error: Session ID is already bound to another workspace: '
  + 'session_id=s, existing_storage_path=C:/a/sessions, requested_storage_path=C:/b/sessions',
);

describe('sessionMutationFailureMessage', () => {
  it('explains a workspace binding mismatch without exposing storage paths', () => {
    expect(isSessionWorkspaceBindingMismatch(bindingMismatch)).toBe(true);
    for (const kind of ['delete', 'archive', 'rename', 'duplicate'] as const) {
      expect(sessionMutationFailureMessage(kind, bindingMismatch))
        .toBe('common:nav.sessions.workspaceBindingMismatch');
    }
  });

  it('uses the localized generic copy for any other failure', () => {
    const offline = new Error('Relay connection timed out; request was not submitted');
    expect(sessionMutationFailureMessage('delete', offline)).toBe('common:nav.sessions.deleteFailed');
    expect(sessionMutationFailureMessage('archive', offline)).toBe('common:nav.sessions.archiveFailed');
    expect(sessionMutationFailureMessage('rename', 'boom')).toBe('common:nav.sessions.renameFailed');
    expect(sessionMutationFailureMessage('duplicate', undefined)).toBe('common:nav.sessions.duplicateFailed');
  });
});
