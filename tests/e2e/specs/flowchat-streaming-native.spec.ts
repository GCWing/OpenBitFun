import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';

const evidence = process.env.OPENBITFUN_FLOWCHAT_E2E_ROOT!;
const scrollerSelector = '[data-flowchat-scroller]';
const latestSelector = '.scroll-to-latest-bar[data-visible="true"]';
type Frame = { t: number; phase: string; top: number; end: number; height: number; width: number; streaming: boolean; anchor: number | null; collapseTop: number | null; tail: number; rows: number; agents: number; userTop: number | null; line: number; sentUser: boolean; turnCount: number; firstIndex: number; lastIndex: number; paddingBottom: number };
const results: Record<string, unknown> = {};

class StreamingFlowChatPage {
  async openRecordedSession() {
    const id = process.env.OPENBITFUN_FLOWCHAT_SESSION_IDS!.split(',')[0];
    const row = $(`[data-testid="nav-session-item"][data-session-id="${id}"]`);
    await row.waitForExist({ timeout: 30000 }); await row.click();
    await browser.waitUntil(async () => (await $('[data-testid="flowchat-message-list"]').getAttribute('data-open-viewport-settled')) === 'true', { timeout: 30000 });
  }
  async newSession() {
    const create = $('[data-testid="nav-workspace-new-session-btn"]');
    await create.waitForExist({ timeout: 30000 }); await create.click();
    await $('[data-testid="chat-input-textarea"]').waitForDisplayed();
  }
  async startProbe() {
    await browser.execute(() => {
      const probe = { phase: 'send', sentText: '', sentTurnId: '', frames: [] as unknown[], tasks: [] as unknown[], inputs: [] as unknown[], stopped: false, anchor: null as Element | null, collapseKey: '' };
      (window as any).flowchatStreamProbe = probe;
      const input = (event: Event) => {
        probe.inputs.push({ t: performance.now(), phase: probe.phase, type: event.type, trusted: event.isTrusted,
          deltaY: (event as WheelEvent).deltaY, key: (event as KeyboardEvent).key,
          target: (event.target as Element)?.className, tag: (event.target as Element)?.tagName,
          part: (event.target as Element)?.getAttribute?.('data-openbitfun-part') });
      };
      const inputTypes = ['wheel', 'pointerdown', 'pointerup', 'keydown', 'focusin'];
      inputTypes.forEach(type => document.addEventListener(type, input, true));
      const observer = new PerformanceObserver(entries => entries.getEntries().forEach(e => probe.tasks.push({ t: e.startTime, ms: e.duration, phase: probe.phase })));
      observer.observe({ type: 'longtask', buffered: false });
      const frame = () => {
        if (probe.stopped) { observer.disconnect(); inputTypes.forEach(type => document.removeEventListener(type, input, true)); return; }
        const node = document.querySelector<HTMLElement>('[data-flowchat-scroller]');
        if (node) {
          const rows = node.querySelectorAll<HTMLElement>('.virtual-item-wrapper');
          const last = rows[rows.length - 1];
          const users = node.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-item-type="user-message"]');
          const user = users[users.length - 1];
          if (probe.sentText && user?.textContent?.includes(probe.sentText)) probe.sentTurnId = user.dataset.turnId ?? '';
          const box = node.getBoundingClientRect();
          const footer = node.querySelector<HTMLElement>('.message-list-footer')?.offsetHeight ?? 0;
          const items = node.querySelector<HTMLElement>('[data-testid="flowchat-item-list"]');
          const collapseRow = [...rows].find(row => row.dataset.virtualItemKey === probe.collapseKey);
          probe.frames.push({ t: performance.now(), phase: probe.phase, top: node.scrollTop,
            end: Math.max(0, node.scrollHeight - node.clientHeight), height: node.clientHeight, width: node.clientWidth,
            streaming: node.parentElement?.dataset.streamingOutput === 'true',
            anchor: probe.anchor?.isConnected ? probe.anchor.getBoundingClientRect().top : null,
            collapseTop: collapseRow ? collapseRow.getBoundingClientRect().top - box.top : null,
            tail: (last?.getBoundingClientRect().bottom ?? box.top) - box.top, rows: rows.length,
            agents: [...node.querySelectorAll('[data-openbitfun-tool-card="agent-control"]')]
              .filter(card => card.closest<HTMLElement>('.virtual-item-wrapper')?.dataset.turnId === probe.sentTurnId).length,
            userTop: user ? user.getBoundingClientRect().top - box.top : null,
            line: 8 + Math.max(0, node.clientHeight - footer - 8) * 0.618,
            sentUser: !!probe.sentText && !!user?.textContent?.includes(probe.sentText), turnCount: users.length,
            firstIndex: Number(rows[0]?.dataset.virtualIndex ?? -1), lastIndex: Number(last?.dataset.virtualIndex ?? -1),
            paddingBottom: Number.parseFloat(items?.style.paddingBottom ?? '0') });
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }
  async phase(name: string, anchor = false) {
    await browser.execute((phase: string, capture: boolean) => {
      const probe = (window as any).flowchatStreamProbe;
      probe.phase = phase;
      if (capture) {
        const node = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
        const top = node.getBoundingClientRect().top;
        probe.anchor = [...node.querySelectorAll('.markdown-renderer p, .markdown-renderer li, .user-message-item__content')]
          .find(e => { const r = e.getBoundingClientRect(); return r.top > top + 40 && r.top < top + node.clientHeight / 2; }) ?? null;
      }
    }, name, anchor);
  }
  async send(text: string, enter = false) {
    const input = $('[data-testid="chat-input-textarea"]');
    await input.waitForDisplayed();
    await input.setValue(text);
    await browser.execute((value: string) => { (window as any).flowchatStreamProbe.sentText = value; }, text);
    if (enter) await browser.keys('Enter'); else await $('[data-testid="chat-input-send-btn"]').click();
    await browser.waitUntil(async () => (await input.getText()) === '', { timeout: 10000, timeoutMsg: 'Submission must clear the composer' });
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ timeout: 30000 });
  }
  async captureCollapse(selector: string, phase: string) {
    return browser.execute((selector: string, phase: string) => {
      const row = document.querySelector(selector)!.closest<HTMLElement>('.virtual-item-wrapper')!;
      const scroller = document.querySelector('[data-flowchat-scroller]')!;
      const probe = (window as any).flowchatStreamProbe;
      probe.phase = phase; probe.collapseKey = row.dataset.virtualItemKey;
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }, selector, phase);
  }
  async clickVisible(selector: string) {
    // Element.click in the embedded driver first scrolls to center. Use its
    // pointer actions for an already-visible control so the test itself does
    // not insert a viewport movement just before the collapse under test.
    const point = await browser.execute((selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, selector);
    await browser.performActions([{ type: 'pointer', id: 'collapse-reader', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', origin: 'viewport', ...point, duration: 0 },
      { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
    ] }]);
  }
  async wheel(delta: number) {
    const rect = await browser.execute(() => {
      const r = document.querySelector('[data-flowchat-scroller]')!.getBoundingClientRect();
      return { x: Math.round(r.right - 32), y: Math.round(r.top + r.height / 2) };
    });
    // The embedded driver applies each wheel delta atomically. A single 700px
    // event looked like a product jump even with duration set. Use a short
    // sequence of ordinary wheel ticks to exercise a real reader gesture.
    const ticks = Math.max(1, Math.ceil(Math.abs(delta) / 100));
    await browser.performActions([{ type: 'wheel', id: 'flowchat-reader', actions: Array.from({ length: ticks }, () => [
      { type: 'scroll' as const, origin: 'viewport' as const, x: rect.x, y: rect.y, deltaX: 0, deltaY: delta / ticks, duration: 0 },
      { type: 'pause' as const, duration: 24 },
    ]).flat() }]);
  }
  async waitForGrowth(min: number) {
    let ready = false;
    await browser.waitUntil(async () => {
      const state = await browser.execute((growth: number) => {
        const f = (window as any).flowchatStreamProbe.frames as Frame[];
        const last = f.at(-1);
        return {
          ready: !!last && f.length > 2 && last.end - f[0].end > growth && last.streaming,
          finished: !!last && f.some(v => v.streaming)
            && f.filter(v => v.t > last.t - 1000).every(v => !v.streaming),
        };
      }, min);
      ready = state.ready;
      return ready || state.finished;
    }, { timeout: 180000, interval: 200, timeoutMsg: 'Real model output must grow while the turn is running' });
    if (!ready) throw new Error('The real provider finished before producing enough continuing output for this interaction check');
  }
  async stopProbe(name: string) {
    const value = await browser.execute(() => { const probe = (window as any).flowchatStreamProbe; probe.stopped = true; return { frames: probe.frames, tasks: probe.tasks, inputs: probe.inputs }; }) as { frames: Frame[]; tasks: unknown[]; inputs: unknown[] };
    results[name] = value;
    writeFileSync(join(evidence, 'streaming-result.json'), JSON.stringify(results, null, 2));
    return value.frames;
  }
}
const page = new StreamingFlowChatPage();

describe('Desktop FlowChat real streaming', () => {
  before(async () => {
    expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!)).toBe(true);
  });
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    await page.stopProbe(`failure-${this.currentTest.title}`);
    await browser.saveScreenshot(join(evidence, 'streaming-failure.png'));
    writeFileSync(join(evidence, 'streaming-failure.txt'), await browser.execute(() => document.body.innerText));
    const stop = $('[data-testid="chat-input-cancel-btn"]');
    if (await stop.isExisting()) await stop.click();
  });

  it('sends, follows real output, yields to upward scrolling and resumes at latest', async () => {
    await page.newSession();
    await page.startProbe();
    await page.send('Write a substantial practical essay in English about designing and maintaining a garden across the seasons. Explain soil, drainage, compost, planting, pruning, watering, wildlife, climate, and common mistakes in depth, with blank lines between paragraphs. Start the actual prose immediately; use no outline, numbering, or length calculations. Do not call tools or access any files.');
    await page.waitForGrowth(1200);
    await page.phase('following');
    await browser.pause(1800);
    await page.phase('wheel-up'); await page.wheel(-700);
    await browser.pause(400);
    await page.phase('reading', true);
    await browser.pause(2200);
    await page.phase('selecting');
    const selection = await browser.execute(() => {
      const anchor = (window as any).flowchatStreamProbe.anchor as Element | null;
      if (!anchor) throw new Error('No visible real text to select');
      const range = document.createRange(); range.selectNodeContents(anchor);
      const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selected.toString();
    });
    await browser.pause(1200);
    expect(await browser.execute(() => window.getSelection()?.toString())).toBe(selection);
    await browser.execute(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    await $(latestSelector).waitForDisplayed({ timeout: 5000 });
    await page.phase('jump-latest'); await $(`${latestSelector} button`).click();
    await browser.pause(1200);
    await page.phase('resumed'); await browser.pause(1600);
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 180000 });
    await page.phase('completed'); await browser.pause(1000);
    const frames = await page.stopProbe('first-send');
    const reading = frames.filter(f => f.phase === 'reading');
    expect(reading.length).toBeGreaterThan(10);
    expect(reading.some(f => f.streaming)).toBe(true);
    expect(Math.max(...reading.map(f => f.top)) - Math.min(...reading.map(f => f.top))).toBeLessThan(4);
    const anchors = reading.filter(f => f.anchor !== null).map(f => f.anchor!);
    expect(anchors.length).toBeGreaterThan(10);
    expect(Math.max(...anchors) - Math.min(...anchors)).toBeLessThan(4);
    const following = frames.filter(f => f.phase === 'following' || f.phase === 'resumed');
    expect(following.some(f => f.streaming)).toBe(true);
    const backward = following.slice(1).filter((f, i) => f.phase === following[i].phase && f.top < following[i].top - 3);
    expect(backward).toHaveLength(0);
    // Actual rendered output, not provider text buffered ahead of the UI.
    const placed = frames.filter(f => f.phase === 'send' && f.sentUser && f.userTop !== null);
    expect(placed.length).toBeGreaterThan(0);
    expect(Math.abs(placed[0].userTop! - 8)).toBeLessThan(4);
    const waiting = placed.filter(f => f.tail < f.line - 4);
    if (waiting.length > 2) expect(Math.max(...waiting.map(f => f.top)) - Math.min(...waiting.map(f => f.top))).toBeLessThan(4);
    const completed = frames.filter(f => f.phase === 'completed').slice(-20);
    expect(completed.length).toBeGreaterThan(5);
    expect(Math.max(...completed.map(f => Math.abs(f.end - f.top)))).toBeLessThan(4);
    expect(Math.max(...completed.map(f => Math.abs(f.tail - f.line)))).toBeLessThan(5);
    // A real wheel gesture and the button must land on that same physical end.
    const endpoint = completed.at(-1)!.top;
    await page.wheel(1000); await browser.pause(250);
    expect(Math.abs(await browser.execute(() => document.querySelector<HTMLElement>('[data-flowchat-scroller]')!.scrollTop) - endpoint)).toBeLessThan(4);
    await browser.saveScreenshot(join(evidence, 'streaming-completed.png'));
  });

  it('sends from history, resumes on downward travel and keeps the viewport stable on stop', async () => {
    // An independent recorded history avoids depending on a provider's previous
    // response length, completion time, or a failed earlier test's state.
    await page.openRecordedSession();
    await page.startProbe();
    await page.phase('history'); await page.wheel(-1500); await browser.pause(350);
    await page.phase('send-from-history');
    await page.send('Read-only scrolling check; do not continue the earlier task. Do not call tools or modify files. Write a detailed essay about forests in 24 substantial numbered paragraphs, separated by blank lines. Start directly with the essay; no planning, word counting or calculations.', true);
    await page.waitForGrowth(600);
    await page.phase('manual-down'); await page.wheel(-700); await browser.pause(300); await page.wheel(1500);
    await page.phase('bottom-resume');
    // Downward arrival resumes follow without needing another button.
    await browser.waitUntil(() => browser.execute(() => {
      const last = (window as any).flowchatStreamProbe.frames.at(-1) as Frame;
      return last.phase === 'bottom-resume' && last.streaming && Math.abs(last.end - last.top) < 4;
    }), { timeout: 60000, interval: 200 });
    await page.phase('wheel-resumed'); await browser.pause(2000);
    const original = await browser.getWindowRect();
    await page.phase('minimized'); await browser.minimizeWindow(); await browser.pause(600);
    await browser.maximizeWindow(); await browser.setWindowRect(original.x, original.y, original.width, original.height);
    await page.phase('restored'); await browser.pause(1000);
    await page.phase('stop'); await $('[data-testid="chat-input-cancel-btn"]').click();
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 15000 });
    await page.phase('stopped'); await browser.pause(1200);
    const frames = await page.stopProbe('second-send');
    const placed = frames.filter(f => f.phase === 'send-from-history' && f.sentUser && f.userTop !== null);
    expect(placed.length).toBeGreaterThan(0);
    expect(Math.abs(placed[0].userTop! - 8)).toBeLessThan(4);
    const streaming = frames.filter(f => f.streaming);
    expect(streaming.length).toBeGreaterThan(10);
    const resumed = frames.filter(f => f.phase === 'wheel-resumed');
    expect(resumed.at(-1)!.end).toBeGreaterThan(resumed[0].end);
    expect(resumed.at(-1)!.top).toBeGreaterThan(resumed[0].top);
    const stopped = frames.filter(f => f.phase === 'stopped').slice(-20);
    expect(Math.max(...stopped.map(f => f.top)) - Math.min(...stopped.map(f => f.top))).toBeLessThan(4);
    await browser.saveScreenshot(join(evidence, 'streaming-stopped.png'));
  });

  it('keeps an explicitly opened collection stable through real tool completion', async () => {
    await page.newSession();
    await page.startProbe();
    await page.send('Read-only UI interaction check: use file reading tools to inspect the first 30 lines of README.md and CONTRIBUTING.md in this workspace. Do not edit files, run shell commands, or delegate work. Then write 25 numbered short paragraphs explaining what these two documents cover, directly in the reply.');
    const header = $('[data-timeline-kind="group-header"] [data-openbitfun-part="header"][role="button"]');
    await header.waitForExist({ timeout: 120000 });
    // User takes over while the tool group is still present; choose a manual
    // expanded state, even when the running group was already auto-expanded.
    await page.phase('tool-reading'); await page.wheel(-500);
    if ((await header.getAttribute('aria-expanded')) === 'true') await header.click();
    await header.click();
    await browser.pause(400);
    await page.phase('manual-group-open', true);
    await browser.execute(() => {
      (window as any).flowchatStreamProbe.anchor = document.querySelector('[data-timeline-kind="group-header"]');
    });
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 180000 });
    await browser.pause(600);
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await page.phase('tool-completed'); await browser.pause(500);
    const frames = await page.stopProbe('tool-lifecycle');
    const reading = frames.filter(f => f.phase === 'manual-group-open');
    expect(Math.max(...reading.map(f => f.top)) - Math.min(...reading.map(f => f.top))).toBeLessThan(4);
    const anchorTops = reading.slice(2).filter(f => f.anchor !== null).map(f => f.anchor!);
    expect(anchorTops.length).toBeGreaterThan(5);
    expect(Math.max(...anchorTops) - Math.min(...anchorTops)).toBeLessThan(4);
    await browser.saveScreenshot(join(evidence, 'streaming-tools.png'));
  });

  it('keeps the newest output visible while streaming into a real long history', async () => {
    await page.openRecordedSession();
    await page.startProbe();
    await page.send('Read-only scrolling check. Do not call tools, continue the previous task, or modify any files. Reply directly with 35 numbered paragraphs in English about rivers, with two sentences each, separated by blank lines. No word counting or calculations.');
    await page.waitForGrowth(1000);
    await page.phase('long-history-follow');
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 180000 });
    await browser.pause(800);
    const frames = await page.stopProbe('long-history');
    const placed = frames.filter(f => f.phase === 'send' && f.sentUser && f.userTop !== null);
    expect(placed.length).toBeGreaterThan(0);
    expect(Math.abs(placed[0].userTop! - 8)).toBeLessThan(4);
    const follow = frames.filter(f => f.phase === 'long-history-follow');
    expect(follow.length).toBeGreaterThan(10);
    // Sample actual DOM and range, not only whether follow's boolean stayed on.
    // Two paints may carry a pending layout; a missing tail must never persist.
    let absentSince: number | null = null;
    let longestAbsence = 0;
    for (const frame of follow) {
      const absent = frame.paddingBottom > 1 || frame.tail > frame.height || frame.rows === 0;
      if (!absent) absentSince = null;
      else {
        absentSince ??= frame.t;
        longestAbsence = Math.max(longestAbsence, frame.t - absentSince);
      }
    }
    expect(longestAbsence).toBeLessThan(100);
    expect(Math.abs(follow.at(-1)!.end - follow.at(-1)!.top)).toBeLessThan(4);
    await browser.saveScreenshot(join(evidence, 'streaming-long-history.png'));
  });

  it('keeps following after a real AskUser answer through subagent launch and continuing output', async () => {
    await page.openRecordedSession();
    await page.startProbe();
    await page.send('Read-only UI interaction check. Do not continue the previous task. First use AskUserQuestion to ask one short question "Which garden?" with two short options "Quiet" and "Bright", without descriptions. After my answer, launch one subagent solely to read README.md and summarize it briefly; it must not edit files. Then write a substantial practical English essay about designing a garden in that style, covering soil, drainage, planting, pruning, watering, wildlife and seasonal care in depth. Start the prose directly, with blank lines between paragraphs and no numbering or length calculations. Do not use other tools or modify files.');
    const askSelector = '[data-flowchat-scroller] [data-openbitfun-component="ask-user"][data-openbitfun-state="asking"]';
    await $(askSelector).waitForExist({ timeout: 120000 });
    await browser.pause(600);
    await page.phase('answering-live-question');
    await page.clickVisible(`${askSelector} [data-openbitfun-part="option"][data-custom="true"] input`);
    await browser.waitUntil(async () => browser.execute(() => !!document.activeElement?.closest('[data-openbitfun-part="custom-input"]')), { timeout: 5000 });
    await browser.keys('Quiet');
    await browser.keys('Tab');
    expect(await browser.execute(() => !!document.activeElement?.closest('[data-openbitfun-part="submit"]'))).toBe(true);
    // The embedded driver dispatches Space but does not synthesize a native
    // button's default click. Exercise key ownership, then activate the visible
    // button through pointer actions. Neither may repair lost follow intent.
    await browser.keys(' ');
    await page.clickVisible(`${askSelector} [data-openbitfun-part="submit"] button`);
    await $('[data-flowchat-scroller] [data-openbitfun-component="ask-user"] [data-openbitfun-part="answers"]').waitForExist({ timeout: 30000 });
    await page.phase('answer-follow');
    await page.waitForGrowth(1200);
    await page.phase('answer-continued-output');
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 180000 });
    await browser.pause(1000);
    const frames = await page.stopProbe('answer-continued-output');
    const answering = frames.filter(f => f.phase === 'answering-live-question');
    expect(answering.length).toBeGreaterThan(0);
    const continued = frames.filter(f => f.phase === 'answer-continued-output');
    expect(continued.length).toBeGreaterThan(10);
    expect(continued.some(f => f.streaming)).toBe(true);
    expect(frames.some(f => (f.phase === 'answer-follow' || f.phase === 'answer-continued-output') && f.agents > 0)).toBe(true);
    expect(continued.at(-1)!.top - answering[0].top).toBeGreaterThan(600);
    let absentSince: number | null = null;
    let longestAbsence = 0;
    for (const frame of continued) {
      if (frame.paddingBottom <= 1 && frame.tail <= frame.height && frame.rows > 0) absentSince = null;
      else {
        absentSince ??= frame.t;
        longestAbsence = Math.max(longestAbsence, frame.t - absentSince);
      }
    }
    expect(longestAbsence).toBeLessThan(100);
    expect(continued.slice(1).filter((f, i) => f.top < continued[i].top - 3)).toHaveLength(0);
    const settled = continued.slice(-20);
    expect(Math.max(...settled.map(f => Math.abs(f.end - f.top)))).toBeLessThan(4);
    expect(Math.max(...settled.map(f => Math.abs(f.tail - f.line)))).toBeLessThan(5);
    await browser.saveScreenshot(join(evidence, 'answer-continued-output.png'));
  });

  it('keeps top priority after answering a tall real AskUser in recorded history', async () => {
    await page.openRecordedSession();
    await page.startProbe();
    await page.send('UI check only: use AskUserQuestion to ask "Which landscape?" with four options, each described in two detailed sentences. No other tools or actions. After my answer reply only "Noted."');
    const ask = $('[data-openbitfun-component="ask-user"][data-openbitfun-part="root"][data-openbitfun-state="asking"]');
    await ask.waitForExist({ timeout: 120000 });
    await browser.pause(600);
    await page.phase('ask-tall'); await browser.pause(400);
    const expanded = await browser.execute(() => (window as any).flowchatStreamProbe.frames.at(-1)) as Frame;
    expect(expanded.tail - (expanded.userTop ?? 8)).toBeGreaterThan(expanded.line);
    await page.clickVisible('[data-openbitfun-component="ask-user"][data-openbitfun-state="asking"] [data-openbitfun-part="option"] input');
    const beforeCollapse = await page.captureCollapse('[data-openbitfun-component="ask-user"][data-openbitfun-state="asking"]', 'ask-answer');
    const submitSelector = '[data-openbitfun-component="ask-user"][data-openbitfun-state="asking"] [data-openbitfun-part="submit"] button';
    await page.clickVisible(submitSelector);
    await $('[data-openbitfun-component="ask-user"] [data-openbitfun-part="answers"]').waitForExist({ timeout: 30000 });
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 120000 });
    await browser.pause(800);
    await page.phase('ask-compact'); await browser.pause(800);
    // Physical bottom is also top-first once the current Turn is short again.
    await page.phase('ask-bottom'); await page.wheel(600); await browser.pause(400);
    const frames = await page.stopProbe('ask-collapse');
    const compact = frames.filter(f => f.phase === 'ask-compact');
    const bottom = frames.filter(f => f.phase === 'ask-bottom');
    const closing = frames.filter(f => f.phase === 'ask-answer' && f.collapseTop !== null);
    expect(closing.length).toBeGreaterThan(2);
    // A visible leading header stays put. An interior that disappears may
    // recover to 8px, never to the middle/reading line.
    expect(Math.max(...closing.map(f => f.collapseTop!))).toBeLessThan(Math.max(8, beforeCollapse) + 4);
    expect(compact.length).toBeGreaterThan(10);
    expect(new Set(compact.map(f => f.width)).size).toBe(1);
    expect(compact.every(f => f.collapseTop !== null)).toBe(true);
    const settledTop = compact[0].collapseTop!;
    expect(Math.max(...compact.map(f => Math.abs(f.collapseTop! - settledTop)))).toBeLessThan(4);
    // A partially visible compact row stays where it was. Recovery to 8px is
    // only needed when the interior the reader saw has disappeared entirely.
    expect(Math.min(Math.abs(settledTop - beforeCollapse), Math.abs(settledTop - 8))).toBeLessThan(4);
    expect(compact.at(-1)!.tail).toBeLessThan(compact.at(-1)!.line - 8);
    expect(Math.max(...compact.map(f => f.top)) - Math.min(...compact.map(f => f.top))).toBeLessThan(4);
    expect(Math.abs(bottom.at(-1)!.end - bottom.at(-1)!.top)).toBeLessThan(4);
    expect(bottom.at(-1)!.tail).toBeGreaterThan(8);
    expect(bottom.at(-1)!.tail).toBeLessThan(bottom.at(-1)!.line);
    await browser.saveScreenshot(join(evidence, 'ask-collapse-top.png'));
  });

  it('keeps top priority after repeatedly folding a real collection', async () => {
    await page.newSession();
    await page.startProbe();
    await page.send('Read-only UI check: call Read ten times on README.md, separately at offsets 1, 6, 11, 16, 21, 26, 31, 36, 41, 46, limit 5 each. No other tools, shell, edits or delegation. After all calls reply only "Done."');
    const header = $('[data-timeline-kind="group-header"] [data-openbitfun-part="header"][role="button"]');
    const headerSelector = '[data-timeline-kind="group-header"] [data-openbitfun-part="header"][role="button"]';
    const leadingOffsets: number[] = [];
    await header.waitForExist({ timeout: 120000 });
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 120000 });
    await browser.pause(800);
    for (let pass = 0; pass < 2; pass++) {
      await page.phase(`group-expand-${pass}`);
      if (await header.getAttribute('aria-expanded') !== 'true') await page.clickVisible(headerSelector);
      await browser.pause(600);
      const expanded = await browser.execute(() => (window as any).flowchatStreamProbe.frames.at(-1)) as Frame;
      expect(expanded.tail - (expanded.userTop ?? 8)).toBeGreaterThan(expanded.line);
      if (pass === 0) { await page.wheel(60); await browser.pause(300); }
      const before = await page.captureCollapse(headerSelector, `group-fold-${pass}`);
      expect(before).toBeGreaterThanOrEqual(8);
      leadingOffsets.push(before);
      await page.clickVisible(headerSelector);
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await browser.pause(600);
      await page.phase(`group-compact-${pass}`); await browser.pause(500);
    }
    const frames = await page.stopProbe('collection-collapse');
    const compact = frames.filter(f => f.phase.startsWith('group-compact-'));
    expect(compact.length).toBeGreaterThan(10);
    for (let pass = 0; pass < 2; pass++) {
      const closing = frames.filter(f => f.phase === `group-fold-${pass}` || f.phase === `group-compact-${pass}`);
      expect(closing.every(f => f.collapseTop !== null)).toBe(true);
      expect(Math.max(...closing.map(f => Math.abs(f.collapseTop! - leadingOffsets[pass])))).toBeLessThan(4);
    }
    expect(compact.at(-1)!.tail).toBeLessThan(compact.at(-1)!.line - 8);
    await browser.saveScreenshot(join(evidence, 'collection-collapse-top.png'));
  });
});
