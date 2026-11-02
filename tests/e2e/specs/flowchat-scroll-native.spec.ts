import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { FlowChatScrollPage, type ScrollProbe } from '../page-objects/FlowChatScrollPage';

const page = new FlowChatScrollPage();
const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const results: Record<string, unknown> = {};
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
    rectReads: probe.rectReads, scans: probe.scans, wheelEvents: probe.wheelEvents,
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
    for (const [label, delta] of [['paging-up', -85], ['reading-down', 65], ['reading-up', -65], ['fast-up', -420], ['fast-down', 280]] as const) {
      await page.startProbe(Math.sign(delta));
      await page.wheel(delta);
      await page.settle();
      const probe = await page.stopProbe();
      const summary = summarize(probe);
      results[label] = summary;
      writeFileSync(join(evidence, `${label}.json`), JSON.stringify(probe));
      console.log(label, summary);
      expect(summary.wheelEvents).toBe(72);
      expect(summary.frames).toBeGreaterThan(20);
      expect(summary.maxRows).toBeLessThan(90);
      expect(summary.reverseFrames).toBe(0);
      expect(summary.blankFrames).toBe(0);
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
  });
});
