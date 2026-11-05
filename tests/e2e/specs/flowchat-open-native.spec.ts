import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browser, expect } from '@wdio/globals';
import { openWorkspace } from '../helpers/workspace-helper';
import { latencyDistribution } from '../helpers/flowchat-frame-metrics';
import { FlowChatScrollPage } from '../page-objects/FlowChatScrollPage';

const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const page = new FlowChatScrollPage();
const samples: Array<Awaited<ReturnType<typeof page.measureSessionOpen>>> = [];
const report: Record<string, unknown> = { frontend: JSON.parse(readFileSync(join(evidence, 'frontend/frontend-revision.json'), 'utf8')), samples };

describe('FlowChat session opening latency', () => {
  before(async () => { expect(await openWorkspace(process.env.E2E_TEST_WORKSPACE!, { requireWorkspaceLabel: false })).toBe(true); });
  after(() => writeFileSync(join(evidence, 'opening-result.json'), JSON.stringify(report, null, 2)));
  it('measures first and repeated session opens from the actual click through presentation', async () => {
    for (let index = 0; index < Number(process.env.OPENBITFUN_SCROLL_OPEN_SAMPLES || 24); index++) {
      const sample = await page.measureSessionOpen(index % 2 ? 'scroll-history-001' : 'scroll-history-000');
      samples.push(sample);
      expect(sample.interactiveMs).toBeGreaterThanOrEqual(sample.viewportReadyMs);
      expect(sample.presentedMs).toBeGreaterThanOrEqual(sample.interactiveMs);
      expect(Number.isFinite(sample.textDomMs)).toBe(true);
      await page.memory(); // Release disconnected test-driver handles only.
    }
    for (const suffix of ['000', '001']) {
      const selected = samples.filter(sample => sample.sessionId.endsWith(suffix));
      // Startup may prehydrate the selected session before this first UI click.
      // This is a first-entry sample, not a cold disk/cache benchmark.
      report[suffix] = { firstEntry: selected[0], warm: Object.fromEntries(
        ['attachedMs', 'textDomMs', 'viewportReadyMs', 'interactiveMs', 'presentedMs'].map(key => [key,
          latencyDistribution(selected.slice(1).map(sample => sample[key as keyof typeof sample] as number))])) };
    }
    report.startupTrace = await browser.execute(() => (window as any).__OPENBITFUN_STARTUP_TRACE__?.snapshot());
    const trace = report.startupTrace as { phases?: { events?: Array<{ phase: string }> } } | undefined;
    expect(trace?.phases?.events?.filter(event => event.phase === 'historical_session_initial_content_paint_signal_missed') ?? []).toHaveLength(0);
  });
});
