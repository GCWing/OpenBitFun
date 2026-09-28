import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSessionsSectionStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('./SessionsSection.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function readSessionsSectionSource(): string {
  const source = readFileSync(
    fileURLToPath(new URL('./SessionsSection.tsx', import.meta.url)),
    'utf8',
  );
  return source.replace(/\r\n/g, '\n');
}

function extractInlineItemActionsBlock(stylesheet: string): string {
  const match = stylesheet.match(/&__inline-item-actions\s*\{(?<body>[\s\S]*?)\n\s*\}/);
  return match?.groups?.body ?? '';
}

function extractInlineItemBlock(stylesheet: string, element: string): string {
  const match = stylesheet.match(new RegExp(`&__inline-item-${element}\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\}`));
  return match?.groups?.body ?? '';
}

function extractBlock(stylesheet: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\}`));
  return match?.groups?.body ?? '';
}

describe('SessionsSection layout styles', () => {
  it('keeps session rows visually compact without reducing the click target height', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const inlineListBlock = extractBlock(stylesheet, '&__inline-list');
    const inlineItemBlock = extractBlock(stylesheet, '&__inline-item');

    expect(inlineListBlock).toContain('padding: 2px var(--openbitfun-space-1) 2px;');
    expect(inlineListBlock).toContain('margin: 0 var(--openbitfun-space-1) 0 calc(var(--openbitfun-space-1) + 4px);');
    expect(inlineListBlock).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(inlineItemBlock).toContain('height: 26px;');
    expect(stylesheet).toContain('margin-top: 0;');
  });

  it('shares one trailing slot between status and menu without shifting the title', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const inlineItemBlock = extractBlock(stylesheet, '&__inline-item');
    const mainBlock = extractInlineItemBlock(stylesheet, 'main');
    const actionsBlock = extractInlineItemActionsBlock(stylesheet);

    expect(stylesheet).toContain('&__inline-item-main {\n    flex: 1 1 0;');
    expect(inlineItemBlock).toContain('position: relative;');
    expect(mainBlock).not.toContain('padding-right');
    const trailingBlock = extractInlineItemBlock(stylesheet, 'trailing');
    expect(trailingBlock).toContain('display: grid;');
    expect(trailingBlock).toContain('flex: 0 0 var(--openbitfun-space-5);');
    const statusBlock = extractInlineItemBlock(stylesheet, 'status');
    expect(statusBlock).toContain('grid-area: 1 / 1;');
    expect(statusBlock).not.toContain('margin-inline-end');
    expect(statusBlock).toContain('.openbitfun-nav-panel__inline-item:hover &');
    expect(statusBlock).toContain('.openbitfun-nav-panel__inline-item:focus-within &');
    expect(statusBlock).toContain('.openbitfun-nav-panel__inline-item.is-menu-open &');
    expect(statusBlock).toContain('visibility: hidden;');
    expect(stylesheet).not.toContain('padding-right: 24px;');
    expect(actionsBlock).not.toContain('display: none;');
    expect(actionsBlock).not.toContain('position: absolute;');
    expect(actionsBlock).toContain('grid-area: 1 / 1;');
    expect(actionsBlock).not.toContain('visibility: hidden;');
    expect(actionsBlock).toContain('opacity: 0;');
    expect(actionsBlock).toContain('pointer-events: none;');
    expect(actionsBlock).toContain('.openbitfun-nav-panel__inline-item:hover &');
    expect(actionsBlock).toContain('.openbitfun-nav-panel__inline-item:focus-within &');
    expect(actionsBlock).toContain('&.is-open');
    expect(actionsBlock).toContain('opacity: 1;');
  });

  it('keeps session menu buttons at the compact row size', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const actionButtonBlock = extractBlock(stylesheet, '&__inline-item-action-btn');

    expect(actionButtonBlock).toContain('width: 20px;');
    expect(actionButtonBlock).toContain('height: 20px;');
  });

  it('anchors session detail tooltips beside the row instead of over adjacent sessions', () => {
    const source = readSessionsSectionSource();
    const sessionTooltip = source.match(
      /<Tooltip\s+key=\{session\.sessionId\}[\s\S]*?disabled=\{isEditing \|\| openMenuSessionId !== null\}\s*>/,
    )?.[0] ?? '';

    expect(sessionTooltip).toContain('content={tooltipContent}');
    expect(sessionTooltip).toContain('placement="right"');
    expect(sessionTooltip).not.toContain('followCursor');
  });

  it('centers empty session placeholder content', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const emptyBlock = extractBlock(stylesheet, '&__inline-empty');

    expect(emptyBlock).toContain('text-align: center;');
  });

  it('aligns the session expansion toggle to the session row text rail', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const toggleBlock = extractBlock(stylesheet, '&__inline-toggle');
    const inlineItemBlock = extractBlock(stylesheet, '&__inline-item');
    const inlineListBlock = extractBlock(stylesheet, '&__inline-list');

    // The toggle is a sibling of the rows, so both take their left padding from
    // one inherited rail. Context stylesheets that indent rows (see
    // WorkspaceListSection's 30px icon gutter) only have to move the rail.
    expect(inlineListBlock).toContain('--openbitfun-nav-session-rail:');
    expect(toggleBlock).toContain('padding: 0 var(--openbitfun-space-1) 0 var(--openbitfun-nav-session-rail);');
    expect(inlineItemBlock).toContain('padding: 0 var(--openbitfun-space-1) 0 var(--openbitfun-nav-session-rail);');
    expect(toggleBlock).toContain('justify-content: flex-start;');
    expect(toggleBlock).toContain('text-align: left;');
    expect(toggleBlock).toContain(`gap: ${inlineItemBlock.match(/gap: (\d+px);/)?.[1] ?? ''};`);
    expect(toggleBlock).not.toContain('justify-content: center;');
    // Every rule that indents a row must move the rail rather than hard-coding
    // padding-left, or the sibling toggle silently drifts off the rail again.
    const rowPaddingDecls = stylesheet.match(/&__inline-item \{[^}]*?padding(?:-left)?: [^;]+;/g) ?? [];
    expect(rowPaddingDecls.length).toBeGreaterThan(0);
    for (const decl of rowPaddingDecls) {
      expect(decl).toContain('var(--openbitfun-nav-session-rail)');
    }
  });

  it('indents child connectors from the parent session text rail', () => {
    const stylesheet = readSessionsSectionStylesheet();

    expect(stylesheet).toContain(
      'padding-left: calc(var(--openbitfun-nav-session-rail) + 14px);',
    );
    expect(
      stylesheet.match(/left: calc\(var\(--openbitfun-nav-session-rail\) \+ 2px\);/g),
    ).toHaveLength(2);
    expect(stylesheet).not.toContain('left: 8px;');
  });

  it('keeps the remaining session count in a compact trailing chip', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const countBlock = extractBlock(stylesheet, '&__inline-toggle-count');
    const labelBlock = extractBlock(stylesheet, '&__inline-toggle-label');
    const source = readSessionsSectionSource();

    expect(countBlock).toContain('flex: 0 0 auto;');
    expect(countBlock).toContain('border-radius: 999px;');
    expect(countBlock).toContain('font-variant-numeric: tabular-nums;');
    // The label grows to fill the row, pushing the chip and the chevron to the
    // trailing edge, and absorbs overflow so the chip is never ellipsized away.
    expect(labelBlock).toContain('flex: 1 1 auto;');
    expect(labelBlock).toContain('min-width: 0;');
    expect(labelBlock).not.toContain('text-overflow: ellipsis;');
    expect(source).toMatch(/<OverflowText[^>]*className="openbitfun-nav-panel__inline-toggle-label"/);
    // The chip is decorative; the full sentence stays on the button's aria-label.
    expect(source).toContain('className="openbitfun-nav-panel__inline-toggle-count" aria-hidden');
    expect(source).toContain("aria-label={t('nav.sessions.showMore', {");
    expect(source).toContain('aria-label={expandToggleLabels.ariaLabel}');
    expect(source).not.toContain('inline-toggle-dots');
  });

  it('keeps child-session badges visible outside the title marquee', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const labelBlock = extractInlineItemBlock(stylesheet, 'label');
    const btwBadgeBlock = extractInlineItemBlock(stylesheet, 'btw-badge');
    const reviewBadgeBlock = extractInlineItemBlock(stylesheet, 'review-badge');
    const backgroundSubagentBadgeBlock = extractInlineItemBlock(stylesheet, 'background-subagent-badge');

    expect(labelBlock).toContain('flex: 1 1 0;');
    expect(labelBlock).toContain('overflow: hidden;');
    expect(labelBlock).not.toContain('text-overflow: ellipsis;');
    expect(readSessionsSectionSource()).toMatch(/<OverflowText[^>]*behavior="marquee"[^>]*className="openbitfun-nav-panel__inline-item-label"/);
    expect(btwBadgeBlock).toContain('flex: 0 0 auto;');
    expect(readSessionsSectionSource()).toMatch(/<StatusPill[^>]*className="openbitfun-nav-panel__inline-item-btw-badge"[^>]*tone="neutral">\s*\{childSessionBadge\}\s*<\/StatusPill>/);
    expect(reviewBadgeBlock).toContain('white-space: nowrap;');
    expect(reviewBadgeBlock).toContain('color: color-mix(in srgb, color-mix(in srgb, var(--openbitfun-color-accent-default) 40%, transparent) 82%, var(--openbitfun-color-content-primary));');
    expect(reviewBadgeBlock).toContain('font-weight: var(--openbitfun-type-label-selected-font-weight);');
    expect(backgroundSubagentBadgeBlock).toContain('flex: 0 0 auto;');
    expect(backgroundSubagentBadgeBlock).toContain('display: inline-grid;');
    expect(backgroundSubagentBadgeBlock).toContain('place-items: center;');
    expect(backgroundSubagentBadgeBlock).toContain('line-height: 0;');
    expect(backgroundSubagentBadgeBlock).toContain('width: var(--openbitfun-control-icon-size-md);');
    expect(backgroundSubagentBadgeBlock).toContain('height: var(--openbitfun-control-icon-size-md);');
    // The scheduled-job mark is not a chip beside the title: it is one 12px
    // secondary clock in the trailing cell, the same drawing and slot the session
    // status indicator uses, so no `cron` rule may come back to the stylesheet.
    expect(stylesheet).not.toContain('cron');
    expect(readSessionsSectionSource()).toContain('idleFallback={scheduledJobMark}');
    expect(readSessionsSectionSource()).toMatch(/<Icon\s+name="clock"\s+size="xs"\s+tone="secondary"/);
    expect(readSessionsSectionSource()).not.toMatch(/inline-item-cron/);

    const backgroundSubagentIconBlock = extractInlineItemBlock(stylesheet, 'background-subagent-icon');
    expect(backgroundSubagentIconBlock).toContain('place-self: center;');
    expect(backgroundSubagentIconBlock).toContain('display: block;');
    expect(backgroundSubagentIconBlock).toContain('transform-origin: center center;');
    expect(stylesheet).not.toContain('--openbitfun-subagent-bot-optical-y');
    expect(stylesheet).not.toContain('translateY(var(--openbitfun-subagent-bot-optical-y))');
  });

  it('ends session rows and the group toggle on the workspace trailing column', () => {
    const stylesheet = readSessionsSectionStylesheet();
    const source = readSessionsSectionSource();

    // Workspace card rows end their trailing actions 4px inside the row box
    // (`__workspace-item` inline padding plus the actions' own right offset).
    // Session rows must end on that same column instead of the 8px reading
    // gutter, or their three-dot buttons sit left of the workspace ones.
    const rowBlock = stylesheet.slice(stylesheet.lastIndexOf('&__inline-item {'));
    expect(rowBlock).toContain('padding-right: var(--openbitfun-space-1);');
    expect(rowBlock).not.toContain('padding-right: var(--openbitfun-space-2);');

    // The toggle's state icon needs the row's trailing cell: flushed to the
    // padding edge its centre sat half a cell right of the dots' column.
    const toggleTrailingBlock = extractBlock(stylesheet, '&__inline-toggle-trailing');
    expect(toggleTrailingBlock).toContain('display: grid;');
    expect(toggleTrailingBlock).toContain('flex: 0 0 var(--openbitfun-space-5);');
    expect(toggleTrailingBlock).toContain('place-items: center;');
    expect(extractInlineItemBlock(stylesheet, 'trailing')).toContain(
      'flex: 0 0 var(--openbitfun-space-5);',
    );
    expect(source).toMatch(
      /className="openbitfun-nav-panel__inline-toggle-trailing"[\s\S]{0,400}?inline-toggle-chevron/,
    );
  });
});
