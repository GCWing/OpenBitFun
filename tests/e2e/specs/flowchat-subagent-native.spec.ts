import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, $$, browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';

const evidence = process.env.OPENBITFUN_FLOWCHAT_E2E_ROOT!;
const sessionId = process.env.OPENBITFUN_FLOWCHAT_SESSION_IDS!.split(',')[0];
const samples: unknown[] = [];

declare global {
  interface Window {
    flowchatAgentGridProbe?: { grid: HTMLElement; cards: HTMLElement[]; focused: HTMLElement };
  }
}

class SubagentTranscriptPage {
  async settle() {
    await browser.executeAsync((done: () => void) => {
      let frames = 16;
      const frame = () => --frames ? requestAnimationFrame(frame) : done();
      requestAnimationFrame(frame);
    });
  }

  async open() {
    expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!)).toBe(true);
    const session = $(`[data-testid="nav-session-item"][data-session-id="${sessionId}"]`);
    await session.waitForExist({ timeout: 30000 });
    await session.click();
    await browser.waitUntil(async () => (await $('[data-testid="flowchat-message-list"]')
      .getAttribute('data-open-viewport-settled')) === 'true', { timeout: 30000 });
  }

  async rememberCards() {
    await browser.execute(() => {
      const grid = [...document.querySelectorAll<HTMLElement>('[data-flowchat-scroller] [data-agent-card-grid]')]
        .find(node => node.querySelectorAll('[data-agent-capsule-trigger]').length >= 3);
      if (!grid) throw new Error('Recorded parent needs at least three adjacent Subagent launch cards');
      const cards = [...grid.querySelectorAll<HTMLElement>('[data-openbitfun-tool-card="agent-control"]')];
      const focused = cards[0].querySelector<HTMLElement>('[data-agent-capsule-trigger]')!;
      focused.focus({ preventScroll: true });
      window.flowchatAgentGridProbe = { grid, cards, focused };
    });
  }

  async sampleCards(label: string) {
    const sample = await browser.execute(() => {
      const { grid, cards, focused } = window.flowchatAgentGridProbe!;
      const scroller = grid.closest<HTMLElement>('[data-flowchat-scroller]')!;
      const style = getComputedStyle(grid);
      const box = grid.getBoundingClientRect();
      return {
        connected: grid.isConnected && cards.every(card => card.isConnected),
        sameCards: cards.every((card, index) => grid.querySelectorAll('[data-openbitfun-tool-card="agent-control"]')[index] === card),
        focused: document.activeElement === focused,
        activeElement: document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName,
        display: style.display,
        gap: Number.parseFloat(style.columnGap),
        paragraphGap: Number.parseFloat(style.getPropertyValue('--openbitfun-control-flow-chat-paragraph-gap')),
        contentWidth: grid.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
        scrollerWidth: scroller.clientWidth,
        scrollTop: scroller.scrollTop,
        cards: cards.map(card => {
          const rect = card.getBoundingClientRect();
          return { width: rect.width, height: rect.height, left: rect.left - box.left, top: rect.top - box.top };
        }),
      };
    });
    samples.push({ label, ...sample });
    return sample;
  }

  async scroll(top: number) {
    await browser.execute((top: number) => {
      const node = document.querySelector<HTMLElement>('.btw-session-panel__body')!;
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: top - node.scrollTop, bubbles: true }));
      node.scrollTop = top;
      node.dispatchEvent(new Event('scroll'));
    }, top);
    await this.settle();
  }

  async sample(label: string) {
    const sample = await browser.execute(() => {
      const node = document.querySelector<HTMLElement>('.btw-session-panel__body')!;
      const top = node.getBoundingClientRect().top + node.clientTop;
      const rows = [...node.querySelectorAll<HTMLElement>('.virtual-item-wrapper')]
        .map(row => ({ key: row.dataset.virtualItemKey, index: row.dataset.virtualIndex,
          kind: row.dataset.timelineKind, group: row.dataset.timelineGroupId,
          top: row.getBoundingClientRect().top - top, height: row.offsetHeight,
          bottom: row.getBoundingClientRect().bottom - top }));
      const window = node.querySelector('.virtual-item-wrapper')?.parentElement;
      return { rows, sessionId: node.dataset.flowchatSelectionRoot,
        scrollTop: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight,
        paddingBottom: Number.parseFloat(window?.style.paddingBottom || '0'),
        lastRowBottom: Math.max(0, ...rows.map(row => row.bottom)),
        groupCounts: [...node.querySelectorAll<HTMLElement>('[data-flow-group]')]
          .map(group => ({ id: group.dataset.toolCardId, count: group.dataset.itemCount,
            expanded: group.dataset.expanded })) };
    });
    samples.push({ label, ...sample });
    return sample;
  }
}

const page = new SubagentTranscriptPage();
describe('Recorded subagent collection window', () => {
  after(() => writeFileSync(join(evidence, 'subagent-expansion.json'), JSON.stringify(samples, null, 2)));
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') await browser.saveScreenshot(join(evidence, 'subagent-failure.png'));
  });

  it('wraps fixed-width agent cards without stretching or remounting them', async () => {
    const original = await browser.getWindowRect();
    try {
      await browser.maximizeWindow();
      const maximum = await browser.getWindowRect();
      // Leave maximized mode before acquiring card focus: native restoration
      // activates the application and is a separate composer-focus lifecycle.
      await browser.setWindowRect(maximum.x, maximum.y, maximum.width, maximum.height);
      await page.open();
      await page.settle();
      await page.rememberCards();
      const wide = await page.sampleCards('agent-grid-wide');
      expect(wide.display).toBe('grid');
      expect(wide.gap).toBe(wide.paragraphGap);
      expect(wide.cards).toHaveLength(3);
      expect(wide.cards.every(card => Math.abs(card.top - wide.cards[0].top) < 1)).toBe(true);
      const width = wide.cards[0].width;
      for (let index = 1; index < wide.cards.length; index++) {
        expect(Math.abs(wide.cards[index].left - wide.cards[index - 1].left - width - wide.gap)).toBeLessThan(1);
      }
      await browser.saveScreenshot(join(evidence, 'agent-grid-wide.png'));
      const wideWindow = await browser.getWindowRect();
      const scale = await browser.execute(() => window.devicePixelRatio);
      // Resize the native host, keeping the application layout and data intact.
      for (const [columns, viewportWidth] of [[2, 740], [1, 500]]) {
        await browser.setWindowRect(wideWindow.x, wideWindow.y,
          Math.round(wideWindow.width - (wide.scrollerWidth - viewportWidth) * scale), wideWindow.height);
        await page.settle();
        const wrapped = await page.sampleCards(`agent-grid-${columns}-columns`);
        expect(wrapped.connected && wrapped.sameCards && wrapped.focused).toBe(true);
        expect(wrapped.cards.every(card => Math.abs(card.width - width) < 1)).toBe(true);
        expect(wrapped.cards.filter(card => Math.abs(card.top - wrapped.cards[0].top) < 1)).toHaveLength(columns);
        expect(Math.abs(wrapped.cards[columns].top - wrapped.cards[0].top - wrapped.cards[0].height - wrapped.gap)).toBeLessThan(1);
        await browser.saveScreenshot(join(evidence, `agent-grid-${columns}-columns.png`));
      }
      await browser.setWindowRect(wideWindow.x, wideWindow.y, wideWindow.width, wideWindow.height);
      await page.settle();
      const restored = await page.sampleCards('agent-grid-restored');
      expect(restored.connected && restored.sameCards && restored.focused).toBe(true);
      expect(restored.cards.every(card => Math.abs(card.top - restored.cards[0].top) < 1)).toBe(true);
    } finally {
      await browser.execute(() => { delete window.flowchatAgentGridProbe; });
      await browser.setWindowRect(original.x, original.y, original.width, original.height);
    }
  });

  it('fills the visible sidebar after disclosure without another scroll gesture', async () => {
    await page.open();
    const cards = await $$('[data-flowchat-scroller] [data-agent-capsule-trigger]');
    expect(cards.length).toBeGreaterThan(0);
    for (let index = 0; index < cards.length; index++) {
      const previous = await browser.execute(() => document.querySelector<HTMLElement>('.btw-session-panel__body')?.dataset.flowchatSelectionRoot);
      await cards[index].click();
      await $('.btw-session-panel__body').waitForDisplayed({ timeout: 10000 });
      await browser.waitUntil(async () => browser.execute((previous?: string) => {
        const current = document.querySelector<HTMLElement>('.btw-session-panel__body')?.dataset.flowchatSelectionRoot;
        return Boolean(current && current !== previous);
      }, previous), { timeout: 10000 });
      await page.scroll(0);
      const selector = '.btw-session-panel__body [data-timeline-kind="group-header"] [role="button"][aria-expanded]';
      const toggle = $(selector);
      await toggle.waitForExist({ timeout: 10000 });
      if (await toggle.getAttribute('aria-expanded') === 'true') {
        await toggle.click();
        await page.settle();
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        const before = await page.sample(`agent-${index}-cycle-${cycle}-collapsed`);
        await toggle.click();
        // No scroll is dispatched after expanding. Measuring must fill the view.
        await page.settle();
        const result = await page.sample(`agent-${index}-cycle-${cycle}-expanded`);
        expect(result.rows.length).toBeLessThan(100);
        if (result.paddingBottom > 1) expect(result.lastRowBottom).toBeGreaterThanOrEqual(result.height - 2);
        const header = result.rows.find(row => row.kind === 'group-header');
        const beforeHeader = before.rows.find(row => row.key === header?.key);
        expect(Math.abs(header!.top - beforeHeader!.top)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
        if (cycle === 0) await browser.saveScreenshot(join(evidence, `subagent-${index}-expanded.png`));
        await page.scroll(Math.min(400, result.scrollHeight - result.height));
        const reading = await page.sample(`agent-${index}-cycle-${cycle}-reading`);
        if (reading.paddingBottom > 1) expect(reading.lastRowBottom).toBeGreaterThanOrEqual(reading.height - 2);
        await page.scroll(0);
        await toggle.click();
        await page.settle();
      }
    }
  });
});
