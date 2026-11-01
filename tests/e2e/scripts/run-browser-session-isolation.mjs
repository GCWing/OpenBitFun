/** Native multi-session browser regression. Only model HTTP responses are scripted. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const backgroundOnly = process.env.OPENBITFUN_E2E_BACKGROUND_ONLY === '1';
const root = await mkdtemp(path.join(tmpdir(), 'openbitfun-browser-sessions-'));
const userRoot = path.join(root, 'user');
const productHome = path.join(root, 'home');
const frontend = path.join(root, 'frontend');
const frontendSource = path.resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist'));
const manifest = await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8');
await cp(frontendSource, frontend, { recursive: true });
assert.equal(await readFile(path.join(frontendSource, 'frontend-revision.json'), 'utf8'), manifest,
  'The frontend changed during the snapshot. Finish the build and rerun.');
await mkdir(userRoot, { recursive: true });
await mkdir(productHome, { recursive: true });
const binaryName = 'openbitfun-desktop' + (process.platform === 'win32' ? '.exe' : '');
const binarySource = path.resolve(process.env.OPENBITFUN_E2E_DESKTOP_BINARY || path.join(repo, 'target/debug', binaryName));
const binary = path.join(root, binaryName);
const before = await stat(binarySource);
await cp(binarySource, binary);
const after = await stat(binarySource);
assert.equal(before.mtimeMs, after.mtimeMs, 'The Desktop binary changed during the snapshot. Rerun after the build.');
assert.equal(before.size, after.size);

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const log = await open(path.join(root, 'desktop.log'), 'w');

const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
const pendingModels = new Map();
const toolResults = new Map();
const fixtureErrors = [];
let fixtureUrl;
function respondModel(res, marker, tool) {
  const [owner, action] = marker.split('_');
  const input = { domain: 'browser', action: action === 'REOPEN' ? 'open_builtin' : action === 'OPEN' ? 'navigate' : action === 'CLICK' ? 'click' : 'read_article',
    params: action === 'REOPEN' ? { url: `${fixtureUrl}/pages/${owner.toLowerCase()}?replacement=1`, replace_existing: true, observe: 'article' }
      : action === 'OPEN' ? { target: 'builtin', url: `${fixtureUrl}/pages/${owner.toLowerCase()}`, observe: 'article' }
      : action === 'CLICK' ? { selector: '#next' } : {} };
  const events = [
    { type: 'message_start', message: { id: marker, type: 'message', role: 'assistant', model: 'browser-fixture', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: `browser-${marker}`, name: 'ControlHub', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: `BROWSER_${marker}_COMPLETE` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const fixture = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url, fixtureUrl);
    if (url.pathname.startsWith('/pages/')) {
      const owner = url.pathname.endsWith('/a') ? 'A' : 'B';
      const replacement = url.searchParams.has('replacement');
      if (replacement) await new Promise(resolve => setTimeout(resolve, 500));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Browser ${owner}</title><main><h1>SESSION_${owner}_PAGE</h1>${replacement ? '<p>REPLACEMENT_DOCUMENT</p>' : ''}<p>${('Session ' + owner + ' content. ').repeat(100)}</p><input id="draft" value="initial"><a id="next" target="_blank" href="?step=2">Next</a><script>window.pageInstance=Math.random();window.ticks=0;setInterval(()=>window.ticks++,100);</script></main>`);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const messages = body.messages ?? [];
    const markers = messages.filter(message => message.role === 'user').flatMap(message => {
      const text = typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      return [...text.matchAll(/BROWSER_([AB]_(?:OPEN|READ|CLICK|REOPEN))/g)].map(match => match[1]);
    });
    const marker = markers.at(-1);
    if (!marker) return respondModel(res, 'A_AUX', false);
    const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === `browser-${marker}`);
    if (result) {
      toolResults.set(marker, result);
      return respondModel(res, marker, false);
    }
    assert.ok((body.tools ?? []).some(tool => tool.name === 'ControlHub'), 'ControlHub must be available in the actual tool catalog');
    if (marker === 'A_OPEN' || marker.endsWith('_READ')) {
      // Hold A's open until the UI switches to B, and release both reads together.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': awaiting conversation switch\n\n');
      pendingModels.set(marker, () => respondModel(res, marker, true));
    } else respondModel(res, marker, true);
  } catch (error) {
    fixtureErrors.push(String(error));
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

const app = spawn(binary, [], {
  cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env,
    OPENBITFUN_USER_ROOT: userRoot, OPENBITFUN_E2E_USER_ROOT: userRoot,
    OPENBITFUN_HOME: productHome, OPENBITFUN_E2E_HOME: productHome,
    OPENBITFUN_E2E_STORAGE_GUARD: '1', OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
    OPENBITFUN_E2E_FRONTEND_DIR: frontend, OPENBITFUN_E2E_LOG_DIR: path.join(root, 'logs'),
    OPENBITFUN_WEBDRIVER_PORT: String(port), OPENBITFUN_WEBDRIVER_LABEL: 'main',
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
  },
});
console.log('Native browser session evidence: ' + root);
let exitError;
app.on('error', error => { exitError = error; });
let session;
const report = { passed: false, platform: process.platform, binarySource,
  binaryModified: before.mtime.toISOString(), frontendRevision: JSON.parse(manifest).revision,
  coverage: backgroundOnly ? 'background-and-panel-binding-only' : 'full-native-visibility', checks: [] };
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(endpoint + route, {
    method, signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || (result.value?.error && result.value?.ok === undefined)) throw new Error(JSON.stringify(result));
  return result.value;
}
async function until(read, description, timeout = 45_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    if (exitError) throw exitError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error('Desktop exited before ' + description);
    try { if (await read()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ' + description + ': ' + (last ?? 'not ready'));
}
const execute = (fn, ...args) => request('/session/' + session + '/execute/sync', { script: fn.toString(), args });
const invokeResult = (command, args = {}) => execute(async (command, args) => {
  try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) }; }
  catch (error) { return { ok: false, error: String(error) }; }
}, command, args);
const invoke = (command, args = {}) => invokeResult(command, args).then(result => {
  assert.equal(result.ok, true, command + ': ' + result.error);
  return result.value;
});

const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const locate = selector => request(`/session/${session}/element`, { using: 'css selector', value: selector });
async function click(selector) {
  const element = await locate(selector);
  await request(`/session/${session}/element/${element[elementKey]}/click`, {});
}
const selected = id => execute(id => Boolean(document.querySelector(`[data-testid="nav-session-item"][data-session-id="${id}"][data-session-active="true"]`)), id);
async function select(id) {
  if (!backgroundOnly) {
    await invoke('show_main_window');
    await until(() => execute(() => document.visibilityState === 'visible'), 'visible host window (unlock the desktop for full visibility coverage)');
  }
  await click(`[data-testid="nav-session-item"][data-session-id="${id}"]`);
  await until(() => selected(id), `selected conversation ${id}`);
}
async function tool(action, params = {}) {
  const result = await invoke('execute_tool', { request: { toolName: 'ControlHub', input: { domain: 'browser', action, params } } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.result.ok, true, JSON.stringify(result));
  return result.result.data;
}
async function pageState(id) {
  const data = await tool('evaluate', { target: 'builtin', session_id: id,
    expression: '({url:location.href,instance:window.pageInstance,ticks:window.ticks,draft:document.querySelector("#draft").value,visibility:document.visibilityState})' });
  return data.result.value;
}
async function presentation(activePage, hiddenPage) {
  await until(() => execute(label => {
    const panels = document.querySelectorAll('[data-testid=browser-panel]');
    return panels.length === 1 && panels[0].querySelector('[data-webview-label]')?.getAttribute('data-webview-label') === label;
  }, activePage), 'active panel bound to its own native target');
  if (!backgroundOnly) {
    await until(async () => (await pageState(activePage)).visibility === 'visible'
      && (await pageState(hiddenPage)).visibility === 'hidden', 'only selected session browser visible');
  } else {
    assert.equal((await pageState(hiddenPage)).visibility, 'hidden');
  }
}
async function turn(id, marker, workspaceId) {
  await invoke('start_dialog_turn', { request: { sessionId: id, userInput: `BROWSER_${marker}`, agentType: 'agentic', workspaceId } });
}
async function completed(marker) {
  await until(async () => {
    assert.deepEqual(fixtureErrors, []);
    return toolResults.has(marker);
  }, `browser tool result ${marker}`, 60_000);
  const result = JSON.stringify(toolResults.get(marker));
  if (!result.includes(`SESSION_${marker[0]}_PAGE`)) {
    console.log('Unexpected tool output', result);
    console.log('Native diagnostic', JSON.stringify(await tool('evaluate', { target: 'builtin',
      expression: '({url:location.href,ready:document.readyState,html:document.documentElement.outerHTML})' })));
    console.log('Article diagnostic', JSON.stringify(await tool('read_article', { target: 'builtin' })));
  }
  assert.ok(result.includes(`SESSION_${marker[0]}_PAGE`), `Wrong page in ${marker}: ${result}`);
}
try {
  await until(async () => (await request('/status')).ready, 'embedded driver');
  session = (await request('/session', {})).sessionId;
  await request(`/session/${session}/timeouts`, { script: 40000 });
  await until(() => execute(() => !!document.querySelector('[data-testid=nav-workspace-new-session-btn]')), 'workspace navigation');
  assert.deepEqual(await execute(() => ({ length: 2, textContent: 'Article metadata', items: [1, 2] })),
    { length: 2, textContent: 'Article metadata', items: [1, 2] }, 'Numeric length must not turn an object into a collection');
  const buttons = await execute(() => document.querySelectorAll('[data-testid=nav-workspace-new-session-btn]'));
  assert.ok(Array.isArray(buttons) && buttons.length > 0 && buttons.every(button => button[elementKey]),
    'Native DOM collections must retain WebDriver element serialization');
  report.checks.push('WebDriver preserves article-shaped objects and native DOM collections');
  const models = await invoke('get_config', { request: { path: 'ai.models' } });
  await invoke('set_config', { request: { path: 'ai.models', expectedModels: models, value: [{
    id: 'browser-fixture', name: 'Browser fixture', provider: 'anthropic', model_name: 'browser-fixture',
    base_url: fixtureUrl, request_url: `${fixtureUrl}/v1/messages`, api_key: 'isolated-fixture',
    auth: { type: 'api_key' }, enabled: true, context_window: 128000, max_tokens: 1024,
    capabilities: ['text_chat', 'function_calling'],
  }] } });
  await invoke('set_config', { request: { path: 'ai.default_models', value: { primary: 'browser-fixture', fast: 'browser-fixture' } } });
  await invoke('set_config', { request: { path: 'ai.enable_deferred_tool_loading', value: false } });
  await invoke('set_config', { request: { path: 'app.ai_experience.enable_session_title_generation', value: false } });
  await invoke('set_config', { request: { path: 'app.ai_experience.enable_welcome_panel_ai_analysis', value: false } });
  const opened = await invoke('open_workspace', { request: { path: workspace, createLocal: true } });
  await invoke('set_active_workspace', { request: { workspaceId: opened.id } });
  const a = randomUUID(), b = randomUUID();
  for (const [sessionId, name] of [[a, 'Browser A'], [b, 'Browser B']]) {
    await invoke('create_session', { request: { sessionId, sessionName: name, agentType: 'agentic',
      workspacePath: workspace, workspaceId: opened.id, config: { modelName: 'browser-fixture', safeMode: false } } });
  }
  await execute(() => { setTimeout(() => location.reload(), 0); return true; });
  await until(() => locate(`[data-testid="nav-session-item"][data-session-id="${a}"]`), 'persisted conversations');
  await select(a);
  await turn(a, 'A_OPEN', opened.id);
  await until(() => pendingModels.has('A_OPEN'), 'A waiting before its browser call');
  await select(b);
  pendingModels.get('A_OPEN')();
  await completed('A_OPEN');
  assert.equal(await selected(b), true, 'Background A must not change the active conversation');
  assert.equal(await execute(() => document.querySelectorAll('[data-testid=browser-panel]').length), 0, 'A must not appear in B');
  let inventory = await tool('list_pages', { target: 'builtin' });
  const aPage = inventory.pages.find(page => page.url.includes('/pages/a')).id;
  await turn(a, 'A_CLICK', opened.id);
  await until(() => toolResults.has('A_CLICK'), 'A background link click');
  await until(async () => (await pageState(aPage)).url.endsWith('?step=2'), 'new-window link stays in its conversation page');
  assert.equal(await selected(b), true);
  assert.equal(await execute(() => document.querySelectorAll('[data-testid=browser-panel]').length), 0);
  report.checks.push('A follows a new-window link in its own hidden page before ever mounting a panel');
  await turn(a, 'A_REOPEN', opened.id);
  await completed('A_REOPEN');
  assert.ok(JSON.stringify(toolResults.get('A_REOPEN')).includes('REPLACEMENT_DOCUMENT'),
    'A replacement read must observe the new document rather than the previous completed page');
  assert.equal((await tool('list_pages', { target: 'builtin' })).pages[0].id, aPage);
  report.checks.push('Replacing a hidden page waits for the new document and retains its native identity');
  const before = await pageState(aPage);
  assert.equal(before.visibility, 'hidden');
  report.checks.push('A opens and reads its native page in the background while B remains selected');
  await turn(b, 'B_OPEN', opened.id);
  await completed('B_OPEN');
  if (!backgroundOnly) await invoke('show_main_window');
  inventory = await tool('list_pages', { target: 'builtin' });
  const bPage = inventory.pages.find(page => page.url.includes('/pages/b')).id;
  assert.notEqual(aPage, bPage);
  await presentation(bPage, aPage);
  await tool('evaluate', { session_id: aPage, expression: 'document.querySelector("#draft").value="retained A draft"' });
  await turn(a, 'A_READ', opened.id);
  await turn(b, 'B_READ', opened.id);
  await until(() => pendingModels.has('A_READ') && pendingModels.has('B_READ'), 'both conversations ready for concurrent reads');
  pendingModels.get('A_READ')();
  pendingModels.get('B_READ')();
  await Promise.all([completed('A_READ'), completed('B_READ')]);
  report.checks.push('Both real Agent conversations read their own pages concurrently');
  for (const id of [a, b, a, b, a]) {
    await select(id);
    const visibleId = id === a ? aPage : bPage;
    const hiddenId = id === a ? bPage : aPage;
    await presentation(visibleId, hiddenId);
  }
  const after = await pageState(aPage);
  assert.equal(after.instance, before.instance, 'Switching must retain the original native document');
  assert.equal(after.draft, 'retained A draft');
  assert.ok(after.ticks > before.ticks, 'The hidden page must continue executing');
  const finalPages = await tool('list_pages', { target: 'builtin' });
  assert.equal(finalPages.pages.length, 2, 'Switching must not leak duplicate WebViews');
  report.checks.push('Repeated switches preserve page identity, edited DOM and background execution with exactly two WebViews');
  if (!backgroundOnly) report.checks.push('Only the active conversation native page is visible after every switch');
  await select(b);
  const bState = await pageState(bPage);
  await invoke('delete_session', { request: { sessionId: a, workspaceId: opened.id } });
  await until(async () => {
    const pages = (await tool('list_pages', { target: 'builtin' })).pages;
    return pages.length === 1 && pages[0].id === bPage;
  }, 'only A native resources released on deletion');
  assert.equal((await pageState(bPage)).instance, bState.instance);
  assert.equal(await selected(b), true);
  if (process.platform === 'darwin') {
    const unavailable = createServer();
    unavailable.listen(0, '127.0.0.1');
    await once(unavailable, 'listening');
    const failedUrl = `http://127.0.0.1:${unavailable.address().port}/`;
    await new Promise(resolve => unavailable.close(resolve));
    for (const [action, params] of [
      ['navigate', { url: failedUrl }],
      ['wait', { condition: 'load', timeout_ms: 15000 }],
    ]) {
      const failure = await invoke('execute_tool', { request: { toolName: 'ControlHub',
        input: { domain: 'browser', action, params: { target: 'builtin', session_id: bPage, ...params } } } });
      assert.equal(failure.result?.ok, false, JSON.stringify(failure));
      assert.equal(failure.result.error.code, 'NOT_AVAILABLE', JSON.stringify(failure));
      assert.match(failure.result.error.message, /Navigation failed/);
    }
    await until(() => execute(() => document.querySelector('[data-testid=browser-error-message]')
      ?.textContent.includes('Navigation failed')), 'native navigation error shown in the panel');
    const recovered = await tool('navigate', { target: 'builtin', session_id: bPage, url: `${fixtureUrl}/pages/b` });
    assert.equal(recovered.loaded, true);
    assert.equal(recovered.session_id, bPage);
    await until(() => execute(() => !document.querySelector('[data-testid=browser-error-message]')),
      'manual navigation clears the previous native failure');
    report.checks.push('Native navigation failure reaches tools and UI; explicit navigation recovers the same page');
  }
  await invoke('delete_session', { request: { sessionId: b, workspaceId: opened.id } });
  await until(async () => (await tool('list_pages', { target: 'builtin' })).pages.length === 0,
    'all native pages released after their conversations are deleted');
  report.checks.push('Deleting a conversation releases only its own page and leaves the other document intact');
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (session) {
    report.dom = await execute(() => ({ text: document.body.innerText,
      panels: [...document.querySelectorAll('[data-testid=browser-panel]')].map(panel => ({
        html: panel.outerHTML, rect: panel.getBoundingClientRect().toJSON(),
      })), visibility: document.visibilityState })).catch(String);
    const screenshot = await request(`/session/${session}/screenshot`).catch(() => null);
    if (typeof screenshot === 'string') await writeFile(path.join(root, 'failure.png'), Buffer.from(screenshot, 'base64'));
  }
  throw error;
} finally {
  report.fixtureErrors = fixtureErrors;
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
  if (app.exitCode === null && app.signalCode === null) {
    app.kill();
    await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  }
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await log.close();
  if (process.env.OPENBITFUN_E2E_KEEP_SNAPSHOT !== '1') {
    await rm(binary, { force: true });
    await rm(frontend, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...report, artifactRoot: root }));
}
