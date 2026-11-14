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
const switchOnly = protocol.suite === 'streaming-switch';
const scrollOnly = protocol.suite === 'streaming-scroll';
const jumpOnly = protocol.suite === 'streaming-jump';
const openOnly = protocol.suite === 'first-open';
const btwOnly = protocol.suite === 'btw-scroll';
const controlled = switchOnly || scrollOnly || jumpOnly || openOnly || btwOnly;
const page = new LongSessionPerformancePage();
let model: Awaited<ReturnType<typeof createLongSessionModel>>;
let workspaceId: string;
const ids = (state: string) => Array.from({ length: openOnly ? protocol.sessionsPerState : 2 }, (_, index) =>
  `perf-${state === 'static' ? 'static' : 'live'}-${String(index).padStart(3, '0')}`);
const tail = (state: string, id: string) => state === 'static' ? `${id}-turn-${String(protocol.turns - 1).padStart(4, '0')}` : `${id}-live-turn`;
const save = () => {
  report.summary = summarize(report.samples);
  const { html, csv } = renderReport(report);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(evidence, 'summary.csv'), csv); writeFileSync(join(evidence, 'report.html'), html);
};

async function sample(state: string, scenario: string, sessionId: string, action: () => Promise<unknown>, streamMarker = sessionId) {
  const row: Record<string, any> = { state, scenario, sessionId, index: report.samples.length, valid: false };
  report.samples.push(row); save();
  try {
    // Restoring a large runtime history can outlast startup notifications or user focus changes.
    // Establish the required starting condition outside the timed window; changes during it still fail.
    await page.focusMainWindow();
    row.streamBefore = state === 'streaming' ? model.snapshot(streamMarker) : null;
    row.before = await page.snapshot(sessionId);
    await action();
    const probe = row.probe = await page.collect();
    if (probe.postReady) {
      row.postReadyFrames = frameMetrics(probe.times, probe.endAt, probe.postReady.endAt!);
      if (state === 'static') {
        assert.equal(probe.postReady.missingAnchorFrames, 0, 'Opening preparation removed the reading anchor');
        assert.ok(probe.postReady.maxAnchorDriftPx <= 2, 'Opening preparation displaced visible content');
      }
    }
    row.frames = frameMetrics(probe.times, probe.actionAt, probe.endAt);
    row.after = await page.snapshot(sessionId);
    row.streamAfter = state === 'streaming' ? model.snapshot(streamMarker) : null;
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
      if (controlled) assert.ok(row.streamAfter.emitted > row.streamBefore.emitted, 'No output delivered during the operation');
      if (!switchOnly) assert.ok(Date.now() - row.streamAfter.lastEmittedAt < (scrollOnly ? 500 : Math.max(5000, protocol.streamIntervalMs * 5)), 'Stalled model output');
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
    await page.arm({ sessionId: id, turnId: tail(state, id), selector: page.sessionSelector(id), collectMilestones: openOnly,
      postReadyMs: openOnly ? protocol.postReadyObservationMs : undefined, checkAnchor: openOnly && state === 'static' });
    if (switchOnly) for (const liveId of ids('streaming')) model.release(liveId, protocol.paragraphsPerSwitch);
    if (openOnly && state === 'streaming') model.release(id, protocol.paragraphsPerOpen);
    await page.clickSession(id);
  });
}

async function startSwitchProfile() {
  const port = process.env.OPENBITFUN_LONG_SESSION_CDP_PORT;
  if (!port) return async () => {};
  const profileName = openOnly ? `open-${report.samples.length}` : scrollOnly || btwOnly ? `scroll-${report.samples.length}` : jumpOnly ? `jump-${report.samples.length}` : 'switch';
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const target = targets.find(value => value.type === 'page' && value.url.includes('index.html') && !value.url.includes('openbitfunWindow='));
  assert.ok(target, 'Main WebView CDP target missing');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  let next = 0;
  const trace: unknown[] = [];
  let traceComplete: () => void = () => {};
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.onmessage = event => {
    const response = JSON.parse(String(event.data)), request = pending.get(response.id);
    if (response.method === 'Tracing.dataCollected') trace.push(...response.params.value);
    if (response.method === 'Tracing.tracingComplete') traceComplete();
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
  };
  const call = (method: string, params?: object) => new Promise<any>((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Profiler.enable'); await call('Profiler.start');
  await call('Tracing.start', { categories: 'devtools.timeline' + (process.env.OPENBITFUN_LONG_SESSION_SELECTOR_STATS === '1'
    ? ',disabled-by-default-blink.debug,disabled-by-default-devtools.timeline.invalidationTracking'
    : process.env.OPENBITFUN_LONG_SESSION_INVALIDATIONS === '1' ? ',disabled-by-default-devtools.timeline.invalidationTracking' : ''), transferMode: 'ReportEvents' });
  return async () => {
    try {
      writeFileSync(join(evidence, `${profileName}.cpuprofile`), JSON.stringify((await call('Profiler.stop')).profile));
      const done = new Promise<void>(resolve => { traceComplete = resolve; });
      await call('Tracing.end'); await done;
      writeFileSync(join(evidence, `${profileName}-trace.json`), JSON.stringify({ traceEvents: trace }));
    }
    finally { socket.close(); }
  };
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
    model = await createLongSessionModel({ intervalMs: protocol.streamIntervalMs, paragraphChars: protocol.paragraphChars, controlled });
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

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      report.failures.push(this.currentTest.err?.stack || this.currentTest.title); save();
      await browser.saveScreenshot(join(evidence, 'failure.png')).catch(() => undefined);
      writeFileSync(join(evidence, 'failure-dom.txt'), await browser.execute(() => document.body.innerText).catch(String));
    }
  });

  after(async () => {
    try {
      await page.cancelMeasurement();
      report.modelErrors = model?.errors ?? [];
      if (report.modelErrors.length) report.failures.push(...report.modelErrors);
      report.contentReadyChecksPassed = report.failures.length === 0 && report.samples.length === (btwOnly ? 6 * protocol.repeats : openOnly ? 2 * protocol.sessionsPerState : scrollOnly ? 2 * protocol.scrollAreas.length * protocol.repeats : switchOnly || jumpOnly ? protocol.repeats : 2 * (2 + protocol.repeats + 2 + protocol.repeats))
        && report.samples.every((row: { valid: boolean }) => row.valid);
      report.functionalPassed = report.contentReadyChecksPassed && (!jumpOnly || report.jumpLandingChecksPassed === true);
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

  if (btwOnly) it('scrolls both panes while the parent and a real BTW session stream', async () => {
    const mainId = 'perf-live-000', childMarker = 'perf-btw';
    await page.invoke('restore_session_with_turns', { sessionId: mainId, workspaceId, workspacePath: workspace });
    await page.prepareSession(mainId);
    await page.activateSession(mainId);
    await page.enterDraft(`/btw LONG_SESSION_STREAM:${childMarker}`);
    assert.ok((await page.draftText()).includes(`LONG_SESSION_STREAM:${childMarker}`), 'BTW draft was not entered');
    await $('[data-testid="chat-input-send-btn"]').click();
    await $('.btw-session-panel__body').waitForDisplayed({ timeout: 30_000 });
    const childId = await $('.btw-session-panel__body').getAttribute('data-flowchat-selection-root');
    assert.ok(childId);
    await browser.waitUntil(() => !!model.snapshot(childMarker)?.connected, { timeout: 60_000, interval: 100 });
    await page.invoke('start_dialog_turn', { sessionId: mainId, workspaceId, workspacePath: workspace,
      agentType: 'agentic', turnId: tail('streaming', mainId), userInput: `LONG_SESSION_STREAM:${mainId}` });
    const markers = [mainId, childMarker];
    await browser.waitUntil(() => !!model.snapshot(mainId)?.connected, { timeout: 60_000, interval: 100 });
    for (const id of markers) model.release(id, protocol.initialParagraphs, protocol.seedIntervalMs);
    await browser.waitUntil(() => markers.every(id => model.snapshot(id)?.emitted === protocol.initialParagraphs), { timeout: 30_000, interval: 100 });
    const main = `[data-testid="flowchat-container"][data-session-id="${mainId}"] [data-flowchat-scroller]`;
    const child = `.btw-session-panel__body[data-flowchat-selection-root="${childId}"]`;
    report.btw = { mainId, childId, childMarker };
    const latest = async (selector: string, id: string, marker: string, count: number) => {
      const button = selector === main
        ? '[data-openbitfun-product-component="scroll-to-latest-bar"][data-openbitfun-product-part="root"][data-visible="true"]'
        : '.btw-session-panel__scroll-to-bottom[data-visible="true"]';
      if (await $(button).isDisplayed().catch(() => false)) await $(button).click();
      await browser.waitUntil(() => browser.execute((selector: string, text: string) => {
        const scroll = document.querySelector<HTMLElement>(selector)!;
        const bounds = scroll.getBoundingClientRect();
        return [...scroll.querySelectorAll('.virtual-item-wrapper')].some(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom && row.textContent?.includes(text);
        });
      }, selector, `Live ${marker} paragraph ${count - 1}:`), { timeout: 30_000, interval: 100, timeoutMsg: `Latest paragraph missing in ${id}` });
      await page.settle();
    };
    for (let cycle = 0; cycle < protocol.repeats; cycle++) {
      for (const area of ['main-live', 'main-history', 'btw-live']) for (const direction of [-1, 1]) {
        const expected = protocol.initialParagraphs + report.samples.length * protocol.paragraphsPerScroll;
        for (const marker of markers) assert.equal(model.snapshot(marker)?.emitted, expected);
        await latest(main, mainId, mainId, expected); await latest(child, childId, childMarker, expected);
        const selector = area === 'btw-live' ? child : main;
        if (area === 'main-history') await jump('streaming', mainId, protocol.turns, tail('streaming', mainId), false);
        if (direction > 0) await page.wheelPane(selector, -protocol.wheelDelta, protocol.scrollSteps);
        await page.settle();
        const beforeStreams = markers.map(id => model.snapshot(id));
        const stopProfile = await startSwitchProfile();
        try {
          const sessionId = area === 'btw-live' ? childId : mainId;
          await sample('streaming', `continuous-scroll-${area}-${direction < 0 ? 'up' : 'down'}`, sessionId, async () => {
            await page.arm({ sessionId, scrollerSelector: selector, wheelCount: protocol.scrollSteps });
            for (const marker of markers) model.release(marker, protocol.paragraphsPerScroll);
            await page.wheelPane(selector, direction * protocol.wheelDelta, protocol.scrollSteps);
          }, area === 'btw-live' ? childMarker : mainId);
        } finally { await stopProfile(); }
        const afterStreams = markers.map(id => model.snapshot(id));
        afterStreams.forEach((stream, index) => {
          assert.ok(stream?.connected && !stream.finished && stream.emitted > beforeStreams[index]!.emitted, 'Both streams must advance during scrolling');
          assert.ok(Date.now() - stream.lastEmittedAt < 500, 'Both streams must remain fresh throughout scrolling');
        });
        await page.settle();
        const reading = await page.paneAnchor(selector);
        const distanceFromTail = await browser.execute((selector: string) => {
          const scroller = document.querySelector<HTMLElement>(selector)!;
          return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        }, selector);
        const heldStreams = markers.map(id => model.snapshot(id));
        heldStreams.forEach(stream => assert.ok(stream!.emitted < expected + protocol.paragraphsPerScroll,
          'Reading-position validation requires further output in both panes'));
        await browser.waitUntil(() => markers.every(id => model.snapshot(id)?.emitted === expected + protocol.paragraphsPerScroll), { timeout: 30_000, interval: 100 });
        await page.settle();
        const still = await page.paneAnchor(selector);
        assert.ok(reading.key);
        if (distanceFromTail > 120) {
          assert.equal(still.key, reading.key, 'Streaming changed the reading row');
          assert.ok(Math.abs(still.offset - reading.offset) < 8, 'Streaming displaced the reading position');
        }
        const panes = await Promise.all([page.snapshot(mainId), page.snapshot(childId)]);
        panes.forEach(pane => assert.ok(pane.exists && pane.rows! > 0 && pane.rows! < 90, 'Both panes must retain bounded transcript DOM'));
        Object.assign(report.samples.at(-1), { beforeStreams, afterStreams, heldStreams, distanceFromTail, panes, reading, still }); save();
      }
    }
    const finalCount = protocol.initialParagraphs + report.samples.length * protocol.paragraphsPerScroll;
    await latest(main, mainId, mainId, finalCount); await latest(child, childId, childMarker, finalCount);
    await browser.saveScreenshot(join(evidence, 'btw-panes.png'));
    for (const marker of markers) model.finish(marker);
    await browser.waitUntil(() => browser.execute((selectors: string[], markers: string[]) => selectors.every((selector, index) =>
      document.querySelector(selector)?.textContent?.includes(`LONG_SESSION_COMPLETE:${markers[index]}`)), [main, child], markers),
    { timeout: 30_000, interval: 100, timeoutMsg: 'Both panes must render their completed response' });
    report.btw.completedResponsesVisible = true;
  });

  for (const state of btwOnly ? [] : controlled && !openOnly ? ['streaming'] : ['static', 'streaming']) {
    it(`measures first entry, switching, continuous scroll and turn jumps while ${state}`, async () => {
      const sessions = scrollOnly || jumpOnly ? ids(state).slice(0, 1) : ids(state);
      if (state === 'streaming') {
        await page.openSession('perf-parking-000');
        for (const id of sessions) {
          // Start on the runtime without ever attaching this transcript to the UI.
          await page.invoke('restore_session_with_turns', { sessionId: id, workspaceId, workspacePath: workspace });
          await page.invoke('start_dialog_turn', { sessionId: id, workspaceId, workspacePath: workspace,
            agentType: 'agentic', turnId: tail(state, id), userInput: `LONG_SESSION_STREAM:${id}` });
          await browser.waitUntil(() => controlled ? !!model.snapshot(id)?.connected : (model.snapshot(id)?.emitted ?? 0) >= 8,
            { timeout: 60_000, interval: 100, timeoutMsg: `Model did not start for ${id}` });
        }
        if (controlled) {
          for (const id of sessions) model.release(id, protocol.initialParagraphs, protocol.seedIntervalMs);
          await browser.waitUntil(() => sessions.every(id => model.snapshot(id)?.emitted === protocol.initialParagraphs), { timeout: 30_000, interval: 100 });
        }
      }
      if (openOnly) {
        for (const id of sessions) {
          await page.openSession('perf-parking-000'); await page.settle();
          assert.equal((await page.snapshot(id)).exists, false, `First-entry target ${id} was already attached`);
          const stopProfile = await startSwitchProfile();
          try { await openMeasured(state, 'first-open', id); } finally { await stopProfile(); }
          if (state === 'streaming') await browser.waitUntil(() => model.snapshot(id)?.emitted === protocol.initialParagraphs + protocol.paragraphsPerOpen,
            { timeout: 10_000, interval: 100 });
          // Observe normal follow after the entire batch reaches the frontend;
          // do not click jump-to-latest to repair a failed opening placement.
          if (state === 'streaming') await page.waitForLiveParagraph(id, protocol.initialParagraphs + protocol.paragraphsPerOpen - 1);
          await page.settle();
          const settled = await page.snapshot(id);
          assert.ok(settled.visibleTurns.includes(tail(state, id)), 'Initial tail left the viewport');
          assert.ok(settled.rows > 0 && settled.rows < 90, 'Initial transcript DOM is not bounded');
          Object.assign(report.samples.at(-1), { settled }); save();
        }
      } else if (jumpOnly) {
        const id = sessions[0];
        await page.prepareSession(id); await page.openSession(id);
        await page.returnToLatest(id, protocol.initialParagraphs - 1);
        const visited = new Set([protocol.turns]);
        for (let index = 0; index < protocol.repeats; index++) {
          const ordinal = protocol.jumpOrdinals[index % protocol.jumpOrdinals.length];
          const turnId = ordinal === protocol.turns ? tail(state, id) : `${id}-turn-${String(ordinal).padStart(4, '0')}`;
          const expectedBefore = protocol.initialParagraphs + index * protocol.paragraphsPerJump;
          assert.equal(model.snapshot(id)?.emitted, expectedBefore, 'Unequal jump workload');
          const selector = await page.revealTurn(ordinal);
          const boundTurnId = await $(selector).getAttribute('data-turn-id');
          assert.ok(boundTurnId === null || boundTurnId === turnId, 'Wrong turn rail binding');
          await page.settle();
          const stopProfile = await startSwitchProfile();
          try {
            await sample(state, 'turn-jump', id, async () => {
              await page.arm({ sessionId: id, turnId, selector, collectMilestones: true,
                collectRows: process.env.OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC === '1' });
              if (process.env.OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC === '1') report.instrumented = true;
              model.release(id, protocol.paragraphsPerJump);
              await page.clickTurn(selector);
            });
          } finally { await stopProfile(); }
          Object.assign(report.samples.at(-1), { targetOrdinal: ordinal, firstVisit: !visited.has(ordinal),
            targetKind: ordinal === protocol.turns ? 'live' : 'history', railBoundTurnId: boundTurnId });
          visited.add(ordinal);
          const landing = await page.turnLanding(id, turnId);
          await browser.waitUntil(() => model.snapshot(id)?.emitted === expectedBefore + protocol.paragraphsPerJump,
            { timeout: 10_000, interval: 100 });
          await page.settle();
          const stable = await page.snapshot(id);
          const settledLanding = await page.turnLanding(id, turnId);
          assert.ok(stable.visibleTurns.includes(turnId), 'Target left the viewport after more output');
          assert.ok(stable.rows && stable.rows < 90, 'Jump mounted unbounded rows');
          const landingStable = !!landing?.visible && !!settledLanding?.visible
            && Math.abs(settledLanding.topPx - landing.topPx) < 8;
          Object.assign(report.samples.at(-1), { landing, settledLanding, landingStable });
          (report.jumpCheckpoints ??= []).push({ ordinal, turnId, landing, settledLanding, landingStable, stable });
          report.jumpLandingChecksPassed = report.jumpCheckpoints.every((value: any) => value.landingStable);
          save();
        }
      } else if (scrollOnly) {
        const id = sessions[0];
        await page.prepareSession(id); await page.openSession(id);
        await page.returnToLatest(id, protocol.initialParagraphs - 1);
        for (let cycle = 0; cycle < protocol.repeats; cycle++) for (const area of protocol.scrollAreas) for (const direction of [-1, 1]) {
          const expectedBefore = protocol.initialParagraphs + report.samples.length * protocol.paragraphsPerScroll;
          assert.equal(model.snapshot(id)?.emitted, expectedBefore, 'Unequal scroll workload');
          await page.returnToLatest(id, expectedBefore - 1);
          if (area === 'history') await jump(state, id, protocol.turns, tail(state, id), false);
          // Preparation uses real wheel input, outside the measured window.
          if (direction > 0) await page.wheel(-240, protocol.scrollSteps);
          await page.settle();
          const stopProfile = await startSwitchProfile();
          try {
            await sample(state, `continuous-scroll-${area}-${direction < 0 ? 'up' : 'down'}`, id, async () => {
              await page.arm({ sessionId: id, wheelCount: protocol.scrollSteps, collectRows: process.env.OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC === '1' });
              if (process.env.OPENBITFUN_LONG_SESSION_ROW_DIAGNOSTIC === '1') report.instrumented = true;
              model.release(id, protocol.paragraphsPerScroll);
              await page.wheel(direction * protocol.wheelDelta, protocol.scrollSteps);
            });
          } finally { await stopProfile(); }
          await browser.waitUntil(() => model.snapshot(id)?.emitted === expectedBefore + protocol.paragraphsPerScroll,
            { timeout: 30_000, interval: 100 });
          const reading = await page.anchor(); await page.settle();
          const still = await page.anchor();
          assert.equal(still.key, reading.key, 'Output changed the reading row after scroll');
          assert.ok(Math.abs(still.offset - reading.offset) < 8, 'Reading position drifted after scroll');
          await page.returnToLatest(id, expectedBefore + protocol.paragraphsPerScroll - 1);
          (report.scrollCheckpoints ??= []).push({ area, direction, reading, still, latest: await page.snapshot(id) });
          save();
        }
      } else if (switchOnly) {
        for (const id of sessions) { await page.prepareSession(id); await page.openSession(id); await page.settle(); }
        const stopProfile = await startSwitchProfile();
        try {
          for (let index = 0; index < protocol.repeats; index++) {
            const expectedBefore = protocol.initialParagraphs + index * protocol.paragraphsPerSwitch;
            for (const id of sessions) assert.equal(model.snapshot(id)?.emitted, expectedBefore, 'Unequal switch workload');
            await openMeasured(state, 'session-switch', sessions[index % 2]);
            await browser.waitUntil(() => sessions.every(id => model.snapshot(id)?.emitted === expectedBefore + protocol.paragraphsPerSwitch), { timeout: 10_000, interval: 100 });
            await browser.waitUntil(() => browser.execute((id: string, last: number) => {
              const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
              return !!root?.textContent?.includes(`Live ${id} paragraph ${last}:`);
            }, sessions[index % 2], expectedBefore + protocol.paragraphsPerSwitch - 1),
            { timeout: 10_000, interval: 100, timeoutMsg: 'Latest streamed paragraph was not rendered' });
            await page.settle();
            (report.streamCheckpoints ??= []).push(await browser.execute((id: string, last: number) => {
              const root = document.querySelector(`[data-testid="flowchat-container"][data-session-id="${id}"]`);
              const scroll = root?.querySelector<HTMLElement>('[data-flowchat-scroller]');
              return { id, last, latestMounted: root?.textContent?.includes(`Live ${id} paragraph ${last}:`),
                top: scroll?.scrollTop, height: scroll?.scrollHeight, viewport: scroll?.clientHeight };
            }, sessions[index % 2], expectedBefore + protocol.paragraphsPerSwitch - 1));
          }
        } finally { await stopProfile(); }
        // Functional checks are outside every timing/profile window. A warm
        // viewport reservation must not replace the user's actual bookmark.
        const currentId = sessions[(protocol.repeats - 1) % 2];
        const otherId = sessions.find(id => id !== currentId)!;
        const draft = 'Streaming switch preserves this draft';
        await page.enterDraft(draft);
        await page.wheel(-360, 6); await page.settle();
        const before = await page.anchor(); assert.ok(before.key, 'Missing reading anchor');
        await page.openSession(otherId); await page.openSession(currentId); await page.settle();
        const restored = await page.anchor();
        assert.equal(restored.key, before.key, 'Switch changed the reading row');
        assert.ok(Math.abs(restored.offset - before.offset) < 8, 'Switch displaced the reading position');
        assert.ok((await page.draftText()).includes(draft), 'Switch lost the draft');
        const finalCount = protocol.initialParagraphs + (protocol.repeats + 1) * protocol.paragraphsPerSwitch;
        for (const id of sessions) model.release(id, protocol.paragraphsPerSwitch);
        await browser.waitUntil(() => sessions.every(id => model.snapshot(id)?.emitted === finalCount), { timeout: 10_000, interval: 100 });
        await page.settle();
        const afterOutput = await page.anchor();
        assert.equal(afterOutput.key, restored.key, 'Streaming took over the reader');
        assert.ok(Math.abs(afterOutput.offset - restored.offset) < 8, 'Streaming displaced the reading position');
        await page.findFirstResult(`Live ${currentId} paragraph 0:`); await page.closeSearch();
        assert.ok((await page.draftText()).includes(draft), 'Search lost the draft');
        const resident = await page.snapshot(currentId);
        assert.ok(resident.rows && resident.rows < 90, 'Transcript DOM is not bounded');
        report.readerChecks = { before, restored, afterOutput, draftPreserved: true, searchLocated: true, mountedRows: resident.rows };
      } else {
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
