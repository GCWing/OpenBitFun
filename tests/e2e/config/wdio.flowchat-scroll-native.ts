import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbeddedConfig } from './embedded-driver';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = process.env.OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE || realpathSync(mkdtempSync(join(tmpdir(), 'openbitfun-flowchat-scroll-')));
if (process.platform === 'darwin' && !existsSync(join(root, 'process-baseline.json'))) {
  const processes = spawnSync('ps', ['-axo', 'pid='], { windowsHide: true, encoding: 'utf8' });
  if (processes.status !== 0) throw new Error('Cannot establish isolated process memory baseline');
  writeFileSync(join(root, 'process-baseline.json'), JSON.stringify(processes.stdout.trim().split(/\s+/).map(Number)));
}
const workspace = join(root, 'workspace');
const home = join(root, 'home');
const user = join(root, 'user');
if (!existsSync(join(root, 'frontend'))) {
  const source = resolve(process.env.OPENBITFUN_E2E_FRONTEND_DIR || join(repo, 'dist'));
  const revision = readFileSync(join(source, 'frontend-revision.json'), 'utf8');
  cpSync(source, join(root, 'frontend'), { recursive: true });
  if (revision !== readFileSync(join(source, 'frontend-revision.json'), 'utf8')) throw new Error('Frontend changed during snapshot');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# FlowChat scroll fixture\n');
  const fixture = spawnSync(process.execPath, [join(repo, 'tests/e2e/scripts/generate-long-session-fixture.mjs'),
    '--workspace', workspace, '--openbitfun-home', home, '--openbitfun-user-root', user,
    '--session-prefix', 'scroll-history', '--session-count', '2',
    '--long-turns', process.env.OPENBITFUN_SCROLL_TURNS || '80',
    '--scenario', process.env.OPENBITFUN_SCROLL_SCENARIO || 'mixed-visible',
    '--dense-groups', process.env.OPENBITFUN_SCROLL_DENSE_GROUPS || '160',
    '--assistant-chars', process.env.OPENBITFUN_SCROLL_TEXT_CHARS || '4000',
    '--tool-items', '3', '--tool-result-chars', '6000',
  ], { cwd: repo, windowsHide: true, encoding: 'utf8' });
  if (fixture.status !== 0) throw new Error(fixture.stderr || fixture.stdout);
}
Object.assign(process.env, {
  OPENBITFUN_FLOWCHAT_SCROLL_EVIDENCE: root,
  OPENBITFUN_E2E_STORAGE_ROOT: root, OPENBITFUN_E2E_HOME: home, OPENBITFUN_HOME: home,
  OPENBITFUN_E2E_USER_ROOT: user, OPENBITFUN_USER_ROOT: user,
  OPENBITFUN_E2E_LOG_DIR: join(root, 'logs'), OPENBITFUN_E2E_STORAGE_GUARD: '1',
  OPENBITFUN_E2E_PACKAGED_FRONTEND: '1', OPENBITFUN_E2E_FRONTEND_DIR: join(root, 'frontend'),
  E2E_TEST_WORKSPACE: workspace,
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
});
console.log(`FlowChat scroll evidence: ${root}`);
export const config = createEmbeddedConfig([process.env.OPENBITFUN_SCROLL_OPEN === '1'
  ? '../specs/flowchat-open-native.spec.ts' : process.env.OPENBITFUN_SCROLL_PAINT === '1'
  ? '../specs/flowchat-paint-native.spec.ts' : process.env.OPENBITFUN_SCROLL_STREAMING === '1'
  ? '../specs/flowchat-stream-performance.spec.ts' : '../specs/flowchat-scroll-native.spec.ts'], 'FlowChat scroll');

// WDIO wraps tests with the configured timeout as well as Mocha's own timer.
config.mochaOpts = { ...config.mochaOpts, timeout: Math.max(120000, Number(process.env.OPENBITFUN_SCROLL_CYCLES || 4) * 5000 + Number(process.env.OPENBITFUN_SCROLL_IDLE_MS || 0)) };
if (process.env.OPENBITFUN_SCROLL_MEMORY_IN_PAGE === '1') {
  config.connectionRetryTimeout = config.mochaOpts.timeout;
}
