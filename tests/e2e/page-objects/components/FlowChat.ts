/**
 * Page object for the flow chat transcript.
 *
 * The flow chat renders virtualized `[data-testid="flowchat-message-item"]`
 * wrappers tagged with `data-item-type` (`user-message`, `model-round`,
 * `turn-failure-notice`, ...). Tool cards are nested inside a model round and
 * carry `data-tool-name` on the card wrapper; the card body exposes
 * `data-openbitfun-status` and a `data-openbitfun-state` that includes `failed`
 * on error.
 *
 * Reads go through `helpers/dom-utils` because WebdriverIO's `isExisting()` never
 * settles on this driver's non-W3C "no such element" response: a wait whose
 * predicate is `!element.isExisting()` polls until the test timeout instead of
 * resolving. The transcript is small enough that one DOM probe per poll is both
 * cheaper and more reliable than element round trips.
 */
import { BasePage } from './../BasePage';
import { browser, $, $$ } from '@wdio/globals';
import { domCount, domTexts, probeSelector } from '../../helpers/dom-utils';

const MESSAGE_ITEM = '[data-testid="flowchat-message-item"]';
const CANCEL_BUTTON = '[data-testid="chat-input-cancel-btn"]';
const TURN_FAILURE = '[data-openbitfun-component="turn-failure-notice"][data-openbitfun-part="root"]';
/** Tool statuses that mean "still working"; every other status is settled. */
const UNSETTLED_TOOL_STATUSES = new Set([
  'pending',
  'queued',
  'waiting',
  'preparing',
  'streaming',
  'receiving',
  'running',
  'analyzing',
  'pending_confirmation',
]);

export class FlowChat extends BasePage {
  private itemSelector(itemType: string): string {
    return `${MESSAGE_ITEM}[data-item-type="${itemType}"]`;
  }

  /**
   * `data-tool-name` sits on the wrapper; the status/state attributes live on
   * whichever card component the tool resolved to (`BaseToolCard`,
   * `CompactToolCard`, `DefaultToolCard`, ...), so both are read from the wrapper
   * subtree instead of from one hard-coded card element.
   */
  private toolCardSelector(toolName: string): string {
    return `[data-tool-name="${toolName}"]`;
  }

  private toolCardStatusSelector(toolName: string): string {
    return `${this.toolCardSelector(toolName)} [data-openbitfun-status]`;
  }

  private toolCardStateSelector(toolName: string): string {
    return `${this.toolCardSelector(toolName)} [data-openbitfun-state]`;
  }

  async waitForLoad(timeout = 15000): Promise<void> {
    await this.waitForElement(MESSAGE_ITEM, timeout);
  }

  /** True while the active session is streaming a turn. */
  async isTurnRunning(): Promise<boolean> {
    const probe = await probeSelector(CANCEL_BUTTON);
    return probe.visibleCount > 0;
  }

  async getUserMessageTexts(): Promise<string[]> {
    return domTexts(this.itemSelector('user-message'));
  }

  async getModelRoundTexts(): Promise<string[]> {
    return domTexts(this.itemSelector('model-round'));
  }

  async getTurnFailureTexts(): Promise<string[]> {
    return domTexts(TURN_FAILURE);
  }

  async hasTurnFailureNotice(): Promise<boolean> {
    return (await domCount(TURN_FAILURE)) > 0;
  }

  /** Wait until a user message containing `needle` is rendered. */
  async waitForUserMessageContaining(needle: string, timeout: number): Promise<void> {
    await browser.waitUntil(
      async () => {
        const texts = await this.getUserMessageTexts();
        return texts.some(text => text.includes(needle));
      },
      {
        timeout,
        interval: 500,
        timeoutMsg: `User message never rendered: ${needle}`,
      },
    );
  }

  /** Wait until any model round contains `needle`. */
  async waitForAssistantText(needle: string, timeout: number): Promise<void> {
    await browser.waitUntil(
      async () => {
        const texts = await this.getModelRoundTexts();
        return texts.some(text => text.includes(needle));
      },
      {
        timeout,
        interval: 1000,
        timeoutMsg: `Assistant output never contained: ${needle}`,
      },
    );
  }

  /**
   * Wait for the running turn to finish.
   *
   * The cancel button exists and is visible only while the session is streaming,
   * so its disappearance is the completion signal. A very fast turn may finish
   * before the button is ever observed, which is why the "started" wait is
   * best-effort.
   */
  async waitForTurnComplete(timeout: number): Promise<void> {
    try {
      await browser.waitUntil(
        async () => this.isTurnRunning(),
        { timeout: 20000, interval: 200 },
      );
    } catch {
      // The turn completed before streaming was observed.
    }

    await browser.waitUntil(
      async () => !(await this.isTurnRunning()),
      {
        timeout,
        interval: 1000,
        timeoutMsg: 'Chat turn did not complete within the timeout',
      },
    );

    await browser.pause(500);
  }

  async getToolCards(toolName: string): Promise<WebdriverIO.Element[]> {
    const cards = await $$(this.toolCardSelector(toolName));
    const result: WebdriverIO.Element[] = [];
    for (const card of cards) {
      result.push(card);
    }
    return result;
  }

  async getToolCardTexts(toolName: string): Promise<string[]> {
    return domTexts(this.toolCardSelector(toolName));
  }

  async waitForToolCard(toolName: string, timeout: number): Promise<void> {
    await browser.waitUntil(
      async () => (await domCount(this.toolCardSelector(toolName))) > 0,
      {
        timeout,
        interval: 500,
        timeoutMsg: `Tool card never appeared: ${toolName}`,
      },
    );
  }

  /** `data-openbitfun-status` of every card element for `toolName`, in document order. */
  async getToolCardStatuses(toolName: string): Promise<string[]> {
    return (await probeSelector(this.toolCardStatusSelector(toolName))).statuses;
  }

  /** True when any element of `toolName`'s card reports an error/failure state. */
  async hasToolCardError(toolName: string): Promise<boolean> {
    const statusProbe = await probeSelector(this.toolCardStatusSelector(toolName));
    if (statusProbe.statuses.some(status => status === 'error' || status === 'failed')) {
      return true;
    }

    const stateProbe = await probeSelector(this.toolCardStateSelector(toolName));
    return stateProbe.states.some(state => state.split(/\s+/).includes('failed'));
  }

  /**
   * Read a tool card's current evidence in one shot.
   *
   * `present` is false when the transcript has collapsed the tool group that owns
   * the card, which the flow chat does once a turn finishes.
   */
  async readToolCardEvidence(toolName: string): Promise<{
    present: boolean;
    statuses: string[];
    texts: string[];
    hasError: boolean;
  }> {
    const wrapper = await probeSelector(this.toolCardSelector(toolName));
    const statusProbe = await probeSelector(this.toolCardStatusSelector(toolName));
    const stateProbe = await probeSelector(this.toolCardStateSelector(toolName));

    return {
      present: wrapper.count > 0,
      statuses: statusProbe.statuses,
      texts: wrapper.texts,
      hasError: statusProbe.statuses.some(status => status === 'error' || status === 'failed')
        || stateProbe.states.some(state => state.split(/\s+/).includes('failed')),
    };
  }

  /**
   * Wait for a tool card to settle, tolerating a card the transcript collapsed away.
   *
   * Tool calls are grouped under a collapsible "ran N explorations" row that
   * auto-expands while the turn streams and collapses when it finishes. A card
   * asserted after the turn therefore often no longer exists, and a strict
   * presence requirement would wait forever. Absence means "nothing left to
   * settle", and the caller pairs this with turn-idle and host-side evidence.
   *
   * @returns true when a card was still present and settled; false when it had
   * already been collapsed out of the DOM.
   */
  async waitForToolCardSettledIfPresent(toolName: string, timeout: number): Promise<boolean> {
    let present = true;

    await browser.waitUntil(
      async () => {
        const wrapper = await probeSelector(this.toolCardSelector(toolName));
        if (wrapper.count === 0) {
          present = false;
          return true;
        }

        const statusProbe = await probeSelector(this.toolCardStatusSelector(toolName));
        if (statusProbe.count > 0) {
          return statusProbe.statuses.every(status => status !== '' && !UNSETTLED_TOOL_STATUSES.has(status));
        }

        const stateProbe = await probeSelector(this.toolCardStateSelector(toolName));
        return !stateProbe.states.some(state => state.split(/\s+/).includes('failed'));
      },
      {
        timeout,
        interval: 1000,
        timeoutMsg: `Tool card ${toolName} never settled`,
      },
    );

    return present;
  }

  /**
   * Wait until `toolName`'s card has left a running/streaming status.
   *
   * Cards built on `BaseToolCard`/`CompactToolCard` expose a status, so the wait
   * is on that. `DefaultToolCard` (used by the memory tools) exposes only an
   * expanded/failed state, which cannot express "still running": for those, the
   * caller's turn-idle wait is the completion signal, so the card only has to
   * exist and not report a failure.
   */
  async waitForToolCardSettled(toolName: string, timeout: number): Promise<void> {
    const present = await this.waitForToolCardSettledIfPresent(toolName, timeout);
    if (!present) {
      throw new Error(`Tool card ${toolName} was collapsed before it could be inspected`);
    }
  }
}

export default FlowChat;
