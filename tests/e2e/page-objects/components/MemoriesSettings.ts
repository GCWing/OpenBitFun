/**
 * Page object for the Memory page of the settings scene (`ai.memory`).
 *
 * Covers the single memory on/off switch and the host-local memory status card
 * (`get_memory_status`): stored Phase-1 outputs, Phase-2 state, memory root, and
 * the on-demand "run pipeline now" trigger.
 *
 * The page has one user-facing switch (`memories-enabled-toggle`): turning it on
 * sets both `memories.generate_memories` and `memories.use_memories`, which is
 * what the backend needs for the pipeline to run and for sessions to read memory.
 * The remaining rows (retention, concurrency, model selectors) live behind
 * `actions.expandAdvanced` and are not part of the journey.
 *
 * The switch `data-testid` lands on the design-system `Switch`'s real
 * `<input type="checkbox">`, which the component keeps at `opacity: 0` under its
 * track. WebDriver therefore reports it as not visible, so every wait here is
 * existence-based and state is read from the input's DOM properties; clicks go to
 * the input itself, which covers the track and is the element the component
 * expects pointer input on.
 */
import { BasePage } from './../BasePage';
import { browser, $ } from '@wdio/globals';
import { environmentSettings } from '../../config/capabilities';
import { domClick, probeSelector } from '../../helpers/dom-utils';

const ENABLED_TOGGLE = '[data-testid="memories-enabled-toggle"]';
const STATUS_CARD = '[data-testid="memories-status-card"]';
const RUN_NOW_BTN = '[data-testid="memories-run-now-btn"]';

const STATUS_STORED_OUTPUTS = '[data-testid="memories-status-stored-outputs"]';
const STATUS_PENDING_PROMOTION = '[data-testid="memories-status-pending-promotion"]';
const STATUS_PHASE2 = '[data-testid="memories-status-phase2"]';
const STATUS_MEMORY_ROOT = '[data-testid="memories-status-memory-root"]';
const STATUS_ROLLOUT_SUMMARIES = '[data-testid="memories-status-rollout-summaries"]';

export class MemoriesSettings extends BasePage {
  private async waitForExist(selector: string, timeout: number) {
    const element = await $(selector);
    await element.waitForExist({ timeout, timeoutMsg: `Element ${selector} never appeared` });
    return element;
  }

  async waitForLoad(timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    await this.waitForExist(STATUS_CARD, timeout);
    await this.waitForExist(ENABLED_TOGGLE, timeout);
    // The config panel resolves its values asynchronously; give the switch one
    // frame to reflect the loaded config.
    await browser.pause(300);
  }

  /** True when the status card rendered a host payload instead of a read error. */
  async hasStatusPayload(timeout: number = environmentSettings.defaultTimeout): Promise<boolean> {
    const card = await this.waitForExist(STATUS_CARD, timeout);
    const text = await card.getText();
    return !/unavailable|不可用/i.test(text);
  }

  async getStatusCardText(): Promise<string> {
    const card = await this.waitForExist(STATUS_CARD, environmentSettings.defaultTimeout);
    return (await card.getText()).trim();
  }

  private async readChecked(selector: string): Promise<boolean> {
    const input = await this.waitForExist(selector, environmentSettings.defaultTimeout);
    const checked = await input.getProperty('checked');
    return checked === true || checked === 'true';
  }

  private async readDisabled(selector: string): Promise<boolean> {
    const input = await $(selector);
    const disabled = await input.getProperty('disabled');
    return disabled === true || disabled === 'true';
  }

  /** True when the memory on/off switch is on (`generate_memories` + `use_memories`). */
  async isMemoryEnabled(): Promise<boolean> {
    return this.readChecked(ENABLED_TOGGLE);
  }

  /**
   * Toggle the memory switch to the requested state and wait until the save settles.
   *
   * The input is transparent and covered by its track, but it owns the pointer
   * surface (`position: absolute; inset: 0; z-index: content`), so a click on the
   * element is a click on the switch. The DOM click is the fallback for the cases
   * where the pointer action cannot land on a transparent input.
   */
  async setMemoryEnabled(enabled: boolean, timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    const input = await this.waitForExist(ENABLED_TOGGLE, timeout);

    if ((await this.readChecked(ENABLED_TOGGLE)) === enabled) {
      return;
    }

    await browser.execute((element: HTMLElement) => element.scrollIntoView({ block: 'center' }), input);
    try {
      await input.click();
    } catch {
      await domClick(ENABLED_TOGGLE);
    }

    await browser.waitUntil(
      async () => {
        const toggled = await this.readChecked(ENABLED_TOGGLE);
        const disabled = await this.readDisabled(ENABLED_TOGGLE);
        return toggled === enabled && !disabled;
      },
      {
        timeout,
        interval: 200,
        timeoutMsg: `Memory switch did not reach enabled=${enabled}`,
      },
    );
  }

  private async readStatusNumber(selector: string): Promise<number> {
    const element = await this.waitForExist(selector, environmentSettings.defaultTimeout);
    const text = (await element.getText()).trim();
    const digits = text.replace(/[^\d]/g, '');
    return digits ? Number.parseInt(digits, 10) : 0;
  }

  async getStoredOutputCount(): Promise<number> {
    return this.readStatusNumber(STATUS_STORED_OUTPUTS);
  }

  async getPendingPromotionCount(): Promise<number> {
    return this.readStatusNumber(STATUS_PENDING_PROMOTION);
  }

  async getRolloutSummaryCount(): Promise<number> {
    return this.readStatusNumber(STATUS_ROLLOUT_SUMMARIES);
  }

  async getPhase2StatusText(): Promise<string> {
    const element = await this.waitForExist(STATUS_PHASE2, environmentSettings.defaultTimeout);
    return (await element.getText()).trim();
  }

  async getMemoryRootDirText(): Promise<string> {
    const element = await this.waitForExist(STATUS_MEMORY_ROOT, environmentSettings.defaultTimeout);
    return (await element.getText()).trim();
  }

  async isRunNowEnabled(): Promise<boolean> {
    const probe = await probeSelector(RUN_NOW_BTN);
    return probe.count > 0 && probe.disabled !== true;
  }

  async clickRunNow(timeout: number = environmentSettings.defaultTimeout): Promise<void> {
    const button = await this.waitForElement(RUN_NOW_BTN, timeout);
    await button.scrollIntoView();
    await button.waitForClickable({ timeout });
    await button.click();
  }

  /**
   * Poll the status card until the predicate holds.
   *
   * The card itself only auto-refreshes every few seconds while a triggered pass
   * runs, so a spec that needs a stricter wait can poll the same DOM values here.
   */
  async waitForStatus(
    predicate: (status: {
      storedOutputCount: number;
      pendingPromotionCount: number;
      rolloutSummaryCount: number;
      phase2StatusText: string;
      memoryRootDirText: string;
    }) => boolean,
    timeout: number,
    interval = 2000,
  ): Promise<void> {
    await browser.waitUntil(
      async () => {
        const storedOutputCount = await this.getStoredOutputCount();
        const pendingPromotionCount = await this.getPendingPromotionCount();
        const rolloutSummaryCount = await this.getRolloutSummaryCount();
        const phase2StatusText = await this.getPhase2StatusText();
        const memoryRootDirText = await this.getMemoryRootDirText();
        return predicate({
          storedOutputCount,
          pendingPromotionCount,
          rolloutSummaryCount,
          phase2StatusText,
          memoryRootDirText,
        });
      },
      {
        timeout,
        interval,
        timeoutMsg: 'Memory status card did not reach the expected state',
      },
    );
  }
}

export default MemoriesSettings;
