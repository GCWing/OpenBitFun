/**
 * L0 navigation spec: verifies sidebar navigation panel exists and items are visible.
 * Basic checks that navigation structure is present - no AI interaction needed.
 */

import { browser, expect, $ } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { saveElementScreenshot, saveStepScreenshot } from '../helpers/screenshot-utils';

const NAV_ENTRY_SELECTORS = [
  '.openbitfun-nav-panel__item',
  '.openbitfun-nav-panel__workspace-item-name-btn',
  '.openbitfun-nav-panel__inline-item',
  '.openbitfun-nav-panel__workspace-create-main',
  '.openbitfun-nav-panel__top-action-btn',
];

async function getNavigationEntries() {
  const entries = [];

  for (const selector of NAV_ENTRY_SELECTORS) {
    const matched = await browser.$$(selector);
    entries.push(...matched);
  }

  return entries;
}

describe('L0 Navigation Panel', () => {
  let hasWorkspace = false;

  describe('Navigation panel existence', () => {
    it('app should start successfully', async () => {
      console.log('[L0] Starting navigation tests...');
      await browser.pause(3000);
      const title = await browser.getTitle();
      console.log('[L0] App title:', title);
      expect(title).toBeDefined();
    });

    it('should detect workspace or startup state', async () => {
      await browser.pause(1000);

      hasWorkspace = await openWorkspace(undefined, { requireWorkspaceLabel: false });

      console.log('[L0] Workspace opened:', hasWorkspace);
      expect(hasWorkspace).toBe(true);
    });

    it('should have navigation panel or sidebar when workspace is open', async function () {
      expect(hasWorkspace).toBe(true);

      await browser.pause(1000);

      // Use the correct selector from NavPanel.tsx
      const navPanel = await $('.openbitfun-nav-panel');
      const navExists = await navPanel.isExisting();

      console.log('[L0] Navigation panel found:', navExists);
      expect(navExists).toBe(true);
    });
  });

  describe('Navigation items visibility', () => {
    it('navigation items should be present if workspace is open', async function () {
      expect(hasWorkspace).toBe(true);

      await browser.pause(500);

      const navItems = await getNavigationEntries();
      const itemCount = navItems.length;

      console.log(`[L0] Found ${itemCount} navigation items`);
      expect(itemCount).toBeGreaterThan(0);
    });

    it('navigation sections should be present', async function () {
      expect(hasWorkspace).toBe(true);

      // Use correct selector from MainNav.tsx
      const sections = await $('.openbitfun-nav-panel__sections');
      const sectionsExist = await sections.isExisting();

      console.log('[L0] Navigation sections found:', sectionsExist);
      expect(sectionsExist).toBe(true);
    });

    it('should not mark the primary assistant in the navigation', async function () {
      if (!hasWorkspace) {
        hasWorkspace = await openWorkspace(undefined, { requireWorkspaceLabel: false });
      }
      expect(hasWorkspace).toBe(true);

      const assistantGroups = await browser.$$('.openbitfun-nav-panel__assistant-item');
      expect(assistantGroups.length).toBeGreaterThan(0);

      for (const assistantGroup of assistantGroups) {
        expect(await assistantGroup.$('.openbitfun-nav-panel__assistant-item-badge').isExisting()).toBe(false);
      }

      await saveStepScreenshot('l0-navigation-assistants-without-primary-badge');
    });
  });

  describe('Navigation interactivity', () => {
    it('should use the standard folder-add icon for the session group menu', async function () {
      expect(hasWorkspace).toBe(true);

      const sessionGroupMenuButton = await $('[data-testid="nav-workspace-add-btn"]');
      await sessionGroupMenuButton.waitForDisplayed({ timeout: 10000 });

      const sessionContextIcon = await sessionGroupMenuButton.$('svg.lucide-folder-plus');
      const lucideFolderOpenIcon = await sessionGroupMenuButton.$('svg.lucide-folder-open');
      const plainPlusIcon = await sessionGroupMenuButton.$('svg.lucide-plus');
      expect(await sessionContextIcon.isDisplayed()).toBe(true);
      expect(await lucideFolderOpenIcon.isExisting()).toBe(false);
      expect(await plainPlusIcon.isExisting()).toBe(false);
      await saveStepScreenshot('l0-standard-folder-add-icon');
    });

    it('should switch the standard session-view icon between grouped and all', async function () {
      expect(hasWorkspace).toBe(true);

      const viewToggle = await $('[data-testid="nav-workspace-session-view-toggle"]');
      await viewToggle.waitForDisplayed({ timeout: 10000 });

      if (await viewToggle.getAttribute('data-view-mode') === 'all') {
        await viewToggle.click();
      }
      await browser.waitUntil(
        async () => await viewToggle.getAttribute('data-view-mode') === 'grouped',
        { timeout: 5000, timeoutMsg: 'Session view did not enter grouped mode' },
      );

      expect(await viewToggle.getAttribute('aria-pressed')).toBe('false');
      expect(await viewToggle.$('svg[data-session-view-icon="grouped"]').isDisplayed()).toBe(true);
      expect(await viewToggle.$('svg[data-session-view-icon="all"]').isExisting()).toBe(false);
      await saveElementScreenshot(
        '[data-testid="nav-workspace-session-view-toggle"]',
        'l0-session-view-grouped-icon',
      );

      await viewToggle.click();
      await browser.waitUntil(
        async () => await viewToggle.getAttribute('data-view-mode') === 'all',
        { timeout: 5000, timeoutMsg: 'Session view did not enter all mode' },
      );

      expect(await viewToggle.getAttribute('aria-pressed')).toBe('true');
      expect(await viewToggle.$('svg[data-session-view-icon="all"]').isDisplayed()).toBe(true);
      expect(await viewToggle.$('svg[data-session-view-icon="grouped"]').isExisting()).toBe(false);
      expect(await $('.openbitfun-nav-panel__workspace-all-sessions-header').isExisting()).toBe(false);
      await saveElementScreenshot(
        '[data-testid="nav-workspace-session-view-toggle"]',
        'l0-session-view-all-icon',
      );
      await saveStepScreenshot('l0-session-view-all-icon');

      await viewToggle.click();
      await browser.waitUntil(
        async () => await viewToggle.getAttribute('data-view-mode') === 'grouped',
        { timeout: 5000, timeoutMsg: 'Session view did not restore grouped mode' },
      );
    });

    it('should render the active session group with a standard semantic icon', async function () {
      expect(hasWorkspace).toBe(true);

      const activeGroup = await $('[data-testid="nav-workspace-item"][data-workspace-active="true"]');
      await activeGroup.waitForDisplayed({ timeout: 10000 });

      const groupIcon = await activeGroup.$(
        '[data-openbitfun-part="icon"] [data-openbitfun-component="icon"], '
        + '[data-openbitfun-part="icon"] svg.lucide-network',
      );
      await groupIcon.waitForDisplayed({ timeout: 10000 });
      await saveElementScreenshot(
        '[data-testid="nav-workspace-item"][data-workspace-active="true"]',
        'l0-navigation-selected-session-group-icon',
      );
    });

    it('should give peer session groups more breathing room than their nested rows', async function () {
      if (!hasWorkspace) {
        hasWorkspace = await openWorkspace(undefined, { requireWorkspaceLabel: false });
      }
      expect(hasWorkspace).toBe(true);

      const viewToggle = await $('[data-testid="nav-workspace-session-view-toggle"]');
      await viewToggle.waitForDisplayed({ timeout: 10000 });
      if (await viewToggle.getAttribute('data-view-mode') === 'all') {
        await viewToggle.click();
      }
      await browser.waitUntil(
        async () => await viewToggle.getAttribute('data-view-mode') === 'grouped',
        { timeout: 5000, timeoutMsg: 'Session view did not enter grouped mode' },
      );

      const spacing = await browser.execute(() => {
        const list = document.querySelector<HTMLElement>(
          '[data-testid="nav-workspace-list"][data-workspace-list="all"]',
        );
        if (!list) return null;

        // The pinned assistant row is a peer group in the same column even
        // though it never joins the workspace drag order.
        const groups = Array.from(list.querySelectorAll<HTMLElement>(
          ':scope > [data-testid="nav-workspace-pinned-item"], '
          + ':scope > [data-testid="nav-workspace-drop-target"]',
        )).filter(group => group.getBoundingClientRect().height > 0);
        const groupWithSession = groups.find(group => group.querySelector(
          '[data-testid="nav-session-item"][data-session-level="0"]',
        ));
        const parentCard = groupWithSession?.querySelector<HTMLElement>(
          ':scope > [data-testid="nav-workspace-item"] > [data-testid="nav-workspace-card"]',
        );
        const firstSession = groupWithSession?.querySelector<HTMLElement>(
          '[data-testid="nav-session-item"][data-session-level="0"]',
        );

        if (groups.length < 2 || !parentCard || !firstSession) return null;

        const firstGroupRect = groups[0].getBoundingClientRect();
        const secondGroupRect = groups[1].getBoundingClientRect();
        const parentRect = parentCard.getBoundingClientRect();
        const sessionRect = firstSession.getBoundingClientRect();

        return {
          configuredGroupGap: Number.parseFloat(window.getComputedStyle(list).rowGap),
          measuredGroupGap: secondGroupRect.top - firstGroupRect.bottom,
          parentChildGap: sessionRect.top - parentRect.bottom,
        };
      });

      expect(spacing).not.toBeNull();
      if (!spacing) return;

      console.log('[L0] Grouped session spacing:', spacing);
      expect(spacing.configuredGroupGap).toBe(8);
      expect(spacing.measuredGroupGap).toBeGreaterThanOrEqual(7.5);
      expect(spacing.measuredGroupGap).toBeGreaterThan(spacing.parentChildGap);
      await saveStepScreenshot('l0-navigation-group-spacing');
    });

    it('should align nested session titles with the active workspace or assistant label', async function () {
      expect(hasWorkspace).toBe(true);

      const activeGroup = await $('[data-testid="nav-workspace-item"][data-workspace-active="true"]');
      const groupLabel = await activeGroup.$('[data-openbitfun-part="label"]');
      const sessionLabel = await activeGroup.$(
        '[data-testid="nav-session-item"][data-session-level="0"] .openbitfun-nav-panel__inline-item-label',
      );
      await groupLabel.waitForDisplayed({ timeout: 10000 });
      await sessionLabel.waitForDisplayed({ timeout: 10000 });

      const groupLabelX = await groupLabel.getLocation('x');
      const sessionLabelX = await sessionLabel.getLocation('x');
      console.log('[L0] Grouped session alignment:', { groupLabelX, sessionLabelX });
      expect(Math.abs(sessionLabelX - groupLabelX)).toBeLessThanOrEqual(1);
      await saveStepScreenshot('l0-navigation-grouped-session-alignment');
    });

    it('should give the selected child session the full row without filling its parent', async function () {
      expect(hasWorkspace).toBe(true);

      const activeGroup = await $('[data-testid="nav-workspace-item"][data-workspace-active="true"]');
      const activeSession = await activeGroup.$(
        '[data-testid="nav-session-item"][data-session-level="0"]',
      );
      await activeGroup.waitForDisplayed({ timeout: 10000 });
      await activeSession.waitForDisplayed({ timeout: 10000 });
      if (await activeSession.getAttribute('data-session-active') !== 'true') {
        await activeSession.click();
      }
      await browser.waitUntil(
        async () => await activeSession.getAttribute('data-session-active') === 'true',
        { timeout: 10000, timeoutMsg: 'Nested session did not become active' },
      );
      await browser.pause(200);

      const hierarchy = await browser.execute(() => {
        const group = document.querySelector<HTMLElement>(
          '[data-testid="nav-workspace-item"][data-workspace-active="true"]',
        );
        const card = group?.querySelector<HTMLElement>(
          ':scope > [data-testid="nav-workspace-card"]',
        );
        const session = group?.querySelector<HTMLElement>(
          '[data-testid="nav-session-item"][data-session-active="true"]',
        );
        const groupLabel = card?.querySelector<HTMLElement>('[data-openbitfun-part="label"]');
        const sessionLabel = session?.querySelector<HTMLElement>(
          '.openbitfun-nav-panel__inline-item-label',
        );

        if (!card || !session || !groupLabel || !sessionLabel) {
          return null;
        }

        const cardRect = card.getBoundingClientRect();
        const sessionRect = session.getBoundingClientRect();
        const selectedBackgroundProbe = document.createElement('span');
        selectedBackgroundProbe.style.backgroundColor = 'var(--openbitfun-color-action-quiet-hover)';
        session.append(selectedBackgroundProbe);
        const selectedBackground = window.getComputedStyle(selectedBackgroundProbe).backgroundColor;
        selectedBackgroundProbe.remove();

        return {
          cardBackground: window.getComputedStyle(card).backgroundColor,
          cardLabelWeight: window.getComputedStyle(groupLabel).fontWeight,
          sessionBackground: window.getComputedStyle(session).backgroundColor,
          sessionLabelWeight: window.getComputedStyle(sessionLabel).fontWeight,
          selectedBackground,
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          cardHeight: cardRect.height,
          sessionLeft: sessionRect.left,
          sessionRight: sessionRect.right,
          sessionHeight: sessionRect.height,
        };
      });

      expect(hierarchy).not.toBeNull();
      if (!hierarchy) {
        return;
      }

      expect(Math.abs(hierarchy.sessionLeft - hierarchy.cardLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(hierarchy.sessionRight - hierarchy.cardRight)).toBeLessThanOrEqual(1);
      expect(hierarchy.sessionHeight).toBeLessThanOrEqual(hierarchy.cardHeight);
      expect(hierarchy.sessionBackground).toBe(hierarchy.selectedBackground);
      expect(hierarchy.sessionLabelWeight).toBe('600');
      expect(hierarchy.cardBackground).toBe('rgba(0, 0, 0, 0)');
      expect(hierarchy.cardLabelWeight).toBe('500');
      await saveStepScreenshot('l0-navigation-selected-child-full-width');
    });

    it('should open External Import from its own group in More', async function () {
      expect(hasWorkspace).toBe(true);
      expect(await $('[data-testid="agent-skill-entry"]').isExisting()).toBe(false);
      expect(await $('[data-testid="skill-tab"]').isExisting()).toBe(false);
      expect(await $('[data-testid="nav-miniapps-entry"]').isExisting()).toBe(false);
      expect(await $('[data-testid="nav-sections"] [data-testid="ecosystem-compatibility-tab"]').isExisting()).toBe(false);
      await $('[data-testid="nav-footer-settings-item"]').click();
      const menu = await $('[data-testid="nav-settings-menu"]');
      await menu.waitForDisplayed({ timeout: 10000 });
      const ecosystem = await menu.$('[data-testid="ecosystem-compatibility-tab"]');
      await ecosystem.waitForDisplayed({ timeout: 10000 });
      const group = await ecosystem.$('./ancestor::*[@role="group"][1]');
      expect(await group.getAttribute('role')).toBe('group');
      const updates = await menu.$('[data-testid="nav-check-updates"]');
      if (await updates.isExisting()) {
        expect(await ecosystem.getLocation('y')).toBeLessThan(await updates.getLocation('y'));
      }
      await ecosystem.click();
      const scene = await $('[data-openbitfun-scene="ecosystem-compatibility"][data-openbitfun-part="root"]');
      await scene.waitForDisplayed({ timeout: 10000 });
      await menu.waitForDisplayed({ reverse: true, timeout: 10000 });
      await saveStepScreenshot('l0-navigation-ecosystem-compatibility');
    });

    it('should place Task Board below Personal Overview and open it', async function () {
      expect(hasWorkspace).toBe(true);

      const overview = await $('[data-testid="nav-personal-overview"]');
      const taskBoard = await $('[data-testid="nav-todos-btn"]');
      await overview.waitForDisplayed({ timeout: 10000 });
      await taskBoard.waitForDisplayed({ timeout: 10000 });

      expect(await overview.getLocation('y')).toBeLessThan(await taskBoard.getLocation('y'));
      expect(['任务看板', 'Task Board', '任務看板']).toContain((await taskBoard.getText()).trim());
      expect(await $('[data-openbitfun-part="footer"] [data-testid="nav-todos-btn"]').isExisting()).toBe(false);

      await taskBoard.click();
      const todosScene = await $('[data-testid="todos-scene"]');
      await todosScene.waitForDisplayed({ timeout: 10000 });
      const taskBoardTitle = await todosScene.$('.openbitfun-todos__title');
      expect(await taskBoard.getAttribute('aria-pressed')).toBe('true');
      expect(await todosScene.isDisplayed()).toBe(true);
      expect(['任务看板', 'Task Board', '任務看板']).toContain((await taskBoardTitle.getText()).trim());
      await saveStepScreenshot('l0-navigation-task-board');
    });

    it('should open assistant management from Personal Overview', async function () {
      expect(hasWorkspace).toBe(true);

      expect(await $('[data-testid="nav-assistant-manager"]').isExisting()).toBe(false);
      expect(await $('[data-testid="agent-tab"]').isExisting()).toBe(false);
      const overview = await $('[data-testid="nav-personal-overview"]');
      await overview.waitForDisplayed({ timeout: 10000 });
      await overview.click();
      const assistantEntry = await $('[data-testid="personal-overview-assistants"]');
      await assistantEntry.waitForDisplayed({ timeout: 10000 });
      await assistantEntry.click();
      const assistantScene = await $('[data-openbitfun-scene="assistant"][data-openbitfun-part="root"]');
      const assistantGallery = await $('[data-openbitfun-component="nursery-gallery"][data-openbitfun-part="root"]');
      await assistantScene.waitForDisplayed({ timeout: 10000 });
      await assistantGallery.waitForDisplayed({ timeout: 10000 });
      expect(await assistantScene.isDisplayed()).toBe(true);
      expect(await assistantGallery.isDisplayed()).toBe(true);
      await saveStepScreenshot('l0-navigation-assistant-management');
    });

    it('should expose the settings utility list without More or Insights', async function () {
      expect(hasWorkspace).toBe(true);

      const deviceStatus = await $('[data-testid="nav-footer-device-status"]');
      const settingsButton = await $('[data-testid="nav-footer-settings-item"]');
      expect(await deviceStatus.isDisplayed()).toBe(true);
      expect(await settingsButton.isDisplayed()).toBe(true);
      expect(await $('[data-testid="shell-panel-entry"]').isExisting()).toBe(false);
      expect(await $('[data-testid="browser-panel-entry"]').isExisting()).toBe(false);
      expect(await $('[data-testid="nav-footer-more-btn"]').isExisting()).toBe(false);

      await settingsButton.click();
      const settingsMenu = await $('[data-testid="nav-settings-menu"]');
      await settingsMenu.waitForDisplayed({ timeout: 10000 });

      const expectedItems = [
        'nav-settings-floating-item',
        'notification-button',
        'nav-settings-theme-item',
        'nav-settings-open-item',
        'nav-settings-about-item',
      ];
      const renderedItems = await settingsMenu.$$('[role="menuitem"]');
      expect(renderedItems).toHaveLength(expectedItems.length);
      for (let index = 0; index < expectedItems.length; index += 1) {
        expect(await renderedItems[index].getAttribute('data-testid')).toBe(expectedItems[index]);
      }

      const menuText = await settingsMenu.getText();
      expect(['洞察', 'Insights'].some(label => menuText.includes(label))).toBe(false);
      await saveStepScreenshot('l0-navigation-settings-utility-list');

      const backdrop = await $('.openbitfun-nav-panel__footer-backdrop');
      await backdrop.click();
      await backdrop.waitForExist({ reverse: true, timeout: 2000 });
    });

    it('should keep the session and footer dividers full-width', async function () {
      if (!hasWorkspace) {
        hasWorkspace = await openWorkspace(undefined, { requireWorkspaceLabel: false });
      }
      expect(hasWorkspace).toBe(true);

      const dividerLayout = await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('.openbitfun-nav-panel');
        const sections = document.querySelector<HTMLElement>('.openbitfun-nav-panel__sections');
        const topActions = document.querySelector<HTMLElement>('.openbitfun-nav-panel__top-actions');
        const stickyHeader = document.querySelector<HTMLElement>('.openbitfun-nav-panel__sticky-section-header');
        const footer = document.querySelector<HTMLElement>('.openbitfun-nav-panel__footer');
        if (!panel || !sections || !topActions || !stickyHeader || !footer) {
          return null;
        }

        const panelRect = panel.getBoundingClientRect();
        const sectionsRect = sections.getBoundingClientRect();
        const topActionsRect = topActions.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const dividerStyle = window.getComputedStyle(topActions, '::after');
        const stickyDividerStyle = window.getComputedStyle(stickyHeader, '::after');
        const footerStyle = window.getComputedStyle(footer);
        const dividerLeft = topActionsRect.left + Number.parseFloat(dividerStyle.left);
        const dividerRight = dividerLeft + Number.parseFloat(dividerStyle.width);

        return {
          dividerBorderStyle: dividerStyle.borderBottomStyle,
          dividerBorderWidth: dividerStyle.borderBottomWidth,
          dividerLeft,
          dividerRight,
          panelLeft: panelRect.left,
          panelRight: panelRect.right,
          sectionsRight: sectionsRect.right,
          hasVerticalScrollbar: sections.scrollHeight > sections.clientHeight,
          stickyDividerBorderStyle: stickyDividerStyle.borderBottomStyle,
          stickyDividerBorderWidth: stickyDividerStyle.borderBottomWidth,
          footerBorderStyle: footerStyle.borderTopStyle,
          footerBorderWidth: footerStyle.borderTopWidth,
          footerLeft: footerRect.left,
          footerRight: footerRect.right,
        };
      });

      expect(dividerLayout).not.toBeNull();
      if (!dividerLayout) {
        return;
      }

      expect(dividerLayout.dividerBorderStyle).toBe('dashed');
      expect(dividerLayout.dividerBorderWidth).toBe('1px');
      expect(Math.abs(dividerLayout.dividerLeft - dividerLayout.panelLeft)).toBeLessThanOrEqual(1);
      expect(dividerLayout.dividerRight).toBeGreaterThanOrEqual(dividerLayout.panelRight - 1);
      expect(dividerLayout.dividerRight).toBeGreaterThanOrEqual(dividerLayout.sectionsRight - 1);
      expect(dividerLayout.stickyDividerBorderStyle).toBe('dashed');
      expect(dividerLayout.stickyDividerBorderWidth).toBe('1px');
      expect(dividerLayout.footerBorderStyle).toBe('dashed');
      expect(dividerLayout.footerBorderWidth).toBe('1px');
      expect(Math.abs(dividerLayout.footerLeft - dividerLayout.panelLeft)).toBeLessThanOrEqual(1);
      expect(dividerLayout.footerRight).toBeGreaterThanOrEqual(dividerLayout.panelRight - 1);
      console.log('[L0] Navigation divider layout:', dividerLayout);
      await saveStepScreenshot('l0-navigation-footer-divider');
    });

    it('should align navigation scroll and resize controls with the scene border', async function () {
      expect(hasWorkspace).toBe(true);

      const boundaryLayout = await browser.execute(() => {
        const navArea = document.querySelector<HTMLElement>('.openbitfun-workspace-body__nav-area');
        const panel = document.querySelector<HTMLElement>('.openbitfun-nav-panel');
        const sections = document.querySelector<HTMLElement>('.openbitfun-nav-panel__sections');
        const divider = document.querySelector<HTMLElement>('.openbitfun-workspace-body__nav-divider');
        const sceneViewport = document.querySelector<HTMLElement>('.openbitfun-scene-viewport');
        if (!navArea || !panel || !sections || !divider || !sceneViewport) {
          return null;
        }

        const navAreaRect = navArea.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const sectionsRect = sections.getBoundingClientRect();
        const dividerRect = divider.getBoundingClientRect();
        const sceneViewportRect = sceneViewport.getBoundingClientRect();
        const dividerLineStyle = window.getComputedStyle(divider, '::after');
        const dividerLineLeft = Number.parseFloat(dividerLineStyle.left);

        return {
          navAreaRight: navAreaRect.right,
          panelRight: panelRect.right,
          sectionsRight: sectionsRect.right,
          dividerLeft: dividerRect.left,
          dividerRight: dividerRect.right,
          dividerLineCenter: dividerRect.left + dividerLineLeft,
          sceneLeft: sceneViewportRect.left,
        };
      });

      expect(boundaryLayout).not.toBeNull();
      if (!boundaryLayout) {
        return;
      }

      // Preserve the workbench breathing room instead of moving the scene
      // border left to meet controls that were positioned against navArea.
      expect(boundaryLayout.sceneLeft - boundaryLayout.navAreaRight).toBeGreaterThan(0);
      expect(Math.abs(boundaryLayout.panelRight - boundaryLayout.sceneLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(boundaryLayout.sectionsRight - boundaryLayout.sceneLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(boundaryLayout.dividerLeft - boundaryLayout.sceneLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(boundaryLayout.dividerLineCenter - boundaryLayout.sceneLeft)).toBeLessThanOrEqual(1);
      expect(boundaryLayout.dividerRight).toBeGreaterThan(boundaryLayout.sceneLeft);
      console.log('[L0] Navigation boundary alignment:', boundaryLayout);
      await saveStepScreenshot('l0-navigation-boundary-alignment');
    });

    it('navigation items should be clickable', async function () {
      expect(hasWorkspace).toBe(true);

      const navItems = await getNavigationEntries();

      expect(navItems.length).toBeGreaterThan(0);

      let firstItem = null;
      for (const item of navItems) {
        try {
          if (await item.isClickable()) {
            firstItem = item;
            break;
          }
        } catch {
          // Continue to the next navigation entry.
        }
      }

      expect(firstItem).not.toBeNull();
      if (!firstItem) {
        return;
      }

      const isClickable = await firstItem.isClickable();
      console.log('[L0] First nav item clickable:', isClickable);

      expect(isClickable).toBe(true);
    });
  });

  after(async () => {
    console.log('[L0] Navigation tests complete');
  });
});
