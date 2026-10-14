import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readWorkspaceListStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('./WorkspaceListSection.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function readWorkspaceItemSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./WorkspaceItem.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function readWorkspaceListSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./WorkspaceListSection.tsx', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

function extractBlock(stylesheet: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\}`, 'm'));
  return match?.groups?.body ?? '';
}

describe('WorkspaceListSection layout styles', () => {
  it('keeps peer session groups airier than rows inside one group', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const workspaceList = extractBlock(stylesheet, '&__workspace-list');
    const workspaceDropTarget = extractBlock(stylesheet, '&__workspace-drop-target');

    expect(workspaceList).toContain('gap: var(--openbitfun-space-2);');
    expect(workspaceDropTarget).toContain('gap: 0;');
  });

  it('keeps workspace rows constrained while only visible row actions reserve title space', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const workspaceList = extractBlock(stylesheet, '&__workspace-list');
    const workspaceGroup = extractBlock(stylesheet, '&__workspace-group');
    const workspaceItem = extractBlock(stylesheet, '&__workspace-item');
    const workspaceCard = extractBlock(stylesheet, '&__workspace-item-card');
    const workspaceIcon = extractBlock(stylesheet, '&__workspace-item-icon');
    const workspaceNameButton = extractBlock(stylesheet, '&__workspace-item-name-btn');
    const workspaceTitle = extractBlock(stylesheet, '&__workspace-item-title');
    const workspaceLabel = extractBlock(stylesheet, '&__workspace-item-label');
    const workspaceActions = extractBlock(stylesheet, '&__workspace-item-actions');
    const workspaceMenu = extractBlock(stylesheet, '&__workspace-item-menu');
    const assistantItem = extractBlock(stylesheet, '&__assistant-item');
    const assistantCard = extractBlock(stylesheet, '&__assistant-item-card');
    const assistantCollapseButton = extractBlock(stylesheet, '&__assistant-item-open-btn');
    const assistantIcon = extractBlock(stylesheet, '&__assistant-item-avatar');
    const assistantNameButton = extractBlock(stylesheet, '&__assistant-item-name-btn');
    const assistantLabel = extractBlock(stylesheet, '&__assistant-item-label');
    const assistantMenu = extractBlock(stylesheet, '&__assistant-item-menu');

    expect(workspaceList).toContain('min-width: 0;');
    expect(workspaceList).toContain('max-width: 100%;');
    expect(workspaceGroup).toContain('min-width: 0;');
    expect(workspaceItem).toContain('min-width: 0;');
    expect(workspaceItem).toContain('max-width: 100%;');
    expect(workspaceItem).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(workspaceCard).toContain('max-width: 100%;');
    expect(workspaceCard).toContain('overflow: hidden;');
    expect(workspaceIcon).toContain('width: var(--_nav-icon-size-prominent);');
    expect(workspaceIcon).toContain('height: var(--_nav-icon-size-prominent);');
    expect(workspaceNameButton).toContain('flex: 0 1 auto;');
    expect(workspaceNameButton).toContain('overflow: hidden;');
    expect(workspaceNameButton).not.toContain('58px');
    expect(stylesheet).toContain('padding-right: 76px;');
    expect(stylesheet).toContain('&__workspace-item:hover &__workspace-item-name-stack');
    expect(stylesheet).toContain('&__workspace-item.is-menu-open &__workspace-item-name-stack');
    expect(stylesheet).not.toContain('&__workspace-item.is-active &__workspace-item-name-btn');
    expect(stylesheet).toContain('&:not(:hover):not(:focus-within):not(.is-menu-open)');
    expect(workspaceTitle).toContain('flex: 1 1 0;');
    expect(workspaceTitle).toContain('max-width: 100%;');
    expect(workspaceLabel).toContain('flex: 1 1 0;');
    expect(workspaceLabel).toContain('overflow: hidden;');
    expect(workspaceLabel).not.toContain('text-overflow: ellipsis;');
    expect(readWorkspaceItemSource()).toMatch(
      /<OverflowText\s+behavior="marquee"\s+className="openbitfun-nav-panel__workspace-item-label"/,
    );
    expect(workspaceActions).toContain('position: absolute;');
    expect(workspaceActions).toContain('right: 4px;');
    expect(workspaceActions).toContain('gap: 4px;');
    expect(workspaceMenu).toContain('gap: 4px;');

    expect(assistantItem).toContain('min-width: 0;');
    expect(assistantItem).toContain('max-width: 100%;');
    expect(assistantItem).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(assistantCard).toContain('max-width: 100%;');
    expect(assistantCard).toContain('min-height: 30px;');
    expect(assistantCard).toContain('overflow: hidden;');
    expect(assistantCollapseButton).toContain('width: 26px;');
    expect(assistantCollapseButton).toContain('min-height: 30px;');
    expect(assistantCollapseButton).toContain('padding: 0 0 0 4px;');
    expect(assistantIcon).toContain('width: var(--_nav-icon-size-prominent);');
    expect(assistantIcon).toContain('height: var(--_nav-icon-size-prominent);');
    expect(assistantIcon).toContain('color: inherit;');
    expect(assistantIcon).toContain('opacity: 1;');
    expect(assistantNameButton).toContain('flex: 1 1 0;');
    expect(assistantNameButton).toContain('min-height: 30px;');
    expect(assistantNameButton).toContain('padding: 0 4px;');
    expect(assistantNameButton).toContain('overflow: hidden;');
    expect(assistantNameButton).not.toContain('58px');
    expect(stylesheet).toContain('&__assistant-item:hover &__assistant-item-name-btn');
    expect(stylesheet.match(/padding-right: 76px;/g)).toHaveLength(2);
    expect(stylesheet).not.toContain('padding-right: 48px;');
    expect(stylesheet).toContain('&__assistant-item.is-menu-open &__assistant-item-name-btn');
    expect(stylesheet).not.toContain('&__assistant-item.is-active &__assistant-item-name-btn');
    expect(assistantLabel).toContain('flex: 1 1 0;');
    expect(assistantLabel).not.toContain('text-overflow: ellipsis;');
    expect(assistantMenu).toContain('position: absolute;');
    expect(assistantMenu).toContain('right: 4px;');
    expect(assistantMenu).toContain('gap: 4px;');
    // The 30px session indent now lives on the list as a shared rail so the
    // rows and their sibling "show more" toggle stay on one text axis.
    expect(stylesheet).toContain('--openbitfun-nav-session-rail: 30px;');
    expect(stylesheet).toContain('padding-right: 0;');
  });

  it('keeps nested selection surfaces full-width while aligning their titles', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const fullWidthSessionLists = stylesheet.match(
      /\.openbitfun-nav-panel__inline-list \{\n\s+\/\/[^\n]+\n\s+margin-left: 0;/g,
    );
    const sessionRails = stylesheet.match(/--openbitfun-nav-session-rail: 30px;/g);

    expect(fullWidthSessionLists).toHaveLength(1);
    expect(sessionRails).toHaveLength(1);
    // SessionsSection derives both the child connector and title offsets from
    // this rail. Context-specific child padding would split those axes again.
    expect(stylesheet).not.toMatch(/&\.is-child\s*\{\s*padding-left:/);
    expect(stylesheet).not.toContain('margin-left: 22px;');
    expect(stylesheet).toContain(
      '&__workspace-item.is-active:has(&__workspace-item-sessions &__inline-item.is-active)',
    );
    expect(stylesheet).not.toContain('&__assistant-item-sessions');
  });

  it('keeps all three workspace hover actions at the compact row size', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const source = readWorkspaceItemSource();
    const workspaceTrigger = extractBlock(stylesheet, '&__workspace-item-menu-trigger');
    const assistantTrigger = extractBlock(stylesheet, '&__assistant-item-menu-trigger');

    for (const block of [workspaceTrigger, assistantTrigger]) {
      expect(block).toContain('width: 20px;');
      expect(block).toContain('height: 20px;');
    }
    expect(source.match(/data-testid="nav-workspace-new-session-btn"/g)).toHaveLength(2);
  });

  it('keeps the scheduled-job mark off workspace rows', () => {
    const source = readWorkspaceItemSource();

    // A workspace row owns no session, so the scheduled-job count it used to
    // borrow from its sessions belongs on the session rows only. The workspace
    // row must not subscribe to the counts store or claim the name row's
    // trailing metadata slot for it.
    expect(source).not.toContain('cronJobCountsStore');
    expect(source).not.toContain('scheduledJobCount');
    expect(source).not.toContain('scheduledJobBadge');
    expect(source).not.toContain('inline-item-cron');
    expect(source).not.toContain('nav.scheduledJobs.badgeTooltip');
    expect(source).not.toContain('metadata={scheduledJobBadge}');
  });

  it('keeps workspace and assistant rows flat on hover', () => {
    const stylesheet = readWorkspaceListStylesheet();

    expect(stylesheet).toContain(
      '.openbitfun-nav-panel__workspace-item:hover,\n' +
      '  .openbitfun-nav-panel__assistant-item:hover,\n' +
      '  .openbitfun-nav-panel__workspace-item-card:hover,\n' +
      '  .openbitfun-nav-panel__assistant-item-card:hover {\n' +
      '    transform: none;\n' +
      '    box-shadow: none;\n' +
      '  }',
    );
  });

  it('uses distinct disclosure icons for collapsed and expanded session groups', () => {
    const source = readWorkspaceItemSource();
    const stylesheet = readWorkspaceListStylesheet();

    expect(source).toContain(
      "const sessionDisclosureIcon = sessionsCollapsed ? 'chevron-right' : 'chevron-down';",
    );
    expect(source.match(/<Icon name=\{sessionDisclosureIcon\} size="sm" \/>/g)).toHaveLength(1);
    expect(stylesheet).not.toContain('&.is-collapsed svg');
  });

  it('keeps remote workspace directory and host metadata on one row with the status dot first', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const remoteChip = extractBlock(stylesheet, '&__workspace-item-remote');
    const remoteHost = extractBlock(stylesheet, '&__workspace-item-remote-host');
    const remoteNameRow = extractBlock(
      stylesheet,
      "&__workspace-item[data-openbitfun-state~='remote'] &__workspace-item-name-row",
    );
    const remoteNameButton = extractBlock(
      stylesheet,
      "&__workspace-item[data-openbitfun-state~='remote'] &__workspace-item-name-btn",
    );

    expect(remoteNameRow).toContain('gap: var(--openbitfun-space-2);');
    expect(remoteNameButton).toContain('flex: 1 1 0;');
    expect(remoteNameButton).toContain('max-width: none;');
    expect(remoteChip).toContain('gap: var(--openbitfun-space-2);');
    expect(remoteChip).toContain('flex: 0 0 auto;');
    expect(remoteChip).toContain('margin-left: auto;');
    expect(remoteChip).toContain('padding: 0 var(--openbitfun-space-2);');
    expect(remoteChip).toContain('border-radius: var(--openbitfun-radius-base);');
    expect(stylesheet).toContain(
      '&.is-connected {\n' +
      '      background: var(--openbitfun-color-status-success-surface);\n' +
      '      color: var(--openbitfun-color-status-success-content);',
    );
    expect(remoteHost).toContain('flex: 0 0 auto;');
    expect(remoteHost).toContain('white-space: nowrap;');
    expect(remoteHost).not.toContain('text-overflow: ellipsis;');

    const source = readWorkspaceItemSource();
    const remoteNameStart = source.indexOf('behavior="marquee"');
    const searchIndicatorStart = source.indexOf('{searchIndexIndicator && (', remoteNameStart);
    const remoteMetaStart = source.indexOf('data-testid="nav-workspace-remote-meta"');
    const remoteMetaEnd = source.indexOf('</Tooltip>', remoteMetaStart);
    const remoteMetaMarkup = source.slice(remoteMetaStart, remoteMetaEnd);

    expect(remoteMetaStart).toBeGreaterThanOrEqual(0);
    expect(remoteMetaEnd).toBeGreaterThan(remoteMetaStart);
    expect(source).toContain('const hostLabel = workspace.sshHost?.trim() || connectionLabel;');
    expect(source).toContain('<OverflowText');
    expect(source).toContain('behavior="marquee"');
    expect(searchIndicatorStart).toBeGreaterThan(remoteNameStart);
    expect(remoteMetaStart).toBeGreaterThan(searchIndicatorStart);
    expect(remoteMetaMarkup).toContain('remoteMeta.connectionLabel');
    expect(remoteMetaMarkup.indexOf('workspace-item-status-dot'))
      .toBeLessThan(remoteMetaMarkup.indexOf('workspace-item-remote-host'));
    expect(source).not.toContain('workspace-item-subtitle');
  });

  it('keeps remote workspace icons aligned with the single-line row', () => {
    const stylesheet = readWorkspaceListStylesheet();
    const workspaceCard = extractBlock(stylesheet, '&__workspace-item-card');
    const collapseButton = extractBlock(stylesheet, '&__workspace-item-collapse-btn');

    expect(workspaceCard).toContain('align-items: center;');
    expect(collapseButton).toContain('min-height: 30px;');
    expect(stylesheet).not.toContain(
      "&__workspace-item[data-openbitfun-state~='remote'] &__workspace-item-collapse-btn",
    );
  });

  it('uses stable OpenBitFun semantics for grouped entries without a redundant aggregate header', () => {
    const itemSource = readWorkspaceItemSource();
    const listSource = readWorkspaceListSource();
    const stylesheet = readWorkspaceListStylesheet();

    expect(itemSource).toContain('<AssistantAvatar size={22} name={workspaceDisplayName} />');
    expect(itemSource).toContain('<Icon glyph={Server} size="sm" />');
    expect(itemSource).toContain('<Icon name="folder" size="sm" />');
    expect(itemSource).not.toContain('SessionGroup');
    expect(listSource).not.toContain('nav.sessions.viewMenu.grouping.all');
    expect(listSource).not.toContain('workspace-all-sessions-header');
    expect(stylesheet).not.toContain('&__workspace-all-sessions-header');
    expect(stylesheet).not.toContain('&__workspace-all-sessions-icon');
    expect(stylesheet).not.toContain('&__assistant-item-group-icon');
    expect(extractBlock(stylesheet, '&__workspace-item:not(.is-active) &__workspace-item-icon'))
      .toContain('opacity: 1;');
    expect(extractBlock(stylesheet, '&__assistant-item:not(.is-active) &__assistant-item-avatar'))
      .toContain('opacity: 1;');
  });

  it('keeps assistant history in a dialog without inline disclosure or a resource shortcut', () => {
    const source = readWorkspaceItemSource();
    const start = source.indexOf('if (workspace.workspaceKind === WorkspaceKind.Assistant)');
    const assistant = source.slice(start, source.indexOf('\n  return (', start));

    expect(assistant).not.toContain('nav-workspace-session-region');
    expect(assistant).not.toContain('nav-workspace-sessions-toggle');
    expect(assistant).not.toContain('nav-workspace-files-btn');
    expect(assistant).not.toContain('handleCollapseToggle');
    for (const removedAction of ['project-permissions', 'reveal', 'open-session-storage', 'manage-sessions', 'copy-path']) {
      expect(assistant).not.toContain(`data-testid="nav-workspace-menu-${removedAction}"`);
    }
    expect(assistant).toContain('nav-assistant-history-btn');
    expect(assistant).toContain('nav-workspace-menu-manage-assistant');
    expect(source).toContain('useNurseryStore.getState().openAssistant(workspace.id)');
    expect(source).toContain("useSceneStore.getState().openScene('assistant')");
    expect(assistant).toContain('{assistantHistoryOpen && (');
    expect(assistant).toContain('onClose={() => setAssistantHistoryOpen(false)}');
    expect(assistant).toContain('handleOpenLatestAssistantSession');
  });
});
