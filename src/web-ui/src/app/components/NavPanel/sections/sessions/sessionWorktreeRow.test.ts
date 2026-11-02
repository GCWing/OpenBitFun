import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceSessionCatalogTotal } from './workspaceSessionCatalogQuery';

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

const sessionsSection = read('./SessionsSection.tsx');
const sessionsSectionStyles = read('./SessionsSection.scss');

describe('worktree isolated session row', () => {
  it('derives the worktree fact from the shared session ordering helper', () => {
    expect(sessionsSection).toMatch(
      /import \{[^}]*isWorktreeIsolatedSession[^}]*\} from '@\/flow_chat\/utils\/sessionOrdering'/,
    );
    expect(sessionsSection).toContain('const worktreeIsolated = isWorktreeIsolatedSession(session);');
    // The row must never re-derive the fact from the execution target itself.
    expect(sessionsSection).not.toContain('session.config.executionTarget?.kind !==');
  });

  it('resolves the worktree directory the session runs in through the shared helper', () => {
    expect(sessionsSection).toMatch(
      /import \{ sessionWorktreeRootPath \} from '@\/flow_chat\/utils\/sessionWorktree'/,
    );
    expect(sessionsSection).toContain('const worktreeRootPath = sessionWorktreeRootPath(session) ?? \'\';');
  });

  it('marks the row with an accessible worktree badge', () => {
    expect(sessionsSection).toContain('openbitfun-nav-panel__inline-item-worktree-badge');
    expect(sessionsSection).toMatch(
      /aria-label=\{t\('nav\.sessions\.worktreeTooltip', \{ path: worktreeRootPath \}\)\}/,
    );
    expect(sessionsSectionStyles).toContain('&__inline-item-worktree-badge {');
  });

  it('keeps the worktree badge icon-only', () => {
    // The marker sits beside the title, so it carries no label text: the tooltip
    // and the aria-label stay as the accessible explanation.
    expect(sessionsSection).not.toContain("t('nav.sessions.worktreeBadge')");
    expect(sessionsSection).toMatch(
      /inline-item-worktree-badge"[\s\S]{0,400}?<FolderGit2 className="openbitfun-nav-panel__inline-item-worktree-icon" aria-hidden \/>\s*<\/span>/,
    );
    expect(sessionsSectionStyles).toMatch(
      /&__inline-item-worktree-badge \{[\s\S]*?inline-size: var\(--openbitfun-control-icon-size-md\);/,
    );
    // The glyph keeps a normal icon size inside the badge circle.
    expect(sessionsSectionStyles).toMatch(
      /\.openbitfun-nav-panel__inline-item-worktree-icon \{[\s\S]*?inline-size: var\(--openbitfun-control-icon-size-xs\);/,
    );
  });

  it('counts only the rows a linked worktree owns when sizing the expand toggle', () => {
    // Both the main checkout and linked worktrees share the storage total.
    // Ownership behavior is covered with real hierarchies in sessionNavHierarchy.test.ts.
    expect(sessionsSection).toContain('getWorkspaceSessionHierarchy(');
    expect(workspaceSessionCatalogTotal(3, { paged: false, total: 655 })).toBe(3);
    expect(workspaceSessionCatalogTotal(3, { paged: true, total: 94, knownCount: 3 })).toBe(94);
    expect(sessionsSection).not.toContain('getEffectiveTopLevelSessionCount');
  });

  it('explains the worktree execution in the row tooltip and badge title', () => {
    const occurrences = sessionsSection.match(
      /t\('nav\.sessions\.worktreeTooltip', \{ path: worktreeRootPath \}\)/g,
    );
    // Tooltip line and badge title/aria-label both surface the directory.
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(sessionsSection).toMatch(/worktreeIsolated \|\|\s*\n?\s*isDispatched/);
  });

  it('offers opening the worktree directory as a workspace only for worktree rows', () => {
    expect(sessionsSection).toMatch(
      /\{worktreeIsolated && worktreeRootPath \? \(\s*\n\s*<MenuItem/,
    );
    expect(sessionsSection).toContain('data-testid="nav-session-menu-open-worktree-workspace"');
    expect(sessionsSection).toContain('void handleOpenWorktreeWorkspace(e, worktreeRootPath);');
  });

  it('activates an already open worktree workspace and opens it otherwise', () => {
    expect(sessionsSection).toContain("isSamePath(workspace.rootPath ?? '', worktreePath)");
    expect(sessionsSection).toContain('await setActiveWorkspace(opened.id);');
    expect(sessionsSection).toContain('await openWorkspace(worktreePath);');
    expect(sessionsSection).toContain('const { setActiveWorkspace, openWorkspace, openedWorkspacesList, currentWorkspace } = useWorkspaceContext();');
  });

  it('reports a failure to open instead of failing silently', () => {
    expect(sessionsSection).toContain(
      "log.error('Failed to open the worktree directory as a workspace'",
    );
    expect(sessionsSection).toContain(
      "notificationService.error(t('nav.sessions.openWorktreeWorkspaceFailed')",
    );
  });
});

describe('worktree row copy', () => {
  const locales = ['en-US', 'zh-CN', 'zh-TW'] as const;

  for (const locale of locales) {
    it(`keeps the ${locale} copy for the worktree row`, () => {
      const catalog = JSON.parse(
        read(`../../../../../locales/${locale}/common.json`),
      ) as { nav: { sessions: Record<string, string> } };
      const sessions = catalog.nav.sessions;

      expect(sessions.openWorktreeWorkspace).toBeTruthy();
      expect(sessions.openWorktreeWorkspaceFailed).toBeTruthy();
      // The badge is icon-only, so it keeps no visible label copy.
      expect(sessions.worktreeBadge).toBeUndefined();
      // The badge title and the tooltip both interpolate the directory.
      expect(sessions.worktreeTooltip).toContain('{{path}}');
    });
  }
});
