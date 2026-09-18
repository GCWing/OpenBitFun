// Self-tests for the core boundary checker configuration and parsers.

import { crateLayoutRules } from './rules/crate-layout.mjs';

export function runManifestParserSelfTest({
  isManifestDependencyDeclaration,
  parseManifestDependencies,
  manifestDependencyMatches,
  matchingForbiddenDependency,
  acpClosedFeatureProfileRules,
  coreClosedFeatureProfileRules,
  coreProductFullFeatureAssemblyRule,
  ownerCrateFeatureAssemblyRules,
  parseManifestFeatures,
  optionalDependencyFeatureOwnerRules,
  lightweightBoundaryRules,
  dependencyProfileRules,
  forbiddenManifestDependencyRules,
  noCoreDependencyCrates,
  requiredContentRules,
  forbiddenContentRules,
  forbiddenContentUnderRules,
  publicApiAllowlistRules,
  publicApiContractSlices,
  facadeOnlyFiles,
  forbiddenRuleTextForPath,
  regexSourceContainsContract,
  collectTopLevelRustPublicSymbols,
  collectPluginRootReexports,
  hasPluginWildcardReexport,
  createFacadeLineChecker,
  escapeRegex,
  validateExplicitIntegrationTestTopology,
  agentRuntimeIntegrationTestTargets,
}) {
  const positiveCases = [
    'openbitfun-core = { path = "../core" }',
    '[dependencies.openbitfun-core]',
    '[dev-dependencies."openbitfun-core"]',
    "[target.'cfg(windows)'.dependencies.openbitfun-core]",
    "[target.'cfg(unix)'.build-dependencies.\"openbitfun-core\"]",
  ];
  const negativeCases = [
    '# openbitfun-core = { path = "../core" }',
    '[dependencies]',
    '[workspace.dependencies.openbitfun-core]',
    '[dependencies.openbitfun-core-extra]',
  ];

  for (const line of positiveCases) {
    if (!isManifestDependencyDeclaration(line, 'openbitfun-core')) {
      throw new Error(`manifest parser missed dependency declaration: ${line}`);
    }
  }
  for (const line of negativeCases) {
    if (isManifestDependencyDeclaration(line, 'openbitfun-core')) {
      throw new Error(`manifest parser matched non-dependency declaration: ${line}`);
    }
  }

  const explicitTestManifest = [
    '[package]',
    'autotests = false',
    ...agentRuntimeIntegrationTestTargets.flatMap(({ name, path, requiredFeatures }) => [
      '[[test]]',
      `name = "${name}"`,
      `path = "${path}"`,
      ...(requiredFeatures === undefined
        ? []
        : [`required-features = [${requiredFeatures.map((feature) => `"${feature}"`).join(', ')}]`]),
    ]),
    '[lints]',
  ].join('\n');
  const explicitTestRoots = new Map(
    agentRuntimeIntegrationTestTargets.map(({ path }) => [path, '']),
  );
  explicitTestRoots.set(
    'tests/agent_definition_contracts.rs',
    '#[path = "agent_definition_contracts/prompt_contracts.rs"]\nmod prompt_contracts;',
  );
  const explicitTestFixture = {
    manifestText: explicitTestManifest,
    expectedTargets: agentRuntimeIntegrationTestTargets,
    topLevelRustFiles: agentRuntimeIntegrationTestTargets.map(({ path }) => path),
    rootSources: explicitTestRoots,
    leafRustFiles: ['tests/agent_definition_contracts/prompt_contracts.rs'],
    leafSources: new Map([['tests/agent_definition_contracts/prompt_contracts.rs', '']]),
  };
  const topologyErrors = validateExplicitIntegrationTestTopology(explicitTestFixture);
  if (topologyErrors.length > 0) {
    throw new Error(`valid explicit integration-test topology failed: ${topologyErrors.join('; ')}`);
  }
  const repeatedOwnerGateErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    rootSources: new Map([
      ...explicitTestRoots,
      [
        'tests/agent_definition_contracts.rs',
        '#![cfg(feature = "agent-definitions")]\n#[path = "agent_definition_contracts/prompt_contracts.rs"]\nmod prompt_contracts;',
      ],
    ]),
    leafSources: new Map([[
      'tests/agent_definition_contracts/prompt_contracts.rs',
      '#![cfg(feature = "agent-definitions")]\n',
    ]]),
  });
  if (!repeatedOwnerGateErrors.some((error) => error.includes('belongs in its explicit target root'))) {
    throw new Error('grouped test topology must keep positive owner cfg only in the target root');
  }
  const hiddenLeafCfgSources = [
    '# ! [ cfg(not(any())) ]\nfn contract() {}\n',
    '#![\n  cfg(not(any()))\n]\nfn contract() {}\n',
    '#/**/!/**/[/**/cfg(not(any()))]\nfn contract() {}\n',
    '#![doc = r#"a"]b"#]\n#![/* ] */ cfg(not(any()))]\nfn contract() {}\n',
    '#![r#cfg_attr(feature = "unrelated", cfg(windows))]\nfn contract() {}\n',
    '#!/usr/bin/env rustx\n#![cfg(not(any()))]\nfn contract() {}\n',
    '\uFEFF#!/usr/bin/env rustx\n/* preamble */\n# ! [ cfg(not(any())) ]\nfn contract() {}\n',
    "#![doc = stringify!('a)]\n#![cfg(not(any()))]\n#![doc = stringify!('b)]\nfn contract() {}\n",
  ];
  for (const leafSource of hiddenLeafCfgSources) {
    const hiddenLeafCfgErrors = validateExplicitIntegrationTestTopology({
      ...explicitTestFixture,
      leafSources: new Map([[
        'tests/agent_definition_contracts/prompt_contracts.rs',
        leafSource,
      ]]),
    });
    if (!hiddenLeafCfgErrors.some((error) => error.includes('belongs in its explicit target root'))) {
      throw new Error(`grouped test topology must reject obfuscated leaf cfg: ${leafSource}`);
    }
  }
  for (const leafSource of [
    '/* # ! [ cfg(not(any())) ] */\nfn contract() {}\n',
    'const TEXT: &str = r#"\n#![cfg(not(any()))]\n"#;\n',
    '#![doc = r#"a"]b"#]\nfn contract() {}\n',
    "#![doc = stringify!('a)]\nfn contract() {}\n",
  ]) {
    const literalLeafCfgErrors = validateExplicitIntegrationTestTopology({
      ...explicitTestFixture,
      leafSources: new Map([[
        'tests/agent_definition_contracts/prompt_contracts.rs',
        leafSource,
      ]]),
    });
    if (literalLeafCfgErrors.length > 0) {
      throw new Error(`grouped test topology misread cfg text in trivia or a literal: ${literalLeafCfgErrors.join('; ')}`);
    }
  }
  const orphanErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    leafRustFiles: [
      ...explicitTestFixture.leafRustFiles,
      'tests/agent_definition_contracts/orphan_contracts.rs',
    ],
  });
  if (!orphanErrors.some((error) => error.includes('orphan_contracts.rs'))) {
    throw new Error('explicit integration-test topology must reject an orphan leaf test');
  }
  const reviewedLeafTargets = agentRuntimeIntegrationTestTargets.map((target) => (
    target.path === 'tests/agent_definition_contracts.rs'
      ? {
          ...target,
          leaves: ['tests/agent_definition_contracts/prompt_contracts.rs'],
        }
      : target
  ));
  const missingReviewedLeafErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    expectedTargets: reviewedLeafTargets,
    leafRustFiles: [],
    leafSources: new Map(),
  });
  if (!missingReviewedLeafErrors.some((error) => error.includes('grouped test leaves'))) {
    throw new Error('explicit integration-test topology must reject a removed reviewed leaf');
  }
  for (const requiredFeaturesDeclaration of [
    'required-features = [\n  "opt-in",\n]',
    '"required\\u002dfeatures" = ["opt-in"]',
  ]) {
    const unexpectedRequiredFeaturesErrors = validateExplicitIntegrationTestTopology({
      ...explicitTestFixture,
      expectedTargets: reviewedLeafTargets,
      manifestText: explicitTestManifest.replace(
        'required-features = ["agent-runtime"]',
        requiredFeaturesDeclaration,
      ),
    });
    if (!unexpectedRequiredFeaturesErrors.some((error) => error.includes('required-features'))) {
      throw new Error(`ungated explicit test topology accepted: ${requiredFeaturesDeclaration}`);
    }
  }
  const independentRequiredFeaturesErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    expectedTargets: reviewedLeafTargets.map((target) => (
      target.path === 'tests/native_hook_execution_contracts.rs'
        ? { ...target, requiredFeatures: ['native-hooks'] }
        : target
    )),
    manifestText: explicitTestManifest.replace(
      'required-features = ["native-hook-runtime"]',
      'required-features = ["native-hooks"]',
    ),
  });
  if (independentRequiredFeaturesErrors.length > 0) {
    throw new Error(
      `target-scoped required-features contract rejected an independent target: ${independentRequiredFeaturesErrors.join('; ')}`,
    );
  }
  const reviewedLeafCfgFixture = {
    ...explicitTestFixture,
    leafSources: new Map([[
      'tests/agent_definition_contracts/prompt_contracts.rs',
      '#![cfg(not(feature = "reviewed-negative"))]\n',
    ]]),
    allowedLeafCfgLines: new Map([[
      'tests/agent_definition_contracts/prompt_contracts.rs',
      '#![cfg(not(feature = "reviewed-negative"))]',
    ]]),
  };
  const reviewedLeafCfgErrors = validateExplicitIntegrationTestTopology(
    reviewedLeafCfgFixture,
  );
  if (reviewedLeafCfgErrors.length > 0) {
    throw new Error(
      `grouped test topology rejected an exact reviewed leaf cfg: ${reviewedLeafCfgErrors.join('; ')}`,
    );
  }
  const extraLeafCfgErrors = validateExplicitIntegrationTestTopology({
    ...reviewedLeafCfgFixture,
    leafSources: new Map([[
      'tests/agent_definition_contracts/prompt_contracts.rs',
      '#![cfg(not(feature = "reviewed-negative"))]\n#![cfg(not(feature = "unrelated-feature"))]\n',
    ]]),
  });
  if (!extraLeafCfgErrors.some((error) => error.includes('belongs in its explicit target root'))) {
    throw new Error('grouped test topology must reject extra cfg lines on a reviewed leaf');
  }
  const wrongSectionErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    manifestText: explicitTestManifest.replace(
      '[package]\nautotests = false',
      '[package]\n[package.metadata.test-topology]\nautotests = false',
    ),
  });
  if (!wrongSectionErrors.some((error) => error.includes('[package]'))) {
    throw new Error('explicit integration-test topology must read autotests from [package] only');
  }
  const commentedReferenceErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    rootSources: new Map([
      ...explicitTestRoots,
      [
        'tests/agent_definition_contracts.rs',
        '/*\n#[path = "agent_definition_contracts/prompt_contracts.rs"]\nmod prompt_contracts;\n*/',
      ],
    ]),
  });
  if (!commentedReferenceErrors.some((error) => error.includes('prompt_contracts.rs'))) {
    throw new Error('explicit integration-test topology must reject a commented-out leaf reference');
  }
  const duplicateReferenceErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    rootSources: new Map([
      ...explicitTestRoots,
      [
        'tests/agent_definition_contracts.rs',
        `${explicitTestRoots.get('tests/agent_definition_contracts.rs')}\n${explicitTestRoots.get('tests/agent_definition_contracts.rs')}`,
      ],
    ]),
  });
  if (!duplicateReferenceErrors.some((error) => error.includes('found 2'))) {
    throw new Error('explicit integration-test topology must reject a duplicate leaf reference');
  }
  const unexpectedRootErrors = validateExplicitIntegrationTestTopology({
    ...explicitTestFixture,
    topLevelRustFiles: [...explicitTestFixture.topLevelRustFiles, 'tests/unregistered.rs'],
  });
  if (!unexpectedRootErrors.some((error) => error.includes('top-level test roots'))) {
    throw new Error('explicit integration-test topology must reject an unregistered test root');
  }

  const parsedDeps = parseManifestDependencies([
    '[dependencies]',
    'reqwest = { workspace = true, optional = true }',
    'dirs = { workspace = true }',
    'rmcp = { version = "0.12.0", default-features = false, features = [',
    '    "auth",',
    '], optional = true }',
    'openbitfun-core = { path = "../core", default-features = false, features = ["product-full"] }',
    'single-quoted-opencode = { package = \'openbitfun-opencode-adapter\', path = "../adapters/opencode-adapter" }',
    '[dependencies.git2]',
    'workspace = true',
    'optional = true',
    '[target.\'cfg(windows)\'.dependencies."openbitfun-cli"]',
    'path = "../../apps/cli"',
    '[dependencies.renamed-opencode]',
    'package = "openbitfun-opencode-adapter"',
    'path = "../adapters/opencode-adapter"',
    '[features]',
    'image = []',
  ]);
  const parsedByName = new Map(parsedDeps.map((dep) => [dep.name, dep]));
  if (parsedByName.get('reqwest')?.optional !== true) {
    throw new Error('dependency profile parser must detect inline optional dependencies');
  }
  if (parsedByName.get('dirs')?.optional !== false) {
    throw new Error('dependency profile parser must detect non-optional inline dependencies');
  }
  if (parsedByName.get('rmcp')?.optional !== true) {
    throw new Error('dependency profile parser must detect multiline optional inline dependencies');
  }
  if (parsedByName.get('git2')?.optional !== true) {
    throw new Error('dependency profile parser must detect optional dependency tables');
  }
  if (parsedByName.get('openbitfun-cli')?.optional !== false) {
    throw new Error('dependency profile parser must detect non-optional target dependency tables');
  }
  if (parsedByName.get('renamed-opencode')?.optional !== false) {
    throw new Error('dependency profile parser must detect renamed dependency tables');
  }
  if (
    !manifestDependencyMatches(
      parsedByName.get('single-quoted-opencode'),
      'openbitfun-opencode-adapter',
    )
  ) {
    throw new Error('dependency profile parser must detect single-quoted package aliases');
  }
  if (parsedByName.has('image')) {
    throw new Error('dependency profile parser must ignore feature entries named like dependencies');
  }
  const parsedWorkspaceDeps = parseManifestDependencies(
    [
      '[workspace.dependencies]',
      'opencode-fixture = { path = "src/crates/adapters/opencode-adapter", package = "openbitfun-opencode-adapter" }',
      'opencode-fixture-single = { path = "src/crates/adapters/opencode-adapter", package = \'openbitfun-opencode-adapter\' }',
      '[workspace.dependencies.renamed-opencode-workspace]',
      'package = "openbitfun-opencode-adapter"',
      'path = "src/crates/adapters/opencode-adapter"',
    ],
    { includeWorkspace: true },
  );
  const workspaceDepsByName = new Map(parsedWorkspaceDeps.map((dep) => [dep.name, dep]));
  if (
    !manifestDependencyMatches(
      workspaceDepsByName.get('opencode-fixture'),
      'openbitfun-opencode-adapter',
    ) ||
    !manifestDependencyMatches(
      workspaceDepsByName.get('opencode-fixture-single'),
      'openbitfun-opencode-adapter',
    ) ||
    !manifestDependencyMatches(
      workspaceDepsByName.get('renamed-opencode-workspace'),
      'openbitfun-opencode-adapter',
    )
  ) {
    throw new Error('manifest parser must detect workspace aliases to forbidden packages');
  }
  const aliasedRuntimeDependency = parseManifestDependencies([
    '[dependencies]',
    'runtime = { package = "openbitfun-agent-runtime", path = "../../execution/agent-runtime" }',
  ])[0];
  if (
    matchingForbiddenDependency(aliasedRuntimeDependency, ['openbitfun-agent-runtime']) !==
    'openbitfun-agent-runtime'
  ) {
    throw new Error('forbidden dependency checks must reject Cargo package aliases');
  }

  for (const featureName of [
    'agent-runtime',
    'diagnostics',
    'diff',
    'announcement',
    'canvas-runtime',
    'dispatch-store',
    'file-watch',
    'filesystem',
    'git',
    'i18n-runtime',
    'local-storage',
    'process-runtime',
    'external-sources',
    'plugin-runtime',
    'remote-workspace',
    'review-platform',
    'ssh-remote',
    'terminal',
    'workspace-runtime',
    'workspace-watch',
    'product-capabilities',
    'function-agents',
    'tool-packs',
  ]) {
    if (!coreProductFullFeatureAssemblyRule.requiredFeatureRefs.includes(featureName)) {
      throw new Error(`core product-full assembly rule must require ${featureName}`);
    }
  }
  const closedProfileKey = (manifestPath, featureName) => `${manifestPath}:${featureName}`;
  const closedCoreProfiles = new Map(
    coreClosedFeatureProfileRules.map((rule) => [
      closedProfileKey(rule.manifestPath, rule.featureName),
      rule,
    ]),
  );
  const coreManifest = 'src/crates/assembly/core/Cargo.toml';
  const servicesCoreManifest = 'src/crates/services/services-core/Cargo.toml';
  const expectedClosedCoreProfiles = [
    [coreManifest, 'default', []],
    [coreManifest, 'i18n-runtime', ['dep:fluent-bundle', 'dep:unic-langid']],
    [coreManifest, 'diagnostics', ['openbitfun-services-core/diagnostics']],
    [coreManifest, 'diff', ['openbitfun-services-core/diff']],
    [servicesCoreManifest, 'default', []],
    [servicesCoreManifest, 'diagnostics', ['dep:regex']],
    [
      servicesCoreManifest,
      'diff',
      ['dep:similar', 'dep:tokio', 'tokio/rt', 'tokio/time'],
    ],
    [
      servicesCoreManifest,
      'filesystem',
      [
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
      ],
    ],
    [servicesCoreManifest, 'product-identity', ['dep:openbitfun-core-types']],
    [servicesCoreManifest, 'memory-store', ['dep:rusqlite']],
    [
      servicesCoreManifest,
      'local-storage',
      [
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
      ],
    ],
    [
      servicesCoreManifest,
      'process-runtime',
      [
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
      ],
    ],
    [
      servicesCoreManifest,
      'workspace-instructions',
      [
        'dep:globset',
        'dep:regex',
        'dep:serde_yaml',
        'dep:tokio',
        'tokio/fs',
        'tokio/io-util',
        'tokio/rt',
      ],
    ],
    [
      servicesCoreManifest,
      'workspace-text-runtime',
      ['dep:tokio', 'tokio/rt'],
    ],
    [
      servicesCoreManifest,
      'workspace-runtime',
      [
        'dep:anyhow',
        'dep:async-trait',
        'dep:openbitfun-runtime-ports',
        'openbitfun-runtime-ports/runtime-event-port',
        'openbitfun-runtime-ports/workspace-ports',
        'dep:dunce',
        // WorkspaceFS metadata restoration is implemented by the local provider.
        'dep:filetime',
        'process-runtime',
        'tokio/fs',
        'tokio/io-util',
        'tokio/sync',
      ],
    ],
    [servicesCoreManifest, 'session-git', ['local-storage', 'dep:git2']],
    [
      servicesCoreManifest,
      'token-usage-statistics',
      ['local-storage', 'dep:chrono-tz'],
    ],
    [servicesCoreManifest, 'workspace-identity', ['dep:dunce', 'dep:sha2']],
    [
      coreManifest,
      'dispatch-store',
      ['dep:base64', 'local-storage', 'openbitfun-services-core/dispatch-workspace'],
    ],
    [coreManifest, 'filesystem', ['openbitfun-services-core/filesystem']],
    [
      coreManifest,
      'local-storage',
      ['dep:openbitfun-agent-tools', 'openbitfun-services-core/local-storage'],
    ],
    [coreManifest, 'process-runtime', ['openbitfun-services-core/process-runtime']],
    [coreManifest, 'terminal', ['dep:terminal-core']],
    [
      coreManifest,
      'workspace-runtime',
      [
        'dep:serde_yaml',
        'filesystem',
        'local-storage',
        'process-runtime',
        'openbitfun-services-core/markdown',
        'openbitfun-services-core/workspace-identity',
        'openbitfun-services-core/workspace-instructions',
        'openbitfun-services-core/workspace-runtime',
        'openbitfun-services-core/workspace-persistence',
      ],
    ],
    [coreManifest, 'workspace-watch', ['workspace-runtime', 'dep:notify']],
    [
      coreManifest,
      'remote-workspace',
      [
        'workspace-runtime',
        'dep:openbitfun-services-integrations',
        'openbitfun-services-integrations/remote-ssh',
      ],
    ],
    [
      coreManifest,
      'canvas-runtime',
      ['dep:openbitfun-product-domains', 'openbitfun-services-integrations/canvas-runtime'],
    ],
    [coreManifest, 'announcement', ['openbitfun-services-integrations/announcement']],
    [coreManifest, 'file-watch', ['openbitfun-services-integrations/file-watch']],
    [coreManifest, 'git', ['openbitfun-services-integrations/git']],
    [coreManifest, 'review-platform', ['openbitfun-services-integrations/review-platform']],
    [coreManifest, 'service-integrations', ['announcement', 'file-watch', 'git', 'review-platform']],
    [
      coreManifest,
      'ssh-remote',
      ['remote-workspace', 'openbitfun-services-integrations/remote-ssh-concrete'],
    ],
  ];
  for (const [manifestPath, featureName, expectedReferences] of expectedClosedCoreProfiles) {
    const rule = closedCoreProfiles.get(closedProfileKey(manifestPath, featureName));
    if (!rule?.exact) {
      throw new Error(`core closed feature profile must cover ${featureName} exactly`);
    }
    if (
      rule.requiredFeatureRefs.length !== expectedReferences.length
      || expectedReferences.some((reference) => !rule.requiredFeatureRefs.includes(reference))
    ) {
      throw new Error(`core closed feature profile has stale references for ${featureName}`);
    }
    if (rule.requiredFeatureRefs.some((reference) => reference.includes('product-full'))) {
      throw new Error(`core closed feature profile must not hide product-full in ${featureName}`);
    }
    if (
      (rule.allowedTransitiveFeatureRefs ?? [])
        .some((reference) => reference.includes('product-full'))
    ) {
      throw new Error(`core closed feature profile must not reach product-full in ${featureName}`);
    }
  }
  const acpProfiles = new Map(
    acpClosedFeatureProfileRules.map((rule) => [rule.featureName, rule]),
  );
  const expectedAcpProfiles = new Map([
    ['default', ['client', 'server']],
    [
      'client',
      [
        'openbitfun-agent-tools/acp-bridge',
        'dep:futures',
        'dep:serde',
        // The bundled DeepSeek Harness profile the ACP client materializes:
        // $DSH_HOME lookup, a minimum-version comparison, and packing the
        // profile for a remote host.
        'dep:dirs',
        'dep:semver',
        'dep:tar',
        'dep:openbitfun-core',
        'openbitfun-core/agent-runtime',
        'openbitfun-core/ssh-remote',
      ],
    ],
    [
      'server',
      [
        'dep:openbitfun-agent-tools',
        'dep:openbitfun-agent-runtime',
        'openbitfun-agent-runtime/agent-runtime',
        'dep:openbitfun-core-types',
        'dep:openbitfun-core',
        'dep:sha2',
        'openbitfun-core/agent-runtime',
        'openbitfun-core/document-read',
        'openbitfun-core/subscription-auth',
        'openbitfun-core/external-sources',
        'openbitfun-core/tools-basic',
        'openbitfun-core/tools-git',
        'openbitfun-core/tools-mcp',
        'openbitfun-core/tools-browser-web',
        'openbitfun-core/tools-computer-use',
        'openbitfun-core/tools-image-analysis',
        'openbitfun-core/tools-agent-control',
      ],
    ],
  ]);
  for (const [featureName, expectedReferences] of expectedAcpProfiles) {
    const rule = acpProfiles.get(featureName);
    if (!rule?.exact) {
      throw new Error(`ACP closed feature profile must cover ${featureName} exactly`);
    }
    if (
      rule.requiredFeatureRefs.length !== expectedReferences.length
      || expectedReferences.some((reference) => !rule.requiredFeatureRefs.includes(reference))
    ) {
      throw new Error(`ACP closed feature profile has stale references for ${featureName}`);
    }
    if (rule.requiredFeatureRefs.some((reference) => reference.includes('product-full'))) {
      throw new Error(`ACP closed feature profile must not reach product-full in ${featureName}`);
    }
  }
  const ownerFeatureRulePaths = new Set(
    ownerCrateFeatureAssemblyRules.map((rule) => rule.manifestPath),
  );
  for (const manifestPath of [
    'src/crates/execution/tool-provider-groups/Cargo.toml',
    'src/crates/services/services-integrations/Cargo.toml',
    'src/crates/contracts/product-domains/Cargo.toml',
  ]) {
    if (!ownerFeatureRulePaths.has(manifestPath)) {
      throw new Error(`owner crate feature assembly rule must cover ${manifestPath}`);
    }
  }
  for (const rule of ownerCrateFeatureAssemblyRules) {
    const declaredFeatures = new Set(rule.requiredProductFullFeatures);
    if (declaredFeatures.size !== rule.requiredProductFullFeatures.length) {
      throw new Error(`${rule.manifestPath} product-full guard must not duplicate feature groups`);
    }
    if (rule.requiredProductFullFeatures.some((featureName) => featureName.startsWith('dep:'))) {
      throw new Error(`${rule.manifestPath} product-full guard must track owner feature groups only`);
    }
  }

  const parsedFeatures = parseManifestFeatures([
    '[package]',
    'name = "example"',
    '[features]',
    'default = ["product-full"]',
    'product-full = [',
    '    "dep:tool-runtime",',
    '    "announcement",',
    '    "file-watch",',
    '    "git",',
    '    "review-platform",',
    ']',
    'announcement = ["openbitfun-services-integrations/announcement"]',
    'file-watch = ["openbitfun-services-integrations/file-watch"]',
    'git = ["openbitfun-services-integrations/git"]',
    'review-platform = ["openbitfun-services-integrations/review-platform"]',
    'service-integrations = ["announcement", "file-watch", "git", "review-platform"]',
    'workspace-runtime = ["dep:serde_yaml", "openbitfun-services-core/workspace-runtime"]',
    'remote-workspace = [',
    '    "workspace-runtime",',
    '    "dep:openbitfun-services-integrations",',
    '    "openbitfun-services-integrations/remote-ssh",',
    ']',
    'ssh-remote = [',
    '    "remote-workspace",',
    '    "openbitfun-services-integrations/remote-ssh-concrete",',
    ']',
    '[dependencies]',
    'git2 = { workspace = true, optional = true }',
  ]);
  if (!parsedFeatures.get('default')?.refs.includes('product-full')) {
    throw new Error('feature parser must detect inline feature references');
  }
  if (!parsedFeatures.get('product-full')?.refs.includes('dep:tool-runtime')) {
    throw new Error('feature parser must detect multiline dependency feature references');
  }
  if (!parsedFeatures.get('service-integrations')?.refs.includes('git')) {
    throw new Error('feature parser must detect inline dependency feature references');
  }
  if (
    !parsedFeatures
      .get('ssh-remote')
      ?.refs.includes('openbitfun-services-integrations/remote-ssh-concrete')
  ) {
    throw new Error('feature parser must detect dependency capability feature references');
  }
  if (!parsedFeatures.get('ssh-remote')?.refs.includes('remote-workspace')) {
    throw new Error('feature parser must detect local capability feature references');
  }

  const acceptsGitFacadeLine = createFacadeLineChecker('openbitfun_services_integrations::git');
  const facadePositiveCases = [
    '',
    '//! Compatibility facade.',
    'pub use openbitfun_services_integrations::git::GitService;',
    'pub use openbitfun_services_integrations::git::types::*;',
    'pub use openbitfun_services_integrations::git::{',
    '    build_git_graph, build_git_graph_for_branch,',
    '};',
    'pub use openbitfun_services_integrations::git::{build_git_graph, build_git_graph_for_branch};',
  ];
  for (const line of facadePositiveCases) {
    if (!acceptsGitFacadeLine(line)) {
      throw new Error(`facade parser rejected allowed line: ${line}`);
    }
  }

  const rejectsGitImplementationLine = createFacadeLineChecker('openbitfun_services_integrations::git');
  const facadeNegativeCases = [
    'pub mod service;',
    'use openbitfun_services_integrations::git::GitService;',
    'fn parse_git_status() {}',
  ];
  for (const line of facadeNegativeCases) {
    if (rejectsGitImplementationLine(line)) {
      throw new Error(`facade parser accepted implementation line: ${line}`);
    }
  }

  const cliBoundaryDeps = ['openbitfun-cli', 'ratatui', 'crossterm', 'arboard', 'syntect-tui'];
  const lightweightBoundaryCrateNames = lightweightBoundaryRules.map((rule) => rule.crateName);
  if (new Set(lightweightBoundaryCrateNames).size !== lightweightBoundaryCrateNames.length) {
    throw new Error('lightweight boundary rules must not duplicate crate names');
  }
  for (const rule of lightweightBoundaryRules) {
    for (const dep of cliBoundaryDeps) {
      if (!rule.forbiddenDeps.includes(dep)) {
        throw new Error(
          `lightweight boundary rule for ${rule.crateName} must forbid CLI-only dependency: ${dep}`,
        );
      }
    }
  }

  const agentToolsRule = lightweightBoundaryRules.find((rule) => rule.crateName === 'agent-tools');
  if (!agentToolsRule?.forbiddenDeps.includes('openbitfun-ai-adapters')) {
    throw new Error('agent-tools lightweight boundary must forbid openbitfun-ai-adapters');
  }
  const coreToolFrameworkRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/framework.rs',
  );
  if (!coreToolFrameworkRuleText) {
    throw new Error('missing core tool framework boundary rule');
  }
  const coreToolFrameworkContracts = [
    'DynamicMcpToolInfo',
    'DynamicToolInfo',
    'ToolRenderOptions',
    'ToolPathBackend',
    'ToolPathResolution',
    'get_global_coordinator',
    'GitService',
    'get_workspace_runtime_service_arc',
    'remote_workspace_runtime_root',
    'get_path_manager_arc',
    'post_call_hooks::record_successful_tool_call',
  ];
  for (const contract of coreToolFrameworkContracts) {
    if (!coreToolFrameworkRuleText.includes(contract)) {
      throw new Error(`core tool framework boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreToolRestrictionRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/restrictions.rs',
  );
  if (!coreToolRestrictionRuleText) {
    throw new Error('missing core tool restrictions boundary rule');
  }
  const coreToolRestrictionContracts = [
    'ToolPathOperation',
    'ToolPathPolicy',
    'ToolRuntimeRestrictions',
    'normalize_absolute_posix_path',
  ];
  for (const contract of coreToolRestrictionContracts) {
    if (!coreToolRestrictionRuleText.includes(contract)) {
      throw new Error(`core tool restrictions boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreDeepReviewTaskAdapterRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/deep_review/task_adapter.rs',
  );
  if (!coreDeepReviewTaskAdapterRuleText) {
    throw new Error('missing core DeepReview task adapter boundary rule');
  }
  const coreDeepReviewTaskAdapterContracts = [
    'QueueWaitTimer',
    'decide_provider_capacity_queue_step',
    'decide_blocked_reviewer_admission_queue_step',
    '<partial_result status=',
    'completed successfully with result:',
    'Retries used:',
    'DeepReview automatic retry elapsed guard exceeded',
    'cancelled coverage',
  ];
  for (const contract of coreDeepReviewTaskAdapterContracts) {
    if (!coreDeepReviewTaskAdapterRuleText.includes(contract)) {
      throw new Error(`core DeepReview task adapter boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreTaskToolRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
  );
  if (!coreTaskToolRuleText) {
    throw new Error('missing core TaskTool DeepReview boundary rule');
  }
  const coreTaskToolContracts = [
    '<partial_result status=',
    'completed successfully with result:',
    'Retries used:',
    'DeepReview automatic retry elapsed guard exceeded',
    'cancelled coverage',
    'provider_capacity_retry_attempts',
    'provider_capacity_queue_elapsed_ms',
    'DEEP_REVIEW_PROVIDER_CAPACITY_MAX_RETRY_ATTEMPTS',
  ];
  for (const contract of coreTaskToolContracts) {
    if (!coreTaskToolRuleText.includes(contract)) {
      throw new Error(`core TaskTool DeepReview boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreCodeReviewToolRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/code_review_tool.rs',
  );
  if (!coreCodeReviewToolRuleText) {
    throw new Error('missing core CodeReviewTool DeepReview report boundary rule');
  }
  if (!coreCodeReviewToolRuleText.includes('"kind"')) {
    throw new Error('core CodeReviewTool DeepReview boundary rule must be anchored to kind');
  }
  for (const contract of ['"cache_hit"', '"cache_miss"']) {
    if (!coreCodeReviewToolRuleText.includes(contract)) {
      throw new Error(
        `core CodeReviewTool DeepReview boundary rule must forbid contract: ${contract}`,
      );
    }
  }
  for (const contract of ['DeepReviewIncrementalCache', 'deepReviewCache']) {
    if (!coreTaskToolRuleText.includes(contract)) {
      throw new Error(`core TaskTool DeepReview boundary rule must forbid contract: ${contract}`);
    }
  }
  const agentToolsFrameworkRule = requiredContentRules.find(
    (rule) => rule.path === 'src/crates/execution/tool-contracts/src/framework.rs',
  );
  if (!agentToolsFrameworkRule) {
    throw new Error('missing agent-tools framework boundary rule');
  }
  const agentToolsFrameworkContracts = [
    'is_tool_path_allowed_by_resolved_roots',
    'build_tool_path_policy_denial_message',
    'resolve_tool_path_with_context',
    'tool_path_is_effectively_absolute',
    'build_tool_runtime_artifact_reference',
    'build_tool_session_runtime_artifact_reference',
  ];
  const agentToolsFrameworkRuleText = agentToolsFrameworkRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of agentToolsFrameworkContracts) {
    if (!agentToolsFrameworkRuleText.includes(contract)) {
      throw new Error(`agent-tools framework boundary rule must require contract: ${contract}`);
    }
  }
  const coreWorkspacePathRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/workspace_paths.rs',
  );
  if (!coreWorkspacePathRuleText) {
    throw new Error('missing core workspace path boundary rule');
  }
  const coreWorkspacePathContracts = [
    'OPENBITFUN_RUNTIME_URI_PREFIX',
    'ParsedOpenBitFunRuntimeUri',
    'posix_normalize_components',
    'Component::ParentDir',
  ];
  for (const contract of coreWorkspacePathContracts) {
    if (!coreWorkspacePathRuleText.includes(contract)) {
      throw new Error(`core workspace path boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreToolRegistryRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/registry.rs',
  );
  if (!coreToolRegistryRuleText) {
    throw new Error('missing core tool registry boundary rule');
  }
  const coreToolRegistryContracts = [
    'DynamicToolMetadata',
    'tools\\s*:\\s*IndexMap',
    'dynamic_tools\\s*:\\s*IndexMap',
  ];
  for (const contract of coreToolRegistryContracts) {
    if (!coreToolRegistryRuleText.includes(contract)) {
      throw new Error(`core tool registry boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreSubagentRuntimeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/subagent_runtime/mod.rs',
  );
  if (!coreSubagentRuntimeRuleText) {
    throw new Error('missing core subagent runtime boundary rule');
  }
  for (const contract of ['DelegationPolicy', 'SubagentContextMode']) {
    if (!coreSubagentRuntimeRuleText.includes(contract)) {
      throw new Error(`core subagent runtime boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreCoordinatorRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
  );
  if (!coreCoordinatorRuleText) {
    throw new Error('missing core coordinator boundary rule');
  }
  if (!coreCoordinatorRuleText.includes('DialogTriggerSource')) {
    throw new Error('core coordinator boundary rule must forbid DialogTriggerSource redefinition');
  }
  const coreSchedulerRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
  );
  if (!coreSchedulerRuleText) {
    throw new Error('missing core scheduler boundary rule');
  }
  for (const contract of [
    'DialogQueuePriority',
    'DialogSubmissionPolicy',
    'DialogSubmitOutcome',
    'AgentSessionReplyRoute',
    'DialogSteerOutcome',
  ]) {
    if (!coreSchedulerRuleText.includes(contract)) {
      throw new Error(`core scheduler boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreSessionStateManagerRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/coordination/state_manager.rs',
  );
  if (!coreSessionStateManagerRuleText) {
    throw new Error('missing core session state manager boundary rule');
  }
  for (const contract of ['SessionStateManager', 'DashMap', 'AgenticEvent::SessionStateChanged']) {
    if (!coreSessionStateManagerRuleText.includes(contract)) {
      throw new Error(`core session state manager boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreRoundPreemptRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/round_preempt.rs',
  );
  if (!coreRoundPreemptRuleText) {
    throw new Error('missing core round preempt boundary rule');
  }
  for (const contract of [
    'RoundInjection',
    'DialogRoundInjectionSource',
    'RoundInjectionKind',
    'RoundInjectionTarget',
  ]) {
    if (!coreRoundPreemptRuleText.includes(contract)) {
      throw new Error(`core round preempt boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreGoalModeTypesRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/goal_mode/mod.rs',
  );
  if (!coreGoalModeTypesRuleText) {
    throw new Error('missing core goal mode types boundary rule');
  }
  for (const contract of [
    'GOAL_MODE_METADATA_KEY',
    'MAX_GOAL_CONTINUATIONS',
    'ThreadGoal',
    'ThreadGoalStatus',
    'ThreadGoalToolResponse',
    'ThreadGoalRuntime',
    'build_thread_goal_continuation_plan',
    'goal_tool_response',
  ]) {
    if (!coreGoalModeTypesRuleText.includes(contract)) {
      throw new Error(`core goal mode types boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreMessageRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/core/message.rs',
  );
  if (!coreMessageRuleText) {
    throw new Error('missing core message boundary rule');
  }
  for (const contract of ['CompressionContract', 'CompressionContractItem']) {
    if (!coreMessageRuleText.includes(contract)) {
      throw new Error(`core message boundary rule must forbid contract: ${contract}`);
    }
  }
  const coreWorkspaceRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/service/workspace/manager.rs',
  );
  if (!coreWorkspaceRuleText) {
    throw new Error('missing core workspace manager boundary rule');
  }
  if (!coreWorkspaceRuleText.includes('RelatedPath')) {
    throw new Error('core workspace manager boundary rule must forbid contract: RelatedPath');
  }
  const coreSubagentRuntimeOwnerPathRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src'
      && rule.reason.includes('owner path for portable subagent contracts'),
  );
  if (!coreSubagentRuntimeOwnerPathRule) {
    throw new Error('missing core subagent runtime owner-path boundary rule');
  }
  const coreSubagentRuntimeOwnerPathRuleText = coreSubagentRuntimeOwnerPathRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of ['DelegationPolicy', 'SubagentContextMode']) {
    if (!coreSubagentRuntimeOwnerPathRuleText.includes(contract)) {
      throw new Error(
        `core subagent runtime owner-path rule must forbid compatibility import: ${contract}`,
      );
    }
  }

  const productDomainProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'product-domains',
  );
  for (const dep of ['dirs', 'log', 'sha2', 'which']) {
    if (!productDomainProfile?.forbiddenNonOptionalDeps.includes(dep)) {
      throw new Error(`product-domains default profile must forbid non-optional ${dep}`);
    }
  }
  const servicesIntegrationsDefaultProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'services-integrations',
  );
  if (!servicesIntegrationsDefaultProfile?.forbiddenNonOptionalDeps.includes('uuid')) {
    throw new Error('services-integrations default profile must forbid non-optional uuid');
  }
  const coreProfile = dependencyProfileRules.find((rule) => rule.crateName === 'core');
  for (const dep of [
    'git2',
    'rmcp',
    'image',
    'tool-runtime',
    'rustls',
    'rustls-native-certs',
    'schannel',
    'win32job',
    'openbitfun-relay-service',
    'openbitfun-transport',
    'htmd',
    'legible',
    'readability-js',
  ]) {
    if (!coreProfile?.forbiddenNonOptionalDeps.includes(dep)) {
      throw new Error(`core no-default profile must forbid non-optional ${dep}`);
    }
  }
  const coreOptionalOwnerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'core',
  );
  const coreOptionalOwnerDeps = new Set(
    coreOptionalOwnerRule?.dependencies.map((dependency) => dependency.depName) ?? [],
  );
  const coreFullyMigratedDeps = new Set([
    'aes',
    'aes-gcm',
    'openbitfun-relay-service',
    'openbitfun-transport',
    'eventsource-stream',
    'git2',
    'glob',
    'globset',
    'hostname',
    'htmd',
    'legible',
    'local-ip-address',
    'mac_address',
    'qrcode',
    'rand',
    'readability-js',
    'rmcp',
    'russh',
    'rustls',
    'rustls-native-certs',
    'schannel',
    'sse-stream',
    'win32job',
    'x25519-dalek',
  ]);
  for (const dep of coreProfile?.forbiddenNonOptionalDeps ?? []) {
    if (coreFullyMigratedDeps.has(dep)) {
      continue;
    }
    if (!coreOptionalOwnerDeps.has(dep)) {
      throw new Error(`core optional dependency owner rule must cover forbidden dependency ${dep}`);
    }
  }
  for (const dep of ['image', 'tool-runtime']) {
    if (!coreOptionalOwnerDeps.has(dep)) {
      throw new Error(`core optional dependency owner rule must cover ${dep}`);
    }
  }
  const servicesOptionalOwnerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'services-integrations',
  );
  const servicesCoreOptionalOwnerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'services-core',
  );
  const servicesCoreDunceOwner = servicesCoreOptionalOwnerRule?.dependencies.find(
    (dependency) => dependency.depName === 'dunce',
  );
  for (const feature of ['runtime-ownership', 'workspace-identity', 'workspace-runtime']) {
    if (!servicesCoreDunceOwner?.ownerFeatures.includes(feature)) {
      throw new Error(`services-core ${feature} must own optional dependency dunce`);
    }
  }
  const expectedServicesCoreOwners = new Map([
    ['base64', ['filesystem']],
    ['openbitfun-core-types', ['filesystem', 'local-storage', 'product-identity']],
    ['openbitfun-events', ['local-storage']],
    ['chrono', ['filesystem', 'local-storage']],
    ['chrono-tz', ['token-usage-statistics']],
    ['fs2', ['json-io', 'local-storage', 'runtime-ownership']],
    ['git2', ['session-git']],
    ['globset', ['workspace-instructions']],
    ['ignore', ['filesystem']],
    ['libc', ['local-storage', 'process-runtime']],
    [
      'regex',
      ['diagnostics', 'filesystem', 'local-storage', 'markdown', 'workspace-instructions'],
    ],
    ['rusqlite', ['memory-store', 'permission']],
    ['serde_yaml', ['markdown', 'workspace-instructions']],
    ['similar', ['diff', 'local-storage']],
    [
      'sha2',
      [
        'dispatch-workspace',
        'filesystem',
        'local-storage',
        'runtime-ownership',
        'workspace-identity',
      ],
    ],
    ['which', ['process-runtime']],
    ['win32job', ['process-runtime']],
    ['windows', ['json-io', 'local-storage', 'process-runtime']],
    [
      'tokio',
      [
        'diff',
        'filesystem',
        'json-io',
        'local-storage',
        'permission',
        'process-runtime',
        'workspace-instructions',
        'workspace-runtime',
        'workspace-text-runtime',
      ],
    ],
  ]);
  for (const [dependencyName, ownerFeatures] of expectedServicesCoreOwners) {
    const dependency = servicesCoreOptionalOwnerRule?.dependencies.find(
      (candidate) => candidate.depName === dependencyName,
    );
    for (const featureName of ownerFeatures) {
      if (!dependency?.ownerFeatures.includes(featureName)) {
        throw new Error(`services-core ${featureName} must own optional dependency ${dependencyName}`);
      }
    }
  }
  const servicesCoreOptionalOwnerDeps = new Set(
    servicesCoreOptionalOwnerRule?.dependencies.map((dependency) => dependency.depName) ?? [],
  );
  const servicesCoreDefaultProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'services-core',
  );
  for (const dep of servicesCoreDefaultProfile?.forbiddenNonOptionalDeps ?? []) {
    if (!servicesCoreOptionalOwnerDeps.has(dep)) {
      throw new Error(
        `services-core optional dependency owner rule must cover forbidden dependency ${dep}`,
      );
    }
  }
  const servicesOptionalOwnerDeps = new Set(
    servicesOptionalOwnerRule?.dependencies.map((dependency) => dependency.depName) ?? [],
  );
  for (const dep of servicesIntegrationsDefaultProfile?.forbiddenNonOptionalDeps ?? []) {
    if (!servicesOptionalOwnerDeps.has(dep)) {
      throw new Error(
        `services-integrations optional dependency owner rule must cover forbidden dependency ${dep}`,
      );
    }
  }
  for (const dep of [
    'aes',
    'openbitfun-services-core',
    'openbitfun-product-domains',
    'dunce',
    'fs2',
    'openbitfun-runtime-ports',
    'git2',
    'hex',
    'hostname',
    'libc',
    'local-ip-address',
    'mac_address',
    'md5',
    'notify',
    'qrcode',
    'reqwest',
    'rmcp',
    'tokio-tungstenite',
    'which',
    'windows',
    'x25519-dalek',
  ]) {
    if (!servicesOptionalOwnerRule?.dependencies.some((dependency) => dependency.depName === dep)) {
      throw new Error(`services-integrations optional dependency owner rule must cover ${dep}`);
    }
  }
  for (const dep of ['openbitfun-product-domains', 'dunce', 'fs2', 'hex', 'libc', 'sha2', 'thiserror', 'uuid', 'windows']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('plugin-source')) {
      throw new Error(`services-integrations plugin-source must own optional dependency ${dep}`);
    }
  }
  for (const dep of ['aes-gcm', 'anyhow', 'base64', 'hostname', 'openbitfun-services-core', 'rand', 'sha2', 'windows']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('remote-persistence')) {
      throw new Error(`services-integrations remote-persistence must own optional dependency ${dep}`);
    }
  }
  for (const dep of ['openbitfun-product-domains', 'image']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('miniapp-market')) {
      throw new Error(`services-integrations miniapp-market must own optional dependency ${dep}`);
    }
  }
  for (const dep of ['sha2', 'windows']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('review-platform')) {
      throw new Error(`services-integrations review-platform must own optional dependency ${dep}`);
    }
  }
  for (const dep of ['openbitfun-services-core']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('process-tree')) {
      throw new Error(`services-integrations process-tree must delegate to ${dep}`);
    }
  }
  for (const dep of ['async-trait', 'openbitfun-runtime-ports']) {
    const owner = servicesOptionalOwnerRule?.dependencies.find(
      (dependency) => dependency.depName === dep,
    );
    if (!owner?.ownerFeatures.includes('git')) {
      throw new Error(`services-integrations git must own optional dependency ${dep}`);
    }
  }
  const productDomainsOptionalOwnerRule = optionalDependencyFeatureOwnerRules.find(
    (rule) => rule.crateName === 'product-domains',
  );
  for (const dep of ['dirs', 'log', 'sha2']) {
    if (!productDomainsOptionalOwnerRule?.dependencies.some((dependency) => dependency.depName === dep)) {
      throw new Error(`product-domains optional dependency owner rule must cover ${dep}`);
    }
  }
  const coreBrowserLauncherFacadeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/browser_control/browser_launcher.rs',
  );
  for (const contract of ['process_manager::', 'Command::new', 'reqwest::']) {
    if (!coreBrowserLauncherFacadeRuleText.includes(contract)) {
      throw new Error(`core browser launcher facade boundary rule must forbid: ${contract}`);
    }
  }
  const coreReviewPlatformFacadeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/service/review_platform/mod.rs',
  );
  for (const contract of [
    'reqwest::',
    'tokio::fs',
    'process_manager::',
    'execute_git_command',
    'serde_json::',
    'ReviewProvider',
  ]) {
    if (!coreReviewPlatformFacadeRuleText.includes(contract)) {
      throw new Error(`core review platform facade boundary rule must forbid: ${contract}`);
    }
  }
  const coreComputerUseSystemFacadeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/computer_use_actions.rs',
  );
  for (const contract of [
    'process_manager::',
    'tokio::process::',
    'script_invocation',
    'platform_open_attempts',
  ]) {
    if (!coreComputerUseSystemFacadeRuleText.includes(contract)) {
      throw new Error(`core computer-use system facade boundary rule must forbid: ${contract}`);
    }
  }
  const coreLocalShellFacadeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/local_shell.rs',
  );
  for (const contract of ['process_manager::', 'Command::new', 'std::env::var', 'target_os']) {
    if (!coreLocalShellFacadeRuleText.includes(contract)) {
      throw new Error(`core local shell facade boundary rule must forbid: ${contract}`);
    }
  }
  const coreWeixinFacadeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/service/remote_connect/bot/weixin.rs',
  );
  for (const contract of ['reqwest::', 'aes::', 'hex::', 'md5::', 'sync_buf_path']) {
    if (!coreWeixinFacadeRuleText.includes(contract)) {
      throw new Error(`core Weixin bot facade boundary rule must forbid: ${contract}`);
    }
  }
  const productDomainRuntimeRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src',
  );
  if (!productDomainRuntimeRule) {
    throw new Error('missing product-domains runtime-owner boundary rule');
  }
  const productDomainRuntimeContracts = [
    'Command::new\\(',
    'process_manager::',
    'GitService::',
    'reqwest::',
    'tauri::',
  ];
  const productDomainRuntimeRuleText = productDomainRuntimeRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of productDomainRuntimeContracts) {
    if (!productDomainRuntimeRuleText.includes(contract)) {
      throw new Error(`product-domains runtime boundary rule must forbid: ${contract}`);
    }
  }
  const productDomainCommandRule = productDomainRuntimeRule.patterns.find((pattern) =>
    pattern.regex.source.includes('Command::new'),
  );
  if (
    !productDomainCommandRule?.allowPaths?.includes(
      'src/crates/contracts/product-domains/src/miniapp/runtime.rs',
    )
  ) {
    throw new Error('product-domains Command::new exception must stay scoped to MiniApp runtime detection');
  }
  const coreTypesProfile = dependencyProfileRules.find((rule) => rule.crateName === 'core-types');
  if (!coreTypesProfile?.forbiddenNonOptionalDeps.includes('openbitfun-ai-adapters')) {
    throw new Error('core-types dependency profile must forbid ai-adapter dependencies');
  }
  const coreTypesAiRuleText = forbiddenRuleTextForPath(
    'src/crates/contracts/core-types/src/ai.rs',
  );
  for (const contract of ['resolve_request_url', 'chat\\/completions', 'v1\\/messages']) {
    if (!coreTypesAiRuleText.includes(contract)) {
      throw new Error(`core-types AI DTO boundary rule must forbid: ${contract}`);
    }
  }
  const runtimePortsProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'runtime-ports',
  );
  if (!runtimePortsProfile?.forbiddenNonOptionalDeps.includes('openbitfun-services-core')) {
    throw new Error('runtime-ports dependency profile must forbid service implementations');
  }
  const pluginRuntimeContractRule = requiredContentRules.find(
    (rule) => rule.path === 'src/crates/contracts/runtime-ports/src/plugin.rs',
  );
  if (!pluginRuntimeContractRule) {
    throw new Error('plugin runtime contracts must have a module-local owner rule');
  }
  const pluginRuntimeContractRuleText = pluginRuntimeContractRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of [
    'PluginRuntimeClient',
    'PluginRuntimeBinding',
    'read_plugins',
    'PluginQuarantineState',
  ]) {
    if (!pluginRuntimeContractRuleText.includes(contract)) {
      throw new Error(`plugin runtime contract owner rule must require: ${contract}`);
    }
  }
  const pluginRuntimeForbiddenRuleText = forbiddenRuleTextForPath(
    'src/crates/contracts/runtime-ports/src/plugin.rs',
  );
  for (const forbiddenContract of [
    'serde_json::Value',
    'accepted',
    'product-full',
    'requires_permission',
    'permission_prompt',
    'PluginMaterializeCondition',
  ]) {
    if (!pluginRuntimeForbiddenRuleText.includes(forbiddenContract)) {
      throw new Error(`plugin runtime boundary rule must forbid: ${forbiddenContract}`);
    }
  }
  const pluginCapabilityPublicationRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/plugin_capability_publication.rs',
  );
  for (const forbiddenDependency of [
    'OpenCode',
    'DeepSeek',
    'HookFunction',
    'serde_json',
    'openbitfun_[a-z0-9_]+_adapter',
  ]) {
    if (!pluginCapabilityPublicationRuleText.includes(forbiddenDependency)) {
      throw new Error(
        `plugin capability publication boundary must forbid: ${forbiddenDependency}`,
      );
    }
  }
  const pluginPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/runtime-ports/src/plugin.rs',
  );
  const agentRuntimePublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/execution/agent-runtime/src/lib.rs',
  );
  const pluginRootReexportRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/runtime-ports/src/lib.rs',
  );
  const opencodeAdapterPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/adapters/opencode-adapter/src/lib.rs',
  );
  const claudeHookAdapterPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/adapters/claude-code-adapter/src/lib.rs',
  );
  const codexHookAdapterPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/adapters/codex-adapter/src/lib.rs',
  );
  const staticHookSupportPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/adapters/static-hook-support/src/lib.rs',
  );
  const userInstructionSourceServicePublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/services/services-core/src/local_instructions.rs',
  );
  const externalSubagentPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/external_subagents.rs',
  );
  const pluginCapabilityProjectionPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/plugin_capabilities.rs',
  );
  const externalHookPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/external_hook_contributions.rs',
  );
  const externalHookCatalogPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/external_hook_catalog.rs',
  );
  const workspaceReferencePublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/workspace_references.rs',
  );
  const externalSourcePublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/external_sources.rs',
  );
  const externalSourceControlPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/contracts/product-domains/src/external_source_control.rs',
  );
  const externalSourceCoordinatorPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/assembly/external-sources/src/lib.rs',
  );
  const externalSourceCorePublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/external_sources.rs',
  );
  const managedPluginActivationPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/plugin_runtime.rs',
  );
  const parsedPluginReexports = collectPluginRootReexports(`
    pub use plugin::{PluginDispatchEnvelope, PluginResponseEnvelope};
    pub use self::plugin::{
      PluginRuntimeReadRequest,
      PluginRuntimeReadResponse as RuntimeReadResponse,
    };
    pub use crate::plugin::PluginRuntimeClient;
    pub use plugin::*;
  `);
  if (
    parsedPluginReexports.join(',') !==
    'PluginDispatchEnvelope,PluginResponseEnvelope,PluginRuntimeReadRequest,RuntimeReadResponse,PluginRuntimeClient,*'
  ) {
    throw new Error('plugin root re-export parser must collect plugin path variants, aliases, and wildcard markers');
  }
  for (const wildcardReexport of [
    'pub use plugin::*;',
    'pub use crate::plugin::*;',
    'pub use self::plugin::*;',
  ]) {
    if (!hasPluginWildcardReexport(wildcardReexport)) {
      throw new Error(`plugin wildcard guard must reject path variant: ${wildcardReexport}`);
    }
  }
  for (const nonWildcardReexport of [
    'pub use plugin::PluginDispatchEnvelope;',
    'pub use crate::not_plugin::*;',
  ]) {
    if (hasPluginWildcardReexport(nonWildcardReexport)) {
      throw new Error(`plugin wildcard guard must not reject non-plugin wildcard: ${nonWildcardReexport}`);
    }
  }
  const parsedPluginSymbols = collectTopLevelRustPublicSymbols(`
    pub enum TopLevelEnum { Value }
    impl TopLevelEnum { pub fn hidden_method(&self) {} }
    pub use plugin::PluginDispatchEnvelope;
    pub use crate::hidden::{HiddenType, InternalName as PublicName};
    pub use crate::multi::{
      MultiLineType,
      InternalMultiLine as PublicMultiLine,
    };
    pub mod host;
    pub const CONTRACT_VERSION: u16 = 1;
  `);
  if (
    parsedPluginSymbols.join(',') !==
    'TopLevelEnum,PluginDispatchEnvelope,HiddenType,PublicName,MultiLineType,PublicMultiLine,host,CONTRACT_VERSION'
  ) {
    throw new Error('public API parser must collect top-level items and re-exports without impl methods');
  }
  const parsedAgentRuntimeModules = collectTopLevelRustPublicSymbols(`
    #[cfg(feature = "agent-runtime")]
    pub mod agents;
    pub mod accidental_feature_free_api;
  `);
  if (!agentRuntimePublicApiRule?.allowedSymbols?.includes('agents')) {
    throw new Error('Agent Runtime public API allowlist must include reviewed owner modules');
  }
  if (
    !parsedAgentRuntimeModules.includes('accidental_feature_free_api') ||
    agentRuntimePublicApiRule.allowedSymbols.includes('accidental_feature_free_api')
  ) {
    throw new Error('Agent Runtime public API allowlist must reject an unreviewed feature-free module');
  }
  const parsedExternalSubagentIds = collectTopLevelRustPublicSymbols(`
    external_subagent_id!(ExternalSubagentLocalId, "local");
    external_subagent_id!(
      ExternalSubagentBehaviorVersion,
      "behavior"
    );
    pub struct SecretText(String);
  `);
  if (parsedExternalSubagentIds.join(',') !== 'ExternalSubagentLocalId,ExternalSubagentBehaviorVersion,SecretText') {
    throw new Error('public API parser must collect external subagent id macro exports');
  }
  const pluginPublicApiSymbols = (pluginPublicApiRule?.allowedSymbolEntries || []).map(
    (entry) => entry.symbol,
  );
  const pluginRootReexportSymbols = (pluginRootReexportRule?.allowedPluginReexportEntries || []).map(
    (entry) => entry.symbol,
  );
  if (!pluginPublicApiSymbols.includes('PluginDispatchEnvelope')) {
    throw new Error('plugin runtime public API allowlist must include dispatch envelope');
  }
  if (!pluginPublicApiSymbols.includes('PluginPermissionGate')) {
    throw new Error('plugin runtime public API allowlist must include permission gate');
  }
  if (pluginPublicApiSymbols.some((symbol) => symbol.startsWith('PluginRecoveryAction'))) {
    throw new Error('plugin runtime P0-B public API allowlist must not include recovery action API');
  }
  if (!pluginPublicApiSymbols.includes('PluginRuntimeReadRequest')) {
    throw new Error('plugin runtime public API allowlist must include read request');
  }
  if (!pluginPublicApiSymbols.includes('PluginStatusSnapshot')) {
    throw new Error('plugin runtime public API allowlist must include plugin status snapshot');
  }
  for (const entry of pluginPublicApiRule.allowedSymbolEntries) {
    for (const field of ['owner', 'consumer', 'verification', 'p0', 'contractSlice', 'rationale', 'exit']) {
      if (!entry[field]) {
        throw new Error(`plugin runtime public API entry must declare ${field}: ${entry.symbol}`);
      }
    }
    if (!publicApiContractSlices.includes(entry.contractSlice)) {
      throw new Error(`plugin runtime public API entry uses unknown contractSlice: ${entry.symbol}`);
    }
    if (typeof entry.wireImpact !== 'boolean') {
      throw new Error(`plugin runtime public API entry must declare wireImpact: ${entry.symbol}`);
    }
  }
  if (!pluginRootReexportSymbols.includes('PluginDispatchEnvelope')) {
    throw new Error('runtime-ports root re-export allowlist must include dispatch envelope');
  }
  if (pluginRootReexportSymbols.length !== pluginPublicApiSymbols.length) {
    throw new Error('plugin root re-export allowlist must match plugin module public budget');
  }
  if (!opencodeAdapterPublicApiRule) {
    throw new Error('OpenCode adapter must have a public API budget rule');
  }
  const opencodeAdapterPublicApiSymbols = (
    opencodeAdapterPublicApiRule.allowedSymbolEntries || []
  ).map((entry) => entry.symbol);
  if (
    opencodeAdapterPublicApiSymbols.join(',') !==
    'load_opencode_package_adapter,load_opencode_config_snapshot,OpenCodeConfigSnapshot,OpenCodeConfigSnapshotError,project_plugin_config,project_plugin_tool_ref,OpenCodePluginConfigProjectionError,OpenCodeCommandProvider,OpenCodeCommandProviderOptions,OpenCodeConfiguredSkillRoot,OpenCodeSkillRootDiagnostic,OpenCodeSkillRootReport,OpenCodeSkillRootProvider,OpenCodeSkillRootProviderOptions,OpenCodeToolProvider,OpenCodeToolProviderOptions,OpenCodeSubagentProvider,OpenCodeSubagentProviderOptions,OpenCodeMcpProvider,OpenCodeMcpProviderOptions,OpenCodeHookProvider,OpenCodeHookProviderOptions,OpenCodeWorkspaceReferenceProvider,OpenCodeWorkspaceReferenceProviderOptions,load_opencode_user_instructions,OpenCodeInstructionSourceOptions'
  ) {
    throw new Error(
      'OpenCode adapter public API budget must stay limited to the reviewed package factory, managed Plugin Host Config projection, and capability-specific command, configured Skill root, tool, subagent, MCP, static Hook, workspace Reference, and user Instruction providers',
    );
  }
  if (!pluginCapabilityProjectionPublicApiRule) {
    throw new Error('plugin capability projection must have a public API budget rule');
  }
  const pluginCapabilityProjectionSymbols = (
    pluginCapabilityProjectionPublicApiRule.allowedSymbolEntries || []
  ).map((entry) => entry.symbol);
  if (
    pluginCapabilityProjectionSymbols.join(',') !==
    'PluginContributorIdentity,PluginToolRef,PluginAgentProjection,PluginSkillRootContribution,PluginCapabilityProjection'
  ) {
    throw new Error(
      'plugin capability projection public API must stay limited to the reviewed provider-neutral contribution DTOs',
    );
  }
  const opencodeInstructionSymbols = new Set([
    'load_opencode_user_instructions',
    'OpenCodeInstructionSourceOptions',
  ]);
  for (const entry of opencodeAdapterPublicApiRule.allowedSymbolEntries) {
    for (const field of ['owner', 'consumer', 'verification', 'p0', 'contractSlice', 'rationale', 'exit']) {
      if (!entry[field]) {
        throw new Error(`OpenCode adapter public API entry must declare ${field}: ${entry.symbol}`);
      }
    }
    const expectedContractSlice = opencodeInstructionSymbols.has(entry.symbol)
      ? 'user-instruction-source-boundary'
      : 'opencode-adapter-boundary';
    if (entry.contractSlice !== expectedContractSlice) {
      throw new Error(`OpenCode adapter public API entry uses wrong contractSlice: ${entry.symbol}`);
    }
    if (entry.wireImpact !== false) {
      throw new Error(`OpenCode adapter public API entry must not claim wire impact: ${entry.symbol}`);
    }
  }
  if (!publicApiContractSlices.includes('user-instruction-source-boundary')) {
    throw new Error('user Instruction sources must have an independent contract slice');
  }
  for (const [label, rule, requiredSymbols] of [
    ['OpenCode Instruction adapter', opencodeAdapterPublicApiRule, ['load_opencode_user_instructions', 'OpenCodeInstructionSourceOptions']],
    ['Claude Code Instruction adapter', claudeHookAdapterPublicApiRule, ['load_claude_code_user_instructions', 'ClaudeCodeInstructionSourceOptions']],
    ['Codex Instruction adapter', codexHookAdapterPublicApiRule, ['load_codex_user_instructions', 'CodexInstructionSourceOptions']],
  ]) {
    if (!rule || requiredSymbols.some((symbol) => !rule.allowedSymbolEntries.some(
      (entry) => entry.symbol === symbol
        && entry.contractSlice === 'user-instruction-source-boundary'
        && entry.wireImpact === false,
    ))) {
      throw new Error(`${label} must have a narrow consumer-backed public API budget`);
    }
  }
  const expectedUserInstructionSourceServiceSymbols = [
    'MAX_LOCAL_INSTRUCTION_FILE_BYTES',
    'MAX_LOCAL_INSTRUCTION_FILES',
    'MAX_LOCAL_INSTRUCTION_TOTAL_BYTES',
    'LocalInstructionFile',
    'LocalInstructionFiles',
    'local_instruction_path_exists',
    'read_local_instruction_file',
    'read_local_text_file',
  ];
  if (
    !userInstructionSourceServicePublicApiRule
    || (userInstructionSourceServicePublicApiRule.allowedSymbolEntries || [])
      .map((entry) => entry.symbol)
      .join(',') !== expectedUserInstructionSourceServiceSymbols.join(',')
  ) {
    throw new Error('services-core user Instruction support must have an exact public API budget');
  }
  for (const entry of userInstructionSourceServicePublicApiRule.allowedSymbolEntries) {
    for (const field of ['owner', 'consumer', 'verification', 'p0', 'contractSlice', 'rationale', 'exit']) {
      if (!entry[field]) {
        throw new Error(`services-core user Instruction public API entry must declare ${field}: ${entry.symbol}`);
      }
    }
    if (entry.contractSlice !== 'user-instruction-source-boundary' || entry.wireImpact !== false) {
      throw new Error(`services-core user Instruction public API entry has the wrong boundary: ${entry.symbol}`);
    }
  }
  for (const [label, rule, requiredSymbols] of [
    ['Claude Code Hook adapter', claudeHookAdapterPublicApiRule, ['ClaudeCodeHookProvider', 'ClaudeCodeHookProviderOptions']],
    ['Codex Hook adapter', codexHookAdapterPublicApiRule, ['CodexHookProvider', 'CodexHookProviderOptions']],
    ['static Hook support', staticHookSupportPublicApiRule, ['read_bounded_file', 'regular_file_exists', 'redacted_parse_content_version', 'parse_hook_document']],
  ]) {
    if (!rule || requiredSymbols.some((symbol) => !rule.allowedSymbolEntries.some(
      (entry) => entry.symbol === symbol && entry.contractSlice === 'external-source-hook-contract',
    ))) {
      throw new Error(`${label} must have a narrow consumer-backed public API budget`);
    }
  }
  if (!externalSubagentPublicApiRule) {
    throw new Error('external subagent contracts must have an independent public API budget rule');
  }
  if (!externalHookPublicApiRule) {
    throw new Error('external Hook contracts must have an independent public API budget rule');
  }
  if (!externalHookCatalogPublicApiRule) {
    throw new Error('external Hook catalog contracts must have an independent public API budget rule');
  }
  if (!workspaceReferencePublicApiRule) {
    throw new Error('workspace Reference contracts must have an independent public API budget rule');
  }
  if (!publicApiContractSlices.includes('external-source-hook-contract')) {
    throw new Error('external Hook contracts must have an independent contract slice');
  }
  for (const requiredSymbol of [
    'ExternalHookContributionId',
    'ExternalHookPoint',
    'ExternalHookRiskCapability',
    'ExternalHookSafetyDeclaration',
    'ExternalHookContributionDeclaration',
  ]) {
    if (!externalHookPublicApiRule.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-hook-contract'
        && entry.wireImpact === false
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external Hook public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of [
    'EXTERNAL_HOOK_CATALOG_SCHEMA_V1',
    'ExternalHookProviderIdentity',
    'ExternalHookSourceProvider',
    'ExternalHookProviderSnapshot',
    'ExternalHookCatalogSnapshotV1',
  ]) {
    if (!externalHookCatalogPublicApiRule.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-hook-contract'
        && entry.wireImpact === true
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external Hook catalog public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  if (!publicApiContractSlices.includes('external-source-subagent-contract')) {
    throw new Error('external subagent contracts must have an independent contract slice');
  }
  if (!publicApiContractSlices.includes('external-source-mcp-contract')) {
    throw new Error('external MCP contracts must have an independent contract slice');
  }
  if (!publicApiContractSlices.includes('external-source-control-contract')) {
    throw new Error('external source control contracts must have an independent contract slice');
  }
  if (!publicApiContractSlices.includes('external-source-reference-contract')) {
    throw new Error('workspace Reference contracts must have an independent contract slice');
  }
  for (const requiredSymbol of [
    'ExternalWorkspaceReferenceProviderIdentity',
    'ExternalWorkspaceReferenceDefinition',
    'ExternalWorkspaceReferenceSourceProvider',
    'WorkspaceReferenceCatalogEntry',
    'WorkspaceReferenceSnapshot',
  ]) {
    if (!workspaceReferencePublicApiRule.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-reference-contract'
        && entry.wireImpact === true
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`workspace Reference public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of [
    'EXTERNAL_SOURCE_CONTROL_SCHEMA_V1',
    'ExternalSourceControlSnapshotV1',
    'ExternalSourceSurfaceSnapshotV1',
    'ExternalSourceControlActionV1',
    'ExternalSourceControlRequestV1',
    'ExternalSourceOperationStage',
    'ExternalSourceRecoveryActionV1',
  ]) {
    if (!externalSourceControlPublicApiRule?.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-control-contract'
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external source control public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of ['ExternalSourceControlPlane', 'DeferredDiscovery', 'DiscoveryBatch']) {
    if (!externalSourceCoordinatorPublicApiRule?.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-control-contract',
    )) {
      throw new Error(`external source coordinator public API budget is missing control symbol: ${requiredSymbol}`);
    }
  }
  if (!externalSourceCoordinatorPublicApiRule?.allowedSymbolEntries.some(
    (entry) => entry.symbol === 'ExternalHookCatalogCoordinator'
      && entry.contractSlice === 'external-source-hook-contract'
      && entry.wireImpact === false,
  )) {
    throw new Error('external source coordinator public API budget is missing the static Hook catalog coordinator');
  }
  if (!externalSourceCoordinatorPublicApiRule.allowedSymbolEntries.some(
    (entry) => entry.symbol === 'ExternalHookDiscoveryResult'
      && entry.contractSlice === 'external-source-hook-contract',
  )) {
    throw new Error('external source coordinator public API budget is missing the typed Hook discovery result');
  }
  for (const requiredSymbol of [
    'ExternalWorkspaceReferenceCoordinator',
    'ExternalWorkspaceReferenceCoordinatorSnapshot',
    'ExternalWorkspaceReferenceDiscoveryRequest',
    'ExternalWorkspaceReferenceDiscoveryResult',
  ]) {
    if (!externalSourceCoordinatorPublicApiRule.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-reference-contract'
        && entry.wireImpact === false,
    )) {
      throw new Error(`external source coordinator public API budget is missing workspace Reference symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of [
    'ExternalSourceControlSnapshotV1',
    'ExternalSourceControlRequestV1',
    'get_external_source_control_snapshot',
    'apply_external_source_control_action',
  ]) {
    if (!externalSourceCorePublicApiRule?.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-control-contract',
    )) {
      throw new Error(`external source core public API budget is missing control symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of ['EXTERNAL_CAPABILITY_REFERENCE', 'workspace_reference_snapshot']) {
    if (!externalSourceCorePublicApiRule?.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external source core public API budget is missing workspace Reference symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of [
    'ExternalMcpTimeouts',
    'MAX_EXTERNAL_MCP_TIMEOUT_MS',
    'ExternalMcpServerDefinition',
    'ExternalMcpSourceProvider',
    'PreparedExternalMcpServer',
    'external_mcp_approval_key',
    'external_mcp_conflict_key',
  ]) {
    if (!externalSourcePublicApiRule?.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-mcp-contract'
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external MCP public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  for (const requiredSymbol of [
    'ExternalSubagentDefinition',
    'ExternalSubagentSourceProvider',
    'ExternalSubagentSummary',
    'external_subagent_approval_key',
    'external_subagent_conflict_key',
  ]) {
    if (!externalSubagentPublicApiRule.allowedSymbolEntries.some(
      (entry) => entry.symbol === requiredSymbol
        && entry.contractSlice === 'external-source-subagent-contract'
        && entry.consumer
        && entry.verification,
    )) {
      throw new Error(`external subagent public API budget is missing a consumer-backed symbol: ${requiredSymbol}`);
    }
  }
  if (
    (managedPluginActivationPublicApiRule?.allowedSymbolEntries || [])
      .map((entry) => entry.symbol)
      .join(',') !==
    'ManagedPluginCandidateView,ManagedPluginActivationView,ManagedPluginDeactivationResult,preview_managed_plugin_activation,activate_managed_plugin,deactivate_managed_plugin'
  ) {
    throw new Error('managed plugin activation API budget must stay limited to six product-facing symbols');
  }
  const appPluginRuntimeContractRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/apps',
  );
  if (!appPluginRuntimeContractRule) {
    throw new Error('product app entrypoints must have a plugin runtime contract import guard');
  }
  const appPluginRuntimeContractRuleText = appPluginRuntimeContractRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const forbiddenPluginRuntimeContract of [
    'PluginRuntimeReadResponse',
    'PluginStatusSnapshot',
    'PluginResponseEnvelope',
    'PluginRuntimeBinding',
  ]) {
    if (!appPluginRuntimeContractRuleText.includes(forbiddenPluginRuntimeContract)) {
      throw new Error(
        `product app entrypoint plugin runtime contract guard must forbid: ${forbiddenPluginRuntimeContract}`,
      );
    }
  }
  const opencodeManifestRule = forbiddenManifestDependencyRules.find((rule) =>
    rule.dependencyNames?.includes('openbitfun-opencode-adapter'),
  );
  if (!opencodeManifestRule) {
    throw new Error('OpenCode adapter must have a forbidden manifest dependency rule');
  }
  const speechEngineManifestRule = forbiddenManifestDependencyRules.find((rule) =>
    rule.dependencyNames?.includes('sherpa-onnx'),
  );
  if (!speechEngineManifestRule) {
    throw new Error('speech engine must have a forbidden manifest dependency rule');
  }
  if (!speechEngineManifestRule.allowManifestPaths?.includes(
    'src/crates/services/services-integrations/Cargo.toml',
  )) {
    throw new Error('speech engine manifest guard must allow only its integration service owner');
  }
  const rmcpManifestRule = forbiddenManifestDependencyRules.find((rule) =>
    rule.dependencyNames?.includes('rmcp'),
  );
  if (!rmcpManifestRule?.allowManifestPaths?.includes(
    'src/crates/services/services-integrations/Cargo.toml',
  )) {
    throw new Error('RMCP manifest guard must allow only its integration service owner');
  }
  const coreSpeechOwnerRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service',
  );
  if (!coreSpeechOwnerRule || !coreSpeechOwnerRule.patterns.some(
    (pattern) => pattern.regex.source.includes('mod\\s+speech'),
  )) {
    throw new Error('core speech ownership guard must forbid a speech service module');
  }
  for (const dependencyName of [
    'openbitfun-claude-code-adapter',
    'openbitfun-codex-adapter',
    'openbitfun-static-hook-support',
  ]) {
    if (!forbiddenManifestDependencyRules.some(
      (rule) => rule.dependencyNames?.includes(dependencyName)
        && rule.workspaceManifestPath === 'Cargo.toml',
    )) {
      throw new Error(`${dependencyName} must have a workspace-wide manifest dependency guard`);
    }
  }
  for (const scanRoot of ['src/apps', 'src/crates', 'OpenBitFun-Installer/src-tauri']) {
    if (!opencodeManifestRule.scanRoots?.includes(scanRoot)) {
      throw new Error(`OpenCode adapter manifest guard must scan ${scanRoot}`);
    }
  }
  if (opencodeManifestRule.workspaceManifestPath !== 'Cargo.toml') {
    throw new Error('OpenCode adapter manifest guard must scan root workspace dependencies');
  }
  if (
    !opencodeManifestRule.allowManifestPaths?.includes(
      'src/crates/adapters/opencode-adapter/Cargo.toml',
    )
  ) {
    throw new Error('OpenCode adapter manifest guard must allow its own manifest');
  }
  if (
    !opencodeManifestRule.allowManifestPaths?.includes(
      'src/crates/assembly/core/Cargo.toml',
    )
  ) {
    throw new Error('OpenCode adapter manifest guard must allow the reviewed core composition root');
  }
  const opencodeSourceRules = forbiddenContentUnderRules.filter((rule) =>
    rule.reason.includes('OpenCode adapter production imports are limited'),
  );
  for (const scanRoot of ['src', 'OpenBitFun-Installer/src-tauri']) {
    if (!opencodeSourceRules.some((rule) => rule.path === scanRoot)) {
      throw new Error(`OpenCode adapter source guard must scan ${scanRoot}`);
    }
  }
  const opencodeSourceRegex = opencodeSourceRules[0]?.patterns?.[0]?.regex;
  if (
    !opencodeSourceRegex?.test('use openbitfun_opencode_adapter as opencode;') ||
    !opencodeSourceRegex?.test('extern crate openbitfun_opencode_adapter;') ||
    !opencodeSourceRegex?.test('openbitfun_opencode_adapter::OpenCodePluginAdapter')
  ) {
    throw new Error('OpenCode adapter source guard must catch direct, alias, and extern imports');
  }
  if (
    !opencodeSourceRules
      .find((rule) => rule.path === 'src')
      ?.patterns?.[0]?.allowPaths?.includes('src/crates/assembly/core/src/plugin_runtime.rs')
  ) {
    throw new Error('OpenCode adapter source guard must allow only the reviewed core composition file');
  }
  const opencodeHostWireRule = forbiddenContentUnderRules.find((rule) =>
    rule.reason.includes('OpenCode backend wire parsing'),
  );
  if (opencodeHostWireRule?.path !== 'src/crates/assembly/core/src') {
    throw new Error('OpenCode Host wire guard must scan the complete core source tree');
  }
  const opencodeHostWireRegexes = opencodeHostWireRule.patterns.map((pattern) => pattern.regex);
  for (const sample of [
    'let request: BackendHttpRequest = decode(params)?;',
    'let params: StreamCancelParams = decode(params)?;',
    'let error = RpcHandlerError::new(-32602, message);',
    'client.register_handler("backend.http.request", handler);',
    'const METHOD: &str = "backend.stream.read";',
    'const METHOD: &str = "backend.stream.cancel";',
    'const METHOD: &str = "backend.diagnostic.publish";',
  ]) {
    if (!opencodeHostWireRegexes.some((regex) => regex.test(sample))) {
      throw new Error(`OpenCode Host wire guard missed fixture: ${sample}`);
    }
  }
  if (
    [
      'impl OpenCodeBackendHandler for CoreOpenCodeBackend {}',
      'let request: BackendRouteRequest = request;',
      'let event: BackendDiagnosticEvent = event;',
    ].some((sample) => opencodeHostWireRegexes.some((regex) => regex.test(sample)))
  ) {
    throw new Error('OpenCode Host wire guard must allow the typed adapter callback');
  }
  const rawHandlerVisibilityRule = forbiddenContentUnderRules.find((rule) =>
    rule.reason.includes('raw OpenCode RPC handler registration'),
  );
  const rawHandlerVisibilityRegex = rawHandlerVisibilityRule?.patterns?.[0]?.regex;
  if (
    rawHandlerVisibilityRule?.path !== 'src/crates/adapters/opencode-plugin-host/src' ||
    !rawHandlerVisibilityRegex?.test('pub async fn register_handler() {}') ||
    rawHandlerVisibilityRegex.test('pub(crate) async fn register_handler() {}')
  ) {
    throw new Error('OpenCode raw handler visibility guard must keep registration crate-private');
  }
  const runtimeServicesRule = lightweightBoundaryRules.find(
    (rule) => rule.crateName === 'runtime-services',
  );
  if (!runtimeServicesRule?.forbiddenDeps.includes('openbitfun-core')) {
    throw new Error('runtime-services lightweight boundary must forbid openbitfun-core');
  }
  if (!runtimeServicesRule?.forbiddenDeps.includes('openbitfun-services-integrations')) {
    throw new Error('runtime-services lightweight boundary must forbid concrete service integrations');
  }
  const runtimeServicesProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'runtime-services',
  );
  if (!runtimeServicesProfile?.forbiddenNonOptionalDeps.includes('tool-runtime')) {
    throw new Error('runtime-services dependency profile must forbid tool runtime implementations');
  }
  if (
    crateLayoutRules.find((rule) => rule.crateName === 'plugin-runtime-client')?.path !==
    'src/crates/execution/plugin-runtime-client'
  ) {
    throw new Error('plugin-runtime-client must be registered in the execution crate layout');
  }
  if (!noCoreDependencyCrates.includes('plugin-runtime-client')) {
    throw new Error('plugin-runtime-client must be covered by the no-core dependency guard');
  }
  if (
    crateLayoutRules.find((rule) => rule.crateName === 'agent-content')?.layer !== 'assembly'
    || !noCoreDependencyCrates.includes('agent-content')
  ) {
    throw new Error('agent-content must stay an assembly-owned leaf independent from openbitfun-core');
  }
  for (const adapterCrate of ['claude-code-adapter', 'codex-adapter', 'static-hook-support']) {
    if (crateLayoutRules.find((rule) => rule.crateName === adapterCrate)?.layer !== 'adapters') {
      throw new Error(`${adapterCrate} must be registered in the adapter crate layout`);
    }
    if (!noCoreDependencyCrates.includes(adapterCrate)) {
      throw new Error(`${adapterCrate} must be covered by the no-core dependency guard`);
    }
  }
  const pluginRuntimeClientRule = lightweightBoundaryRules.find(
    (rule) => rule.crateName === 'plugin-runtime-client',
  );
  if (!pluginRuntimeClientRule?.forbiddenDeps.includes('openbitfun-core')) {
    throw new Error('plugin-runtime-client lightweight boundary must forbid openbitfun-core');
  }
  if (!pluginRuntimeClientRule?.forbiddenDeps.includes('openbitfun-opencode-adapter')) {
    throw new Error('plugin-runtime-client must not depend on the OpenCode fixture adapter');
  }
  if (!pluginRuntimeClientRule?.forbiddenDeps.includes('openbitfun-services-integrations')) {
    throw new Error('plugin-runtime-client must not depend on concrete service integrations');
  }
  const pluginRuntimeClientProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'plugin-runtime-client',
  );
  if (!pluginRuntimeClientProfile?.forbiddenNonOptionalDeps.includes('tauri')) {
    throw new Error('plugin-runtime-client dependency profile must forbid product surfaces');
  }
  const pluginRuntimeClientPublicApiRule = publicApiAllowlistRules.find(
    (rule) => rule.path === 'src/crates/execution/plugin-runtime-client/src/lib.rs',
  );
  const clientPublicSymbols = (pluginRuntimeClientPublicApiRule?.allowedSymbolEntries || []).map(
    (entry) => entry.symbol,
  );
  if (clientPublicSymbols.join(',') !== 'PluginRuntimeAdapter,DefaultPluginRuntimeClient') {
    throw new Error('plugin-runtime-client public API budget must stay narrow');
  }
  const hasPluginRuntimeClientMethodBudgetRule = forbiddenContentRules.some(
    (rule) =>
      rule.path === 'src/crates/execution/plugin-runtime-client/src/lib.rs' &&
      rule.patterns.some((pattern) =>
        pattern.message.includes('unexpected public DefaultPluginRuntimeClient method') &&
        pattern.regex.test('pub fn dispose_project(&self)') === false &&
        pattern.regex.test('pub fn restart(&self)') === true,
      ),
  );
  if (!hasPluginRuntimeClientMethodBudgetRule) {
    throw new Error('plugin-runtime-client public method budget forbidden rule is missing');
  }
  const hasPluginRuntimeAdapterMethodBudgetRule = forbiddenContentRules.some(
    (rule) =>
      rule.path === 'src/crates/execution/plugin-runtime-client/src/adapter.rs' &&
      rule.patterns.some((pattern) =>
        pattern.message.includes('unexpected PluginRuntimeAdapter trait method'),
      ),
  );
  if (!hasPluginRuntimeAdapterMethodBudgetRule) {
    throw new Error('plugin-runtime-client adapter method budget forbidden rule is missing');
  }
  const agentRuntimeRule = lightweightBoundaryRules.find(
    (rule) => rule.crateName === 'agent-runtime',
  );
  if (!agentRuntimeRule?.forbiddenDeps.includes('openbitfun-core')) {
    throw new Error('agent-runtime lightweight boundary must forbid openbitfun-core');
  }
  if (!agentRuntimeRule?.forbiddenDeps.includes('openbitfun-services-integrations')) {
    throw new Error('agent-runtime lightweight boundary must forbid concrete service integrations');
  }
  if (!agentRuntimeRule?.forbiddenDeps.includes('openbitfun-product-capabilities')) {
    throw new Error('agent-runtime lightweight boundary must forbid product assembly facts');
  }
  if (!agentRuntimeRule?.forbiddenDeps.includes('tool-runtime')) {
    throw new Error('agent-runtime lightweight boundary must forbid concrete tool runtime');
  }
  const agentRuntimeProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'agent-runtime',
  );
  if (!agentRuntimeProfile?.forbiddenNonOptionalDeps.includes('tauri')) {
    throw new Error('agent-runtime dependency profile must forbid product surface dependencies');
  }
  if (!agentRuntimeProfile?.forbiddenNonOptionalDeps.includes('openbitfun-product-capabilities')) {
    throw new Error('agent-runtime dependency profile must forbid product assembly facts');
  }
  if (!agentRuntimeProfile?.forbiddenNonOptionalDeps.includes('tool-runtime')) {
    throw new Error('agent-runtime dependency profile must forbid concrete tool runtime');
  }
  if (!noCoreDependencyCrates.includes('sdk-host')) {
    throw new Error('SDK Host protocol crate must be covered by the no-core dependency guard');
  }
  const sdkHostRule = lightweightBoundaryRules.find((rule) => rule.crateName === 'sdk-host');
  for (const dependency of [
    'openbitfun-core',
    'terminal-core',
    'openbitfun-services-core',
    'openbitfun-services-integrations',
    'tool-runtime',
    'openbitfun-cli',
  ]) {
    if (!sdkHostRule?.forbiddenDeps.includes(dependency)) {
      throw new Error(`SDK Host protocol boundary must forbid concrete dependency: ${dependency}`);
    }
  }
  const productCapabilitiesRule = lightweightBoundaryRules.find(
    (rule) => rule.crateName === 'product-capabilities',
  );
  if (!productCapabilitiesRule?.forbiddenDeps.includes('openbitfun-core')) {
    throw new Error('product-capabilities lightweight boundary must forbid openbitfun-core');
  }
  if (!productCapabilitiesRule?.forbiddenDeps.includes('openbitfun-product-domains')) {
    throw new Error(
      'product-capabilities lightweight boundary must forbid product-domain implementations',
    );
  }
  if (!productCapabilitiesRule?.forbiddenDeps.includes('tool-runtime')) {
    throw new Error('product-capabilities lightweight boundary must forbid tool-runtime');
  }
  const productCapabilitiesProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'product-capabilities',
  );
  if (!productCapabilitiesProfile?.forbiddenNonOptionalDeps.includes('openbitfun-core')) {
    throw new Error('product-capabilities dependency profile must forbid openbitfun-core');
  }
  const agentToolsManifestRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/execution/tool-contracts/src',
  );
  if (!agentToolsManifestRule) {
    throw new Error('missing agent-tools manifest-owner boundary rule');
  }
  const agentToolsRuntimeForbiddenContracts = [
    'GetToolSpecTool',
    'manifest_resolver',
    'ToolUseContext',
  ];
  const agentToolsManifestRuleText = agentToolsManifestRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of agentToolsRuntimeForbiddenContracts) {
    if (!agentToolsManifestRuleText.includes(contract)) {
      throw new Error(`agent-tools manifest boundary rule must forbid: ${contract}`);
    }
  }
  const toolPacksManifestRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/execution/tool-provider-groups/src',
  );
  if (!toolPacksManifestRule) {
    throw new Error('missing tool-packs manifest-owner boundary rule');
  }
  const toolPacksManifestRuleText = toolPacksManifestRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  const toolPacksManifestContracts = [
    'GetToolSpecTool',
    'GET_TOOL_SPEC_TOOL_NAME',
    'manifest_resolver',
    'loaded_deferred_tool_specs',
    'ToolExposure',
  ];
  for (const contract of toolPacksManifestContracts) {
    if (!toolPacksManifestRuleText.includes(contract)) {
      throw new Error(`tool-packs manifest boundary rule must forbid: ${contract}`);
    }
  }
  const serviceAgentRuntimeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/service_agent_runtime.rs',
  );
  if (!serviceAgentRuntimeRuleText.includes('self\\.scheduler')) {
    throw new Error('service agent runtime boundary rule must forbid direct scheduler submit');
  }
  if (!serviceAgentRuntimeRuleText.includes('strip_remote_user_input_tags')) {
    throw new Error('service agent runtime boundary rule must forbid remote display cleanup ownership');
  }
  if (!serviceAgentRuntimeRuleText.includes('compress_remote_chat_data_url_for_mobile')) {
    throw new Error('service agent runtime boundary rule must forbid remote thumbnail compression ownership');
  }
  if (!serviceAgentRuntimeRuleText.includes('normalize_remote_session_model_id')) {
    throw new Error('service agent runtime boundary rule must forbid session model normalization ownership');
  }
  const serviceAgentRuntimeOwnerFeatureContracts = [
    'images',
    'image::load_from_memory',
    'JpegEncoder',
    "User's question",
    'AgentInputAttachment',
    'remote_image',
  ];
  for (const contract of serviceAgentRuntimeOwnerFeatureContracts) {
    if (!serviceAgentRuntimeRuleText.includes(contract)) {
      throw new Error(`service agent runtime boundary rule must forbid remote chat owner feature: ${contract}`);
    }
  }
  const sessionMessageRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/session_message_tool.rs',
  );
  if (!sessionMessageRuleText.includes('submit_with_prepended_messages')) {
    throw new Error('SessionMessage boundary rule must forbid direct scheduler submit');
  }
  const sessionMessageLegacySessionAccessContracts = [
    'resolve_session_workspace_binding',
    'list_sessions',
  ];
  for (const contract of sessionMessageLegacySessionAccessContracts) {
    if (!sessionMessageRuleText.includes(contract)) {
      throw new Error(`SessionMessage boundary rule must forbid direct coordinator ${contract}`);
    }
  }
  const sessionControlForbiddenRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
  );
  if (!sessionControlForbiddenRuleText.includes('cancel_active_turn_for_session_from_requester')) {
    throw new Error('SessionControl boundary rule must forbid direct scheduler cancellation');
  }
  const sessionControlLegacySessionAccessContracts = [
    'resolve_session_workspace_binding',
    'list_sessions',
    'delete_session',
  ];
  for (const contract of sessionControlLegacySessionAccessContracts) {
    if (!sessionControlForbiddenRuleText.includes(contract)) {
      throw new Error(`SessionControl boundary rule must forbid direct coordinator ${contract}`);
    }
  }
  const cronServiceRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/service/cron/service.rs',
  );
  if (!cronServiceRuleText.includes('submit_with_prepended_messages')) {
    throw new Error('cron service boundary rule must forbid direct scheduler submit');
  }
  const cronToolRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/cron_tool.rs',
  );
  const cronToolLegacySessionAccessContracts = [
    'resolve_session_workspace_binding',
    'list_sessions',
  ];
  for (const contract of cronToolLegacySessionAccessContracts) {
    if (!cronToolRuleText.includes(contract)) {
      throw new Error(`CronTool boundary rule must forbid direct coordinator ${contract}`);
    }
  }
  const coordinatorRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
  );
  if (
    !coordinatorRuleText.includes('scheduler') ||
    !coordinatorRuleText.includes('deliver_thread_goal_') ||
    !coordinatorRuleText.includes('deliver_background_result') ||
    !coordinatorRuleText.includes('CoreRuntimeServicesProvider::terminal_port') ||
    !coordinatorRuleText.includes('TerminalRuntimePort')
  ) {
    throw new Error(
      'Coordinator boundary rule must forbid direct scheduler delivery and terminal provider construction',
    );
  }
  const agenticSystemRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/system.rs',
  );
  if (
    !agenticSystemRuleText.includes('CoreRuntimeServicesProvider::terminal_port') ||
    !agenticSystemRuleText.includes('TerminalRuntimePort')
  ) {
    throw new Error('agentic system boundary rule must forbid terminal provider construction');
  }
  const coreReviewReadReceiptRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/session/review_read_receipt.rs',
  );
  for (const contract of [
    'FileRevision',
    'ReviewReadCoverage',
    'ReviewReadReceiptStore',
    'DashMap',
  ]) {
    if (!coreReviewReadReceiptRuleText.includes(contract)) {
      throw new Error(`core review_read_receipt boundary rule must forbid ${contract}`);
    }
  }
  const coreEvidenceLedgerRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/session/evidence_ledger.rs',
  );
  for (const contract of [
    'EvidenceLedgerTargetKind',
    'EvidenceLedgerEvent',
    'SessionEvidenceLedger',
    'CompressionContract',
    'uuid::Uuid::new_v4',
    'DashMap',
  ]) {
    if (!coreEvidenceLedgerRuleText.includes(contract)) {
      throw new Error(`core evidence_ledger boundary rule must forbid ${contract}`);
    }
  }
  const coreToolContextRuntimeRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/tool_context_runtime.rs',
  );
  for (const contract of ['LightCheckpoint', 'TerminalRuntimePort']) {
    if (!coreToolContextRuntimeRuleText.includes(contract)) {
      throw new Error(`core tool_context_runtime boundary rule must forbid ${contract}`);
    }
  }
  const coreUserInputManagerRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/user_input_manager.rs',
  );
  for (const contract of ['UserInputManager', 'oneshot::Sender', 'DashMap']) {
    if (!coreUserInputManagerRuleText.includes(contract)) {
      throw new Error(`core user_input_manager boundary rule must forbid ${contract}`);
    }
  }
  const coreToolPipelineRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
  );
  for (const contract of ['ConfirmationResponse', 'oneshot::Sender', 'CancellationToken']) {
    if (!coreToolPipelineRuleText.includes(contract)) {
      throw new Error(`core tool_pipeline boundary rule must forbid ${contract}`);
    }
  }
  const coreRoundExecutorRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/execution/round_executor.rs',
  );
  for (const contract of ['CancellationToken', 'DashMap']) {
    if (!coreRoundExecutorRuleText.includes(contract)) {
      throw new Error(`core round_executor boundary rule must forbid ${contract}`);
    }
  }
  const coreBackgroundCommandOutputRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/background_command_output.rs',
  );
  for (const contract of [
    'BackgroundCommandOutputCapture',
    'BackgroundCommandOutputStatus',
    'VecDeque',
    'mpsc::UnboundedSender',
    'tokio::spawn',
  ]) {
    if (!coreBackgroundCommandOutputRuleText.includes(contract)) {
      throw new Error(`core background_command_output boundary rule must forbid ${contract}`);
    }
  }
  const coreExecCommandRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/command.rs',
  );
  for (const contract of [
    'POWERSHELL_UTF8_OUTPUT_PREFIX',
    'REMOTE_NON_TTY_INTERRUPT_GRACE_SECONDS',
    'DEFAULT_TOOL_YIELD_TIME_MS',
    '(?:local|remote)_completion_value',
    '(?:local|remote)_completion',
    '(?:local|remote)_background_output_status_for_completion',
    'merged_remote_env',
    'remote_command_env_words',
    'shell_escape',
    'is_plausible_remote_shell_path',
    'getent\\s+passwd',
    'command\\s+-v\\s+bash',
      'REMOTE_SHELL_PROBE_TIMEOUT_MS',
      'get_global_exec_process_manager',
      'get_global_remote_exec_process_manager',
      'SSHConnectionManager',
      'SSHCommandOptions',
      'LocalExecCommandRequest',
      'CoreRuntimeServicesProvider::terminal_port',
      'TerminalRuntimePort',
    ]) {
      if (!coreExecCommandRuleText.includes(contract)) {
        throw new Error(`core exec_command boundary rule must forbid ${contract}`);
      }
    }
  const coreWriteStdinRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/stdin.rs',
  );
  for (const contract of [
    'DEFAULT_TOOL_YIELD_TIME_MS',
    '(?:local|remote)_completion_value',
    '(?:local|remote)_completion',
    '"status"\\s*:\\s*"session_not_found"',
      'No input was sent',
      'get_global_exec_process_manager',
      'get_global_remote_exec_process_manager',
      'RemoteExecError',
      'LocalWriteStdinRequest',
      'CoreRuntimeServicesProvider::terminal_port',
      'TerminalRuntimePort',
    ]) {
      if (!coreWriteStdinRuleText.includes(contract)) {
        throw new Error(`core WriteStdin boundary rule must forbid ${contract}`);
      }
    }
  const coreExecControlRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/control.rs',
  );
  if (!coreExecControlRuleText.includes('exec_command_control_action_name')) {
    throw new Error('core ExecControl boundary rule must forbid action result shaping');
  }
  if (!coreExecControlRuleText.includes('(?:local|remote)_completion')) {
    throw new Error('core ExecControl boundary rule must forbid duplicated completion mapping');
  }
    for (const contract of [
      'get_global_exec_process_manager',
      'get_global_remote_exec_process_manager',
      'RemoteExecError',
      'LocalExecControlRequest',
      'CoreRuntimeServicesProvider::terminal_port',
      'TerminalRuntimePort',
    ]) {
      if (!coreExecControlRuleText.includes(contract)) {
        throw new Error(`core ExecControl boundary rule must forbid ${contract}`);
      }
    }
  const coreExecCommandInputRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/input.rs',
  );
    for (const contract of [
      'get_global_exec_process_manager',
      'get_global_remote_exec_process_manager',
      'LocalSendStdinRequest',
      'CoreRuntimeServicesProvider::terminal_port',
      'TerminalRuntimePort',
    ]) {
      if (!coreExecCommandInputRuleText.includes(contract)) {
        throw new Error(`core ExecCommand input boundary rule must forbid ${contract}`);
      }
    }
  const coreExecCommandEnvSnapshotRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/env_snapshot.rs',
  );
  for (const contract of [
    'ENV_SNAPSHOT_BEGIN',
    'ENV_SNAPSHOT_END',
    'should_import_env_var',
    'is_valid_env_var_name',
    'is_volatile_env_var',
    'shell_escape',
    'ENV_SNAPSHOT_TIMEOUT_MS',
    'ENV_SNAPSHOT_MAX_OUTPUT_CHARS',
    'ENV_SNAPSHOT_TTL',
    'get_global_remote_exec_process_manager',
    'SSHConnectionManager',
  ]) {
    if (!coreExecCommandEnvSnapshotRuleText.includes(contract)) {
      throw new Error(`core exec_command env_snapshot boundary rule must forbid ${contract}`);
    }
  }
  const coreSkillAgentSnapshotRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs',
  );
  for (const contract of [
    'SkillSnapshotEntry',
    'AgentSnapshotEntry',
    'TurnSkillAgentSnapshot',
    'SkillAgentDiff',
    'diff_skill_agent_snapshot',
    'render_titled_skill_entries',
  ]) {
    if (!coreSkillAgentSnapshotRuleText.includes(contract)) {
      throw new Error(`core skill_agent_snapshot boundary rule must forbid ${contract}`);
    }
  }
  const coreTurnSkillAgentSnapshotStoreRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/session/turn_skill_agent_snapshot_store.rs',
  );
  for (const contract of ['TurnSkillAgentSnapshotStore', 'DashMap', 'BTreeMap']) {
    if (!coreTurnSkillAgentSnapshotStoreRuleText.includes(contract)) {
      throw new Error(`core turn_skill_agent_snapshot_store boundary rule must forbid ${contract}`);
    }
  }

  const requiredContentContracts = [
    {
      path: 'src/crates/contracts/runtime-ports/src/agent_api.rs',
      contracts: [
        'AgentDialogTurnRequest',
        'AgentDialogPrependedReminder',
        'AgentDialogTurnPort',
        'AgentBackgroundResultRequest',
        'AgentThreadGoalDeliveryKind',
        'AgentThreadGoalDeliveryRequest',
        'AgentLifecycleDeliveryPort',
        'agent_dialog_turn_request_serializes_lifecycle_contract',
        'agent_background_result_request_serializes_lifecycle_contract',
        'agent_thread_goal_delivery_request_serializes_lifecycle_contract',
        'AgentTurnCancellationPort',
        'requester_session_id',
        'AgentSessionListRequest',
        'AgentSessionSummary',
        'AgentSessionDeleteRequest',
        'AgentSessionWorkspaceRequest',
        'AgentSessionManagementPort',
        'agent_session_management_contracts_serialize_stable_shape',
        'RemoteControlStatePort',
        'RuntimeEventSink',
        'AgentSessionCreateResult',
        'session_name',
        'RemoteWorkspaceFacts',
        'RemoteWorkspaceRuntimeHost',
        'RemoteWorkspacePort',
        'RemoteWorkspaceFileRuntimeHost',
        'RemoteProjectionPort',
        'RemoteInitialSyncRuntimeHost',
        'remote_workspace_contracts_preserve_workspace_and_session_facts',
        'remote_projection_contract_preserves_file_chunk_identity',
        'remote_image',
        'DialogTriggerSource',
        'dialog_trigger_source_reuses_agent_submission_source_contract',
        'DialogQueuePriority',
        'DialogSubmissionPolicy',
        'dialog_submission_policy_preserves_current_surface_queue_defaults',
        'DialogSubmitOutcome',
        'dialog_submit_outcome_preserves_started_and_queued_fields',
        'DialogSessionStateFact',
        'DialogSubmitQueueFacts',
        'DialogSubmitQueueAction',
        'resolve_dialog_submit_queue_action',
        'dialog_submit_queue_action_preserves_current_scheduler_routing_policy',
        'should_suppress_agent_session_cancelled_reply',
        'DialogTurnOutcomeKind',
        'should_skip_agent_session_reply',
        'agent_session_reply_decisions_preserve_cancel_suppression_boundary',
        'AgentSessionReplyRoute',
        'agent_session_reply_route_keeps_requester_fields',
        'DialogSteerOutcome',
        'dialog_steer_outcome_preserves_buffered_fields',
        'RoundInjectionKind',
        'RoundInjectionTarget',
        'RoundInjection',
        'DialogRoundInjectionSource',
        'round_injection_contract_keeps_kind_and_target_identity',
        'round_injection_source_contract_drains_portable_injections',
        'ThreadGoalStatus',
        'ThreadGoal',
        'SetThreadGoalResult',
        'ThreadGoalContinuationPlan',
        'ThreadGoalToolResponse',
        'thread_goal_active_status_includes_budget_limited',
        'thread_goal_tool_response_serializes_optional_fields',
        'CompressionContract',
        'CompressionContractItem',
        'compression_contract_renders_model_visible_fields',
        'RelatedPath',
        'related_path_serializes_as_request_context_fact',
        'WorkspaceFileSystem',
        'WorkspaceShell',
        'WorkspaceServices',
        'WorkspaceCommandOptions',
        'WorkspaceCommandResult',
        'WorkspaceDirEntry',
        'workspace_services_contract_is_runtime_port_owned',
        'DelegationPolicy',
        'SubagentContextMode',
        'delegation_policy_child_blocks_recursive_spawn_without_losing_depth',
        'subagent_context_mode_preserves_fork_wire_value',
      ],
    },
    {
      path: 'src/crates/execution/runtime-services/src/lib.rs',
      contracts: [
        'RuntimeServices',
        'RuntimeServicesBuilder',
        'CapabilityAvailability',
        'RuntimeServiceMarkerPort',
        'RuntimeServicesProvider',
        'RuntimeServicesRegistry',
        'CapabilityMismatch',
        'require_capability',
      ],
    },
    {
      path: 'src/crates/execution/runtime-services/src/backend_events.rs',
      contracts: [
        'BackendEvent',
        'BackendEventSystem',
        'event_name',
        'emit',
        'get_global_event_system',
        'backend_event_names_remain_stable',
      ],
    },
    {
      path: 'src/crates/contracts/events/src/frontend_projection.rs',
      contracts: [
        'AgenticFrontendEvent',
        'project_agentic_frontend_event',
        'deep_review_queue_projection_preserves_camel_case_contract',
      ],
    },
    {
      path: 'src/crates/adapters/transport/src/adapters/tauri.rs',
      contracts: ['project_agentic_frontend_event', 'projected.event_name.as_str()'],
    },
    {
      path: 'src/crates/execution/runtime-services/src/runtime_services_contracts.rs',
      contracts: [
        'builder_requires_mandatory_runtime_services',
        'fake_provider_registers_required_and_remote_services_through_registry',
        'missing_optional_capability_returns_typed_unsupported_error',
        'capability_availability_reports_optional_service_status_without_side_effects',
        'builder_rejects_port_registered_under_the_wrong_capability',
        'registered_remote_ports_expose_owner_contract_methods',
        'marker_ports_register_optional_service_availability_without_core_dependency',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/runtime.rs',
      contracts: [
        'AgentRuntime',
        'AgentRuntimeBuilder',
        'AgentSubmissionPort',
        'AgentDialogTurnPort',
        'with_dialog_turn_port',
        'submit_dialog_turn',
        'AgentLifecycleDeliveryPort',
        'with_lifecycle_delivery_port',
        'deliver_background_result',
        'deliver_thread_goal',
        'AgentTurnCancellationPort',
        'AgentSessionManagementPort',
        'with_session_management_port',
        'MissingSessionManagementPort',
        'list_sessions',
        'delete_session',
        'resolve_session_workspace_binding',
        'session_management_delegates_to_registered_port',
        'RuntimeServices',
        'RuntimeEventEnvelope',
        'AgentEventStream',
        'with_event_stream',
        'SessionSelector',
        'AgentRunRequest',
        'AgentRunHandle',
        'run',
        'publish_event',
        'publish_event_uses_runtime_services_event_sink',
        'run_handle_exposes_configured_agent_event_stream',
        'port_errors_remain_typed',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/sdk.rs',
      contracts: [
        'AGENT_RUNTIME_SDK_API_VERSION',
        '#[non_exhaustive]',
        'AgentRuntimeSdkStability',
        'AgentRuntimeSdkCompatibility',
        'impl AgentRuntimeSdkCompatibility',
        'openbitfun_agent_tools',
        'openbitfun_runtime_services',
        'PortResult',
        'RuntimeServicePort',
        'FileSystemPort',
        'RemoteWorkspacePort',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/Cargo.toml',
      contracts: ['[features]', 'default = []'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/context_profile.rs',
      contracts: [
        'ContextProfile',
        'ModelCapabilityProfile',
        'ContextProfilePolicy',
        'for_subagent_context_and_models',
        'model_capability_weak_for_mini',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/session_state.rs',
      contracts: [
        'SessionState',
        'ProcessingPhase',
        'dialog_state_fact',
        'session_state_label_for_state',
        'processing_state_serialization_stays_compatible',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/session.rs',
      contracts: [
        'Session',
        'SessionConfig',
        'SessionSummary',
        'SessionKind',
        'PersistedSessionStateFile',
        'sanitize_persisted_session_state',
        'persisted_session_state_file_shape_stays_compatible',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/dialog_turn.rs',
      contracts: ['new_turn_id', 'TurnStats'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/side_question.rs',
      contracts: [
        'SideQuestionRuntime',
        'ActiveBtwTurn',
        'register_btw_turn',
        'registering_same_request_cancels_previous_token',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/sdk_smoke.rs',
      contracts: [
        'sdk_facade_exposes_versioned_preview_compatibility_contract',
        'sdk_facade_runs_with_fake_provider_and_local_event_stream',
        'sdk_facade_accepts_fake_services_tools_and_hooks_without_core',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/examples/sdk_minimal.rs',
      contracts: [
        'openbitfun_agent_runtime::sdk',
        'AgentRuntimeSdkCompatibility::current',
        'impl AgentSubmissionPort for ExampleAgentProvider',
        'AgentRuntimeBuilder::new',
        'AgentRunRequest::new',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/agents.rs',
      contracts: [
        'SubagentQueryContext',
        'SubagentListScope',
        'SubagentVisibilityPolicy',
        'resolve_subagent_default_enabled',
        'resolve_subagent_availability',
        'SubagentOverrideLayers',
        'SubagentStateReason',
        'STANDARD_HARNESS_CONFIG_ID',
        'resolve_mode_config_profile_id',
        'mode_config_profile_member_mode_ids',
        'mode_presentation_rank',
        'standard_harness_user_context_policy',
        'SubAgentSource',
        'subagent_source_kind',
        'subagent_source_presentation_rank',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/agent_registry_contracts.rs',
      contracts: [
        'visibility_policy_supports_public_restricted_hidden_and_denied_parents',
        'availability_preserves_builtin_project_and_user_override_layering',
        'default_enabled_uses_visibility_only_for_builtin_subagents',
        'shared_coding_modes_resolve_to_the_same_config_profile',
        'subagent_source_contract_preserves_runtime_kind_and_presentation_order',
        'mode_presentation_and_shared_context_policy_match_existing_mode_contract',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/custom_agent.rs',
      contracts: [
        'CustomAgentKind',
        'CustomAgentDiscoveryRoots',
        'CustomAgentLoadReport',
        'CustomAgentDefinition',
        'CustomAgentDefinitionError',
        'DEFAULT_CUSTOM_MODE_TOOLS',
        'DEFAULT_CUSTOM_SUBAGENT_TOOLS',
        'custom_agent_read_markdown_file',
        'custom_agent_save_markdown_file',
        'custom_agent_possible_dirs',
        'load_custom_agent_definitions',
        'CustomAgentValidationContext',
        'CustomAgentValidationReport',
        'CustomAgentModelFallback',
        'validate_custom_agent_definition',
        'custom_agent_review_writable_tools',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/custom_subagent.rs',
      contracts: [
        'pub type CustomSubagentKind = CustomAgentLevel',
        'pub type CustomSubagentDefinition = CustomAgentDefinition',
        'pub type CustomSubagentDiscoveryRoots = CustomAgentDiscoveryRoots',
        'load_custom_subagent_definitions',
        'custom_agent_read_markdown_file',
        'custom_agent_save_markdown_file',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/custom_subagent_discovery_contracts.rs',
      contracts: [
        'custom_subagent_discovery_preserves_openbitfun_priority_and_ignores_foreign_agent_dirs',
        'custom_subagent_discovery_reports_parse_errors_without_dropping_valid_files',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/custom_subagent_contracts.rs',
      contracts: [
        'custom_subagent_defaults_match_existing_front_matter_contract',
        'custom_subagent_tool_front_matter_keeps_existing_comma_format',
        'custom_subagent_default_fields_are_omitted_when_saved',
        'custom_subagent_definition_from_front_matter_preserves_schema_and_defaults',
        'custom_subagent_definition_reports_legacy_missing_field_errors',
        'custom_subagent_markdown_io_writes_canonical_front_matter',
        'custom_subagent_markdown_parse_errors_match_legacy_prefixes',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/native_hooks/kind.rs',
      contracts: ['RuntimeHookKind', 'SuccessfulToolPostCall'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/native_hooks/registry.rs',
      contracts: [
        'RuntimeHookErrorPolicy',
        'RuntimeHookPlan',
        'RuntimeHookRegistry',
        'EmptyHookId',
        'InvalidTimeoutMillis',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_interaction_contracts/post_call_hook_contracts.rs',
      contracts: [
        'successful_tool_call_uses_stable_builtin_registration_id',
        'runtime_hook_registry_preserves_source_order_timeout_and_error_policy',
        'runtime_hook_registry_rejects_duplicate_ids',
        'runtime_hook_registry_rejects_unstable_ids_and_zero_timeouts',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_interaction_contracts/post_call_hook_execution_contracts.rs',
      contracts: ['successful_tool_post_call_executor_runs_deep_review_measurement_route'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/user_questions.rs',
      contracts: [
        'AskUserQuestionInput',
        'UserInputResponse',
        'UserInputManager',
        'get_user_input_manager',
        'validate_ask_user_question_input',
        'user_input_manager_delivers_answer_and_clears_channel',
        'user_input_manager_cancel_closes_receiver',
      ],
    },
    {
      path: 'src/crates/execution/tool-execution/src/background_command_output.rs',
      contracts: [
        'BackgroundCommandOutputCapture',
        'BackgroundCommandOutputStatus',
        'BackgroundCommandOutputMetadata',
        'background_command_output_capture',
        'BACKGROUND_COMMAND_OUTPUT_CAPTURE_LIMIT_BYTES',
        'background_command_output_reads_snapshot_then_incremental_chunks',
      ],
    },
    {
      path: 'src/crates/execution/tool-execution/src/exec_command.rs',
      contracts: [
        'EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX',
        'EXEC_COMMAND_DEFAULT_YIELD_TIME_MS',
        'ExecCommandShellKind',
        'Custom',
        'ExecCommandRemoteShell',
        'REMOTE_EXEC_SHELL_PROBE_TIMEOUT_MS',
        'remote_exec_shell_probe_command',
        'fallback_remote_exec_shell',
        'ExecCommandRemoteEnvSnapshot',
        'ExecCommandRemoteEnvSnapshotCapturePolicy',
        'ExecCommandRemoteEnvSnapshotCacheKey',
        'ExecCommandRemoteEnvSnapshotCache',
        'remote_exec_env_snapshot_capture_policy',
        'ExecCommandRunInput',
        'WriteStdinInput',
        'ExecCommandControlToolInput',
        'ExecCommandResultFields',
        'ExecCommandShellMetadata',
        'exec_command_argv_for_shell',
        'exec_command_result_value',
        'write_stdin_result_value',
        'write_stdin_session_not_found_result',
        'exec_control_result_value',
        'remote_exec_login_shell_command',
        'remote_exec_non_tty_control_wrapper',
        'parse_remote_exec_env_snapshot_output',
        'ExecCommandLifecycleStatus',
        'exec_command_lifecycle_background_output_status',
        'remote_login_shell_command_applies_snapshot_then_tool_env',
        'remote_shell_probe_and_env_snapshot_are_provider_neutral',
        'exec_command_input_policy_applies_defaults_without_trimming_command',
        'write_stdin_input_policy_applies_poll_defaults',
        'exec_control_input_policy_keeps_wait_optional',
        'exec_command_result_builder_preserves_existing_wire_shape',
        'write_stdin_and_control_result_builders_preserve_remote_shape',
        'remote_env_snapshot_capture_policy_keeps_existing_bounds',
        'remote_env_snapshot_cache_owns_key_and_ttl_policy',
        'remote_shell_probe_skips_non_posix_shells',
        'lifecycle_status_has_provider_neutral_names_and_background_statuses',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/completion.rs',
      contracts: [
        'exec_command_local_completion',
        'exec_command_remote_completion',
        'ExecCommandCompletionStatus::Interrupted',
        'ExecCommandCompletionSource::OutOfBandControl',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/command.rs',
      contracts: [
        'exec_command_argv_for_shell',
        'parse_remote_exec_shell_probe_output',
        'remote_exec_shell_probe_command',
        'fallback_remote_exec_shell',
        'remote_exec_login_shell_command',
        'remote_exec_non_tty_control_wrapper',
        'exec_command_lifecycle_status_name',
        'exec_command_lifecycle_background_output_status',
        'exec_command_run_input_from_input',
        'exec_command_result_value',
        'exec_command_local_completion',
        'exec_command_remote_completion',
        'ExecCommandShellMetadata',
        'remote_shell_probe_preserves_unknown_shell_metadata',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/stdin.rs',
      contracts: [
        'write_stdin_input_from_input',
        'write_stdin_input_validation_message',
        'write_stdin_result_value',
        'write_stdin_session_not_found_result',
        'exec_command_local_completion',
        'exec_command_remote_completion',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/control.rs',
      contracts: [
        'exec_command_control_tool_input_from_input',
        'exec_command_control_tool_input_validation_message',
        'exec_control_result_value',
        'exec_command_local_completion',
        'exec_command_remote_completion',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/env_snapshot.rs',
      contracts: [
        'remote_exec_env_snapshot_command',
        'parse_remote_exec_env_snapshot_output',
        'remote_exec_env_snapshot_capture_policy',
        'ExecCommandRemoteEnvSnapshotCache',
        'ExecCommandRemoteEnvSnapshotCacheKey',
        'exec_command_shell_kind',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/shell_kind.rs',
      contracts: [
        'exec_command_shell_kind',
        'terminal_shell_type',
        'ExecCommandShellKind::Custom(name.clone())',
        'ShellType::Custom(name)',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/checkpoint.rs',
      contracts: [
        'LightCheckpoint',
        'LightCheckpointWorkspaceFacts',
        'GitStatusCheckpointFacts',
        'build_light_checkpoint',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/scheduler.rs',
      contracts: [
        'DEFAULT_MAX_DIALOG_QUEUE_DEPTH',
        'ActiveDialogTurn',
        'ActiveDialogTurnStore',
        'AgentSessionReplyAction',
        'AgentSessionReplyPlan',
        'BackgroundDeliveryFacts',
        'BackgroundDeliveryAction',
        'BackgroundInjectionKind',
        'DialogReplySuppressionSet',
        'DialogSteeringAction',
        'DialogTurnQueue',
        'SessionAbortFlags',
        'resolve_agent_session_reply_action',
        'resolve_background_delivery_action',
        'resolve_background_delivery_injection',
        'resolve_dialog_steering_action',
        'follow_up_submission_policy',
        'SubmitAgentSessionFollowUp',
        'InjectIntoRunningTurn',
        'SessionRoundInjectionBuffer',
        'TurnOutcome',
        'TurnOutcomeQueueAction',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/scheduler_contracts.rs',
      contracts: [
        'background_delivery_injects_when_session_is_processing',
        'background_delivery_starts_agent_session_follow_up_when_session_is_not_processing',
        'background_delivery_follow_up_uses_agent_session_source_semantics',
        'background_delivery_injection_does_not_expose_follow_up_policy',
        'background_delivery_injection_builds_thread_goal_current_turn_message',
        'background_delivery_injection_builds_background_result_with_display_fallback',
        'dialog_turn_queue_preserves_priority_order_and_fifo_within_priority',
        'dialog_turn_queue_rejects_overflow_and_preserves_current_error_shape',
        'dialog_turn_queue_clear_and_requeue_front_preserve_scheduler_recovery_contract',
        'dialog_turn_queue_requeued_turn_keeps_original_priority_for_later_ordering',
        'active_dialog_turn_owns_agent_session_reply_suppression_facts',
        'active_dialog_turn_store_owns_suppression_key_resolution_and_removal',
        'reply_suppression_set_marks_takes_and_clears_turn_keys',
        'session_abort_flags_are_session_scoped',
        'agent_session_reply_action_forwards_completed_outcome_with_legacy_reminder_text',
        'agent_session_reply_action_suppresses_cancelled_auto_reply_when_requested',
        'agent_session_reply_action_ignores_non_agent_session_turns',
        'dialog_steering_action_buffers_exact_running_turn_with_display_fallback',
        'dialog_steering_action_rejects_when_target_turn_is_not_running',
        'round_injection_buffer_drains_only_messages_for_the_active_turn',
        'turn_outcome_status_reply_and_queue_policy_are_portable',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/thread_goal.rs',
      contracts: [
        'ThreadGoalRuntime',
        'SetThreadGoalRequest',
        'build_set_thread_goal_result',
        'continuation_after_turn',
        'ThreadGoalContinuationOutcome',
        'goal_tool_response',
        'should_skip_goal_for_turn',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_long_horizon_contracts/thread_goal_contracts.rs',
      contracts: [
        'set_thread_goal_creates_new_active_goal_with_trimmed_objective',
        'continuation_outcome_increments_active_goal_and_builds_plan',
        'continuation_outcome_marks_active_goal_blocked_at_limit',
        'continuation_outcome_reports_budget_limit_once_when_tokens_cross_budget',
        'prompt_and_tool_response_contracts_match_thread_goal_wire_shape',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/prompt.rs',
      contracts: [
        'UserContextSection',
        'UserContextPolicy',
        'ToolListingSections',
        'PrependedPromptReminders',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/prompt_cache.rs',
      contracts: [
        'PROMPT_CACHE_SCHEMA_VERSION',
        'PromptCachePolicy',
        'prompt_cache_scope_key',
        'SessionPromptCacheStore',
        'PromptCacheLookup',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/skill_agent_snapshot.rs',
      contracts: [
        'SkillSnapshotEntry',
        'AgentSnapshotEntry',
        'TurnSkillAgentSnapshot',
        'SkillAgentDiff',
        'diff_skill_agent_snapshot',
        'build_skill_agent_tool_listing_sections_from_snapshot',
        'TurnSkillAgentSnapshotStore',
        'skill_agent_diff_renders_changed_added_and_removed_entries',
        'latest_snapshot_at_or_before_returns_nearest_sparse_snapshot',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/review_read_receipt.rs',
      contracts: [
        'FileRevision',
        'ReviewReadCoverage',
        'ReviewReadReceiptStore',
        'review_read_receipt_store_scopes_entries_by_session',
        'review_read_receipt_covers_only_previously_returned_lines',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/evidence_ledger.rs',
      contracts: [
        'EvidenceLedgerTargetKind',
        'EvidenceLedgerEventStatus',
        'EvidenceLedgerEvent',
        'EvidenceLedgerSummary',
        'SessionEvidenceLedger',
        'impl From<EvidenceLedgerSummary> for CompressionContract',
        'impl From<LightCheckpoint> for EvidenceLedgerCheckpoint',
        'ledger_reads_events_scoped_by_session_and_turn',
        'checkpoint_from_light_checkpoint_preserves_recovery_boundary_metadata',
        'summary_projects_into_compression_contract',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/turn_cancellation.rs',
      contracts: [
        'DialogTurnCancellationTokenStore',
        'get_or_insert_new',
        'is_cancelled',
        'turn_cancellation_store_reuses_existing_token',
        'turn_cancellation_store_cancels_registered_token',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/execution/round_executor.rs',
      contracts: ['DialogTurnCancellationTokenStore', 'get_or_insert_new', 'is_cancelled'],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/prompt_cache_contracts.rs',
      contracts: [
        'prompt_cache_policy_keeps_existing_default_persistence_ttl',
        'prompt_cache_lookup_preserves_identity_and_expiry_semantics',
        'prompt_cache_scope_key_preserves_legacy_mode_switch_shape',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/prompt_contracts.rs',
      contracts: [
        'user_context_policy_preserves_order_and_deduplicates_sections',
        'tool_listing_sections_render_only_present_sections',
        'prepended_prompt_reminders_keep_runtime_injection_order',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/events.rs',
      contracts: ['FinishReason', 'session_state_label', 'turn_outcome_kind'],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/events_contracts.rs',
      contracts: [
        'finish_reason_display_preserves_wire_labels',
        'session_state_labels_match_existing_event_wire_values',
        'turn_outcome_kind_matches_existing_reply_policy_contract',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/event_queue.rs',
      contracts: ['EventQueue', 'impl StreamEventSink for EventQueue', 'clear_session'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/session_state_manager.rs',
      contracts: [
        'pub struct SessionStateManager',
        'DashMap<String, SessionState>',
        'EventQueue',
        'AgenticEvent::SessionStateChanged',
        'session_state_label_for_state',
        'can_start_new_turn',
        'session_state_manager_emits_compatible_state_change_events',
        'session_state_manager_keeps_turn_start_guard_semantics',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/coordination/state_manager.rs',
      contracts: ['pub use openbitfun_agent_runtime::session_state_manager::SessionStateManager'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/event_router.rs',
      contracts: ['EventSubscriber', 'EventRouter', 'route_batch'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/prompt_markup.rs',
      contracts: [
        'PromptEnvelope',
        'render_user_query',
        'strip_prompt_markup',
        'strips_current_and_legacy_system_reminder_suffix',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/remote_file_delivery.rs',
      contracts: [
        'TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY',
        'remote_file_delivery_reminder',
        'user_workspace_relative_file_link',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/scheduled_job.rs',
      contracts: [
        'ScheduledJobRuntimeState',
        'ScheduledJobRunStatus',
        'DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS',
        'mark_manual_trigger',
        'apply_due_scheduled_trigger',
        'mark_enqueued',
        'mark_enqueue_failed',
        'recover_interrupted_turn_after_restart',
        'pending_is_due',
        'next_wakeup_at_ms',
        'clear_pending_trigger',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/scheduled_job_contracts.rs',
      contracts: [
        'manual_trigger_coalesces_existing_pending_run',
        'due_scheduled_trigger_coalesces_when_active_or_pending',
        'pending_wakeup_prefers_retry_time_when_present',
        'disabled_and_config_clear_remove_pending_retry_without_touching_history',
        'enqueue_success_sets_active_turn_and_disables_one_shot_next_run',
        'enqueue_failure_preserves_retry_and_missing_session_disable_semantics',
        'restart_recovery_marks_active_turn_error',
        'serde_shape_preserves_legacy_cron_state_wire_contract',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/cron/types.rs',
      contracts: [
        'ScheduledJobRuntimeState as CronJobState',
        'ScheduledJobRunStatus as CronJobRunStatus',
        'DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/cron/service.rs',
      contracts: [
        'mark_manual_trigger',
        'apply_due_scheduled_trigger',
        'mark_enqueued',
        'mark_enqueue_failed',
        'recover_interrupted_turn_after_restart',
        'pending_is_due',
        'next_wakeup_at_ms',
        'clear_pending_trigger',
        'ScheduledJobEnqueueFailureAction',
        'CoreServiceAgentRuntime::agent_runtime_with_dialog_turns',
        'AgentDialogTurnRequest',
        'AgentDialogPrependedReminder',
        'submit_dialog_turn',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/cron_tool.rs',
      contracts: [
        'CoreServiceAgentRuntime::agent_runtime',
        'AgentSessionListRequest',
        'AgentSessionWorkspaceRequest',
        'list_sessions',
        'resolve_session_workspace_binding',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/execution/types.rs',
      contracts: ['openbitfun_agent_runtime::events::FinishReason'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/events/types.rs',
      contracts: [
        'openbitfun_agent_runtime::session_state::session_state_label_for_state',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/agents/prompt_builder/user_context.rs',
      contracts: ['openbitfun_agent_runtime::prompt'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/subagent_runtime/mod.rs',
      contracts: [
        'openbitfun_runtime_ports',
        'DelegationPolicy',
        'SubagentContextMode',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/session/session_manager.rs',
      contracts: [
        'clone_prompt_cache',
        'start_dialog_turn_with_existing_context',
        'start_dialog_turn_with_existing_context_persists_turn_and_snapshot',
        'clone_prompt_cache_copies_runtime_and_persisted_entries',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/persistence/session_branch.rs',
      contracts: ['SessionBranchRequest', 'SessionBranchResult', 'build_branched_session_metadata'],
    },
    {
      path: 'src/crates/services/services-core/src/session/mod.rs',
      contracts: [
        'mod metadata_store',
        'SessionMetadataStore',
      ],
    },
    {
      path: 'src/crates/services/services-core/src/session/metadata_store.rs',
      contracts: [
        'SessionMetadataStore',
        'SessionMetadataStoreError',
        'SessionStorageLayout',
        'list_metadata',
        'list_metadata_page',
        'list_metadata_including_internal',
        'rebuild_index',
        'save_metadata',
        'load_metadata',
        'delete_session_dir_and_index',
        'metadata_store_saves_visible_metadata_and_updates_index',
        'metadata_store_rebuilds_stale_index_entries',
        'metadata_store_rebuild_index_counts_hidden_metadata_files',
        'metadata_store_delete_session_updates_visible_index',
      ],
    },
    {
      path: 'src/crates/services/services-core/src/managed_runtime.rs',
      contracts: [
        'ManagedRuntimeResolver',
        'RuntimeSource',
        'resolve_command',
        'merged_path_env',
        'normalizes_windows_alias_for_managed_lookup',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/runtime/mod.rs',
      contracts: ['ManagedRuntimeResolver::new', 'get_path_manager_arc'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/persistence/manager.rs',
      contracts: [
        'SessionMetadataStore',
        'session_metadata_store',
        'list_metadata',
        'list_metadata_page',
        'list_metadata_including_internal',
        'save_metadata',
        'load_metadata',
        'delete_session_dir_and_index',
        'ensure_runtime_for_write',
      ],
    },
    {
      path: 'src/crates/assembly/product-capabilities/src/lib.rs',
      contracts: [
        'ProductCapabilityAssembly',
        'ProductFeatureGroup',
        'ProductRuntimeAssembly',
        'DeliveryProfile::Sdk',
        'into_runtime_parts',
        'feature_groups_from_tool_provider_group_plan',
      ],
    },
    {
      path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/product_capabilities.rs',
      contracts: [
        'product_assembly_plan_exposes_build_feature_groups_explicitly',
        'product_runtime_assembly_reports_runtime_service_capability_gaps',
      ],
    },
    {
      path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/plugin_product_shape.rs',
      contracts: [
        'executable_plugin_runtime_is_limited_to_product_full_desktop_and_cli',
        'executable_plugin_runtime_client_builds_agent_runtime_parts',
        'non_p0_surfaces_cannot_inherit_executable_plugin_runtime',
        'default_product_shapes_expose_only_disabled_plugin_availability',
        'default_assembled_product_shapes_keep_profile_specific_plugin_availability',
      ],
    },
    {
      path: 'src/crates/execution/plugin-runtime-client/tests/plugin_runtime_client.rs',
      contracts: [
        'client_dispatches_candidates',
        'client_replays_idempotent_dispatch_without_recalling_adapter',
        'concurrent_idempotent_dispatch_reuses_in_flight_response',
        'concurrent_cross_key_dispatch_observes_active_quarantine_before_success',
        'idempotent_dispatch_cache_is_scoped_by_project_workspace_and_source',
        'idempotent_dispatch_cache_does_not_replay_across_events',
        'idempotent_dispatch_cache_is_scoped_by_epoch_changes',
        'idempotent_dispatch_cache_evicts_old_entries',
        'read_model_is_scoped_by_project_and_workspace',
        'read_model_rejects_wrong_workspace_response',
        'active_quarantine_blocks_new_dispatches_until_declared_recovery',
        'active_quarantine_blocks_malformed_follow_up_without_new_quarantine',
        'malformed_dispatch_with_missing_identity_observes_active_quarantine',
        'client_owned_quarantine_is_visible_in_read_model_with_diagnostics',
        'zero_deadline_quarantines_without_adapter_dispatch',
        'malformed_dispatch_envelope_quarantines_without_adapter_dispatch',
        'nonzero_deadline_timeout_quarantines_without_success_effects',
        'adapter_failure_quarantines_without_writing_success',
        'malformed_adapter_success_quarantines_without_effects',
        'permission_prompt_target_mismatch_quarantines_without_effects',
        'final_policy_decision_from_adapter_fails_closed',
        'adapter_id_or_quarantine_with_effects_mismatch_fails_closed',
        'status_quarantine_with_success_effects_fails_closed',
        'disposed_project_rejects_dispatch_and_read_model_reports_statuses',
      ],
    },
    {
      path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/product_sdk_assembly.rs',
      contracts: [
        'product_runtime_parts_can_build_agent_runtime_sdk_without_core',
        'sdk_delivery_profile_builds_shared_runtime_owner_ceiling_without_openbitfun_core',
        'DeliveryProfile::Cli',
        'DeliveryProfile::Sdk',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
      contracts: [
        'remote_workspace_route_root_isolated_from_same_local_path',
        'once_and_always_replies_control_execution_and_remembered_grants',
        'should_retry_tool_attempt',
        'retry_delay_ms',
        'build_normal_tool_json_repair_notice',
        'build_write_tail_closure_notice',
        'normal_json_repair_notice_for_interactive_tools_does_not_claim_file_write',
        'write_tail_closure_notice_keeps_write_continuation_guidance',
        'denied_tool_messages',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/restrictions.rs',
      contracts: [
        'tool_restrictions_for_delegation_policy',
        'miniapp_headless_agent_tool_restrictions',
        'impl From<ToolRestrictionError> for OpenBitFunError',
        'is_local_path_within_root',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/tool_result_storage.rs',
      contracts: ['write_once', 'file\\.flush\\(\\)\\.await'],
    },
    {
      path: 'src/crates/execution/tool-execution/src/pipeline.rs',
      contracts: [
        'ToolBatch',
        'partition_tool_batches',
        'ToolExecutionErrorClass',
        'ToolRetryAttemptFacts',
        'should_retry_tool_attempt',
        'retry_delay_ms',
        'ToolTaskStateKind',
        'should_cancel_tool_state',
        'summarize_dialog_turn_cancellation',
        'ToolCancellationTokenStore',
        'count_tool_states',
        'ToolStateEventFacts',
        'ToolStateEventKind',
        'tool_state_event_data',
        'sanitize_tool_result_for_event',
      ],
    },
    {
      path: 'src/crates/execution/tool-execution/tests/tool_pipeline_planning.rs',
      contracts: [
        'partitions_consecutive_concurrency_safe_tools_into_parallel_batches',
        'retry_policy_preserves_attempt_limit_and_error_class_contract',
        'cancellation_policy_preserves_cancellable_and_terminal_state_contract',
        'dialog_turn_cancellation_summary_counts_cancelled_and_skipped_tasks',
        'cancellation_token_store_cancels_and_removes_tokens',
        'state_counts_preserve_pipeline_stats_contract',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/mcp/server/connection.rs',
      contracts: [
        'send_request_with_id',
        'initialize_timeout',
        'notifications/initialized',
        'pending\\.clear\\(\\)',
        'local_tool_calls_do_not_inherit_initialize_timeout',
        'local_initialize_uses_initialize_timeout',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/mcp/protocol/transport.rs',
      contracts: ['send_request_with_id', '\\.flush\\(\\)\\s*\\.await'],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/framework.rs',
      contracts: [
        'GET_TOOL_SPEC_TOOL_NAME',
        'ToolExposure',
        'ToolManifestPolicyTool',
        'resolve_tool_manifest_policy',
        'default_exposure',
        'build_tool_manifest_policy_tools',
        'PromptVisibleToolManifestItem',
        'build_prompt_visible_tool_manifest_definitions',
        'ContextualToolManifestItem',
        'ToolCatalogSnapshotProvider',
        'GetToolSpecCatalogProvider',
        'ContextualVisibleTools',
        'ContextualToolManifest',
        'resolve_contextual_visible_tools',
        'resolve_contextual_tool_manifest',
        'resolve_contextual_visible_tools_from_provider',
        'resolve_contextual_tool_manifest_from_provider',
        'build_get_tool_spec_catalog_description_from_provider',
        'resolve_get_tool_spec_detail_from_provider',
        'build_get_tool_spec_description',
        'GetToolSpecDeferredToolSummary',
        'GetToolSpecDetail',
        'summarize_get_tool_spec_deferred_tools',
        'resolve_get_tool_spec_detail',
        'build_get_tool_spec_catalog_description',
        'get_tool_spec_input_schema',
        'get_tool_spec_short_description',
        'render_get_tool_spec_tool_use_message',
        'get_tool_spec_is_readonly',
        'get_tool_spec_is_concurrency_safe',
        'validate_get_tool_spec_input',
        'build_get_tool_spec_assistant_detail',
        'build_get_tool_spec_duplicate_load_result',
        'build_get_tool_spec_detail_result',
        'GetToolSpecExecutionPlan',
        'GetToolSpecExecutionError',
        'resolve_get_tool_spec_execution_plan',
        'resolve_get_tool_spec_execution_result_from_provider',
        'GetToolSpecRuntime',
        'call_results',
        'GetToolSpecLoadObservation',
        'collect_loaded_deferred_tool_specs',
        'DeferredToolUsageError',
        'ToolExecutionAccessError',
        'validate_tool_allowed_by_list',
        'validate_deferred_tool_usage',
        'sort_tool_manifest_definitions',
        'is_tool_deferred',
        'get_deferred_tool_names',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/file_guidance.rs',
      contracts: [
        'FILE_TOOL_GUIDANCE_PREFIX',
        'file_tool_guidance_message',
        'is_file_tool_guidance_message',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/tool_result_storage.rs',
      contracts: [
        'ToolResultStoragePolicy',
        'PersistedToolOutput',
        'ToolResultPersistenceCandidate',
        'select_tool_result_indices_for_persistence',
        'sanitize_tool_result_file_component',
        'generate_tool_result_preview',
        'count_tool_result_lines',
        'tool_result_is_persisted_output',
        'build_persisted_tool_output_message',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/tool_execution_presentation.rs',
      contracts: [
        'TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES',
        'USER_STEERING_INTERRUPTED_MESSAGE',
        'ToolExecutionErrorPresentation',
        'render_tool_result_for_assistant',
        'truncate_tool_arguments_preview',
        'truncate_raw_tool_arguments_preview',
        'build_tool_execution_error_presentation',
        'build_user_steering_interrupted_presentation',
        'build_invalid_tool_call_error_message',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
      contracts: [
        'AgentSubmissionPort',
        'SessionTranscriptReader',
        'AgentTurnCancellationPort',
        'AgentSessionManagementPort',
        'runtime_session_summary',
        'AgentSessionSummary',
        'RemoteControlStatePort',
        'generic attachments',
        'DialogTriggerSource',
        'openbitfun_agent_runtime::subagent_task::subagent_task_completion_result',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
      contracts: [
        'AgentSessionReplyRoute',
        'DialogQueuePriority',
        'DialogSessionStateFact',
        'DialogSteerOutcome',
        'DialogSubmissionPolicy',
        'DialogSubmitOutcome',
        'DialogSubmitQueueAction',
        'DialogSubmitQueueFacts',
        'ActiveDialogTurnStore',
        'AgentSessionReplyAction',
        'AgentSessionReplyPlan',
        'BackgroundInjectionKind',
        'DialogReplySuppressionSet',
        'DialogSteeringAction',
        'DialogTurnQueue',
        'SessionAbortFlags',
        'resolve_agent_session_reply_action',
        'resolve_background_delivery_injection',
        'resolve_dialog_submit_queue_action',
        'resolve_dialog_steering_action',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/round_preempt.rs',
      contracts: [
        'openbitfun_agent_runtime',
        'openbitfun_runtime_ports',
        'DialogRoundInjectionSource',
        'RoundInjection',
        'RoundInjectionKind',
        'RoundInjectionTarget',
        'SessionRoundInjectionBuffer',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/goal_mode/mod.rs',
      contracts: [
        'openbitfun_runtime_ports',
        'SetThreadGoalResult',
        'ThreadGoal',
        'ThreadGoalContinuationPlan',
        'ThreadGoalStatus',
        'ThreadGoalToolResponse',
        'THREAD_GOAL_METADATA_KEY',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/core/message.rs',
      contracts: ['openbitfun_runtime_ports', 'CompressionContract', 'CompressionContractItem'],
    },
    {
      path: 'src/crates/assembly/core/src/service/workspace/manager.rs',
      contracts: ['openbitfun_runtime_ports', 'RelatedPath'],
    },
    {
      path: 'src/crates/assembly/core/src/service_agent_runtime.rs',
      contracts: [
        'CoreServiceAgentRuntime',
        'remote_dialog_host',
        'remote_cancel_host',
        'remote_image_context',
        'load_remote_model_catalog',
        'RemoteModelCatalogFacts',
        'RemoteModelCapabilityFact',
        'project_model_reasoning_catalog',
        'build_remote_model_catalog',
        'update_remote_session_model',
        'normalize_remote_session_model_id',
        'normalize_remote_model_selection',
        'normalize_remote_model_selection_contract',
        'remote_chat_messages_from_turns',
        'RemoteDialogSchedulerOutcomeFact',
        'remote_dialog_submit_outcome_from_scheduler',
        'RemoteChatHistoryTurn',
        'build_remote_chat_messages',
        'project_remote_chat_user',
        'load_remote_chat_messages',
        'agent_runtime',
        'agent_runtime_with_dialog_turns',
        'agent_runtime_with_lifecycle_delivery',
        'agent_runtime_with_scheduler_ports',
        'global_agent_runtime_with_lifecycle_delivery',
        'with_lifecycle_delivery_port',
        'agent_input_attachment_from_image_context',
        'AgentDialogTurnRequest',
        'submit_dialog_turn',
        'AgentRuntimeBuilder',
        'remote_control_state_port',
        'CoreRemoteDialogRuntimeHost',
        'CoreRemoteCancelRuntimeHost',
        'CoreRemoteCancelRuntimeHost\\s*\\{[\\s\\S]*\\bruntime:\\s*AgentRuntime',
        'CoreServiceAgentRuntime::agent_runtime_with_scheduler_ports',
        'CoreRemoteWorkspaceFileRuntimeHost',
        'CoreRemoteWorkspaceRuntimeHost',
        'CoreRemoteSessionRuntimeHost',
        'CoreRemoteSessionRuntimeHost\\s*\\{[\\s\\S]*\\bruntime:\\s*AgentRuntime',
        'CoreRemotePollRuntimeHost',
        'CoreRemoteInteractionRuntimeHost',
        'CoreRemoteSessionTrackerHost',
        'RemoteExecutionDispatcher',
        'ImageContextData',
        'agent_input_attachment_from_remote_image_context',
        'AgentSubmissionPort',
        'AgentDialogTurnPort',
        'AgentTurnCancellationPort',
        'AgentSessionManagementPort',
        'with_session_management_port',
        'RemoteControlStatePort',
        'SessionTranscriptReader',
        'core_service_agent_runtime_owner_keeps_coordinator_port_contracts',
        'core_service_agent_runtime_owner_normalizes_remote_session_model_ids',
        'core_service_agent_runtime_owner_normalizes_remote_model_selection_aliases',
        'core_service_agent_runtime_owner_preserves_remote_chat_history_shape',
        'core_service_agent_runtime_owner_preserves_in_progress_remote_assistant_history',
        'core_service_agent_runtime_owner_maps_image_context_to_lifecycle_attachment',
        'core_service_agent_runtime_owner_keeps_scheduler_lifecycle_port_contracts',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
      contracts: [
        'CoreServiceAgentRuntime::agent_runtime',
        'CoreServiceAgentRuntime::agent_runtime_with_scheduler_ports',
        'AgentSessionCreateRequest',
        'AgentSessionListRequest',
        'AgentSessionDeleteRequest',
        'AgentSessionWorkspaceRequest',
        'list_sessions',
        'delete_session',
        'resolve_session_workspace_binding',
        '"createdBy"',
        'AgentTurnCancellationRequest',
        'requester_session_id',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_message_tool.rs',
      contracts: [
        'CoreServiceAgentRuntime::agent_runtime_with_dialog_turns',
        'AgentSessionCreateRequest',
        'AgentSessionListRequest',
        'AgentSessionWorkspaceRequest',
        'list_sessions',
        'resolve_session_workspace_binding',
        '"createdBy"',
        'AgentDialogTurnRequest',
        'AgentDialogPrependedReminder',
        'submit_dialog_turn',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_connect.rs',
      contracts: [
        'pub mod device',
        'pub mod encryption',
        'pub mod pairing',
        'pub mod qr_generator',
        'pub mod relay_client',
        'pub use device::DeviceIdentity',
        'pub use encryption::{decrypt_from_base64, encrypt_to_base64, KeyPair}',
        'PairingState',
        'pub use qr_generator::QrGenerator',
        'RelayClient',
        'RelayEvent',
        'RemoteSessionStateTracker',
        'TrackerEvent',
        'RemoteSessionTrackerHost',
        'RemoteSessionTrackerRegistry',
        'make_slim_tool_params',
        'handle_agentic_event',
        'resolve_remote_agent_type',
        'RemoteImageContext',
        'build_remote_image_contexts',
        'resolve_remote_execution_image_contexts',
        'remote_session_restore_target',
        'RemoteCancelDecision',
        'resolve_remote_cancel_decision',
        'RemoteCancelTaskRequest',
        'RemoteCancelRuntimeHost',
        'cancel_remote_task',
        'RemoteChatHistoryTurn',
        'RemoteChatHistoryRound',
        'RemoteChatHistoryToolItem',
        'build_remote_chat_messages',
        'RemoteChatUserProjection',
        'project_remote_chat_user',
        'REMOTE_FILE_MAX_READ_BYTES',
        'REMOTE_FILE_MAX_CHUNK_BYTES',
        'resolve_remote_file_chunk_range',
        'remote_file_display_name',
        'RemoteWorkspaceFacts',
        'RemoteSessionMetadata',
        'remote_workspace_info_response',
        'remote_recent_workspaces_response',
        'remote_assistant_list_response',
        'RemoteWorkspaceRuntimeHost',
        'handle_remote_workspace_command',
        'remote_workspace_handler_preserves_response_shapes',
        'RemoteInitialSyncRuntimeHost',
        'generate_remote_initial_sync',
        'remote_session_info',
        'remote_session_list_response',
        'remote_initial_sync_response',
        'remote_messages_response',
        'RemoteSessionRuntimeHost',
        'handle_remote_session_command',
        'remote_session_handler_preserves_list_and_create_policy',
        'remote_session_handler_removes_tracker_after_delete_success',
        'RemotePollRuntimeHost',
        'handle_remote_poll_command',
        'remote_poll_handler_preserves_missing_workspace_error',
        'RemoteInteractionRuntimeHost',
        'handle_remote_interaction_command',
        'RemoteDefaultModelsConfig',
        'RemoteModelConfig',
        'RemoteModelCatalog',
        'RemoteModelCapabilityFact',
        'ReasoningCatalogProjection',
        'RemoteModelFacts',
        'RemoteModelCatalogFacts',
        'build_remote_model_catalog',
        'RemoteModelCatalogPollDelta',
        'normalize_remote_session_model_id',
        'normalize_remote_model_selection',
        'remote_model_selection_needs_config',
        'RemoteDialogSchedulerOutcomeFact',
        'remote_dialog_submit_outcome_from_scheduler',
        'RemoteCommand',
        'RemoteResponse',
        'should_send_remote_model_catalog',
        'remote_model_catalog_poll_delta',
        'remote_no_change_poll_response',
        'remote_snapshot_poll_response',
        'remote_persisted_poll_response',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/tests/remote_connect_contracts.rs',
      contracts: [
        'relay_invitations_and_authentication_use_the_same_protocol_for_all_endpoints',
        'remote_connect_lan_url_builder_lives_in_services_owner',
        'remote_connect_command_wire_shape_lives_in_owner_contract',
        'remote_connect_response_wire_shape_lives_in_owner_contract',
        'remote_connect_model_catalog_delta_preserves_poll_invalidation_policy',
        'remote_connect_model_catalog_builder_preserves_config_shape',
        'remote_connect_model_selection_policy_owns_alias_and_config_reference_rules',
        'remote_connect_poll_helpers_preserve_delta_and_completion_policy',
        'remote_connect_image_context_policy_preserves_legacy_fallback_shape',
        'remote_connect_image_context_policy_prefers_explicit_contexts',
        'remote_connect_cancel_and_restore_policy_preserve_runtime_decisions',
        'remote_connect_dialog_submit_outcome_builder_preserves_scheduler_shape',
        'remote_chat_history_assembly_preserves_message_shape_and_item_order',
        'remote_chat_history_assembly_preserves_in_progress_assistant_history',
        'remote_connect_file_transfer_policy_preserves_limits_and_chunk_ranges',
        'remote_connect_file_transfer_policy_preserves_name_fallback',
        'remote_connect_tracker_keeps_finished_turn_snapshot_until_persistence_finalizes',
        'remote_connect_tracker_registry_owns_lifecycle_without_core_state',
        'remote_connect_tracker_ignores_unrelated_direct_session_events',
        'remote_connect_tool_preview_slimming_keeps_short_fields_and_drops_large_strings',
        'remote_connect_workspace_response_helpers_own_wire_shape',
        'remote_connect_session_response_helpers_own_pagination_and_timestamps',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/remote_connect/remote_server.rs',
      contracts: [
        'CoreServiceAgentRuntime',
        'remote_image_context',
        'handle_remote_workspace_command',
        'handle_remote_session_command',
        'generate_remote_initial_sync',
        'handle_remote_poll_command',
        'handle_remote_interaction_command',
        'core_service_agent_runtime_owner_maps_remote_image_context',
        'remote_execution_prefers_unified_image_contexts_over_legacy_images',
        'remote_cancel_decision_preserves_current_turn_boundaries',
        'remote_restore_target_only_restores_cold_sessions_with_workspace_binding',
        'remote_command_snapshot_covers_execution_poll_and_cancel_surfaces',
        'remote_response_snapshot_preserves_active_turn_and_result_shapes',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
      contracts: [
        'AgentDialogTurnPort',
        'AgentLifecycleDeliveryPort',
        'AgentTurnCancellationPort',
        'AgentBackgroundResultRequest',
        'AgentThreadGoalDeliveryRequest',
        'AgentThreadGoalDeliveryKind::ObjectiveUpdated',
        'cancel_active_turn_for_session_from_requester',
        'agent_dialog_turn_image_contexts',
        'agent_dialog_turn_prepended_messages',
        'agent_dialog_turn_attachments_preserve_remote_image_context',
        'agent_dialog_turn_attachments_reject_unknown_kind',
        'agent_dialog_turn_prepended_reminders_preserve_session_message_kind',
        'agent_dialog_turn_prepended_reminders_reject_unknown_kind',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/registry.rs',
      contracts: [
        'from_inner',
        'ProductToolDecoratorRef',
        'ProductToolRuntime',
        'get_deferred_tool_names',
        'resolve_product_readonly_enabled_tools',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime.rs',
      contracts: [
        'ProductToolRuntime',
        'SnapshotToolDecorator',
        'create_product_tool_registry_from_plan',
        'product_assembly_plan_for_profile',
        'product_tool_runtime_owner_preserves_registry_contract',
        'product_tool_runtime_provider_plan_covers_registry_without_owning_order',
        'product_tool_runtime_keeps_no_direct_core_profiles_empty',
        'DeliveryProfile::Sdk',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/snapshot.rs',
      contracts: [
        'ProductSnapshotToolWrapper',
        'SnapshotToolWrapper',
        'wrap_tool_for_snapshot_tracking',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/catalog.rs',
      contracts: [
        'ProductToolCatalogProvider',
        'ToolCatalogSnapshotProvider',
        'GetToolSpecCatalogProvider',
        'get_global_tool_registry',
        'get_agent_registry',
        'ToolCatalogRuntime',
        'product_tool_catalog_runtime',
        'GetToolSpecRuntime',
        'product_get_tool_spec_runtime',
        'resolve_product_tool_manifest',
        'resolve_product_readonly_enabled_tools',
        'resolve_product_get_tool_spec_results',
        'loaded_deferred_tool_specs',
        'product_catalog_provider_default_get_tool_spec_catalog_matches_registry',
        'product_resolved_manifest_owner_matches_legacy_shape',
        'GetToolSpec requires agent type context',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/materialization.rs',
      contracts: [
        'ProductConcreteToolFactory',
        'StaticToolProviderFactory',
        'create_registry_from_static_provider_entries',
        'create_product_tool_registry_from_plan',
        'PRODUCT_TOOL_REGISTRATION_ORDER',
        'MissingRegistrationOrder',
        'unavailable_feature_groups',
        'materialize_tool',
        'GetToolSpecTool',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/framework.rs',
      contracts: [
        'ToolContextFacts',
        'PortableToolContextProvider',
        'ToolWorkspaceKind',
        'StaticToolProvider',
        'StaticToolProviderGroup',
        'StaticToolProviderPlan',
        'StaticToolProviderFactory',
        'StaticToolMaterializationError',
        'materialize_static_tool_provider_groups',
        'ToolRuntimeAssembly',
        'materialized_tool_snapshot',
        'create_registry_from_static_provider_plans',
        'create_registry_from_static_provider_entries',
        'ToolCatalogRuntime',
        'ToolDecoratorRef',
        'SnapshotToolWrapper',
        'SnapshotToolDecorator',
        'create_registry_from_static_providers',
        'install_static_provider',
        'resolve_readonly_enabled_tools',
        'build_get_tool_spec_duplicate_load_result',
        'build_get_tool_spec_detail_result',
        'miniapp_headless_agent_tool_restrictions',
        'tool_restrictions_for_delegation_policy',
        'denied_tool_messages',
        'resolve_get_tool_spec_execution_plan',
        'resolve_get_tool_spec_execution_result_from_provider',
        'GetToolSpecRuntime',
        'call_results',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/tool_snapshot.rs',
      contracts: [
        'MaterializedToolSnapshot',
        'ToolProviderIdentity',
        'ToolEffectFacts',
        'ToolEffectFactsSource',
        'ToolEffectFilter',
        'ToolCallSnapshotGuard',
        'ToolSnapshotCallError',
        'materialize_tool_snapshot',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/mcp_tool_bridge.rs',
      contracts: [
        'build_mcp_tool_bridge_name',
        'McpToolBridgeDefinition',
        'McpToolBridgeBehaviorHints',
        'build_mcp_tool_bridge_definition',
        'mcp_tool_bridge_dynamic_tool_info',
        'validate_mcp_tool_bridge_input',
        'render_mcp_tool_bridge_use_message',
        'render_mcp_tool_bridge_rejected_message',
        'render_mcp_tool_bridge_result_message',
        'build_mcp_tool_bridge_result',
      ],
    },
    {
      path: 'src/crates/execution/tool-contracts/src/acp_tool_bridge.rs',
      contracts: [
        'build_acp_external_agent_tool_name',
        'AcpExternalAgentToolDefinition',
        'build_acp_external_agent_tool_definition',
        'acp_external_agent_tool_input_schema',
        'validate_acp_external_agent_tool_input',
        'render_acp_external_agent_use_message',
        'render_acp_external_agent_rejected_message',
        'render_acp_external_agent_result_message',
        'render_acp_external_agent_result_for_assistant',
        'build_acp_external_agent_tool_result',
      ],
    },
    {
      path: 'src/crates/execution/tool-provider-groups/src/lib.rs',
      contracts: [
        'ToolPackFeatureGroup',
        'ToolProviderGroupPlan',
        'all_feature_groups',
        'enabled_feature_groups',
        'unavailable_feature_groups',
        'product_tool_provider_group_plan',
        'ToolProviderGroupPlanSelectionError',
        'try_product_tool_provider_group_plan_for_ids',
        'product_provider_group_plan_selector_rejects_unknown_provider_ids',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/tool_adapter.rs',
      contracts: [
        'ToolRegistryItem',
        'ContextualToolManifestItem',
        'Tool::dynamic_tool_info',
        'Tool::is_readonly',
        'Tool::is_enabled',
        'Tool::description_with_context',
        'Tool::input_schema_for_model_with_context',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/manifest_resolver.rs',
      contracts: [
        'resolve_tool_manifest',
        'GET_TOOL_SPEC_TOOL_NAME',
        'resolve_product_resolved_visible_tools',
        'resolve_product_resolved_tool_manifest',
        'deferred_tool_names',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/get_tool_spec_tool.rs',
      contracts: [
        'GetToolSpecTool',
        'build_deferred_tools_context_section',
        'product_get_tool_spec_runtime',
        'with_runtime',
        'resolve_product_get_tool_spec_results',
        'map_get_tool_spec_execution_error',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/framework.rs',
      contracts: [
        'ToolExposure',
        'ToolUseContext',
        'pub use crate::agentic::tools::tool_context_runtime::ToolUseContext',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/tool_context_runtime.rs',
      contracts: [
        'pub struct ToolUseContext',
        'to_tool_context_facts',
        'project_tool_context_facts',
        'build_tool_runtime_custom_data',
        'delegation_policy_from_custom_data',
        'impl PortableToolContextProvider for ToolUseContext',
        'tool_context_facts_omit_runtime_owner_fields_even_when_context_is_populated',
        'customData',
        'cancellationToken',
        'loaded_deferred_tool_specs',
        'impl ToolUseContext',
        'record_light_checkpoint',
        'build_runtime_light_checkpoint',
        'LightCheckpointWorkspaceFacts::LocalWorkspace',
        'call_with_tool_runtime_hooks',
        'call_tool_with_runtime_hooks',
        'call_records_deep_review_read_file_measurement_without_touching_result',
        'build_tool_use_context_for_task',
        'build_tool_description_context',
        'ensure_current_workspace_runtime',
        'resolve_tool_path',
        'enforce_path_operation',
        'workspace_path_resolution_rejects_absolute_paths_outside_remote_workspace',
        'runtime_uri_resolution_rejects_different_workspace_scope',
        'path_policy_allows_only_configured_local_roots',
        'tool_call_runtime_hook_returns_cancelled_before_impl_completes',
        'tool_task_context_materialization_preserves_runtime_fields',
        'tool_description_context_preserves_manifest_custom_data_shape',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
      contracts: [
        'validate_tool_execution_admission',
        'loaded_deferred_tool_specs',
        'GetToolSpec',
        'render_tool_result_for_assistant',
        'build_tool_execution_error_presentation',
        'build_user_steering_interrupted_presentation',
        'build_invalid_tool_call_error_message',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/execution/execution_engine.rs',
      contracts: [
        'collect_product_loaded_deferred_tool_specs',
        'loaded_deferred_tool_specs',
        'deferred_tool_names',
        'GetToolSpec',
        'should_post_process_research_report',
        'openbitfun_services_integrations::deep_research::run_for_session_workspace',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/loaded_spec_state.rs',
      contracts: [
        'collect_product_loaded_deferred_tool_specs',
        'GetToolSpecLoadObservation',
        'collect_loaded_deferred_tool_specs',
        'product_loaded_spec_state_dedupes_and_filters_results',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/agents/registry/availability.rs',
      contracts: [
        'resolve_availability',
        'resolve_override_layers',
        'AgentSubagentOverrideState',
        'resolve_subagent_availability',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/agents/registry/types.rs',
      contracts: ['SubagentQueryContext', 'SubagentListScope', 'default_enabled', 'effective_enabled', 'SubagentStateReason'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/agents/definitions/subagents/mod.rs',
      contracts: ['mod general_purpose', 'GeneralPurposeAgent'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/agents/registry/builtin.rs',
      contracts: ['builtin_agent_specs', 'runtime_agents::default_model_id_for_builtin_agent'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/input.rs',
      contracts: [
        'fork_context',
        'SubagentContextMode::Fork',
        'run_in_background',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
      contracts: [
        'child_delegation_policy',
        'start_background_subagent',
        'bg_task_id',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/background.rs',
      contracts: ['Background subagent started successfully'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/tests.rs',
      contracts: [
        'background_subagent_start_acknowledgement_exposes_agent_wait_task_id',
        '<background_task',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
      contracts: [
        'deliver_background_result',
        'BackgroundResult',
        'AgentSession',
      ],
    },
    {
      path: 'src/apps/cli/src/modes/chat/worktree.rs',
      contracts: [
        'WorktreeService::bind_session',
        'is_remote_workspace',
        'does not fall back to controller-local services',
      ],
    },
    {
      path: 'src/apps/cli/src/ui/startup.rs',
      contracts: [
        'show_available_subagent_list',
        'show_subagent_config_selector',
        'get_subagents_for_query',
        'SubagentSummary',
        'update_subagent_override',
      ],
    },
    {
      path: 'src/apps/cli/src/ui/subagent_selector.rs',
      contracts: [
        'SubagentSelectorAction',
        'show_list',
        'show_config',
        'enabled',
        'render_subagent_line',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/subagent_task.rs',
      contracts: [
        'SubagentTaskCompletionResultInput',
        'subagent_task_completion_result',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/deep_review/task_execution.rs',
      contracts: [
        'deep_review_task_completion_result',
        'crate::subagent_task::subagent_task_completion_result',
        'deep_review_cancelled_reviewer_result',
        'should_emit_deep_review_retry_guidance',
        'deep_review_retry_guidance',
        'auto_retry_suppression_reason',
        'ensure_deep_review_auto_retry_allowed',
        'DeepReviewProviderCapacityQueueRuntime',
        'DeepReviewProviderCapacityRetryRuntime',
        'DeepReviewProviderCapacityRetryDecision',
        'DeepReviewReviewerAdmissionQueueRuntime',
        'QueueWaitTimer',
      ],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/deep_review/report.rs',
      contracts: ['fill_deep_review_runtime_tracker_signal'],
    },
    {
      path: 'src/crates/execution/agent-runtime/src/deep_review/diagnostics.rs',
      contracts: ['deep_review_runtime_diagnostics_log_line'],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/deep_review/task_adapter.rs',
      contracts: [
        'runtime_task_execution::deep_review_cancelled_reviewer_result',
        'runtime_task_execution::should_emit_deep_review_retry_guidance',
        'runtime_task_execution::deep_review_retry_guidance',
        'runtime_task_execution::auto_retry_suppression_reason',
        'runtime_task_execution::ensure_deep_review_auto_retry_allowed',
        'runtime_task_execution::DeepReviewProviderCapacityQueueRuntime::start',
        'DeepReviewProviderCapacityRetryRuntime',
        'DeepReviewProviderCapacityRetryDecision',
        'runtime_task_execution::DeepReviewReviewerAdmissionQueueRuntime::start',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/deep_review.rs',
      contracts: [
        'deep_review_task_adapter::should_emit_deep_review_retry_guidance',
        'deep_review_task_adapter::auto_retry_suppression_reason',
        'deep_review_task_adapter::ensure_deep_review_auto_retry_allowed',
        'deep_review_task_adapter::deep_review_cancelled_reviewer_result',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
      contracts: [
        'deep_review_task_adapter::deep_review_retry_guidance',
        'openbitfun_agent_runtime::subagent_task::subagent_task_completion_result',
        'DeepReviewProviderCapacityRetryRuntime::default',
        'DeepReviewProviderCapacityRetryDecision::WaitForCapacity',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/deep_research.rs',
      contracts: ['run_for_session_workspace', 'try_renumber_research_report', 'renumber_research_report', 'report.md', 'citations.md', 'display_map', 'REJECTED'],
    },
    {
      path: 'src/crates/execution/agent-workflows/src/deep_research.rs',
      contracts: ['renumber_research_report', 'ResearchCitationRenumberOutput', 'ResearchCitationDisplayMapEntry', 'rejected_index_rows_dropped', 'should_post_process_research_report'],
    },
    {
      path: 'src/crates/execution/agent-workflows/tests/deep_research_contracts.rs',
      contracts: ['deep_research_citation_renumber_owner_preserves_report_and_display_map_contracts', 'deep_research_citation_renumber_owner_is_idempotent_without_citations'],
    },
    {
      path: 'src/crates/assembly/core/src/service/workspace/service.rs',
      contracts: ['prepare_startup_restored_workspaces', 'WorkspaceKind::Remote', 'ensure_remote_workspace_runtime', 'sshHost'],
    },
    {
      path: 'src/crates/services/services-integrations/src/workspace_search/mod.rs',
      contracts: ['flashgrep'],
    },
    {
      path: 'src/crates/services/services-integrations/src/workspace_search/service.rs',
      contracts: ['WorkspaceSearchRepoConfig'],
    },
    {
      path: 'src/crates/services/services-integrations/src/workspace_search/result_mapping.rs',
      contracts: ['convert_hits_to_file_search_results', 'line_hydration', 'preview_inside'],
    },
    {
      path: 'src/crates/services/services-integrations/src/workspace_search/line_hydration.rs',
      contracts: ['hydrate_grouped_line_matches', 'MAX_HYDRATED_LINE_COLUMNS', 'ContentMatchPreviewBuilder'],
    },
    {
      path: 'src/crates/services/services-core/src/filesystem/content_preview.rs',
      contracts: ['compile_content_search_regex', 'build_content_match_preview', 'ContentMatchPreviewBuilder'],
    },
    {
      path: 'src/crates/assembly/core/src/service/search/service.rs',
      contracts: ['owner::WorkspaceSearchService::new_with_hooks', 'CoreWorkspaceSearchRuntimeHooks', 'WorkspaceSearchRepoConfig', 'get_global_config_service', 'ensure_workspace_gitignore_ignores_openbitfun'],
    },
    {
      path: 'src/crates/assembly/core/src/service/search/remote.rs',
      contracts: ['ServiceRemoteWorkspaceSearchService', 'impl RemoteWorkspaceSearchProvider for CoreRemoteWorkspaceSearchProvider', 'require_workspace(workspace_id)', 'open_workspace_stdio', 'RemoteWorkspaceSearchStdioProtocol'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/mod.rs',
      contracts: [
        'not(feature = "remote-ssh-concrete")',
        'pub mod disabled',
        'build_remote_scope',
        'shell_escape',
        'should_retry_remote_scan_fallback_as_files_with_matches',
        'remote_workspace_search_paths_preserve_current_contract',
        'remote_scan_fallback_retry_policy_preserves_current_contract',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/service.rs',
      contracts: ['RemoteWorkspaceSearchProvider', 'RemoteWorkspaceSearchService', 'RemoteWorkspaceSearchStdioProtocol', 'REMOTE_STDIO_SESSIONS', 'ensure_remote_search_context', 'fallback_query', 'remote_search_rejects_non_linux_before_stdio_open'],
    },
    {
      path: 'src/crates/assembly/core/src/service/search/mod.rs',
      contracts: [
        'feature = "ssh-remote"',
        'remote_disabled',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/search/remote_disabled.rs',
      contracts: ['Remote SSH search is disabled', 'remote_workspace_search_service_for_workspace'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/disabled.rs',
      contracts: ['Remote SSH search is disabled', 'RemoteWorkspaceSearchService', 'pub async fn search_content'],
    },
    {
      path: 'src/crates/assembly/core/Cargo.toml',
      contracts: [
        'openbitfun-product-capabilities = \\{ path = "\\.\\.\\/product-capabilities", optional = true \\}',
        'openbitfun-ai-adapters = \\{ path = "\\.\\.\\/\\.\\.\\/adapters\\/ai-adapters", optional = true \\}',
        'openbitfun-tool-packs = \\{ path = "\\.\\.\\/\\.\\.\\/execution\\/tool-provider-groups", optional = true \\}',
        'openbitfun-services-integrations = \\{ path = "\\.\\.\\/\\.\\.\\/services\\/services-integrations", optional = true \\}',
        'openbitfun-product-domains = \\{ path = "\\.\\.\\/\\.\\.\\/contracts\\/product-domains", optional = true \\}',
        'dep:openbitfun-ai-adapters',
        'ai-adapter-runtime',
        'canvas-runtime',
        'openbitfun-services-integrations\\/canvas-runtime',
        'openbitfun-services-integrations\\/function-agents',
        'openbitfun-services-integrations\\/miniapp-runtime',
        'dep:openbitfun-product-capabilities',
        'dep:openbitfun-tool-packs',
        'tools-basic',
        'openbitfun-tool-packs\\/basic',
        'agent-runtime',
        'dep:openbitfun-product-domains',
        'openbitfun-product-domains\\/external-sources',
        'openbitfun-product-domains\\/function-agents',
        'openbitfun-product-domains\\/miniapp',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/lib.rs',
      contracts: [
        'feature = "agent-runtime"',
        'pub mod agentic',
        'feature = "external-sources"',
        'mod external_subagents',
        'feature = "function-agents"',
        'pub mod function_agents',
        'feature = "tools-miniapp"',
        'pub mod miniapp',
        'feature = "agent-runtime"',
        'service_agent_runtime',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/infrastructure/mod.rs',
      contracts: [
        'feature = "ai-adapter-runtime"',
        'pub mod ai',
        'pub mod subscription_auth',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/util/types/ai.rs',
      contracts: [
        'openbitfun_core_types',
        'feature = "ai-adapter-runtime"',
        'GeminiResponse',
        'GeminiUsage',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/mod.rs',
      contracts: [
        'feature = "announcement"',
        'pub mod announcement',
        'feature = "file-watch"',
        'file_watch',
        'feature = "git"',
        'pub mod git',
        'feature = "agent-runtime"',
        'pub mod mcp',
        'feature = "agent-runtime"',
        'pub mod remote_connect',
        'feature = "review-platform"',
        'pub mod review_platform',
        'feature = "agent-runtime"',
        'pub mod search',
        'feature = "agent-runtime"',
        'pub mod snapshot',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/config/mod.rs',
      contracts: ['feature = "agent-runtime"', 'mode_config_canonicalizer'],
    },
    {
      path: 'src/crates/assembly/core/src/service/workspace/manager.rs',
      contracts: [
        'feature = "git"',
        'global_worktree_topology_service',
        'return None',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/workspace_runtime/service.rs',
      contracts: [
        'feature = "agent-runtime"',
        'WorkspaceBinding',
        'ensure_runtime_for_workspace_binding',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/dispatch/mod.rs',
      contracts: [
        'feature = "agent-runtime"',
        'not\\(feature = "agent-runtime"\\)',
        'release_baseline_claim',
        'DispatchStoreError::ClaimRelease',
      ],
    },
    {
      path: 'src/crates/interfaces/acp/src/client/manager.rs',
      contracts: ['CLIENT_STARTUP_TIMEOUT_SECS', 'startup_timeout_error_message', 'formats_startup_timeout_error_message'],
    },
    {
      path: 'src/web-ui/src/flow_chat/tool-cards/FileOperationToolCard.tsx',
      contracts: [
        'InlineDiffPreview',
        "previewVariant === 'completed-diff'",
        'originalContent=\\{oldStringContent\\}',
        'modifiedContent=\\{newStringContent\\}',
        'originalContent=""',
        'modifiedContent=\\{contentPreview\\}',
      ],
    },
    {
      path: 'src/web-ui/src/main.tsx',
      contracts: ['startupTrace', 'backgroundTaskScheduler', 'initializeAllTools', 'after_render_start'],
    },
    {
      path: 'src/web-ui/src/shared/utils/startupTrace.ts',
      contracts: [
        'sanitizeTraceData',
        'isRemoteTraceRequest',
        'recordApiCall',
        'flushSummary',
        'markPhaseAfterAnimationFrames',
      ],
    },
    {
      path: 'src/web-ui/src/shared/utils/backgroundTaskScheduler.ts',
      contracts: [
        'BackgroundTaskScheduler',
        'inFlightKey',
        'AbortController',
        'BackgroundTaskCancelledError',
        'cancelIdle',
      ],
    },
    {
      path: 'src/web-ui/src/tools/initializeTools.ts',
      contracts: ['initializeAllTools', 'initializeGit', 'does not import every tool'],
    },
    {
      path: 'src/web-ui/src/tools/editor/services/MonacoStartupWarmup.ts',
      contracts: ['scheduleMonacoStartupWarmup', 'backgroundTaskScheduler', 'startup:monaco-warmup'],
    },
    {
      path: 'src/web-ui/src/flow_chat/services/flow-chat-manager/SessionModule.ts',
      contracts: ['historical_session_hydrate_request', 'Load history in the background', "historyState: 'ready'"],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/storage.rs',
      contracts: [
        'ServiceMiniAppStorage',
        'map_storage_error',
        'MiniAppImportBundleWriteRequest',
        'read_import_meta_json',
        'write_import_bundle',
        'MiniAppStoragePort',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/miniapp/storage.rs',
      contracts: [
        'pub struct MiniAppStorage',
        'MiniAppStorageError',
        'MiniAppImportBundleWriteRequest',
        'read_import_meta_json',
        'write_import_bundle',
        'tokio::fs::read_to_string',
        'tokio::fs::write',
        'tokio::fs::remove_dir_all',
        'MiniAppStorageLayout',
        'MiniAppStoragePort',
        'storage_port_adapter_preserves_existing_file_lifecycle',
        'import_bundle_io_preserves_copy_and_fallback_contract',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/builtin/mod.rs',
      contracts: [
        'BUILTIN_APPS',
        'seed_builtin_miniapps_with_host',
        'BuiltinMiniAppSeedHost',
        'CoreBuiltinMiniAppSeedHost',
        'mark_builtin_update_available',
        'miniapp_builtin_io::prepare_builtin_seed_bundle_files',
        'read_builtin_install_marker',
        'miniapp_builtin_io::read_builtin_install_marker',
        'write_builtin_install_marker',
        'miniapp_builtin_io::write_builtin_install_marker',
        'recompile',
        'load_customization_metadata',
        'available_builtin_update',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/miniapp/builtin_io.rs',
      contracts: [
        'read_builtin_install_marker',
        'parse_builtin_install_marker',
        'write_builtin_install_marker',
        'serialize_builtin_install_marker',
        'prepare_builtin_seed_bundle_files',
        'builtin_source_files',
        'build_builtin_seed_meta',
        'preserved_builtin_created_at',
        'BUILTIN_PLACEHOLDER_COMPILED_HTML',
        'storage.json',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/builtin.rs',
      contracts: [
        'BUILTIN_APPS',
        'BuiltinMiniAppBundle',
        'BuiltinInstallMarker',
        'BUILTIN_INSTALL_MARKER',
        'builtin_content_hash',
        'should_seed_builtin_app',
        'BuiltinSeedArtifacts',
        'BuiltinSeedCheck',
        'BuiltinSeedAction',
        'BuiltinMiniAppSeedHost',
        'seed_builtin_miniapps_with_host',
        'seed_builtin_miniapp_with_host',
        'BuiltinMiniAppSeedOutcome',
        'resolve_builtin_seed_check',
        'resolve_builtin_seed_action',
        'serialize_builtin_install_marker',
        'parse_builtin_install_marker',
        'builtin_source_files',
        'BUILTIN_PLACEHOLDER_COMPILED_HTML',
        'build_builtin_package_json',
        'preserved_builtin_created_at',
        'build_builtin_seed_meta',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/host_dispatch.rs',
      contracts: [
        'dispatch_host',
        'openbitfun_services_integrations::miniapp::host_dispatch::dispatch_host',
        'map_host_dispatch_error',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/miniapp/host_dispatch.rs',
      contracts: [
        'dispatch_host',
        'split_host_method',
        'dispatch_fs',
        'plan_fs_legacy_path_check',
        'plan_fs_host_call',
        'fs_policy_scopes',
        'MiniAppPermissionPolicyRequest::from_paths',
        'resolve_policy_with_request',
        'fs_resolved_path_allowed',
        'dispatch_shell',
        'plan_shell_host_call',
        'shell_exec_default_env',
        'command_basename_allowed',
        'host_allowed_by_allowlist',
        'process_manager::create_tokio_command',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/js_worker_pool.rs',
      contracts: [
        'MiniAppRuntimePort',
        'ServiceJsWorkerPool',
        'CoreMiniAppWorkerEventSink',
        'emit_global_event',
        'map_worker_pool_error',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/js_worker.rs',
      contracts: [
        'pub use openbitfun_services_integrations::miniapp::worker::{',
        'MiniAppWorkerEventSink',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/miniapp/worker.rs',
      contracts: [
        'pub struct JsWorker',
        'pub trait MiniAppWorkerEventSink',
        'process_manager::create_tokio_command',
        'PendingResponseMap',
        'uuid::Uuid::new_v4',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/miniapp/worker_pool.rs',
      contracts: [
        'pub struct JsWorkerPool',
        'MiniAppWorkerPoolError',
        'worker_pool_at_capacity',
        'select_lru_worker',
        'plan_install_deps',
        'process_manager::create_tokio_command',
        'MiniAppRuntimePort',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/function_agents/port_adapters.rs',
      contracts: [
        'CoreFunctionAgentGitAdapter',
        'FunctionAgentGitPort',
        'FunctionAgentGitService::git_commit_snapshot',
        'CoreFunctionAgentAiAdapter',
        'FunctionAgentAiPort',
        'git_adapter_commit_snapshot_keeps_staged_diff_and_unstaged_count_separate',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/remote_connect/bot/command_router.rs',
      contracts: [
        'CoreServiceAgentRuntime',
        'agent_runtime',
        'build_remote_session_create_request',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/product_domain_runtime.rs',
      contracts: [
        'CoreProductDomainRuntime',
        'miniapp_runtime_facade',
        'function_agent_git_adapter',
        'function_agent_ai_adapter',
        'function_agent_runtime_facade',
        'CoreFunctionAgentGitAdapter',
        'CoreFunctionAgentAiAdapter',
        'MiniAppRuntimeFacade',
        'MiniAppStoragePort',
        'FunctionAgentRuntimeFacade',
        'FunctionAgentGitPort',
        'FunctionAgentAiPort',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/service/remote_ssh/mod.rs',
      contracts: ['openbitfun_services_integrations::remote_ssh', 'pub mod manager', 'pub mod remote_fs', 'pub mod remote_terminal', 'pub mod workspace_state'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/mod.rs',
      contracts: ['mod disabled', 'pub use disabled', 'remote-ssh-concrete', 'pub mod manager', 'mod remote_exec', 'pub mod remote_fs', 'pub mod remote_terminal'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/disabled.rs',
      contracts: ['Remote SSH support is disabled', 'SSHConnectionManager', 'RemoteFileService', 'RemoteTerminalManager'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/manager.rs',
      contracts: [
        'SSHConnectionManager',
        'russh::client::connect_stream',
        'SftpSession',
        'retains_password_connection_and_workspace_without_vault_entry',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/remote_exec.rs',
      contracts: ['RemoteExecProcessManager', 'GLOBAL_REMOTE_EXEC_MANAGER', 'remote_exec_session_ids_match_local_test_baseline'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/remote_fs.rs',
      contracts: ['RemoteFileService', 'sftp_read', 'sftp_write'],
    },
    {
      path: 'src/crates/services/services-integrations/src/remote_ssh/remote_terminal.rs',
      contracts: ['RemoteTerminalManager', 'PtyCommand', 'channel.window_change'],
    },
    {
      path: 'src/crates/services/services-core/src/workspace_identity.rs',
      contracts: [
        'WorkspaceSessionIdentity',
        'workspace_session_identity',
        'remote_workspace_runtime_root',
        'remote_workspace_session_mirror_dir',
        'canonicalize_local_workspace_root',
        'normalize_local_workspace_root_for_stable_id',
        'local_workspace_roots_equal',
        'unresolved_remote_session_storage_dir',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/runtime_facade.rs',
      contracts: [
        'MiniAppRuntimeFacade',
        'create_app',
        'persist_update_result_for_app',
        'persist_draft_for_app',
        'persist_draft_source_sync_result',
        'persist_draft_permission_update_result',
        'apply_draft_app',
        'mark_builtin_update_available',
        'mark_deps_installed_state',
        'persist_sync_from_fs_result_for_app',
        'persist_import_runtime_state',
        'pub async fn import_from_path',
        'MiniAppImportPort',
        'MiniAppCompilePort',
        'MiniAppImportBundleWriteRequest',
        'build_import_bundle_plan',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/compiler.rs',
      contracts: [
        'MiniAppCompileRequest',
        'from_paths',
        'compile_with_request',
        'compile_request_from_paths_preserves_runtime_paths',
        'compile_with_request_preserves_legacy_compile_output',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/permission_policy.rs',
      contracts: [
        'MiniAppPermissionPolicyRequest',
        'from_paths',
        'resolve_policy_with_request',
        'permission_policy_request_preserves_path_scope_and_granted_paths',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/storage.rs',
      contracts: [
        'MiniAppStorageLayout',
        'META_JSON',
        'source_file_path',
        'versions_dir',
        'DRAFT_JSON',
        'draft_dir',
        'customization_path',
        'REQUIRED_SOURCE_FILES',
        'PLACEHOLDER_COMPILED_HTML',
        'MiniAppImportLayout',
        'build_import_fallbacks',
        'MiniAppImportBundlePlan',
        'MiniAppImportBundlePlanError',
        'MiniAppImportBundleWriteRequest',
        'build_import_bundle_plan',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/lifecycle.rs',
      contracts: [
        'MiniAppCreateInput',
        'MiniAppUpdatePatch',
        'build_created_app',
        'apply_update_patch',
        'prepare_draft_app',
        'apply_draft_source_sync_result',
        'apply_draft_permission_update_result',
        'apply_draft_to_active',
        'mark_deps_installed_state',
        'clear_worker_restart_required_state',
        'prepare_rollback_app',
        'apply_recompile_result',
        'apply_sync_from_fs_result',
        'apply_import_runtime_state',
        'prepare_imported_meta',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/draft.rs',
      contracts: ['MiniAppDraftManifest', 'MiniAppDraft', 'build_draft_manifest', 'build_draft_response'],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/runtime.rs',
      contracts: [
        'runtime_lookup_order',
        'detect_runtime',
        'DefaultMiniAppRuntimeProbe',
        'MiniAppRuntimeProbe',
        'detect_runtime_with_probe',
        'which::which',
        'std::fs::read_dir',
        'create_version_command',
        'candidate_executable_path',
        'versioned_executable_candidate',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/worker.rs',
      contracts: [
        'InstallDepsPlan',
        'plan_install_deps',
        'worker_pool_capacity',
        'worker_idle_timeout_ms',
        'worker_is_idle',
        'select_lru_worker',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/host_routing.rs',
      contracts: [
        'split_host_method',
        'FsAccessMode',
        'fs_method_access_mode',
        'MiniAppFsHostCallPlan',
        'plan_fs_host_call',
        'plan_fs_legacy_path_check',
        'fs_policy_scopes',
        'fs_resolved_path_allowed',
        'command_basename_for_allowlist',
        'command_basename_allowed',
        'host_allowed_by_allowlist',
        'shell_exec_first_token',
        'shell_exec_input_is_empty',
        'shell_exec_cwd',
        'shell_exec_timeout_ms',
        'shell_exec_default_env',
        'MiniAppShellHostCallPlan',
        'plan_shell_host_call',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/exporter.rs',
      contracts: ['MISSING_JS_RUNTIME_MESSAGE', 'export_runtime_label', 'build_export_check_result'],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/exporter.rs',
      contracts: ['detect_runtime', 'build_export_check_result', 'Export not yet implemented'],
    },
    {
      path: 'src/crates/contracts/product-domains/src/miniapp/customization.rs',
      contracts: [
        'MiniAppCustomizationMetadata',
        'MiniAppDeclinedBuiltinUpdate',
        'MiniAppPermissionDiff',
        'diff_permissions',
        'apply_draft_customization_metadata',
        'mark_builtin_update_available_metadata',
        'decline_builtin_update_metadata',
        'is_current_declined_builtin_update',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/manager.rs',
      contracts: [
        'CoreProductDomainRuntime',
        'MiniAppRuntimeFacade',
        'create_app',
        'persist_update_result_for_app',
        'persist_draft_for_app',
        'persist_draft_source_sync_result',
        'persist_draft_permission_update_result',
        'apply_draft_app',
        'mark_builtin_update_available',
        'decline_builtin_update',
        'persist_sync_from_fs_result_for_app',
        'compile_source',
        'MiniAppCompileRequest::from_paths',
        'compile_with_request',
        'MiniAppPermissionPolicyRequest::from_paths',
        'resolve_policy_with_request',
        'MiniAppCompilePort',
        'MiniAppImportFromPathRequest',
        'import_from_path',
        'runtime_preflight_preserves_recompile_sync_rollback_and_deps_state',
        'import_from_path_preserves_fallback_files_recompile_and_runtime_state',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/function_agents/port_adapters.rs',
      contracts: [
        'prepare_commit_ai_prompt',
        'parse_commit_ai_response',
        'send_message',
        'AgentError::internal_error',
        'CoreCommitAiAnalysisService',
        'CoreCommitAiAnalysisService::new_with_task_config',
        'parse_commit_response_preserves_product_domain_response_policy',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/src/function_agents.rs',
      contracts: [
        'FunctionAgentGitService',
        'git_commit_snapshot',
      ],
    },
    {
      path: 'src/crates/services/services-integrations/tests/function_agent_contracts.rs',
      contracts: [
        'git_service_builds_commit_snapshot_from_staged_diff_without_unstaged_content',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/function_agents/git-func-agent/ai_service.rs',
      contracts: ['CoreCommitAiAnalysisService as AIAnalysisService'],
    },
    {
      path: 'src/crates/assembly/core/src/function_agents/git-func-agent/commit_generator.rs',
      contracts: ['CoreProductDomainRuntime', 'generate_function_agent_commit_message'],
    },
    {
      path: 'src/crates/contracts/product-domains/src/function_agents/ports.rs',
      contracts: [
        'FunctionAgentRuntimeFacade',
        'generate_commit_message',
      ],
    },
    {
      path: 'src/crates/contracts/product-domains/src/function_agents/common.rs',
      contracts: ['extract_json_from_ai_response', 'try_repair_json'],
    },
    {
      path: 'src/crates/contracts/product-domains/src/function_agents/git_func_agent/utils.rs',
      contracts: [
        'COMMIT_MESSAGE_PROMPT',
        'parse_commit_analysis_value',
        'parse_commit_analysis_json',
        'truncate_diff_for_commit_prompt',
        'prepare_commit_prompt',
        'prepare_commit_ai_prompt',
        'parse_commit_ai_response',
      ],
    },
    {
      path: 'src/crates/assembly/core/src/miniapp/runtime_detect.rs',
      contracts: ['pub use openbitfun_product_domains::miniapp::runtime::{', 'detect_runtime'],
    },
  ];
  for (const { path, contracts } of requiredContentContracts) {
    const matchingRules = requiredContentRules.filter((rule) => rule.path === path);
    if (matchingRules.length === 0) {
      throw new Error(`missing owner content anchor rule for ${path}`);
    }
    const ruleText = matchingRules
      .flatMap((rule) => rule.patterns)
      .map((pattern) => pattern.regex.source)
      .join('\n');
    for (const contract of contracts) {
      if (!regexSourceContainsContract(ruleText, contract)) {
        throw new Error(`owner content anchor rule for ${path} must require: ${contract}`);
      }
    }
  }

  const dispatchClaimReleaseRule = requiredContentRules
    .find((rule) => rule.path === 'src/crates/assembly/core/src/service/dispatch/mod.rs')
    ?.patterns.find((pattern) => pattern.message === 'no-default dispatch claim release must fail closed');
  if (!dispatchClaimReleaseRule) {
    throw new Error('missing no-default dispatch claim release boundary rule');
  }
  const failClosedDispatchRelease = `
#[cfg(not(feature = "agent-runtime"))]
async fn release_baseline_claim(release: BaselineClaimRelease) -> Result<(), DispatchStoreError> {
    Err(DispatchStoreError::ClaimRelease(format!("job_id={}", release.job_id)))
}`;
  const unsafeDispatchRelease = `
#[cfg(not(feature = "agent-runtime"))]
async fn release_baseline_claim(release: BaselineClaimRelease) -> Result<(), DispatchStoreError> {
    let _ignored = DispatchStoreError::ClaimRelease(format!("job_id={}", release.job_id));
    Ok(())
}`;
  if (!dispatchClaimReleaseRule.regex.test(failClosedDispatchRelease)) {
    throw new Error('no-default dispatch claim release rule must accept a direct fail-closed return');
  }
  if (dispatchClaimReleaseRule.regex.test(unsafeDispatchRelease)) {
    throw new Error('no-default dispatch claim release rule must reject a discarded error followed by success');
  }

  const sessionControlRuleText = forbiddenRuleTextForPath(
    'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
  );
  if (!sessionControlRuleText.includes('create_session_with_workspace_and_creator')) {
    throw new Error('SessionControl old create-path boundary rule must cover legacy create path');
  }

  const sdkSmokeRuleText = forbiddenRuleTextForPath(
    'src/crates/execution/agent-runtime/tests/agent_session_contracts/sdk_smoke.rs',
  );
  for (const forbiddenSdkSmokeImport of [
    'openbitfun_runtime_services::test_support',
    'FakeRuntimeServicesProvider',
  ]) {
    if (!sdkSmokeRuleText.includes(forbiddenSdkSmokeImport)) {
      throw new Error(
        `SDK smoke boundary rule must forbid ${forbiddenSdkSmokeImport}`,
      );
    }
  }

  const remoteWorkspaceRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/remote_ssh/workspace_state.rs',
  );
  if (!remoteWorkspaceRule) {
    throw new Error('missing remote SSH workspace_state boundary rule');
  }
  const remoteWorkspaceHelpers = [
    'LOCAL_WORKSPACE_SSH_HOST',
    'normalize_remote_workspace_path',
    'sanitize_ssh_connection_id_for_local_dir',
    'sanitize_remote_mirror_path_component',
    'sanitize_ssh_hostname_for_mirror',
    'remote_root_to_mirror_subpath',
    'workspace_logical_key',
    'local_workspace_stable_storage_id',
    'remote_workspace_stable_id',
    'unresolved_remote_session_storage_key',
    'RegisteredRemoteWorkspace',
    'RemoteWorkspaceEntry',
    'RemoteWorkspaceState',
    'registration_matches_path',
    'dunce::canonicalize',
    'path_buf_to_stable_local_root_string',
    'join\\("_unresolved"\\)',
  ];
  const ruleText = remoteWorkspaceRule.patterns.map((pattern) => pattern.regex.source).join('\n');
  for (const helper of remoteWorkspaceHelpers) {
    if (!ruleText.includes(helper)) {
      throw new Error(`remote SSH workspace boundary rule must forbid helper: ${helper}`);
    }
  }

  const announcementStateStoreRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/announcement/state_store.rs',
  );
  if (!announcementStateStoreRule) {
    throw new Error('missing announcement state store boundary rule');
  }

  const mcpProcessRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/server/process.rs',
  );
  if (!mcpProcessRule) {
    throw new Error('missing MCP server process boundary rule');
  }
  const mcpProcessHelpers = [
    'MCPServerType',
    'MCPServerStatus',
    'is_auth_error',
    'AUTHORIZATION_KEYS',
    'contains_key\\("Authorization"\\)',
    'process_manager::create_tokio_command',
    'MCPTransport::start_receive_loop',
    'MCPConnection::new_remote',
  ];
  const mcpProcessRuleText = mcpProcessRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpProcessHelpers) {
    if (!mcpProcessRuleText.includes(helper)) {
      throw new Error(`MCP server process boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpManagerRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/server/manager/mod.rs',
  );
  if (!mcpManagerRule) {
    throw new Error('missing MCP server manager boundary rule');
  }
  const mcpManagerHelpers = [
    'ListChangedKind',
    'resource_catalog_cache',
    'prompt_catalog_cache',
  ];
  const mcpManagerRuleText = mcpManagerRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpManagerHelpers) {
    if (!mcpManagerRuleText.includes(helper)) {
      throw new Error(`MCP server manager boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpReconnectRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/server/manager/reconnect.rs',
  );
  if (!mcpReconnectRule) {
    throw new Error('missing MCP reconnect boundary rule');
  }
  if (
    !mcpReconnectRule.patterns
      .map((pattern) => pattern.regex.source)
      .join('\n')
      .includes('compute_backoff_delay')
  ) {
    throw new Error('MCP reconnect boundary rule must forbid compute_backoff_delay');
  }

  const mcpInteractionRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/server/manager/interaction.rs',
  );
  if (!mcpInteractionRule) {
    throw new Error('missing MCP interaction boundary rule');
  }
  if (
    !mcpInteractionRule.patterns
      .map((pattern) => pattern.regex.source)
      .join('\n')
      .includes('detect_list_changed_kind')
  ) {
    throw new Error('MCP interaction boundary rule must forbid detect_list_changed_kind');
  }

  const mcpToolAdapterRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/adapter/tool.rs',
  );
  if (!mcpToolAdapterRule) {
    throw new Error('missing MCP tool adapter boundary rule');
  }
  const mcpToolAdapterHelpers = [
    'behavior_hints',
    'truncate_for_assistant',
    'MCPToolResultContent',
    'Tool',
    'DynamicMcpToolInfo',
    'Input must be an object',
    'Using MCP tool',
    'was rejected by user',
    'completed\\. Result:',
  ];
  const mcpToolAdapterRuleText = mcpToolAdapterRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpToolAdapterHelpers) {
    if (!mcpToolAdapterRuleText.includes(helper)) {
      throw new Error(`MCP tool adapter boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpContextAdapterRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/adapter/context.rs',
  );
  if (!mcpContextAdapterRule) {
    throw new Error('missing MCP context adapter boundary rule');
  }
  const mcpContextAdapterHelpers = [
    'ContextEnhancerConfig',
    'ContextEnhancer',
    'partial_cmp',
  ];
  const mcpContextAdapterRuleText = mcpContextAdapterRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpContextAdapterHelpers) {
    if (!mcpContextAdapterRuleText.includes(helper)) {
      throw new Error(`MCP context adapter boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpJsonConfigRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/config/json_config.rs',
  );
  if (!mcpJsonConfigRule) {
    throw new Error('missing MCP JSON config boundary rule');
  }
  const mcpJsonConfigHelpers = [
    'normalize_source',
    'normalize_transport',
    'normalize_legacy_type',
    'mcpServers',
  ];
  const mcpJsonConfigRuleText = mcpJsonConfigRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpJsonConfigHelpers) {
    if (!mcpJsonConfigRuleText.includes(helper)) {
      throw new Error(`MCP JSON config boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpConfigServiceRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/config/service.rs',
  );
  if (!mcpConfigServiceRule) {
    throw new Error('missing MCP config service boundary rule');
  }
  const mcpConfigServiceHelpers = [
    'AUTHORIZATION_KEYS',
    'config_signature',
    'precedence',
    'config_authorization_from_map',
    'BTreeMap',
  ];
  const mcpConfigServiceRuleText = mcpConfigServiceRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpConfigServiceHelpers) {
    if (!mcpConfigServiceRuleText.includes(helper)) {
      throw new Error(`MCP config service boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpAuthRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/auth.rs',
  );
  if (!mcpAuthRule) {
    throw new Error('missing MCP auth boundary rule');
  }
  const mcpAuthHelpers = [
    'VaultFile',
    'NONCE_LEN',
    'encrypt_value',
    'decrypt_value',
    'AuthorizationManager::new',
    'OAuthState::new',
  ];
  const mcpAuthRuleText = mcpAuthRule.patterns.map((pattern) => pattern.regex.source).join('\n');
  for (const helper of mcpAuthHelpers) {
    if (!mcpAuthRuleText.includes(escapeRegex(helper))) {
      throw new Error(`MCP auth boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpRemoteTransportRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/protocol/transport_remote.rs',
  );
  if (!mcpRemoteTransportRule) {
    throw new Error('missing MCP remote transport boundary rule');
  }
  const mcpRemoteTransportHelpers = [
    'normalize_authorization_value',
    'starts_with\\("bearer "\\)',
    'build_client_info',
    'ClientCapabilities::builder',
    'map_(?:rmcp_)?initialize_result',
    'map_(?:rmcp_)?tool',
    'map_(?:rmcp_)?resource',
    'map_(?:rmcp_)?resource_content',
    'map_(?:rmcp_)?prompt',
    'map_(?:rmcp_)?prompt_message',
    'map_(?:rmcp_)?tool_result',
    'map_(?:rmcp_)?content_block',
    'map_(?:rmcp_)?icons',
    'map_(?:rmcp_)?annotations',
  ];
  const mcpRemoteTransportRuleText = mcpRemoteTransportRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpRemoteTransportHelpers) {
    if (!mcpRemoteTransportRuleText.includes(helper)) {
      throw new Error(`MCP remote transport boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpJsonrpcRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/protocol/jsonrpc.rs',
  );
  if (!mcpJsonrpcRule) {
    throw new Error('missing MCP JSON-RPC boundary rule');
  }
  const mcpJsonrpcHelpers = [
    'serialize_params',
    'create_initialize_request',
    'create_resources_list_request',
    'create_resources_read_request',
    'create_prompts_list_request',
    'create_prompts_get_request',
    'create_tools_list_request',
    'create_tools_call_request',
    'create_ping_request',
  ];
  const mcpJsonrpcRuleText = mcpJsonrpcRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const helper of mcpJsonrpcHelpers) {
    if (!mcpJsonrpcRuleText.includes(helper)) {
      throw new Error(`MCP JSON-RPC boundary rule must forbid helper: ${helper}`);
    }
  }

  const mcpServerConfigRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/mcp/server/config.rs',
  );
  if (!mcpServerConfigRule) {
    throw new Error('missing MCP server config boundary rule');
  }
  const mcpServerConfigContracts = [
    'MCPServerTransport',
    'MCPServerOAuthConfig',
    'MCPServerXaaConfig',
    'MCPServerConfig',
    'default_true',
    'resolved_transport',
    'validate',
  ];
  const mcpServerConfigRuleText = mcpServerConfigRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of mcpServerConfigContracts) {
    if (!mcpServerConfigRuleText.includes(contract)) {
      throw new Error(`MCP server config boundary rule must forbid contract: ${contract}`);
    }
  }

  const servicesIntegrationsProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'services-integrations',
  );
  for (const dep of [
    'aes',
    'dunce',
    'futures',
    'hex',
    'local-ip-address',
    'md5',
    'reqwest',
    'sse-stream',
    'which',
  ]) {
    if (!servicesIntegrationsProfile?.forbiddenNonOptionalDeps.includes(dep)) {
      throw new Error(`services-integrations default profile must forbid non-optional ${dep}`);
    }
  }

  const remoteConnectRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/assembly/core/src/service/remote_connect/remote_server.rs',
  );
  if (!remoteConnectRule) {
    throw new Error('missing remote-connect remote_server boundary rule');
  }
  const remoteConnectContracts = [
    'ImageAttachment',
    'ChatImageAttachment',
    'ChatMessage',
    'ChatMessageItem',
    'RemoteToolStatus',
    'ActiveTurnSnapshot',
    'SessionInfo',
    'RemoteDefaultModelsConfig',
    'RemoteModelConfig',
    'RemoteModelCatalog',
    'RemoteModelCatalogPollDelta',
    'RemoteCommand',
    'RemoteResponse',
    'TrackerState',
    'TrackerEvent',
    'RemoteSessionStateTracker',
    'DashMap',
    'make_slim_params',
    'match mobile_type',
    'RemoteCancelDecision',
    'resolve_remote_cancel_decision',
    'RemoteCancelTaskRequest',
    'RemoteCancelRuntimeHost',
    'cancel_remote_task',
    'remote_session_restore_target',
    'resolve_remote_execution_image_contexts',
    'RemoteImageContextAdapter',
    'MAX_SIZE',
    'MAX_CHUNK',
    'unwrap_or\\("file"\\)',
    'resolve_workspace_path',
    'detect_mime_type',
    'read_workspace_file',
    'read_remote_workspace_file',
    'read_remote_workspace_file_chunk',
    'read_remote_workspace_file_info',
    'remote_file_content_response',
    'remote_file_chunk_response',
    'remote_file_info_response',
    'handle_remote_workspace_file_command',
    'general_purpose::STANDARD\\.encode',
    'remote_dialog_submit_response',
    'remote_task_cancel_response',
    'remote_interaction_accepted_response',
    'remote_answer_question_response',
    'remote_workspace_info_response',
    'remote_recent_workspaces_response',
    'remote_assistant_list_response',
    'remote_workspace_updated_response',
    'remote_assistant_updated_response',
    'remote_session_info',
    'remote_session_list_response',
    'remote_initial_sync_response',
    'remote_session_created_response',
    'remote_session_model_updated_response',
    'remote_messages_response',
    'remote_session_deleted_response',
    'should_send_remote_model_catalog',
    'remote_model_catalog_poll_delta',
    'remote_no_change_poll_response',
    'remote_snapshot_poll_response',
    'remote_persisted_poll_response',
  ];
  const remoteConnectRuleText = remoteConnectRule.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n');
  for (const contract of remoteConnectContracts) {
    if (!remoteConnectRuleText.includes(contract)) {
      throw new Error(`remote-connect boundary rule must forbid contract: ${contract}`);
    }
  }

  const facadePaths = new Set(facadeOnlyFiles.map((facade) => facade.path));
  for (const path of [
    'src/crates/assembly/core/src/service/mcp/protocol/transport.rs',
    'src/crates/assembly/core/src/service/mcp/protocol/transport_remote.rs',
    'src/crates/assembly/core/src/service/mcp/server/connection.rs',
  ]) {
    if (!facadePaths.has(path)) {
      throw new Error(`missing MCP runtime facade-only rule for ${path}`);
    }
  }

  if (!noCoreDependencyCrates.includes('agent-runtime-ipc')) {
    throw new Error('agent-runtime-ipc must be covered by the no-core dependency guard');
  }
  const runtimeIpcBoundary = lightweightBoundaryRules.find(
    (rule) => rule.crateName === 'agent-runtime-ipc',
  );
  for (const dependency of [
    'openbitfun-agent-runtime',
    'openbitfun-sdk-host',
    'openbitfun-services-core',
    'openbitfun-services-integrations',
    'terminal-core',
    'tool-runtime',
    'tauri',
    'reqwest',
    'tokio-tungstenite',
    'openbitfun-cli',
  ]) {
    if (!runtimeIpcBoundary?.forbiddenDeps.includes(dependency)) {
      throw new Error(`agent-runtime-ipc lightweight boundary must forbid ${dependency}`);
    }
  }
  for (const allowedDependency of [
    'openbitfun-events',
    'openbitfun-product-domains',
    'openbitfun-runtime-ports',
    'openbitfun-transport',
  ]) {
    if (runtimeIpcBoundary?.forbiddenDeps.includes(allowedDependency)) {
      throw new Error(`agent-runtime-ipc must be allowed to reuse ${allowedDependency}`);
    }
  }
  const runtimeIpcProfile = dependencyProfileRules.find(
    (rule) => rule.crateName === 'agent-runtime-ipc',
  );
  for (const dependency of ['openbitfun-agent-runtime', 'openbitfun-services-core', 'tauri', 'reqwest']) {
    if (!runtimeIpcProfile?.forbiddenNonOptionalDeps.includes(dependency)) {
      throw new Error(`agent-runtime-ipc dependency profile must forbid ${dependency}`);
    }
  }
  const runtimeIpcOperationRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/adapters/agent-runtime-ipc/src/operation.rs',
  );
  const cliManifestRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/apps/cli/Cargo.toml',
  );
  const cliManifestPattern = cliManifestRule?.patterns[0]?.regex;
  if (
    !cliManifestPattern ||
    cliManifestPattern.test('openbitfun-app-server = { path = "..." }') ||
    !cliManifestPattern.test('openbitfun-app-server-client = { path = "..." }') ||
    !cliManifestPattern.test('openbitfun-tui-management = { path = "..." }') ||
    !cliManifestPattern.test('openbitfun-app-server-protocol = { path = "..." }') ||
    cliManifestPattern.test('openbitfun-agent-runtime-ipc = { path = "..." }')
  ) {
    throw new Error('CLI manifest guard must allow the App Server stdio host while forbidding the typed client transport, wire DTOs, and shared TUI management implementations, and allowing contracts and Runtime IPC');
  }
  const cliServerHostRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/apps/cli/src',
  );
  const cliServerHostPattern = cliServerHostRule?.patterns[0];
  if (!cliServerHostPattern) {
    throw new Error('CLI source must carry a openbitfun_app_server import guard');
  }
  if (!cliServerHostPattern.regex.test('use openbitfun_app_server::OpenBitFunAppServer;')) {
    throw new Error('CLI app-server import guard must match implementation imports');
  }
  if (
    !cliServerHostPattern.allowPaths ||
    cliServerHostPattern.allowPaths.length !== 1 ||
    cliServerHostPattern.allowPaths[0] !== 'src/apps/cli/src/server_host.rs'
  ) {
    throw new Error('CLI app-server import guard must allow only the reviewed stdio Server Host assembly point');
  }

  const runtimeIpcOperationPattern = runtimeIpcOperationRule?.patterns[0]?.regex;
  if (
    !runtimeIpcOperationPattern ||
    ![
      'ReplayEvents',
      'ReadTranscript',
      'DetachSession',
      'ManageModels',
      'ManageAgents',
      'LineageSessionTranscript',
    ].every((name) => runtimeIpcOperationPattern.test(`    ${name},`)) ||
    runtimeIpcOperationPattern.test('    Health,') ||
    runtimeIpcOperationPattern.test('    DeleteSession {') ||
    runtimeIpcOperationPattern.test('    ForkSession {') ||
    runtimeIpcOperationPattern.test('    RenameSession {') ||
    runtimeIpcOperationPattern.test('    UpdateSessionMode {') ||
    runtimeIpcOperationPattern.test('    UpdateSessionModel {') ||
    runtimeIpcOperationPattern.test('    UndoSession {') ||
    runtimeIpcOperationPattern.test('    RedoSession {') ||
    runtimeIpcOperationPattern.test('    SearchWorkspaceReferences {') ||
    runtimeIpcOperationPattern.test('    WorkspaceReferencesForMessage {') ||
    runtimeIpcOperationPattern.test('    GetSessionLineage {') ||
    runtimeIpcOperationPattern.test('    InspectLineageSession {') ||
    runtimeIpcOperationPattern.test('    CancelLineageSession {') ||
    runtimeIpcOperationPattern.test('    SessionLineage {') ||
    runtimeIpcOperationPattern.test('    LineageSessionInspection {') ||
    runtimeIpcOperationPattern.test('    AgentSessionLineageCancellationRequest,') ||
    runtimeIpcOperationPattern.test('    AgentSessionLineageRequest,') ||
    runtimeIpcOperationPattern.test('    AgentSessionLineageSnapshot,') ||
    runtimeIpcOperationPattern.test('    AgentSessionLineageTranscriptRequest,') ||
    runtimeIpcOperationPattern.test('    WorkspaceReferenceSearch {') ||
    runtimeIpcOperationPattern.test('    WorkspaceReferences {') ||
    runtimeIpcOperationPattern.test('    WorkspaceDiff {') ||
    runtimeIpcOperationPattern.test('    WorkspaceDiffSnapshot,') ||
    runtimeIpcOperationPattern.test('    SubmitTurn {') ||
    runtimeIpcOperationPattern.test('    StartQuestionInteraction {') ||
    runtimeIpcOperationPattern.test('    CancelUserQuestion {') ||
    runtimeIpcOperationPattern.test('    SteerTurn {') ||
    runtimeIpcOperationPattern.test('    AgentDialogSteerRequest {') ||
    runtimeIpcOperationPattern.test('    RunUserShellCommand {') ||
    runtimeIpcOperationPattern.test('    AgentUserShellCommandRequest {') ||
    runtimeIpcOperationPattern.test('    SessionForked {') ||
    runtimeIpcOperationPattern.test('    SessionReverted {') ||
    runtimeIpcOperationPattern.test('    TurnSteered {')
  ) {
    throw new Error('agent-runtime-ipc operation guard must preserve the Shared TUI operation budget');
  }
  const runtimeIpcTransportRule = forbiddenContentUnderRules.find(
    (rule) => rule.path === 'src/crates/adapters/agent-runtime-ipc/src',
  );
  const runtimeIpcTransportRuleText = runtimeIpcTransportRule?.patterns
    .map((pattern) => pattern.regex.source)
    .join('\n') ?? '';
  const runtimeIpcTransportPattern = runtimeIpcTransportRule?.patterns[0]?.regex;
  for (const transport of ['TcpListener', 'TcpStream', 'TcpSocket', 'UdpSocket', 'WebSocket']) {
    if (!runtimeIpcTransportPattern?.test(transport)) {
      throw new Error(`agent-runtime-ipc local-only guard must forbid ${transport}`);
    }
  }
  for (const dependency of ['reqwest', 'tokio_tungstenite']) {
    if (!runtimeIpcTransportRuleText.includes(dependency)) {
      throw new Error(`agent-runtime-ipc local-only guard must forbid ${dependency}`);
    }
  }
  const privateTransportModule = 'src/crates/adapters/agent-runtime-ipc/src/tcp.rs';
  if (
    !runtimeIpcTransportRule ||
    !privateTransportModule.startsWith(`${runtimeIpcTransportRule.path}/`) ||
    !runtimeIpcTransportPattern?.test('use tokio::net::TcpListener;')
  ) {
    throw new Error(
      'agent-runtime-ipc local-only guard must cover network transports in new private modules',
    );
  }
  const runtimeIpcSharedTransportPattern = runtimeIpcTransportRule?.patterns.find(
    (pattern) => pattern.message.includes('bounded JSON API'),
  )?.regex;
  if (
    !runtimeIpcSharedTransportPattern ||
    !runtimeIpcSharedTransportPattern.test('use openbitfun_transport::TransportAdapter;') ||
    !runtimeIpcSharedTransportPattern.test('use openbitfun_transport as transport;') ||
    runtimeIpcSharedTransportPattern.test('use openbitfun_transport::encode_json_with_limit;') ||
    runtimeIpcSharedTransportPattern.test('use openbitfun_transport::JsonCodecError;')
  ) {
    throw new Error(
      'agent-runtime-ipc may consume only the reviewed openbitfun-transport bounded JSON API',
    );
  }
  const runtimeIpcTransportFeatureRule = forbiddenContentRules.find(
    (rule) => rule.path === 'src/crates/adapters/agent-runtime-ipc/Cargo.toml' &&
      rule.reason.includes('openbitfun-transport features'),
  );
  const runtimeIpcTransportFeaturePattern =
    runtimeIpcTransportFeatureRule?.patterns[0]?.regex;
  if (
    !runtimeIpcTransportFeaturePattern?.test(
      'openbitfun-transport = { path = "../transport", features = ["tauri-adapter"] }',
    ) ||
    runtimeIpcTransportFeaturePattern.test(
      'openbitfun-transport = { path = "../transport" }',
    )
  ) {
    throw new Error('agent-runtime-ipc must not enable openbitfun-transport features');
  }
  const runtimeIpcTransportDependencyRule = requiredContentRules.find(
    (rule) => rule.path === 'src/crates/adapters/agent-runtime-ipc/Cargo.toml' &&
      rule.reason.includes('exact feature-free openbitfun-transport dependency'),
  );
  const runtimeIpcTransportDependencyPattern =
    runtimeIpcTransportDependencyRule?.patterns[0]?.regex;
  if (
    !runtimeIpcTransportDependencyPattern?.test(
      'openbitfun-transport = { path = "../transport" }',
    ) ||
    runtimeIpcTransportDependencyPattern.test(
      'openbitfun-transport = {\n  path = "../transport",\n  features = ["tauri-adapter"]\n}',
    )
  ) {
    throw new Error(
      'agent-runtime-ipc must keep the exact feature-free openbitfun-transport dependency',
    );
  }
}
