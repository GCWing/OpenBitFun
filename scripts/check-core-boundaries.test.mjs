import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectCargoMetadataGraph,
  collectCargoMetadataPackages,
  discoverCargoManifestPaths,
  findCargoLayerViolations,
  findFeatureGatedTestTargetViolations,
  findProductEntrypointCoreFeatureViolations,
  findReqwestDependencyFeatureViolations,
  findResolvedThirdPartyCapabilityFeatureViolations,
  findRuntimeServicesTestSupportFeatureViolations,
  findResolvedReqwestNativeTlsViolations,
  findServicesIntegrationsPlatformDependencyFeatureViolations,
  findServicesIntegrationsReqwestFeatureViolations,
  findServicesIntegrationsTokioFeatureViolations,
  findThirdPartyCapabilityFeatureViolations,
  findTokioDependencyFeatureViolations,
} from './core-boundaries/cargo-dependency-boundaries.mjs';
import {
  checkCliIntegrationTestTopology,
  checkExternalSourceIntegrationTestTopologies,
  checkServicesCoreIntegrationTestTopology,
  checkServicesIntegrationsIntegrationTestTopology,
  claudeCodeAdapterIntegrationTestTargets,
  cliIntegrationTestTargets,
  codexAdapterIntegrationTestTargets,
  externalSourcesIntegrationTestTargets,
  opencodeAdapterIntegrationTestTargets,
  validateExplicitIntegrationTestTopology,
} from './core-boundaries/explicit-test-topology.mjs';
import { crateLayoutRules } from './core-boundaries/rules/crate-layout.mjs';
import { findForbiddenContentMatches } from './core-boundaries/source-content-checks.mjs';
import {
  capabilityContractDependencyRules,
  coreClosedFeatureProfileRules,
  coreProductFullFeatureAssemblyRule,
  guardedEmptyInternalDefaultManifestPaths,
  optionalDependencyFeatureOwnerRules,
} from './core-boundaries/rules/feature-rules.mjs';
import {
  agentRuntimeRootPublicModules,
  forbiddenContentRules,
  forbiddenContentUnderRules,
  publicApiAllowlistRules,
  requiredContentRules,
} from './core-boundaries/rules/source-rules.mjs';

const ENTRYPOINT = new URL('./check-core-boundaries.mjs', import.meta.url);
const MODULES = [
  './core-boundaries/checker.mjs',
  './core-boundaries/cargo-dependency-boundaries.mjs',
  './core-boundaries/explicit-test-topology.mjs',
  './core-boundaries/manifest-feature-helpers.mjs',
  './core-boundaries/source-content-checks.mjs',
  './core-boundaries/self-test.mjs',
  './core-boundaries/tui-boundary-ratchet.mjs',
  './core-boundaries/rules/crate-rules.mjs',
  './core-boundaries/rules/feature-rules.mjs',
  './core-boundaries/rules/source-rules.mjs',
  './core-boundaries/rules/source/facade-rules.mjs',
  './core-boundaries/rules/source/forbidden-rules.mjs',
  './core-boundaries/rules/source/public-api-rules.mjs',
  './core-boundaries/rules/source/required-rules.mjs',
];

const TEST_ROOT = join('C:', 'repo');

test('tool-runtime search regex stays available without enabling HTML extractors', () => {
  const rule = requiredContentRules.find(
    rule => rule.path === 'src/crates/execution/tool-execution/Cargo.toml',
  );
  assert.ok(rule);
  const manifest = `[features]
default = []
web-readable = ["dep:htmd", "dep:legible", "dep:readability-js"]
[dependencies]
regex = { workspace = true }
htmd = { version = "0.5.4", optional = true }
legible = { version = "0.4.2", optional = true }
readability-js = { version = "0.1.5", optional = true }
`;
  const accepts = text => rule.patterns.every(({ regex }) => regex.test(text));
  assert.ok(accepts(manifest));
  assert.equal(accepts(manifest.replace(
    'regex = { workspace = true }',
    'regex = { workspace = true, optional = true }',
  )), false);
  for (const dependency of ['htmd', 'legible', 'readability-js']) {
    assert.equal(accepts(manifest.replace(
      new RegExp(`(${dependency} = \\{[^}]*), optional = true`), '$1',
    )), false, `${dependency} must remain optional`);
  }
  assert.equal(accepts(manifest.replace(
    'web-readable = [', 'web-readable = ["dep:regex", ',
  )), false);
});

test('workspace file tools reject new per-tool SSH implementations', async () => {
  for (const tool of ['file_read_tool', 'file_write_tool', 'file_edit_tool', 'delete_file_tool', 'ls_tool']) {
    const path = `src/crates/assembly/core/src/agentic/tools/implementations/${tool}.rs`;
    const rule = forbiddenContentRules.find(rule => rule.path === path);
    assert.ok(rule, `${tool} must retain its provider boundary guard`);
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.deepEqual(findForbiddenContentMatches(source, rule.patterns), []);
    for (const mutation of [
      'if context.is_remote() { return call_remote(); }',
      'resolved.uses_remote_workspace_backend()',
      'context.ws_shell().unwrap().exec(command)',
      'write_local_file(request)',
      'build_remote_delete_command(path, recursive)',
    ]) {
      assert.ok(findForbiddenContentMatches(`${source}\n${mutation}`, rule.patterns).length > 0,
        `${tool} must reject ${mutation}`);
    }
  }
});

test('Pi Skill discovery may use bounded static-source support without opening other consumers', async () => {
  const rule = forbiddenContentUnderRules.find(
    (rule) => rule.reason === 'shared bounded static-source support is private to reviewed ecosystem source adapters',
  );
  assert.ok(rule);
  const sourcePath = 'src/crates/adapters/pi-adapter/src/skill_source.rs';
  const source = await readFile(new URL(`../${sourcePath}`, import.meta.url), 'utf8');
  assert.match(source, /use openbitfun_static_hook_support::/);
  assert.deepEqual(findForbiddenContentMatches(source, rule.patterns, sourcePath), []);
  for (const rejectedPath of [
    'src/crates/adapters/pi-adapter/src/unreviewed_source.rs',
    'src/crates/assembly/core/src/agentic/tools/implementations/skills/registry.rs',
  ]) {
    assert.ok(findForbiddenContentMatches(source, rule.patterns, rejectedPath).length > 0,
      `static-source support must remain private at ${rejectedPath}`);
  }
});

test('Cargo manifest discovery ignores nested local-agent worktrees', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'openbitfun-core-boundaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, 'src', 'crate'), { recursive: true }),
    mkdir(join(root, '.claude', 'worktrees', 'other'), { recursive: true }),
    mkdir(join(root, '.cursor', 'worktrees', 'other'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'Cargo.toml'), '[workspace]\n'),
    writeFile(join(root, 'src', 'crate', 'Cargo.toml'), '[package]\nname="kept"\nversion="0.1.0"\n'),
    writeFile(join(root, '.claude', 'worktrees', 'other', 'Cargo.toml'), '[package]\nname="ignored-claude"\nversion="0.1.0"\n'),
    writeFile(join(root, '.cursor', 'worktrees', 'other', 'Cargo.toml'), '[package]\nname="ignored-cursor"\nversion="0.1.0"\n'),
  ]);

  const manifests = discoverCargoManifestPaths(root)
    .map((manifest) => manifest.slice(root.length + 1).replaceAll('\\', '/'));
  assert.deepEqual(manifests, ['Cargo.toml', 'src/crate/Cargo.toml']);
});

test('App Server TypeScript capability is owned by the protocol crate and independent from RPC', () => {
  const appServerTs = coreClosedFeatureProfileRules.find(
    (rule) => rule.manifestPath === 'src/crates/interfaces/app-server/Cargo.toml'
      && rule.featureName === 'ts',
  );
  assert.deepEqual(appServerTs?.requiredFeatureRefs, [
    'openbitfun-app-server-protocol/ts',
  ]);
  assert.equal(appServerTs?.exact, true);

  const protocolProfiles = new Map(
    coreClosedFeatureProfileRules
      .filter(
        (rule) => rule.manifestPath
          === 'src/crates/interfaces/app-server-protocol/Cargo.toml',
      )
      .map((rule) => [rule.featureName, rule]),
  );

  const protocolDefault = protocolProfiles.get('default');
  assert.deepEqual(protocolDefault?.requiredFeatureRefs, ['rpc']);
  assert.equal(protocolDefault?.exact, true);

  const protocolRpc = protocolProfiles.get('rpc');
  assert.deepEqual(protocolRpc?.requiredFeatureRefs, ['dep:agent-client-protocol']);
  assert.equal(protocolRpc?.exact, true);

  const protocolOptionalOwners = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'app-server-protocol',
  );
  assert.deepEqual(protocolOptionalOwners?.dependencies, [
    { depName: 'agent-client-protocol', ownerFeatures: ['rpc'] },
  ]);

  const protocolTs = protocolProfiles.get('ts');
  assert.deepEqual(protocolTs?.requiredFeatureRefs, [
    'openbitfun-core-types/ts',
    'openbitfun-product-domains/ts',
    'openbitfun-runtime-ports/ts',
    'dep:ts-rs',
  ]);
  assert.equal(protocolTs?.exact, true);
});

test('Agent Runtime leaf capabilities have one managed feature and source contract', async () => {
  const rule = capabilityContractDependencyRules.find(
    (candidate) => candidate.packageName === 'openbitfun-agent-runtime',
  );
  assert.ok(rule, 'openbitfun-agent-runtime must be a managed capability target');
  assert.deepEqual(Object.keys(rule.featureProfiles).sort(), [
    'agent-runtime',
    'default',
    'definition-contracts',
    'native-hook-runtime',
    'native-hook-settings',
  ]);
  assert.equal(rule.consumers.size, 11);
  assert.ok(rule.consumers.has('openbitfun-legacy-migration-adapters'));
  assert.ok(
    guardedEmptyInternalDefaultManifestPaths.includes(
      'src/crates/execution/agent-runtime/Cargo.toml',
    ),
  );
  assert.ok(requiredContentRules.some(
    (sourceRule) => sourceRule.path === 'src/crates/execution/agent-runtime/src/lib.rs'
      && sourceRule.reason.includes('leaf capability modules'),
  ));
  const publicApiRule = publicApiAllowlistRules.find(
    (sourceRule) => sourceRule.path === 'src/crates/execution/agent-runtime/src/lib.rs',
  );
  assert.ok(publicApiRule, 'openbitfun-agent-runtime root must have a closed public module allowlist');
  assert.deepEqual(
    new Set(publicApiRule.allowedSymbols),
    new Set(agentRuntimeRootPublicModules),
  );
  const flatRootRule = forbiddenContentRules.find(
    (sourceRule) => sourceRule.path === 'src/crates/execution/agent-runtime/src/lib.rs'
      && sourceRule.reason.includes('flat feature-owned module wrapper'),
  );
  assert.ok(flatRootRule, 'openbitfun-agent-runtime root must reject non-wrapper source lines');
  const rootSource = await readFile(
    new URL('../src/crates/execution/agent-runtime/src/lib.rs', import.meta.url),
    'utf8',
  );
  assert.equal(flatRootRule.patterns[0].regex.test(rootSource), false);
  for (const mutation of [
    '#[doc(hidden)] pub mod accidental_feature_free_api;',
    'pub union AccidentalFeatureFreeApi { value: u64 }',
    'const DOC: &str = "{";\npub mod accidental_feature_free_api;',
  ]) {
    assert.equal(
      flatRootRule.patterns[0].regex.test(`${rootSource}\n${mutation}`),
      true,
      `Agent Runtime root must reject mutation: ${mutation}`,
    );
  }
});

test('Server canonical Agent Runtime ownership is protected by source boundary rules', async () => {
  const bootstrapPath = 'src/apps/server/src/bootstrap.rs';
  const mainPath = 'src/apps/server/src/main.rs';
  const bootstrapRequired = requiredContentRules.find((rule) => rule.path === bootstrapPath);
  const bootstrapForbidden = forbiddenContentRules.find((rule) => rule.path === bootstrapPath);
  const mainRequired = requiredContentRules.find((rule) => rule.path === mainPath);
  const mainForbidden = forbiddenContentRules.find((rule) => rule.path === mainPath);

  assert.ok(bootstrapRequired, 'Server bootstrap must have a required ownership contract');
  assert.ok(bootstrapForbidden, 'Server bootstrap must reject duplicate Runtime assembly');
  assert.ok(mainRequired, 'Server main must retain the product event owner');
  assert.ok(mainForbidden, 'Server main must reject an unowned event source');

  const [bootstrapSource, mainSource] = await Promise.all([
    readFile(new URL('../src/apps/server/src/bootstrap.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src/apps/server/src/main.rs', import.meta.url), 'utf8'),
  ]);
  for (const pattern of bootstrapRequired.patterns) {
    assert.match(bootstrapSource, pattern.regex, pattern.message);
  }
  for (const pattern of mainRequired.patterns) {
    assert.match(mainSource, pattern.regex, pattern.message);
  }
  assert.match(
    'let queue = EventQueue::new(Default::default());',
    bootstrapForbidden.patterns[0].regex,
  );
  assert.match(
    'let source = AgentEventSource::new(event_queue);',
    mainForbidden.patterns[0].regex,
  );
});

test('TLS source boundaries reject bypasses of the centralized provider owner', () => {
  const integrationsRule = forbiddenContentUnderRules.find((rule) =>
    rule.path === 'src/crates/services/services-integrations/src'
      && rule.reason.includes('provider-initializing Reqwest constructors'));
  const providerRule = forbiddenContentUnderRules.find((rule) =>
    rule.path === 'src'
      && rule.reason.includes('only owner allowed to install'));
  assert.ok(integrationsRule, 'integration Reqwest constructors must be guarded');
  assert.ok(providerRule, 'direct Rustls provider installation must be guarded');

  assert.ok(integrationsRule.patterns.some((pattern) => pattern.regex.test(
    'use reqwest::Client;\nfn client() { let _ = Client::builder(); }',
  )));
  assert.ok(integrationsRule.patterns.some((pattern) => pattern.regex.test(
    'use reqwest::{Client as HttpClient, Url};\nfn client() { let _ = HttpClient::new(); }',
  )));
  assert.ok(integrationsRule.patterns.some((pattern) => pattern.regex.test(
    'fn client() { let _ = reqwest::ClientBuilder::new(); }',
  )));
  assert.ok(integrationsRule.patterns.some((pattern) => pattern.regex.test(
    'use reqwest as http;\nfn client() { let _ = http::Client::new(); }',
  )));
  assert.match(
    'rustls::crypto::ring::default_provider().install_default();',
    providerRule.patterns[0].regex,
  );
  assert.doesNotMatch(
    'unrelated_component.install_default();',
    providerRule.patterns[0].regex,
  );
});

test('standalone Relay TLS exception cannot install a process provider', () => {
  const providerRule = forbiddenContentUnderRules.find(rule => rule.reason.includes('only owner allowed to install'));
  const relayPath = 'src/crates/services/relay-service/src/identity.rs';
  assert.ok(providerRule.patterns[0].allowPaths.includes(relayPath));
  const scopedRule = forbiddenContentUnderRules.find(rule => rule.path === relayPath && rule.reason.includes('client-scoped'));
  assert.ok(scopedRule);
  assert.ok(scopedRule.patterns.some(pattern => pattern.regex.test('provider.install_default()')));
  assert.ok(scopedRule.patterns.every(pattern => !pattern.regex.test('ClientConfig::builder_with_provider(provider)')));
});

test('Core and ACP defaults preserve their explicit assembly contracts', async () => {
  const [coreManifest, acpManifest] = await Promise.all([
    readFile(new URL('../src/crates/assembly/core/Cargo.toml', import.meta.url), 'utf8'),
    readFile(new URL('../src/crates/interfaces/acp/Cargo.toml', import.meta.url), 'utf8'),
  ]);

  assert.deepEqual(parseManifestFeatures(coreManifest).default, []);
  assert.deepEqual(
    new Set(parseManifestFeatures(acpManifest).default),
    new Set(['client', 'server']),
  );
});

test('consumers do not repeat guarded empty internal defaults', async () => {
  const cargoBoundaries = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  assert.equal(
    typeof cargoBoundaries.findRedundantInternalDefaultFeatureDisables,
    'function',
  );

  const emptyOwner = {
    ...packageAt('empty-owner', 'src/crates/contracts/empty-owner/Cargo.toml'),
    features: { default: [] },
  };
  const compatibilityOwner = {
    ...packageAt('compatibility-owner', 'src/crates/interfaces/compatibility-owner/Cargo.toml'),
    features: { default: ['client', 'server'] },
  };
  const unguardedEmptyOwner = {
    ...packageAt('unguarded-empty-owner', 'src/crates/contracts/unguarded-empty-owner/Cargo.toml'),
    features: { default: [] },
  };
  const consumer = packageAt('consumer', 'src/apps/consumer/Cargo.toml', [
    pathDependency('src/crates/contracts/empty-owner', {
      name: 'empty-owner',
      usesDefaultFeatures: false,
    }),
    pathDependency('src/crates/interfaces/compatibility-owner', {
      name: 'compatibility-owner',
      usesDefaultFeatures: false,
    }),
    pathDependency('src/crates/contracts/unguarded-empty-owner', {
      name: 'unguarded-empty-owner',
      usesDefaultFeatures: false,
    }),
  ]);

  const violations = cargoBoundaries.findRedundantInternalDefaultFeatureDisables(
    [emptyOwner, compatibilityOwner, unguardedEmptyOwner, consumer],
    {
      root: TEST_ROOT,
      guardedManifests: ['src/crates/contracts/empty-owner/Cargo.toml'],
    },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /empty-owner.*redundant/);
});

test('guarded internal defaults stay explicitly empty', async () => {
  const cargoBoundaries = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const manifestPath = 'src/crates/contracts/empty-owner/Cargo.toml';
  const owner = {
    ...packageAt('empty-owner', manifestPath),
    features: { default: [] },
  };
  assert.deepEqual(
    cargoBoundaries.findGuardedInternalDefaultFeatureViolations(
      [owner],
      { root: TEST_ROOT, guardedManifests: [manifestPath] },
    ),
    [],
  );

  owner.features.default = ['expanded'];
  const violations = cargoBoundaries.findGuardedInternalDefaultFeatureViolations(
    [owner],
    { root: TEST_ROOT, guardedManifests: [manifestPath] },
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /guarded default feature must stay explicitly empty/);
});

test('portable contract crates expose only capability-local feature slices', async () => {
  const [runtimePortsManifest, agentToolsManifest] = await Promise.all([
    readFile(new URL('../src/crates/contracts/runtime-ports/Cargo.toml', import.meta.url), 'utf8'),
    readFile(new URL('../src/crates/execution/tool-contracts/Cargo.toml', import.meta.url), 'utf8'),
  ]);

  const runtimePortFeatures = parseManifestFeatures(runtimePortsManifest);
  assert.deepEqual(runtimePortFeatures.default, []);
  assert.deepEqual(
    new Set(Object.keys(runtimePortFeatures)),
    new Set([
      'default',
      'agent-api',
      'git-port',
      'hook-function-runtime',
      'permission',
      'plugin-runtime',
      'product-search',
      'remote-exec-port',
      'remote-workspace-ports',
      'runtime-event-port',
      'script-tool-runtime',
      'terminal-port',
      'tool-runtime-handles',
      'ts',
      'web-search-port',
      'workspace-ports',
    ]),
  );
  assert.deepEqual(runtimePortFeatures['agent-api'], ['dep:openbitfun-core-types']);
  assert.deepEqual(runtimePortFeatures['hook-function-runtime'], []);
  assert.deepEqual(runtimePortFeatures['plugin-runtime'], []);
  assert.deepEqual(runtimePortFeatures['product-search'], ['dep:openbitfun-product-domains']);
  assert.deepEqual(runtimePortFeatures['script-tool-runtime'], []);
  assert.deepEqual(runtimePortFeatures['web-search-port'], []);
  // Workspace byte readers expose AsyncRead/AsyncSeek without selecting a
  // process, network, scheduler, or full Tokio runtime at the contract layer.
  assert.deepEqual(new Set(runtimePortFeatures['workspace-ports']), new Set(['dep:anyhow', 'dep:tokio-util', 'dep:tokio', 'tokio/io-util']));
  assert.deepEqual(runtimePortFeatures['terminal-port'], ['dep:tokio']);
  assert.deepEqual(runtimePortFeatures['remote-exec-port'], ['dep:tokio']);
  assert.deepEqual(
    new Set(runtimePortFeatures['tool-runtime-handles']),
    new Set([
      'workspace-ports',
      'terminal-port',
      'remote-exec-port',
    ]),
  );

  const agentToolFeatures = parseManifestFeatures(agentToolsManifest);
  assert.deepEqual(agentToolFeatures.default, []);
  assert.deepEqual(agentToolFeatures['acp-bridge'], []);
  assert.deepEqual(agentToolFeatures['computer-use-contract'], []);
  assert.deepEqual(agentToolFeatures['element-token'], []);
  assert.deepEqual(agentToolFeatures['mcp-bridge'], []);
});

test('runtime-port capability source gates protect modules and public exports', async () => {
  const { requiredContentRules } = await import(
    './core-boundaries/rules/source/required-rules.mjs'
  );
  const sourceRule = requiredContentRules.find(
    (rule) => rule.path === 'src/crates/contracts/runtime-ports/src/lib.rs'
      && rule.reason.includes('capability features'),
  );
  const patterns = sourceRule?.patterns.map(({ regex }) => regex.source).join('\n') ?? '';

  for (const [feature, moduleName] of [
    ['workspace-ports', 'workspace_ports'],
    ['terminal-port', 'terminal_port'],
    ['remote-exec-port', 'remote_exec_port'],
    ['remote-workspace-ports', 'remote_workspace_ports'],
    ['runtime-event-port', 'runtime_event_port'],
    ['git-port', 'git_port'],
    ['product-search', 'product_search'],
    ['tool-runtime-handles', 'tool_runtime_handles'],
  ]) {
    assert.match(patterns, new RegExp(`${feature}.*mod ${moduleName}`));
    assert.match(patterns, new RegExp(`${feature}.*pub use ${moduleName}`));
  }
});

test('runtime-ports async dependencies stay behind their exact port owners', () => {
  const ownerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'runtime-ports',
  );
  const ownersByDependency = new Map(
    ownerRule.dependencies.map((dependency) => [
      dependency.depName,
      new Set(dependency.ownerFeatures),
    ]),
  );

  assert.deepEqual(
    ownersByDependency.get('anyhow'),
    new Set(['workspace-ports']),
  );
  assert.deepEqual(
    ownersByDependency.get('tokio-util'),
    new Set(['workspace-ports']),
  );
  assert.deepEqual(
    ownersByDependency.get('tokio'),
    // WorkspaceReader exposes AsyncRead/AsyncSeek through the workspace IO port.
    new Set(['remote-exec-port', 'terminal-port', 'workspace-ports']),
  );
});

test('Core feature-free dependencies stay attached to their exact runtime owners', () => {
  const coreOwnerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'core',
  );
  const ownersByDependency = new Map(
    coreOwnerRule.dependencies.map((dependency) => [
      dependency.depName,
      new Set(dependency.ownerFeatures),
    ]),
  );

  assert.deepEqual(ownersByDependency.get('base64'), new Set(['agent-runtime', 'dispatch-store']));
  assert.deepEqual(ownersByDependency.get('futures'), new Set(['agent-runtime']));
  assert.deepEqual(ownersByDependency.get('regex'), new Set(['agent-runtime']));
  assert.deepEqual(
    ownersByDependency.get('openbitfun-agent-tools'),
    new Set(['agent-runtime', 'local-storage', 'mcp-runtime']),
  );
  assert.deepEqual(ownersByDependency.get('fluent-bundle'), new Set(['i18n-runtime']));
  assert.deepEqual(ownersByDependency.get('unic-langid'), new Set(['i18n-runtime']));
  assert.deepEqual(
    ownersByDependency.get('tokio-util'),
    new Set(['agent-runtime']),
  );
});

test('Services Core feature-free dependencies stay behind exact text and async IO owners', () => {
  const ownerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'services-core',
  );
  const ownersByDependency = new Map(
    ownerRule.dependencies.map((dependency) => [
      dependency.depName,
      new Set(dependency.ownerFeatures),
    ]),
  );

  assert.deepEqual(
    ownersByDependency.get('regex'),
    new Set(['diagnostics', 'filesystem', 'local-storage', 'markdown', 'workspace-instructions']),
  );
  assert.deepEqual(ownersByDependency.get('similar'), new Set(['diff', 'local-storage']));
  assert.deepEqual(
    ownersByDependency.get('tokio'),
    new Set([
      'credential-vault',
      'diff',
      'filesystem',
      'json-io',
      'local-storage',
      'permission',
      'process-runtime',
      'session-search',
      'workspace-instructions',
      'workspace-runtime',
      'workspace-text-runtime',
      'workspace-transfer',
    ]),
  );
});

test('Services Core text runtime features keep independent exact owner profiles', () => {
  const profiles = new Map(
    coreClosedFeatureProfileRules
      .filter((rule) => rule.manifestPath === 'src/crates/services/services-core/Cargo.toml')
      .map((rule) => [rule.featureName, rule.requiredFeatureRefs]),
  );

  assert.deepEqual(profiles.get('diagnostics'), ['dep:regex']);
  assert.deepEqual(profiles.get('diff'), [
    'dep:similar',
    'dep:tokio',
    'tokio/rt',
    'tokio/time',
  ]);
  assert.deepEqual(profiles.get('workspace-text-runtime'), [
    'dep:tokio',
    'tokio/rt',
  ]);
});

function parseManifestFeatures(manifest) {
  const section = manifest.match(/^\[features\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? '';
  const features = {};

  for (const match of section.matchAll(/^([a-zA-Z0-9_-]+)\s*=\s*\[([\s\S]*?)\]/gm)) {
    features[match[1]] = [...match[2].matchAll(/["']([^"']+)["']/g)].map((value) => value[1]);
  }

  return features;
}

function removeFeatureValue(manifest, feature, value) {
  const featurePattern = new RegExp(`^${feature}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  return manifest.replace(featurePattern, (definition) =>
    definition.replace(new RegExp(`\\s*["']${value}["'],?`), ''));
}

function servicesIntegrationsPackage(manifest) {
  return {
    name: 'openbitfun-services-integrations',
    manifest_path: join(TEST_ROOT, 'src', 'crates', 'services', 'services-integrations', 'Cargo.toml'),
    features: parseManifestFeatures(manifest),
  };
}

function packageAt(name, repoManifestPath, dependencies = []) {
  return {
    id: name,
    name,
    manifest_path: join(TEST_ROOT, ...repoManifestPath.split('/')),
    dependencies,
  };
}

function pathDependency(repoCratePath, options = {}) {
  return {
    name: options.name ?? repoCratePath.split('/').at(-1),
    rename: options.rename ?? null,
    path: join(TEST_ROOT, ...repoCratePath.split('/')),
    kind: options.kind ?? null,
    optional: options.optional ?? false,
    target: options.target ?? null,
    uses_default_features: options.usesDefaultFeatures ?? true,
    features: options.features ?? [],
  };
}

const RUNTIME_PORT_FEATURE_PROFILES = {
  default: [],
  'agent-api': ['dep:openbitfun-core-types'],
  'git-port': [],
  'hook-function-runtime': [],
  permission: ['dep:openbitfun-product-domains'],
  'plugin-runtime': [],
  'product-search': ['dep:openbitfun-product-domains'],
  'remote-exec-port': ['dep:tokio'],
  'remote-workspace-ports': [],
  'runtime-event-port': [],
  'script-tool-runtime': [],
  'terminal-port': ['dep:tokio'],
  'tool-runtime-handles': ['workspace-ports', 'terminal-port', 'remote-exec-port'],
  ts: [
    'dep:ts-rs',
    'agent-api',
    'permission',
    'openbitfun-core-types/ts',
    'openbitfun-product-domains?/ts',
  ],
  'web-search-port': [],
  'workspace-ports': ['dep:anyhow', 'dep:tokio-util', 'dep:tokio', 'tokio/io-util'],
};

const AGENT_TOOL_FEATURE_PROFILES = {
  default: [],
  'acp-bridge': [],
  'computer-use-contract': [],
  'element-token': [],
  'mcp-bridge': [],
};

function capabilityPackage(name, repoManifestPath, featureProfiles) {
  return {
    ...packageAt(name, repoManifestPath),
    features: structuredClone(featureProfiles),
  };
}

function agentToolsCapabilityPackage() {
  return {
    ...capabilityPackage(
      'openbitfun-agent-tools',
      'src/crates/execution/tool-contracts/Cargo.toml',
      AGENT_TOOL_FEATURE_PROFILES,
    ),
    dependencies: [pathDependency('src/crates/contracts/runtime-ports', {
      name: 'openbitfun-runtime-ports',
      usesDefaultFeatures: false,
    })],
  };
}

function findTestCapabilityViolations(finder, packages, rules) {
  return finder(packages, rules, { root: TEST_ROOT });
}

function integrationTarget(name, sourcePath, requiredFeatures = []) {
  return {
    kind: ['test'],
    name,
    src_path: sourcePath,
    'required-features': requiredFeatures,
  };
}

test('feature-gated integration targets require every positive crate feature', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'remote.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget('remote', sourcePath, ['remote-ssh'])],
  };
  const sources = new Map([[
    sourcePath,
    '#![cfg(all(feature = "remote-ssh", feature = "workspace-search", not(feature = "remote-ssh-concrete")))]\n',
  ]]);

  const violations = findFeatureGatedTestTargetViolations([pkg], {
    readSource: (path) => sources.get(path),
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /workspace-search/);
  assert.doesNotMatch(violations[0].message, /remote-ssh-concrete.*missing/);
});

test('matching integration target requirements cover all positive crate features', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'remote.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget(
      'remote',
      sourcePath,
      ['remote-ssh', 'workspace-search'],
    )],
  };

  assert.deepEqual(
    findFeatureGatedTestTargetViolations([pkg], {
      readSource: () => '#![cfg(all(feature = "remote-ssh", feature = "workspace-search", not(feature = "remote-ssh-concrete")))]\n',
    }),
    [],
  );
});

test('runtime-services test support stays dev-only across dependency and feature edges', () => {
  const runtimeServicesPath = 'src/crates/execution/runtime-services';
  const packages = [
    packageAt('normal-consumer', 'src/apps/normal/Cargo.toml', [
      pathDependency(runtimeServicesPath, {
        name: 'openbitfun-runtime-services',
        features: ['test-support'],
      }),
    ]),
    packageAt('build-consumer', 'src/apps/build/Cargo.toml', [
      pathDependency(runtimeServicesPath, {
        name: 'openbitfun-runtime-services',
        kind: 'build',
        features: ['test-support'],
      }),
    ]),
    {
      ...packageAt('feature-forwarder', 'src/apps/forwarder/Cargo.toml'),
      features: {
        preview: ['openbitfun-runtime-services/test-support'],
      },
    },
    {
      ...packageAt('weak-forwarder', 'src/apps/weak/Cargo.toml'),
      features: {
        preview: ['openbitfun-runtime-services?/test-support'],
      },
    },
    {
      ...packageAt('renamed-forwarder', 'src/apps/renamed/Cargo.toml', [{
        ...pathDependency(runtimeServicesPath, {
          name: 'openbitfun-runtime-services',
          optional: true,
        }),
        rename: 'runtime_services',
      }]),
      features: {
        preview: ['runtime_services?/test-support'],
      },
    },
    {
      ...packageAt(
        'openbitfun-runtime-services',
        'src/crates/execution/runtime-services/Cargo.toml',
      ),
      features: {
        default: ['test-support'],
        'test-support': [],
      },
    },
    packageAt('test-consumer', 'src/apps/test/Cargo.toml', [
      pathDependency(runtimeServicesPath, {
        name: 'openbitfun-runtime-services',
        kind: 'dev',
        features: ['test-support'],
      }),
    ]),
  ];

  const violations = findRuntimeServicesTestSupportFeatureViolations(packages);

  assert.equal(violations.length, 6);
  assert.match(violations[0].message, /normal-consumer.*normal dependency/);
  assert.match(violations[1].message, /build-consumer.*build dependency/);
  assert.match(violations[2].message, /feature-forwarder:preview/);
  assert.match(violations[3].message, /weak-forwarder:preview/);
  assert.match(violations[4].message, /renamed-forwarder:preview/);
  assert.match(violations[5].message, /openbitfun-runtime-services:default/);
});

test('runtime-services feature aliases cannot hide test support from default builds', () => {
  const owner = {
    ...packageAt(
      'openbitfun-runtime-services',
      'src/crates/execution/runtime-services/Cargo.toml',
    ),
    features: {
      default: ['testing'],
      testing: ['test-support'],
      'test-support': [],
    },
  };

  const messages = findRuntimeServicesTestSupportFeatureViolations([owner])
    .map((violation) => violation.message)
    .join('\n');

  assert.match(messages, /openbitfun-runtime-services:default/);
  assert.match(messages, /default -> testing -> test-support/);
  assert.match(messages, /openbitfun-runtime-services:testing/);
});

test('CLI integration tests keep the reviewed four-target topology', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

  assert.deepEqual(cliIntegrationTestTargets, [
    { name: 'acp_stdio_cli', path: 'tests/acp_stdio_cli.rs' },
    { name: 'app_server_stdio_cli', path: 'tests/app_server_stdio_cli.rs' },
    { name: 'cli_command_contracts', path: 'tests/cli_command_contracts.rs' },
    { name: 'terminal_process_contracts', path: 'tests/terminal_process_contracts.rs' },
  ]);
  assert.deepEqual(checkCliIntegrationTestTopology(repositoryRoot), []);
});

test('service integration tests keep their reviewed explicit target topology', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

  assert.deepEqual(checkServicesCoreIntegrationTestTopology(repositoryRoot), []);
  assert.deepEqual(checkServicesIntegrationsIntegrationTestTopology(repositoryRoot), []);
});

test('contract and AI adapter tests keep reviewed feature and failure-domain topology', async () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const topology = await import('./core-boundaries/explicit-test-topology.mjs');

  assert.deepEqual(topology.coreTypesIntegrationTestTargets, [
    {
      name: 'core_type_contracts',
      path: 'tests/core_type_contracts.rs',
      leaves: [
        'tests/core_type_contracts/agent_identity.rs',
        'tests/core_type_contracts/session_contracts.rs',
        'tests/core_type_contracts/session_usage_contracts.rs',
        'tests/core_type_contracts/surface_contracts.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(topology.runtimePortsIntegrationTestTargets, [
    {
      name: 'plugin_runtime_contracts',
      path: 'tests/runtime_port_contracts.rs',
      leaves: [
        'tests/runtime_port_contracts/plugin_runtime_contracts.rs',
        'tests/runtime_port_contracts/plugin_runtime_diagnostics_contracts.rs',
      ],
      requiredFeatures: ['plugin-runtime'],
    },
    {
      name: 'git_port_contracts',
      path: 'tests/git_port_contracts.rs',
      requiredFeatures: ['git-port'],
    },
    {
      name: 'hook_function_runtime_contracts',
      path: 'tests/hook_function_runtime_contracts.rs',
      requiredFeatures: ['hook-function-runtime'],
    },
    {
      name: 'script_tool_port_contracts',
      path: 'tests/script_tool_port_contracts.rs',
      requiredFeatures: ['script-tool-runtime'],
    },
    {
      name: 'session_store_contracts',
      path: 'tests/session_store_contracts.rs',
      requiredFeatures: ['workspace-ports'],
    },
  ]);
  assert.deepEqual(topology.productDomainsIntegrationTestTargets, [
    {
      name: 'product_domain_contracts',
      path: 'tests/product_domain_contracts.rs',
      leaves: [
        'tests/product_domain_contracts/canvas_contracts.rs',
        'tests/product_domain_contracts/tool_permission_contracts.rs',
      ],
      forbidRequiredFeatures: true,
    },
    {
      name: 'external_source_contracts',
      path: 'tests/external_source_contracts.rs',
      leaves: [
        'tests/external_source_contracts/external_hook_catalog_contracts.rs',
        'tests/external_source_contracts/external_hook_contribution_contracts.rs',
        'tests/external_source_contracts/external_source_contracts.rs',
        'tests/external_source_contracts/plugin_capability_contracts.rs',
        'tests/external_source_contracts/workspace_reference_contracts.rs',
      ],
      requiredFeatures: ['external-sources'],
    },
    {
      name: 'function_agent_contracts',
      path: 'tests/function_agent_contracts.rs',
      requiredFeatures: ['function-agents'],
    },
    {
      name: 'miniapp_contracts',
      path: 'tests/miniapp_contracts.rs',
      requiredFeatures: ['miniapp'],
    },
    {
      name: 'loopx_contracts',
      path: 'tests/loopx_contracts.rs',
      requiredFeatures: ['miniapp'],
    },
    {
      name: 'legacy_migration_contracts',
      path: 'tests/legacy_migration_contracts.rs',
      requiredFeatures: ['legacy-migration'],
    },
    {
      name: 'plugin_source_contracts',
      path: 'tests/plugin_source_contracts.rs',
      requiredFeatures: ['plugin-source'],
    },
  ]);
  assert.deepEqual(topology.aiAdaptersIntegrationTestTargets, [
    {
      name: 'ai_protocol_contracts',
      path: 'tests/ai_protocol_contracts.rs',
      leaves: [
        'tests/ai_protocol_contracts/model_selector.rs',
        'tests/ai_protocol_contracts/openai_empty_content_parts.rs',
      ],
      forbidRequiredFeatures: true,
    },
    {
      name: 'ai_stream_contracts',
      path: 'tests/ai_stream_contracts.rs',
      leaves: [
        'tests/ai_stream_contracts/common.rs',
        'tests/ai_stream_contracts/stream_processor_anthropic.rs',
        'tests/ai_stream_contracts/stream_processor_openai.rs',
        'tests/ai_stream_contracts/stream_processor_tool_arguments.rs',
        'tests/ai_stream_contracts/stream_replay_regressions.rs',
        'tests/ai_stream_contracts/stream_test_harness.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(topology.productCapabilitiesIntegrationTestTargets, [
    {
      name: 'product_capability_contracts',
      path: 'tests/product_capability_contracts.rs',
      leaves: [
        'tests/product_capability_contracts/plugin_product_shape.rs',
        'tests/product_capability_contracts/product_capabilities.rs',
        'tests/product_capability_contracts/product_sdk_assembly.rs',
        'tests/product_capability_contracts/runtime_boundary.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(topology.agentWorkflowsIntegrationTestTargets, [
    {
      name: 'deep_research_contracts',
      path: 'tests/deep_research_contracts.rs',
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(topology.checkBuildGraphContractIntegrationTestTopologies(repositoryRoot), []);

  const widenedOwnerErrors = validateExplicitIntegrationTestTopology({
    manifestText: [
      '[package]',
      'autotests = false',
      '[[test]]',
      'name = "external_source_contracts"',
      'path = "tests/external_source_contracts.rs"',
      'required-features = ["product-full"]',
    ].join('\n'),
    expectedTargets: [{
      name: 'external_source_contracts',
      path: 'tests/external_source_contracts.rs',
      requiredFeatures: ['external-sources'],
    }],
    topLevelRustFiles: ['tests/external_source_contracts.rs'],
    rootSources: new Map([[
      'tests/external_source_contracts.rs',
      '#![cfg(feature = "product-full")]\n',
    ]]),
    leafRustFiles: [],
    leafSources: new Map(),
  });
  assert.match(widenedOwnerErrors.join('\n'), /required-features.*external-sources/);
});

test('external source integration tests keep reviewed owner and process boundaries', () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

  assert.deepEqual(opencodeAdapterIntegrationTestTargets, [
    { name: 'opencode_mcp_adapter', path: 'tests/opencode_mcp_adapter.rs' },
    { name: 'opencode_source_adapter', path: 'tests/opencode_source_adapter.rs' },
    {
      name: 'opencode_static_source_contracts',
      path: 'tests/opencode_static_source_contracts.rs',
      leaves: [
        'tests/opencode_static_source_contracts/hook_source.rs',
        'tests/opencode_static_source_contracts/opencode_command_adapter.rs',
        'tests/opencode_static_source_contracts/opencode_skill_roots.rs',
        'tests/opencode_static_source_contracts/opencode_subagent_adapter.rs',
        'tests/opencode_static_source_contracts/opencode_workspace_references.rs',
      ],
      forbidRequiredFeatures: true,
    },
    { name: 'tool_source_contracts', path: 'tests/tool_source_contracts.rs' },
  ]);
  assert.deepEqual(claudeCodeAdapterIntegrationTestTargets, [
    {
      name: 'claude_code_source_contracts',
      path: 'tests/claude_code_source_contracts.rs',
      leaves: [
        'tests/claude_code_source_contracts/command_source.rs',
        'tests/claude_code_source_contracts/hook_source.rs',
        'tests/claude_code_source_contracts/mcp_source.rs',
        'tests/claude_code_source_contracts/subagent_source.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(codexAdapterIntegrationTestTargets, [
    {
      name: 'codex_source_contracts',
      path: 'tests/codex_source_contracts.rs',
      leaves: [
        'tests/codex_source_contracts/hook_source.rs',
        'tests/codex_source_contracts/mcp_source.rs',
        'tests/codex_source_contracts/subagent_source.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(externalSourcesIntegrationTestTargets, [
    {
      name: 'external_source_coordination_contracts',
      path: 'tests/external_source_coordination_contracts.rs',
      leaves: [
        'tests/external_source_coordination_contracts/control_plane.rs',
        'tests/external_source_coordination_contracts/coordinator_contracts.rs',
        'tests/external_source_coordination_contracts/hook_coordinator.rs',
        'tests/external_source_coordination_contracts/mcp_coordinator.rs',
        'tests/external_source_coordination_contracts/subagent_coordinator.rs',
        'tests/external_source_coordination_contracts/tool_coordinator_contracts.rs',
        'tests/external_source_coordination_contracts/workspace_reference.rs',
      ],
      forbidRequiredFeatures: true,
    },
  ]);
  assert.deepEqual(
    checkExternalSourceIntegrationTestTopologies(repositoryRoot),
    [],
  );
});

test('Web UI command contracts do not become Rust compilation inputs', async () => {
  const webApiPath = 'src/web-ui/src/infrastructure/api/service-api/ExternalSourcesAPI.ts';
  const webCommandRule = requiredContentRules.find(
    (rule) => rule.path === webApiPath
      && rule.reason.includes('stable Desktop command'),
  );
  assert.ok(webCommandRule, 'Web API must retain a boundary-owned stable command contract');

  const webCommandPattern = webCommandRule.patterns.find(
    (pattern) => pattern.message.includes('external-source control snapshot'),
  )?.regex;
  assert.ok(webCommandPattern, 'Web API command contract must name the control snapshot');

  const webApi = await readFile(new URL(`../${webApiPath}`, import.meta.url), 'utf8');
  assert.equal(webCommandPattern.test(webApi), true);
  assert.equal(
    webCommandPattern.test(
      webApi.replace('get_external_source_control_snapshot', 'get_renamed_snapshot'),
    ),
    false,
    'renaming the invoked command must break the cross-surface contract',
  );

  const rustSourceRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === '.'
      && rule.reason.includes('Rust source must not reference the Web UI source tree'),
  );
  assert.ok(rustSourceRule, 'all tracked Rust sources must reject Web UI file inputs');
  for (const mutation of [
    'let web = include_str!(\n  "../../web-ui/src/infrastructure/api.ts"\n);',
    'let web = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web-ui/src/api.ts"));',
    'let web = include!("../../web-ui/public/generated.rs");',
    'let web = include_dir!("../../web-ui/src");',
    'let path = PathBuf::from("../../web-ui/src/api.ts");',
    'let path = PathBuf::from("../../").join("web-ui").join("src");',
    'const WEB_UI_DIR: &str = "web-ui"; let body = fs::read_to_string(WEB_UI_DIR);',
    'let example = r#"include_str!(\"../../web-ui/src/api.ts\")"#;',
  ]) {
    assert.equal(
      findForbiddenContentMatches(mutation, rustSourceRule.patterns, 'src/example.rs').length,
      1,
      `Rust/Web input guard must reject: ${mutation}`,
    );
  }
  for (const allowed of [
    '// include_str!("../../web-ui/src/comment-only.ts")',
    '/* PathBuf::from("../../web-ui/public/comment-only.json") */',
    'const REVIEW_SCOPE: &str = "src/frontend/src/**/*.ts";',
  ]) {
    assert.deepEqual(
      findForbiddenContentMatches(allowed, rustSourceRule.patterns, 'src/example.rs'),
      [],
      `Rust/Web input guard must ignore non-input text: ${allowed}`,
    );
  }
  assert.deepEqual(
    findForbiddenContentMatches(
      'allowed\nforbidden',
      [{ regex: /forbidden/, message: 'line-based guard' }],
      'src/example.rs',
    ),
    [{ line: 2, message: 'line-based guard' }],
  );
});

test('runtime-services test support is absent from ordinary library builds', async () => {
  const [manifest, library] = await Promise.all([
    readFile(
      new URL('../src/crates/execution/runtime-services/Cargo.toml', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../src/crates/execution/runtime-services/src/lib.rs', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(manifest, /^test-support\s*=\s*\[\]\s*$/m);
  assert.doesNotMatch(manifest, /^required-features\s*=.*test-support.*$/m);
  assert.match(
    library,
    /#\[cfg\(any\(test, feature = "test-support"\)\)\]\s*pub mod test_support;/,
  );
  assert.match(library, /#\[cfg\(test\)\]\s*mod runtime_services_contracts;/);
  assert.equal((library.match(/^pub mod test_support;\s*$/gm) ?? []).length, 1);
});

test('feature-gated integration targets reject extra umbrella requirements', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'focused.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget('focused', sourcePath, ['focused', 'product-full'])],
  };

  const violations = findFeatureGatedTestTargetViolations([pkg], {
    readSource: () => '#![cfg(feature = "focused")]\n',
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /unexpected required-features: product-full/);
});

test('target guard ignores module cfg and non-integration targets', () => {
  const moduleSourcePath = join(TEST_ROOT, 'tests', 'module.rs');
  const binarySourcePath = join(TEST_ROOT, 'src', 'main.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [
      integrationTarget('module', moduleSourcePath),
      {
        ...integrationTarget('binary', binarySourcePath),
        kind: ['bin'],
      },
    ],
  };
  const sources = new Map([
    [moduleSourcePath, '#[cfg(feature = "serde")]\nmod serde_tests {}\n'],
    [binarySourcePath, '#![cfg(feature = "cli")]\nfn main() {}\n'],
  ]);

  assert.deepEqual(
    findFeatureGatedTestTargetViolations([pkg], {
      readSource: (path) => sources.get(path),
    }),
    [],
  );
});

test('target guard ignores crate cfg examples in comments and strings', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'documented.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget('documented', sourcePath)],
  };

  assert.deepEqual(
    findFeatureGatedTestTargetViolations([pkg], {
      readSource: () => [
        '// Example: #![cfg(feature = "commented")]',
        'const EXAMPLE: &str = r#"',
        '#![cfg(feature = "string-literal")]',
        '"#;',
      ].join('\n'),
    }),
    [],
  );
});

test('target guard rejects feature OR gates that Cargo cannot express', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'provider.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget('provider', sourcePath, ['provider-a'])],
  };

  const violations = findFeatureGatedTestTargetViolations([pkg], {
    readSource: () => '#![cfg(any(feature = "provider-a", feature = "provider-b"))]\n',
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /cannot express.*split the target/);
});

test('multiple crate feature gates combine as required feature AND conditions', () => {
  const sourcePath = join(TEST_ROOT, 'tests', 'combined.rs');
  const pkg = {
    ...packageAt('example', 'src/crates/services/example/Cargo.toml'),
    targets: [integrationTarget('combined', sourcePath, ['first'])],
  };

  const violations = findFeatureGatedTestTargetViolations([pkg], {
    readSource: () => '#![cfg(feature = "first")]\n#![cfg(feature = "second")]\n',
  });

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /second/);
});

test('product entrypoints may inherit the guarded empty openbitfun-core default', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const app = packageAt('entry', 'src/apps/example/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      features: ['plugin-source'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [app, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.deepEqual(violations, []);
});

test('Core Agent Runtime baseline excludes concrete capability unions', () => {
  const agentRuntime = coreClosedFeatureProfileRules.find(
    (rule) => rule.featureName === 'agent-runtime',
  );
  assert.ok(agentRuntime, 'agent-runtime closed profile must exist');

  for (const forbidden of [
    'openbitfun-services-integrations/browser-control',
    'openbitfun-services-integrations/deep-research',
    'openbitfun-services-integrations/mcp',
    'openbitfun-services-integrations/models-dev',
    'openbitfun-services-integrations/remote-connect',
    'openbitfun-services-integrations/script-tool-runtime',
    'openbitfun-services-integrations/web-tools',
    'openbitfun-services-integrations/workspace-search',
    'dep:cron',
    'dep:semver',
    'dep:tokio-tungstenite',
    'git',
    'review-platform',
  ]) {
    assert.ok(
      !agentRuntime.requiredFeatureRefs.includes(forbidden),
      `agent-runtime must not own ${forbidden}`,
    );
  }
});

test('Core optional document and subscription capabilities have independent modifiers', () => {
  const ruleByFeature = new Map(
    coreClosedFeatureProfileRules.map((rule) => [rule.featureName, rule]),
  );
  assert.deepEqual(ruleByFeature.get('document-read')?.requiredFeatureRefs, [
    'tool-runtime?/document-read',
  ]);
  assert.deepEqual(ruleByFeature.get('subscription-auth')?.requiredFeatureRefs, [
    'openbitfun-ai-adapters?/subscription-auth',
  ]);
  assert.deepEqual(ruleByFeature.get('ai-adapter-runtime')?.requiredFeatureRefs, [
    'dep:openbitfun-ai-adapters',
  ]);
  assert.ok(
    !ruleByFeature.get('tools-basic')?.requiredFeatureRefs.includes('tool-runtime/document-read'),
    'baseline tools must not activate document conversion',
  );
});

test('Core product-full explicitly assembles service and tool capability owners', () => {
  for (const required of [
    'document-read',
    'subscription-auth',
    'i18n-runtime',
    'model-catalog',
    'mcp-runtime',
    'remote-connect',
    'workspace-search',
    'browser-control',
    'web-tools',
    'deep-research',
    'scheduled-jobs',
    'tools-basic',
    'tools-git',
    'tools-mcp',
    'tools-browser-web',
    'tools-computer-use',
    'tools-creation',
    'tools-image-analysis',
    'tools-miniapp',
    'tools-canvas',
    'tools-agent-control',
  ]) {
    assert.ok(
      coreProductFullFeatureAssemblyRule.requiredFeatureRefs.includes(required),
      `product-full must explicitly assemble ${required}`,
    );
  }
});

test('product entrypoints must select explicit openbitfun-core features', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const interfacePackage = packageAt(
    'interface',
    'src/crates/interfaces/acp/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
    })],
  );

  const violations = findProductEntrypointCoreFeatureViolations(
    [interfacePackage, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /at least one explicit feature/);
});

test('explicit product entrypoint openbitfun-core feature selections pass', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const consumers = [
    packageAt('app', 'src/apps/example/Cargo.toml'),
    packageAt('interface', 'src/crates/interfaces/acp/Cargo.toml'),
    packageAt('installer', 'OpenBitFun-Installer/src-tauri/Cargo.toml'),
  ].map((pkg) => ({
    ...pkg,
    dependencies: [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['plugin-source'],
    })],
  }));

  assert.deepEqual(
    findProductEntrypointCoreFeatureViolations(
      [...consumers, core, packageAt('no-core', 'src/apps/no-core/Cargo.toml')],
      { root: TEST_ROOT, crateLayoutRules },
    ),
    [],
  );
});

test('Desktop and Server must retain the full product Core capability closure', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');

  for (const [name, manifestPath] of [
    ['openbitfun-desktop', 'src/apps/desktop/Cargo.toml'],
    ['openbitfun-server', 'src/apps/server/Cargo.toml'],
  ]) {
    const product = packageAt(name, manifestPath, [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        usesDefaultFeatures: false,
        features: ['i18n-runtime'],
      }),
    ]);
    const messages = findProductEntrypointCoreFeatureViolations(
      [product, core],
      { root: TEST_ROOT, crateLayoutRules },
    ).map((violation) => violation.message);

    assert.deepEqual(messages, [
      `${name} Core capability closure must select exactly product-full`,
    ]);
  }
});

test('Desktop and Server must retain their Core product dependency', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  for (const [name, manifestPath] of [
    ['openbitfun-desktop', 'src/apps/desktop/Cargo.toml'],
    ['openbitfun-server', 'src/apps/server/Cargo.toml'],
  ]) {
    const product = packageAt(name, manifestPath);
    assert.deepEqual(
      findProductEntrypointCoreFeatureViolations(
        [product, core],
        { root: TEST_ROOT, crateLayoutRules },
      ).map((violation) => violation.message),
      [`${name} Core capability closure must keep the openbitfun-core dependency`],
    );
  }
});

test('Desktop must select only the ACP client role', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: {
      default: ['client', 'server'],
      client: [],
      server: [],
    },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      usesDefaultFeatures: false,
      features: ['client', 'server'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /Desktop ACP role selection must not include server/);
});

test('ACP consumers must disable compatibility default roles', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      usesDefaultFeatures: true,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must set default-features = false on every dependency/);
});

test('CLI must select both ACP roles explicitly', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: {
      default: ['client', 'server'],
      client: [],
      server: [],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      usesDefaultFeatures: false,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /CLI ACP role selection must include server/);
});

test('new product entrypoints must register an explicit ACP role selection', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: {
      default: ['client', 'server'],
      client: [],
      server: [],
    },
  };
  const newHost = packageAt('openbitfun-new-host', 'src/apps/new-host/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      usesDefaultFeatures: false,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [newHost, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must register an explicit role selection/);
});

test('ACP roles must be selected by an unconditional normal dependency', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: {
      default: ['client', 'server'],
      client: [],
      server: [],
    },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      kind: 'dev',
      usesDefaultFeatures: false,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(
    violations[0].message,
    /Desktop ACP role selection must keep an unconditional normal openbitfun-acp dependency/,
  );
});

test('reviewed ACP roles require an unconditional normal dependency', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      target: 'cfg(windows)',
      usesDefaultFeatures: false,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must keep an unconditional normal openbitfun-acp dependency/);
});

test('target-specific ACP edges cannot expand a reviewed product role', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      usesDefaultFeatures: false,
      features: ['client'],
    }),
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      target: 'cfg(windows)',
      usesDefaultFeatures: false,
      features: ['server'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /Desktop ACP role selection must not include server/);
});

test('dev and build ACP edges cannot expand a reviewed product role', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };

  for (const kind of ['dev', 'build']) {
    const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
      pathDependency('src/crates/interfaces/acp', {
        name: 'openbitfun-acp',
        usesDefaultFeatures: false,
        features: ['client'],
      }),
      pathDependency('src/crates/interfaces/acp', {
        name: 'openbitfun-acp',
        kind,
        usesDefaultFeatures: false,
        features: ['server'],
      }),
    ]);

    const violations = findProductEntrypointCoreFeatureViolations(
      [desktop, acp],
      { root: TEST_ROOT, crateLayoutRules },
    );

    assert.equal(violations.length, 1, `${kind} dependency must not widen Desktop ACP roles`);
    assert.match(violations[0].message, /Desktop ACP role selection must not include server/);
  }
});

test('reviewed ACP product dependencies must not become optional', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };
  const desktop = packageAt('openbitfun-desktop', 'src/apps/desktop/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', {
      name: 'openbitfun-acp',
      optional: true,
      usesDefaultFeatures: false,
      features: ['client'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [desktop, acp],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /must keep an unconditional normal openbitfun-acp dependency/);
  assert.match(violations[1].message, /must not make a openbitfun-acp dependency optional/);
});

test('target, dev, and build ACP consumers must still register their role selection', () => {
  const acp = {
    ...packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml'),
    features: { default: ['client', 'server'], client: [], server: [] },
  };
  for (const dependency of [
    { target: 'cfg(windows)' },
    { kind: 'dev' },
    { kind: 'build' },
  ]) {
    const newHost = packageAt('openbitfun-new-host', 'src/apps/new-host/Cargo.toml', [
      pathDependency('src/crates/interfaces/acp', {
        name: 'openbitfun-acp',
        ...dependency,
        usesDefaultFeatures: false,
        features: ['client'],
      }),
    ]);

    const violations = findProductEntrypointCoreFeatureViolations(
      [newHost, acp],
      { root: TEST_ROOT, crateLayoutRules },
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /must register an explicit role selection/);
  }
});

const SDK_HOST_REVIEWED_CORE_FEATURES = [
  'agent-runtime',
  'document-read',
  'subscription-auth',
  'external-sources',
  'tools-basic',
  'tools-git',
  'tools-mcp',
  'tools-browser-web',
  'tools-computer-use',
  'tools-image-analysis',
  'tools-agent-control',
];

const ACP_REVIEWED_CORE_FEATURES = [
  ...SDK_HOST_REVIEWED_CORE_FEATURES,
  'ssh-remote',
];

const CLI_REVIEWED_CORE_FEATURES = [
  'tools-pages',
  ...ACP_REVIEWED_CORE_FEATURES,
  'product-search',
  'remote-connect',
  'plugin-runtime',
  'opencode-plugin-host',
];

const APP_SERVER_REVIEWED_CORE_FEATURES = [
  'external-sources',
  'git',
  'i18n-runtime',
  'remote-connect',
  'web-tools',
];

test('OpenCode Plugin Host keeps retired LSP outside its feature closure', () => {
  const rule = coreClosedFeatureProfileRules.find(
    (candidate) => candidate.manifestPath === 'src/crates/assembly/core/Cargo.toml'
      && candidate.featureName === 'opencode-plugin-host',
  );

  assert.ok(rule, 'opencode-plugin-host feature closure rule');
  assert.equal(rule.requiredFeatureRefs.includes('lsp'), false);
});

test('SDK Host Core capability closure keeps every reviewed owner', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const sdkHost = packageAt(
    'openbitfun-sdk-host-app',
    'src/apps/sdk-host/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: SDK_HOST_REVIEWED_CORE_FEATURES.filter(
        (feature) => feature !== 'external-sources',
      ),
    })],
  );

  const violations = findProductEntrypointCoreFeatureViolations(
    [sdkHost, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.deepEqual(violations.map((violation) => violation.message), [
    'openbitfun-sdk-host-app Core capability closure must include external-sources',
  ]);
});

test('SDK Host closure rejects unreviewed capability owners below Core', () => {
  const cases = [
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'remote-connect'],
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'remote-ssh'],
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'remote-ssh-concrete'],
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'function-agents'],
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'announcement'],
    ['openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', 'product-full'],
    ['openbitfun-product-domains', 'src/crates/contracts/product-domains/Cargo.toml', 'function-agents'],
    ['openbitfun-product-domains', 'src/crates/contracts/product-domains/Cargo.toml', 'product-full'],
    ['openbitfun-services-core', 'src/crates/services/services-core/Cargo.toml', 'dispatch-workspace'],
  ];

  for (const [ownerName, ownerManifest, forbiddenFeature] of cases) {
    const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
    const owner = {
      ...packageAt(ownerName, ownerManifest),
      features: { [forbiddenFeature]: [] },
    };
    const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency(ownerManifest.replace('/Cargo.toml', ''), {
        name: ownerName,
        usesDefaultFeatures: false,
        features: [forbiddenFeature],
      }),
    ]);
    const sdkHost = packageAt(
      'openbitfun-sdk-host-app',
      'src/apps/sdk-host/Cargo.toml',
      [
        pathDependency('src/crates/assembly/core', {
          name: 'openbitfun-core',
          usesDefaultFeatures: false,
          features: SDK_HOST_REVIEWED_CORE_FEATURES,
        }),
        pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
      ],
    );

    const violations = findProductEntrypointCoreFeatureViolations(
      [sdkHost, bridge, core, owner],
      { root: TEST_ROOT, crateLayoutRules },
    );

    const forbiddenOwner = `${ownerName}/${forbiddenFeature}`;
    assert.equal(violations.length, 1, forbiddenOwner);
    assert.match(
      violations[0].message,
      new RegExp(forbiddenOwner),
    );
  }
});

test('SDK Host closure inspects lower owners forwarded by reviewed Core features', () => {
  const ownerManifest = 'src/crates/services/services-integrations/Cargo.toml';
  const core = {
    ...packageAt(
      'openbitfun-core',
      'src/crates/assembly/core/Cargo.toml',
      [pathDependency('src/crates/services/services-integrations', {
        name: 'openbitfun-services-integrations',
        optional: true,
        usesDefaultFeatures: false,
      })],
    ),
    features: {
      'external-sources': ['openbitfun-services-integrations/remote-connect'],
    },
  };
  const owner = {
    ...packageAt('openbitfun-services-integrations', ownerManifest),
    features: { 'remote-connect': [] },
  };
  const sdkHost = packageAt(
    'openbitfun-sdk-host-app',
    'src/apps/sdk-host/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: SDK_HOST_REVIEWED_CORE_FEATURES,
    })],
  );

  const violations = findProductEntrypointCoreFeatureViolations(
    [sdkHost, core, owner],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(
    violations[0].message,
    /openbitfun-services-integrations\/remote-connect/,
  );
});

test('App Server Core capability closure keeps its production Git owner', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const appServer = packageAt(
    'openbitfun-app-server',
    'src/crates/interfaces/app-server/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: APP_SERVER_REVIEWED_CORE_FEATURES.filter((feature) => feature !== 'git'),
    })],
  );

  const violations = findProductEntrypointCoreFeatureViolations(
    [appServer, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.deepEqual(violations.map((violation) => violation.message), [
    'openbitfun-app-server Core capability closure must include git',
  ]);
});

test('App Server Core capability closure keeps its backend i18n runtime', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const appServer = packageAt(
    'openbitfun-app-server',
    'src/crates/interfaces/app-server/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: APP_SERVER_REVIEWED_CORE_FEATURES.filter(
        (feature) => feature !== 'i18n-runtime',
      ),
    })],
  );

  const violations = findProductEntrypointCoreFeatureViolations(
    [appServer, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.deepEqual(violations.map((violation) => violation.message), [
    'openbitfun-app-server Core capability closure must include i18n-runtime',
  ]);
});

test('App Server reviewed Core capability closure remains independently valid', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const appServer = packageAt(
    'openbitfun-app-server',
    'src/crates/interfaces/app-server/Cargo.toml',
    [pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: APP_SERVER_REVIEWED_CORE_FEATURES,
    })],
  );

  assert.deepEqual(
    findProductEntrypointCoreFeatureViolations(
      [appServer, core],
      { root: TEST_ROOT, crateLayoutRules },
    ),
    [],
  );
});

test('ACP Core capability closure rejects the Canvas product tool owner', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const acp = packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: [...ACP_REVIEWED_CORE_FEATURES, 'tools-canvas'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [acp, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must not include unreviewed feature tools-canvas/);
});

test('ACP Core capability closure validation cannot be disabled by removing an owner', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const acp = packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ACP_REVIEWED_CORE_FEATURES.filter((feature) => feature !== 'agent-runtime'),
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [acp, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.deepEqual(violations.map((violation) => violation.message), [
    'openbitfun-acp Core capability closure must include agent-runtime',
  ]);
});

test('CLI Core capability closure requires every reviewed owner', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: CLI_REVIEWED_CORE_FEATURES.filter((feature) => feature !== 'plugin-runtime'),
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must include plugin-runtime/);
});

test('CLI entrypoint must not select the product-full Core feature', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.ok(violations.some((violation) =>
    /openbitfun-cli -> openbitfun-core\/product-full/.test(violation.message)));
});

test('CLI entrypoint must not reach product-full through a Core owner feature', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: {
      'agent-runtime': ['runtime-services', 'product-full'],
      'runtime-services': ['dep:openbitfun-runtime-services'],
      'product-full': ['dep:openbitfun-agent-runtime'],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['agent-runtime'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.ok(violations.some((violation) =>
    /openbitfun-cli -> openbitfun-core\/product-full/.test(violation.message)));
});

test('CLI dependency closure must not re-enable product-full through an interface crate', () => {
  const core = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml');
  const acp = packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/interfaces/acp', { name: 'openbitfun-acp' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, acp, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.ok(violations.some((violation) =>
    /openbitfun-cli -> openbitfun-acp -> openbitfun-core\/product-full/.test(violation.message)));
});

test('CLI dependency closure rejects indirect Core default features', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { default: ['product-full'], 'product-full': [] },
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', { name: 'openbitfun-core' }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-cli -> bridge -> openbitfun-core\/product-full/);
});

test('CLI dependency closure resolves active intermediate feature forwarding', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { default: ['product-full'], 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      default: ['full'],
      full: ['dep:openbitfun-core', 'openbitfun-core/product-full'],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-cli -> bridge -> openbitfun-core\/product-full/);
});

test('CLI dependency closure resolves renamed optional dependency forwarding', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        rename: 'core-alias',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      full: ['dep:core-alias', 'core-alias/product-full'],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['full'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('CLI dependency closure unions weak forwarding and optional activation per package', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const left = packageAt('left', 'src/crates/assembly/left/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['forward'],
    }),
  ]);
  const right = packageAt('right', 'src/crates/assembly/right/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['activate'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/left', { name: 'left' }),
    pathDependency('src/crates/assembly/right', { name: 'right' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, left, right, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('CLI dependency closure keeps normal and build feature unions separate', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const normalParent = packageAt('normal-parent', 'src/crates/assembly/normal-parent/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['forward'],
    }),
  ]);
  const buildParent = packageAt('build-parent', 'src/crates/assembly/build-parent/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['activate'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/normal-parent', { name: 'normal-parent' }),
    pathDependency('src/crates/assembly/build-parent', {
      name: 'build-parent',
      kind: 'build',
    }),
  ]);

  assert.deepEqual(
    findProductEntrypointCoreFeatureViolations(
      [cli, normalParent, buildParent, bridge, core],
      { root: TEST_ROOT, crateLayoutRules },
    ),
    [],
  );
});

test('CLI dependency closure keeps proc-macro and normal feature unions separate', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const shared = {
    ...packageAt('shared', 'src/crates/assembly/shared/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const normalParent = packageAt('normal-parent', 'src/crates/assembly/normal-parent/Cargo.toml', [
    pathDependency('src/crates/assembly/shared', {
      name: 'shared',
      usesDefaultFeatures: false,
      features: ['forward'],
    }),
  ]);
  const macroParent = {
    ...packageAt('macro-parent', 'src/crates/assembly/macro-parent/Cargo.toml', [
      pathDependency('src/crates/assembly/shared', {
        name: 'shared',
        usesDefaultFeatures: false,
        features: ['activate'],
      }),
    ]),
    targets: [{ kind: ['proc-macro'] }],
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/normal-parent', { name: 'normal-parent' }),
    pathDependency('src/crates/assembly/macro-parent', { name: 'macro-parent' }),
  ]);

  assert.deepEqual(
    findProductEntrypointCoreFeatureViolations(
      [cli, normalParent, macroParent, shared, core],
      { root: TEST_ROOT, crateLayoutRules },
    ),
    [],
  );
});

test('CLI dependency architecture closure cannot hide features behind target cfgs', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: 'cfg(windows)',
      usesDefaultFeatures: false,
      features: ['forward'],
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: 'cfg(unix)',
      usesDefaultFeatures: false,
      features: ['activate'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('CLI dependency architecture closure unions unconditional and target-specific declarations', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'product-full': [] },
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      usesDefaultFeatures: false,
      features: ['forward'],
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: 'cfg(windows)',
      usesDefaultFeatures: false,
      features: ['activate'],
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

function reviewedCoreFeaturesFor(rootName) {
  return rootName === 'openbitfun-cli'
    ? CLI_REVIEWED_CORE_FEATURES
    : ACP_REVIEWED_CORE_FEATURES;
}

function targetedWeakForwardingGraph(rootName, forwardTarget, activateTarget, reverse = false) {
  const reviewedFeatures = reviewedCoreFeaturesFor(rootName);
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: Object.fromEntries([
      ...reviewedFeatures.map((feature) => [feature, []]),
      ['product-full', []],
    ]),
  };
  const bridge = {
    ...packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        optional: true,
        usesDefaultFeatures: false,
      }),
    ]),
    features: {
      forward: ['openbitfun-core?/product-full'],
      activate: ['dep:openbitfun-core'],
    },
  };
  const root = packageAt(rootName, rootName === 'openbitfun-cli'
    ? 'src/apps/cli/Cargo.toml'
    : 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: reviewedFeatures,
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: forwardTarget,
      usesDefaultFeatures: false,
      features: [reverse ? 'activate' : 'forward'],
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: activateTarget,
      usesDefaultFeatures: false,
      features: [reverse ? 'forward' : 'activate'],
    }),
  ]);

  return { root, bridge, core };
}

test('CLI dependency architecture closure ignores Windows target spelling differences', () => {
  for (const reverse of [false, true]) {
    const { root, bridge, core } = targetedWeakForwardingGraph(
      'openbitfun-cli',
      'cfg(windows)',
      'cfg(target_os = "windows")',
      reverse,
    );
    const violations = findProductEntrypointCoreFeatureViolations(
      [root, bridge, core],
      { root: TEST_ROOT, crateLayoutRules },
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /openbitfun-core\/product-full/);
  }
});

test('CLI dependency architecture closure includes Unix and not-Windows declarations', () => {
  for (const reverse of [false, true]) {
    const { root, bridge, core } = targetedWeakForwardingGraph(
      'openbitfun-cli',
      'cfg(not(windows))',
      'cfg(unix)',
      reverse,
    );
    const violations = findProductEntrypointCoreFeatureViolations(
      [root, bridge, core],
      { root: TEST_ROOT, crateLayoutRules },
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /openbitfun-core\/product-full/);
  }
});

test('CLI dependency architecture closure includes nested target-specific declarations', () => {
  const reviewedFeatures = reviewedCoreFeaturesFor('openbitfun-cli');
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: Object.fromEntries([
      ...reviewedFeatures.map((feature) => [feature, []]),
      ['product-full', []],
    ]),
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      target: 'cfg(unix)',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: reviewedFeatures,
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: 'cfg(windows)',
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('CLI dependency architecture closure includes target-specific build dependencies', () => {
  const reviewedFeatures = reviewedCoreFeaturesFor('openbitfun-cli');
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: Object.fromEntries([
      ...reviewedFeatures.map((feature) => [feature, []]),
      ['product-full', []],
    ]),
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      kind: 'build',
      target: 'cfg(unix)',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: reviewedFeatures,
    }),
    pathDependency('src/crates/assembly/bridge', {
      name: 'bridge',
      target: 'cfg(windows)',
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('CLI dependency closure inspects non-default root features', () => {
  const reviewedFeatures = reviewedCoreFeaturesFor('openbitfun-cli');
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: Object.fromEntries([
      ...reviewedFeatures.map((feature) => [feature, []]),
      ['product-full', []],
    ]),
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);
  const cli = {
    ...packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
      pathDependency('src/crates/assembly/core', {
        name: 'openbitfun-core',
        usesDefaultFeatures: false,
        features: reviewedFeatures,
      }),
      pathDependency('src/crates/assembly/bridge', {
        name: 'bridge',
        optional: true,
      }),
    ]),
    features: {
      default: [],
      bad: ['dep:bridge'],
    },
  };

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('ACP dependency closure rejects indirect unreviewed Core features', () => {
  const reviewedFeatures = reviewedCoreFeaturesFor('openbitfun-acp');
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: Object.fromEntries([
      ...reviewedFeatures.map((feature) => [feature, []]),
      ['product-full', []],
    ]),
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['product-full'],
    }),
  ]);
  const acp = packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: reviewedFeatures,
    }),
    pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [acp, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/product-full/);
});

test('ACP active closure cannot be expanded by a reviewed owner definition', () => {
  const reviewedFeatures = reviewedCoreFeaturesFor('openbitfun-acp');
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: {
      ...Object.fromEntries(reviewedFeatures.map((feature) => [feature, []])),
      'tools-git': ['plugin-runtime'],
      'plugin-runtime': [],
    },
  };
  const acp = packageAt('openbitfun-acp', 'src/crates/interfaces/acp/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: reviewedFeatures,
    }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [acp, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/plugin-runtime/);
});

test('CLI dependency closure includes build dependencies and excluded capabilities', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: {
      'cli-everything': ['announcement'],
      announcement: [],
    },
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      kind: 'build',
      usesDefaultFeatures: false,
      features: ['cli-everything'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/announcement/);
});

test('CLI dependency closure excludes the Core dispatch store', () => {
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml'),
    features: { 'dispatch-store': [] },
  };
  const bridge = packageAt('bridge', 'src/crates/assembly/bridge/Cargo.toml', [
    pathDependency('src/crates/assembly/core', {
      name: 'openbitfun-core',
      usesDefaultFeatures: false,
      features: ['dispatch-store'],
    }),
  ]);
  const cli = packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [
    pathDependency('src/crates/assembly/bridge', { name: 'bridge' }),
  ]);

  const violations = findProductEntrypointCoreFeatureViolations(
    [cli, bridge, core],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /openbitfun-core\/dispatch-store/);
});

test('cargo layer checker rejects reverse edges across dependency kinds', () => {
  const packages = [
    packageAt('entry', 'src/apps/example/Cargo.toml'),
    packageAt('adapter', 'src/crates/adapters/transport/Cargo.toml'),
    packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [
      pathDependency('src/apps/example', { optional: true }),
    ]),
    packageAt('service', 'src/crates/services/services-core/Cargo.toml', [
      pathDependency('src/crates/adapters/transport'),
      pathDependency('src/crates/assembly/core', {
        kind: 'dev',
        target: 'cfg(windows)',
      }),
    ]),
    packageAt('runtime', 'src/crates/execution/agent-runtime/Cargo.toml', [
      pathDependency('src/crates/adapters/transport'),
      pathDependency('src/crates/services/services-core'),
    ]),
    packageAt('contract', 'src/crates/contracts/core-types/Cargo.toml', [
      pathDependency('src/crates/services/services-core', { kind: 'build' }),
    ]),
  ];

  const violations = findCargoLayerViolations(packages, {
    root: TEST_ROOT,
    crateLayoutRules,
  });

  assert.equal(violations.length, 6);
  assert.match(violations[0].message, /assembly.*->.*entry.*apps.*normal optional dependency/);
  assert.match(violations[1].message, /service.*services.*->.*adapter.*adapters.*normal dependency/);
  assert.match(violations[2].message, /service.*services.*->.*assembly.*dev dependency.*cfg\(windows\)/);
  assert.match(violations[3].message, /runtime.*execution.*->.*adapter.*adapters.*normal dependency/);
  assert.match(violations[4].message, /runtime.*execution.*->.*service.*services.*normal dependency/);
  assert.match(violations[5].message, /contract.*contracts.*->.*service.*services.*build dependency/);
});

test('workspace Tokio capabilities stay crate-owned', async () => {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const workspaceManifest = await readFile(new URL('../Cargo.toml', import.meta.url), 'utf8');
  const workspaceTokio = workspaceManifest.match(/^tokio\s*=\s*\{[^}]+\}/m)?.[0];

  assert.ok(workspaceTokio, 'workspace dependencies must declare Tokio once');
  assert.match(workspaceTokio, /default-features\s*=\s*false/);
  assert.doesNotMatch(workspaceTokio, /(?:^|,\s*)features\s*=/);
  const packages = collectCargoMetadataPackages({ root: repositoryRoot });
  assert.deepEqual(findTokioDependencyFeatureViolations(packages), []);

  const integrations = packages.find((pkg) => pkg.name === 'openbitfun-services-integrations');
  const mutatedPackages = packages.map((pkg) => pkg === integrations
    ? {
        ...pkg,
        dependencies: pkg.dependencies.map((dependency) =>
          dependency.name === 'tokio' && (dependency.kind ?? null) === null
            ? { ...dependency, features: ['net'] }
            : dependency),
      }
    : pkg);
  assert.ok(
    findTokioDependencyFeatureViolations(mutatedPackages).some((violation) =>
      violation.message === 'openbitfun-services-integrations has unexpected base Tokio capabilities: net'),
  );
});

test('services integrations Tokio owner contracts reject feature-union masking', async () => {
  const manifest = await readFile(
    new URL('../src/crates/services/services-integrations/Cargo.toml', import.meta.url),
    'utf8',
  );
  const mutations = [
    ['plugin-source', 'tokio/time', /plugin-source missing effective Tokio capabilities: time/],
    ['mcp', 'tokio/process', /mcp missing effective Tokio capabilities: process/],
    ['miniapp-market', 'miniapp-runtime', /miniapp-market missing effective Tokio capabilities: fs/],
    ['function-agents', 'git', /function-agents missing effective Tokio capabilities: fs/],
    ['remote-ssh-concrete', 'remote-ssh', /remote-ssh-concrete missing effective Tokio capabilities: fs/],
  ];

  for (const [feature, value, expected] of mutations) {
    const mutated = removeFeatureValue(manifest, feature, value);
    assert.notEqual(mutated, manifest, `${feature} must own ${value} in the fixture`);
    const messages = findServicesIntegrationsTokioFeatureViolations(
      servicesIntegrationsPackage(mutated),
    ).map((violation) => violation.message).join('\n');
    assert.match(messages, expected);
  }
});

test('services integrations Reqwest policy uses Cargo-decoded feature references', () => {
  const pkg = servicesIntegrationsPackage(`
[features]
reqwest = ["dep:reqwest"]
announcement = ["reqwest", "reqwest/rustls-no-provider"]
file-watch = ["reqwest?/__native-tls"]
mcp = ["reqwest", "reqwest/rustls-no-provider", "reqwest/json"]
models-dev = ["reqwest", "reqwest/rustls-no-provider", "reqwest/system-proxy"]
speech = ["reqwest", "reqwest/rustls-no-provider", "reqwest/http3"]
`);

  const messages = findServicesIntegrationsReqwestFeatureViolations(pkg)
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /announcement.*missing Reqwest feature reference reqwest\/json/);
  assert.match(messages, /file-watch.*outside its reviewed owner features/);
  assert.match(messages, /mcp.*missing Reqwest feature reference reqwest\/stream/);
  assert.doesNotMatch(messages, /models-dev.*system-proxy/);
  assert.match(messages, /speech.*unreviewed Reqwest feature reference reqwest\/http3/);
  assert.doesNotMatch(messages, /missing reqwest\/rustls\b/);
  assert.doesNotMatch(messages, /unreviewed.*reqwest\/rustls-no-provider/);
});

test('every services integrations Reqwest owner activates the reviewed TLS provider', async () => {
  const manifest = await readFile(
    new URL('../src/crates/services/services-integrations/Cargo.toml', import.meta.url),
    'utf8',
  );
  const mutated = removeFeatureValue(
    manifest,
    'review-platform',
    'openbitfun-services-core/tls-provider',
  );
  assert.notEqual(mutated, manifest, 'review-platform must own the TLS provider in the fixture');

  const messages = findServicesIntegrationsReqwestFeatureViolations(
    servicesIntegrationsPackage(mutated),
  ).map((violation) => violation.message).join('\n');
  assert.match(messages, /review-platform.*missing openbitfun-services-core\/tls-provider/);
});

test('direct Reqwest clients reject extra decoded dependency and package features', () => {
  const pkg = {
    ...packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [{
      name: 'reqwest',
      kind: null,
      optional: false,
      uses_default_features: false,
      features: [
        'http2',
        'stream',
        'rustls-no-provider',
        '__native-tls',
      ],
    }]),
    features: { default: ['reqwest?/http3'] },
  };

  const messages = findReqwestDependencyFeatureViolations([pkg])
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /openbitfun-cli.*unexpected dependency features: __native-tls/);
  assert.match(messages, /openbitfun-cli:default.*unreviewed Reqwest feature reference reqwest\?\/http3/);

  const installerMessages = findReqwestDependencyFeatureViolations([{
    ...pkg,
    name: 'openbitfun-installer',
    manifest_path: join(TEST_ROOT, 'OpenBitFun-Installer', 'src-tauri', 'Cargo.toml'),
  }]).map((violation) => violation.message).join('\n');
  assert.match(installerMessages, /openbitfun-installer.*missing a reviewed owner profile/);
});

test('AI adapters Reqwest profile owns the supported SOCKS transport', () => {
  const baseFeatures = ['http2', 'json', 'stream'];
  const valid = {
    ...packageAt('openbitfun-ai-adapters', 'src/crates/adapters/ai-adapters/Cargo.toml', [
      {
        name: 'reqwest',
        kind: null,
        optional: false,
        uses_default_features: false,
        features: [...baseFeatures, 'rustls-no-provider', 'socks'],
      },
      {
        name: 'openbitfun-services-core',
        kind: null,
        optional: false,
        features: ['tls-provider'],
      },
    ]),
    features: { 'subscription-auth': ['reqwest/form'] },
  };
  const missingSocks = {
    ...packageAt(
    'openbitfun-ai-adapters',
    'src/crates/adapters/ai-adapters/Cargo.toml',
    [
      {
        name: 'reqwest',
        kind: null,
        optional: false,
        uses_default_features: false,
        features: [...baseFeatures, 'rustls-no-provider'],
      },
      {
        name: 'openbitfun-services-core',
        kind: null,
        optional: false,
        features: ['tls-provider'],
      },
    ],
    ),
    features: { 'subscription-auth': ['reqwest/form'] },
  };

  assert.deepEqual(findReqwestDependencyFeatureViolations([valid]), []);
  const messages = findReqwestDependencyFeatureViolations([missingSocks])
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /openbitfun-ai-adapters.*missing features: socks/);
});

test('Reqwest metadata policy covers URL-only and future dependency owners', () => {
  const coreFeatures = [];
  const core = {
    ...packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml', [{
      name: 'reqwest',
      kind: null,
      optional: true,
      uses_default_features: false,
      features: coreFeatures,
    }]),
    features: { product: ['dep:reqwest', 'reqwest/__native-tls'] },
  };
  const future = packageAt('future-client', 'src/crates/services/future-client/Cargo.toml', [{
    name: 'reqwest',
    kind: null,
    optional: false,
    uses_default_features: false,
    features: ['http2', 'rustls', 'stream'],
  }]);
  const duplicate = packageAt(
    'openbitfun-services-integrations',
    'src/crates/services/services-integrations/Cargo.toml',
    [
      {
        name: 'reqwest',
        kind: null,
        optional: true,
        uses_default_features: false,
        features: ['http2'],
      },
      {
        name: 'reqwest',
        rename: 'windows_reqwest',
        kind: null,
        optional: true,
        target: 'cfg(windows)',
        uses_default_features: false,
        features: ['http2', '__native-tls'],
      },
    ],
  );

  const messages = findReqwestDependencyFeatureViolations([core, future, duplicate])
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /openbitfun-core:product.*reqwest\/__native-tls/);
  assert.match(messages, /future-client.*missing a reviewed owner profile/);
  assert.match(messages, /openbitfun-services-integrations.*exactly one normal Reqwest dependency/);
});

test('Reqwest consumers inherit the workspace version without duplicating feature rules', async () => {
  const { requiredContentRules } = await import(
    './core-boundaries/rules/source/required-rules.mjs'
  );
  const rules = requiredContentRules.filter((rule) =>
    rule.reason.includes('Reqwest consumers must inherit the workspace-owned compatible version')
  );

  assert.equal(rules.length, 7);
  for (const rule of rules) {
    const pattern = rule.patterns[0].regex;
    assert.match('reqwest = { workspace = true, features = ["rustls-no-provider"] }', pattern);
    assert.doesNotMatch(
      'reqwest = { version = "99", features = ["rustls-no-provider"] }',
      pattern,
    );
  }
});

test('third-party capability profiles reject ambient feature unions and unreviewed owners', () => {
  const validPackages = [
    packageAt('openbitfun-cli', 'src/apps/cli/Cargo.toml', [{
      name: 'image',
      kind: null,
      optional: false,
      uses_default_features: false,
      features: ['gif', 'jpeg', 'png', 'webp'],
    }]),
    packageAt('openbitfun-server', 'src/apps/server/Cargo.toml', [{
      name: 'axum',
      kind: null,
      optional: false,
      uses_default_features: true,
      features: ['json', 'ws'],
    }]),
    packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml', [{
      name: 'tokio-tungstenite',
      kind: null,
      optional: true,
      uses_default_features: true,
      features: [],
    }]),
    packageAt('openbitfun-services-core', 'src/crates/services/services-core/Cargo.toml', [{
      name: 'git2',
      kind: null,
      optional: true,
      uses_default_features: false,
      features: ['vendored-libgit2'],
    }]),
  ];

  assert.deepEqual(findThirdPartyCapabilityFeatureViolations(validPackages), []);

  const mutatedPackages = structuredClone(validPackages);
  mutatedPackages[0].dependencies[0].features.push('bmp');
  mutatedPackages[1].dependencies[0].features = ['json'];
  mutatedPackages[2].dependencies[0].features.push('rustls-tls-native-roots');
  mutatedPackages[3].dependencies[0].features.push('https');
  mutatedPackages[3].dependencies[0].rename = 'private-git2';
  mutatedPackages.push(packageAt('future-image-owner', 'src/apps/future/Cargo.toml', [{
    name: 'image',
    kind: null,
    optional: false,
    uses_default_features: false,
    features: ['png'],
  }]));

  const messages = findThirdPartyCapabilityFeatureViolations(mutatedPackages)
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /openbitfun-cli Image dependency has unexpected features: bmp/);
  assert.match(messages, /openbitfun-server Axum dependency missing features: ws/);
  assert.match(messages, /openbitfun-core Tokio Tungstenite dependency has unexpected features: rustls-tls-native-roots/);
  assert.match(messages, /openbitfun-services-core Git2 dependency has unexpected features: https/);
  assert.match(messages, /openbitfun-services-core Git2 dependency does not match its reviewed owner shape/);
  assert.match(messages, /future-image-owner Image dependency is missing a reviewed owner profile/);
});

test('relay WebSocket lifecycle client stays test-only without TLS or defaults', () => {
  const pkg = packageAt('openbitfun-relay-service', 'src/crates/services/relay-service/Cargo.toml', [{
    name: 'tokio-tungstenite', kind: 'dev', optional: false, uses_default_features: false,
    features: ['connect', 'handshake'],
  }]);
  assert.deepEqual(findThirdPartyCapabilityFeatureViolations([pkg]), []);
  for (const change of [
    { kind: null }, { uses_default_features: true },
    { features: ['connect', 'handshake', 'rustls-tls-native-roots'] },
  ]) {
    const mutated = structuredClone(pkg);
    Object.assign(mutated.dependencies[0], change);
    assert.ok(findThirdPartyCapabilityFeatureViolations([mutated]).length > 0);
  }
});

test('services integrations image codecs stay attached to exact product owners', () => {
  const pkg = {
    ...packageAt('openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', [{
      name: 'image',
      kind: null,
      optional: true,
      uses_default_features: false,
      features: [],
    }]),
    features: {
      image: ['dep:image'],
      'miniapp-market': ['image', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      'remote-connect': [
        'image',
        'image/bmp',
        'image/gif',
        'image/jpeg',
        'image/png',
        'image/webp',
      ],
    },
  };

  assert.deepEqual(findThirdPartyCapabilityFeatureViolations([pkg]), []);

  const mutated = structuredClone(pkg);
  mutated.features.image.push('image/png');
  mutated.features['miniapp-market'].push('image/bmp');
  mutated.features['remote-connect'] = mutated.features['remote-connect']
    .filter((reference) => reference !== 'image/gif');
  mutated.features.default = ['image/png'];
  const messages = findThirdPartyCapabilityFeatureViolations([mutated])
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /miniapp-market.*unexpected Image capabilities: bmp/);
  assert.match(messages, /remote-connect.*missing Image capabilities: gif/);
  assert.match(messages, /default enables Image outside its reviewed owner features/);
  assert.match(messages, /image shared Image activation alias must not select capabilities: png/);
});

test('services integrations WebSocket TLS stays attached to reviewed realtime owners', () => {
  const pkg = {
    ...packageAt('openbitfun-services-integrations', 'src/crates/services/services-integrations/Cargo.toml', [{
      name: 'tokio-tungstenite',
      kind: null,
      optional: true,
      uses_default_features: true,
      features: [],
    }]),
    features: {
      'remote-connect': [
        'dep:tokio-tungstenite',
        'tokio-tungstenite?/rustls-tls-native-roots',
      ],
      'speech-realtime': [
        'dep:tokio-tungstenite',
        'tokio-tungstenite?/rustls-tls-native-roots',
      ],
    },
  };

  assert.deepEqual(findThirdPartyCapabilityFeatureViolations([pkg]), []);

  const mutated = structuredClone(pkg);
  mutated.features['tokio-tungstenite'] = ['dep:tokio-tungstenite'];
  mutated.features['future-non-remote-owner'] = ['dep:tokio-tungstenite'];
  const messages = findThirdPartyCapabilityFeatureViolations([mutated])
    .map((violation) => violation.message)
    .join('\n');
  assert.match(messages, /future-non-remote-owner enables Tokio Tungstenite outside its reviewed owner features/);
  assert.match(messages, /tokio-tungstenite enables Tokio Tungstenite outside its reviewed owner features/);
});

test('resolved third-party feature unions reject global capability regressions', () => {
  const validRecords = [
    {
      name: 'git2',
      version: '0.21.0',
      features: ['vendored-libgit2'],
    },
    {
      name: 'image',
      version: '0.24.9',
      features: ['default', 'exr', 'tiff'],
    },
    {
      name: 'image',
      version: '0.25.10',
      features: ['bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp'],
    },
    {
      name: 'libgit2-sys',
      version: '0.18.7+1.9.6',
      features: ['vendored'],
    },
  ];

  assert.deepEqual(
    findResolvedThirdPartyCapabilityFeatureViolations(validRecords, { root: TEST_ROOT }),
    [],
  );

  const mutated = structuredClone(validRecords);
  mutated[0].features.push('https', 'vendored-openssl');
  mutated[2].features.push('exr');
  mutated[3].features.push('https', 'openssl-sys', 'vendored-openssl');
  mutated.push({
    name: 'image',
    version: '0.26.0',
    features: ['avif', 'default', 'exr'],
  });
  const messages = findResolvedThirdPartyCapabilityFeatureViolations(
    mutated,
    { root: TEST_ROOT },
  ).map((violation) => violation.message).join('\n');
  assert.match(messages, /resolved git2.*https, vendored-openssl/);
  assert.match(messages, /resolved image 0\.25\.10.*exr/);
  assert.match(messages, /resolved libgit2-sys.*https, openssl-sys, vendored-openssl/);
  assert.match(messages, /resolved image 0\.26\.0 uses an unreviewed version family/);
});

test('resolved Reqwest feature union rejects every native TLS backend alias', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [
      {
        name: 'reqwest',
        version: '0.13.4',
        features: ['rustls', 'rustls-no-provider', '__native-tls', 'native-tls-vendored-no-alpn'],
      },
      {
        name: 'reqwest',
        version: '0.12.28',
        features: ['rustls-tls', 'default-tls'],
      },
      {
        name: 'rustls',
        version: '0.23.42',
        features: ['ring', 'std'],
      },
    ],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 2);
  const messages = violations.map((violation) => violation.message).join('\n');
  assert.match(messages, /__native-tls, native-tls-vendored-no-alpn/);
  assert.match(messages, /reqwest 0\.12\.28.*default-tls/);
});

test('resolved Reqwest feature union rejects the AWS-LC selecting Rustls alias', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [{
      name: 'reqwest',
      version: '0.13.4',
      features: ['rustls', 'rustls-no-provider'],
    }, {
      name: 'rustls',
      version: '0.23.42',
      features: ['ring', 'std'],
    }],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /rustls.*AWS-LC/);
});

test('resolved Rustls feature union rejects multiple crypto providers', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [
      {
        name: 'reqwest',
        version: '0.13.4',
        features: ['rustls-no-provider'],
      },
      {
        name: 'rustls',
        version: '0.23.42',
        features: ['aws_lc_rs', 'ring', 'std'],
      },
    ],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /only the ring crypto provider.*aws_lc_rs, ring/);
});

test('resolved Rustls feature union normalizes and rejects AWS-LC aliases once', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [
      {
        name: 'reqwest',
        version: '0.13.4',
        features: ['rustls-no-provider'],
      },
      {
        name: 'rustls',
        version: '0.23.42',
        features: ['aws-lc-rs', 'aws_lc_rs', 'std'],
      },
    ],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /selects aws_lc_rs$/);
});

test('resolved Rustls feature union rejects providers split across Rustls versions', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [
      {
        name: 'reqwest',
        version: '0.13.4',
        features: ['rustls-no-provider'],
      },
      {
        name: 'rustls',
        version: '0.23.42',
        features: ['ring', 'std'],
      },
      {
        name: 'rustls',
        version: '0.22.4',
        features: ['aws_lc_rs', 'std'],
      },
    ],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /only the ring crypto provider.*aws_lc_rs, ring/);
});

test('resolved Reqwest Rustls closure rejects a missing crypto provider', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [{
      name: 'reqwest',
      version: '0.13.4',
      features: ['rustls-no-provider'],
    }],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /selects \(no provider\)/);
});

test('resolved Reqwest Rustls closure rejects linked AWS-LC packages', () => {
  const violations = findResolvedReqwestNativeTlsViolations(
    [
      {
        name: 'reqwest',
        version: '0.13.4',
        features: ['rustls-no-provider'],
      },
      {
        name: 'rustls',
        version: '0.23.42',
        features: ['ring', 'std'],
      },
      {
        name: 'aws-lc-rs',
        version: '1.13.3',
        features: [],
      },
    ],
    { root: TEST_ROOT },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /aws_lc_rs, ring/);
});

test('Cargo metadata Tokio policy catches table-style and renamed full dependencies', () => {
  const pkg = packageAt('table-style', 'src/crates/services/table-style/Cargo.toml', [{
    name: 'tokio',
    rename: 'async_runtime',
    kind: null,
    optional: false,
    features: ['full'],
  }]);
  const violations = findTokioDependencyFeatureViolations([pkg]);

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /table-style must not enable tokio\/full/);

  const installerViolations = findTokioDependencyFeatureViolations([{
    ...pkg,
    name: 'openbitfun-installer',
    manifest_path: join(TEST_ROOT, 'OpenBitFun-Installer', 'src-tauri', 'Cargo.toml'),
  }]);
  assert.equal(installerViolations.length, 1);
  assert.match(installerViolations[0].message, /openbitfun-installer must not enable tokio\/full/);
});

test('cargo layer checker allows documented downward and peer dependencies', () => {
  const packages = [
    packageAt('entry', 'src/apps/example/Cargo.toml', [
      pathDependency('src/crates/interfaces/acp'),
      pathDependency('src/crates/assembly/core'),
    ]),
    packageAt('interface', 'src/crates/interfaces/acp/Cargo.toml', [
      pathDependency('src/crates/assembly/core'),
    ]),
    packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [
      pathDependency('src/crates/services/services-core'),
      pathDependency('src/crates/execution/agent-runtime'),
    ]),
    packageAt('service', 'src/crates/services/services-core/Cargo.toml', [
      pathDependency('src/crates/execution/agent-runtime'),
      pathDependency('src/crates/contracts/core-types'),
    ]),
    packageAt('runtime', 'src/crates/execution/agent-runtime/Cargo.toml', [
      pathDependency('src/crates/contracts/core-types'),
    ]),
    packageAt('contract', 'src/crates/contracts/core-types/Cargo.toml'),
  ];

  assert.deepEqual(
    findCargoLayerViolations(packages, {
      root: TEST_ROOT,
      crateLayoutRules,
    }),
    [],
  );
});

test('cargo layer checker uses resolved edges for locally patched dependencies', () => {
  const entry = packageAt('entry', 'src/apps/example/Cargo.toml');
  const assembly = packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [
    { name: 'entry', path: null, kind: null, optional: false, target: null },
  ]);

  const violations = findCargoLayerViolations(
    [entry, assembly],
    { root: TEST_ROOT, crateLayoutRules },
    [{
      sourceManifestPath: assembly.manifest_path,
      targetManifestPath: entry.manifest_path,
      name: 'entry',
      kind: null,
      optional: false,
      target: null,
    }],
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /assembly.*->.*entry.*apps.*normal dependency/);
});

test('cargo layer checker combines declared path dependencies with resolved edges', () => {
  const entry = packageAt('entry', 'src/apps/example/Cargo.toml');
  const assembly = packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [
    pathDependency('src/apps/example', { optional: true }),
  ]);

  const violations = findCargoLayerViolations(
    [entry, assembly],
    { root: TEST_ROOT, crateLayoutRules },
    [],
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /assembly.*->.*entry.*apps.*normal optional dependency/);
});

test('cargo layer checker deduplicates renamed declared and resolved edges', () => {
  const entry = packageAt('entry', 'src/apps/example/Cargo.toml');
  const assembly = packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [{
    ...pathDependency('src/apps/example', { name: 'entry', optional: true }),
    rename: 'legacy_entry',
  }]);

  const violations = findCargoLayerViolations(
    [entry, assembly],
    { root: TEST_ROOT, crateLayoutRules },
    [{
      sourceManifestPath: assembly.manifest_path,
      targetManifestPath: entry.manifest_path,
      name: 'legacy_entry',
      kind: null,
      optional: true,
      target: null,
    }],
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /assembly.*->.*entry.*apps.*normal optional dependency/);
});

test('cargo layer checker rejects repository packages without a known layer', () => {
  const violations = findCargoLayerViolations(
    [packageAt('mystery', 'tools/mystery/Cargo.toml')],
    { root: TEST_ROOT, crateLayoutRules },
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /unknown crate layer.*tools\/mystery\/Cargo\.toml/);
});

test('cargo metadata collection scans standalone manifests not covered by the workspace', () => {
  const workspaceManifest = join(TEST_ROOT, 'Cargo.toml');
  const memberManifest = join(TEST_ROOT, 'src', 'apps', 'example', 'Cargo.toml');
  const installerManifest = join(TEST_ROOT, 'OpenBitFun-Installer', 'src-tauri', 'Cargo.toml');
  const calls = [];

  const packages = collectCargoMetadataPackages({
    root: TEST_ROOT,
    manifestPaths: [workspaceManifest, memberManifest, installerManifest],
    loadMetadata(manifestPath, options) {
      calls.push([manifestPath, options]);
      if (manifestPath === workspaceManifest) {
        const entry = packageAt('entry', 'src/apps/example/Cargo.toml');
        return { packages: [entry], workspace_members: [entry.id] };
      }
      if (manifestPath === installerManifest) {
        return { packages: [packageAt('installer', 'OpenBitFun-Installer/src-tauri/Cargo.toml')] };
      }
      throw new Error(`workspace member metadata should not be loaded twice: ${manifestPath}`);
    },
  });

  assert.deepEqual(calls, [
    [workspaceManifest, { noDeps: false }],
    [installerManifest, { noDeps: true }],
  ]);
  assert.deepEqual(packages.map((pkg) => pkg.name), ['entry', 'installer']);
});

test('cargo metadata collection rescans standalone packages discovered by the workspace', () => {
  const workspaceManifest = join(TEST_ROOT, 'Cargo.toml');
  const serviceManifest = join(TEST_ROOT, 'src', 'crates', 'services', 'services-core', 'Cargo.toml');
  const assembly = packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [
    pathDependency('src/crates/services/services-core'),
  ]);
  const service = packageAt('service', 'src/crates/services/services-core/Cargo.toml', [
    pathDependency('src/apps/example', { optional: true }),
  ]);
  const entry = packageAt('example', 'src/apps/example/Cargo.toml');
  const calls = [];

  const graph = collectCargoMetadataGraph({
    root: TEST_ROOT,
    manifestPaths: [workspaceManifest, serviceManifest],
    loadMetadata(manifestPath, options) {
      calls.push([manifestPath, options]);
      if (manifestPath === workspaceManifest) {
        return {
          packages: [assembly, service, entry],
          workspace_members: [assembly.id],
          resolve: {
            nodes: [{
              id: assembly.id,
              deps: [{
                name: 'service',
                pkg: service.id,
                dep_kinds: [{ kind: null, target: null }],
              }],
            }],
          },
        };
      }
      return {
        packages: [service, entry],
        workspace_members: [service.id],
        resolve: {
          nodes: [{
            id: service.id,
            deps: [{
              name: 'example',
              pkg: entry.id,
              dep_kinds: [{ kind: null, target: null }],
            }],
          }],
        },
      };
    },
  });

  const violations = findCargoLayerViolations(
    graph.packages,
    { root: TEST_ROOT, crateLayoutRules },
    graph.resolvedDependencies,
  );

  assert.deepEqual(calls, [
    [workspaceManifest, { noDeps: false }],
    [serviceManifest, { noDeps: true }],
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /service.*services.*->.*example.*apps.*normal optional dependency/);
});

test('cargo metadata collection preserves resolved repository edges', () => {
  const workspaceManifest = join(TEST_ROOT, 'Cargo.toml');
  const assembly = packageAt('assembly', 'src/crates/assembly/core/Cargo.toml', [{
    name: 'entry',
    rename: null,
    path: null,
    kind: 'dev',
    optional: true,
    target: 'cfg(windows)',
  }]);
  const entry = packageAt('entry', 'src/apps/example/Cargo.toml');

  const graph = collectCargoMetadataGraph({
    root: TEST_ROOT,
    manifestPaths: [workspaceManifest],
    loadMetadata() {
      return {
        packages: [assembly, entry],
        resolve: {
          nodes: [{
            id: assembly.id,
            deps: [{
              name: 'entry',
              pkg: entry.id,
              dep_kinds: [{ kind: 'dev', target: 'cfg(windows)' }],
            }],
          }],
        },
      };
    },
  });

  assert.deepEqual(graph.packages.map((pkg) => pkg.name), ['assembly', 'entry']);
  assert.equal(graph.resolvedDependencies.length, 1);
  assert.equal(graph.resolvedDependencies[0].sourceManifestPath, assembly.manifest_path);
  assert.equal(graph.resolvedDependencies[0].targetManifestPath, entry.manifest_path);
  assert.equal(graph.resolvedDependencies[0].kind, 'dev');
  assert.equal(graph.resolvedDependencies[0].optional, true);
  assert.equal(graph.resolvedDependencies[0].target, 'cfg(windows)');
});

test('core boundary check is split into focused modules', async () => {
  const entrypoint = await readFile(ENTRYPOINT, 'utf8');
  assert.ok(
    entrypoint.split(/\r?\n/).length <= 20,
    'entrypoint should stay a thin wrapper around core-boundaries modules',
  );
  assert.match(entrypoint, /core-boundaries\/checker\.mjs/);

  for (const modulePath of MODULES) {
    await access(new URL(modulePath, import.meta.url));
  }

  const checker = await readFile(new URL('./core-boundaries/checker.mjs', import.meta.url), 'utf8');
  assert.ok(
    checker.split(/\r?\n/).length <= 1200,
    'checker should stay focused on orchestration and shared check helpers',
  );
  assert.match(
    checker,
    /listTrackedRustRepoPaths/,
    'recursive source boundary checks must inspect tracked Rust files only',
  );

  const sourceRuleEntry = await readFile(
    new URL('./core-boundaries/rules/source-rules.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(
    sourceRuleEntry.split(/\r?\n/).length <= 40,
    'source rule entrypoint should delegate to focused source-rule modules',
  );
});

test('core checker runs the unified cargo dependency boundary check', async () => {
  const checker = await readFile(
    new URL('./core-boundaries/checker.mjs', import.meta.url),
    'utf8',
  );

  assert.match(checker, /checkCargoDependencyBoundariesSafely/);
  assert.doesNotMatch(checker, /checkCargoDependencyLayersSafely/);
});

test('product entrypoint feature policy does not pin product-full per manifest', async () => {
  const [checker, featureRules] = await Promise.all([
    readFile(new URL('./core-boundaries/checker.mjs', import.meta.url), 'utf8'),
    readFile(
      new URL('./core-boundaries/rules/feature-rules.mjs', import.meta.url),
      'utf8',
    ),
  ]);

  assert.doesNotMatch(checker, /checkProductCoreFeatureAssembly/);
  assert.doesNotMatch(featureRules, /productCoreFeatureAssemblyRules/);
});

test('Rust build dependency boundary policy stays discoverable', async () => {
  const policyUrl = new URL(
    '../docs/architecture/rust-build-dependency-boundaries.md',
    import.meta.url,
  );
  await assert.doesNotReject(
    () => access(policyUrl),
    'the Rust build dependency boundary policy must exist',
  );
  const [agents, productArchitecture, policy] = await Promise.all([
    readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/architecture/product-architecture.md', import.meta.url), 'utf8'),
    readFile(policyUrl, 'utf8'),
  ]);

  assert.match(agents, /docs\/architecture\/rust-build-dependency-boundaries\.md/);
  assert.match(productArchitecture, /rust-build-dependency-boundaries\.md/);
  assert.match(policy, /Cargo feature/);
  assert.match(policy, /Delivery Profile/);
  assert.match(policy, /Runtime Config/);
  assert.match(policy, /Capability Availability/);
  assert.match(policy, /pnpm run check:core-boundaries:test/);
});

test('transport contract stays limited to current delivery needs', async () => {
  const [workspaceManifest, transportTrait] = await Promise.all([
      readFile(new URL('../Cargo.toml', import.meta.url), 'utf8'),
      readFile(
        new URL('../src/crates/adapters/transport/src/traits.rs', import.meta.url),
        'utf8',
      ),
    ]);

  assert.doesNotMatch(workspaceManifest, /src\/crates\/adapters\/api-layer/);
  assert.doesNotMatch(
    transportTrait,
    /\b(?:emit_text_chunk|emit_tool_event|emit_stream_start|emit_stream_end|adapter_type|TextChunk|ToolEventPayload|ToolEventType|StreamEvent)\b/,
  );
  assert.doesNotMatch(
    transportTrait,
    /emit_event\s*\(\s*&self,\s*session_id:\s*&str/,
  );
});

test('public event projection stays limited to current host needs', async () => {
  const frontendProjection = await readFile(
    new URL(
      '../src/crates/contracts/events/src/frontend_projection.rs',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(
    frontendProjection,
    /\b(?:into_)?legacy_flat_message\b|\bpub event_type\b/,
  );
});

test('embedded relay concrete lifecycle stays desktop-owned', async () => {
  const [coreManifest, corePort, desktopManifest, desktopHost] = await Promise.all([
    readFile(new URL('../src/crates/assembly/core/Cargo.toml', import.meta.url), 'utf8'),
    readFile(
      new URL(
        '../src/crates/assembly/core/src/service/remote_connect/embedded_relay_host.rs',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../src/apps/desktop/Cargo.toml', import.meta.url), 'utf8'),
    readFile(
      new URL('../src/apps/desktop/src/embedded_relay_host.rs', import.meta.url),
      'utf8',
    ),
  ]);

  assert.doesNotMatch(coreManifest, /openbitfun-relay-service/);
  assert.doesNotMatch(corePort, /\b(?:axum|TcpListener|ServeDir|build_relay_router)\b/);
  assert.match(desktopManifest, /openbitfun-relay-service/);
  assert.match(desktopHost, /impl EmbeddedRelayHost for DesktopEmbeddedRelayHost/);
  assert.match(desktopHost, /TcpListener::bind/);
  assert.match(desktopHost, /ServeDir::new/);
});

test('desktop preview rebuild inputs use the current crate layout', async () => {
  const devScript = await readFile(new URL('./dev.cjs', import.meta.url), 'utf8');

  assert.match(
    devScript,
    /path\.join\(ROOT_DIR, 'src', 'crates'\)/,
  );
  assert.doesNotMatch(
    devScript,
    /'src', 'crates', '(?:core|transport|events|ai-adapters|webdriver|api-layer|assembly|adapters|contracts|execution|interfaces|services)'/,
  );
  assert.match(
    devScript,
    /service\$\{path\.sep\}announcement\$\{path\.sep\}content/,
  );
});

test('split core boundary check keeps self-test execution behavior', () => {
  const selfTest = spawnSync(
    process.execPath,
    ['scripts/check-core-boundaries.mjs'],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, OPENBITFUN_BOUNDARY_CHECK_SELF_TEST: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);
  assert.match(selfTest.stdout, /Core boundary check self-test passed\./);
});

test('Task execution boundary requires policy-aware child delegation', () => {
  const executionRule = requiredContentRules.find(
    (rule) => rule.path
      === 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs'
      && rule.patterns.some((pattern) => pattern.message.includes('background launches')),
  );
  assert.ok(executionRule, 'Task execution must have a required-content rule');

  const backgroundRule = executionRule.patterns.find(
    (pattern) => pattern.message.includes('background launches'),
  );
  const foregroundRule = executionRule.patterns.find(
    (pattern) => pattern.message.includes('foreground execution'),
  );
  assert.ok(backgroundRule, 'background child delegation must be protected');
  assert.ok(foregroundRule, 'foreground child delegation must be protected');
  assert.match(
    'let delegation_policy = child_delegation_policy(context, coordinator).await?;',
    backgroundRule.regex,
  );
  assert.match(
    'delegation_policy: child_delegation_policy(context, coordinator).await?',
    foregroundRule.regex,
  );
  assert.doesNotMatch(
    'delegation_policy: context.delegation_policy().spawn_child()',
    backgroundRule.regex,
  );
  assert.doesNotMatch(
    'delegation_policy: context.delegation_policy().spawn_child()',
    foregroundRule.regex,
  );
});

test('optional dependency ownership rejects undeclared direct feature owners', async () => {
  const {
    featureReferencesOptionalDependencyOwner,
    unexpectedDependencyOwnerFeatures,
  } = await import(
    './core-boundaries/manifest-feature-helpers.mjs'
  );
  const features = new Map([
    ['declared', { refs: ['dep:example'], line: 1 }],
    ['missing', { refs: ['example'], line: 2 }],
    ['feature-ref', { refs: ['example/subfeature'], line: 3 }],
    ['weak-ref', { refs: ['example?/subfeature'], line: 4 }],
    ['unrelated', { refs: ['other'], line: 5 }],
  ]);

  assert.deepEqual(
    unexpectedDependencyOwnerFeatures(features, {
      depName: 'example',
      ownerFeatures: ['declared'],
    }).map(([featureName]) => featureName),
    ['missing', 'feature-ref', 'weak-ref'],
  );
  assert.equal(featureReferencesOptionalDependencyOwner(features.get('declared'), 'example'), true);
  assert.equal(featureReferencesOptionalDependencyOwner(features.get('weak-ref'), 'example'), true);
  assert.equal(featureReferencesOptionalDependencyOwner(features.get('unrelated'), 'example'), false);
});

test('optional dependency ownership rejects hidden aliases but permits reviewed aggregates', async () => {
  const { unexpectedDependencyOwnerFeatures } = await import(
    './core-boundaries/manifest-feature-helpers.mjs'
  );
  const features = new Map([
    ['owner', { refs: ['dep:example'], line: 1 }],
    ['reviewed-aggregate', { refs: ['owner'], line: 2 }],
    ['sneaky', { refs: ['owner'], line: 3 }],
    ['bad-aggregate', { refs: ['owner', 'dep:example'], line: 4 }],
  ]);

  assert.deepEqual(
    unexpectedDependencyOwnerFeatures(
      features,
      { depName: 'example', ownerFeatures: ['owner'] },
      new Set(['reviewed-aggregate', 'bad-aggregate']),
    ).map(([featureName]) => featureName),
    ['sneaky', 'bad-aggregate'],
  );
});

test('services-core capability profiles keep heavy owners out of the empty profile', async () => {
  const { coreClosedFeatureProfileRules } = await import(
    './core-boundaries/rules/feature-rules.mjs'
  );
  const { dependencyProfileRules } = await import(
    './core-boundaries/rules/crate-rules.mjs'
  );
  const { requiredContentRules } = await import(
    './core-boundaries/rules/source/required-rules.mjs'
  );
  const serviceManifest = 'src/crates/services/services-core/Cargo.toml';
  const profiles = new Map(
    coreClosedFeatureProfileRules
      .filter((rule) => rule.manifestPath === serviceManifest)
      .map((rule) => [rule.featureName, rule.requiredFeatureRefs]),
  );

  assert.deepEqual(profiles.get('filesystem'), [
    'dep:base64',
    'dep:chrono',
    'dep:ignore',
    'dep:openbitfun-core-types',
    'dep:regex',
    'dep:sha2',
    'dep:tokio',
    'tokio/fs',
    'tokio/rt',
    'tokio/sync',
  ]);
  assert.deepEqual(profiles.get('product-identity'), ['dep:openbitfun-core-types']);
  assert.deepEqual(profiles.get('json-io'), [
    'dep:fs2',
    'dep:tokio',
    'dep:windows',
    'tokio/fs',
    'tokio/rt',
    'tokio/sync',
    'tokio/time',
    'windows/Win32_Foundation',
    'windows/Win32_Storage_FileSystem',
  ]);
  assert.deepEqual(profiles.get('local-storage'), [
    'dep:openbitfun-core-types',
    'dep:openbitfun-events',
    'dep:chrono',
    'dep:fs2',
    'dep:libc',
    'dep:regex',
    'dep:sha2',
    'dep:similar',
    'dep:tokio',
    'dep:windows',
    'tokio/fs',
    'tokio/rt',
    'tokio/sync',
    'tokio/time',
    'windows/Win32_Foundation',
    'windows/Win32_Storage_FileSystem',
  ]);
  assert.deepEqual(profiles.get('process-runtime'), [
    'dep:libc',
    'dep:tokio',
    'dep:which',
    'dep:win32job',
    'dep:windows',
    'tokio/io-util',
    'tokio/process',
    'tokio/rt',
    'tokio/time',
    'windows/Win32_Foundation',
    'windows/Win32_System_Diagnostics_ToolHelp',
    'windows/Win32_System_JobObjects',
    'windows/Win32_System_Threading',
  ]);
  assert.deepEqual(profiles.get('workspace-instructions'), [
    'dep:globset',
    'dep:regex',
    'dep:serde_yaml',
    'dep:tokio',
    'tokio/fs',
    'tokio/io-util',
    'tokio/rt',
  ]);
  assert.deepEqual(profiles.get('workspace-runtime'), [
    'dep:anyhow',
    'dep:async-trait',
    'dep:openbitfun-runtime-ports',
    'openbitfun-runtime-ports/runtime-event-port',
    'openbitfun-runtime-ports/workspace-ports',
    'dep:dunce',
    // The concrete local provider restores modification times through WorkspaceFS.
    'dep:filetime',
    'process-runtime',
    'tokio/fs',
    'tokio/io-util',
    'tokio/sync',
  ]);

  const defaultProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'services-core',
  );
  for (const dependency of [
    'base64',
    'openbitfun-core-types',
    'openbitfun-events',
    'chrono',
    'fs2',
    'globset',
    'ignore',
    'libc',
    'regex',
    'sha2',
    'similar',
    'which',
    'win32job',
    'windows',
  ]) {
    assert.ok(
      defaultProfile?.forbiddenNonOptionalDeps.includes(dependency),
      `services-core empty profile must reject ambient ${dependency}`,
    );
  }

  const sourceRule = requiredContentRules.find(
    (rule) => rule.path === 'src/crates/services/services-core/src/lib.rs',
  );
  const sourceContracts = sourceRule?.patterns.map((pattern) => pattern.regex.source).join('\n') ?? '';
  for (const moduleName of [
    'diagnostics',
    'diff',
    'filesystem',
    'json_store',
    'managed_runtime',
    'persistence',
    'process_manager',
    'process_tree',
    'session',
    'session_usage',
    'storage_cleanup',
    'system',
    'token_usage',
    'workspace_instructions',
  ]) {
    assert.match(
      sourceContracts,
      new RegExp(`pub mod ${moduleName}`),
      `services-core source rule must protect the ${moduleName} capability gate`,
    );
  }
});

test('services-core Tokio capabilities stay owner-scoped', () => {
  const invalidPackage = {
    name: 'openbitfun-services-core',
    manifest_path: 'src/crates/services/services-core/Cargo.toml',
    dependencies: [
      {
        name: 'tokio',
        kind: null,
        optional: false,
        features: ['fs', 'io-util', 'process', 'rt', 'sync', 'time'],
      },
    ],
    features: {
      filesystem: [],
      'json-io': [],
      'local-storage': [],
      'process-runtime': [],
      'workspace-instructions': [],
      'workspace-runtime': [],
    },
  };

  const messages = findTokioDependencyFeatureViolations([invalidPackage]).map(
    (violation) => violation.message,
  );
  assert.ok(
    messages.some((message) => message.includes('unexpected base Tokio capabilities')),
    'services-core must reject ambient fs/io/process/sync Tokio capabilities',
  );
  assert.ok(
    messages.some((message) => message.includes('filesystem missing effective Tokio capabilities: fs')),
    'services-core must require filesystem to own tokio/fs',
  );
});

test('Services Core accepts only the reviewed feature-owned Tokio runtime graph', () => {
  const validPackage = {
    name: 'openbitfun-services-core',
    manifest_path: 'src/crates/services/services-core/Cargo.toml',
    dependencies: [
      {
        name: 'tokio',
        kind: null,
        optional: true,
        features: [],
      },
    ],
    features: {
      'credential-vault': ['dep:tokio', 'tokio/fs', 'tokio/io-util', 'tokio/rt'],
      diff: ['dep:tokio', 'tokio/rt', 'tokio/time'],
      filesystem: ['dep:tokio', 'tokio/fs', 'tokio/rt', 'tokio/sync'],
      'json-io': ['dep:tokio', 'tokio/fs', 'tokio/rt', 'tokio/sync', 'tokio/time'],
      'local-storage': [
        'dep:tokio',
        'tokio/fs',
        'tokio/rt',
        'tokio/sync',
        'tokio/time',
      ],
      permission: ['dep:tokio', 'tokio/rt'],
      'session-search': ['dep:tokio', 'tokio/rt'],
      'process-runtime': [
        'dep:tokio',
        'tokio/io-util',
        'tokio/process',
        'tokio/rt',
        'tokio/time',
      ],
      'workspace-instructions': ['dep:tokio', 'tokio/fs', 'tokio/io-util', 'tokio/rt'],
      'workspace-text-runtime': ['dep:tokio', 'tokio/rt'],
      'workspace-runtime': [
        'process-runtime',
        'tokio/fs',
        'tokio/io-util',
        'tokio/sync',
      ],
      'session-git': ['local-storage'],
      'workspace-transfer': ['dep:tokio', 'tokio/fs', 'tokio/io-util', 'tokio/rt', 'tokio/sync'],
    },
  };

  assert.deepEqual(findTokioDependencyFeatureViolations([validPackage]), []);
});

test('Services Core Tokio owners cannot be hidden behind an unreviewed alias', () => {
  const invalidPackage = {
    name: 'openbitfun-services-core',
    manifest_path: 'src/crates/services/services-core/Cargo.toml',
    dependencies: [
      {
        name: 'tokio',
        kind: null,
        optional: true,
        features: [],
      },
    ],
    features: {
      diff: ['dep:tokio', 'tokio/rt', 'tokio/time'],
      filesystem: ['dep:tokio', 'tokio/fs', 'tokio/rt', 'tokio/sync'],
      'json-io': ['dep:tokio', 'tokio/fs', 'tokio/rt', 'tokio/sync', 'tokio/time'],
      'local-storage': [
        'dep:tokio',
        'tokio/fs',
        'tokio/rt',
        'tokio/sync',
        'tokio/time',
      ],
      permission: ['dep:tokio', 'tokio/rt'],
      'process-runtime': [
        'dep:tokio',
        'tokio/io-util',
        'tokio/process',
        'tokio/rt',
        'tokio/time',
      ],
      'workspace-instructions': ['dep:tokio', 'tokio/fs', 'tokio/io-util', 'tokio/rt'],
      'workspace-text-runtime': ['dep:tokio', 'tokio/rt'],
      'workspace-runtime': [
        'process-runtime',
        'tokio/fs',
        'tokio/io-util',
        'tokio/sync',
      ],
      sneaky: ['filesystem', 'local-storage'],
      'sneaky-weak': ['tokio?/full'],
    },
  };

  const messages = findTokioDependencyFeatureViolations([invalidPackage]).map(
    (violation) => violation.message,
  );
  assert.ok(
    messages.includes('openbitfun-services-core:sneaky Tokio capabilities require an explicit owner contract'),
  );
  assert.ok(
    messages.includes('openbitfun-services-core:sneaky-weak Tokio capabilities require an explicit owner contract'),
  );
});

test('Core feature-free Tokio capabilities stay limited to baseline path and state IO', () => {
  const invalidPackage = {
    name: 'openbitfun-core',
    manifest_path: 'src/crates/assembly/core/Cargo.toml',
    dependencies: [
      {
        name: 'tokio',
        kind: null,
        optional: false,
        features: ['fs', 'io-util', 'macros', 'net', 'rt', 'sync', 'time'],
      },
    ],
    features: {},
  };

  const messages = findTokioDependencyFeatureViolations([invalidPackage]).map(
    (violation) => violation.message,
  );
  assert.ok(
    messages.some((message) => message.includes('unexpected base Tokio capabilities')),
    'Core must reject async runtime, networking, and timing capabilities in its feature-free profile',
  );
});

test('Core Tokio capabilities cannot hide behind an unreviewed owner feature', () => {
  const invalidPackage = {
    name: 'openbitfun-core',
    manifest_path: 'src/crates/assembly/core/Cargo.toml',
    dependencies: [
      {
        name: 'tokio',
        kind: null,
        optional: false,
        features: ['fs', 'sync'],
      },
    ],
    features: {
      'agent-runtime': ['tokio/io-util', 'tokio/macros', 'tokio/rt', 'tokio/time'],
      'legacy-migration': [],
      'mcp-runtime': ['agent-runtime', 'tokio/rt-multi-thread'],
      'browser-control': ['tokio/net', 'tokio/rt', 'tokio/time'],
      sneaky: ['agent-runtime', 'browser-control'],
    },
  };

  const messages = findTokioDependencyFeatureViolations([invalidPackage]).map(
    (violation) => violation.message,
  );
  assert.deepEqual(messages, [
    'openbitfun-core:sneaky Tokio capabilities require an explicit owner contract',
  ]);
});

test('reviewed Tokio aggregates cannot declare runtime capabilities directly', () => {
  const invalidPackage = {
    name: 'openbitfun-core',
    manifest_path: 'src/crates/assembly/core/Cargo.toml',
    dependencies: [{ name: 'tokio', kind: null, optional: false, features: ['fs', 'sync'] }],
    features: {
      'agent-runtime': ['tokio/io-util', 'tokio/macros', 'tokio/rt', 'tokio/time'],
      'legacy-migration': [],
      'mcp-runtime': ['agent-runtime', 'tokio/rt-multi-thread'],
      'browser-control': ['tokio/net', 'tokio/rt', 'tokio/time'],
      'product-full': ['agent-runtime', 'tokio/net'],
    },
  };

  const messages = findTokioDependencyFeatureViolations([invalidPackage]).map(
    (violation) => violation.message,
  );
  assert.deepEqual(messages, [
    'openbitfun-core:product-full Tokio aggregate must compose reviewed owners instead of declaring Tokio capabilities directly',
  ]);
});

test('services-core Windows API capabilities stay feature-owned', async () => {
  const { findServicesCorePlatformDependencyFeatureViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  assert.equal(
    typeof findServicesCorePlatformDependencyFeatureViolations,
    'function',
    'Cargo boundary checker must expose the services-core platform dependency policy',
  );
  const packageWithAmbientWindowsApis = {
    name: 'openbitfun-services-core',
    manifest_path: 'src/crates/services/services-core/Cargo.toml',
    dependencies: [
      {
        name: 'windows',
        kind: null,
        optional: true,
        target: 'cfg(windows)',
        features: ['Win32_Storage_FileSystem', 'Win32_System_Threading'],
      },
    ],
  };

  const violations = findServicesCorePlatformDependencyFeatureViolations([
    packageWithAmbientWindowsApis,
  ]);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0].message,
    /windows API capabilities must be selected by services-core owner features/,
  );

  assert.deepEqual(
    findServicesCorePlatformDependencyFeatureViolations([
      {
        ...packageWithAmbientWindowsApis,
        dependencies: [{ ...packageWithAmbientWindowsApis.dependencies[0], features: [] }],
      },
    ]),
    [],
  );
});

test('services-integrations Windows dependency keeps only APIs used by its owners', () => {
  const pkg = packageAt(
    'openbitfun-services-integrations',
    'src/crates/services/services-integrations/Cargo.toml',
    [{
      name: 'windows',
      kind: null,
      optional: true,
      target: 'cfg(windows)',
      features: [
        'Win32_Foundation',
        'Win32_Storage_FileSystem',
        'Win32_System_Diagnostics_ToolHelp',
      ],
    }],
  );

  const violations = findServicesIntegrationsPlatformDependencyFeatureViolations([pkg]);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /unexpected Windows API capabilities: Win32_System_Diagnostics_ToolHelp/);

  pkg.dependencies[0].features = ['Win32_Foundation', 'Win32_Storage_FileSystem'];
  assert.deepEqual(findServicesIntegrationsPlatformDependencyFeatureViolations([pkg]), []);

  pkg.dependencies[0].target = 'cfg(all(windows, target_arch = "x86_64"))';
  const targetViolations = findServicesIntegrationsPlatformDependencyFeatureViolations([pkg]);
  assert.equal(targetViolations.length, 1);
  assert.match(targetViolations[0].message, /must declare exactly one reviewed Windows dependency/);

  pkg.dependencies[0].target = 'cfg(windows)';
  pkg.dependencies.push({
    name: 'windows',
    kind: null,
    optional: false,
    target: null,
    features: ['Win32_System_Threading'],
  });
  const duplicateViolations = findServicesIntegrationsPlatformDependencyFeatureViolations([pkg]);
  assert.equal(duplicateViolations.length, 1);
  assert.match(duplicateViolations[0].message, /must declare exactly one reviewed Windows dependency/);

  pkg.dependencies = [];
  const missingViolations = findServicesIntegrationsPlatformDependencyFeatureViolations([pkg]);
  assert.equal(missingViolations.length, 1);
  assert.match(missingViolations[0].message, /must declare exactly one reviewed Windows dependency/);
});

test('closed feature profiles reject product-full hidden behind a child feature', async () => {
  const { unexpectedReachableLocalFeatures } = await import(
    './core-boundaries/manifest-feature-helpers.mjs'
  );
  const features = new Map([
    ['service-integrations', { refs: ['announcement'], line: 1 }],
    [
      'announcement',
      {
        refs: ['openbitfun-services-integrations/announcement', 'product-full'],
        line: 2,
      },
    ],
    ['product-full', { refs: ['dep:rmcp'], line: 3 }],
  ]);

  assert.deepEqual(
    unexpectedReachableLocalFeatures(
      features,
      'service-integrations',
      new Set(['announcement']),
    ),
    [
      {
        featureName: 'product-full',
        path: ['service-integrations', 'announcement', 'product-full'],
      },
    ],
  );
});

test('capability contract consumers may inherit empty defaults but must select reviewed features', async () => {
  const cargoBoundaries = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  assert.equal(
    typeof cargoBoundaries.findCapabilityContractConsumerViolations,
    'function',
    'Cargo boundary checker must expose the capability contract consumer policy',
  );

  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  const agentTools = agentToolsCapabilityPackage();
  const pluginRuntimeClient = packageAt(
    'openbitfun-plugin-runtime-client',
    'src/crates/execution/plugin-runtime-client/Cargo.toml',
    [
      pathDependency('src/crates/contracts/runtime-ports', {
        name: 'openbitfun-runtime-ports',
      }),
    ],
  );

  const messages = findTestCapabilityViolations(
    cargoBoundaries.findCapabilityContractConsumerViolations,
    [
    runtimePorts,
    agentTools,
    pluginRuntimeClient,
    ],
  ).map((violation) => violation.message);

  assert.doesNotMatch(messages.join('\n'), /default-features = false/);
  assert.ok(messages.some((message) => /plugin-runtime/.test(message)));

  // Shared file/search algorithms consume workspace IO, not the entire runtime API.
  const toolRuntime = packageAt(
    'tool-runtime',
    'src/crates/execution/tool-execution/Cargo.toml',
    [
      pathDependency('src/crates/contracts/runtime-ports', {
        name: 'openbitfun-runtime-ports',
        features: ['workspace-ports'],
      }),
      pathDependency('src/crates/execution/tool-contracts', {
        name: 'openbitfun-agent-tools',
      }),
    ],
  );
  const ioContractRules = capabilityContractDependencyRules.filter(
    ({ packageName }) => ['openbitfun-runtime-ports', 'openbitfun-agent-tools'].includes(packageName),
  );
  assert.deepEqual(findTestCapabilityViolations(
    cargoBoundaries.findCapabilityContractConsumerViolations,
    [runtimePorts, agentTools, toolRuntime],
    ioContractRules,
  ), []);
  for (const features of [[], ['workspace-ports', 'agent-api']]) {
    const mutatedConsumer = {
      ...toolRuntime,
      dependencies: [
        { ...toolRuntime.dependencies[0], features },
        toolRuntime.dependencies[1],
      ],
    };
    const violations = findTestCapabilityViolations(
      cargoBoundaries.findCapabilityContractConsumerViolations,
      [runtimePorts, agentTools, mutatedConsumer],
      ioContractRules,
    );
    assert.ok(violations.some(({ message }) => /tool-runtime.*openbitfun-runtime-ports/.test(message)),
      `tool-runtime must retain exactly workspace-ports, not ${features.join(', ') || 'an empty edge'}`);
  }
});

test('unreviewed consumers cannot add capability contract dependency edges', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  const agentTools = agentToolsCapabilityPackage();
  const unreviewed = packageAt(
    'unreviewed-host',
    'src/apps/unreviewed-host/Cargo.toml',
    [
      pathDependency('src/crates/contracts/runtime-ports', {
        name: 'openbitfun-runtime-ports',
        target: 'cfg(windows)',
        usesDefaultFeatures: false,
        features: ['agent-api'],
      }),
    ],
  );

  const messages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [runtimePorts, agentTools, unreviewed],
    capabilityContractDependencyRules.slice(0, 2),
  ).map(
    (violation) => violation.message,
  );
  assert.equal(messages.length, 1, messages.join('\n'));
  assert.match(messages[0], /unreviewed consumer/);
});

test('capability contract edge policy rejects alias, weak, optional, and non-normal widening', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  const validDependency = pathDependency('src/crates/contracts/runtime-ports', {
    name: 'openbitfun-runtime-ports',
    usesDefaultFeatures: false,
    features: ['plugin-runtime'],
  });
  const mutations = [
    { label: 'renamed alias forwarding', dependency: { ...validDependency, rename: 'ports' }, features: { sneaky: ['ports/agent-api'] }, expected: /sneaky.*unreviewed.*forwarding/ },
    { label: 'weak alias forwarding', dependency: { ...validDependency, rename: 'ports' }, features: { sneaky: ['ports?/agent-api'] }, expected: /sneaky.*unreviewed.*forwarding/ },
    { label: 'optional edge', dependency: { ...validDependency, optional: true }, features: {}, expected: /unreviewed.*dependency edge/ },
    { label: 'dev edge', dependency: { ...validDependency, kind: 'dev' }, features: {}, expected: /unreviewed.*dependency edge/ },
    { label: 'build edge', dependency: { ...validDependency, kind: 'build' }, features: {}, expected: /unreviewed.*dependency edge/ },
    { label: 'target edge', dependency: { ...validDependency, target: 'cfg(windows)' }, features: {}, expected: /unreviewed.*dependency edge/ },
  ];

  for (const mutation of mutations) {
    const consumer = {
      ...packageAt(
        'openbitfun-plugin-runtime-client',
        'src/crates/execution/plugin-runtime-client/Cargo.toml',
        [mutation.dependency],
      ),
      features: mutation.features,
    };
    const messages = findTestCapabilityViolations(
      findCapabilityContractConsumerViolations,
      [runtimePorts, consumer],
    ).map(
      (violation) => violation.message,
    );
    assert.ok(
      messages.some((message) => mutation.expected.test(message)),
      `${mutation.label} must not widen the reviewed capability contract`,
    );
  }
});

test('capability contract targets require an explicit empty default feature', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  delete runtimePorts.features.default;

  const messages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [runtimePorts],
  ).map(
    (violation) => violation.message,
  );
  assert.ok(messages.some((message) => /default feature must stay empty/.test(message)));
});

test('capability contract optional activators reject unreviewed dep aliases', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const agentTools = agentToolsCapabilityPackage();
  const dependency = pathDependency('src/crates/execution/tool-contracts', {
    name: 'openbitfun-agent-tools',
    rename: 'tools_contract',
    optional: true,
    usesDefaultFeatures: false,
  });
  const consumer = {
    ...packageAt(
      'openbitfun-acp',
      'src/crates/interfaces/acp/Cargo.toml',
      [dependency],
    ),
    features: {
      client: ['tools_contract/acp-bridge'],
      server: ['dep:tools_contract'],
      sneaky: ['tools_contract'],
    },
  };

  const messages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [agentTools, consumer],
  ).map(
    (violation) => violation.message,
  );
  assert.ok(messages.some((message) => /sneaky.*unreviewed.*activation/.test(message)));
  assert.doesNotMatch(messages.join('\n'), /server.*unreviewed.*activation/);
});

test('capability contract consumers cannot remove reviewed forwarding or activation', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  const integrations = {
    ...packageAt(
      'openbitfun-services-integrations',
      'src/crates/services/services-integrations/Cargo.toml',
      [pathDependency('src/crates/contracts/runtime-ports', {
        name: 'openbitfun-runtime-ports',
        optional: true,
        usesDefaultFeatures: false,
      })],
    ),
    features: {
      git: [],
      'remote-connect': [
        'openbitfun-runtime-ports/agent-api',
        'openbitfun-runtime-ports/remote-workspace-ports',
      ],
      'remote-ssh': [
        'openbitfun-runtime-ports/remote-exec-port',
        'openbitfun-runtime-ports/remote-workspace-ports',
        'openbitfun-runtime-ports/workspace-ports',
      ],
      'remote-ssh-concrete': ['dep:openbitfun-runtime-ports'],
      'script-tool-runtime': ['openbitfun-runtime-ports/script-tool-runtime'],
    },
  };
  const servicesCore = {
    ...packageAt(
      'openbitfun-services-core',
      'src/crates/services/services-core/Cargo.toml',
      [pathDependency('src/crates/contracts/runtime-ports', {
        name: 'openbitfun-runtime-ports',
        optional: true,
        usesDefaultFeatures: false,
      })],
    ),
    features: {
      permission: [],
      'workspace-runtime': [
        'dep:openbitfun-runtime-ports',
        'openbitfun-runtime-ports/runtime-event-port',
        'openbitfun-runtime-ports/workspace-ports',
      ],
    },
  };

  const messages = findTestCapabilityViolations(findCapabilityContractConsumerViolations, [
    runtimePorts,
    integrations,
    servicesCore,
  ]).map((violation) => violation.message);

  assert.ok(messages.some((message) => /openbitfun-services-integrations:git.*missing reviewed.*git-port forwarding/.test(message)));
  assert.ok(messages.some((message) => /openbitfun-services-core:permission.*missing reviewed.*activation/.test(message)));
});

test('capability contract targets cannot be removed or replaced by a same-name package', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const reviewedConsumer = packageAt(
    'openbitfun-plugin-runtime-client',
    'src/crates/execution/plugin-runtime-client/Cargo.toml',
    [pathDependency('src/crates/contracts/runtime-ports', {
      name: 'openbitfun-runtime-ports',
      usesDefaultFeatures: false,
      features: ['plugin-runtime'],
    })],
  );

  const missingTargetMessages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [reviewedConsumer],
  ).map((violation) => violation.message);
  assert.ok(missingTargetMessages.some((message) =>
    /openbitfun-runtime-ports managed target.*missing/.test(message)));

  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  reviewedConsumer.dependencies[0] = {
    ...reviewedConsumer.dependencies[0],
    path: null,
    source: 'registry+https://github.com/rust-lang/crates.io-index',
  };
  const spoofedTargetMessages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [runtimePorts, reviewedConsumer],
  ).map((violation) => violation.message);
  assert.ok(spoofedTargetMessages.some((message) => /managed internal path/.test(message)));

  const vendorRuntimePorts = {
    ...runtimePorts,
    manifest_path: join(
      TEST_ROOT,
      'vendor',
      'src',
      'crates',
      'contracts',
      'runtime-ports',
      'Cargo.toml',
    ),
  };
  reviewedConsumer.dependencies[0] = {
    ...reviewedConsumer.dependencies[0],
    path: join(TEST_ROOT, 'vendor', 'src', 'crates', 'contracts', 'runtime-ports'),
    source: null,
  };
  const vendorTargetMessages = findCapabilityContractConsumerViolations(
    [vendorRuntimePorts, reviewedConsumer],
    [capabilityContractDependencyRules[0]],
    { root: TEST_ROOT },
  ).map((violation) => violation.message);
  assert.ok(vendorTargetMessages.some((message) => /managed target.*missing/.test(message)));
});

test('capability contract target feature graphs stay exact', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  runtimePorts.features['git-port'] = ['plugin-runtime'];

  const messages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [runtimePorts],
  ).map(
    (violation) => violation.message,
  );
  assert.ok(messages.some((message) => /git-port.*feature graph must stay exact/.test(message)));
});

test('unreviewed local feature aliases cannot wrap reviewed capability owners', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const agentTools = agentToolsCapabilityPackage();
  const acp = {
    ...packageAt(
      'openbitfun-acp',
      'src/crates/interfaces/acp/Cargo.toml',
      [pathDependency('src/crates/execution/tool-contracts', {
        name: 'openbitfun-agent-tools',
        optional: true,
        usesDefaultFeatures: false,
      })],
    ),
    features: {
      default: ['client', 'server'],
      client: ['openbitfun-agent-tools/acp-bridge'],
      server: ['dep:openbitfun-agent-tools'],
      sneakyClient: ['client'],
      sneakyServer: ['server'],
    },
  };

  const messages = findTestCapabilityViolations(
    findCapabilityContractConsumerViolations,
    [agentTools, acp],
  ).map(
    (violation) => violation.message,
  );
  assert.ok(messages.some((message) => /sneakyClient.*unreviewed.*aggregate/.test(message)));
  assert.ok(messages.some((message) => /sneakyServer.*unreviewed.*aggregate/.test(message)));
  assert.doesNotMatch(messages.join('\n'), /default.*unreviewed.*aggregate/);
});

test('capability contract consumers cannot remove reviewed dependency edges', async () => {
  const { findCapabilityContractConsumerViolations } = await import(
    './core-boundaries/cargo-dependency-boundaries.mjs'
  );
  const runtimePorts = capabilityPackage(
    'openbitfun-runtime-ports',
    'src/crates/contracts/runtime-ports/Cargo.toml',
    RUNTIME_PORT_FEATURE_PROFILES,
  );
  const pluginRuntimeClient = packageAt(
    'openbitfun-plugin-runtime-client',
    'src/crates/execution/plugin-runtime-client/Cargo.toml',
  );
  const opencodeAdapter = packageAt(
    'openbitfun-opencode-adapter',
    'src/crates/adapters/opencode-adapter/Cargo.toml',
    [pathDependency('src/crates/contracts/runtime-ports', {
      name: 'openbitfun-runtime-ports',
      usesDefaultFeatures: false,
      features: ['plugin-runtime'],
    })],
  );

  const messages = findTestCapabilityViolations(findCapabilityContractConsumerViolations, [
    runtimePorts,
    pluginRuntimeClient,
    opencodeAdapter,
  ]).map((violation) => violation.message);
  assert.ok(messages.some((message) => /openbitfun-plugin-runtime-client.*missing reviewed.*normal.*edge/.test(message)));
  assert.ok(messages.some((message) => /openbitfun-opencode-adapter.*missing reviewed.*dev.*edge/.test(message)));
});

test('vendored Engine.IO remains in resolved feature audits without becoming a product owner', () => {
  const owner = packageAt('owner', 'src/apps/example/Cargo.toml');
  const vendor = { ...packageAt('eioc', 'third_party/eioc/Cargo.toml'), version: '0.5.0' };
  const collect = members => collectCargoMetadataGraph({
    root: TEST_ROOT,
    manifestPaths: [join(TEST_ROOT, 'Cargo.toml')],
    loadMetadata: () => ({
      packages: [owner, vendor], workspace_members: members,
      resolve: { nodes: [{ id: vendor.id, features: ['rustls-tls'], deps: [] }] },
    }),
  });
  const graph = collect([owner.id]);
  assert.deepEqual(graph.packages.map(pkg => pkg.name), ['owner']);
  assert.ok(graph.resolvedPackageFeatures.some(record => record.name === 'eioc'));
  assert.ok(collect([owner.id, vendor.id]).packages.some(pkg => pkg.name === 'eioc'),
    'a product workspace member cannot bypass ownership checks through a vendor path');
});


test('workspace transfer admits IO without process or networking capabilities', () => {
  const pkg = {
    name: 'openbitfun-services-core',
    manifest_path: 'src/crates/services/services-core/Cargo.toml',
    dependencies: [{ name: 'tokio', kind: null, optional: true, features: [] }],
    features: {
      'workspace-transfer': ['dep:tokio', 'tokio/fs', 'tokio/io-util', 'tokio/rt', 'tokio/sync'],
    },
  };
  assert.deepEqual(findTokioDependencyFeatureViolations([pkg]).filter(v => v.message.includes(':workspace-transfer ')), []);
  pkg.features['workspace-transfer'].push('tokio/process', 'tokio/net');
  assert.ok(findTokioDependencyFeatureViolations([pkg]).some(v =>
    v.message.includes('workspace-transfer has unexpected effective Tokio capabilities')));
});


test('core loopback WebSocket fixture cannot broaden the runtime dependency', () => {
  const runtime = { name: 'tokio-tungstenite', kind: null, optional: true, uses_default_features: true, features: [] };
  const development = { ...runtime, kind: 'dev', optional: false };
  const pkg = packageAt('openbitfun-core', 'src/crates/assembly/core/Cargo.toml', [runtime, development]);
  assert.deepEqual(findThirdPartyCapabilityFeatureViolations([pkg]), []);
  for (const dependencies of [
    [{ ...runtime, optional: false }, development],
    [runtime, { ...development, features: ['rustls-tls-native-roots'] }],
    [runtime, development, { ...development }],
  ]) {
    assert.ok(findThirdPartyCapabilityFeatureViolations([{ ...pkg, dependencies }]).length > 0);
  }
});
