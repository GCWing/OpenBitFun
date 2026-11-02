import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readNavPanelStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('./NavPanel.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function readNavPanelTypographyStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('../../styles/nav-panel-font-scope.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function readWorkspaceListStylesheet(): string {
  const stylesheet = readFileSync(
    fileURLToPath(new URL('./sections/workspaces/WorkspaceListSection.scss', import.meta.url)),
    'utf8',
  );
  return stylesheet.replace(/\r\n/g, '\n');
}

function extractBlock(stylesheet: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[\\s\\S]*?)\\n\\s*\\}`));
  return match?.groups?.body ?? '';
}

describe('NavPanel layout styles', () => {
  it('allows navigation list wrappers to shrink instead of inheriting long item widths', () => {
    const stylesheet = readNavPanelStylesheet();
    const rootBlock = extractBlock(stylesheet, '.openbitfun-nav-panel');
    const contentBlock = extractBlock(stylesheet, '&__content');
    const mainLayerBlock = extractBlock(stylesheet, '&--main');
    const itemsBlock = extractBlock(stylesheet, '&__items');

    for (const block of [
      rootBlock,
      contentBlock,
      mainLayerBlock,
      itemsBlock,
    ]) {
      expect(block).toContain('min-width: 0;');
      expect(block).toContain('max-width: 100%;');
    }
  });

  it('keeps root navigation rows close to the panel edge', () => {
    const stylesheet = readNavPanelStylesheet();
    const sectionHeaderBlock = extractBlock(stylesheet, '&__section-header');
    const itemsBlock = extractBlock(stylesheet, '&__items');
    const topActionExpandBlock = extractBlock(stylesheet, '&__top-action-expand');
    const topActionSublistBlock = extractBlock(stylesheet, '.openbitfun-nav-panel__top-action-sublist-inner');

    expect(itemsBlock).toContain('padding: 2px var(--openbitfun-space-1);');
    expect(itemsBlock).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(topActionExpandBlock).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(topActionSublistBlock).toContain('gap: calc(var(--openbitfun-space-1) / 2);');
    expect(sectionHeaderBlock).toContain('margin: 0 var(--openbitfun-space-1);');
  });

  it('ends the section header actions on the workspace row action column', () => {
    const navStylesheet = readNavPanelStylesheet();
    const workspaceListStylesheet = readWorkspaceListStylesheet();

    // The sticky section header and the rows below it live in different
    // stylesheets, so their trailing edges only agree if both resolve to the same
    // column: the 12px list inset plus the row's own transparent 1px border plus
    // the 4px row-action offset. The header override has to give up exactly that
    // border width, or its icons sit 3px inside the workspace row actions.
    const trailingHeaderOverrides = [...navStylesheet.matchAll(/&__section-header\s*\{(?<body>[^}]*)\}/g)]
      .map(match => match.groups?.body ?? '')
      .filter(body => body.includes('padding-right:'));
    const itemsOverrides = [...navStylesheet.matchAll(/&__items\s*\{(?<body>[^}]*)\}/g)]
      .map(match => match.groups?.body ?? '')
      .filter(body => body.includes('padding:'));
    const sectionActionsBlock = extractBlock(navStylesheet, '&__section-actions');
    const workspaceItemBlock = extractBlock(workspaceListStylesheet, '&__workspace-item');
    const workspaceActionsBlock = extractBlock(workspaceListStylesheet, '&__workspace-item-actions');
    const workspaceActionMenuBlock = extractBlock(workspaceListStylesheet, '&__workspace-item-menu');
    const workspaceActionTriggerBlock =
      extractBlock(workspaceListStylesheet, '&__workspace-item-menu-trigger');

    // A single trailing-edge owner keeps the column from being silently undone by
    // a later block, so assert the count as part of the contract.
    expect(trailingHeaderOverrides).toHaveLength(1);
    const headerTrailing = trailingHeaderOverrides[0]!;
    const itemsTrailing = itemsOverrides[itemsOverrides.length - 1]!;

    expect(itemsTrailing).toContain('padding: 2px var(--openbitfun-space-3);');
    expect(workspaceItemBlock).toContain('border: 1px solid transparent;');
    expect(workspaceActionsBlock).toContain('right: 4px;');
    expect(headerTrailing).toContain('margin: 0 var(--openbitfun-space-3);');
    expect(headerTrailing).toContain(
      'padding-right: calc(var(--openbitfun-space-1) + var(--openbitfun-border-width-default));',
    );
    expect(headerTrailing).not.toContain('padding-right: var(--openbitfun-space-2);');

    // Matching trailing edges are not enough: the pitch has to match too, or the
    // first and second icons drift 2px and 4px off the row columns. Both clusters
    // are therefore a 20px box on a 4px gap.
    expect(workspaceActionTriggerBlock).toContain('width: 20px;');
    expect(workspaceActionTriggerBlock).toContain('height: 20px;');
    expect(workspaceActionMenuBlock).toContain('gap: 4px;');
    expect(sectionActionsBlock).toContain('gap: 4px;');
  });

  it('keeps the sessions section header static and visually flat', () => {
    const stylesheet = readNavPanelStylesheet();
    const sectionHeaderBlock = extractBlock(stylesheet, '&__section-header');

    expect(sectionHeaderBlock).not.toContain('&--interactive');
    expect(sectionHeaderBlock).not.toContain('cursor: pointer;');
    expect(stylesheet).not.toContain('.openbitfun-nav-panel__section-header--interactive:hover');
    expect(stylesheet).not.toContain('&__collapsible');
  });

  it('keeps section actions on the compact row action box', () => {
    const stylesheet = readNavPanelStylesheet();
    const sectionActionBlock = extractBlock(stylesheet, '&__section-action');
    const actionWrapBlock = extractBlock(stylesheet, '&__workspace-action-wrap');
    const itemActionBlock = extractBlock(stylesheet, '&__item-action');

    // The header cluster shares the workspace row's geometry so the two groups
    // stack on one set of icon columns; the wrap has to follow the button, or it
    // reserves a box the button does not fill and the columns drift again.
    expect(sectionActionBlock).toContain('inline-size: 20px;');
    expect(sectionActionBlock).toContain('block-size: 20px;');
    expect(actionWrapBlock).toContain('inline-size: 20px;');
    expect(actionWrapBlock).toContain('block-size: 20px;');
    expect(itemActionBlock).toContain('width: 20px;');
    expect(itemActionBlock).toContain('height: 20px;');
  });

  it('uses the selected label weight for active navigation rows', () => {
    const stylesheet = readNavPanelTypographyStylesheet();
    const activeRowMixin = extractBlock(stylesheet, '@mixin nav-panel-text-row-active');

    expect(activeRowMixin).toContain(
      'font-weight: var(--openbitfun-type-label-selected-font-weight);',
    );
    expect(activeRowMixin).not.toContain(
      'font-weight: var(--openbitfun-type-label-sm-font-weight);',
    );
  });

  it('centers footer actions with symmetric vertical padding', () => {
    const stylesheet = readNavPanelStylesheet();
    const footerBlocks = [...stylesheet.matchAll(
      /\.openbitfun-nav-panel__footer\s*\{(?<body>[\s\S]*?)\n\s*\}/g,
    )].map(match => match.groups?.body ?? '');

    expect(footerBlocks).toHaveLength(2);
    expect(footerBlocks[0]).toContain('padding: 2px var(--openbitfun-space-2);');
    expect(footerBlocks[1]).toContain('padding: 2px var(--openbitfun-space-3);');
  });

  it('keeps the compact settings button while using a more legible gear icon', () => {
    const stylesheet = readNavPanelStylesheet();
    const settingsButtonBlock = extractBlock(stylesheet, '.openbitfun-nav-panel__footer-btn--icon');

    expect(settingsButtonBlock).toContain('width: 28px;');
    expect(settingsButtonBlock).toContain('height: 28px;');
    expect(settingsButtonBlock).toContain("inline-size: var(--openbitfun-control-icon-size-md);");
    expect(settingsButtonBlock).toContain("block-size: var(--openbitfun-control-icon-size-md);");
  });

  it('keeps category actions flat on hover', () => {
    const stylesheet = readNavPanelStylesheet();

    expect(stylesheet).toContain(
      '.openbitfun-nav-panel__top-action-btn:hover {\n' +
      '    transform: none;\n' +
      '    box-shadow: none;\n' +
      '  }',
    );
    expect(stylesheet).not.toContain(
      '&:not(.openbitfun-nav-panel__top-action-btn--sub):hover .openbitfun-nav-panel__top-action-icon-slot {\n' +
      '    transform: scale(1.07);',
    );
  });

  it('centers the extension glyph and hover chevron in the shared icon column', () => {
    const stylesheet = readNavPanelStylesheet();

    expect(stylesheet).toContain(
      '> .openbitfun-nav-panel__top-action-expand-icon-default,\n' +
      '  > .openbitfun-nav-panel__top-action-expand-icon-chevron {',
    );
    expect(stylesheet).toContain('inset-block-start: 50%;');
    expect(stylesheet).toContain('inset-inline-start: 50%;');
    expect(stylesheet).toContain('transform: translate(-50%, -50%);');
    expect(stylesheet).not.toContain('translate(calc(-50% + 1px), -50%)');
    expect(stylesheet).not.toContain(
      '.openbitfun-nav-panel__top-action-expand-icons {\n' +
      '  position: relative;\n' +
      '  width: 22px;',
    );
  });

  it('keeps component-library leading slots out of the flexible label column', () => {
    const stylesheet = readNavPanelStylesheet();

    expect(stylesheet).toContain(
      ".openbitfun-nav-panel__top-action-btn,\n" +
      ".openbitfun-nav-panel__miniapp-entry {\n" +
      "  > [data-openbitfun-part='leading'] {\n" +
      '    flex: 0 0 var(--_nav-icon-slot-size);\n' +
      '    inline-size: var(--_nav-icon-slot-size);\n' +
      '    block-size: var(--_nav-icon-slot-size);',
    );
    expect(stylesheet).toContain(
      "> [data-openbitfun-part='label'] {\n" +
      '    flex: 1;',
    );
    expect(stylesheet).not.toContain(
      '> span:not([data-overflow-content]):not(.openbitfun-nav-panel__top-action-icon-circle)',
    );
  });

  it('keeps the miniapp row pill on the full row width', () => {
    const stylesheet = readNavPanelStylesheet();
    const itemBlock = extractBlock(stylesheet, '&__miniapp-item');
    const trailingBlock = extractBlock(
      stylesheet,
      "&__miniapp-item > [data-openbitfun-part='actions']",
    );

    // The row paints its hover/selected pill on the ActionItem trigger, so the
    // trailing actions region must stay out of the trigger's flex line: as an
    // in-flow sibling it took the root gap plus its own margin off the row and
    // left the pill short of the row's right edge.
    expect(itemBlock).toContain('position: relative;');
    expect(trailingBlock).toContain('position: absolute;');
    expect(trailingBlock).toContain('inset-inline-end: var(--openbitfun-space-2);');
    expect(trailingBlock).not.toContain('margin-inline-end');
  });
});
