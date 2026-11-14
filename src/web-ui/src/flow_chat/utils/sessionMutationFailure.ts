import { i18nService } from '@/infrastructure/i18n';

/**
 * Host refusal for a session mutation addressed to a workspace other than the
 * one that owns the session's storage (see `claim_session_storage_path`).
 */
const WORKSPACE_BINDING_MISMATCH = 'already bound to another workspace';

export function isSessionWorkspaceBindingMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes(WORKSPACE_BINDING_MISMATCH);
}

export type SessionMutationKind = 'delete' | 'archive' | 'rename' | 'duplicate';

/**
 * User-facing copy for a failed session mutation. Host and transport text is
 * never shown raw: it is English-only and may carry storage paths.
 */
export function sessionMutationFailureMessage(kind: SessionMutationKind, error: unknown): string {
  if (isSessionWorkspaceBindingMismatch(error)) {
    return i18nService.t('common:nav.sessions.workspaceBindingMismatch');
  }
  switch (kind) {
    case 'delete': return i18nService.t('common:nav.sessions.deleteFailed');
    case 'archive': return i18nService.t('common:nav.sessions.archiveFailed');
    case 'rename': return i18nService.t('common:nav.sessions.renameFailed');
    case 'duplicate': return i18nService.t('common:nav.sessions.duplicateFailed');
  }
}
