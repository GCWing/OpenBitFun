/**
 * Page object for the scene tab bar and the scene viewport.
 *
 * Scenes are tabs (`session`, `settings`, ...) identified by
 * `data-scene-tab-id`. Every open tab stays mounted, so "is the settings scene
 * open" is not the same as "is the settings scene the active surface". The
 * viewport tags each mounted scene with `data-testid="scene-viewport-scene"`,
 * `data-scene-id`, and `data-scene-active="true"` for the active one; that is the
 * authoritative check.
 */
import { BasePage } from './../BasePage';
import { browser } from '@wdio/globals';
import { domClick, domCount } from '../../helpers/dom-utils';

const ACTIVE_SCENE = '[data-testid="scene-viewport-scene"][data-scene-active="true"]';
/**
 * The scene tab's clickable control.
 *
 * `data-scene-tab-id` sits on the wrapper the scene bar renders around each tab;
 * the actual `role="tab"` button (which owns the activate handler) is inside it.
 */
const SESSION_TAB = '[data-scene-tab-id="session"] [role="tab"]';

export class SceneBar extends BasePage {
  async getActiveSceneId(): Promise<string | null> {
    return browser.execute((selector: string) => {
      const element = document.querySelector(selector);
      return element ? element.getAttribute('data-scene-id') : null;
    }, ACTIVE_SCENE);
  }

  async waitForActiveScene(sceneId: string, timeout = 15000): Promise<void> {
    await browser.waitUntil(
      async () => (await this.getActiveSceneId()) === sceneId,
      {
        timeout,
        interval: 200,
        timeoutMsg: `Scene did not become active: ${sceneId}`,
      },
    );
  }

  /**
   * Activate the session scene.
   *
   * The session scene tab only exists once a session is open, so a missing tab is
   * not an error: the caller is expected to create a session and then wait for the
   * scene to become active.
   */
  async activateSessionScene(timeout = 15000): Promise<void> {
    if ((await this.getActiveSceneId()) === 'session') {
      return;
    }

    if ((await domCount(SESSION_TAB)) === 0) {
      return;
    }

    // The tab button is the element that owns the activate handler; the
    // dispatched DOM click reaches it without depending on tab geometry.
    await domClick(SESSION_TAB);
    await this.waitForActiveScene('session', timeout);
  }

  /** True when the settings scene is the active surface. */
  async isSettingsSceneActive(): Promise<boolean> {
    return (await this.getActiveSceneId()) === 'settings';
  }
}

export default SceneBar;
