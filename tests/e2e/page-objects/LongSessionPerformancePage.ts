import { $, browser } from '@wdio/globals';
import { FlowChatScrollPage } from './FlowChatScrollPage';

export interface LongSessionProbe {
  times: number[]; actionAt: number; endAt: number; latencyMs: number | null;
  readyAt?: number; firstMovementAt?: number; inputType?: string; wheelTimes: number[];
  beforeTop: number; afterTop: number; visibility: string; focus: boolean;
  visibilityChanged: boolean; focusChanged: boolean; timedOut: boolean;
  longTasksSupported: boolean; longTasks: Array<{ startTime: number; durationMs: number }>;
  targetTurnId?: string;
}
interface ProbeOptions { sessionId: string; turnId?: string; selector?: string; wheelCount?: number; }
type ProbeHost = Window & { __longSessionProbe?: {
  result: Partial<LongSessionProbe>; done: boolean; dispose: () => void;
} };

/** Measures the production transcript; no Vite imports or product store mutations. */
export class LongSessionPerformancePage extends FlowChatScrollPage {
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
          result.longTasks!.push({ startTime: entry.startTime, durationMs: entry.duration });
        }
      };
      const taskObserver = result.longTasksSupported ? new PerformanceObserver(list => recordTasks(list.getEntries())) : undefined;
      taskObserver?.observe({ type: 'longtask' });
      const scroller = () => document.querySelector<HTMLElement>(`[data-testid="flowchat-container"][data-session-id="${options.sessionId}"] [data-flowchat-scroller]`);
      result.beforeTop = scroller()?.scrollTop ?? 0;
      let frame = 0, afterReady = 0, cleaned = false;
      const changed = () => { result.visibilityChanged ||= document.visibilityState !== result.visibility; result.focusChanged ||= document.hasFocus() !== result.focus; };
      const input = (event: Event) => {
        if (!(event.target instanceof Element)) return;
        const match = options.wheelCount ? event.type === 'wheel' && event.target.closest('[data-flowchat-scroller]')
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
        events.forEach(name => document.removeEventListener(name, input, true));
        document.removeEventListener('visibilitychange', changed);
        window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
      } };
      host.__longSessionProbe = state;
      const complete = (timedOut: boolean) => {
        result.endAt = performance.now(); result.afterTop = scroller()?.scrollTop ?? 0; result.timedOut = timedOut;
        result.latencyMs = result.actionAt === undefined ? null : options.wheelCount
          ? result.firstMovementAt === undefined ? null : result.firstMovementAt - result.actionAt
          : result.readyAt === undefined ? null : result.endAt - result.actionAt;
        changed(); state.done = true; state.dispose();
      };
      const tick = (time: number) => {
        result.times!.push(time);
        if (result.actionAt !== undefined) {
          const scroll = scroller();
          let usable = false;
          if (options.wheelCount) {
            if (scroll && Math.abs(scroll.scrollTop - result.beforeTop!) > 1) result.firstMovementAt ??= performance.now();
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
            usable = !!placed && !loading && box.height > 0 && visibleText;
          }
          if (usable) result.readyAt ??= performance.now();
          else { delete result.readyAt; afterReady = 0; }
          if (result.readyAt !== undefined && ++afterReady >= 3) { complete(false); return; }
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
      const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
      const scroll = root?.querySelector<HTMLElement>('[data-flowchat-scroller]');
      return { sessionId: id, exists: !!root, scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight,
        clientHeight: scroll?.clientHeight, rows: root?.querySelectorAll('.virtual-item-wrapper').length,
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
