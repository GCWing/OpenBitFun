import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { FlowChatScrollPage, type ScrollProbe } from '../page-objects/FlowChatScrollPage';
import { captureFlowChatMemory } from '../helpers/flowchat-memory';

const page = new FlowChatScrollPage();
const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const visual = process.env.OPENBITFUN_SCROLL_VISUAL === '1';
const results: Record<string, unknown> = { fixture: {
  turns: Number(process.env.OPENBITFUN_SCROLL_TURNS || 300),
  scenario: process.env.OPENBITFUN_SCROLL_SCENARIO || 'mixed-visible',
  assistantChars: Number(process.env.OPENBITFUN_SCROLL_ASSISTANT_CHARS || 4000),
  toolItems: Number(process.env.OPENBITFUN_SCROLL_TOOL_ITEMS || 3),
  richMarkdown: process.env.OPENBITFUN_SCROLL_RICH_MARKDOWN === '1',
  timingComparable: !visual && process.env.OPENBITFUN_SCROLL_DIAGNOSTICS !== '1',
} };
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
function summarize(probe: ScrollProbe) {
  const intervals = probe.frames.slice(1).map((frame, index) => frame.time - probe.frames[index].time);
  const median = percentile(intervals, 0.5);
  return {
    frames: probe.frames.length, frameP50Ms: median, frameP95Ms: percentile(intervals, 0.95), maxFrameMs: Math.max(0, ...intervals),
    delayedFrames: intervals.filter(value => value > Math.max(25, median * 1.5)).length,
    reverseFrames: probe.frames.filter(frame => frame.reverse > 4).length,
    maxReversePx: Math.max(0, ...probe.frames.map(frame => frame.reverse)),
    blankFrames: probe.frames.filter(frame => frame.blank).length,
    partialBlankFrames: probe.frames.filter(frame => frame.uncoveredPx > 4).length,
    maxUncoveredPx: Math.max(0, ...probe.frames.map(frame => frame.uncoveredPx)),
    rectReads: probe.rectReads, scans: probe.scans, wheelEvents: probe.wheelEvents, wheelDelta: probe.wheelDelta,
    maxRows: Math.max(0, ...probe.frames.map(frame => frame.rows)),
  };
}

describe('FlowChat historical scrolling in the packaged desktop', () => {
  before(async () => { expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!, { requireWorkspaceLabel: false })).toBe(true); });
  after(() => { writeFileSync(join(evidence, 'result.json'), JSON.stringify(results, null, 2)); });
  afterEach(async function () {
    await page.disposeProbe();
    await browser.saveScreenshot(join(evidence, `${this.currentTest?.state === 'failed' ? 'fail' : 'pass'}-${this.currentTest?.title.replace(/[^a-z0-9]+/gi, '-')}.png`));
  });

  it('keeps history scrolling continuous and preserves reading position, drafts and search', async () => {
    await page.openSession('scroll-history-000');
    await page.settle();
    results.opened = await page.anchor();
    results.memoryOpened = await captureFlowChatMemory();
    for (const [label, delta] of [['paging-up', -85], ['reading-down', 65], ['reading-up', -65], ['fast-up', -420], ['fast-down', 280], ['fling-up', -1200], ['fling-down', 1200]] as const) {
      await page.startProbe(Math.sign(delta));
      await Promise.all([page.wheel(delta), ...(visual ? [page.captureScrolling(evidence, label)] : [])]);
      await page.settle();
      const probe = await page.stopProbe();
      const summary = summarize(probe);
      results[label] = summary;
      writeFileSync(join(evidence, `${label}.json`), JSON.stringify(probe));
      console.log(label, summary);
      // Chromium coalesces native wheel events while the renderer is busy.
      expect(summary.wheelEvents).toBeGreaterThan(36);
      expect(Math.sign(summary.wheelDelta)).toBe(Math.sign(delta));
      expect(Math.abs(probe.frames.at(-1)!.top - probe.frames[0].top)).toBeGreaterThan(1000);
      expect(summary.frames).toBeGreaterThan(20);
      expect(summary.maxRows).toBeLessThan(90);
      expect(summary.reverseFrames).toBe(0);
      expect(summary.blankFrames).toBe(0);
      expect(summary.partialBlankFrames).toBe(0);
      if (process.env.OPENBITFUN_SCROLL_PERF === '1' && !visual) {
        expect(summary.frameP95Ms).toBeLessThan(35);
        expect(summary.maxFrameMs).toBeLessThan(50);
      }
    }
    const stopped = await page.anchor();
    await page.settle();
    const stable = await page.anchor();
    results.stopped = { stopped, stable };
    expect(stable.key).toBe(stopped.key);
    expect(Math.abs(stable.offset - stopped.offset)).toBeLessThan(2);
    await page.enterDraft('Scroll continuity draft');
    const before = await page.anchor();
    await page.openSession('scroll-history-001');
    await page.openSession('scroll-history-000');
    await page.settle();
    const restored = await page.anchor();
    results.restoration = { before, restored };
    expect(restored.key).toBe(before.key);
    expect(Math.abs(restored.offset - before.offset)).toBeLessThan(8);
    expect(await page.draftText()).toContain('Scroll continuity draft');
    await page.findFirstResult('fixture');
    await page.closeSearch();
    const located = await page.anchor();
    await page.wheel(60, 8);
    await page.settle();
    const released = await page.anchor();
    expect(released.key !== located.key || Math.abs(released.offset - located.offset) > 20).toBe(true);
    await page.settle();
    const stableAfterSearch = await page.anchor();
    expect(stableAfterSearch.key).toBe(released.key);
    expect(Math.abs(stableAfterSearch.offset - released.offset)).toBeLessThan(2);
    results.interactions = { draftPreserved: true, searchLocated: true, readerTakeoverStable: true };
    results.memoryAfterScrolling = await captureFlowChatMemory();
  });

  it('keeps expanded shell output and file diffs stable while recycling tool rows', async function () {
    if (process.env.OPENBITFUN_SCROLL_SCENARIO !== 'tool-heavy') return this.skip();
    await page.openSession('scroll-history-000');
    // Locate the first Turn through the product's search and then open the
    // adjacent file revision with real disclosure controls, never store mutation.
    await page.findFirstResult('fixture');
    await page.closeSearch();
    await page.settle();
    await page.wheel(100, 8);
    const expanded = await page.expandToolCards();
    results.expandedTools = expanded;
    expect(new Set(expanded.map(card => card.name)).size).toBe(2);
    await page.releaseToolFocus();
    await page.settle();
    for (const [label, delta] of [['expanded-down', 420], ['expanded-up', -420]] as const) {
      await page.startProbe(Math.sign(delta));
      await Promise.all([page.wheel(delta, 24, true), ...(visual ? [page.captureScrolling(evidence, label)] : [])]);
      await page.settle();
      const probe = await page.stopProbe();
      const summary = summarize(probe);
      results[label] = summary;
      writeFileSync(join(evidence, `${label}.json`), JSON.stringify(probe));
      expect(summary.wheelEvents).toBeGreaterThan(12);
      expect(summary.frames).toBeGreaterThan(20);
      expect(summary.blankFrames).toBe(0);
      expect(summary.partialBlankFrames).toBe(0);
      expect(summary.reverseFrames).toBe(0);
      expect(Math.abs(probe.frames.at(-1)!.top - probe.frames[0].top)).toBeGreaterThan(1000);
      if (process.env.OPENBITFUN_SCROLL_PERF === '1' && !visual) {
        expect(summary.frameP95Ms).toBeLessThan(35);
        expect(summary.maxFrameMs).toBeLessThan(50);
      }
      if (label === 'expanded-down') {
        const mountedExpanded = await page.expandedTools();
        results.toolsAfterRecycling = mountedExpanded;
        expect(mountedExpanded.some(card => expanded.some(original => original.id === card.id))).toBe(false);
      }
    }
    const restored = await page.expandedTools();
    for (const original of expanded) expect(restored).toContainEqual(original);
  });

  it('keeps mounted content bounded across repeated scroll and session cycles', async function () {
    const cycles = Number(process.env.OPENBITFUN_SCROLL_MEMORY_CYCLES || 0);
    if (!cycles) return this.skip();
    this.timeout(30_000 + cycles * 5_000);
    const samples: Array<{
      cycle: number;
      travel: number;
      short: Awaited<ReturnType<typeof captureFlowChatMemory>>;
      long: Awaited<ReturnType<typeof captureFlowChatMemory>>;
    }> = [];
    results.memoryCycles = samples;
    for (let cycle = 0; cycle < cycles; cycle++) {
      await page.openSession('scroll-history-000');
      const before = await page.anchor();
      await page.wheel(420, 36, true);
      const travel = (await page.anchor()).top - before.top;
      expect(travel).toBeGreaterThan(1000);
      await page.wheel(-420, 36, true);
      await page.openSession('scroll-history-001');
      await page.settle();
      const short = await captureFlowChatMemory();
      await page.openSession('scroll-history-000');
      await page.settle();
      const long = await captureFlowChatMemory();
      samples.push({ cycle, travel, short, long });
      expect(short.renderer.mountedRows).toBeLessThan(40);
      expect(long.renderer.mountedRows).toBeLessThan(90);
    }
  });
});
