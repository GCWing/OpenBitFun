/** Isolated native product acceptance; only external provider HTTP is mocked. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoolProvider } from '../helpers/subscription-pool-provider.mjs';
import { verifyProviderAccountPools } from '../helpers/verify-provider-account-pools.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-subscription-pool-'));
const userRoot = path.join(root, 'user');
const productHome = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
for (const dir of [path.join(userRoot, 'config'), productHome, workspace]) await mkdir(dir, { recursive: true });
await writeFile(path.join(workspace, 'seed.txt'), 'pool-seed-history\n');
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const frontend = path.join(root, 'frontend');
const manifest = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
await cp(frontendSource, frontend, { recursive: true });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), manifest, 'Frontend changed while being snapshotted');
const binaryName = 'openbitfun-desktop' + (process.platform === 'win32' ? '.exe' : '');
const binarySource = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug', binaryName));
const binary = path.join(root, binaryName);
const beforeCopy = await stat(binarySource);
await cp(binarySource, binary);
assert.equal((await stat(binarySource)).mtimeMs, beforeCopy.mtimeMs, 'Desktop changed while being snapshotted');
const binaryHash = createHash('sha256');
for await (const chunk of createReadStream(binary)) binaryHash.update(chunk);
const binarySha256 = binaryHash.digest('hex');
const provider = await createPoolProvider(root, workspace);
await writeFile(path.join(userRoot, 'config', 'app.json'), JSON.stringify({
  ai: { models: [], proxy: { enabled: true, url: provider.url } },
  app: { language: 'en-US', ai_experience: { enable_session_title_generation: false, enable_welcome_panel_ai_analysis: false } },
}));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const report = { passed: false, artifactRoot: root, frontendRevision: JSON.parse(manifest).revision,
  binaryModified: beforeCopy.mtime.toISOString(), binarySha256, checks: [], limitations: ['External OAuth, quota and model HTTP are simulated.', 'No physical remote connection or complete old application is exercised.'] };
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
let app;
let session;
let generation = 0;
console.log(`Native subscription pool evidence: ${root}`);
const saveReport = () => writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
await saveReport();

async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + route, { method, signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const execute = (fn, ...args) => request(`/session/${session}/execute/sync`, { script: fn.toString(), args });
const invoke = (command, request = {}) => execute(async (command, request) => window.__TAURI_INTERNALS__.invoke(command, { request }), command, request);
const locate = selector => request(`/session/${session}/element`, { using: 'css selector', value: selector });
const click = async selector => {
  await until(() => execute(selector => {
    const element = document.querySelector(selector);
    return element && !element.disabled;
  }, selector), 'enabled click target ' + selector);
  const element = await until(() => locate(selector), `click target ${selector}`);
  return request(`/session/${session}/element/${element[elementKey]}/click`, {});
};
async function until(read, label, timeout = 45_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    if (app?.exitCode != null || app?.signalCode != null) throw new Error(`Desktop exited while waiting for ${label}`);
    try { const value = await read(); if (value) return value; } catch (error) { if (error.fatal) throw error; last = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}: ${last ?? 'not ready'}`);
}
async function capture(name) {
  await execute(async () => {
    await Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  await writeFile(path.join(root, name), Buffer.from(await request('/session/' + session + '/screenshot'), 'base64'));
}
async function start() {
  const log = await open(path.join(root, `desktop-${++generation}.log`), 'w');
  app = spawn(binary, [], { cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
    OPENBITFUN_USER_ROOT: userRoot, OPENBITFUN_E2E_USER_ROOT: userRoot,
    OPENBITFUN_HOME: productHome, OPENBITFUN_E2E_HOME: productHome,
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: frontend, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_E2E_SUBSCRIPTION_CA_FILE: provider.certificate,
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  } });
  await once(app, 'spawn');
  await log.close();
  await until(() => request('/status'), 'embedded WebDriver');
  const created = await request('/session', {});
  session = created.sessionId;
  await until(() => execute(() => Boolean(window.__TAURI_INTERNALS__?.invoke && document.querySelector('[data-testid=nav-footer-settings-item]'))), 'native app shell');
}
async function stop() {
  if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  session = null;
  if (app && app.exitCode == null && app.signalCode == null) {
    const exited = once(app, 'exit'); app.kill('SIGTERM'); await exited;
  }
}
const readModels = () => invoke('get_config', { path: 'ai.models' });
const statistics = () => invoke('get_token_usage_statistics', { timeRange: 'all', granularity: 'day', includeSubagent: true });
async function reloadShell() {
  const previous = await execute(() => performance.timeOrigin);
  await execute(() => location.reload()).catch(() => {});
  await until(() => execute(previous => performance.timeOrigin !== previous
    && Boolean(document.querySelector('[data-testid=nav-footer-settings-item]')), previous), 'reloaded shell');
}
async function openSettings(page) {
  await click('[data-testid=nav-footer-settings-item]');
  await until(() => locate('[data-testid=nav-settings-open-item]'), 'settings menu');
  await click('[data-testid=nav-settings-open-item]');
  await until(() => locate(`[data-testid=settings-nav-page][data-settings-page="${page}"]`), 'settings navigation');
  await click(`[data-testid=settings-nav-page][data-settings-page="${page}"]`);
}
async function choose(selector, index, label) {
  const control = `${selector} [role=combobox]`;
  await until(() => execute((selector, index) => {
    const control = document.querySelectorAll(selector)[index];
    return Boolean(control && !control.disabled);
  }, control, index), `enabled select ${control}`);
  const elements = await request(`/session/${session}/elements`, { using: 'css selector', value: control });
  assert.ok(elements[index], `Missing ${control} number ${index}`);
  await request(`/session/${session}/element/${elements[index][elementKey]}/click`, {});
  const option = await until(() => execute(label => [...document.querySelectorAll('[role=option]')].find(option => option.textContent?.includes(label)) ?? null, label), `option ${label}`);
  await request(`/session/${session}/element/${option[elementKey]}/click`, {});
}
async function submit(text) {
  console.log('Native scenario: ' + text.split(':')[0]);
  await until(async () => {
    const state = await execute(text => {
      const input = document.querySelector('[data-testid=chat-input-textarea]');
      const send = document.querySelector('[data-testid=chat-input-send-btn]');
      return { editable: Boolean(input?.isContentEditable || (input && 'value' in input && !input.disabled)),
        matches: (input?.value ?? input?.textContent)?.trim() === text, ready: Boolean(send && !send.disabled) };
    }, text);
    if (!state.editable) return false;
    if (!state.matches) {
      const input = await locate('[data-testid=chat-input-textarea]');
      await request('/session/' + session + '/element/' + input[elementKey] + '/clear', {});
      await request('/session/' + session + '/element/' + input[elementKey] + '/value', { text });
      return false;
    }
    return state.ready;
  }, 'composer state ready');
  await click('[data-testid=chat-input-send-btn]');
}
async function send(text, expected) {
  await submit(text);
  await until(async () => {
    const state = await execute(expected => ({ complete: Boolean(document.querySelector('[data-testid=flowchat-message-list]')?.textContent.includes(expected)) && !document.querySelector('[data-testid=chat-input-cancel-btn]'),
      approve: Boolean(document.querySelector('[data-testid=chat-input-approval-allow]')) }), expected);
    if (state.approve) await click('[data-testid=chat-input-approval-allow]');
    return state.complete;
  }, expected, 120_000);
}

try {
  await start();
  await invoke('set_config', { path: 'app.ai_experience.enable_session_title_generation', value: false });
  await invoke('set_config', { path: 'app.ai_experience.enable_welcome_panel_ai_analysis', value: false });
  const before = await invoke('list_subscription_account_instances');
  assert.ok(before.every(account => !account.account.connected), 'Fresh application must not see normal-profile credentials');
  const accounts = ['codex', `codex-account-${randomUUID()}`];
  for (const [index, accountId] of accounts.entries()) {
    const sessionId = randomUUID();
    const login = await invoke('start_subscription_account_login', { provider: 'codex', accountId, sessionId, method: 'browser' });
    const authorization = new URL(login.authorization_url);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname));
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', index ? 'mock-seat-two' : 'mock-seat-one');
    await fetch(callback, { signal: AbortSignal.timeout(10_000) });
    await until(async () => {
      const status = await invoke('get_subscription_login_status', { provider: 'codex', sessionId });
      if (status.status === 'failed') throw Object.assign(new Error(status.error ?? 'Mock OAuth failed'), { fatal: true });
      return status.status === 'authorized';
    }, `OAuth slot ${index + 1}`);
  }
  const loggedIn = await invoke('list_subscription_account_instances');
  assert.equal(loggedIn.filter(account => account.account.connected).length, 2);
  const authMetadata = await readFile(path.join(userRoot, 'data', 'subscription_auth.json'), 'utf8');
  assert.ok(!authMetadata.includes('synthetic-refresh'), 'Metadata must not contain OAuth secrets');
  assert.ok((await stat(path.join(userRoot, 'data', 'subscription_auth_vault.json'))).size > 0);
  report.checks.push('Two OAuth logins use actual native commands and isolated encrypted vault');

  const base = { enabled: true, context_window: 128000, max_tokens: 1024, capabilities: ['text_chat', 'function_calling'] };
  const models = [
    { ...base, id: 'subscription-channel', name: 'Mock subscription', provider: 'responses', model_name: 'gpt-5.5',
      base_url: 'https://chatgpt.com/backend-api/codex', skip_ssl_verify: true,
      auth: { type: 'subscription_pool', provider: 'codex', accounts, revision: 1 } },
    ...['key-one', 'key-two'].map(id => ({ ...base, id, name: id, provider: 'anthropic', model_name: `${id}-model`,
      base_url: provider.url, request_url: `${provider.url}/${id}`, api_key: `synthetic-${id}`, auth: { type: 'api_key' } })),
  ];
  await invoke('set_config', { path: 'ai.models', value: models, expectedModels: await readModels() });
  await invoke('set_config', { path: 'ai.default_models', value: { primary: 'subscription-channel', fast: 'key-two' } });
  // Setup used native commands rather than the frontend config manager.
  // Hydrate the shell from those saved facts before driving the real editor.
  await reloadShell();
  await openSettings('ai.models');
  await until(() => locate('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]'), 'subscription editor');
  await click('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]');
  const routeEditor = '[data-testid=model-channel-routing-editor]';
  await until(() => locate(routeEditor), 'channel editor');
  await choose(routeEditor, 0, 'key-one');
  await choose(routeEditor, 0, 'key-two');
  await execute(() => document.querySelector('[data-testid=model-usage-sources]')?.scrollIntoView({ block: 'start' }));
  await capture('channel-routing.png');
  await click('[data-testid=settings-model-save-btn]');
  const saved = await until(async () => { const models = await readModels(); return models.find(model => model.id === 'subscription-channel')?.channel_routing ? models : null; }, 'real UI route save');
  assert.deepEqual(saved.find(model => model.id === 'subscription-channel').channel_routing.fallback_model_ids, ['key-one', 'key-two']);
  report.checks.push('Production channel editor saves ordered cross-provider backups through actual config command');
  const importButton = await until(() => execute(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Import') ?? null), 'subscription manager');
  await request('/session/' + session + '/element/' + importButton[elementKey] + '/click', {});
  await until(() => locate('[data-openbitfun-part=subscriptionAccountCard]'), 'account cards');
  await capture('subscription-accounts.png');
  await reloadShell();


  const opened = await invoke('open_workspace', { path: workspace });
  await invoke('set_active_workspace', { workspaceId: opened.id });
  await reloadShell();
  await until(() => locate('[data-testid=nav-workspace-new-session-btn]'), 'workspace navigation');
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_FIRST: Read seed.txt once and report its content.', 'POOL_FIRST_COMPLETE');
  provider.continue();
  await send('POOL_CONTINUE: Preserve the read result, append pool-mutation once to pool-output.txt, then finish.', 'POOL_COMPLETE');
  assert.equal(await readFile(path.join(workspace, 'pool-output.txt'), 'utf8'), 'pool-mutation\n');
  const attempts = provider.requests.filter(request => request.phase === 'continue');
  assert.deepEqual(attempts.map(request => request.channel), ['subscription-channel', 'subscription-channel', 'key-one', 'key-two', 'key-two']);
  assert.deepEqual(attempts.slice(0, 2).map(request => request.seat), ['seat-one', 'seat-two']);
  assert.equal(attempts[2].key, 'synthetic-key-one');
  assert.equal(attempts[3].key, 'synthetic-key-two');
  for (const request of attempts) assert.ok(JSON.stringify(request.body).includes('pool-seed-history'), 'Actual read result must survive every failover');
  let stats = await until(async () => { const value = await statistics(); return value.recentAttempts?.length >= 7 ? value : null; }, 'native attempt statistics');
  report.statistics = stats;
  const sessionId = stats.recentAttempts[0].sessionId;
  const round = stats.recentAttempts.filter(attempt => attempt.turnId === stats.recentAttempts.find(attempt => attempt.outcome === 'failed').turnId);
  assert.equal(round.filter(attempt => attempt.outcome === 'failed').length, 3);
  assert.equal(stats.unknownUsageRequests, 3);
  assert.equal(stats.totalTokens, 100);
  assert.equal(stats.byChannel.filter(channel => channel.requests > 0).length, 3);
  report.checks.push('Historical native turn fails over A1 → A2 → key1 → key2; real append executes once; actual ledger records seven sends including tool rounds');
  report.statistics = stats;
  await openSettings('data.usage');
  await until(() => execute(() => {
    const section = document.querySelector('[data-testid=usage-channel-section]');
    return section?.textContent.includes('key-one') && section.textContent.includes('key-two')
      && document.querySelectorAll('[data-testid=usage-attempt]').length === 5;
  }), 'actual usage page channel distribution');
  await click('[data-testid=usage-attempt] ~ button[aria-expanded=false]');
  await until(() => execute(() => document.querySelectorAll('[data-testid=usage-attempt]').length === 7), 'expanded actual attempt details');
  report.checks.push('Actual usage settings page renders recorded channels and all seven attempts');
  await saveReport();

  await stop(); await start();
  const restored = await statistics();
  assert.equal(restored.totalTokens, stats.totalTokens);
  assert.equal(restored.totalRequests, stats.totalRequests);
  assert.deepEqual((await readModels()).find(model => model.id === 'subscription-channel').channel_routing.fallback_model_ids, ['key-one', 'key-two']);
  await until(() => locate(`[data-testid=nav-session-item][data-session-id="${sessionId}"]`), 'restored session');
  await click(`[data-testid=nav-session-item][data-session-id="${sessionId}"]`);
  await until(() => execute(() => document.body.innerText.includes('POOL_COMPLETE')), 'restored conversation');
  const afterHydrate = await statistics();
  assert.equal(afterHydrate.totalRequests, stats.totalRequests);
  assert.equal(afterHydrate.totalTokens, stats.totalTokens);
  assert.equal(await readFile(path.join(workspace, 'pool-output.txt'), 'utf8'), 'pool-mutation\n');
  report.checks.push('Full native product restart retains configuration, conversation and actual usage without recounting');

  await openSettings('ai.models');
  await until(() => locate('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]'), 'restored model editor');
  await click('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]');
  await until(() => locate(routeEditor), 'manual channel editor');
  await click('[data-testid=model-channel-advanced] button[aria-expanded]');
  await choose(routeEditor, 1, 'key-two');
  await click('[data-testid=settings-model-save-btn]');
  await until(async () => (await readModels()).find(model => model.id === 'subscription-channel')?.channel_routing?.manual_channel === 'key-two', 'actual manual route save');
  const manualStart = provider.requests.length;
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_MANUAL: Reply briefly without using tools.', 'POOL_COMPLETE');
  assert.deepEqual(provider.requests.slice(manualStart).map(request => request.channel), ['key-two']);
  assert.equal(await readFile(path.join(workspace, 'pool-output.txt'), 'utf8'), 'pool-mutation\n');
  report.checks.push('Actual manual channel editor confines a new native turn to key2');

  provider.deny();
  const deniedStart = provider.requests.length;
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_MANUAL_DENIED: Reply briefly without using tools.', 'Model quota unavailable');
  await click('[data-openbitfun-component=turn-failure-notice][data-openbitfun-part=toggle]');
  assert.ok(await execute(() => document.querySelector('[data-openbitfun-component=turn-failure-notice][data-openbitfun-part=rawError]')?.textContent.includes('Fixture quota exhausted')));
  assert.deepEqual(provider.requests.slice(deniedStart).map(request => request.channel), ['key-two']);
  const deniedStats = await statistics();
  assert.equal(deniedStats.totalRequests, stats.totalRequests + 2);
  assert.equal(deniedStats.unknownUsageRequests, stats.unknownUsageRequests + 1);
  assert.equal(deniedStats.totalTokens, stats.totalTokens + 25);
  report.checks.push('Quota rejection on a manual channel stops after one send and is recorded as unknown usage; no automatic spillover');

  await openSettings('ai.models');
  await click('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]');
  await until(() => locate(routeEditor), 'automatic route editor');
  await click(`${routeEditor} [role=switch]`);
  await click('[data-testid=settings-model-save-btn]');
  await until(async () => !(await readModels()).find(model => model.id === 'subscription-channel')?.channel_routing?.manual_channel, 'restored automatic route');
  provider.signed();
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_SIGNED: Reply briefly without using tools.', 'POOL_SIGNED_COMPLETE');
  const signedRestartSession = (await statistics()).recentAttempts[0].sessionId;
  const signedBeforeRestart = await statistics();
  await stop(); await start();
  await until(() => locate(`[data-testid=nav-session-item][data-session-id="${signedRestartSession}"]`), 'signed session after product restart');
  await click(`[data-testid=nav-session-item][data-session-id="${signedRestartSession}"]`);
  await until(() => execute(() => document.querySelector('[data-testid=flowchat-message-list]')?.textContent.includes('POOL_SIGNED_COMPLETE')), 'restored signed conversation');
  assert.equal((await statistics()).totalRequests, signedBeforeRestart.totalRequests);
  report.checks.push('A separate full product restart restores signed conversation provenance without recounting attempts');
  provider.deny();
  const boundStart = provider.requests.length;
  await send('POOL_SIGNED_CONTINUE: Continue this conversation.', 'This conversation requires its original channel');
  const boundRequests = provider.requests.slice(boundStart);
  assert.deepEqual(boundRequests.map(request => request.channel), ['key-two']);
  assert.ok(JSON.stringify(boundRequests[0].body).includes('mock-signed-state'));
  assert.ok(JSON.stringify(boundRequests[0].body).includes('Fixture signed reasoning'));
  report.checks.push('Automatic pool keeps signed history on its proven channel; quota failure preserves the exact signature and shows the recovery limitation');

  const signedSession = (await statistics()).recentAttempts[0].sessionId;
  await openSettings('ai.models');
  await click('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]');
  await until(() => locate(routeEditor), 'manual replay constraint editor');
  await click('[data-testid=model-channel-advanced] button[aria-expanded]');
  await choose(routeEditor, 1, 'key-one');
  await click('[data-testid=settings-model-save-btn]');
  await until(async () => (await readModels()).find(model => model.id === 'subscription-channel')?.channel_routing?.manual_channel === 'key-one', 'saved incompatible manual selection');
  await click(`[data-testid=nav-session-item][data-session-id="${signedSession}"]`);
  const priorNotices = await execute(() => document.querySelectorAll('[data-openbitfun-component=turn-failure-notice][data-openbitfun-part=root]').length);
  const manualBoundStart = provider.requests.length;
  await submit('POOL_MANUAL_BOUND: Continue without dropping the signed history.');
  await until(() => execute(previous => document.querySelectorAll('[data-openbitfun-component=turn-failure-notice][data-openbitfun-part=root]').length > previous
    && !document.querySelector('[data-testid=chat-input-cancel-btn]'), priorNotices), 'manual replay refusal');
  assert.equal(provider.requests.length, manualBoundStart, 'Manual selection cannot bypass signed-history provenance');
  assert.ok(await execute(() => [...document.querySelectorAll('[data-openbitfun-component=turn-failure-notice][data-openbitfun-part=title]')].at(-1)?.textContent.includes('This conversation requires its original channel')));
  report.checks.push('An incompatible manual selection refuses signed history before HTTP and exposes the same specific recovery explanation');
  await openSettings('ai.models');
  await click('[data-testid=settings-model-row][data-config-id=subscription-channel] button[aria-label=Edit]');
  await until(() => locate(routeEditor), 'restore automatic editor');
  await click(`${routeEditor} [role=switch]`);
  await click('[data-testid=settings-model-save-btn]');
  await until(async () => !(await readModels()).find(model => model.id === 'subscription-channel')?.channel_routing?.manual_channel, 'automatic route after manual refusal');

  provider.partial();
  await click('[data-testid=nav-workspace-new-session-btn]');
  const partialStart = provider.requests.length;
  await send('POOL_PARTIAL: Reply briefly without using tools.', 'Model quota unavailable');
  assert.equal(provider.requests.length, partialStart + 1, 'Effective output must prevent cross-candidate replay');
  assert.ok(await execute(() => document.querySelector('[data-testid=flowchat-message-list]')?.textContent.includes('POOL_PARTIAL_OUTPUT')));
  report.checks.push('A deterministic quota rejection after partial output remains an error and does not cross to another candidate');

  provider.hold();
  await click('[data-testid=nav-workspace-new-session-btn]');
  const beforeCancel = await statistics();
  const cancelledStart = provider.requests.length;
  const closedBefore = provider.cancelledStreams;
  await submit('POOL_CANCEL: Wait for my next instruction.');
  await until(() => provider.requests.length === cancelledStart + 1, 'held real model request');
  await click('[data-testid=chat-input-cancel-btn]');
  await until(() => provider.cancelledStreams === closedBefore + 1, 'released provider connection');
  const cancelled = await until(async () => { const value = await statistics(); return value.totalRequests === beforeCancel.totalRequests + 1 ? value : null; }, 'cancelled attempt ledger');
  assert.equal(provider.requests.length, cancelledStart + 1, 'Cancellation must not invoke a backup');
  assert.equal(cancelled.unknownUsageRequests, beforeCancel.unknownUsageRequests + 1);
  assert.ok(cancelled.recentAttempts.some(attempt => attempt.outcome === 'cancelled'));
  report.checks.push('Actual UI cancellation releases the HTTP stream, records unknown usage and makes no backup request');

  provider.healthy();
  await invoke('set_subscription_account_enabled', { provider: 'codex', accountId: accounts[0], enabled: false });
  const disabledStart = provider.requests.length;
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_DISABLED: Reply briefly without using tools.', 'POOL_HEALTHY_COMPLETE');
  assert.deepEqual(provider.requests.slice(disabledStart).map(request => [request.channel, request.seat]), [['subscription-channel', 'seat-two']]);
  await invoke('logout_subscription_account_instance', { provider: 'codex', accountId: accounts[0] });
  await invoke('set_subscription_account_enabled', { provider: 'codex', accountId: accounts[0], enabled: true });
  const loggedOut = (await invoke('list_subscription_account_instances')).find(account => account.account_id === accounts[0]);
  assert.equal(loggedOut.account.connected, false, 'Re-enabling must not revive logged-out credentials');
  assert.equal(loggedOut.upstream_account_id, 'seat-one', 'Logout retains the original seat metadata');
  const logoutStart = provider.requests.length;
  await click('[data-testid=nav-workspace-new-session-btn]');
  await send('POOL_LOGGED_OUT: Reply briefly without using tools.', 'POOL_HEALTHY_COMPLETE');
  assert.deepEqual(provider.requests.slice(logoutStart).map(request => [request.channel, request.seat]), [['subscription-channel', 'seat-two']]);
  assert.equal(await readFile(path.join(workspace, 'pool-output.txt'), 'utf8'), 'pool-mutation\n');
  report.checks.push('Native disable and logout skip A1; re-enable does not revive its credentials or remove its original identity');
  await verifyProviderAccountPools({ invoke, until, readModels, reloadShell, click, send, statistics, provider, report });
  await openSettings('ai.models');
  const finalManager = await until(() => execute(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Import') ?? null), 'all-provider account manager');
  await request('/session/' + session + '/element/' + finalManager[elementKey] + '/click', {});
  await until(() => locate('[data-openbitfun-part=subscriptionAccountCard]'), 'all-provider account cards');
  await capture('all-provider-accounts.png');
  report.providerRequests = provider.services.requests;
  report.finalStatistics = await statistics();
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
  if (session) report.visibleText = await execute(() => document.body.innerText).catch(() => null);
  process.exitCode = 1;
} finally {
  report.requests = provider.requests;
  report.providerRequests = provider.services.requests;
  await saveReport();
  await stop(); await provider.close();
  if (process.env.OPENBITFUN_E2E_KEEP_SNAPSHOT !== '1') {
    await rm(binary, { force: true });
    await rm(frontend, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error, artifactRoot: root }, null, 2));
}
