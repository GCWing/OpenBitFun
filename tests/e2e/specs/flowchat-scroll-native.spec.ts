import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { FlowChatScrollPage, type ScrollProbe } from '../page-objects/FlowChatScrollPage';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics';

const page = new FlowChatScrollPage();
const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const results: Record<string, unknown> = {
  frontend: JSON.parse(readFileSync(join(evidence, 'frontend/frontend-revision.json'), 'utf8')),
  scenario: process.env.OPENBITFUN_SCROLL_SCENARIO || 'mixed-visible',
  environment: { platform: process.platform, arch: process.arch },
  fixture: { turns: Number(process.env.OPENBITFUN_SCROLL_TURNS || 80),
    denseGroups: Number(process.env.OPENBITFUN_SCROLL_DENSE_GROUPS || 160),
    textChars: Number(process.env.OPENBITFUN_SCROLL_TEXT_CHARS || 4000),
    fastDelta: Number(process.env.OPENBITFUN_SCROLL_FAST_DELTA || 420),
    cycles: Number(process.env.OPENBITFUN_SCROLL_CYCLES || 4),
    maxFrameBudgetMs: Number(process.env.OPENBITFUN_SCROLL_FRAME_BUDGET_MS || 100) },
};
let processCandidates: Set<number> | undefined;
async function memorySnapshot() {
  const renderer = await page.memory();
  if (process.platform !== 'darwin') return { renderer };
  const baseline = new Set<number>(JSON.parse(readFileSync(join(evidence, 'process-baseline.json'), 'utf8')));
  const sample = spawnSync('ps', ['-axo', 'pid=,rss=,comm='], { windowsHide: true, encoding: 'utf8' });
  if (sample.status !== 0) throw new Error('Cannot sample isolated process memory');
  const processes = sample.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || baseline.has(Number(match[1])) || (processCandidates && !processCandidates.has(Number(match[1])))) return [];
    const command = match[3];
    const role = command === process.env.OPENBITFUN_E2E_APP_PATH ? 'host'
      : command.endsWith('/com.apple.WebKit.WebContent') ? 'new-webkit-content' : null;
    return role ? [{ pid: Number(match[1]), role, rssMiB: Number(match[2]) / 1024 }] : [];
  });
  processCandidates ??= new Set(processes.map(process => process.pid));
  // WebKit XPC processes have launchd parents: report newly created candidates
  // separately, never attribute other running apps' renderers to this fixture.
  return { renderer, processes };
}
function summarize(probe: ScrollProbe) {
  const intervals = probe.frames.slice(1).map((frame, index) => frame.time - probe.frames[index].time);
  const distributions = probeFrameDistributions(probe);
  const median = distributions.phase.p50Ms;
  return {
    distributions,
    frames: probe.frames.length, frameP50Ms: median, frameP95Ms: distributions.phase.p95Ms, maxFrameMs: distributions.phase.maxMs,
    delayedFrames: intervals.filter(value => value > Math.max(25, median * 1.5)).length,
    reverseFrames: probe.frames.filter(frame => frame.reverse > 4).length,
    maxReversePx: Math.max(0, ...probe.frames.map(frame => frame.reverse)),
    blankFrames: probe.frames.filter(frame => frame.blank).length,
    partialBlankFrames: probe.frames.filter(frame => frame.uncoveredPx > 48).length,
    maxUncoveredPx: Math.max(0, ...probe.frames.map(frame => frame.uncoveredPx)),
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
    const openStart = Date.now();
    await page.openSession('scroll-history-000');
    results.openMs = Date.now() - openStart;
    await page.settle();
    results.opened = await page.anchor();
    results.memoryOpened = await memorySnapshot();
    const phases: ReturnType<typeof summarize>[] = [];
    const fastDelta = Number(process.env.OPENBITFUN_SCROLL_FAST_DELTA || 420);
    for (const [label, delta] of [['paging-up', -85], ['reading-down', 65], ['reading-up', -65], ['fast-up', -fastDelta], ['fast-down', fastDelta]] as const) {
      await page.startProbe(Math.sign(delta));
      await page.wheel(delta);
      await page.settle();
      const probe = await page.stopProbe();
      const summary = summarize(probe);
      results[label] = summary;
      writeFileSync(join(evidence, `${label}.json`), JSON.stringify(probe));
      console.log(label, summary);
      phases.push(summary);
    }
    results.memoryScrolled = await memorySnapshot();
    for (const summary of phases) {
      expect(summary.wheelEvents).toBe(72);
      expect(summary.frames).toBeGreaterThan(20);
      expect(summary.maxRows).toBeLessThan(90);
      expect(summary.reverseFrames).toBe(0);
      expect(summary.blankFrames).toBe(0);
      expect(summary.partialBlankFrames).toBe(0);
      expect(summary.frameP95Ms).toBeLessThan(34);
      expect(summary.maxFrameMs).toBeLessThan(Number(process.env.OPENBITFUN_SCROLL_FRAME_BUDGET_MS || 100));
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
    await page.findFirstResult(process.env.OPENBITFUN_SCROLL_SCENARIO === 'rich-text' ? 'narrative'
      : process.env.OPENBITFUN_SCROLL_SCENARIO === 'code-block' ? 'source stays selectable' : 'fixture');
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

  (process.env.OPENBITFUN_SCROLL_SCENARIO === 'tool-heavy' ? it : it.skip)('keeps expanded shell and edit cards across viewport recycling', async () => {
    await page.openSession('scroll-history-000');
    const opened = [];
    for (const name of ['ExecCommand', 'Edit']) {
      let target = await page.visibleTool(name);
      for (let step = 0; !target && step < 180; step++) {
        const group = await page.visibleCollapsedGroup();
        if (group) { await page.clickPoint(group); await page.settle(); }
        else await page.wheel(-160, 1);
        target = await page.visibleTool(name);
      }
      expect(target).not.toBeNull();
      await page.clickPoint(target!);
      const selector = `.flow-tool-card-wrapper[data-tool-card-id="${target!.id}"] [data-openbitfun-part="surface"]`;
      await browser.waitUntil(async () => (await $(selector).getAttribute('data-openbitfun-state'))?.split(' ').includes('expanded') === true);
      await page.settle();
      let travel = 0;
      do { await page.wheel(-240, 4); travel += 4; } while (await $(selector).isExisting() && travel < 80);
      expect(await $(selector).isExisting()).toBe(false);
      await page.wheel(240, travel);
      await page.settle();
      expect((await $(selector).getAttribute('data-openbitfun-state'))?.split(' ')).toContain('expanded');
      opened.push({ name, id: target!.id, memory: await page.memory() });
    }
    results.expandedTools = opened;
  });

  it('releases transcript DOM across repeated reading and session switches', async () => {
    if (process.env.OPENBITFUN_SCROLL_MEMORY_IN_PAGE === '1') {
      await page.openSession('scroll-history-000');
      await page.settle();
      await browser.setTimeout({ script: 600000 });
      const processSamples: Array<{ at: number; sample: string }> = [];
      const timer = setInterval(() => {
        const sample = spawnSync('ps', ['-axo', 'pid=,rss=,comm='], { windowsHide: true, encoding: 'utf8' });
        processSamples.push({ at: Date.now(), sample: sample.stdout });
      }, 3000);
      try {
        // One native eval for the whole experiment. The ordinary driver embeds
        // its helper plus changing element ids in each eval; that source churn
        // is separate from product residency. This is lifecycle/heap evidence,
        // not trusted-wheel timing or visual/gesture acceptance.
        results.inPageResidency = await browser.executeAsync((cycles: number, idleMs: number, animationDiagnostics: boolean, done: (value: unknown) => void) => {
          void (async () => {
            const roots: Array<WeakRef<Element>> = [];
            const samples: unknown[] = [];
            const animate = Element.prototype.animate;
            const animations: Array<{ animation: WeakRef<Animation>; target: string }> = [];
            if (animationDiagnostics) Element.prototype.animate = function (...args) {
              const animation = animate.apply(this, args);
              animations.push({ animation: new WeakRef(animation), target: this.className });
              return animation;
            };
            const frames = (count: number) => new Promise<void>(resolve => {
              const tick = () => --count ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick);
            });
            const sample = () => {
              const root = document.querySelector('[data-testid="flowchat-message-list"]')!;
              if (root !== roots.at(-1)?.deref()) roots.push(new WeakRef(root));
              const state = window as unknown as { __openbitfunWdElements?: Record<string, Node>; __OPENBITFUN_RESOURCE_BUDGET__?: { snapshot: () => Array<{ bytes: number }> } };
              for (const [id, node] of Object.entries(state.__openbitfunWdElements ?? {})) if (!node.isConnected) delete state.__openbitfunWdElements![id];
              const budget = state.__OPENBITFUN_RESOURCE_BUDGET__?.snapshot();
              const animationResidency = animationDiagnostics ? animations.reduce((counts, ref) => {
                const animation = ref.animation.deref();
                if (animation) {
                  const key = `${ref.target}:${animation.playState}:${(animation.effect as KeyframeEffect | null)?.target?.isConnected}`;
                  counts[key] = (counts[key] ?? 0) + 1;
                }
                return counts;
              }, {} as Record<string, number>) : undefined;
              return { at: Date.now(), domNodes: document.querySelectorAll('*').length,
                rows: document.querySelectorAll('.virtual-item-wrapper').length,
                detachedRootsAlive: roots.filter(ref => { const node = ref.deref(); return node && !node.isConnected; }).length,
                budgetBytes: budget?.reduce((sum, item) => sum + item.bytes, 0),
                animationResidency, animationCreated: animationDiagnostics ? animations.length : undefined };
            };
            try {
              for (let cycle = 0; cycle < cycles; cycle++) {
                document.querySelector<HTMLElement>('[data-testid="nav-session-item"][data-session-id="scroll-history-000"]')!.click();
                await frames(28);
                for (const delta of [-280, -280, -280, 280, 280, 280]) {
                  const scroller = document.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
                  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true }));
                  scroller.scrollBy({ top: delta, behavior: 'instant' });
                  await frames(2);
                }
                const long = sample();
                document.querySelector<HTMLElement>('[data-testid="nav-session-item"][data-session-id="scroll-history-001"]')!.click();
                await frames(28);
                samples.push({ cycle, long, short: sample() });
              }
              await new Promise(resolve => setTimeout(resolve, idleMs));
              done({ samples, afterIdle: sample(), observedRoots: roots.length });
            } finally { if (animationDiagnostics) Element.prototype.animate = animate; }
          })().catch(error => done({ error: String(error) }));
        }, Number(process.env.OPENBITFUN_SCROLL_CYCLES || 128), Number(process.env.OPENBITFUN_SCROLL_IDLE_MS || 30000),
        process.env.OPENBITFUN_SCROLL_ANIMATION_DIAGNOSTICS === '1');
      } finally { clearInterval(timer); }
      const baseline = new Set<number>(JSON.parse(readFileSync(join(evidence, 'process-baseline.json'), 'utf8')));
      results.inPageProcessSamples = processSamples.map(({ at, sample }) => {
        const processes = sample.split('\n').flatMap(line => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
          return match && !baseline.has(Number(match[1]))
            && (!processCandidates || processCandidates.has(Number(match[1])))
            && match[3].endsWith('/com.apple.WebKit.WebContent')
            ? [{ pid: Number(match[1]), rssMiB: Number(match[2]) / 1024 }] : [];
        });
        // Other apps can create WebKit processes during a long soak. Freeze the
        // launch-time candidates just as the trusted-wheel sampler does.
        processCandidates ??= new Set(processes.map(process => process.pid));
        return { at, processes };
      });
      const result = results.inPageResidency as { error?: string; samples: Array<{ long: { domNodes: number }; short: { domNodes: number } }> };
      expect(result.error).toBeUndefined();
      expect(result.samples).toHaveLength(Number(process.env.OPENBITFUN_SCROLL_CYCLES || 128));
      // The first sample may precede async syntax decoration. Compare residency
      // after warmup, retaining every cold sample in the evidence for inspection.
      const warm = result.samples.slice(Math.min(7, result.samples.length - 1));
      for (const side of ['long', 'short'] as const) {
        const nodes = warm.map(sample => sample[side].domNodes);
        expect(Math.max(...nodes) - Math.min(...nodes)).toBeLessThanOrEqual(64);
      }
      return;
    }
    const samples: Array<{ cycle: number; longOpenMs: number; shortOpenMs: number; long: Awaited<ReturnType<typeof memorySnapshot>>; short: Awaited<ReturnType<typeof memorySnapshot>> }> = [];
    results.residency = samples;
    const control = process.env.OPENBITFUN_SCROLL_MEMORY_CONTROL === '1';
    results.memoryControl = control;
    const cycles = Number(process.env.OPENBITFUN_SCROLL_CYCLES || 4);
    for (let cycle = 0; cycle < cycles; cycle++) {
      const longStart = Date.now();
      await page.openSession(control ? 'scroll-history-001' : 'scroll-history-000');
      const longOpenMs = Date.now() - longStart;
      await page.wheel(control ? 0 : -280, 12);
      await page.wheel(control ? 0 : 280, 12);
      await page.settle();
      const long = await memorySnapshot();
      const shortStart = Date.now();
      await page.openSession('scroll-history-001');
      const shortOpenMs = Date.now() - shortStart;
      await page.settle();
      const short = await memorySnapshot();
      samples.push({ cycle, longOpenMs, shortOpenMs, long, short });
      results.sessionSwitchLatency = { long: latencyDistribution(samples.map(sample => sample.longOpenMs)),
        short: latencyDistribution(samples.map(sample => sample.shortOpenMs)) };
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(results, null, 2));
      if (process.env.OPENBITFUN_SCROLL_VMMAP === '1' && [7, cycles - 1].includes(cycle) && process.platform === 'darwin') {
        const largest = ('processes' in short ? short.processes ?? [] : []).filter(item => item.role === 'new-webkit-content').sort((a, b) => b.rssMiB - a.rssMiB)[0];
        if (largest) {
          const map = spawnSync('vmmap', ['-summary', String(largest.pid)], { windowsHide: true, encoding: 'utf8' });
          writeFileSync(join(evidence, `vmmap-cycle-${cycle + 1}.txt`), map.stdout || map.stderr);
        }
      }
    }
    const idleMs = Number(process.env.OPENBITFUN_SCROLL_IDLE_MS || 0);
    if (idleMs > 0) {
      await browser.pause(idleMs);
      results.memoryAfterIdle = await memorySnapshot();
    }
    for (const { long, short } of samples) {
      expect(long.renderer.mountedRows).toBeLessThan(90);
      expect(short.renderer.mountedRows).toBeLessThan(90);
    }
    if (samples.length >= 3) {
      expect(samples.at(-1)!.long.renderer.domNodes).toBeLessThanOrEqual(samples[0].long.renderer.domNodes + 64);
      expect(samples.at(-1)!.short.renderer.domNodes).toBeLessThanOrEqual(samples[0].short.renderer.domNodes + 64);
    }
  });
});
