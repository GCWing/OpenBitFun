import { isWorkspaceIdReferencesUnsupportedError } from './RemoteSessionManager';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * User-facing text for a failed remote command. Typed unsupported states map to
 * mobile-web messages; other host errors keep the host's own English message.
 */
export function describeRemoteError(error: unknown, t: Translate, fallback?: string): string {
  if (isWorkspaceIdReferencesUnsupportedError(error)) {
    return t('workspace.idReferencesUnsupported');
  }
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message
      : '';
  if (message) return message;
  return fallback ?? String(error);
}
