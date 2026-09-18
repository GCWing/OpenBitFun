import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  acpClientCoreFeatures,
  acpServerCoreFeatures,
  capabilityContractDependencyRules,
  guardedEmptyInternalDefaultManifestPaths,
  servicesReqwestOwnerFeatures,
} from './rules/feature-rules.mjs';

const SKIPPED_DIRECTORIES = new Set([
  '.openbitfun',
  '.claude',
  '.cursor',
  '.git',
  '.targets',
  '.tmp',
  '.worktrees',
  // Local-only worktree roots (git-ignored); their manifests are historical
  // snapshots and must not participate in boundary checks.
  'BitFun-worktrees',
  'node_modules',
  'target',
]);

const ALLOWED_TARGET_LAYERS = new Map([
  ['apps', new Set(['interfaces', 'assembly', 'adapters', 'services', 'execution', 'contracts'])],
  ['interfaces', new Set(['interfaces', 'assembly', 'adapters', 'services', 'execution', 'contracts'])],
  ['assembly', new Set(['assembly', 'adapters', 'services', 'execution', 'contracts'])],
  ['adapters', new Set(['adapters', 'services', 'execution', 'contracts'])],
  ['services', new Set(['services', 'execution', 'contracts'])],
  ['execution', new Set(['execution', 'contracts'])],
  ['contracts', new Set(['contracts'])],
]);

function normalizedPath(path) {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function repositoryPath(root, path) {
  const result = relative(resolve(root), resolve(path)).replace(/\\/g, '/');
  if (result === '' || result === '.') {
    return '';
  }
  if (result === '..' || result.startsWith('../') || isAbsolute(result)) {
    return null;
  }
  return result;
}

// This crates.io source is patched only to select the product TLS provider.
// It is an external dependency, not an OpenBitFun runtime owner. Resolved
// feature checks below still include it and its full dependency closure.
function isVendoredExternalManifest(root, manifestPath) {
  return repositoryPath(root, manifestPath) === 'third_party/eioc/Cargo.toml';
}

function layerForManifest(manifestPath, { root, crateLayoutRules }) {
  const repoManifestPath = repositoryPath(root, manifestPath);
  if (repoManifestPath === null) {
    return null;
  }
  const cratePath = repoManifestPath.replace(/\/Cargo\.toml$/, '');

  if (cratePath.startsWith('src/apps/') || cratePath === 'OpenBitFun-Installer/src-tauri') {
    return 'apps';
  }

  return crateLayoutRules.find((rule) => rule.path === cratePath)?.layer ?? null;
}

function dependencyDescription(dependency) {
  const kind = dependency.kind ?? 'normal';
  const optional = dependency.optional ? ' optional' : '';
  const target = dependency.target ? ` for ${dependency.target}` : '';
  return `${kind}${optional} dependency${target}`;
}

function expandedLocalFeatures(featureGraph, selectedFeatures, useDefaultFeatures) {
  const pending = [...selectedFeatures];
  if (useDefaultFeatures && Object.hasOwn(featureGraph, 'default')) {
    pending.push('default');
  }
  const active = new Set();
  const references = new Set();

  while (pending.length > 0) {
    const feature = pending.pop();
    if (active.has(feature)) {
      continue;
    }
    active.add(feature);
    for (const reference of featureGraph[feature] ?? []) {
      references.add(reference);
      if (Object.hasOwn(featureGraph, reference)) {
        pending.push(reference);
      }
    }
  }

  return { active, references };
}

function dependencyAlias(dependency) {
  return dependency.rename ?? dependency.name;
}

function dependencyActivation(dependency, sourceFeatureState) {
  const alias = dependencyAlias(dependency);
  const forwarded = [];
  let explicitlyActivated = false;
  for (const reference of sourceFeatureState.references) {
    if (reference === `dep:${alias}`) {
      explicitlyActivated = true;
      continue;
    }
    const match = reference.match(/^([^/?]+)(\?)?\/(.+)$/);
    if (match?.[1] !== alias) {
      continue;
    }
    if (!match[2]) {
      explicitlyActivated = true;
    }
    forwarded.push(match[3]);
  }

  if (dependency.optional && !explicitlyActivated) {
    return null;
  }
  return {
    features: [...new Set([...(dependency.features ?? []), ...forwarded])],
    useDefaultFeatures: dependency.uses_default_features !== false,
  };
}

function isProcMacroPackage(pkg) {
  return (pkg.targets ?? []).some((target) =>
    (target.kind ?? []).includes('proc-macro'));
}

const SERVICES_INTEGRATIONS_TOKIO_FEATURES = new Map([
  ['account-identity', ['rt', 'sync']],
  ['announcement', ['fs', 'sync']],
  ['models-dev', ['fs', 'sync', 'time']],
  ['browser-control', ['time']],
  ['canvas-runtime', ['fs']],
  ['deep-research', []],
  ['git', ['fs', 'io-util', 'macros', 'rt', 'time']],
  ['file-watch', ['rt', 'sync']],
  ['function-agents', ['fs', 'io-util', 'macros', 'rt', 'time']],
  ['mcp', ['fs', 'io-util', 'net', 'process', 'rt', 'sync', 'time']],
  ['miniapp-loopx', ['fs', 'io-util', 'macros', 'process', 'rt', 'sync', 'time']],
  ['miniapp-storage', ['fs', 'time']],
  ['miniapp-runtime', ['fs', 'io-util', 'net', 'process', 'rt', 'sync', 'time']],
  ['miniapp-market', ['fs', 'io-util', 'net', 'process', 'rt', 'sync', 'time']],
  ['plugin-source', ['fs', 'rt', 'sync', 'time']],
  ['hook-import', ['fs', 'sync']],
  ['remote-connect', ['fs', 'io-util', 'net', 'process', 'rt', 'sync', 'time']],
  ['remote-ssh', ['fs', 'io-util', 'macros', 'net', 'process', 'rt', 'sync', 'time']],
  ['remote-ssh-concrete', ['fs', 'io-util', 'macros', 'net', 'process', 'rt', 'sync', 'time']],
  ['review-platform', ['fs', 'io-util', 'sync']],
  ['speech', ['fs', 'io-util', 'macros', 'rt', 'sync']],
  ['speech-realtime', ['fs', 'io-util', 'macros', 'net', 'rt', 'sync', 'time']],
  ['workspace-search', ['io-util', 'rt', 'sync', 'time']],
  ['script-tool-runtime', ['io-util', 'process', 'rt', 'sync', 'time']],
]);

const SERVICES_CORE_TOKIO_FEATURES = new Map([
  ['credential-vault', ['fs', 'io-util', 'rt']],
  ['diff', ['rt', 'time']],
  ['filesystem', ['fs', 'rt', 'sync']],
  ['json-io', ['fs', 'rt', 'sync', 'time']],
  ['local-storage', ['fs', 'rt', 'sync', 'time']],
  ['permission', ['rt']],
  ['process-runtime', ['io-util', 'process', 'rt', 'time']],
  ['session-search', ['rt']],
  ['workspace-instructions', ['fs', 'io-util', 'rt']],
  ['workspace-text-runtime', ['rt']],
  ['workspace-runtime', ['fs', 'io-util', 'process', 'rt', 'sync', 'time']],
  ['workspace-transfer', ['fs', 'io-util', 'rt', 'sync']],
]);
const SERVICES_CORE_BASE_TOKIO_FEATURES = [];
const SERVICES_INTEGRATIONS_TOKIO_AGGREGATES = new Set(['product-full']);
const SERVICES_CORE_TOKIO_AGGREGATES = new Set(['session-git', 'token-usage-statistics']);
const CORE_TOKIO_FEATURES = new Map([
  ['agent-runtime', ['io-util', 'macros', 'rt', 'time']],
  ['legacy-migration', []],
  ['mcp-runtime', ['io-util', 'macros', 'rt', 'rt-multi-thread', 'time']],
  ['browser-control', ['net', 'rt', 'time']],
]);
const CORE_TOKIO_AGGREGATES = new Set([
  'external-sources',
  'plugin-runtime',
  'product-search',
  'opencode-plugin-host',
  'product-full',
  'remote-connect',
  'tools-browser-web',
  'tools-mcp',
]);
const AGENT_RUNTIME_TOKIO_FEATURES = new Map([
  ['native-hook-runtime', ['io-util', 'macros', 'process', 'rt', 'time']],
  ['agent-runtime', ['io-util', 'macros', 'process', 'rt', 'sync', 'time']],
]);

const TOKIO_DEPENDENCY_POLICY_EXCLUDED_PACKAGES = new Set();

function tokioCapabilityReference(value) {
  return value.match(/^tokio\??\/(.+)$/)?.[1];
}

function effectiveTokioCapabilities(feature, featureGraph, visiting = new Set()) {
  if (visiting.has(feature)) {
    return new Set();
  }
  visiting.add(feature);

  const capabilities = new Set();
  for (const value of featureGraph[feature] ?? []) {
    const capability = tokioCapabilityReference(value);
    if (capability) {
      capabilities.add(capability);
    } else if (Object.hasOwn(featureGraph, value)) {
      for (const capability of effectiveTokioCapabilities(value, featureGraph, visiting)) {
        capabilities.add(capability);
      }
    }
  }

  visiting.delete(feature);
  return capabilities;
}

function findOwnedTokioFeatureViolations(pkg, ownerProfiles, aggregateFeatures = new Set()) {
  const violations = [];
  const featureGraph = pkg.features ?? {};

  for (const [feature, expectedCapabilities] of ownerProfiles) {
    if (!Object.hasOwn(featureGraph, feature)) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} governed Tokio feature is missing`,
      });
      continue;
    }

    const actualCapabilities = [...effectiveTokioCapabilities(feature, featureGraph)].sort();
    const expected = [...expectedCapabilities].sort();
    const missing = expected.filter((capability) => !actualCapabilities.includes(capability));
    const unexpected = actualCapabilities.filter((capability) => !expected.includes(capability));
    if (missing.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} missing effective Tokio capabilities: ${missing.join(', ')}`,
      });
    }
    if (unexpected.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} has unexpected effective Tokio capabilities: ${unexpected.join(', ')}`,
      });
    }
  }

  for (const [feature, values] of Object.entries(featureGraph)) {
    if (ownerProfiles.has(feature)) {
      continue;
    }
    if (aggregateFeatures.has(feature)) {
      if (values.some((value) => tokioCapabilityReference(value))) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name}:${feature} Tokio aggregate must compose reviewed owners instead of declaring Tokio capabilities directly`,
        });
      }
      continue;
    }
    if (effectiveTokioCapabilities(feature, featureGraph).size > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} Tokio capabilities require an explicit owner contract`,
      });
    }
  }

  return violations;
}

export function findServicesIntegrationsTokioFeatureViolations(pkg) {
  return findOwnedTokioFeatureViolations(
    pkg,
    SERVICES_INTEGRATIONS_TOKIO_FEATURES,
    SERVICES_INTEGRATIONS_TOKIO_AGGREGATES,
  );
}

function reqwestDependencyFeatureReferences(references) {
  return references.filter(
    (reference) =>
      reference === 'reqwest'
      || reference === 'dep:reqwest'
      || reference.startsWith('reqwest/')
      || reference.startsWith('reqwest?/'),
  );
}

const REQWEST_PACKAGE_PROFILES = new Map([
  ['openbitfun-core', { dependencyFeatures: [], optional: true }],
  ['openbitfun-services-integrations', {
    dependencyFeatures: ['http2'],
    optional: true,
    servicesOwners: true,
  }],
  ['openbitfun-ai-adapters', {
    dependencyFeatures: ['http2', 'json', 'rustls-no-provider', 'socks', 'stream'],
    optional: false,
    allowedPackageFeatureRefs: new Set(['reqwest/form']),
    requiredPackageFeatureRefs: new Map([
      ['subscription-auth', new Set(['reqwest/form'])],
    ]),
    tlsProviderDependency: 'openbitfun-services-core',
  }],
  ['openbitfun-cli', {
    dependencyFeatures: ['http2', 'rustls-no-provider', 'stream'],
    optional: false,
    tlsProviderDependency: 'openbitfun-services-core',
  }],
  ['openbitfun-desktop', {
    dependencyFeatures: ['http2', 'json', 'query', 'rustls-no-provider', 'stream'],
    optional: false,
  }],
  ['openbitfun-miniapp-market-service', {
    dependencyFeatures: ['form', 'http2', 'json', 'rustls-no-provider'],
    optional: false,
    tlsProviderDependency: 'openbitfun-services-core',
  }],
  // Relay verifies global identity over bounded JSON HTTPS; no streaming or form API.
  ['openbitfun-relay-service', {
    dependencyFeatures: ['json', 'rustls-no-provider'],
    optional: false,
  }],
  ['openbitfun-skin-market-service', {
    dependencyFeatures: ['http2', 'json', 'rustls-no-provider'],
    optional: false,
    tlsProviderDependency: 'openbitfun-services-core',
  }],
]);

function findReqwestPackageProfileViolations(pkg, profile) {
  const violations = [];
  const dependencies = (pkg.dependencies ?? []).filter(
    (dependency) => dependency.name === 'reqwest',
  );
  if (dependencies.length !== 1) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} must declare exactly one normal Reqwest dependency`,
    });
    return violations;
  }

  const dependency = dependencies[0];
  if (
    (dependency.kind ?? null) !== null
    || (dependency.rename ?? null) !== null
    || (dependency.target ?? null) !== null
  ) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message:
        `${pkg.name} Reqwest dependency must be an unrenamed, non-target-specific normal dependency`,
    });
  }
  if (dependency.uses_default_features !== false) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} Reqwest dependency must disable default features`,
    });
  }
  if (dependency.optional !== profile.optional) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message:
        `${pkg.name} Reqwest dependency optional=${dependency.optional} does not match its owner profile`,
    });
  }
  const actualFeatures = new Set(dependency.features ?? []);
  const expectedFeatures = new Set(profile.dependencyFeatures);
  const missing = [...expectedFeatures]
    .filter((feature) => !actualFeatures.has(feature));
  const unexpected = [...actualFeatures]
    .filter((feature) => !expectedFeatures.has(feature));
  if (missing.length > 0) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} Reqwest dependency missing features: ${missing.join(', ')}`,
    });
  }
  if (unexpected.length > 0) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} Reqwest dependency has unexpected dependency features: ${unexpected.join(', ')}`,
    });
  }

  if (profile.servicesOwners) {
    violations.push(...findServicesIntegrationsReqwestFeatureViolations(pkg));
  } else {
    for (const [featureName, references] of Object.entries(pkg.features ?? {})) {
      for (const reference of reqwestDependencyFeatureReferences(references)) {
        if (
          (reference.startsWith('reqwest/') || reference.startsWith('reqwest?/'))
          && !profile.allowedPackageFeatureRefs?.has(reference)
        ) {
          violations.push({
            path: pkg.manifest_path,
            line: 1,
            message:
              `${pkg.name}:${featureName} has unreviewed Reqwest feature reference ${reference}`,
          });
        }
      }
    }
    for (const [featureName, requiredReferences] of profile.requiredPackageFeatureRefs ?? []) {
      const actualReferences = new Set(pkg.features?.[featureName] ?? []);
      for (const reference of requiredReferences) {
        if (!actualReferences.has(reference)) {
          violations.push({
            path: pkg.manifest_path,
            line: 1,
            message: `${pkg.name}:${featureName} is missing Reqwest feature reference ${reference}`,
          });
        }
      }
    }
  }

  if (profile.tlsProviderDependency) {
    const providerDependencies = (pkg.dependencies ?? []).filter(
      (candidate) => candidate.name === profile.tlsProviderDependency
        && (candidate.kind ?? null) === null
        && (candidate.target ?? null) === null,
    );
    if (
      providerDependencies.length !== 1
      || !(providerDependencies[0].features ?? []).includes('tls-provider')
    ) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message:
          `${pkg.name} must select ${profile.tlsProviderDependency}/tls-provider `
          + 'for its provider-neutral Reqwest client',
      });
    }
  }

  return violations;
}

function ungovernedReqwestDependencyViolations(pkg) {
  const hasReqwestDependency = (pkg.dependencies ?? []).some(
    (dependency) => dependency.name === 'reqwest',
  );
  if (!hasReqwestDependency) {
    return [];
  }
  return [
    {
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} Reqwest dependency is missing a reviewed owner profile`,
    },
  ];
}

export function findReqwestDependencyFeatureViolations(packages) {
  return packages.flatMap((pkg) => {
    const profile = REQWEST_PACKAGE_PROFILES.get(pkg.name);
    if (!profile) {
      return ungovernedReqwestDependencyViolations(pkg);
    }
    return findReqwestPackageProfileViolations(pkg, profile);
  });
}

function dependencyProfile(features, options = {}) {
  return {
    features,
    kind: options.kind ?? null,
    optional: options.optional ?? false,
    target: options.target ?? null,
    useDefaultFeatures: options.useDefaultFeatures ?? true,
    allowDependencyFeatureAlias: options.allowDependencyFeatureAlias ?? false,
    ownerFeatureCapabilities: options.ownerFeatureCapabilities,
  };
}

const THIRD_PARTY_CAPABILITY_PROFILES = new Map([
  ['axum', {
    label: 'Axum',
    packages: new Map([
      ['openbitfun-ai-adapters', dependencyProfile(['json'], { kind: 'dev' })],
      ['openbitfun-core', dependencyProfile(['json'], { optional: true })],
      ['openbitfun-desktop', dependencyProfile(['json'])],
      ['openbitfun-miniapp-market-server', dependencyProfile(['json'])],
      ['openbitfun-miniapp-market-service', dependencyProfile(['json'])],
      ['openbitfun-relay-server', dependencyProfile([])],
      ['openbitfun-relay-service', dependencyProfile(['json', 'ws'])],
      ['openbitfun-server', dependencyProfile(['json', 'ws'])],
      ['openbitfun-skin-market-server', dependencyProfile(['json'])],
      ['openbitfun-skin-market-service', dependencyProfile(['json'])],
      ['openbitfun-webdriver', dependencyProfile(['json'])],
    ]),
  }],
  ['git2', {
    label: 'Git2',
    packages: new Map([
      ['openbitfun-services-core', dependencyProfile(['vendored-libgit2'], {
        optional: true,
        useDefaultFeatures: false,
      })],
      ['openbitfun-services-integrations', dependencyProfile(['vendored-libgit2'], {
        optional: true,
        useDefaultFeatures: false,
      })],
    ]),
  }],
  ['image', {
    label: 'Image',
    packages: new Map([
      ['openbitfun-services-core', dependencyProfile([], {
        optional: true,
        useDefaultFeatures: false,
        ownerFeatureCapabilities: new Map([
          ['pet-packages', ['gif', 'jpeg', 'png', 'webp']],
        ]),
      })],
      ['openbitfun-cli', dependencyProfile(['gif', 'jpeg', 'png', 'webp'], {
        useDefaultFeatures: false,
      })],
      ['openbitfun-core', dependencyProfile(['bmp', 'gif', 'jpeg', 'png', 'webp'], {
        optional: true,
        useDefaultFeatures: false,
      })],
      // Desktop owns bounded controller-local drag thumbnail decoding.
      // Keep only its raster input formats and PNG/JPEG output codecs.
      ['openbitfun-desktop', dependencyProfile(['bmp', 'gif', 'jpeg', 'png', 'webp'], {
        useDefaultFeatures: false,
      })],
      ['openbitfun-miniapp-market-service', dependencyProfile(['jpeg', 'png', 'webp'], {
        useDefaultFeatures: false,
      })],
      ['openbitfun-services-integrations', dependencyProfile([], {
        allowDependencyFeatureAlias: true,
        optional: true,
        useDefaultFeatures: false,
        ownerFeatureCapabilities: new Map([
          ['miniapp-market', ['gif', 'jpeg', 'png', 'webp']],
          ['remote-connect', ['bmp', 'gif', 'jpeg', 'png', 'webp']],
        ]),
      })],
      ['openbitfun-skin-market-service', dependencyProfile(['gif', 'jpeg', 'png', 'webp'], {
        useDefaultFeatures: false,
      })],
      ['openbitfun-webdriver', dependencyProfile(['png'], {
        useDefaultFeatures: false,
      })],
    ]),
  }],
  ['tokio-tungstenite', {
    label: 'Tokio Tungstenite',
    packages: new Map([
      ['openbitfun-core', { ...dependencyProfile([], { optional: true }),
        devProfile: dependencyProfile([], { kind: 'dev' }),
      }],
      // Loopback WebSocket lifecycle regressions only; the relay runtime is
      // an Axum server and does not acquire a TLS/client capability.
      ['openbitfun-relay-service', dependencyProfile(['connect', 'handshake'], {
        kind: 'dev',
        useDefaultFeatures: false,
      })],
      ['openbitfun-services-integrations', dependencyProfile([], {
        optional: true,
        ownerFeatureCapabilities: new Map([
          ['remote-connect', ['rustls-tls-native-roots']],
          ['speech-realtime', ['rustls-tls-native-roots']],
        ]),
      })],
    ]),
  }],
  ['tower-http', {
    label: 'Tower HTTP',
    packages: new Map([
      ['openbitfun-core', dependencyProfile(['cors'], { optional: true })],
      ['openbitfun-desktop', dependencyProfile(['fs'])],
      ['openbitfun-miniapp-market-service', dependencyProfile(['fs', 'set-header', 'trace'])],
      ['openbitfun-relay-server', dependencyProfile(['fs'])],
      ['openbitfun-relay-service', dependencyProfile(['cors'])],
      ['openbitfun-server', dependencyProfile(['cors'])],
      ['openbitfun-skin-market-service', dependencyProfile(['fs'])],
    ]),
  }],
]);

function externalDependencyReference(reference, dependencyName) {
  if (reference === dependencyName || reference === `dep:${dependencyName}`) {
    return { activates: true, capability: null };
  }
  const match = reference.match(/^([^/?]+)(\?)?\/(.+)$/);
  if (match?.[1] !== dependencyName) {
    return null;
  }
  return { activates: !match[2], capability: match[3] };
}

function effectiveExternalDependencyState(
  feature,
  featureGraph,
  dependencyName,
  visiting = new Set(),
) {
  if (visiting.has(feature)) {
    return { activates: false, capabilities: new Set() };
  }
  visiting.add(feature);
  let activates = false;
  const capabilities = new Set();
  for (const reference of featureGraph[feature] ?? []) {
    const external = externalDependencyReference(reference, dependencyName);
    if (external) {
      activates ||= external.activates;
      if (external.capability) {
        capabilities.add(external.capability);
      }
      continue;
    }
    if (Object.hasOwn(featureGraph, reference)) {
      const nested = effectiveExternalDependencyState(
        reference,
        featureGraph,
        dependencyName,
        visiting,
      );
      activates ||= nested.activates;
      for (const capability of nested.capabilities) {
        capabilities.add(capability);
      }
    }
  }
  visiting.delete(feature);
  return { activates, capabilities };
}

function featureOwnedDependencyViolations(pkg, dependencyName, label, profile) {
  const ownerProfiles = profile.ownerFeatureCapabilities;
  if (!ownerProfiles) {
    return [];
  }
  const violations = [];
  const ownerFeatures = new Set(ownerProfiles.keys());
  const featureGraph = pkg.features ?? {};

  for (const [feature, expectedCapabilities] of ownerProfiles) {
    const state = effectiveExternalDependencyState(feature, featureGraph, dependencyName);
    if (!state.activates) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} must explicitly enable ${label}`,
      });
    }
    const actual = [...state.capabilities].sort();
    const expected = [...expectedCapabilities].sort();
    const missing = expected.filter((capability) => !actual.includes(capability));
    const unexpected = actual.filter((capability) => !expected.includes(capability));
    if (missing.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} missing ${label} capabilities: ${missing.join(', ')}`,
      });
    }
    if (unexpected.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} has unexpected ${label} capabilities: ${unexpected.join(', ')}`,
      });
    }
  }

  for (const [feature, references] of Object.entries(featureGraph)) {
    if (ownerFeatures.has(feature)) {
      continue;
    }
    if (feature === dependencyName && profile.allowDependencyFeatureAlias) {
      const state = effectiveExternalDependencyState(feature, featureGraph, dependencyName);
      if (!state.activates) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name}:${feature} shared ${label} activation alias must activate the dependency`,
        });
      }
      if (state.capabilities.size > 0) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message:
            `${pkg.name}:${feature} shared ${label} activation alias must not select capabilities: `
            + [...state.capabilities].sort().join(', '),
        });
      }
      continue;
    }
    if (references.some((reference) => externalDependencyReference(reference, dependencyName))) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${feature} enables ${label} outside its reviewed owner features`,
      });
    }
  }

  return violations;
}

function thirdPartyDependencyProfileViolations(pkg, dependencyName, policy, profile) {
  const violations = [];
  // A separately reviewed test client must not broaden the runtime edge.
  if (profile.devProfile) {
    const development = (pkg.dependencies ?? []).filter(dep => dep.name === dependencyName && dep.kind === 'dev');
    if (development.length) violations.push(...thirdPartyDependencyProfileViolations(
      { ...pkg, dependencies: development, features: {} }, dependencyName, policy, profile.devProfile,
    ));
    pkg = { ...pkg, dependencies: (pkg.dependencies ?? []).filter(dep => dep.name !== dependencyName || dep.kind !== 'dev') };
  }
  const dependencies = (pkg.dependencies ?? []).filter(
    (dependency) => dependency.name === dependencyName,
  );
  if (dependencies.length !== 1) {
    return [{
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} must declare exactly one reviewed ${policy.label} dependency`,
    }];
  }
  const dependency = dependencies[0];
  if (
    (dependency.kind ?? null) !== profile.kind
    || (dependency.rename ?? null) !== null
    || (dependency.target ?? null) !== profile.target
    || dependency.optional !== profile.optional
  ) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} ${policy.label} dependency does not match its reviewed owner shape`,
    });
  }
  if ((dependency.uses_default_features !== false) !== profile.useDefaultFeatures) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} ${policy.label} dependency default-feature policy does not match its owner profile`,
    });
  }
  const actual = new Set(dependency.features ?? []);
  const expected = new Set(profile.features);
  const missing = [...expected].filter((feature) => !actual.has(feature));
  const unexpected = [...actual].filter((feature) => !expected.has(feature));
  if (missing.length > 0) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} ${policy.label} dependency missing features: ${missing.join(', ')}`,
    });
  }
  if (unexpected.length > 0) {
    violations.push({
      path: pkg.manifest_path,
      line: 1,
      message: `${pkg.name} ${policy.label} dependency has unexpected features: ${unexpected.join(', ')}`,
    });
  }
  violations.push(...featureOwnedDependencyViolations(
    pkg,
    dependencyName,
    policy.label,
    profile,
  ));
  return violations;
}

export function findThirdPartyCapabilityFeatureViolations(packages) {
  const violations = [];
  for (const pkg of packages) {
    for (const [dependencyName, policy] of THIRD_PARTY_CAPABILITY_PROFILES) {
      if (!(pkg.dependencies ?? []).some((dependency) => dependency.name === dependencyName)) {
        continue;
      }
      const profile = policy.packages.get(pkg.name);
      if (!profile) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name} ${policy.label} dependency is missing a reviewed owner profile`,
        });
        continue;
      }
      violations.push(...thirdPartyDependencyProfileViolations(
        pkg,
        dependencyName,
        policy,
        profile,
      ));
    }
  }
  return violations;
}

const RESOLVED_THIRD_PARTY_CAPABILITY_POLICIES = new Map([
  ['git2', {
    forbiddenFeatures: new Set(['https', 'vendored-openssl']),
  }],
  ['libgit2-sys', {
    forbiddenFeatures: new Set(['https', 'openssl-sys', 'vendored-openssl']),
  }],
  ['image', {
    versionPrefix: '0.25.',
    ignoredVersionPrefixes: ['0.24.'],
    // macOS clipboard support currently adds TIFF through arboard. The other
    // formats are the codecs selected by reviewed OpenBitFun owners.
    allowedFeatures: new Set(['bmp', 'gif', 'jpeg', 'png', 'tiff', 'webp']),
  }],
]);

export function findResolvedThirdPartyCapabilityFeatureViolations(records, { root }) {
  const violations = [];

  for (const [dependencyName, policy] of RESOLVED_THIRD_PARTY_CAPABILITY_POLICIES) {
    const namedRecords = records.filter((record) => record.name === dependencyName);
    const governedRecords = policy.versionPrefix
      ? namedRecords.filter((record) => record.version.startsWith(policy.versionPrefix))
      : namedRecords;
    for (const record of namedRecords) {
      if (
        !policy.versionPrefix
        || record.version.startsWith(policy.versionPrefix)
        || policy.ignoredVersionPrefixes?.some((prefix) => record.version.startsWith(prefix))
      ) {
        continue;
      }
      violations.push({
        path: join(root, 'Cargo.toml'),
        line: 1,
        message: `resolved ${dependencyName} ${record.version} uses an unreviewed version family`,
      });
    }
    if (policy.versionPrefix && namedRecords.length > 0 && governedRecords.length === 0) {
      violations.push({
        path: join(root, 'Cargo.toml'),
        line: 1,
        message:
          `resolved ${dependencyName} graph has no evidence for reviewed version family `
          + policy.versionPrefix,
      });
      continue;
    }

    for (const record of governedRecords) {
      const features = record.features ?? [];
      const unexpected = policy.forbiddenFeatures
        ? features.filter((feature) => policy.forbiddenFeatures.has(feature))
        : features.filter((feature) => !policy.allowedFeatures.has(feature));
      if (unexpected.length === 0) {
        continue;
      }
      violations.push({
        path: join(root, 'Cargo.toml'),
        line: 1,
        message:
          `resolved ${dependencyName} ${record.version} feature union enables unreviewed capabilities: `
          + unexpected.join(', '),
      });
    }
  }

  return violations;
}

export function findRuntimeServicesTestSupportFeatureViolations(packages) {
  const violations = [];

  const pathToFeature = (featureGraph, start, target, visiting = new Set()) => {
    if (start === target) {
      return [target];
    }
    if (visiting.has(start)) {
      return null;
    }
    visiting.add(start);
    for (const reference of featureGraph[start] ?? []) {
      if (!Object.hasOwn(featureGraph, reference)) {
        continue;
      }
      const suffix = pathToFeature(featureGraph, reference, target, visiting);
      if (suffix) {
        visiting.delete(start);
        return [start, ...suffix];
      }
    }
    visiting.delete(start);
    return null;
  };

  for (const pkg of packages) {
    const runtimeServiceAliases = new Set(['openbitfun-runtime-services']);
    for (const dependency of pkg.dependencies ?? []) {
      if (dependency.name !== 'openbitfun-runtime-services') {
        continue;
      }
      runtimeServiceAliases.add(dependency.rename ?? dependency.name);
      if (
        (dependency.features ?? []).includes('test-support')
        && dependency.kind !== 'dev'
      ) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message:
            `${pkg.name} must not enable openbitfun-runtime-services/test-support for its `
            + dependencyDescription(dependency),
        });
      }
    }

    for (const [featureName, references] of Object.entries(pkg.features ?? {})) {
      const testSupportReference = references.find((reference) =>
        [...runtimeServiceAliases].some(
          (alias) =>
            reference === `${alias}/test-support`
            || reference === `${alias}?/test-support`,
        ));
      if (!testSupportReference) {
        continue;
      }
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message:
          `${pkg.name}:${featureName} must not expose openbitfun-runtime-services/test-support `
          + 'through a package feature',
      });
    }

    if (pkg.name === 'openbitfun-runtime-services') {
      for (const featureName of Object.keys(pkg.features ?? {})) {
        if (featureName === 'test-support') {
          continue;
        }
        const path = pathToFeature(pkg.features, featureName, 'test-support');
        if (!path) {
          continue;
        }
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message:
            `openbitfun-runtime-services:${featureName} must not expose test-support; `
            + `reachable via ${path.join(' -> ')}`,
        });
      }
    }
  }

  return violations;
}

export function findResolvedReqwestNativeTlsViolations(records, { root }) {
  const reqwestRecords = records.filter((record) => record.name === 'reqwest');
  if (reqwestRecords.length === 0) {
    return [{
      path: join(root, 'Cargo.toml'),
      line: 1,
      message: 'resolved Cargo graph is missing Reqwest feature-union evidence',
    }];
  }

  const reqwestViolations = reqwestRecords.flatMap((record) => {
    const nativeTlsFeatures = (record.features ?? []).filter(
      (feature) =>
        feature === 'default-tls'
        || feature === '__native-tls'
        || feature.startsWith('__native-tls-')
        || feature === 'native-tls'
        || feature.startsWith('native-tls-'),
    );
    const providerSelectingFeatures = record.version.startsWith('0.13.')
      && (record.features ?? []).includes('rustls')
      ? ['rustls (selects AWS-LC)']
      : [];
    const unreviewedTlsFeatures = [...nativeTlsFeatures, ...providerSelectingFeatures];
    if (unreviewedTlsFeatures.length === 0) {
      return [];
    }
    return [{
      path: join(root, 'Cargo.toml'),
      line: 1,
      message:
        `resolved reqwest ${record.version} feature union enables an unreviewed TLS backend: `
        + unreviewedTlsFeatures.join(', '),
    }];
  });

  const rustlsRecords = records.filter((record) => record.name === 'rustls');
  const selectedRustlsProviders = new Set(rustlsRecords
    .flatMap((record) => (record.features ?? [])
        .filter((feature) => feature === 'ring' || feature === 'aws_lc_rs' || feature === 'aws-lc-rs')
        .map((feature) => feature === 'ring' ? feature : 'aws_lc_rs')));
  if (records.some((record) => record.name === 'aws-lc-rs' || record.name === 'aws-lc-sys')) {
    selectedRustlsProviders.add('aws_lc_rs');
  }
  const sortedRustlsProviders = [...selectedRustlsProviders].sort();
  const rustlsVersions = [...new Set(rustlsRecords.map((record) => record.version))].sort();
  const reqwestUsesRustls = reqwestRecords.some((record) =>
    (record.features ?? []).some((feature) => feature.includes('rustls')));
  const rustlsProviderViolations = !reqwestUsesRustls
    || (sortedRustlsProviders.length === 1 && sortedRustlsProviders[0] === 'ring')
    ? []
    : [{
        path: join(root, 'Cargo.toml'),
        line: 1,
        message:
          `resolved Reqwest/Rustls closure must select only the ring crypto provider; `
          + `rustls ${rustlsVersions.join(', ') || '(missing)'} selects `
          + (sortedRustlsProviders.join(', ') || '(no provider)'),
      }];

  return [...reqwestViolations, ...rustlsProviderViolations];
}

export function findServicesIntegrationsReqwestFeatureViolations(pkg) {
  const violations = [];
  const featureGraph = pkg.features ?? {};
  const ownerFeatures = new Set(servicesReqwestOwnerFeatures);
  const ownerFeatureReferences = new Map([
    ['account-identity', ['reqwest/json']],
    ['announcement', ['reqwest/json']],
    ['browser-control', ['reqwest/json']],
    ['mcp', ['reqwest/json', 'reqwest/stream']],
    ['miniapp-loopx', ['reqwest/json']],
    ['miniapp-market', ['reqwest/json', 'reqwest/query', 'reqwest/stream']],
    ['miniapp-runtime', ['reqwest/stream']],
    ['models-dev', ['reqwest/system-proxy']],
    ['remote-connect', ['reqwest/json', 'reqwest/multipart', 'reqwest/query']],
    ['remote-ssh-concrete', ['reqwest/stream']],
    ['review-platform', ['reqwest/json', 'reqwest/query', 'reqwest/stream']],
    ['speech', ['reqwest/stream']],
    ['web-tools', ['reqwest/json']],
  ]);

  for (const featureName of servicesReqwestOwnerFeatures) {
    const references = featureGraph[featureName];
    if (!references) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${featureName} governed Reqwest owner feature is missing`,
      });
      continue;
    }
    if (!references.some((reference) => reference === 'reqwest' || reference === 'dep:reqwest')) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${featureName} must explicitly enable reqwest`,
      });
    }
    if (!references.includes('reqwest/rustls-no-provider')) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${featureName} is missing reqwest/rustls-no-provider`,
      });
    }
    if (!references.includes('openbitfun-services-core/tls-provider')) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name}:${featureName} is missing openbitfun-services-core/tls-provider`,
      });
    }
    for (const reference of ownerFeatureReferences.get(featureName) ?? []) {
      if (!references.includes(reference)) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name}:${featureName} is missing Reqwest feature reference ${reference}`,
        });
      }
    }
  }

  for (const [featureName, references] of Object.entries(featureGraph)) {
    const reqwestReferences = reqwestDependencyFeatureReferences(references);
    const implicitDependencyFeature =
      featureName === 'reqwest'
      && reqwestReferences.length === 1
      && reqwestReferences[0] === 'dep:reqwest';
    if (implicitDependencyFeature || reqwestReferences.length === 0) {
      continue;
    }
    if (!ownerFeatures.has(featureName)) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message:
          `${pkg.name}:${featureName} enables Reqwest outside its reviewed owner features`,
      });
      continue;
    }
    const allowedReferences = new Set([
      'reqwest',
      'dep:reqwest',
      'reqwest/rustls-no-provider',
      ...(ownerFeatureReferences.get(featureName) ?? []),
    ]);
    for (const reference of reqwestReferences) {
      if (
        !allowedReferences.has(reference)
      ) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message:
            `${pkg.name}:${featureName} has unreviewed Reqwest feature reference ${reference}`,
        });
      }
    }
  }

  return violations;
}


export function findServicesCoreTokioFeatureViolations(pkg) {
  return findOwnedTokioFeatureViolations(
    pkg,
    SERVICES_CORE_TOKIO_FEATURES,
    SERVICES_CORE_TOKIO_AGGREGATES,
  );
}

export function findServicesCorePlatformDependencyFeatureViolations(packages) {
  const violations = [];

  for (const pkg of packages) {
    if (pkg.name !== 'openbitfun-services-core') {
      continue;
    }
    for (const dependency of pkg.dependencies ?? []) {
      if (dependency.name !== 'windows' || (dependency.features ?? []).length === 0) {
        continue;
      }
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message:
          'windows API capabilities must be selected by services-core owner features, not the dependency declaration',
      });
    }
  }

  return violations;
}

export function findServicesIntegrationsPlatformDependencyFeatureViolations(packages) {
  const expectedFeatures = new Set([
    'Win32_Foundation',
    'Win32_Storage_FileSystem',
  ]);
  const violations = [];

  for (const pkg of packages) {
    if (pkg.name !== 'openbitfun-services-integrations') {
      continue;
    }
    const dependencies = (pkg.dependencies ?? []).filter(
      (dependency) => dependency.name === 'windows',
    );
    const dependency = dependencies[0];
    if (
      dependencies.length !== 1
      || (dependency.kind ?? null) !== null
      || (dependency.rename ?? null) !== null
      || dependency.optional !== true
      || dependency.target !== 'cfg(windows)'
    ) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name} must declare exactly one reviewed Windows dependency`,
      });
      continue;
    }
    const actual = new Set(dependency.features ?? []);
    const missing = [...expectedFeatures].filter((feature) => !actual.has(feature));
    const unexpected = [...actual].filter((feature) => !expectedFeatures.has(feature));
    if (missing.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name} Windows dependency missing API capabilities: ${missing.join(', ')}`,
      });
    }
    if (unexpected.length > 0) {
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `${pkg.name} Windows dependency has unexpected Windows API capabilities: ${unexpected.join(', ')}`,
      });
    }
  }

  return violations;
}

export function findTokioDependencyFeatureViolations(packages) {
  const violations = [];

  for (const pkg of packages) {
    if (TOKIO_DEPENDENCY_POLICY_EXCLUDED_PACKAGES.has(pkg.name)) {
      continue;
    }
    for (const dependency of pkg.dependencies ?? []) {
      if (dependency.name !== 'tokio') {
        continue;
      }
      const features = dependency.features ?? [];
      if (features.includes('full')) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name} must not enable tokio/full for its ${dependencyDescription(dependency)}`,
        });
      }
      const featureOwnedIntegrationRuntime =
        pkg.name === 'openbitfun-services-integrations'
        && (dependency.kind ?? null) === null;
      const featureOwnedServicesCoreRuntime =
        pkg.name === 'openbitfun-services-core'
        && (dependency.kind ?? null) === null;
      const featureOwnedCoreRuntime =
        pkg.name === 'openbitfun-core'
        && (dependency.kind ?? null) === null;
      const featureOwnedAgentRuntime =
        pkg.name === 'openbitfun-agent-runtime'
        && (dependency.kind ?? null) === null;
      if (
        featureOwnedIntegrationRuntime
        || featureOwnedServicesCoreRuntime
        || featureOwnedCoreRuntime
        || featureOwnedAgentRuntime
      ) {
        const actual = [...features].sort();
        const expected = [...(featureOwnedCoreRuntime
          ? ['fs', 'sync']
          : SERVICES_CORE_BASE_TOKIO_FEATURES)].sort();
        const missing = expected.filter((feature) => !actual.includes(feature));
        const unexpected = actual.filter((feature) => !expected.includes(feature));
        if (missing.length > 0) {
          violations.push({
            path: pkg.manifest_path,
            line: 1,
            message: `${pkg.name} missing base Tokio capabilities: ${missing.join(', ')}`,
          });
        }
        if (unexpected.length > 0) {
          violations.push({
            path: pkg.manifest_path,
            line: 1,
            message: `${pkg.name} has unexpected base Tokio capabilities: ${unexpected.join(', ')}`,
          });
        }
      } else if (features.length === 0 && !featureOwnedIntegrationRuntime) {
        violations.push({
          path: pkg.manifest_path,
          line: 1,
          message: `${pkg.name} must declare explicit Tokio capabilities for its ${dependencyDescription(dependency)}`,
        });
      }
    }

    if (pkg.name === 'openbitfun-services-integrations') {
      violations.push(...findServicesIntegrationsTokioFeatureViolations(pkg));
    }
    if (pkg.name === 'openbitfun-services-core') {
      violations.push(...findServicesCoreTokioFeatureViolations(pkg));
    }
    if (pkg.name === 'openbitfun-core') {
      violations.push(...findOwnedTokioFeatureViolations(
        pkg,
        CORE_TOKIO_FEATURES,
        CORE_TOKIO_AGGREGATES,
      ));
    }
    if (pkg.name === 'openbitfun-agent-runtime') {
      violations.push(...findOwnedTokioFeatureViolations(
        pkg,
        AGENT_RUNTIME_TOKIO_FEATURES,
      ));
    }
  }

  return violations;
}

export function findCargoLayerViolations(
  packages,
  { root, crateLayoutRules },
  resolvedDependencies = null,
) {
  const packageByManifest = new Map(
    packages.map((pkg) => [normalizedPath(pkg.manifest_path), pkg]),
  );
  const layerByManifest = new Map();
  const violations = [];

  for (const pkg of packages) {
    const layer = layerForManifest(pkg.manifest_path, { root, crateLayoutRules });
    layerByManifest.set(normalizedPath(pkg.manifest_path), layer);
    if (!layer) {
      const repoManifestPath = repositoryPath(root, pkg.manifest_path) ?? pkg.manifest_path;
      violations.push({
        path: pkg.manifest_path,
        line: 1,
        message: `unknown crate layer for repository package ${pkg.name} at ${repoManifestPath}`,
      });
    }
  }

  const declaredDependencies = [];
  for (const sourcePackage of packages) {
    for (const dependency of sourcePackage.dependencies ?? []) {
      if (!dependency.path || repositoryPath(root, dependency.path) === null) {
        continue;
      }

      const targetManifestKey = normalizedPath(join(dependency.path, 'Cargo.toml'));
      const targetPackage = packageByManifest.get(targetManifestKey);
      if (!targetPackage) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `cargo metadata did not discover internal path dependency ${dependency.name} at ${repositoryPath(root, dependency.path)}`,
        });
        continue;
      }

      declaredDependencies.push({
        sourceManifestPath: sourcePackage.manifest_path,
        targetManifestPath: targetPackage.manifest_path,
        name: dependency.name,
        kind: dependency.kind,
        optional: dependency.optional,
        target: dependency.target,
      });
    }
  }

  const dependenciesToCheck = new Map();
  for (const dependency of [
    ...declaredDependencies,
    ...(resolvedDependencies ?? []),
  ]) {
    const key = [
      normalizedPath(dependency.sourceManifestPath),
      normalizedPath(dependency.targetManifestPath),
      dependency.kind ?? 'normal',
      dependency.target ?? '',
    ].join('|');
    const existing = dependenciesToCheck.get(key);
    dependenciesToCheck.set(key, existing
      ? {
          ...existing,
          optional: existing.optional && dependency.optional,
        }
      : dependency);
  }

  for (const dependency of dependenciesToCheck.values()) {
    const sourceManifestKey = normalizedPath(dependency.sourceManifestPath);
    const targetManifestKey = normalizedPath(dependency.targetManifestPath);
    const sourcePackage = packageByManifest.get(sourceManifestKey);
    const targetPackage = packageByManifest.get(targetManifestKey);
    if (!sourcePackage || !targetPackage) {
      continue;
    }

    const sourceLayer = layerByManifest.get(sourceManifestKey);
    const targetLayer = layerByManifest.get(targetManifestKey);
    if (!sourceLayer || !targetLayer || ALLOWED_TARGET_LAYERS.get(sourceLayer)?.has(targetLayer)) {
      continue;
    }

    violations.push({
      path: sourcePackage.manifest_path,
      line: 1,
      message: `cargo dependency layer violation: ${sourcePackage.name} (${sourceLayer}) -> ${targetPackage.name} (${targetLayer}) via ${dependencyDescription(dependency)}`,
    });
  }

  return violations;
}

export function findProductEntrypointCoreFeatureViolations(
  packages,
  { root, crateLayoutRules },
) {
  const coreCompatibilityReviewedFeatures = [
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
  const CORE_TEST_SUPPORT_FEATURE = 'test-support';
  const reviewedCoreFeatureClosures = new Map([
    ['openbitfun-cli', [
      'tools-pages',
      ...coreCompatibilityReviewedFeatures,
      'product-search',
      'remote-connect',
      'plugin-runtime',
      'opencode-plugin-host',
      'ssh-remote',
    ]],
    ['openbitfun-acp', [...new Set([...acpClientCoreFeatures, ...acpServerCoreFeatures])]],
    ['openbitfun-app-server', [
      'external-sources',
      'git',
      'i18n-runtime',
      'remote-connect',
      'web-tools',
    ]],
    ['openbitfun-sdk-host-app', coreCompatibilityReviewedFeatures],
  ]);
  const fullProductCoreEntrypoints = new Set(['openbitfun-desktop', 'openbitfun-server']);
  const fullProductCoreEntrypointsFound = new Set();
  const coreCompatibilityActiveFeatures = [
    'agent-runtime',
    'ai-adapter-runtime',
    'browser-control',
    'canvas-runtime',
    'deep-research',
    'document-read',
    'external-sources',
    'file-watch',
    'filesystem',
    'git',
    'local-storage',
    'mcp-runtime',
    'model-catalog',
    'plugin-source',
    'process-runtime',
    'product-capabilities',
    'review-platform',
    'runtime-services',
    'scheduled-jobs',
    'script-tool-runtime',
    'subscription-auth',
    'terminal',
    'tool-packs',
    'tools-agent-control',
    'tools-basic',
    'tools-browser-web',
    'tools-canvas',
    'tools-computer-use',
    'tools-creation',
    'tools-git',
    'tools-image-analysis',
    'tools-mcp',
    'tools-miniapp',
    'web-tools',
    'workspace-search',
    'workspace-runtime',
    'workspace-watch',
  ];
  const acpActiveCoreFeatures = [
    ...coreCompatibilityActiveFeatures,
    'remote-workspace',
    'ssh-remote',
  ];
  const reviewedActiveCoreFeatureClosures = new Map([
    ['openbitfun-cli', [
      'tools-pages',
      ...acpActiveCoreFeatures,
      'i18n-runtime',
      'plugin-runtime',
      'product-search',
      'opencode-plugin-host',
      'remote-connect',
    ]],
    ['openbitfun-acp', acpActiveCoreFeatures],
    ['openbitfun-sdk-host-app', coreCompatibilityActiveFeatures],
    ['openbitfun-app-server', [
      'agent-runtime',
      'ai-adapter-runtime',
      'external-sources',
      'file-watch',
      'filesystem',
      'git',
      'i18n-runtime',
      'local-storage',
      'mcp-runtime',
      'model-catalog',
      'plugin-source',
      'process-runtime',
      'product-capabilities',
      'remote-connect',
      'runtime-services',
      'scheduled-jobs',
      'script-tool-runtime',
      'terminal',
      'tool-packs',
      'tools-agent-control',
      'tools-basic',
      'ts',
      'web-tools',
      'workspace-search',
      'workspace-runtime',
      'workspace-watch',
    ]],
  ]);
  const reviewedForbiddenDependencyOwnerFeatures = new Map([
    ['openbitfun-sdk-host-app', new Map([
      ['openbitfun-services-integrations', [
        'announcement',
        'function-agents',
        'product-full',
        'remote-connect',
        'remote-ssh',
        'remote-ssh-concrete',
      ]],
      ['openbitfun-product-domains', ['function-agents', 'product-full']],
      ['openbitfun-services-core', ['dispatch-workspace']],
    ])],
  ]);
  const packageByManifest = new Map(
    packages.map((pkg) => [normalizedPath(pkg.manifest_path), pkg]),
  );
  const violations = [];

  const reviewedAcpRoleSelections = new Map([
    ['openbitfun-cli', {
      label: 'CLI',
      requiredFeatures: ['client', 'server'],
    }],
    ['openbitfun-desktop', {
      label: 'Desktop',
      requiredFeatures: ['client'],
    }],
  ]);
  const acpPackage = packages.find((pkg) => pkg.name === 'openbitfun-acp');
  if (acpPackage) {
    const reviewedConsumersFound = new Set();
    for (const sourcePackage of packages) {
      const declaredDependencies = (sourcePackage.dependencies ?? []).filter((candidate) => {
        if (!candidate.path) {
          return false;
        }
        return packageByManifest.get(
          normalizedPath(join(candidate.path, 'Cargo.toml')),
        )?.name === 'openbitfun-acp';
      });
      const normalDependencies = declaredDependencies.filter(
        (dependency) => dependency.kind === null,
      );
      const rule = reviewedAcpRoleSelections.get(sourcePackage.name);
      if (!rule) {
        if (declaredDependencies.length > 0) {
          violations.push({
            path: sourcePackage.manifest_path,
            line: 1,
            message: `openbitfun-acp consumer ${sourcePackage.name} must register an explicit role selection`,
          });
        }
        continue;
      }
      if (declaredDependencies.length === 0) {
        continue;
      }
      reviewedConsumersFound.add(sourcePackage.name);
      const unconditionalDependencies = normalDependencies.filter(
        (dependency) => dependency.target === null && dependency.optional !== true,
      );
      if (unconditionalDependencies.length === 0) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `${rule.label} ACP role selection must keep an unconditional normal openbitfun-acp dependency`,
        });
      }
      if (declaredDependencies.some((dependency) => dependency.optional === true)) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `${rule.label} ACP role selection must not make a openbitfun-acp dependency optional`,
        });
      }
      if (declaredDependencies.some((dependency) => dependency.uses_default_features !== false)) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `${rule.label} ACP role selection must set default-features = false on every dependency`,
        });
      }
      const unconditionalFeatures = new Set(
        unconditionalDependencies.flatMap((dependency) => dependency.features ?? []),
      );
      const selectedFeatures = new Set(
        declaredDependencies.flatMap((dependency) => dependency.features ?? []),
      );
      if (unconditionalDependencies.length > 0) {
        for (const requiredFeature of rule.requiredFeatures) {
          if (!unconditionalFeatures.has(requiredFeature)) {
            violations.push({
              path: sourcePackage.manifest_path,
              line: 1,
              message: `${rule.label} ACP role selection must include ${requiredFeature}`,
            });
          }
        }
      }
      for (const selectedFeature of selectedFeatures) {
        if (!rule.requiredFeatures.includes(selectedFeature)) {
          violations.push({
            path: sourcePackage.manifest_path,
            line: 1,
            message: `${rule.label} ACP role selection must not include ${selectedFeature}`,
          });
        }
      }
    }
    for (const [sourceName, rule] of reviewedAcpRoleSelections) {
      const sourcePackage = packages.find((pkg) => pkg.name === sourceName);
      if (sourcePackage && !reviewedConsumersFound.has(sourceName)) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `${rule.label} ACP role selection must keep the openbitfun-acp dependency`,
        });
      }
    }
  }

  for (const sourcePackage of packages) {
    const sourceLayer = layerForManifest(sourcePackage.manifest_path, {
      root,
      crateLayoutRules,
    });
    if (sourceLayer !== 'apps' && sourceLayer !== 'interfaces') {
      continue;
    }

    for (const dependency of sourcePackage.dependencies ?? []) {
      if (!dependency.path || repositoryPath(root, dependency.path) === null) {
        continue;
      }
      const targetPackage = packageByManifest.get(
        normalizedPath(join(dependency.path, 'Cargo.toml')),
      );
      if (targetPackage?.name !== 'openbitfun-core') {
        continue;
      }
      const roleOwnedAcpDependency =
        sourcePackage.name === 'openbitfun-acp' && dependency.optional === true;
      if (dependency.kind === 'dev') {
        // A `[dev-dependencies]` edge on openbitfun-core only widens the test
        // build. It may switch on Core test-support constructors (isolated
        // workspace catalogs for in-process fixtures) and nothing else; the
        // product capability closure is owned by the normal dependency edge.
        const devSelectedFeatures = [...new Set(dependency.features ?? [])].sort();
        if (devSelectedFeatures.length !== 1 || devSelectedFeatures[0] !== CORE_TEST_SUPPORT_FEATURE) {
          violations.push({
            path: sourcePackage.manifest_path,
            line: 1,
            message: `${sourcePackage.name} openbitfun-core dev-dependency may select only ${CORE_TEST_SUPPORT_FEATURE}, not [${devSelectedFeatures.join(', ')}]`,
          });
        }
        continue;
      }
      if (
        !roleOwnedAcpDependency
        && (!Array.isArray(dependency.features) || dependency.features.length === 0)
      ) {
        violations.push({
          path: sourcePackage.manifest_path,
          line: 1,
          message: `product entrypoint ${sourcePackage.name} must select at least one explicit feature for its openbitfun-core ${dependencyDescription(dependency)}`,
        });
      }
      if (fullProductCoreEntrypoints.has(sourcePackage.name)) {
        fullProductCoreEntrypointsFound.add(sourcePackage.name);
        const selectedFeatures = [...new Set(dependency.features ?? [])].sort();
        if (selectedFeatures.length !== 1 || selectedFeatures[0] !== 'product-full') {
          violations.push({
            path: sourcePackage.manifest_path,
            line: 1,
            message: `${sourcePackage.name} Core capability closure must select exactly product-full`,
          });
        }
      }
      const reviewedClosure = roleOwnedAcpDependency
        ? undefined
        : reviewedCoreFeatureClosures.get(sourcePackage.name);
      if (reviewedClosure) {
        const selectedFeatures = new Set(dependency.features ?? []);
        for (const requiredFeature of reviewedClosure) {
          if (!selectedFeatures.has(requiredFeature)) {
            violations.push({
              path: sourcePackage.manifest_path,
              line: 1,
              message: `${sourcePackage.name} Core capability closure must include ${requiredFeature}`,
            });
          }
        }
        for (const selectedFeature of selectedFeatures) {
          if (!reviewedClosure.includes(selectedFeature)) {
            violations.push({
              path: sourcePackage.manifest_path,
              line: 1,
              message: `${sourcePackage.name} Core capability closure must not include unreviewed feature ${selectedFeature}`,
            });
          }
        }
      }
    }
  }
  for (const sourceName of packages.some((pkg) => pkg.name === 'openbitfun-core')
    ? fullProductCoreEntrypoints
    : []) {
    const sourcePackage = packages.find((pkg) => pkg.name === sourceName);
    if (sourcePackage && !fullProductCoreEntrypointsFound.has(sourceName)) {
      violations.push({
        path: sourcePackage.manifest_path,
        line: 1,
        message: `${sourceName} Core capability closure must keep the openbitfun-core dependency`,
      });
    }
  }

  const corePackage = packages.find((pkg) => pkg.name === 'openbitfun-core');
  if (corePackage) {
    const forbiddenCoreFeatures = [
      'product-full',
      'announcement',
      'dispatch-store',
    ];
    const reportedUnexpectedFeatures = new Set();

    for (const [rootName, reviewedClosure] of reviewedCoreFeatureClosures) {
      const rootPackage = packages.find((pkg) => pkg.name === rootName);
      if (!rootPackage) {
        continue;
      }
      const allowedCoreFeatures = new Set(
        ['default', ...(reviewedActiveCoreFeatureClosures.get(rootName) ?? [])],
      );
      const rootSelectedFeatures = Object.keys(rootPackage.features ?? {})
        .filter((feature) => feature !== 'default');
      const rootLabel = new Map([
        ['openbitfun-cli', 'CLI'],
        ['openbitfun-acp', 'ACP'],
        ['openbitfun-app-server', 'App Server'],
        ['openbitfun-sdk-host-app', 'SDK Host'],
      ]).get(rootName) ?? rootName;
      const forbiddenOwnerFeatures =
        reviewedForbiddenDependencyOwnerFeatures.get(rootName);

      const packageStates = new Map();
      const pending = [];
      const queued = new Set();

      const mergePackageState = (
        pkg,
        dependencyKindContext,
        selectedFeatures,
        useDefaultFeatures,
        packagePath,
      ) => {
        const key = [
          normalizedPath(pkg.manifest_path),
          dependencyKindContext,
        ].join('|');
        let state = packageStates.get(key);
        if (!state) {
          state = {
            pkg,
            dependencyKindContext,
            selectedFeatures: new Set(),
            useDefaultFeatures: false,
            featureState: { active: new Set(), references: new Set() },
            packagePath,
            initialized: false,
          };
          packageStates.set(key, state);
        }

        let changed = false;
        for (const feature of selectedFeatures) {
          if (!state.selectedFeatures.has(feature)) {
            state.selectedFeatures.add(feature);
            changed = true;
          }
        }
        if (useDefaultFeatures && !state.useDefaultFeatures) {
          state.useDefaultFeatures = true;
          changed = true;
        }
        if (!changed && state.initialized) {
          return state;
        }

        state.featureState = expandedLocalFeatures(
          pkg.features ?? {},
          state.selectedFeatures,
          state.useDefaultFeatures,
        );
        state.initialized = true;
        if (!queued.has(key)) {
          pending.push(key);
          queued.add(key);
        }
        return state;
      };

      // This is an architecture declaration check, not a target simulator.
      // Cargo target cfg facts are multi-valued and evolve with rustc. Treating
      // every declared target edge as reachable prevents a platform-only path
      // from hiding an unreviewed Core owner. Products that genuinely need
      // different owners must express that difference through package/module
      // boundaries. Cargo features are additive, so all root features form the
      // strongest buildable profile.
      mergePackageState(
        rootPackage,
        'normal',
        rootSelectedFeatures,
        true,
        [rootPackage.name],
      );

      while (pending.length > 0) {
        const stateKey = pending.shift();
        queued.delete(stateKey);
        const {
          pkg: sourcePackage,
          dependencyKindContext,
          featureState,
          packagePath,
        } = packageStates.get(stateKey);

        for (const dependency of sourcePackage.dependencies ?? []) {
          const kind = dependency.kind ?? 'normal';
          if (
            !dependency.path
            || (kind !== 'normal' && kind !== 'build')
            || repositoryPath(root, dependency.path) === null
          ) {
            continue;
          }
          const activation = dependencyActivation(dependency, featureState);
          if (!activation) {
            continue;
          }
          const targetPackage = packageByManifest.get(
            normalizedPath(join(dependency.path, 'Cargo.toml')),
          );
          if (!targetPackage) {
            continue;
          }
          const targetDependencyKindContext =
            dependencyKindContext === 'build'
              || kind === 'build'
              || isProcMacroPackage(targetPackage)
              ? 'build'
              : 'normal';
          const targetPath = [...packagePath, targetPackage.name];
          const targetState = mergePackageState(
            targetPackage,
            targetDependencyKindContext,
            activation.features,
            activation.useDefaultFeatures,
            targetPath,
          );

          if (targetPackage.name === 'openbitfun-core') {
            const activeCoreFeatures = targetState.featureState.active;
            const unexpected = forbiddenCoreFeatures.find((feature) =>
              activeCoreFeatures.has(feature))
              ?? [...activeCoreFeatures]
                .filter((feature) => !allowedCoreFeatures.has(feature))
                .sort()[0];
            const reportKey = [rootName, targetDependencyKindContext, unexpected].join('|');
            if (unexpected && !reportedUnexpectedFeatures.has(reportKey)) {
              reportedUnexpectedFeatures.add(reportKey);
              violations.push({
                path: sourcePackage.manifest_path,
                line: 1,
                message: `${rootLabel} dependency closure must not enable ${unexpected}: ${[
                  ...packagePath,
                  `${targetPackage.name}/${unexpected}`,
                ].join(' -> ')}`,
              });
            }
            continue;
          }

          const forbiddenOwnerFeature = (
            forbiddenOwnerFeatures?.get(targetPackage.name) ?? []
          ).find((feature) => targetState.featureState.active.has(feature));
          if (forbiddenOwnerFeature) {
            const forbiddenOwner = `${targetPackage.name}/${forbiddenOwnerFeature}`;
            const reportKey = [
              rootName,
              targetDependencyKindContext,
              forbiddenOwner,
            ].join('|');
            if (!reportedUnexpectedFeatures.has(reportKey)) {
              reportedUnexpectedFeatures.add(reportKey);
              violations.push({
                path: sourcePackage.manifest_path,
                line: 1,
                message: `${rootLabel} dependency closure must not enable ${forbiddenOwner}: ${[
                  ...packagePath,
                  forbiddenOwner,
                ].join(' -> ')}`,
              });
            }
            continue;
          }
        }
      }
    }
  }

  return violations;
}

function normalizedDependencyKind(dependency) {
  return dependency.kind ?? 'normal';
}

function normalizedDependencyTarget(dependency) {
  return dependency.target ?? null;
}

function sameStringSet(actual, expected) {
  const left = [...new Set(actual ?? [])].sort();
  const right = [...new Set(expected ?? [])].sort();
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function featureForwardingReferences(featureGraph, dependency) {
  const alias = dependencyAlias(dependency);
  const references = [];
  for (const [sourceFeature, values] of Object.entries(featureGraph ?? {})) {
    for (const value of values) {
      const match = value.match(/^([^/?]+)(\?)?\/(.+)$/);
      if (match?.[1] === alias) {
        references.push({
          sourceFeature,
          feature: match[3],
          weak: Boolean(match[2]),
        });
      }
    }
  }
  return references;
}

function featureDependencyActivations(featureGraph, dependency) {
  const alias = dependencyAlias(dependency);
  const activations = [];
  for (const [sourceFeature, values] of Object.entries(featureGraph ?? {})) {
    if (values.includes(`dep:${alias}`) || values.includes(alias)) {
      activations.push(sourceFeature);
    }
  }
  return activations;
}

function packageMatchesManifest(pkg, manifestPath, root) {
  return repositoryPath(root, pkg.manifest_path) === manifestPath;
}

function dependencyTargetsPackage(dependency, targetPackage) {
  return dependency.path !== null
    && dependency.path !== undefined
    && normalizedPath(join(dependency.path, 'Cargo.toml'))
      === normalizedPath(targetPackage.manifest_path);
}

function dependencyEdgeMatches(dependency, expected) {
  return normalizedDependencyKind(dependency) === expected.kind
    && dependency.optional === expected.optional
    && normalizedDependencyTarget(dependency) === expected.target
    && (dependency.rename ?? null) === (expected.rename ?? null)
    && sameStringSet(dependency.features, expected.features);
}

function featureTransitivelyReaches(featureGraph, sourceFeature, destinations, seen = new Set()) {
  if (destinations.has(sourceFeature)) {
    return true;
  }
  if (seen.has(sourceFeature)) {
    return false;
  }
  seen.add(sourceFeature);
  return (featureGraph[sourceFeature] ?? []).some((reference) =>
    Object.hasOwn(featureGraph, reference)
    && featureTransitivelyReaches(featureGraph, reference, destinations, seen));
}

export function findRedundantInternalDefaultFeatureDisables(
  packages,
  {
    root,
    guardedManifests = guardedEmptyInternalDefaultManifestPaths,
  } = {},
) {
  if (!root) {
    throw new Error('redundant internal default-feature check requires the repository root');
  }

  const packageByManifest = new Map(
    packages.map((pkg) => [normalizedPath(pkg.manifest_path), pkg]),
  );
  const guardedTargets = new Set(
    guardedManifests.map((path) => normalizedPath(join(root, path))),
  );
  const violations = [];

  for (const consumer of packages) {
    for (const dependency of consumer.dependencies ?? []) {
      if (dependency.uses_default_features !== false || !dependency.path) {
        continue;
      }
      const targetPackage = packageByManifest.get(
        normalizedPath(join(dependency.path, 'Cargo.toml')),
      );
      const targetFeatures = targetPackage?.features ?? {};
      if (
        !targetPackage
        || !guardedTargets.has(normalizedPath(targetPackage.manifest_path))
        || !Object.hasOwn(targetFeatures, 'default')
        || !sameStringSet(targetFeatures.default, [])
      ) {
        continue;
      }
      violations.push({
        path: consumer.manifest_path,
        line: 1,
        message: `${consumer.name} ${targetPackage.name} dependency has redundant default-features = false because the target default is guarded empty`,
      });
    }
  }

  return violations;
}

export function findGuardedInternalDefaultFeatureViolations(
  packages,
  {
    root,
    guardedManifests = guardedEmptyInternalDefaultManifestPaths,
  } = {},
) {
  if (!root) {
    throw new Error('guarded internal default-feature check requires the repository root');
  }

  const packageByManifest = new Map(
    packages.map((pkg) => [normalizedPath(pkg.manifest_path), pkg]),
  );
  const violations = [];

  for (const manifestPath of guardedManifests) {
    const targetPackage = packageByManifest.get(normalizedPath(join(root, manifestPath)));
    if (!targetPackage) {
      violations.push({
        path: join(root, manifestPath),
        line: 1,
        message: `guarded internal empty-default target is missing: ${manifestPath}`,
      });
      continue;
    }
    const targetFeatures = targetPackage.features ?? {};
    if (
      !Object.hasOwn(targetFeatures, 'default')
      || !sameStringSet(targetFeatures.default, [])
    ) {
      violations.push({
        path: targetPackage.manifest_path,
        line: 1,
        message: `${targetPackage.name} guarded default feature must stay explicitly empty`,
      });
    }
  }

  return violations;
}

export function findCapabilityContractConsumerViolations(
  packages,
  rules = capabilityContractDependencyRules,
  { root } = {},
) {
  const violations = [];
  const targetPackages = new Map();

  if (!root) {
    throw new Error('capability contract consumer check requires the repository root');
  }

  for (const rule of rules) {
    const targetPackage = packages.find((pkg) =>
      pkg.name === rule.packageName && packageMatchesManifest(pkg, rule.manifestPath, root));
    if (!targetPackage) {
      violations.push({
        path: rule.manifestPath,
        line: 1,
        message: `${rule.packageName} managed target is missing from Cargo metadata`,
      });
      continue;
    }
    targetPackages.set(rule.packageName, targetPackage);
    if (
      !Object.hasOwn(targetPackage.features ?? {}, 'default')
      || !sameStringSet(targetPackage.features.default, [])
    ) {
      violations.push({
        path: targetPackage.manifest_path,
        line: 1,
        message: `${rule.packageName} capability contract default feature must stay empty`,
      });
    }
    const actualFeatures = Object.keys(targetPackage.features ?? {})
      .filter((feature) => feature !== 'default');
    const expectedFeatures = Object.keys(rule.featureProfiles)
      .filter((feature) => feature !== 'default');
    if (!sameStringSet(actualFeatures, expectedFeatures)) {
      violations.push({
        path: targetPackage.manifest_path,
        line: 1,
        message: `${rule.packageName} capability contract feature surface must stay exact`,
      });
    }
    for (const [feature, expectedReferences] of Object.entries(rule.featureProfiles)) {
      if (
        Object.hasOwn(targetPackage.features ?? {}, feature)
        && !sameStringSet(targetPackage.features[feature], expectedReferences)
      ) {
        violations.push({
          path: targetPackage.manifest_path,
          line: 1,
          message: `${rule.packageName}:${feature} feature graph must stay exact`,
        });
      }
    }
  }

  for (const rule of rules) {
    const targetPackage = targetPackages.get(rule.packageName);
    if (!targetPackage) {
      continue;
    }
    for (const consumer of packages) {
      const namedDependencies = (consumer.dependencies ?? []).filter(
        (dependency) => dependency.name === rule.packageName,
      );
      const managedDependencies = namedDependencies.filter((dependency) =>
        dependencyTargetsPackage(dependency, targetPackage));
      for (const dependency of namedDependencies) {
        if (dependencyTargetsPackage(dependency, targetPackage)) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name} ${rule.packageName} dependency must use the managed internal path`,
        });
      }

      const consumerProfile = rule.consumers.get(consumer.name);
      if (!consumerProfile) {
        if (managedDependencies.length > 0) {
          violations.push({
            path: consumer.manifest_path,
            line: 1,
            message: `${consumer.name} has an unreviewed consumer edge to ${rule.packageName}`,
          });
        }
        continue;
      }
      const unmatchedExpectedEdges = [...consumerProfile.edges];
      for (const dependency of managedDependencies) {
        const matchIndex = unmatchedExpectedEdges.findIndex((edge) =>
          dependencyEdgeMatches(dependency, edge));
        if (matchIndex === -1) {
          violations.push({
            path: consumer.manifest_path,
            line: 1,
            message: `${consumer.name} has an unreviewed ${rule.packageName} dependency edge`,
          });
        } else {
          unmatchedExpectedEdges.splice(matchIndex, 1);
        }
      }
      for (const edge of unmatchedExpectedEdges) {
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name} is missing reviewed ${edge.kind} ${rule.packageName} dependency edge`,
        });
      }

      const actualForwarders = managedDependencies.flatMap((dependency) =>
        featureForwardingReferences(consumer.features, dependency));
      for (const forwarding of actualForwarders) {
        const allowed = (consumerProfile.forwarders ?? []).some((expected) =>
          expected.sourceFeature === forwarding.sourceFeature
          && expected.feature === forwarding.feature
          && expected.weak === forwarding.weak);
        if (allowed) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name}:${forwarding.sourceFeature} has unreviewed ${rule.packageName}/${forwarding.feature} forwarding`,
        });
      }
      for (const expected of consumerProfile.forwarders ?? []) {
        const present = actualForwarders.some((forwarding) =>
          expected.sourceFeature === forwarding.sourceFeature
          && expected.feature === forwarding.feature
          && expected.weak === forwarding.weak);
        if (present) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name}:${expected.sourceFeature} is missing reviewed ${rule.packageName}/${expected.feature} forwarding`,
        });
      }
      const actualActivators = managedDependencies.flatMap((dependency) =>
        featureDependencyActivations(consumer.features, dependency));
      for (const sourceFeature of actualActivators) {
        if ((consumerProfile.activators ?? []).includes(sourceFeature)) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name}:${sourceFeature} has unreviewed ${rule.packageName} activation`,
        });
      }
      for (const sourceFeature of consumerProfile.activators ?? []) {
        if (actualActivators.includes(sourceFeature)) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name}:${sourceFeature} is missing reviewed ${rule.packageName} activation`,
        });
      }

      const directOwners = new Set([
        ...(consumerProfile.forwarders ?? []).map(({ sourceFeature }) => sourceFeature),
        ...(consumerProfile.activators ?? []),
      ]);
      const allowedAggregates = new Set(consumerProfile.aggregates ?? []);
      for (const feature of Object.keys(consumer.features ?? {})) {
        if (
          directOwners.has(feature)
          || allowedAggregates.has(feature)
          || !featureTransitivelyReaches(consumer.features, feature, directOwners)
        ) {
          continue;
        }
        violations.push({
          path: consumer.manifest_path,
          line: 1,
          message: `${consumer.name}:${feature} is an unreviewed aggregate of ${rule.packageName} capability owners`,
        });
      }
    }
  }

  return violations;
}

function matchingClosingDelimiter(
  source,
  openingIndex,
  openingCharacter,
  closingCharacter,
) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === openingCharacter) {
      depth += 1;
    } else if (character === closingCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function matchingClosingParenthesis(source, openingIndex) {
  return matchingClosingDelimiter(source, openingIndex, '(', ')');
}

function crateCfgBodies(source) {
  const bodies = [];
  let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;

  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (!source.startsWith('#![', index)) {
      break;
    }

    const closingBracket = matchingClosingDelimiter(source, index + 2, '[', ']');
    if (closingBracket === -1) {
      break;
    }
    const attribute = source.slice(index, closingBracket + 1);
    const cfgStart = /^#!\s*\[\s*cfg\s*\(/.exec(attribute);
    if (cfgStart !== null) {
      const openingIndex = cfgStart[0].length - 1;
      const closingIndex = matchingClosingParenthesis(attribute, openingIndex);
      if (closingIndex !== -1) {
        bodies.push(attribute.slice(openingIndex + 1, closingIndex));
      }
    }
    index = closingBracket + 1;
  }

  return bodies;
}

function removeCfgBranches(expression, branchName) {
  const branchStart = new RegExp(`\\b${branchName}\\s*\\(`, 'g');
  let result = expression;
  for (let match = branchStart.exec(result); match !== null; match = branchStart.exec(result)) {
    const openingIndex = branchStart.lastIndex - 1;
    const closingIndex = matchingClosingParenthesis(result, openingIndex);
    if (closingIndex === -1) {
      break;
    }
    result = `${result.slice(0, match.index)}${' '.repeat(closingIndex + 1 - match.index)}${result.slice(closingIndex + 1)}`;
    branchStart.lastIndex = match.index;
  }
  return result;
}

function containsFeatureAny(expression) {
  const anyStart = /\bany\s*\(/g;
  for (let match = anyStart.exec(expression); match !== null; match = anyStart.exec(expression)) {
    const openingIndex = anyStart.lastIndex - 1;
    const closingIndex = matchingClosingParenthesis(expression, openingIndex);
    if (closingIndex === -1) {
      return false;
    }
    const body = expression.slice(openingIndex + 1, closingIndex);
    if (/\bfeature\s*=\s*"[^"]+"/.test(body)) {
      return true;
    }
    anyStart.lastIndex = closingIndex + 1;
  }
  return false;
}

function crateFeatureCfgFacts(source) {
  const positiveFeatures = new Set();
  let unsupportedAny = false;

  for (const body of crateCfgBodies(source)) {
    const positiveExpression = removeCfgBranches(body, 'not');
    unsupportedAny ||= containsFeatureAny(positiveExpression);
    for (const match of positiveExpression.matchAll(/\bfeature\s*=\s*"([^"]+)"/g)) {
      positiveFeatures.add(match[1]);
    }
  }

  return { positiveFeatures, unsupportedAny };
}

export function findFeatureGatedTestTargetViolations(
  packages,
  { readSource = (path) => readFileSync(path, 'utf8') } = {},
) {
  const violations = [];

  for (const pkg of packages) {
    for (const target of pkg.targets ?? []) {
      if (!(target.kind ?? []).includes('test')) {
        continue;
      }
      const cfgFacts = crateFeatureCfgFacts(readSource(target.src_path));
      if (cfgFacts.unsupportedAny) {
        violations.push({
          path: target.src_path,
          line: 1,
          message: `integration test target ${pkg.name}:${target.name} uses feature any(...), which Cargo required-features cannot express; split the target`,
        });
        continue;
      }
      const declared = new Set(target['required-features'] ?? []);
      const missing = [...cfgFacts.positiveFeatures]
        .filter((feature) => !declared.has(feature));
      const unexpected = cfgFacts.positiveFeatures.size === 0
        ? []
        : [...declared].filter((feature) => !cfgFacts.positiveFeatures.has(feature));
      if (missing.length > 0 && unexpected.length > 0) {
        violations.push({
          path: target.src_path,
          line: 1,
          message: `feature-gated integration test target ${pkg.name}:${target.name} must align required-features with crate-level cfg; missing: ${missing.join(', ')}; unexpected: ${unexpected.join(', ')}`,
        });
      } else if (missing.length > 0) {
        violations.push({
          path: target.src_path,
          line: 1,
          message: `feature-gated integration test target ${pkg.name}:${target.name} must declare required-features for: ${missing.join(', ')}`,
        });
      } else if (unexpected.length > 0) {
        violations.push({
          path: target.src_path,
          line: 1,
          message: `feature-gated integration test target ${pkg.name}:${target.name} has unexpected required-features: ${unexpected.join(', ')}`,
        });
      }
    }
  }

  return violations;
}

export function discoverCargoManifestPaths(root) {
  const manifests = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          visit(join(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && entry.name === 'Cargo.toml'
        && !isVendoredExternalManifest(root, join(directory, entry.name))) {
        manifests.push(join(directory, entry.name));
      }
    }
  }

  visit(root);
  const workspaceManifest = normalizedPath(join(root, 'Cargo.toml'));
  return manifests.sort((left, right) => {
    if (normalizedPath(left) === workspaceManifest) {
      return -1;
    }
    if (normalizedPath(right) === workspaceManifest) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function loadCargoMetadata(manifestPath, root, { noDeps = false } = {}) {
  const args = ['metadata', '--format-version', '1', '--all-features'];
  if (noDeps) {
    args.push('--no-deps');
  }
  args.push('--manifest-path', manifestPath);
  const result = spawnSync(
    'cargo',
    args,
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`cargo metadata failed for ${manifestPath}: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

function resolvedDependencyRecords(metadata, root) {
  const packageById = new Map((metadata.packages ?? []).map((pkg) => [pkg.id, pkg]));
  const records = [];

  for (const node of metadata.resolve?.nodes ?? []) {
    const sourcePackage = packageById.get(node.id);
    if (!sourcePackage || repositoryPath(root, sourcePackage.manifest_path) === null) {
      continue;
    }

    for (const dependency of node.deps ?? []) {
      const targetPackage = packageById.get(dependency.pkg);
      if (!targetPackage || repositoryPath(root, targetPackage.manifest_path) === null) {
        continue;
      }

      const declarations = (sourcePackage.dependencies ?? []).filter((candidate) =>
        candidate.name === targetPackage.name
        && (candidate.rename ?? candidate.name) === dependency.name
      );
      const dependencyKinds = dependency.dep_kinds?.length > 0
        ? dependency.dep_kinds
        : [{ kind: null, target: null }];

      for (const dependencyKind of dependencyKinds) {
        const kind = dependencyKind.kind ?? null;
        const declaration = declarations.find((candidate) =>
          (candidate.kind ?? null) === kind
          && (candidate.target ?? null) === (dependencyKind.target ?? null)
        ) ?? declarations.find((candidate) => (candidate.kind ?? null) === kind)
          ?? declarations[0];

        records.push({
          sourceManifestPath: sourcePackage.manifest_path,
          targetManifestPath: targetPackage.manifest_path,
          name: dependency.name,
          kind,
          optional: declaration?.optional ?? false,
          target: dependencyKind.target ?? null,
        });
      }
    }
  }

  return records;
}

function resolvedPackageFeatureRecords(metadata) {
  const packageById = new Map((metadata.packages ?? []).map((pkg) => [pkg.id, pkg]));
  return (metadata.resolve?.nodes ?? []).flatMap((node) => {
    const pkg = packageById.get(node.id);
    if (!pkg) {
      return [];
    }
    return [{
      name: pkg.name,
      version: pkg.version,
      source: pkg.source ?? null,
      features: node.features ?? [],
    }];
  });
}

export function collectCargoMetadataGraph({
  root,
  manifestPaths = discoverCargoManifestPaths(root),
  loadMetadata = (manifestPath, options) => loadCargoMetadata(manifestPath, root, options),
}) {
  const packagesByManifest = new Map();
  const dependenciesByKey = new Map();
  const resolvedPackageFeaturesByKey = new Map();
  const coveredManifests = new Set();
  const workspaceManifest = normalizedPath(join(root, 'Cargo.toml'));
  const orderedManifests = [...manifestPaths].sort((left, right) => {
    if (normalizedPath(left) === workspaceManifest) {
      return -1;
    }
    if (normalizedPath(right) === workspaceManifest) {
      return 1;
    }
    return left.localeCompare(right);
  });

  for (const manifestPath of orderedManifests) {
    const manifestKey = normalizedPath(manifestPath);
    if (manifestKey !== workspaceManifest && coveredManifests.has(manifestKey)) {
      continue;
    }

    const metadata = loadMetadata(manifestPath, {
      noDeps: manifestKey !== workspaceManifest,
    });
    const workspaceMemberIds = new Set(metadata.workspace_members ?? []);
    for (const pkg of metadata.packages ?? []) {
      if (repositoryPath(root, pkg.manifest_path) === null) {
        continue;
      }
      const packageManifestKey = normalizedPath(pkg.manifest_path);
      if (isVendoredExternalManifest(root, pkg.manifest_path)
        && pkg.name === 'eioc' && pkg.version === '0.5.0' && !workspaceMemberIds.has(pkg.id)) {
        continue;
      }
      if (workspaceMemberIds.has(pkg.id)) {
        coveredManifests.add(packageManifestKey);
      }
      packagesByManifest.set(packageManifestKey, pkg);
    }
    for (const dependency of resolvedDependencyRecords(metadata, root)) {
      const key = [
        normalizedPath(dependency.sourceManifestPath),
        normalizedPath(dependency.targetManifestPath),
        dependency.name,
        dependency.kind ?? 'normal',
        dependency.optional,
        dependency.target ?? '',
      ].join('|');
      dependenciesByKey.set(key, dependency);
    }
    for (const record of resolvedPackageFeatureRecords(metadata)) {
      const key = `${record.name}@${record.version}|${record.source ?? ''}`;
      resolvedPackageFeaturesByKey.set(key, record);
    }
  }

  return {
    packages: [...packagesByManifest.values()],
    resolvedDependencies: [...dependenciesByKey.values()],
    resolvedPackageFeatures: [...resolvedPackageFeaturesByKey.values()],
  };
}

export function collectCargoMetadataPackages(options) {
  return collectCargoMetadataGraph(options).packages;
}

export function checkCargoDependencyLayers({ root, crateLayoutRules }) {
  const { packages, resolvedDependencies } = collectCargoMetadataGraph({ root });
  return findCargoLayerViolations(
    packages,
    { root, crateLayoutRules },
    resolvedDependencies,
  );
}

export function checkCargoDependencyLayersSafely({ root, crateLayoutRules }) {
  try {
    return checkCargoDependencyLayers({ root, crateLayoutRules });
  } catch (error) {
    return [{
      path: join(root, 'Cargo.toml'),
      line: 1,
      message: `cargo dependency layer check failed to run: ${error.message}`,
    }];
  }
}

export function checkCargoDependencyBoundaries({ root, crateLayoutRules }) {
  const {
    packages,
    resolvedDependencies,
    resolvedPackageFeatures,
  } = collectCargoMetadataGraph({ root });
  return [
    ...findCargoLayerViolations(
      packages,
      { root, crateLayoutRules },
      resolvedDependencies,
    ),
    ...findProductEntrypointCoreFeatureViolations(
      packages,
      { root, crateLayoutRules },
    ),
    ...findGuardedInternalDefaultFeatureViolations(packages, { root }),
    ...findRedundantInternalDefaultFeatureDisables(packages, { root }),
    ...findCapabilityContractConsumerViolations(packages, undefined, { root }),
    ...findFeatureGatedTestTargetViolations(packages),
    ...findRuntimeServicesTestSupportFeatureViolations(packages),
    ...findTokioDependencyFeatureViolations(packages),
    ...findReqwestDependencyFeatureViolations(packages),
    ...findThirdPartyCapabilityFeatureViolations(packages),
    ...findResolvedThirdPartyCapabilityFeatureViolations(resolvedPackageFeatures, { root }),
    ...findResolvedReqwestNativeTlsViolations(resolvedPackageFeatures, { root }),
    ...findServicesCorePlatformDependencyFeatureViolations(packages),
    ...findServicesIntegrationsPlatformDependencyFeatureViolations(packages),
  ];
}

export function checkCargoDependencyBoundariesSafely({ root, crateLayoutRules }) {
  try {
    return checkCargoDependencyBoundaries({ root, crateLayoutRules });
  } catch (error) {
    return [{
      path: join(root, 'Cargo.toml'),
      line: 1,
      message: `cargo dependency boundary check failed to run: ${error.message}`,
    }];
  }
}
