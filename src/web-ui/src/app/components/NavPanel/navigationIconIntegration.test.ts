import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('navigation icon integration', () => {
  it('uses the standard extension icon in the expandable entry', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./MainNav.tsx', import.meta.url)),
      'utf8',
    );
    const entryStart = source.indexOf('data-testid="agent-skill-entry"');
    const entryEnd = source.indexOf('</NavigationPanelItem>', entryStart);
    const entryMarkup = source.slice(entryStart, entryEnd);

    expect(entryStart).toBeGreaterThanOrEqual(0);
    expect(entryEnd).toBeGreaterThan(entryStart);
    expect(entryMarkup).toContain(
      'className="openbitfun-nav-panel__top-action-icon-slot openbitfun-nav-panel__top-action-expand-icons"',
    );
    expect(entryMarkup).toContain('name="extension"');
    expect(entryMarkup).toContain('size="sm"');
  });

  it('keeps extension subnavigation icons at one optical weight', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./MainNav.tsx', import.meta.url)),
      'utf8',
    );
    const sublistStart = source.indexOf('data-testid="agent-skill-tabs"');
    const sublistEnd = source.indexOf('</div>', sublistStart);
    const sublistMarkup = source.slice(sublistStart, sublistEnd);

    expect(sublistStart).toBeGreaterThanOrEqual(0);
    expect(sublistEnd).toBeGreaterThan(sublistStart);
    expect(sublistMarkup).toContain('<Icon glyph={Users} size="sm" />');
    expect(sublistMarkup).toContain('<Icon name="book-open" size="sm" />');
    expect(sublistMarkup).toContain('<Icon glyph={Network} size="sm" />');
    expect(sublistMarkup).not.toContain('strokeWidth');
  });

  it('uses the reference clock icon for Task Board', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./MainNav.tsx', import.meta.url)),
      'utf8',
    );
    const entryStart = source.indexOf('data-testid="nav-todos-btn"');
    const entryEnd = source.indexOf('</NavigationPanelItem>', entryStart);
    const entryMarkup = source.slice(entryStart, entryEnd);

    expect(entryStart).toBeGreaterThanOrEqual(0);
    expect(entryEnd).toBeGreaterThan(entryStart);
    expect(entryMarkup).toContain('<Icon name="clock" size="sm" />');
    expect(source).not.toContain('CalendarClock');
  });

  it('uses standard grouped and all-session icons in one view toggle', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./components/WorkspaceSessionGroupingToggle.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain("import { List, ListTree } from 'lucide-react'");
    expect(source).toContain('const ViewIcon = isAll ? List : ListTree');
    expect(source).toContain('glyph={ViewIcon}');
    expect(source).toContain('size="sm"');
    expect(source).toContain('data-session-view-icon={grouping}');
    expect(source).toContain('data-testid="nav-workspace-session-view-toggle"');
    expect(source).not.toContain('strokeWidth');
    expect(source).not.toContain('NavigationSessionView');
  });

  it('uses the standard folder-add icon in the add-group action', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./MainNav.tsx', import.meta.url)),
      'utf8',
    );
    const actionStart = source.indexOf('data-testid="nav-workspace-add-btn"');
    const componentStart = source.lastIndexOf('<IconButton', actionStart);
    const actionEnd = source.indexOf('\n                      />', actionStart);
    const actionMarkup = source.slice(componentStart, actionEnd);

    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(componentStart).toBeGreaterThanOrEqual(0);
    expect(actionEnd).toBeGreaterThan(actionStart);
    expect(actionMarkup).toContain('<Icon glyph={FolderPlus} size="sm"');
    expect(actionMarkup).toContain('size="xs"');
    expect(actionMarkup).toContain('variant="quiet"');
  });

  it('uses one IconButton contract for all session header actions', () => {
    const groupingSource = readFileSync(
      fileURLToPath(new URL('./components/WorkspaceSessionGroupingToggle.tsx', import.meta.url)),
      'utf8',
    );
    const filterSource = readFileSync(
      fileURLToPath(new URL('./components/WorkspaceSessionFilterMenu.tsx', import.meta.url)),
      'utf8',
    );
    const mainNavSource = readFileSync(
      fileURLToPath(new URL('./MainNav.tsx', import.meta.url)),
      'utf8',
    );

    for (const source of [groupingSource, filterSource, mainNavSource]) {
      expect(source).toContain('<IconButton');
      expect(source).toContain('size="xs"');
      expect(source).toContain('variant="quiet"');
    }
  });

  it('uses stable standard icons for every session-group type', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./sections/workspaces/WorkspaceItem.tsx', import.meta.url)),
      'utf8',
    );
    const assistantStart = source.indexOf('openbitfun-nav-panel__assistant-item-group-icon');
    const assistantEnd = source.indexOf('</span>', assistantStart);
    const assistantMarkup = source.slice(assistantStart, assistantEnd);
    const workspaceStart = source.indexOf('openbitfun-nav-panel__workspace-item-icon-default');
    const workspaceEnd = source.indexOf('</span>', workspaceStart);
    const workspaceMarkup = source.slice(workspaceStart, workspaceEnd);

    expect(assistantMarkup).toContain('<Icon name="user" size="sm" />');
    expect(assistantMarkup).not.toContain('SessionGroupAssistant');

    expect(workspaceMarkup).toContain('workspaceIsRemote');
    expect(workspaceMarkup).toContain('<Icon glyph={Server} size="sm" />');
    expect(workspaceMarkup).toContain('<Icon name="folder" size="sm" />');
    expect(workspaceMarkup).not.toContain('SessionGroup');
  });
});
