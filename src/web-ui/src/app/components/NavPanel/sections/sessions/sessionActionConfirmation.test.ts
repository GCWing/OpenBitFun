import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('session action confirmation policy', () => {
  it('archives a single session immediately without delete or batch actions in its menu', () => {
    const source = readSource('./SessionsSection.tsx');
    const archiveHandler = sliceBetween(source, 'const handleArchive = useCallback(', 'const handleDuplicateSession = useCallback(');

    expect(source).not.toContain('data-testid="nav-session-menu-delete"');
    expect(source).not.toContain('data-testid="nav-session-menu-manage-sessions"');
    expect(source).not.toContain('flowChatManager.deleteChatSession');
    expect(archiveHandler).not.toMatch(/confirm(?:Danger|Warning)\(/);
    expect(archiveHandler).toContain('await flowChatManager.archiveChatSession(sessionId)');
  });

  it('archives selected sessions immediately and uses danger confirmation for deletion', () => {
    const source = readSource('../workspaces/WorkspaceSessionBatchModal.tsx');
    const archiveHandler = sliceBetween(source, 'const handleArchiveSelected = useCallback(', 'const handleDeleteSelected = useCallback(');
    const deleteHandler = sliceBetween(source, 'const handleDeleteSelected = useCallback(', 'return (');

    expect(source).toContain("import { confirmDanger } from '@/infrastructure/confirm-dialog';");
    expect(source).not.toContain('confirmWarning');
    expect(archiveHandler).not.toMatch(/confirm(?:Danger|Warning)\(/);
    expect(archiveHandler).toContain('flowChatManager.archiveChatSession(sessionId)');
    expect(deleteHandler).toContain('await confirmDanger(');
    expect(deleteHandler).toContain("t('nav.sessions.bulkDeleteConfirmTitle')");
    expect(deleteHandler).toContain("{ confirmText: onlySources ? t('nav.sessions.removeSelected') : t('nav.sessions.deleteSelected') }");
    expect(deleteHandler.indexOf('await confirmDanger(')).toBeLessThan(
      deleteHandler.indexOf('await flowChatManager.deleteChatSession(rootId)'),
    );
  });
});
