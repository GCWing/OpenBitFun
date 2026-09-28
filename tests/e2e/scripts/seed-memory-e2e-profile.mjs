#!/usr/bin/env node
/**
 * Seed the isolated E2E sandbox with a working AI configuration.
 *
 * The desktop E2E harness redirects the app under test into
 * `tests/e2e/.openbitfun/runtime` (see `config/embedded-driver.ts`), which starts
 * as an empty profile. Chat turns need a real provider, so this script copies ONLY
 * the `ai` section from the developer's real OpenBitFun config into the sandbox
 * config file, and deliberately drops every other section.
 *
 * `memories` is never copied: the memory spec asserts the *true* defaults of a
 * fresh profile (memory off), so the seeded file must not contain a `memories`
 * key at all.
 *
 * The seeded document is `{ app: { language }, ai }`. `app.language` is the one
 * field the host requires to accept a config that carries no product metadata:
 * `validate_current_config_value` rejects a document without `product_id` /
 * `schema_version` / `version` / `last_modified`, and the host then repairs the
 * sparse installer shape, which only understands `app.language`, `themes.current`
 * and `ai`. Everything else (including `memories`) is rebuilt from host defaults,
 * which is exactly the fresh-profile state this spec needs. The host rewrites the
 * file in the full schema on first start.
 *
 * The config service caches the file at startup, so run this BEFORE `wdio run`.
 *
 * Usage:
 *   node ./scripts/seed-memory-e2e-profile.mjs [--keep] [--source=<path>]
 *
 *   --keep           keep the existing sandbox runtime instead of wiping it
 *   --source=<path>  read the source config from an explicit path
 *
 * Env:
 *   OPENBITFUN_E2E_SOURCE_CONFIG  source config path (same as --source)
 *   OPENBITFUN_E2E_STORAGE_ROOT   sandbox runtime root override
 *   OPENBITFUN_E2E_USER_ROOT      sandbox user root override
 *
 * Security: API keys are copied programmatically and are never printed. Only
 * structural facts (paths, counts, the resolved primary model id) reach stdout.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const E2E_DIR = path.resolve(PROJECT_ROOT, 'tests', 'e2e');

/** Host default when the source config carries no usable language. */
const DEFAULT_LANGUAGE = 'zh-CN';

const args = process.argv.slice(2);
const keepExisting = args.includes('--keep');
const sourceArg = args.find(arg => arg.startsWith('--source='));
const explicitSource = sourceArg
  ? sourceArg.slice('--source='.length)
  : process.env.OPENBITFUN_E2E_SOURCE_CONFIG;

function runtimeRoot() {
  return process.env.OPENBITFUN_E2E_STORAGE_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_STORAGE_ROOT)
    : path.join(E2E_DIR, '.openbitfun', 'runtime');
}

function userRoot() {
  return process.env.OPENBITFUN_E2E_USER_ROOT
    ? path.resolve(process.env.OPENBITFUN_E2E_USER_ROOT)
    : path.join(runtimeRoot(), 'user-root');
}

function sandboxConfigFile() {
  return path.join(userRoot(), 'config', 'app.json');
}

function sourceCandidates() {
  const candidates = [];
  if (explicitSource) {
    candidates.push(path.resolve(explicitSource));
  }
  if (process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'openbitfun', 'config', 'app.json'),
      path.join(process.env.APPDATA, 'BitFun', 'config', 'app.json'),
      path.join(process.env.APPDATA, 'bitfun', 'config', 'app.json'),
    );
  }
  candidates.push(
    path.join(os.homedir(), '.config', 'openbitfun', 'config', 'app.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'openbitfun', 'config', 'app.json'),
    path.join(os.homedir(), '.config', 'bitfun', 'config', 'app.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'bitfun', 'config', 'app.json'),
  );
  return candidates;
}

function resolveSourceConfig() {
  for (const candidate of sourceCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Deep clone through JSON so no live object from the source is shared. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message) {
  console.error(`[seed] ERROR: ${message}`);
  process.exit(1);
}

const sandboxConfig = sandboxConfigFile();

if (!keepExisting) {
  const root = runtimeRoot();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`[seed] Cleared sandbox runtime: ${root}`);
}

const sourceConfig = resolveSourceConfig();
if (!sourceConfig) {
  fail(
    'no source config found. Set OPENBITFUN_E2E_SOURCE_CONFIG (or pass --source=<path>) '
    + `to a real OpenBitFun config containing an "ai" section. Tried:\n  ${sourceCandidates().join('\n  ')}`,
  );
}

const source = readJson(sourceConfig);
const aiSection = source.ai;
if (!aiSection || typeof aiSection !== 'object') {
  fail(`source config has no "ai" section: ${sourceConfig}`);
}

const language = typeof source.app?.language === 'string' && source.app.language.trim()
  ? source.app.language.trim()
  : DEFAULT_LANGUAGE;

const seeded = {
  app: { language },
  ai: clone(aiSection),
};

const models = Array.isArray(seeded.ai.models) ? seeded.ai.models : [];

// Drop the reasoning block from the seeded copy.
//
// A stored `reasoning.default_preset` is validated against the catalog projected
// from the *bundled* models.dev snapshot. A binding whose provider is absent from
// that snapshot makes validation fail, and a "reasoning default preset" error is
// a hard config failure rather than a per-model isolation, so
// `initialize global config service` aborts and the app never starts its embedded
// WebDriver.
//
// The memory spec only needs a working chat model, so the fixture drops the
// reasoning binding. The developer's real profile is never modified.
let reasoningBlocksStripped = 0;
for (const model of models) {
  if (model && typeof model === 'object' && Object.prototype.hasOwnProperty.call(model, 'reasoning')) {
    delete model.reasoning;
    reasoningBlocksStripped += 1;
  }
}

const enabledModelIds = models
  .filter(model => model && model.enabled === true && typeof model.id === 'string' && model.id.trim())
  .map(model => model.id);

if (enabledModelIds.length === 0) {
  fail(`source config has no enabled AI model in "ai.models": ${sourceConfig}`);
}

if (!seeded.ai.default_models || typeof seeded.ai.default_models !== 'object') {
  seeded.ai.default_models = {};
}

const primaryBefore = seeded.ai.default_models.primary;
const primaryIsUsable = typeof primaryBefore === 'string' && primaryBefore.trim().length > 0;
if (!primaryIsUsable) {
  seeded.ai.default_models.primary = enabledModelIds[0];
  console.log(
    `[seed] "ai.default_models.primary" was missing; defaulted to the first enabled model id: ${enabledModelIds[0]}`,
  );
}

// Hard guarantee: a fresh profile must not carry memory settings.
if (Object.prototype.hasOwnProperty.call(seeded, 'memories')) {
  delete seeded.memories;
}
if (Object.prototype.hasOwnProperty.call(seeded.ai, 'memories')) {
  delete seeded.ai.memories;
}

fs.mkdirSync(path.dirname(sandboxConfig), { recursive: true });
fs.writeFileSync(sandboxConfig, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

console.log('[seed] Isolated E2E profile seeded.');
console.log(`[seed]   source config : ${sourceConfig}`);
console.log(`[seed]   sandbox config: ${sandboxConfig}`);
console.log(`[seed]   top-level keys: ${Object.keys(seeded).sort().join(', ')}`);
console.log(`[seed]   app language  : ${language}`);
console.log(`[seed]   enabled models: ${enabledModelIds.length}`);
console.log(`[seed]   reasoning blocks stripped: ${reasoningBlocksStripped} (see script comment)`);
console.log(`[seed]   primary model : ${seeded.ai.default_models.primary}`);
console.log('[seed]   memories section present: false');
console.log('[seed] Ready. Start wdio after this script so the app loads the seeded config.');
