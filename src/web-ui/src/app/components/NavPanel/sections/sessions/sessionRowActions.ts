/**
 * Session row menu actions, run against the rendered device surface.
 *
 * The live session list and the read-only device catalog share these: the
 * catalog renders the owning device first and then runs the same handler, so
 * both menus report success and failure identically.
 */

import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { isOutcomeUnknownError } from '@/infrastructure/api/errors/TauriCommandError';
import { isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { isSamePath } from '@/shared/utils/pathUtils';

const log = createLogger('SessionRowActions');

export type SessionRowTranslate = (key: string, options?: Record<string, unknown>) => string;

/** Delete after menu confirmation; the session module reports failures. */
export async function deleteSessionRow(sessionId: string): Promise<void> {
  try {
    await flowChatManager.deleteChatSession(sessionId);
  } catch (error) {
    if (isSurfaceChangedError(error)) return;
    log.error('Failed to delete session', { sessionId, error });
  }
}

/** Archive a session; the archive module reports its own failures. */
export async function archiveSessionRow(sessionId: string, t: SessionRowTranslate): Promise<void> {
  try {
    await flowChatManager.archiveChatSession(sessionId);
    window.dispatchEvent(new CustomEvent('openbitfun:session-archived'));
    notificationService.success(t('nav.sessions.archivedAll', { count: 1 }), { duration: 3000 });
  } catch (err) {
    log.error('Failed to archive session', err);
  }
}

/**
 * Copy the session into a new independent session. The copy is created by the
 * host and appears in the list; the current row and the active session stay
 * untouched.
 */
export async function duplicateSessionRow(sessionId: string, t: SessionRowTranslate): Promise<void> {
  try {
    const copied = await flowChatManager.duplicateChatSession(sessionId);
    if (copied.metadataProjected) {
      notificationService.success(
        t('nav.sessions.duplicateSuccess', { name: copied.sessionName }),
        { duration: 3000 },
      );
    } else {
      notificationService.warning(
        t('nav.sessions.duplicateCreatedRefreshFailed', { name: copied.sessionName }),
        { duration: 5000 },
      );
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) return;
    log.error('Failed to copy session', { sessionId, error });
    notificationService.error(
      error instanceof Error && error.message
        ? error.message
        : t('nav.sessions.duplicateFailed'),
      { duration: 4000 },
    );
  }
}

/** Rename a session; an unknown outcome reloads the host's title. */
export async function renameSessionRow(sessionId: string, title: string, t: SessionRowTranslate): Promise<void> {
  try {
    await flowChatManager.renameChatSessionTitle(sessionId, title);
  } catch (err) {
    log.error('Failed to update session title', { sessionId, error: err });
    if (isOutcomeUnknownError(err)) {
      notificationService.warning(t('nav.sessions.renameOutcomeUnknown'), { duration: 6000 });
      try {
        await flowChatManager.reloadSessionTitle(sessionId);
      } catch (refreshError) {
        log.error('Failed to reload the session title after an unknown rename outcome', {
          sessionId,
          error: refreshError,
        });
      }
    }
  }
}

/**
 * A worktree directory is registered for execution but not opened, so the
 * session row is the only place it can be reached from. Opening it as a
 * workspace is an explicit user action; if the worktree happens to be open
 * already, activating it is the whole effect.
 */
export async function openWorktreeWorkspaceRow(worktreePath: string, t: SessionRowTranslate): Promise<void> {
  const opened = [...workspaceManager.getState().openedWorkspaces.values()].find(workspace =>
    isSamePath(workspace.rootPath ?? '', worktreePath),
  );
  try {
    if (opened) {
      await workspaceManager.setActiveWorkspace(opened.id);
      return;
    }
    await workspaceManager.openWorkspace(worktreePath);
  } catch (err) {
    log.error('Failed to open the worktree directory as a workspace', { worktreePath, error: err });
    notificationService.error(t('nav.sessions.openWorktreeWorkspaceFailed'), { duration: 3000 });
  }
}
