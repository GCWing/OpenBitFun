// Disposable Chromium -> production ControlHub -> DOM/ref/readiness/result contracts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireE2e = createRequire(new URL('../tests/e2e/package.json', import.meta.url));
const requireWdio = createRequire(requireE2e.resolve('@wdio/cli'));
const puppeteer = requireWdio('puppeteer-core');
let pageRequests = 0;
const server = createServer((request, response) => {
  if (request.url === '/api') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ message: 'fixture-response' }));
    return;
  }
  if (new URL(request.url, 'http://fixture').pathname !== '/') { response.writeHead(404).end(); return; }
  pageRequests += 1;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Browser workflow</title><main>
    <label for="name">Name</label><input id="name"><button id="apply">Apply</button>
    <p id="status">Ready</p><p>${'Content '.repeat(100)} BODY_AFTER_EXCERPT</p>
    <div style="height:1800px">Tall page</div></main>
    <script>document.querySelector('#apply').onclick = () => {
      document.querySelector('#status').textContent = 'Saved: ' + document.querySelector('#name').value;
    };</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let otherBrowser;
async function closeFixtureBrowser(instance) {
  if (!instance) return;
  const child = instance.process();
  try {
    await instance.close();
  } finally {
    // Chrome crash/update helpers can inherit stderr after the browser exits.
    // Release only our pipes; those unrelated helpers do not keep this test alive.
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  }
}
try {
  browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: 'new',
  });
  const existing = (await browser.pages())[0];
  await existing.goto('data:text/html,<title>Unrelated fixture tab</title><p>Preserve me</p>');
  const existingUrl = existing.url();
  otherBrowser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: 'new',
  });
  const testName = 'agentic::tools::implementations::control_hub_tool::browser_workflow_tests::real_browser_workflow';
  const args = ['--ignored', '--exact', testName, '--nocapture'];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENBITFUN_TEST_BINARY || 'cargo', process.env.OPENBITFUN_TEST_BINARY ? args : [
      'test', '-p', 'openbitfun-core', '--no-default-features', '--features',
      'agent-runtime,tools-browser-web,tools-computer-use,git', '--lib', 'real_browser_workflow', '--', ...args,
    ], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: {
        ...process.env,
        OPENBITFUN_BROWSER_TEST_WS: browser.wsEndpoint(),
        OPENBITFUN_BROWSER_TEST_PORT: new URL(browser.wsEndpoint()).port,
        OPENBITFUN_OTHER_BROWSER_TEST_PORT: new URL(otherBrowser.wsEndpoint()).port,
        OPENBITFUN_BROWSER_TEST_URL: `http://127.0.0.1:${server.address().port}/`,
      },
    });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
  assert.equal(exitCode, 0, 'production browser workflow must pass');
  assert.equal(existing.url(), existingUrl, 'first navigation must preserve unrelated tabs');
  assert.equal(pageRequests, 2, 'one initial navigation and one explicit legacy read; no setup/recovery replays');
  console.log('PASS production ControlHub workflow, unrelated tab preservation, and exact navigation count');
} finally {
  try {
    await Promise.all([closeFixtureBrowser(otherBrowser), closeFixtureBrowser(browser)]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
