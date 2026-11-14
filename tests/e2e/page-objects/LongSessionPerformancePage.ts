import { $, browser } from '@wdio/globals';
import { FlowChatScrollPage } from './FlowChatScrollPage';

export interface LongSessionProbe {
  times: number[]; actionAt: number; endAt: number; latencyMs: number | null;
  readyAt?: number; firstMovementAt?: number; inputType?: string; wheelTimes: number[];
  beforeTop: number; afterTop: number; visibility: string; focus: boolean;
  visibilityChanged: boolean; focusChanged: boolean; timedOut: boolean;
  longTasksSupported: boolean; longTasks: Array<{ startTime: number; durationMs: number }>;
  targetTurnId?: string;
  milestones?: { targetDomMs?: number; targetVisibleMs?: number; viewportReadyMs?: number };
  rowChurn?: { added: Record<string, number>; removed: Record<string, number> };
  rowBatches?: Array<{ time: number; added: number; removed: number }>;
  postReady?: { endAt?: number; maxAnchorDriftPx: number; missingAnchorFrames: number;
    longTasks: Array<{ startTime: number; durationMs: number }> };
  scrollPositions?: Array<{ time: number; top: number }>;
}
interface ProbeOptions { sessionId: string; scrollerSelector?: string; turnId?: string; selector?: string; wheelCount?: number; collectRows?: boolean; collectMilestones?: boolean;
  postReadyMs?: number; checkAnchor?: boolean; }
type ProbeHost = Window & { __longSessionProbe?: {
  result: Partial<LongSessionProbe>; done: boolean; dispose: () => void;
} };

/** Measures the production transcript; no Vite imports or product store mutations. */
export class LongSessionPerformancePage extends FlowChatScrollPage {
  async activateSession(id: string) {
    await $(this.sessionSelector(id)).scrollIntoView();
    // The embedded click endpoint emits MouseEvent only; sidebar activation starts at pointerdown.
    await browser.execute((selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)!;
      const rect = node.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2, button: 0 };
      node.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
      node.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
      node.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      node.dispatchEvent(new MouseEvent('mouseup', init)); node.click();
    }, this.sessionSelector(id));
    await browser.waitUntil(() => browser.execute((id: string) => {
      const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
      return !!root?.querySelector('[data-open-viewport-settled="true"]')
        && !root.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])');
    }, id), { timeout: 30_000, interval: 100 });
  }

  async wheelPane(selector: string, delta: number, count: number) {
    const position = await browser.execute((selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 3) };
    }, selector);
    await browser.performActions([{ type: 'wheel', id: 'btw-wheel', actions: Array.from({ length: count }, () => ({
      type: 'scroll', origin: 'viewport', ...position, deltaX: 0, deltaY: delta, duration: 24,
    })) }]);
    await browser.releaseActions();
  }

  async paneAnchor(selector: string) {
    return browser.execute((selector: string) => {
      const scroll = document.querySelector<HTMLElement>(selector)!;
      const top = scroll.getBoundingClientRect().top;
      const row = [...scroll.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].find(row => {
        const rect = row.getBoundingClientRect(); return rect.bottom > top && rect.top < top + scroll.clientHeight && rect.height > 0;
      });
      return { key: row?.dataset.virtualItemKey, offset: row ? row.getBoundingClientRect().top - top : 0 };
    }, selector);
  }

  async returnToLatest(sessionId: string, paragraph: number) {
    const selector = '[data-openbitfun-product-component="scroll-to-latest-bar"][data-openbitfun-product-part="root"][data-visible="true"]';
    if (await $(selector).isExisting()) await $(selector).click();
    await this.waitForLiveParagraph(sessionId, paragraph);
  }

  async waitForLiveParagraph(sessionId: string, paragraph: number) {
    await browser.waitUntil(() => browser.execute((id: string, paragraph: number) => {
      const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
      const scroll = root?.querySelector<HTMLElement>('[data-flowchat-scroller]');
      if (!scroll) return false;
      const viewport = scroll.getBoundingClientRect();
      return [...scroll.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].some(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom && row.textContent?.includes(`paragraph ${paragraph}:`);
      });
    }, sessionId, paragraph), { timeout: 15_000, interval: 100, timeoutMsg: 'Latest streamed paragraph is not visible' });
    await this.settle();
  }

  async focusMainWindow() {
    await browser.execute(async () => {
      const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args: unknown) => Promise<unknown> } };
      await host.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: 'main' });
    });
    await browser.waitUntil(() => browser.execute(() => document.hasFocus()), { timeout: 10_000, interval: 100,
      timeoutMsg: 'Main WebView did not gain focus; foreground timing is unavailable' });
  }

  async invoke<T = unknown>(command: string, request: unknown): Promise<T> {
    return browser.execute(async (command: string, request: unknown) => {
      const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args: unknown) => Promise<T> } };
      return host.__TAURI_INTERNALS__.invoke(command, { request });
    }, command, request) as Promise<T>;
  }

  sessionSelector(id: string) { return `[data-testid="nav-session-item"][data-session-id="${id}"]`; }

  async arm(options: ProbeOptions) {
    await browser.execute((options: ProbeOptions) => {
      const host = window as ProbeHost;
      host.__longSessionProbe?.dispose();
      const result: Partial<LongSessionProbe> = { times: [], wheelTimes: [],
        visibility: document.visibilityState, focus: document.hasFocus(), visibilityChanged: false, focusChanged: false,
        targetTurnId: options.turnId,
        longTasksSupported: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask'), longTasks: [] };
      const recordTasks = (entries: PerformanceEntry[]) => {
        for (const entry of entries) if (result.actionAt !== undefined && entry.startTime + entry.duration >= result.actionAt) {
          const tasks = result.endAt !== undefined && entry.startTime >= result.endAt ? result.postReady?.longTasks : result.longTasks;
          tasks?.push({ startTime: entry.startTime, durationMs: entry.duration });
        }
      };
      const taskObserver = result.longTasksSupported ? new PerformanceObserver(list => recordTasks(list.getEntries())) : undefined;
      taskObserver?.observe({ type: 'longtask' });
      const scroller = () => document.querySelector<HTMLElement>(options.scrollerSelector ?? `[data-testid="flowchat-container"][data-session-id="${options.sessionId}"] [data-flowchat-scroller]`);
      let rowObserver: MutationObserver | undefined;
      if (options.collectRows) {
        result.rowChurn = { added: {}, removed: {} }; result.rowBatches = []; result.scrollPositions = [];
        rowObserver = new MutationObserver(records => {
          if (result.actionAt === undefined) return;
          const batch = { time: performance.now(), added: 0, removed: 0 };
          for (const record of records) for (const [kind, nodes] of [['added', record.addedNodes], ['removed', record.removedNodes]] as const) {
            for (const node of nodes) {
              if (!(node instanceof Element)) continue;
              const rows = [...(node.matches('.virtual-item-wrapper') ? [node] : []), ...node.querySelectorAll('.virtual-item-wrapper')];
              for (const row of rows) {
                const key = row.getAttribute('data-virtual-item-key');
                if (key) { result.rowChurn![kind][key] = (result.rowChurn![kind][key] ?? 0) + 1; batch[kind]++; }
              }
            }
          }
          if (batch.added || batch.removed) result.rowBatches!.push(batch);
        });
        const root = scroller(); if (root) rowObserver.observe(root, { subtree: true, childList: true });
      }
      result.beforeTop = scroller()?.scrollTop ?? 0;
      let frame = 0, afterReady = 0, cleaned = false;
      let anchor: { key: string; offset: number } | undefined;
      const changed = () => { result.visibilityChanged ||= document.visibilityState !== result.visibility; result.focusChanged ||= document.hasFocus() !== result.focus; };
      const input = (event: Event) => {
        if (!(event.target instanceof Element)) return;
        const match = options.wheelCount ? event.type === 'wheel' && scroller()?.contains(event.target)
          : options.selector && event.target.closest(options.selector);
        if (!match) return;
        if (result.actionAt === undefined) { result.actionAt = performance.now(); result.inputType = event.type; result.beforeTop = scroller()?.scrollTop ?? 0; }
        if (event.type === 'wheel') result.wheelTimes!.push(performance.now());
      };
      const events = ['pointerdown', 'mousedown', 'click', 'wheel'];
      events.forEach(name => document.addEventListener(name, input, true));
      document.addEventListener('visibilitychange', changed);
      window.addEventListener('focus', changed); window.addEventListener('blur', changed);
      const state = { result, done: false, dispose: () => {
        if (cleaned) return; cleaned = true;
        cancelAnimationFrame(frame); clearTimeout(timeout);
        if (taskObserver) { recordTasks(taskObserver.takeRecords()); taskObserver.disconnect(); }
        rowObserver?.disconnect();
        events.forEach(name => document.removeEventListener(name, input, true));
        document.removeEventListener('visibilitychange', changed);
        window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
      } };
      host.__longSessionProbe = state;
      const complete = (timedOut: boolean) => {
        result.endAt ??= performance.now(); result.afterTop ??= scroller()?.scrollTop ?? 0; result.timedOut = timedOut;
        result.latencyMs = result.actionAt === undefined ? null : options.wheelCount
          ? result.firstMovementAt === undefined ? null : result.firstMovementAt - result.actionAt
          : result.readyAt === undefined ? null : result.endAt - result.actionAt;
        changed(); state.done = true; state.dispose();
      };
      const tick = (time: number) => {
        result.times!.push(time);
        if (result.postReady) {
          const scroll = scroller();
          if (anchor && scroll) {
            const row = [...scroll.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].find(row => row.dataset.virtualItemKey === anchor!.key);
            if (!row) result.postReady.missingAnchorFrames++;
            else result.postReady.maxAnchorDriftPx = Math.max(result.postReady.maxAnchorDriftPx,
              Math.abs(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset));
          }
          if (performance.now() - result.endAt! >= options.postReadyMs!) {
            result.postReady.endAt = performance.now(); complete(false); return;
          }
          frame = requestAnimationFrame(tick); return;
        }
        if (result.actionAt !== undefined) {
          const scroll = scroller();
          let usable = false;
          if (options.wheelCount) {
            const top = scroll?.scrollTop;
            if (top !== undefined) result.scrollPositions?.push({ time, top });
            if (top !== undefined && Math.abs(top - result.beforeTop!) > 1) result.firstMovementAt ??= performance.now();
            usable = result.wheelTimes!.length >= options.wheelCount && result.firstMovementAt !== undefined;
          } else if (scroll) {
            const root = scroll.closest('[data-testid="flowchat-container"]')!;
            const placed = root.querySelector('[data-open-viewport-settled="true"]');
            const loading = root.querySelector('.history-session-loading:not([data-history-loading-phase="idle"])');
            const box = scroll.getBoundingClientRect();
            const rows = options.turnId ? scroll.querySelectorAll<HTMLElement>(`.virtual-item-wrapper[data-turn-id="${options.turnId}"]`)
              : scroll.querySelectorAll<HTMLElement>('.virtual-item-wrapper');
            const visibleText = [...rows].some(row => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > box.top && rect.top < box.bottom && (row.textContent?.trim().length ?? 0) > 0;
            });
            if (options.collectMilestones) {
              const elapsed = performance.now() - result.actionAt;
              const milestones = result.milestones ??= {};
              if (rows.length) milestones.targetDomMs ??= elapsed;
              if (visibleText) milestones.targetVisibleMs ??= elapsed;
              if (placed && !loading && visibleText) milestones.viewportReadyMs ??= elapsed;
            }
            usable = !!placed && !loading && box.height > 0 && visibleText;
          }
          if (usable) result.readyAt ??= performance.now();
          else { delete result.readyAt; afterReady = 0; }
          if (result.readyAt !== undefined && ++afterReady >= 3) {
            if (!options.postReadyMs) { complete(false); return; }
            result.endAt = performance.now(); result.afterTop = scroller()?.scrollTop ?? 0;
            result.postReady = { maxAnchorDriftPx: 0, missingAnchorFrames: 0, longTasks: [] };
            const scroll = scroller();
            if (options.checkAnchor && scroll) {
              const top = scroll.getBoundingClientRect().top;
              const row = [...scroll.querySelectorAll<HTMLElement>('.virtual-item-wrapper')].find(row => row.getBoundingClientRect().bottom > top);
              if (row?.dataset.virtualItemKey) anchor = { key: row.dataset.virtualItemKey, offset: row.getBoundingClientRect().top - top };
              else result.postReady.missingAnchorFrames++;
            }
          }
        }
        frame = requestAnimationFrame(tick);
      };
      const timeout = setTimeout(() => complete(true), 30_000);
      frame = requestAnimationFrame(tick);
    }, options);
  }

  async collect(): Promise<LongSessionProbe> {
    await browser.waitUntil(() => browser.execute(() => (window as ProbeHost).__longSessionProbe?.done === true),
      { timeout: 35_000, interval: 50, timeoutMsg: 'Performance probe did not complete' });
    return browser.execute(() => {
      const host = window as ProbeHost, state = host.__longSessionProbe!;
      state.dispose(); delete host.__longSessionProbe; return state.result;
    }) as Promise<LongSessionProbe>;
  }

  async cancelMeasurement() {
    await browser.execute(() => { const host = window as ProbeHost; host.__longSessionProbe?.dispose(); delete host.__longSessionProbe; });
  }

  async snapshot(id: string) {
    return browser.execute((id: string) => {
      const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`)
        ?? document.querySelector(`[data-flowchat-selection-root="${id}"].btw-session-panel__body`);
      const scroll = root?.matches('.btw-session-panel__body') ? root as HTMLElement : root?.querySelector<HTMLElement>('[data-flowchat-scroller]');
      return { sessionId: id, exists: !!root, scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
        clientHeight: scroll?.clientHeight, rows: root?.querySelectorAll('.virtual-item-wrapper').length,
        clientWidth: scroll?.clientWidth, domNodes: root?.querySelectorAll('*').length, documentNodes: document.querySelectorAll('*').length,
        streamingBlocks: root?.querySelectorAll('[data-streaming="true"]').length,
        textChars: root?.textContent?.length ?? 0, visibility: document.visibilityState, focus: document.hasFocus(),
        visibleTurns: [...(scroll?.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-turn-id]') ?? [])].flatMap(row => {
          const box = row.getBoundingClientRect(), viewport = scroll!.getBoundingClientRect();
          return box.bottom > viewport.top && box.top < viewport.bottom ? [row.dataset.turnId] : [];
        }),
        rail: [...document.querySelectorAll<HTMLElement>('[data-testid="flowchat-turn-rail"] button[data-turn-ordinal]')]
          .map(button => ({ ordinal: button.dataset.turnOrdinal, turnId: button.dataset.turnId })) };
    }, id);
  }

  async clickSession(id: string) { await $(this.sessionSelector(id)).click(); }

  async turnLanding(sessionId: string, turnId: string) {
    return browser.execute((sessionId: string, turnId: string) => {
      const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${sessionId}"]`);
      const scroller = root?.querySelector<HTMLElement>('[data-flowchat-scroller]');
      const header = scroller?.querySelector<HTMLElement>(`.user-message-item[data-turn-id="${turnId}"]`);
      if (!scroller || !header) return null;
      const viewport = scroller.getBoundingClientRect(), rect = header.getBoundingClientRect();
      return { topPx: rect.top - viewport.top, bottomPx: rect.bottom - viewport.top,
        visible: rect.bottom > viewport.top && rect.top < viewport.bottom };
    }, sessionId, turnId);
  }

  async prepareSession(id: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await $(this.sessionSelector(id)).isExisting()) return;
      const toggles = await browser.$$('[data-testid="nav-session-list-toggle"], [data-testid="session-nav-show-more"]');
      let expanded = false;
      for (const toggle of toggles) {
        if (await toggle.isDisplayed() && await toggle.getAttribute('data-session-nav-toggle-action') !== 'show-less') {
          await toggle.click(); expanded = true; break;
        }
      }
      if (!expanded) break;
    }
    await $(this.sessionSelector(id)).waitForExist({ timeout: 10_000 });
  }

  async revealTurn(ordinal: number) {
    // Reveal the virtualized rail outside the timed window. Actual navigation uses its production button.
    await browser.execute((ordinal: number) => {
      const rail = document.querySelector('[data-testid="flowchat-turn-rail"]')!;
      const list = rail.querySelector<HTMLElement>('[data-openbitfun-part="list"]')!;
      const first = list.querySelector<HTMLElement>('button[data-turn-ordinal]')!;
      const next = first.parentElement?.nextElementSibling?.querySelector<HTMLElement>('button[data-turn-ordinal]');
      // Track height is the rail's own geometry contract, including its padding.
      const track = list.firstElementChild as HTMLElement;
      const count = Number(rail.getAttribute('data-total-turn-count'));
      const rowHeight = next ? next.offsetTop - first.offsetTop : (track.clientHeight - 6) / count;
      list.scrollTop = Math.max(0, ordinal * rowHeight - list.clientHeight / 2);
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, ordinal);
    const selector = `[data-testid="flowchat-turn-rail"] button[data-turn-ordinal="${ordinal}"]`;
    await $(selector).waitForExist({ timeout: 20_000 });
    return selector;
  }

  async clickTurn(selector: string) { await $(selector).click(); }
}
