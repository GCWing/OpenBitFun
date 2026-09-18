/**
 * Export a whole session's history to a Markdown file.
 *
 * Turns are read from session persistence (not from the in-memory store) so a
 * partially hydrated history session still exports its full transcript.
 */

import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { i18nService } from '@/infrastructure/i18n';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { downloadMarkdownInBrowser } from '@/shared/utils/browserDownload';
import type { DialogTurnData } from '@/shared/types/session-history';
import {
  collectPersistedTurn,
  formatSessionTranscriptMarkdown,
  hasTranscriptContent,
  type TranscriptExportScope,
  type TranscriptExportTurn,
} from '../utils/dialogTranscriptExport';
import { buildSessionTranscriptMarkdownLabels } from '../utils/transcriptExportLabels';

const log = createLogger('sessionMarkdownExport');

export interface SessionMarkdownExportTarget {
  sessionId: string;
  title: string;
  workspaceId: string;
  /** Display only; never used to locate persistence. */
  workspacePath?: string;
}

export type SessionMarkdownExportResult =
  | { status: 'saved'; filePath?: string }
  | { status: 'cancelled' }
  | { status: 'empty' }
  | { status: 'failed' };

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

const FILE_NAME_RESERVED_CHARS = '\\/:*?"<>|';

/** Filesystem-safe, reasonably short file stem derived from the session title. */
export function buildSessionExportFileName(title: string, sessionId: string, exportedAt: Date): string {
  const safeTitle = Array.from(title)
    .map(char => (char < ' ' || FILE_NAME_RESERVED_CHARS.includes(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const stamp = exportedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const stem = safeTitle || sessionId;
  return `${stem}_${stamp}.md`;
}

/** Build the Markdown document for already-loaded persisted turns. */
export function buildSessionMarkdown(
  turns: DialogTurnData[],
  scope: TranscriptExportScope,
  meta: { title: string; sessionId: string; exportedAt: Date; workspacePath?: string }
): string {
  const exportTurns: TranscriptExportTurn[] = turns
    .map(collectPersistedTurn)
    .filter(turn => hasTranscriptContent(turn, scope));

  return formatSessionTranscriptMarkdown(
    exportTurns,
    scope,
    meta,
    buildSessionTranscriptMarkdownLabels()
  );
}

/**
 * Load, render, and save a session transcript. Returns the outcome so callers
 * can stay silent on user cancellation.
 */
export async function exportSessionToMarkdown(
  target: SessionMarkdownExportTarget,
  scope: TranscriptExportScope
): Promise<SessionMarkdownExportResult> {
  const exportedAt = new Date();

  try {
    const turns = await sessionAPI.loadSessionTurns(
      target.sessionId,
      target.workspaceId
    );

    const exportTurns = (turns ?? [])
      .map(collectPersistedTurn)
      .filter(turn => hasTranscriptContent(turn, scope));

    if (exportTurns.length === 0) {
      notificationService.warning(i18nService.t('flow-chat:transcriptExport.exportEmpty'));
      return { status: 'empty' };
    }

    const markdown = formatSessionTranscriptMarkdown(
      exportTurns,
      scope,
      {
        title: target.title,
        sessionId: target.sessionId,
        exportedAt,
        workspacePath: target.workspacePath,
      },
      buildSessionTranscriptMarkdownLabels()
    );

    const fileName = buildSessionExportFileName(target.title, target.sessionId, exportedAt);

    if (isTauriDesktop()) {
      const [{ save }, { writeFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ]);
      const filePath = await save({
        title: i18nService.t('flow-chat:transcriptExport.saveDialogTitle'),
        defaultPath: fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!filePath) {
        return { status: 'cancelled' };
      }
      await writeFile(filePath, new TextEncoder().encode(markdown));
      notificationService.success(
        i18nService.t('flow-chat:transcriptExport.exportSuccess', { filePath }),
        { duration: 4000 }
      );
      return { status: 'saved', filePath };
    }

    downloadMarkdownInBrowser(fileName, markdown);
    notificationService.success(
      i18nService.t('flow-chat:transcriptExport.exportSuccess', { filePath: fileName }),
      { duration: 4000 }
    );
    return { status: 'saved', filePath: fileName };
  } catch (error) {
    log.error('Failed to export session transcript', {
      sessionId: target.sessionId,
      scope,
      error,
    });
    notificationService.error(i18nService.t('flow-chat:transcriptExport.exportFailed'));
    return { status: 'failed' };
  }
}
