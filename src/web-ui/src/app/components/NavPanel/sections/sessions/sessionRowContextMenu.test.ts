import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSessionsSectionSource(): string {
  const source = readFileSync(
    fileURLToPath(new URL('./SessionsSection.tsx', import.meta.url)),
    'utf8',
  );
  return source.replace(/\r\n/g, '\n');
}

describe('SessionsSection session row context menu', () => {
  it('opens the shared row menu on right click and suppresses the browser menu', () => {
    const source = readSessionsSectionSource();

    expect(source).toContain('onContextMenu={event => handleContextMenu(event, session.sessionId)}');
    expect(source).toMatch(/handleContextMenu = useCallback\(\s*\(e: React\.MouseEvent, sessionId: string\)/);
    expect(source).toMatch(/e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
    // Right click opens the same menu the "more" button opens, reusing closeSessionMenu.
    expect(source).toContain('setOpenMenuSessionId(sessionId);');
    expect(source).toContain('setIsExportScopeMenu(false);');
  });

  it('keeps the inline editor usable by skipping the context menu for the edited row', () => {
    const source = readSessionsSectionSource();
    // The guard must compare against the row being edited, not just any edit state.
    expect(source).toContain('if (editingSessionId === sessionId) {\n        return;\n      }');
  });

  it('anchors the context-menu variant to the right-click point', () => {
    const source = readSessionsSectionSource();
    expect(source).toContain("sessionMenuAnchorKindRef.current = 'context';");
    expect(source).toContain('const point = { x: e.clientX, y: e.clientY };');
    expect(source).toContain('sessionMenuContextPointRef.current = point;');
    expect(source).toContain('const { top, left } = computeFixedPopoverPositionInViewport(');
  });

  it('reuses the shared portal menu for the context-menu path', () => {
    const source = readSessionsSectionSource();
    expect(source).toContain('openMenuSessionId === session.sessionId && createOverlayPortal(');
    expect(source).toContain("visibility: sessionMenuPosition ? 'visible' : 'hidden'");
    expect(source).toContain('data-testid="nav-session-menu"');
  });

  it('exposes the copy action to both menu entry points as one shared row', () => {
    const source = readSessionsSectionSource();
    // The copy action lives in the single shared Menu, so the "more" button and
    // right click open the same entry with the same handler.
    expect(source).toContain('data-testid="nav-session-menu-duplicate"');
    expect(source).toMatch(/handleDuplicateSession = useCallback\(\s*async \(e: React\.MouseEvent, sessionId: string\)/);
    expect(source).toContain('await flowChatManager.duplicateChatSession(sessionId)');
    expect(source).toContain("t('nav.sessions.duplicateSuccess'");
    expect(source).toContain('{ name: copied.sessionName }');
    expect(source).toContain("t('nav.sessions.duplicateFailed')");
  });

  it('keeps copy unavailable while a turn runs or another device owns the session', () => {
    const source = readSessionsSectionSource();
    // A running turn is not a stable copy boundary, and a dispatch-owned session
    // has no local history to copy. Both entry points share these guards.
    expect(source).toContain('disabled={isDispatched');
    expect(source).toContain('|| runningSessionIds.has(session.sessionId)');
    expect(source).toContain('|| duplicatingSessionId === session.sessionId}');
    expect(source).toContain("t('nav.sessions.duplicateDispatchUnsupported')");
    expect(source).toContain("t('nav.sessions.duplicateRunning')");
  });
});
