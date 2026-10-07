import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbeddedConfig } from './embedded-driver';

// Opt-in recorded data. Live sends additionally require an explicit model/config.
const recorded = process.env.OPENBITFUN_FLOWCHAT_RECORDED_SESSIONS;
const ids = process.env.OPENBITFUN_FLOWCHAT_SESSION_IDS?.split(',').filter(Boolean) ?? [];
if (!recorded || ids.length < 2) throw new Error('Set OPENBITFUN_FLOWCHAT_RECORDED_SESSIONS and at least two OPENBITFUN_FLOWCHAT_SESSION_IDS.');
const root = process.env.OPENBITFUN_FLOWCHAT_E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'openbitfun-flowchat-e2e-'));
const home = join(root, 'home');
const destination = join(home, 'projects', basename(resolve(recorded, '..')), 'sessions');
mkdirSync(destination, { recursive: true });
if (!existsSync(join(destination, 'index.json'))) {
  const metadata = ids.map(id => {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid recorded session id');
    const session = join(recorded, id);
    const value = JSON.parse(readFileSync(join(session, 'metadata.json'), 'utf8'));
    cpSync(session, join(destination, id), { recursive: true });
    return value;
  });
  writeFileSync(join(destination, 'index.json'), JSON.stringify({ schema_version: metadata[0].schema_version,
    updated_at: Date.now(), metadata_file_count: metadata.length, sessions: metadata }));
}
Object.assign(process.env, {
  OPENBITFUN_FLOWCHAT_E2E_ROOT: root,
  OPENBITFUN_E2E_STORAGE_ROOT: root, OPENBITFUN_E2E_HOME: home, OPENBITFUN_HOME: home,
  OPENBITFUN_E2E_USER_ROOT: join(root, 'user'), OPENBITFUN_USER_ROOT: join(root, 'user'),
  OPENBITFUN_E2E_LOG_DIR: join(root, 'logs'), OPENBITFUN_E2E_STORAGE_GUARD: '1',
  OPENBITFUN_E2E_PACKAGED_FRONTEND: '1',
  OPENBITFUN_E2E_FRONTEND_DIR: resolve(fileURLToPath(new URL('../../../dist', import.meta.url))),
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
});
console.log(`FlowChat desktop evidence: ${root}`);
const liveConfig = process.env.OPENBITFUN_FLOWCHAT_LIVE_CONFIG;
const liveModelId = process.env.OPENBITFUN_FLOWCHAT_LIVE_MODEL_ID;
if (Boolean(liveConfig) !== Boolean(liveModelId)) throw new Error('Live FlowChat requires both a config path and model id.');
const isolatedConfig = join(root, 'user', 'config', 'app.json');
if (liveConfig && liveModelId) {
  const source = JSON.parse(readFileSync(liveConfig, 'utf8'));
  const model = source.ai.models.find((value: { id: string; enabled: boolean; api_key?: string }) => value.id === liveModelId && value.enabled && value.api_key);
  if (!model) throw new Error('Live FlowChat requires an enabled API-key model; subscription refresh credentials are not copied.');
  mkdirSync(join(root, 'user', 'config'), { recursive: true });
  writeFileSync(isolatedConfig, JSON.stringify({
    product_id: source.product_id, schema_version: source.schema_version, version: source.version, last_modified: Date.now(),
    editor: source.editor, terminal: source.terminal, workspace: source.workspace, appearance: source.appearance,
    ai: { models: [model], default_models: { primary: model.id, fast: model.id }, proxy: source.ai.proxy },
    app: { language: source.app.language, logging: { flow_chat_diagnostics: true } },
  }));
}
if (process.env.OPENBITFUN_FLOWCHAT_CDP_PORT) {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    `--remote-debugging-port=${Number(process.env.OPENBITFUN_FLOWCHAT_CDP_PORT)}`].filter(Boolean).join(' ');
}
export const config = createEmbeddedConfig([
  liveConfig ? '../specs/flowchat-streaming-native.spec.ts' : '../specs/flowchat-native.spec.ts',
], 'FlowChat native');
if (liveConfig) config.mochaOpts = { ...config.mochaOpts, timeout: 360000 };
const finish = config.onComplete;
config.onComplete = async function (...args) {
  try { if (typeof finish === 'function') await finish.apply(this, args); }
  finally {
    // Retain geometry/log evidence, never the credential used for an opt-in send.
    if (liveConfig && existsSync(isolatedConfig)) {
      const value = JSON.parse(readFileSync(isolatedConfig, 'utf8'));
      if (value.ai) value.ai.models = [];
      writeFileSync(isolatedConfig, JSON.stringify(value));
    }
  }
};
