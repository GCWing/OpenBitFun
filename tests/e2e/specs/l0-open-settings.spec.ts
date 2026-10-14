/**
 * L0 open settings spec: verifies settings panel can be opened.
 * Tests basic navigation to settings/config panel.
 */

import { browser, expect, $ } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { saveStepScreenshot } from '../helpers/screenshot-utils';

describe('L0 Settings Panel', () => {
  let hasWorkspace = false;

  describe('Initial setup', () => {
    it('app should start', async () => {
      console.log('[L0] Initializing settings test...');
      await browser.pause(2000);
      const title = await browser.getTitle();
      console.log('[L0] App title:', title);
      expect(title).toBeDefined();
    });

    it('should open workspace if needed', async () => {
      await browser.pause(2000);

      hasWorkspace = await openWorkspace();

      console.log('[L0] Workspace opened:', hasWorkspace);
      expect(hasWorkspace).toBe(true);
      if (hasWorkspace) {
        await saveStepScreenshot('l0-settings-workspace-ready');
      }
    });
  });

  describe('Settings button location', () => {
    it('should find settings/config button', async function () {
      expect(hasWorkspace).toBe(true);

      await browser.pause(1500);

      const settingsButton = await $('[data-testid="nav-footer-settings-item"]');
      const settingsButtonVisible = await settingsButton.isDisplayed();

      console.log('[L0] Persistent settings button visible:', settingsButtonVisible);
      expect(settingsButtonVisible).toBe(true);
      await saveStepScreenshot('l0-settings-footer-entry');
    });

    it('should align upper and lower main navigation item typography', async function () {
      expect(hasWorkspace).toBe(true);

      const comparison = await browser.execute(() => {
        const upperItem = document.querySelector<HTMLElement>(
          '[data-testid="nav-todos-btn"]',
        );
        const lowerItem = document.querySelector<HTMLElement>(
          '[data-testid="nav-session-item"]:not([data-session-active="true"]) .openbitfun-nav-panel__inline-item-label',
        );

        if (!upperItem || !lowerItem) {
          return null;
        }

        const typeStyle = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontStyle: style.fontStyle,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            lineHeight: style.lineHeight,
            textTransform: style.textTransform,
          };
        };

        return {
          upper: typeStyle(upperItem),
          lower: typeStyle(lowerItem),
        };
      });

      expect(comparison).not.toBeNull();
      if (!comparison) {
        return;
      }

      expect(comparison.upper).toEqual(comparison.lower);
      await saveStepScreenshot('l0-main-navigation-typography-aligned');
    });
  });

  describe('Settings panel interaction', () => {
    it('should open the settings list and then the settings panel', async function () {
      expect(hasWorkspace).toBe(true);

      console.log('[L0] Opening settings list...');
      const settingsButton = await $('[data-testid="nav-footer-settings-item"]');
      await settingsButton.click();
      const settingsMenu = await $('[data-testid="nav-settings-menu"]');
      await settingsMenu.waitForDisplayed({ timeout: 10000 });
      expect(await settingsMenu.isDisplayed()).toBe(true);

      const openSettingsItem = await $('[data-testid="nav-settings-open-item"]');
      await openSettingsItem.click();

      // Check for settings scene
      const settingsScene = await $('.openbitfun-settings-scene');
      await settingsScene.waitForDisplayed({ timeout: 10000 });
      const sceneExists = await settingsScene.isDisplayed();

      console.log('[L0] Settings scene opened:', sceneExists);
      expect(sceneExists).toBe(true);
      if (sceneExists) {
        await saveStepScreenshot('l0-settings-panel-opened');
      }
    });

    it('should match the main navigation typography and row rhythm', async function () {
      expect(hasWorkspace).toBe(true);

      const comparison = await browser.execute(() => {
        const mainItem = document.querySelector<HTMLElement>(
          '[data-testid="nav-todos-btn"]',
        );
        const settingsItem = document.querySelector<HTMLElement>(
          '.openbitfun-settings-nav__item:not(.is-active)',
        );
        const lowerItem = document.querySelector<HTMLElement>(
          '[data-testid="nav-session-item"]:not([data-session-active="true"]) .openbitfun-nav-panel__inline-item-label',
        );
        const activeSettingsItem = document.querySelector<HTMLElement>(
          '.openbitfun-settings-nav__item.is-active',
        );
        const mainCategory = document.querySelector<HTMLElement>(
          '.openbitfun-nav-panel__section-label',
        );
        const settingsCategory = document.querySelector<HTMLElement>(
          '.openbitfun-settings-nav__category-label',
        );

        if (!mainItem || !settingsItem || !lowerItem || !activeSettingsItem || !mainCategory || !settingsCategory) {
          return null;
        }

        const typeStyle = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          return {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontStyle: style.fontStyle,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            lineHeight: style.lineHeight,
            textTransform: style.textTransform,
          };
        };
        const rowStyle = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          return {
            borderRadius: style.borderRadius,
            height: element.getBoundingClientRect().height,
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
          };
        };

        return {
          mainItemType: typeStyle(mainItem),
          settingsItemType: typeStyle(settingsItem),
          lowerItemType: typeStyle(lowerItem),
          activeSettingsWeight: window.getComputedStyle(activeSettingsItem).fontWeight,
          mainCategoryType: typeStyle(mainCategory),
          settingsCategoryType: typeStyle(settingsCategory),
          mainRow: rowStyle(mainItem),
          settingsRow: rowStyle(settingsItem),
        };
      });

      expect(comparison).not.toBeNull();
      if (!comparison) {
        return;
      }

      expect(comparison.mainItemType).toEqual(comparison.lowerItemType);
      expect(comparison.settingsItemType).toEqual(comparison.lowerItemType);
      expect(comparison.settingsCategoryType).toEqual(comparison.mainCategoryType);
      expect(comparison.activeSettingsWeight).toBe('600');
      expect(comparison.settingsRow).toEqual(comparison.mainRow);
      await saveStepScreenshot('l0-settings-navigation-aligned');
    });
  });

  describe('UI stability after settings interaction', () => {
    it('UI should remain responsive', async function () {
      expect(hasWorkspace).toBe(true);

      console.log('[L0] Checking UI responsiveness...');
      await browser.pause(2000);

      const body = await $('body');
      const elementCount = await body.$$('*').then(els => els.length);
      
      expect(elementCount).toBeGreaterThan(10);
      console.log('[L0] UI responsive, element count:', elementCount);
    });
  });
});
