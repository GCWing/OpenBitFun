/**
 * Page object for the settings scene (`.openbitfun-settings-scene`).
 *
 * Settings is reached from the nav panel footer menu, not the header: the footer
 * gear (`nav-footer-settings-item`) opens `nav-settings-menu`, whose
 * `nav-settings-open-item` entry activates the settings scene.
 *
 * The scene root (`data-testid="settings-scene"`) carries `data-settings-page`
 * with the active page id, and every nav entry exposes
 * `data-testid="settings-nav-page"` with `data-settings-page="<id>"`. Page ids
 * are dotted (`ai.memory`, `application.appearance`, `tools.mcp`).
 *
 * The scene stays mounted when it is not the active surface, so "open" here means
 * "the settings scene is the active scene tab" (see `SceneBar`).
 */
import { BasePage } from './BasePage';
import { browser, $, $$ } from '@wdio/globals';
import { environmentSettings } from '../config/capabilities';

const ACTIVE_SCENE = '[data-testid="scene-viewport-scene"][data-scene-active="true"]';

export class SettingsPage extends BasePage {
  private selectors = {
    footerSettingsTrigger: '[data-testid="nav-footer-settings-item"]',
    footerSettingsMenu: '[data-testid="nav-settings-menu"]',
    footerOpenSettings: '[data-testid="nav-settings-open-item"]',
    scene: '[data-testid="settings-scene"], .openbitfun-settings-scene',
    sceneContent: '[data-testid="settings-scene-content"]',
  };

  private async getActiveSceneId(): Promise<string | null> {
    return browser.execute((selector: string) => {
      const element = document.querySelector(selector);
      return element ? element.getAttribute('data-scene-id') : null;
    }, ACTIVE_SCENE);
  }

  /** True when the settings scene is the active scene tab. */
  async isActive(): Promise<boolean> {
    return (await this.getActiveSceneId()) === 'settings';
  }

  async waitForActive(timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    await browser.waitUntil(
      async () => (await this.getActiveSceneId()) === 'settings',
      {
        timeout,
        interval: 200,
        timeoutMsg: 'Settings scene did not become the active scene',
      },
    );
    await this.waitForElement(this.selectors.scene, timeout);
  }

  private async footerMenuOpen(): Promise<boolean> {
    const menu = await $(this.selectors.footerSettingsMenu);
    return await menu.isExisting();
  }

  private async openFooterMenu(timeout: number): Promise<void> {
    if (await this.footerMenuOpen()) {
      return;
    }

    const trigger = await this.waitForElement(this.selectors.footerSettingsTrigger, timeout);
    await trigger.waitForClickable({ timeout });
    await trigger.click();

    await browser.waitUntil(
      async () => this.footerMenuOpen(),
      {
        timeout,
        interval: 100,
        timeoutMsg: 'Nav panel footer settings menu did not open',
      },
    );
  }

  /** Activate the settings scene from the nav panel footer menu. */
  async open(timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    if (await this.isActive()) {
      return;
    }

    await this.openFooterMenu(timeout);

    const openSettings = await this.waitForElement(this.selectors.footerOpenSettings, timeout);
    await openSettings.waitForClickable({ timeout });
    await openSettings.click();
    await this.waitForActive(timeout);
  }

  /** Switch to a settings page by its dotted page id (for example `ai.memory`). */
  async openTab(tabId: string, timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    await this.open(timeout);

    const tabSelector = `[data-testid="settings-nav-page"][data-settings-page="${tabId}"]`;
    const tab = await this.waitForElement(tabSelector, timeout);
    await tab.waitForClickable({ timeout });
    await tab.click();

    await browser.waitUntil(
      async () => {
        const scene = await $(this.selectors.scene);
        if (!(await scene.isExisting())) {
          return false;
        }
        return (await scene.getAttribute('data-settings-page')) === tabId;
      },
      {
        timeout,
        interval: 200,
        timeoutMsg: `Settings page did not become active: ${tabId}`,
      },
    );

    await this.waitForElement(this.selectors.sceneContent, timeout);
    // Page content is lazy-loaded and animated; give it a frame to settle.
    await browser.pause(300);
  }

  async getActiveTab(): Promise<string | null> {
    const scene = await $(this.selectors.scene);
    if (!(await scene.isExisting())) {
      return null;
    }
    return scene.getAttribute('data-settings-page');
  }

  /** Count of currently rendered settings nav entries. */
  async navEntryCount(): Promise<number> {
    const items = await $$('[data-testid="settings-nav-page"]');
    return await items.length;
  }
}

export default SettingsPage;
