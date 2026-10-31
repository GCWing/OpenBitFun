import { $, browser } from '@wdio/globals';

export interface ScrollFrame {
  time: number;
  top: number;
  height: number;
  rows: number;
  reverse: number;
  blank: boolean;
  anchor?: Array<{ key: string | undefined; top: number; height: number }>;
}
export interface ScrollProbe {
  frames: ScrollFrame[];
  rectReads: number;
  scans: number;
  wheelEvents: number;
  writes: Array<{ time: number; before: number; after: number; value: number; stack: string | undefined }>;
}

/** Production transcript, driven through the embedded driver's wheel actions. */
export class FlowChatScrollPage {
  async openSession(id: string) {
    const row = $(`[data-testid="nav-session-item"][data-session-id="${id}"]`);
    await row.waitForExist({ timeout: 30000 });
    await row.click();
    await browser.waitUntil(async () => (await $('[data-testid="flowchat-message-list"]').getAttribute('data-open-viewport-settled')) === 'true', { timeout: 30000 });
  }

  async settle() {
    await browser.executeAsync((done: () => void) => {
      let frames = 24;
      const tick = () => --frames ? requestAnimationFrame(tick) : done();
      requestAnimationFrame(tick);
    });
  }

  async startProbe(direction: number) {
    await browser.execute((direction: number, diagnostics: boolean) => {
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const probe: ScrollProbe = { frames: [], rectReads: 0, scans: 0, wheelEvents: 0, writes: [] };
      const rect = Element.prototype.getBoundingClientRect;
      const query = Element.prototype.querySelectorAll;
      let sampling = false, frame = 0, previous: HTMLElement | undefined, previousTop = 0;
      let prototype: object | null = scroller;
      let scrollDescriptor: PropertyDescriptor | undefined;
      while (prototype && !scrollDescriptor) { scrollDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollTop'); prototype = Object.getPrototypeOf(prototype); }
      if (diagnostics && scrollDescriptor?.get && scrollDescriptor?.set) Object.defineProperty(scroller, 'scrollTop', {
        configurable: true, get() { return scrollDescriptor!.get!.call(this); },
        set(value: number) {
          const before = scrollDescriptor!.get!.call(this);
          scrollDescriptor!.set!.call(this, value);
          const after = scrollDescriptor!.get!.call(this);
          if (Math.abs(after - before) > 1) probe.writes.push({ time: performance.now(), before, after, value, stack: new Error().stack });
        },
      });
      Element.prototype.getBoundingClientRect = function () {
        if (!sampling && (this === scroller || this.classList.contains('virtual-item-wrapper'))) probe.rectReads++;
        return rect.call(this);
      };
      Element.prototype.querySelectorAll = function (this: Element, selector: string) {
        if (!sampling && this === scroller) probe.scans++;
        return query.call(this, selector);
      } as typeof query;
      const onWheel = () => probe.wheelEvents++;
      scroller.addEventListener('wheel', onWheel, { passive: true });
      const tick = (time: number) => {
        sampling = true;
        const bounds = rect.call(scroller);
        const rows = [...query.call(scroller, '.virtual-item-wrapper')] as HTMLElement[];
        const visible = rows.filter(row => { const r = rect.call(row); return r.bottom > bounds.top && r.top < bounds.bottom && r.height > 0; });
        const reverse = previous?.isConnected ? Math.max(0, (rect.call(previous).top - previousTop) * direction) : 0;
        previous = visible[0];
        previousTop = previous ? rect.call(previous).top : 0;
        probe.frames.push({ time, top: scroller.scrollTop, height: scroller.scrollHeight, rows: rows.length, reverse, blank: visible.length === 0,
          anchor: diagnostics ? rows.map(row => ({ key: row.dataset.virtualItemKey, top: rect.call(row).top - bounds.top, height: rect.call(row).height })) : undefined });
        sampling = false;
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      (window as any).__flowchatScrollProbe = () => {
        cancelAnimationFrame(frame);
        Element.prototype.getBoundingClientRect = rect;
        Element.prototype.querySelectorAll = query;
        scroller.removeEventListener('wheel', onWheel);
        if (diagnostics) delete (scroller as any).scrollTop;
        return probe;
      };
    }, direction, process.env.OPENBITFUN_SCROLL_DIAGNOSTICS === '1');
  }

  async wheel(delta: number, count = 72) {
    const position = await browser.execute(() => {
      const r = document.querySelector('[data-flowchat-scroller]')!.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 3) };
    });
    await browser.performActions([{ type: 'wheel', id: 'history-wheel', actions: Array.from({ length: count }, () => ({
      type: 'scroll', origin: 'viewport', ...position, deltaX: 0, deltaY: delta, duration: 24,
    })) }]);
    await browser.releaseActions();
  }

  async stopProbe(): Promise<ScrollProbe> {
    return browser.execute(() => {
      const probe = (window as any).__flowchatScrollProbe();
      delete (window as any).__flowchatScrollProbe;
      return probe;
    });
  }

  async disposeProbe() {
    await browser.execute(() => {
      (window as any).__flowchatScrollProbe?.();
      delete (window as any).__flowchatScrollProbe;
    });
  }

  async enterDraft(text: string) {
    const editor = $('[data-testid="chat-input-container"] .rich-text-input[contenteditable="true"]');
    await editor.waitForExist();
    await editor.click();
    await browser.keys(text);
  }

  async draftText() {
    return $('[data-testid="chat-input-container"] .rich-text-input[contenteditable="true"]').getText();
  }

  async findFirstResult(query: string) {
    await $('[data-testid="flowchat-header-search"]').click();
    await $('[data-testid="flowchat-header-search-bar"] input').setValue(query);
    // Trajectory search is debounced. Wait for results before navigating them.
    await browser.waitUntil(async () => /\/\s*[1-9]\d*/.test(
      await $('.flowchat-header__search-status').getText(),
    ), { timeout: 15000 });
    await browser.keys('Enter');
    await browser.waitUntil(() => browser.execute(() => {
      const line = document.querySelector<HTMLElement>('.flowchat-search-line:not([hidden])');
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]');
      if (!line || !scroller) return false;
      const a = line.getBoundingClientRect(), b = scroller.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom;
    }), { timeout: 15000 });
  }

  async closeSearch() {
    await browser.keys('Escape');
  }

  async anchor() {
    return browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].find(row => {
        const rect = row.getBoundingClientRect(); return rect.bottom > top && rect.top < top + scroller.clientHeight && rect.height > 0;
      });
      return { key: row?.dataset.virtualItemKey, offset: row ? row.getBoundingClientRect().top - top : 0, top: scroller.scrollTop };
    });
  }
}
