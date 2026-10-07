import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, $$, browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';

const ids = process.env.OPENBITFUN_FLOWCHAT_SESSION_IDS!.split(',');
const evidence = process.env.OPENBITFUN_FLOWCHAT_E2E_ROOT!;
const samples: Record<string, unknown> = {};

async function profileExpansion() {
  const port = process.env.OPENBITFUN_FLOWCHAT_CDP_PORT;
  if (!port) return async () => {};
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; title: string; webSocketDebuggerUrl: string }>;
  samples.profileTargets = pages.map(({ type, url, title }) => ({ type, url, title }));
  const target = pages.find(page => page.type === 'page' && page.url.includes('index.html') && !page.url.includes('openbitfunWindow='))!;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let next = 0;
  const pending = new Map<number, (value: any) => void>();
  const trace: unknown[] = [];
  let traceCompleted: () => void = () => {};
  socket.onmessage = event => {
    const value = JSON.parse(String(event.data));
    if (value.method === 'Tracing.dataCollected') trace.push(...value.params.value);
    if (value.method === 'Tracing.tracingComplete') traceCompleted();
    pending.get(value.id)?.(value.result); pending.delete(value.id);
  };
  const call = (method: string, params?: object) => new Promise<any>(resolve => {
    const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Performance.enable');
  const before = await call('Performance.getMetrics');
  await call('Profiler.enable'); await call('Profiler.start');
  await call('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
  return async () => {
    const profile = await call('Profiler.stop');
    const after = await call('Performance.getMetrics');
    const done = new Promise<void>(resolve => { traceCompleted = resolve; });
    await call('Tracing.end'); await done;
    writeFileSync(join(evidence, 'expansion-trace.json'), JSON.stringify({ traceEvents: trace }));
    writeFileSync(join(evidence, 'expansion-profile.json'), JSON.stringify(profile));
    samples.expansionMetrics = { before, after };
    socket.close();
  };
}

class NativeFlowChatPage {
  async openSession(id: string) {
    const row = $(`[data-testid="nav-session-item"][data-session-id="${id}"]`);
    await row.waitForExist({ timeout: 30000 });
    await row.click();
    await $('[data-flowchat-scroller]').waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(async () => (await $('[data-testid="flowchat-message-list"]').getAttribute('data-open-viewport-settled')) === 'true', { timeout: 30000 });
  }
  async scroll(top: number) {
    await browser.execute((offset: number) => {
      const node = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: offset < node.scrollTop ? -300 : 300, bubbles: true }));
      node.scrollTop = offset;
      node.dispatchEvent(new Event('scroll'));
    }, top);
    await this.settle();
  }
  async settle() {
    await browser.executeAsync((done: () => void) => {
      let remaining = 12;
      const frame = () => --remaining ? requestAnimationFrame(frame) : done();
      requestAnimationFrame(frame);
    });
  }
  async sample(name: string) {
    samples[name] = await browser.execute(() => {
      const node = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      return { mountedRows: node.querySelectorAll('.virtual-item-wrapper').length,
        mountedTools: node.querySelectorAll('.flow-tool-card-wrapper').length,
        domNodes: node.querySelectorAll('*').length, scrollTop: node.scrollTop,
        rows: [...node.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].map(row => ({
          index: row.dataset.virtualIndex, kind: row.dataset.timelineKind,
          key: row.dataset.virtualItemKey, height: row.getBoundingClientRect().height,
          top: row.getBoundingClientRect().top - node.getBoundingClientRect().top,
          group: row.dataset.timelineGroupId,
        })),
        scrollHeight: node.scrollHeight, viewportHeight: node.clientHeight,
        heap: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize };
    });
    return samples[name] as { mountedRows: number; mountedTools: number; scrollTop: number; scrollHeight: number };
  }
}
const page = new NativeFlowChatPage();

describe('Desktop FlowChat with recorded sessions', () => {
  before(async () => {
    expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!)).toBe(true);
  });
  after(async () => { writeFileSync(join(evidence, 'result.json'), JSON.stringify(samples, null, 2)); });
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    await browser.saveScreenshot(join(evidence, 'failure.png'));
    const state = await browser.execute(() => {
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]');
      const source = document.querySelector<HTMLElement>('.virtual-item-wrapper[data-openbitfun-state~="searchCurrent"] .thinking-markdown');
      const ranges: unknown[] = [];
      if (source) {
        const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.toLowerCase().indexOf('src') ?? -1;
          if (index < 0) continue;
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 3);
          const parents: unknown[] = [];
          for (let e = node.parentElement; e && e !== scroller; e = e.parentElement) parents.push({
            className: e.className, rect: e.getBoundingClientRect().toJSON(),
            overflow: getComputedStyle(e).overflowY, scrollTop: e.scrollTop, ariaHidden: e.getAttribute('aria-hidden'),
          });
          ranges.push({ rects: [...range.getClientRects()].map(r => r.toJSON()), parents });
          break;
        }
      }
      return { search: document.querySelector('.flowchat-header__search')?.outerHTML,
        ranges,
        scrollTop: scroller?.scrollTop, height: scroller?.clientHeight,
        rows: [...document.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].map(row => ({
          data: { ...row.dataset }, top: row.getBoundingClientRect().top, height: row.offsetHeight,
          sources: [...row.querySelectorAll<HTMLElement>('[data-flow-item-id], [data-tool-card-id]')].map(source => ({
            data: { ...source.dataset }, text: source.textContent?.slice(0, 160),
          })), line: row.querySelector('.flowchat-search-line')?.outerHTML,
          current: row.dataset.openbitfunState?.includes('searchCurrent') ? row.outerHTML : undefined,
        })) };
    });
    writeFileSync(join(evidence, 'failure.json'), JSON.stringify(state, null, 2));
  });

  it('opens large history, incrementally mounts groups, preserves filtering and scrolling after recycling', async () => {
    await page.openSession(ids[0]);
    await page.sample('opened');
    await page.scroll(0);
    const header = $('[data-timeline-kind="group-header"]');
    await header.waitForExist({ timeout: 10000 });
    const group = await header.getAttribute('data-timeline-group-id');
    const groupSelector = `[data-timeline-kind="group-header"][data-timeline-group-id="${group}"]`;
    const toggleSelector = `${groupSelector} [data-openbitfun-part="header"][role="button"]`;
    const finishProfile = await profileExpansion();
    await browser.execute((selector: string) => {
      const toggle = document.querySelector<HTMLElement>(selector)!;
      const root = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const baseline = toggle.getBoundingClientRect().top;
      const state = { frameMs: 0, maxHeaderDrift: 0, tasks: [] as number[] };
      (window as unknown as { flowchatProbe: unknown }).flowchatProbe = state;
      const observer = new PerformanceObserver(entries => entries.getEntries().forEach(entry => state.tasks.push(entry.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      toggle.addEventListener('click', () => {
        const start = performance.now();
        let n = 0;
        const frame = () => {
          state.maxHeaderDrift = Math.max(state.maxHeaderDrift, Math.abs(toggle.getBoundingClientRect().top - baseline));
          if (++n === 2) state.frameMs = performance.now() - start;
          if (n < 20 && root.isConnected) requestAnimationFrame(frame); else observer.disconnect();
        };
        requestAnimationFrame(frame);
      }, { once: true });
    }, toggleSelector);
    await $(toggleSelector).click();
    await page.settle();
    await finishProfile();
    await expect($(toggleSelector)).toHaveAttribute('aria-expanded', 'true');
    const opened = await page.sample('expanded');
    expect(opened.mountedRows).toBeLessThan(60);
    samples.firstExpansion = await browser.execute(() => (window as unknown as { flowchatProbe: unknown }).flowchatProbe);
    await browser.saveScreenshot(join(evidence, 'expanded.png'));
    const query = $(`${groupSelector} input`);
    await query.setValue('__flowchat_no_match__');
    await page.settle();
    expect(await $$(`[data-timeline-kind="group-members"][data-timeline-group-id="${group}"]`)).toHaveLength(0);
    await query.setValue('');
    await page.settle();
    const countBefore = (await page.sample('filter-cleared')).mountedTools;
    // Open a real recorded card through its native surface.
    const card = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('.flow-tool-card-wrapper [data-openbitfun-part="surface"][data-openbitfun-expandable="true"]');
      return button?.closest<HTMLElement>('.flow-tool-card-wrapper')?.dataset.toolCardId;
    });
    expect(card).toBeTruthy();
    const cardSelector = `.flow-tool-card-wrapper[data-tool-card-id="${card}"]`;
    const cardToggle = `${cardSelector} [data-openbitfun-part="surface"][data-openbitfun-expandable="true"]`;
    const cardShell = `${cardSelector} [data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="root"]`;
    await $(cardToggle).click();
    await page.settle();
    await expect($(cardShell)).toHaveAttribute('data-openbitfun-expanded-shell', 'true');
    await browser.execute(() => (document.activeElement as HTMLElement)?.blur());
    await page.scroll(10000000);
    await page.sample('tail');
    await page.scroll(0);
    await expect($(toggleSelector)).toHaveAttribute('aria-expanded', 'true');
    await expect($(cardShell)).toHaveAttribute('data-openbitfun-expanded-shell', 'true');
    await $(cardToggle).click();
    await page.settle();
    expect((await page.sample('returned')).mountedTools).toBe(countBefore);
    await $(toggleSelector).click();
    await page.settle();
    await expect($(toggleSelector)).toHaveAttribute('aria-expanded', 'false');
    await browser.saveScreenshot(join(evidence, 'collapsed.png'));
  });

  it('restores the session reader state after switching away and keeps search usable', async () => {
    await page.openSession(ids[0]); await page.scroll(0);
    const toggle = $('[data-timeline-kind="group-header"] [data-openbitfun-part="header"][role="button"]');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.settle();
    await page.scroll(1800);
    const before = await page.sample('before-switch');
    await page.openSession(ids[1]);
    await page.sample('second-session');
    await page.openSession(ids[0]);
    await page.settle();
    const restored = await page.sample('after-switch');
    expect(Math.abs(restored.scrollTop - before.scrollTop)).toBeLessThan(8);
    await page.scroll(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await $('[data-testid="flowchat-header-search"]').click();
    const search = $('.flowchat-header__search input');
    await search.waitForExist();
    await search.setValue('src');
    await page.settle();
    await browser.waitUntil(() => browser.execute(() => {
      const line = document.querySelector<HTMLElement>('.virtual-item-wrapper[data-openbitfun-state~="searchCurrent"] .flowchat-search-line:not([hidden])');
      const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]');
      if (!line || !scroller) return false;
      const a = line.getBoundingClientRect(), b = scroller.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom;
    }), { timeout: 10000, timeoutMsg: 'A concrete search hit must be visible in the transcript' });
    await page.sample('search');
    await browser.keys('Escape');
    await browser.saveScreenshot(join(evidence, 'search.png'));
  });

  it('retains native selection through recycling, resize and minimized-window restoration', async () => {
    await page.openSession(ids[0]); await page.scroll(0);
    const selected = await browser.execute(() => {
      const source = document.querySelector<HTMLElement>('.user-message-item__content')!;
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode()) && (node.textContent?.trim().length ?? 0) < 8) { /* find recorded prose */ }
      if (!node) throw new Error('Recorded user message has no selectable text');
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(24, node.textContent!.length));
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      const events: unknown[] = [];
      (window as any).selectionProbe = { source, events };
      for (const type of ['selectionchange', 'focusin', 'focusout']) document.addEventListener(type, () => {
        events.push({ type, connected: source.isConnected, text: window.getSelection()?.toString(),
          active: document.activeElement?.outerHTML.slice(0, 200) });
      });
      return selection.toString();
    });
    await page.scroll(10000000);
    expect(await browser.execute(() => window.getSelection()?.toString())).toBe(selected);
    const original = await browser.getWindowRect();
    try {
      await browser.setWindowRect(original.x, original.y, Math.max(900, original.width - 240), Math.max(700, original.height - 120));
      await page.settle();
      samples.resizeSelection = await browser.execute(() => {
        const probe = (window as any).selectionProbe;
        return { connected: probe.source.isConnected, events: probe.events };
      });
      expect(await browser.execute(() => window.getSelection()?.toString())).toBe(selected);
      const before = await page.sample('before-minimize');
      await browser.minimizeWindow();
      await browser.maximizeWindow();
      await browser.setWindowRect(original.x, original.y, original.width, original.height);
      await page.settle();
      const after = await page.sample('after-restore');
      expect(after.mountedRows).toBeGreaterThan(0);
      expect(after.mountedRows).toBeLessThan(80);
      expect(await browser.execute(() => window.getSelection()?.toString())).toBe(selected);
      samples.minimize = { before, after };
    } finally {
      await browser.maximizeWindow();
      await browser.setWindowRect(original.x, original.y, original.width, original.height);
      await browser.execute(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    }
    await browser.saveScreenshot(join(evidence, 'restored.png'));
  });
});
