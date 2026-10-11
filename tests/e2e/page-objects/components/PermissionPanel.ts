/**
 * Page object for the permission approval band above the chat input.
 *
 * A tool that touches new resources (for example `MemorySave capture_session`,
 * which writes under the memory root) blocks the turn on this surface until the
 * user answers. A spec that drives such a tool has to answer it the way a user
 * would, otherwise the turn never completes.
 *
 * The band (`ChatInputApprovalBand`) replaced the older floating permission
 * panel: it renders inside the composer stack, keeps the
 * `permission-request-panel` component attributes, and exposes its answers as
 * `chat-input-approval-*` test ids. Answering "this request" and "this request
 * and the following ones" is a scope control rather than a second button, so the
 * batch answer sets the scope first.
 *
 * The band is rendered per session and only the active session's band is visible,
 * so the probes here look for a visible root.
 */
import { BasePage } from './../BasePage';
import { $, browser } from '@wdio/globals';
import { domClick, probeSelector } from '../../helpers/dom-utils';

const PANEL_ROOT = '[data-openbitfun-component="permission-request-panel"][data-openbitfun-part="root"]';
const REQUEST_ITEM = '[data-openbitfun-component="permission-request-panel"][data-openbitfun-part="request"]';
const ALLOW_ONCE_BTN = '[data-testid="chat-input-approval-allow"]';
const ALLOW_ALWAYS_BTN = '[data-testid="chat-input-approval-allow-always"]';
const REJECT_BTN = '[data-testid="chat-input-approval-reject"]';
const SCOPE_CONTROL = '[data-testid="chat-input-approval-scope"]';
const SCOPE_ALL_SEGMENT = `${SCOPE_CONTROL} [data-openbitfun-value="all"]`;
const PENDING_COUNT_BADGE = '[data-testid="chat-input-approval-pending-count"]';

export class PermissionPanel extends BasePage {
  /** True while a permission request is waiting for an answer. */
  async hasVisibleRequest(): Promise<boolean> {
    const probe = await probeSelector(PANEL_ROOT);
    return probe.visibleCount > 0 && (await probeSelector(REQUEST_ITEM)).count > 0;
  }

  /**
   * Number of requests waiting for an answer.
   *
   * The band answers one request at a time and reports the remaining ones as a
   * `+N` badge; without a badge exactly one request is pending.
   */
  async getPendingCount(): Promise<number> {
    if (!(await probeSelector(PANEL_ROOT)).visibleCount) {
      return 0;
    }

    const badge = await probeSelector(PENDING_COUNT_BADGE);
    const badgeDigits = (badge.text ?? '').replace(/[^\d]/g, '');
    if (badgeDigits) {
      return Number.parseInt(badgeDigits, 10) + 1;
    }

    return Math.max((await probeSelector(REQUEST_ITEM)).count, 1);
  }

  /** Text of the visible band, for evidence logging. */
  async getPanelText(): Promise<string> {
    return (await probeSelector(PANEL_ROOT)).text ?? '';
  }

  private async clickIfClickable(selector: string): Promise<boolean> {
    const probe = await probeSelector(selector);
    if (probe.visibleCount === 0 || probe.disabled === true) {
      return false;
    }
    const element = await $(selector);
    await element.click().catch(async () => {
      await domClick(selector);
    });
    return true;
  }

  /**
   * Answer the pending request with "allow once".
   *
   * Returns true when something was answered, so a caller can keep looping until
   * the band clears.
   */
  async allowAllOnce(): Promise<boolean> {
    if (!(await this.hasVisibleRequest())) {
      return false;
    }
    return this.clickIfClickable(ALLOW_ONCE_BTN);
  }

  /** Reply to a single pending request with "always allow" when offered. */
  async allowAlways(): Promise<boolean> {
    return this.clickIfClickable(ALLOW_ALWAYS_BTN);
  }

  /**
   * Reply with the batch action "allow current and following".
   *
   * The batch answer is the same button under the `all` scope, so the scope is
   * selected first. Only offered while more than one request is pending.
   */
  async allowBatch(): Promise<boolean> {
    if (!(await this.hasVisibleRequest())) {
      return false;
    }
    if ((await probeSelector(SCOPE_CONTROL)).count === 0) {
      return false;
    }
    if (!(await this.clickIfClickable(SCOPE_ALL_SEGMENT))) {
      return false;
    }
    return this.clickIfClickable(ALLOW_ONCE_BTN);
  }

  async rejectAll(): Promise<boolean> {
    if (!(await this.hasVisibleRequest())) {
      return false;
    }
    return this.clickIfClickable(REJECT_BTN);
  }

  /** Wait until no request is pending, answering every request that appears. */
  async waitForCleared(timeout: number, onApprove?: (pendingCount: number, panelText: string) => void): Promise<void> {
    await browser.waitUntil(
      async () => {
        if (!(await this.hasVisibleRequest())) {
          return true;
        }
        const pendingCount = await this.getPendingCount();
        const panelText = await this.getPanelText();
        const answered = await this.allowAllOnce();
        if (answered) {
          onApprove?.(pendingCount, panelText);
          await browser.pause(500);
          return false;
        }
        return false;
      },
      {
        timeout,
        interval: 1000,
        timeoutMsg: 'Permission requests were never cleared',
      },
    );
  }
}

export default PermissionPanel;
