import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('global search ownership', () => {
  it('mounts one shell-owned root and routes the nav trigger into its store', () => {
    expect(source('src/app/App.tsx')).toContain('<LazyGlobalSearchRoot />');
    expect(source('src/app/components/NavPanel/MainNav.tsx')).toContain('openGlobalSearch()');
    expect(source('src/app/components/NavPanel/MainNav.tsx')).not.toContain('NavSearchDialog');
  });

  it('keeps the shared search presentation outside the session right-panel empty state', () => {
    const globalSearch = source('src/app/global-search/GlobalSearchRoot.tsx');
    const globalSearchStyles = source('src/app/global-search/GlobalSearchRoot.scss');
    const auxPane = source('src/app/scenes/session/AuxPane.tsx');
    const contentCanvas = source('src/app/components/panels/content-canvas/ContentCanvas.tsx');
    const canvasShortcuts = source(
      'src/app/components/panels/content-canvas/hooks/useKeyboardShortcuts.ts',
    );

    expect(globalSearch).toContain('export const GlobalSearchContent');
    expect(globalSearch).toContain('variant="modal"');
    expect(auxPane).not.toContain('GlobalSearchContent');
    expect(auxPane).toContain('missionControlEnabled={false}');
    expect(contentCanvas).toContain('<EmptyState onClose={disablePopOut ? undefined : onCollapsePanel} toolbarActions={toolbarActions}>');
    expect(contentCanvas).toContain(
      'onOpenMissionControl={missionControlEnabled ? handleOpenMissionControl : undefined}',
    );
    expect(contentCanvas).toMatch(/\{missionControlEnabled && \(\s*<MissionControl/);
    expect(canvasShortcuts).toContain('enabled: enabled && missionControlEnabled');
    expect(globalSearch).toContain('className="global-search__query global-search__query--system"');
    expect(globalSearch).toContain('shortcut={query ? undefined : (');
    expect(globalSearch).toContain('<TabGroup');
    expect(globalSearch).toContain('className="global-search__scopes"');
    expect(globalSearch).not.toContain('global-search__scope--native');
    expect(globalSearch).toContain("if (itemVariant === 'action')");
    expect(globalSearch).toContain('if (entity)');
    expect(globalSearch).not.toContain("variant === 'modal' && itemVariant");
    expect(globalSearch).not.toMatch(/variant === 'embedded'\s*\|\| Boolean\(parsedQuery\.query\)/);
    expect(globalSearchStyles).toMatch(
      /\.global-search--modal,\s*\.global-search--embedded\s*\{/,
    );
    expect(globalSearchStyles).toContain('padding: var(--openbitfun-overlay-dialog-content-padding-lg)');
  });

  it('routes global-search action identities through canonical theme tokens in every host', () => {
    const globalSearch = source('src/app/global-search/GlobalSearchRoot.tsx');
    const globalSearchStyles = source('src/app/global-search/GlobalSearchRoot.scss');
    const actionCatalog = source('src/app/global-search/productActionCatalog.ts');

    expect(globalSearch).toContain('const GLOBAL_SEARCH_ACTION_ICON_ROLES: Partial<Record<ProductActionId');
    expect(globalSearch).toContain("'session.new': 'new-session'");
    expect(globalSearch).toContain("'surface.browser.open': 'open-browser'");
    expect(globalSearch).toContain("'surface.terminal.open': 'open-terminal'");
    expect(globalSearch).toContain("'project.open': 'open-project'");
    expect(globalSearch).toContain("'project.new': 'new-project'");
    expect(globalSearch).toContain("'surface.files.open': 'open-files'");
    expect(globalSearch).toContain("if (itemVariant === 'action')");
    expect(globalSearch).toContain('className="global-search__action-icon"');
    expect(globalSearch).toContain('data-icon-role={actionIconRole}');
    expect(actionCatalog).toMatch(/id: 'session\.new',[\s\S]*?icon: 'message-circle'/);
    expect(actionCatalog).toMatch(/id: 'project\.open',[\s\S]*?icon: 'folder'/);
    expect(actionCatalog).toMatch(/id: 'project\.new',[\s\S]*?icon: 'plus'/);
    expect(actionCatalog).toMatch(/id: 'settings\.open',[\s\S]*?icon: 'gear'/);
    expect(globalSearch).toContain("settings: { name: 'gear' }");
    expect(actionCatalog).not.toMatch(/'folder-open'|'folder-plus'/);

    expect(globalSearchStyles).toMatch(
      /\.global-search--modal,\s*\.global-search--embedded\s*\{[\s\S]*\.global-search__action-icon\s*\{/,
    );
    for (const role of [
      'new-session',
      'open-browser',
      'open-terminal',
      'open-project',
      'new-project',
      'open-files',
    ]) {
      expect(globalSearchStyles).toContain(`&[data-icon-role='${role}']`);
      expect(globalSearchStyles).toContain(`var(--openbitfun-color-identity-global-search-${role})`);
    }
    expect(globalSearchStyles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(globalSearchStyles).not.toContain('--openbitfun-color-status-');
    expect(actionCatalog).not.toMatch(/iconTone|iconColor|leadingTone/);
  });

  it('does not persist pointer hover as the keyboard-active result', () => {
    const globalSearch = source('src/app/global-search/GlobalSearchRoot.tsx');
    const globalSearchStyles = source('src/app/global-search/GlobalSearchRoot.scss');

    expect(globalSearch).not.toContain('onMouseEnter={() => setActiveId(item.id)}');
    expect(globalSearch).not.toContain('setActiveId(navigableItems[0].id)');
    expect(globalSearch).toContain("if (event.key === 'ArrowDown')");
    expect(globalSearch).toContain('setActiveId(navigableItems[nextIndex]?.id ?? null)');
    expect(globalSearchStyles).toMatch(
      /&:hover\s*\{\s*border-color: var\(--openbitfun-color-border-default\)/,
    );
  });

  it('keeps the modal results scrollbar on the dialog edge while preserving content inset', () => {
    const globalSearchStyles = source('src/app/global-search/GlobalSearchRoot.scss');

    expect(globalSearchStyles).toMatch(
      /\.global-search-modal-content\s*\{[^}]*padding-inline-end:\s*0;/,
    );
    expect(globalSearchStyles).toMatch(
      /> \.global-search__results,[\s\S]*?padding-inline-end:\s*var\(--global-search-modal-inline-end-inset\);/,
    );
  });

  it('keeps browser and terminal capabilities on the shared product activator without footer shortcuts', () => {
    const footer = source('src/app/components/NavPanel/components/PersistentFooterActions.tsx');
    const activator = source('src/app/global-search/productActionActivator.ts');

    expect(footer).not.toContain('data-testid="browser-panel-entry"');
    expect(footer).not.toContain('data-testid="shell-panel-entry"');
    expect(activator).toContain("case 'surface.browser.open':");
    expect(activator).toContain("case 'surface.terminal.open':");
    expect(activator).toContain("new CustomEvent('terminal-create-requested')");
    expect(activator).not.toContain("openNavScene('shell')");
  });

  it('does not register a Shell navigation surface in the left panel', () => {
    const navRegistry = source('src/app/scenes/nav-registry.ts');

    expect(navRegistry).not.toContain("import('./shell/ShellNav')");
    expect(navRegistry).not.toContain('shell: lazy(');
  });

  it('removes the superseded navigation-owned dialog', () => {
    expect(existsSync(resolve(process.cwd(), 'src/app/components/NavPanel/NavSearchDialog.tsx'))).toBe(false);
  });
});
