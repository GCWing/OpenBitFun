import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { $, browser } from '@wdio/globals';
import { openWorkspace } from '../../helpers/workspace-helper';
import { LongSessionPerformancePage, type LongSessionProbe } from '../../page-objects/LongSessionPerformancePage';
import { createLongSessionModel } from '../../helpers/long-session-model.mjs';
import { frameMetrics, summarize, renderReport } from '../../scripts/long-session-metrics.mjs';

const evidence = process.env.OPENBITFUN_LONG_SESSION_EVIDENCE!;
const workspace = process.env.E2E_TEST_WORKSPACE!;
const report = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8'));
const protocol = report.protocol;
const page = new LongSessionPerformancePage();
let model: Awaited<ReturnType<typeof createLongSessionModel>>;
let workspaceId: string;
const ids = (state: string) => [`perf-${state === 'static' ? 'static' : 'live'}-000`, `perf-${state === 'static' ? 'static' : 'live'}-001`];
const tail = (state: string, id: string) => state === 'static' ? `${id}-turn-${String(protocol.turns - 1).padStart(4, '0')}` : `${id}-live-turn`;
const save = () => {
  report.summary = summarize(report.samples);
  const { html, csv } = renderReport(report);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(evidence, 'summary.csv'), csv); writeFileSync(join(evidence, 'report.html'), html);
};

async function sample(state: string, scenario: string, sessionId: string, action: () => Promise<unknown>) {
  const row: Record<string, any> = { state, scenario, sessionId, index: report.samples.length, valid: false };
  report.samples.push(row); save();
  try {
    // Restoring a large runtime history can outlast startup notifications or user focus changes.
    // Establish the required starting condition outside the timed window; changes during it still fail.
    await page.focusMainWindow();
    row.streamBefore = state === 'streaming' ? model.snapshot(sessionId) : null;
    row.before = await page.snapshot(sessionId);
    await action();
    const probe = row.probe = await page.collect();
    row.frames = frameMetrics(probe.times, probe.actionAt, probe.endAt);
    row.after = await page.snapshot(sessionId);
    row.streamAfter = state === 'streaming' ? model.snapshot(sessionId) : null;
    assert.equal(probe.timedOut, false, 'Target never became usable');
    assert.equal(probe.visibility, 'visible', 'Hidden WebView cannot establish visible-window performance');
    assert.equal(probe.visibilityChanged, false, 'Visibility changed during measurement');
    assert.equal(probe.focusChanged, false, 'Focus changed during measurement');
    assert.equal(probe.focus, true, 'Main WebView was not focused during measurement');
    assert.ok(Number.isFinite(probe.latencyMs), 'Missing input or readiness timestamp');
    assert.ok(row.frames.count > 0, 'No RAF intervals');
    assert.equal(row.after.exists, true, 'Wrong or absent transcript');
    assert.ok(row.after.rows > 0, 'Empty transcript');
    if (probe.targetTurnId) assert.ok(row.after.visibleTurns.includes(probe.targetTurnId), 'Requested turn left the viewport after readiness');
    if (scenario.startsWith('continuous-scroll')) {
      assert.equal(probe.wheelTimes.length, protocol.scrollSteps, 'Wheel delivery mismatch');
      assert.ok(Math.abs(probe.afterTop - probe.beforeTop) > 10, 'Scroll workload did not move');
    }
    if (state === 'streaming') {
      if (scenario === 'first-open' || scenario === 'session-switch') assert.ok(row.after.streamingBlocks > 0, 'Live output is not rendered');
      assert.ok(row.streamBefore?.connected && !row.streamBefore.finished, 'Stream inactive before operation');
      assert.ok(row.streamAfter?.connected && !row.streamAfter.finished, 'Stream ended during operation');
      assert.ok(Date.now() - row.streamAfter.lastEmittedAt < Math.max(5000, protocol.streamIntervalMs * 5), 'Stalled model output');
      assert.deepEqual(model.errors, []);
    } else assert.equal(row.after.streamingBlocks, 0, 'Static case contains streaming output');
    row.valid = true;
    console.log(`[LongSessionPerf] ${state}/${scenario} latency=${probe.latencyMs?.toFixed(1)}ms RAF=${row.frames.rafFps?.toFixed(1)}fps`);
  } catch (error) {
    row.error = error instanceof Error ? error.stack : String(error); report.failures.push(`${state}/${scenario}: ${row.error}`);
    await page.cancelMeasurement().catch(() => undefined);
    await browser.saveScreenshot(join(evidence, `failure-${row.index}.png`)).catch(() => undefined);
    console.error(`[LongSessionPerf] ${state}/${scenario} failed: ${row.error}`);
  } finally { save(); }
}

async function openMeasured(state: string, scenario: string, id: string) {
  await page.prepareSession(id);
  await sample(state, scenario, id, async () => {
    await page.arm({ sessionId: id, turnId: tail(state, id), selector: page.sessionSelector(id) });
    await page.clickSession(id);
  });
}

async function jump(state: string, id: string, ordinal: number, turnId: string, measured = true) {
  const selector = await page.revealTurn(ordinal);
  const action = async () => {
    // An unloaded ordinal intentionally has no ID: clicking it performs the real history-window read.
    const boundTurnId = await $(selector).getAttribute('data-turn-id');
    assert.ok(boundTurnId === null || boundTurnId === turnId,
      `Turn rail ordinal ${ordinal} is bound to ${boundTurnId}, expected ${turnId}`);
    await page.arm({ sessionId: id, turnId, selector }); await page.clickTurn(selector);
  };
  if (measured) await sample(state, 'turn-jump', id, action);
  else {
    await action(); const probe: LongSessionProbe = await page.collect();
    assert.equal(probe.timedOut, false, 'Preparation jump did not reach requested turn');
  }
}

describe('Desktop long-session performance matrix', () => {
  before(async () => {
    assert.ok(await openWorkspace(workspace, { requireWorkspaceLabel: false }), 'Isolated workspace unavailable');
    model = await createLongSessionModel({ intervalMs: protocol.streamIntervalMs, paragraphChars: protocol.paragraphChars });
    const models = await page.invoke('get_config', { path: 'ai.models' });
    await page.invoke('set_config', { path: 'ai.models', expectedModels: models, value: [{
      id: 'perf-fixture-model', name: 'Isolated long-session model', provider: 'anthropic', model_name: 'perf-fixture-model',
      base_url: model.url, request_url: `${model.url}/v1/messages`, api_key: 'loopback-only', auth: { type: 'api_key' },
      enabled: true, context_window: 10_000_000, max_tokens: 1_000_000, capabilities: ['text_chat'],
    }] });
    for (const [path, value] of [
      ['ai.default_models', { primary: 'perf-fixture-model', fast: 'perf-fixture-model' }],
      ['app.ai_experience.enable_session_title_generation', false],
      ['app.ai_experience.enable_welcome_panel_ai_analysis', false], ['app.ai_experience.enable_prompt_suggestion', false],
      ['app.logging.level', 'warn'],
    ]) await page.invoke('set_config', { path, value });
    await page.invoke('product_control_invoke', { action: 'configure', capabilityId: 'setting.application.general', optionId: 'auto-update', value: false });
    const settings = await page.invoke<{ currentOptionValues: Record<string, unknown> }>('product_control_invoke', { action: 'get', capabilityId: 'setting.application.general' });
    assert.equal(settings.currentOptionValues['auto-update'], false);
    report.environment.loggingLevel = await page.invoke('get_config', { path: 'app.logging.level' });
    const current = await page.invoke<{ id: string }>('get_current_workspace', {}); workspaceId = current.id;
    await page.prepareSession('perf-parking-000'); await page.openSession('perf-parking-000'); await page.settle();
    await page.focusMainWindow();
    report.runtimeFrontend = await browser.execute(async () => ({ url: location.href,
      revision: await fetch(new URL('frontend-revision.json', location.href)).then(response => response.json()) }));
    assert.deepEqual(report.runtimeFrontend.revision, report.frontend, 'Loaded frontend does not match the immutable snapshot');
    report.environment.viewport = await browser.execute(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio, userAgent: navigator.userAgent,
      visibility: document.visibilityState, focus: document.hasFocus() }));
    save();
  });

  afterEach(function () {
    if (this.currentTest?.state === 'failed') {
      report.failures.push(this.currentTest.err?.stack || this.currentTest.title); save();
    }
  });

  after(async () => {
    try {
      await page.cancelMeasurement();
      report.modelErrors = model?.errors ?? [];
      if (report.modelErrors.length) report.failures.push(...report.modelErrors);
      report.functionalPassed = report.failures.length === 0 && report.samples.length === 2 * (2 + protocol.repeats + 2 + protocol.repeats)
        && report.samples.every((row: { valid: boolean }) => row.valid);
      const budgets = report.samples.filter((row: { valid: boolean }) => row.valid).map((row: any) => ({ index: row.index,
        latencyPassed: protocol.maxLatencyMs === null || row.probe.latencyMs <= protocol.maxLatencyMs,
        framesPassed: protocol.maxP95FrameMs === null || row.frames.p95Ms <= protocol.maxP95FrameMs }));
      report.budgets = budgets;
      report.performanceBudgetsPassed = protocol.maxLatencyMs === null && protocol.maxP95FrameMs === null ? null
        : report.functionalPassed && budgets.every((entry: any) => entry.latencyPassed && entry.framesPassed);
      report.passed = report.functionalPassed && report.performanceBudgetsPassed !== false;
      report.completedAt = new Date().toISOString(); save();
    } finally { await model?.close(); }
  });

  for (const state of ['static', 'streaming']) {
    it(`measures first entry, switching, continuous scroll and turn jumps while ${state}`, async () => {
      const sessions = ids(state);
      if (state === 'streaming') {
        await page.openSession('perf-parking-000');
        for (const id of sessions) {
          // Start on the runtime without ever attaching this transcript to the UI.
          await page.invoke('restore_session_with_turns', { sessionId: id, workspaceId, workspacePath: workspace });
          await page.invoke('start_dialog_turn', { sessionId: id, workspaceId, workspacePath: workspace,
            agentType: 'agentic', turnId: tail(state, id), userInput: `LONG_SESSION_STREAM:${id}` });
          await browser.waitUntil(() => (model.snapshot(id)?.emitted ?? 0) >= 8, { timeout: 60_000, interval: 100, timeoutMsg: `Model did not start for ${id}` });
        }
      }
      for (const id of sessions) {
        const alreadyAttached = await page.snapshot(id);
        assert.equal(alreadyAttached.exists, false, `First-entry target ${id} was already attached`);
        await openMeasured(state, 'first-open', id);
      }
      for (let index = 0; index < protocol.repeats; index++) await openMeasured(state, 'session-switch', sessions[index % 2]);
      const id = sessions[(protocol.repeats - 1) % 2];
      // Each scroll direction starts with known viewport placement; preparation is not timed.
      await jump(state, id, state === 'static' ? protocol.turns - 1 : protocol.turns, tail(state, id), false);
      for (const direction of [-1, 1]) {
        await sample(state, direction < 0 ? 'continuous-scroll-up' : 'continuous-scroll-down', id, async () => {
          await page.arm({ sessionId: id, wheelCount: protocol.scrollSteps });
          await page.wheel(direction * protocol.wheelDelta, protocol.scrollSteps);
        });
      }
      const targets = [0, Math.floor(protocol.turns * .75), Math.floor(protocol.turns * .25), protocol.turns - 1];
      for (let index = 0; index < protocol.repeats; index++) {
        const ordinal = targets[index % targets.length];
        await jump(state, id, ordinal, `${id}-turn-${String(ordinal).padStart(4, '0')}`);
      }
      if (state === 'streaming') {
        report.streamCompletion = [];
        for (const liveId of sessions) {
          const stream = model.snapshot(liveId); assert.ok(stream && stream.emitted > 8, 'No sustained streaming workload');
          model.finish(liveId);
          // Startup migrates legacy path-slug fixtures to stable project IDs. Resolve within this isolated home.
          const projects = join(evidence, 'home', 'projects');
          await browser.waitUntil(() => readdirSync(projects).some(project => {
            const turnsDirectory = join(projects, project, 'sessions', liveId, 'turns');
            return existsSync(turnsDirectory) && readdirSync(turnsDirectory).some(file => file.endsWith('.json') &&
              readFileSync(join(turnsDirectory, file), 'utf8').includes(`LONG_SESSION_COMPLETE:${liveId}`));
          }), { timeout: 30_000, interval: 200, timeoutMsg: 'Stream did not reach persisted transcript' });
          report.streamCompletion.push({ sessionId: liveId, ...stream, persisted: true });
        }
      }
      assert.equal(report.samples.filter((row: any) => row.state === state && !row.valid).length, 0, `${state} samples failed; inspect report.html`);
    });
  }
});
