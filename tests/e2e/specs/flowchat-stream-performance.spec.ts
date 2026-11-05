import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { FlowChatScrollPage } from '../page-objects/FlowChatScrollPage';
import { openWorkspace } from '../helpers/workspace-helper';
import { createFlowChatStreamFixture } from '../helpers/flowchat-stream-fixture';
import { probeFrameDistributions } from '../helpers/flowchat-frame-metrics';

const evidence = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE!;
const workspace = process.env.E2E_TEST_WORKSPACE!;
const page = new FlowChatScrollPage();
const report: Record<string, unknown> = {};
let workspaceId: string;
let fixture: Awaited<ReturnType<typeof createFlowChatStreamFixture>>;
async function invoke(command: string, args: unknown = {}) {
  return browser.execute(async (name: string, payload: unknown) => {
    const host = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    return host.invoke(name, payload);
  }, command, args);
}

describe('FlowChat streaming performance with actual local tools', () => {
  before(async () => {
    expect(await openWorkspace(workspace, { requireWorkspaceLabel: false })).toBe(true);
    fixture = await createFlowChatStreamFixture(workspace);
    const models = await invoke('get_config', { request: { path: 'ai.models' } });
    await invoke('set_config', { request: { path: 'ai.models', expectedModels: models, value: [{
      id: 'flowchat-perf', name: 'FlowChat performance', provider: 'anthropic', model_name: 'flowchat-perf',
      base_url: fixture.url, request_url: `${fixture.url}/v1/messages`, api_key: 'isolated-loopback-fixture',
      auth: { type: 'api_key' }, enabled: true, context_window: 128000, max_tokens: 32000,
      capabilities: ['text_chat', 'function_calling'],
    }] } });
    for (const [path, value] of [
      ['ai.default_models', { primary: 'flowchat-perf', fast: 'flowchat-perf' }],
      ['ai.enable_deferred_tool_loading', false],
      ['app.ai_experience.enable_session_title_generation', false],
      ['app.ai_experience.enable_welcome_panel_ai_analysis', false],
      ['app.ai_experience.enable_prompt_suggestion', false],
    ]) await invoke('set_config', { request: { path, value } });
    const current = await invoke('get_current_workspace', { request: {} }) as { id: string };
    workspaceId = current.id;
    await invoke('create_session', { request: { sessionId: 'flowchat-perf-live', sessionName: 'FlowChat live performance',
      agentType: 'agentic', workspacePath: workspace, workspaceId: current.id, config: { modelName: 'flowchat-perf', safeMode: false } } });
    await browser.refresh();
    const row = $('[data-testid="nav-session-item"][data-session-id="flowchat-perf-live"]');
    await row.waitForExist(); await row.click();
    await $('[data-testid="chat-input-send-btn"]').waitForExist();
  });
  after(async () => {
    report.fixtureErrors = fixture?.errors;
    report.toolResults = fixture?.results;
    await page.disposeProbe();
    await browser.saveScreenshot(join(evidence, 'streaming.png'));
    writeFileSync(join(evidence, 'streaming-result.json'), JSON.stringify(report, null, 2));
    await fixture?.close();
  });

  it('keeps reader control during growing Markdown and real shell/file edits', async () => {
    if (process.env.OPENBITFUN_SCROLL_DIAGNOSTICS === '1') {
      await browser.execute(() => { (window as any).__OPENBITFUN_RENDER_PROFILE_ENABLED__ = true; });
    }
    await page.enterDraft('FLOWCHAT_PERF_STREAM');
    await $('[data-testid="chat-input-send-btn"]').click();
    await $('[data-flowchat-scroller]').waitForExist();
    await page.startProbe(0);
    await browser.waitUntil(() => fixture.textReady || fixture.errors.length > 0, { timeout: 45000 });
    report.toolsStartup = await page.stopProbe();
    await page.settle();
    await page.startProbe(0);
    fixture.begin();
    const initialParagraphs = Number(process.env.OPENBITFUN_STREAM_INITIAL_PARAGRAPHS || 80);
    report.initialParagraphs = initialParagraphs;
    await browser.waitUntil(() => fixture.emitted >= initialParagraphs + 5 || fixture.errors.length > 0, { timeout: 45000 });
    expect(fixture.errors).toEqual([]);
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll('.flow-text-block[data-streaming="true"]')]
      .some(node => (node.textContent?.length ?? 0) > 0)), { timeout: 20000 });
    const firstText = await page.stopProbe();
    report.follow = firstText;
    const arrivalFrames = probeFrameDistributions(firstText).phase;
    expect(arrivalFrames.samples).toBeGreaterThan(10);
    expect(arrivalFrames.p95Ms).toBeLessThan(34);
    expect(arrivalFrames.maxMs).toBeLessThan(Number(process.env.OPENBITFUN_SCROLL_FRAME_BUDGET_MS || 100));
    expect(Math.max(...firstText.frames.map(frame => frame.rows))).toBeLessThan(90);
    report.renderTrace = await browser.execute(() => (window as any).__OPENBITFUN_STARTUP_TRACE__?.snapshot());
    await page.startProbe(0);
    const followStart = fixture.emitted;
    await browser.waitUntil(() => fixture.emitted >= followStart + 24, { timeout: 10000, interval: 100 });
    const sustainedFollow = await page.stopProbe();
    report.sustainedFollow = sustainedFollow;
    await page.startProbe(-1);
    await page.wheel(-100, 24);
    await page.settle();
    const readerScroll = await page.stopProbe();
    report.readerScroll = readerScroll;
    report.frameDistributions = { firstArrival: probeFrameDistributions(firstText),
      sustainedFollow: probeFrameDistributions(sustainedFollow), readerScroll: probeFrameDistributions(readerScroll) };
    const readerFrames = probeFrameDistributions(readerScroll).phase;
    expect(readerScroll.wheelEvents).toBe(24);
    expect(readerScroll.frames.length).toBeGreaterThan(20);
    expect(readerFrames.p95Ms).toBeLessThan(34);
    expect(readerFrames.maxMs).toBeLessThan(Number(process.env.OPENBITFUN_SCROLL_FRAME_BUDGET_MS || 100));
    expect(readerScroll.frames.some(frame => frame.blank)).toBe(false);
    const before = await page.anchor();
    const emitted = fixture.emitted;
    const holdParagraphs = Number(process.env.OPENBITFUN_STREAM_HOLD_PARAGRAPHS || 16);
    report.memoryBeforeHold = await page.memory();
    await browser.waitUntil(() => fixture.emitted >= emitted + holdParagraphs, { timeout: holdParagraphs * 100 + 10000, interval: 100 });
    report.memoryAfterHold = await page.memory();
    await page.settle();
    const after = await page.anchor();
    report.readerHold = { before, after, emittedBefore: emitted, emittedAfter: fixture.emitted };
    expect(after.key).toBe(before.key);
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(3);
    await $('.scroll-to-latest-bar[data-visible="true"] button').click();
    fixture.finish();
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="flowchat-message-list"]')?.textContent?.includes('FLOWCHAT_STREAM_COMPLETE') === true), { timeout: 30000 });
    await $('[data-testid="chat-input-cancel-btn"]').waitForExist({ reverse: true, timeout: 30000 });
    for (let index = 0; index < 4; index++) expect(readFileSync(join(workspace, `flowchat-live-${index}.ts`), 'utf8')).toContain('value = 1');
    expect(fixture.results).toHaveLength(8);
    expect(fixture.results.some(result => (result as { is_error?: boolean }).is_error)).toBe(false);
    const saved = JSON.stringify(await invoke('load_session_turns', { request: { session_id: 'flowchat-perf-live', workspace_id: workspaceId } }));
    expect(saved).toContain('Stream paragraph 0:');
    expect(saved).toContain(`Stream paragraph ${fixture.emitted - 1}:`);
    expect(saved).toContain('FLOWCHAT_STREAM_COMPLETE');
    report.persistedAllParagraphs = true;
    await page.settle();
    report.completed = await page.memory();
    expect((report.completed as { highlightRanges: number }).highlightRanges).toBe(0);
    expect((report.completed as { mountedRows: number }).mountedRows).toBeLessThan(90);
  });
});
