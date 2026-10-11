/**
 * Page object for the left navigation panel.
 *
 * Session creation lives in the per-workspace action strip: the active workspace
 * row exposes `nav-workspace-new-session-btn`, and its overflow menu exposes
 * `nav-workspace-menu-create-session`. Both are stable `data-testid`s, so session
 * creation does not depend on a translated label.
 *
 * The action strip is revealed on hover, so a WebDriver pointer click cannot
 * always land on it even though the button is mounted. The dispatched DOM click in
 * `helpers/dom-utils` is the reliable path for that affordance.
 */
import { BasePage } from './../BasePage';
import { $, browser } from '@wdio/globals';
import { domClick, domCount } from '../../helpers/dom-utils';

const ACTIVE_WORKSPACE = '[data-testid="nav-workspace-item"][data-workspace-active="true"]';
const WORKSPACE_MENU_BUTTON = '[data-testid="nav-workspace-menu-btn"]';
const WORKSPACE_MENU = '[data-testid="nav-workspace-item-menu"]';
const CREATE_SESSION = '[data-testid="nav-workspace-menu-create-session"]';
const NEW_SESSION_BUTTON = '[data-testid="nav-workspace-new-session-btn"]';
const CHAT_INPUT = '[data-testid="chat-input-container"]';

export class NavPanel extends BasePage {
  /** `data-workspace-id` of the active workspace row, or null when none is active. */
  private async activeWorkspaceId(): Promise<string | null> {
    const row = await $(ACTIVE_WORKSPACE);
    if (!(await row.isExisting().catch(() => false))) {
      return null;
    }
    return row.getAttribute('data-workspace-id').catch(() => null);
  }

  /** Resolve the action-strip selector of the active workspace when several are listed. */
  private async resolveWorkspaceSelector(testId: string): Promise<string> {
    const workspaceId = await this.activeWorkspaceId();
    if (workspaceId) {
      const scopedSelector = `[data-testid="${testId}"][data-workspace-id="${workspaceId}"]`;
      if ((await domCount(scopedSelector)) > 0) {
        return scopedSelector;
      }
    }
    return `[data-testid="${testId}"]`;
  }

  /**
   * True when the nav panel rendered a session-creation entry point.
   *
   * On a cold profile the workspace list is populated asynchronously after the
   * frontend shell paints, so this is the readiness signal for anything that
   * needs a workspace row.
   */
  async hasWorkspaceEntry(): Promise<boolean> {
    return (await domCount(NEW_SESSION_BUTTON)) > 0 || (await domCount(WORKSPACE_MENU_BUTTON)) > 0;
  }

  /**
   * Wait until the nav panel rendered a session-creation entry point.
   *
   * The first workspace-list render on a fresh profile waits on the host
   * workspace catalog, so the budget is deliberately larger than the interaction
   * timeout: 10s is enough once the shell is warm, but not while the profile is
   * still being created.
   */
  async waitForWorkspaceEntry(timeout = 60000): Promise<void> {
    await browser.waitUntil(
      async () => this.hasWorkspaceEntry(),
      {
        timeout,
        interval: 500,
        timeoutMsg: 'nav panel never rendered a workspace session-creation entry point',
      },
    );
  }

  /**
   * Create a new Code (agentic) session and wait for the session scene to be ready.
   *
   * The active workspace's new-session button is the primary entry point; its
   * overflow menu is the fallback for layouts that hide the action strip. Either
   * entry point can be missing for a moment after startup, so the presence check
   * waits instead of sampling the DOM once and falling through to the wrong branch.
   */
  async createNewCodeSession(timeout: number = 60000): Promise<void> {
    await this.waitForWorkspaceEntry(timeout);

    if ((await domCount(NEW_SESSION_BUTTON)) > 0) {
      await domClick(await this.resolveWorkspaceSelector('nav-workspace-new-session-btn'));
    } else {
      const menuButtonSelector = await this.resolveWorkspaceSelector('nav-workspace-menu-btn');
      await this.openWorkspaceMenu(menuButtonSelector, timeout);

      const createItem = await this.waitForElement(CREATE_SESSION, timeout);
      await createItem.waitForClickable({ timeout });
      await createItem.click();
    }

    // Session creation round-trips to the host before the transcript mounts.
    await this.waitForElement(CHAT_INPUT, Math.max(timeout, 30000));
    await this.wait(500);
  }

  /**
   * Open the active workspace's overflow menu.
   *
   * The menu button is revealed on hover in some layouts, so a WebDriver pointer
   * click cannot land on it even though it is mounted. The dispatched DOM click is
   * the fallback whenever the pointer click does not produce the menu.
   */
  private async openWorkspaceMenu(menuButtonSelector: string, timeout: number): Promise<void> {
    const menuButton = await this.waitForElement(menuButtonSelector, timeout).catch(() => null);
    if (menuButton) {
      await menuButton.click().catch(() => undefined);
      if ((await domCount(WORKSPACE_MENU)) > 0) {
        return;
      }
    }

    await domClick(menuButtonSelector);
    await browser.waitUntil(
      async () => (await domCount(WORKSPACE_MENU)) > 0,
      {
        timeout,
        interval: 500,
        timeoutMsg: 'workspace item menu never opened',
      },
    );
  }

  async isChatInputPresent(): Promise<boolean> {
    return (await domCount(CHAT_INPUT)) > 0;
  }
}

export default NavPanel;
