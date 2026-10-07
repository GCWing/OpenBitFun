import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildCapabilityCatalog,
  loadRemoteSurfaceRegistry,
  parseRegisteredCommands,
  projectSettingsCatalogDestination,
  renderRemoteSurfaceTsBindings,
} from './generate-interactive-capabilities.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('historical settings wire targets resolve through the current presentation migration', () => {
  const { runtimeCatalog } = buildCapabilityCatalog();
  const execution = runtimeCatalog.capabilities.find(({ id }) => id === 'setting.tools.execution');
  const permissions = execution.items.find(({ id }) => id === 'permission-mode');
  assert.deepEqual(permissions.destination, { kind: 'settings', pageId: 'tools.execution', viewId: 'common' });
  assert.deepEqual(projectSettingsCatalogDestination(execution.id, permissions.destination, permissions.id), {
    kind: 'settings', pageId: 'ai.permissions',
  });
  const automation = runtimeCatalog.capabilities.find(({ id }) => id === 'setting.tools.automation');
  const hooks = automation.items.find(({ id }) => id === 'hooks-enabled');
  assert.deepEqual(hooks.destination, { kind: 'settings', pageId: 'tools.automation', viewId: 'hooks' });
  assert.deepEqual(projectSettingsCatalogDestination(automation.id, hooks.destination, hooks.id), {
    kind: 'settings', pageId: 'tools.automation', sectionId: 'hooks',
  });
  const computerUse = runtimeCatalog.capabilities.find(({ id }) => id === 'feature.computer-use');
  assert.deepEqual(projectSettingsCatalogDestination(computerUse.id, computerUse.destination), {
    kind: 'settings', pageId: 'tools.desktop-control',
  });
});

test('the public contract is a compact feature-and-settings manual', () => {
  const { publicCatalog, runtimeCatalog } = buildCapabilityCatalog();
  const featureCount = publicCatalog.capabilities.filter(({ kind }) => kind === 'feature').length;
  const settingCount = publicCatalog.capabilities.filter(({ kind }) => kind === 'setting').length;
  const documentedItemCount = publicCatalog.capabilities.reduce(
    (total, capability) => total + capability.items.length,
    0,
  );
  assert.equal(publicCatalog.counts.features, featureCount);
  assert.equal(publicCatalog.counts.settings, settingCount);
  assert.equal(publicCatalog.counts.userFacing, publicCatalog.capabilities.length);
  assert.equal(publicCatalog.counts.documentedItems, documentedItemCount);
  assert.deepEqual(new Set(publicCatalog.capabilities.map(({ kind }) => kind)), new Set(['feature', 'setting']));
  assert.equal(new Set(publicCatalog.capabilities.map(({ id }) => id)).size, publicCatalog.capabilities.length);
  assert.equal(publicCatalog.capabilities.some(({ id }) => id === 'get_configs'), false);
  assert.equal(publicCatalog.counts.controlCoverage.unsupported, 0);
  assert.ok(publicCatalog.searchAcceptance.length >= 5);
  assert.equal(
    publicCatalog.counts.controlCoverage.direct
      + publicCatalog.counts.controlCoverage.delegated
      + publicCatalog.counts.controlCoverage.interactive,
    publicCatalog.counts.documentedItems,
  );
  assert.equal(JSON.stringify(publicCatalog).includes('tauri::'), false);
  assert.equal(JSON.stringify(publicCatalog).includes('implementationCoverage'), false);
  assert.equal(JSON.stringify(publicCatalog).includes('tauriCommandsAudited'), false);
  assert.equal(JSON.stringify(publicCatalog).includes('evidence'), false);
  assert.equal(JSON.stringify(publicCatalog).includes('reviewedInteractionContract'), false);
  assert.match(publicCatalog.digest, /^[a-f0-9]{64}$/u);
  assert.match(publicCatalog.ownerDigest, /^[a-f0-9]{64}$/u);
  assert.equal(publicCatalog.digest, runtimeCatalog.digest);
  assert.equal(publicCatalog.ownerDigest, runtimeCatalog.ownerDigest);
  assert.equal(JSON.stringify(publicCatalog).includes('"handler"'), false);
  assert.equal(JSON.stringify(runtimeCatalog).includes('"handler"'), true);
});

test('the manual overlay cannot own executable product-control facts', async () => {
  const source = JSON.parse(await read('src/shared/interactive-capabilities/catalog.json'));
  for (const capability of source.capabilities) {
    for (const option of capability.options ?? []) {
      assert.equal(Object.hasOwn(option, 'handler'), false, `${capability.id}:${option.id}`);
      assert.equal(Object.hasOwn(option, 'valueSchema'), false, `${capability.id}:${option.id}`);
    }
    for (const operation of capability.operations ?? []) {
      for (const field of ['handler', 'risk', 'inputSchema', 'argumentScopes']) {
        assert.equal(Object.hasOwn(operation, field), false, `${capability.id}:${operation.id}`);
      }
    }
  }
});

test('the technical audit exactly covers Desktop Tauri registration without exposing it as UX', async () => {
  const registrations = parseRegisteredCommands(await read('src/apps/desktop/src/lib.rs'));
  const { publicCatalog, technicalMap } = buildCapabilityCatalog();
  assert.equal(technicalMap.commands.length, registrations.length);
  assert.deepEqual(
    new Set(technicalMap.commands.map(({ id }) => id)),
    new Set(registrations.map(({ id }) => id)),
  );
  assert.equal(technicalMap.commandCount, registrations.length);
  assert.equal(technicalMap.coverage.commandCount, registrations.length);
  assert.equal(
    technicalMap.coverage.documentedCommandCount + technicalMap.coverage.implementationCommandCount,
    technicalMap.commandCount,
  );
  for (const command of technicalMap.commands) {
    assert.ok(Array.isArray(command.capabilityIds));
    assert.ok(Array.isArray(command.documentedItemIds));
    assert.ok(['documented', 'implementation', 'internal'].includes(command.visibility));
    if (command.visibility === 'documented') {
      assert.ok(command.capabilityIds.length > 0);
      assert.ok(command.documentedItemIds.length > 0);
    }
  }
  const petCommands = technicalMap.commands.filter(({ id }) => [
    'list_agent_companion_pets',
    'import_agent_companion_pet_package',
    'delete_agent_companion_pet_package',
  ].includes(id));
  assert.equal(petCommands.length, 3);
  assert.ok(petCommands.every(({ capabilityIds, visibility }) =>
    visibility === 'documented' && capabilityIds.includes('setting.application.pet')));
});

test('every manual entry has bilingual discovery, instructions, routing, and agent recipes', () => {
  const { publicCatalog } = buildCapabilityCatalog();
  for (const capability of publicCatalog.capabilities) {
    assert.match(capability.titleZh, /[\u3400-\u9fff]/u, `${capability.id} needs a Chinese title`);
    assert.match(capability.titleEn, /[A-Za-z]/u, `${capability.id} needs an English title`);
    assert.ok(capability.searchTerms.some((term) => /[\u3400-\u9fff]/u.test(term)));
    assert.ok(capability.searchTerms.some((term) => /[A-Za-z]/u.test(term)));
    assert.ok(capability.highlightsZh.length > 0);
    assert.ok(capability.items.length > 0, `${capability.id} must enumerate real user-visible items`);
    assert.equal(new Set(capability.items.map(({ id }) => id)).size, capability.items.length);
    assert.ok(capability.items.every(({ titleZh, titleEn }) =>
      /[\u3400-\u9fff]/u.test(titleZh) && /[A-Za-z]/u.test(titleEn)));
    assert.ok(capability.items.every(({ control }) =>
      ['direct', 'delegate', 'open', 'unsupported'].includes(control.kind)));
    assert.ok(capability.items
      .filter(({ control }) => control.kind === 'delegate')
      .every(({ control }) => control.tools.length > 0
        && control.workflowZh.length > 0
        && control.workflowZh.length === control.workflowEn.length));
    assert.ok(capability.stepsZh.length > 0);
    assert.ok(capability.agentExamplesZh.length > 0);
    assert.ok(['settings', 'action', 'scene', 'event'].includes(capability.destination.kind));
    assert.equal(capability.docsUrl, `${publicCatalog.origin}/capabilities/${capability.id}/`);
    assert.doesNotMatch(JSON.stringify(capability), /"handler"/u);
  }
});

test('every executable contract is bound to a documented item and navigation is not called control', () => {
  const { publicCatalog } = buildCapabilityCatalog();
  for (const capability of publicCatalog.capabilities) {
    const mappedOperations = new Set(capability.items.flatMap(({ control }) =>
      control.kind === 'direct' ? control.operations : []));
    const mappedOptions = new Set(capability.items.flatMap(({ control }) =>
      control.kind === 'direct' ? control.options.map(({ id }) => id) : []));
    assert.deepEqual(mappedOperations, new Set(capability.operations.map(({ id }) => id)));
    assert.deepEqual(mappedOptions, new Set(capability.options.map(({ id }) => id)));
    assert.ok(capability.items
      .filter(({ control }) => control.kind === 'open')
      .every(({ control }) => {
        assert.deepEqual(
          Object.keys(control).sort(),
          ['kind', 'reasonCode', 'reasonEn', 'reasonZh'],
          'interactive routing must not carry executable operation or option bindings',
        );
        assert.ok([
          'externalAuth',
          'secretEntry',
          'visualSelection',
          'unstructuredInteraction',
        ].includes(control.reasonCode));
        return control.reasonZh.trim().length > 0 && control.reasonEn.trim().length > 0;
      }));
  }
});

test('every interaction-only control has an individually reviewable reason and evidence', () => {
  const { publicCatalog, openAudit } = buildCapabilityCatalog();
  assert.equal(openAudit.catalogDigest, publicCatalog.digest);
  assert.equal(openAudit.count, publicCatalog.counts.controlCoverage.interactive);
  assert.equal(openAudit.entries.length, openAudit.count);
  assert.equal(
    Object.values(openAudit.reasonCounts).reduce((total, count) => total + count, 0),
    openAudit.count,
  );
  for (const entry of openAudit.entries) {
    if (entry.reasonCode === 'unstructuredInteraction') {
      assert.ok(entry.reasonZh.includes(entry.titleZh), `${entry.capabilityId}:${entry.itemId}`);
      assert.ok(entry.reasonEn.includes(entry.titleEn), `${entry.capabilityId}:${entry.itemId}`);
    }
    assert.ok(entry.reasonZh.length >= 24, `${entry.capabilityId}:${entry.itemId}`);
    assert.ok(entry.reasonEn.length >= 48, `${entry.capabilityId}:${entry.itemId}`);
    assert.ok(entry.evidence.length > 0, `${entry.capabilityId}:${entry.itemId}`);
    assert.notEqual(
      entry.reasonZh,
      '该流程依赖当前界面状态、用户选择或额外确认；Agent 可准确打开入口，但契约不把跳转冒充为直接执行。',
    );
  }
});

test('every product Agent tool is mapped to a user capability or explicitly classified as framework-only', async () => {
  const source = JSON.parse(await read('src/shared/interactive-capabilities/catalog.json'));
  const toolProviderGroups = await read('src/crates/execution/tool-provider-groups/src/lib.rs');
  const productPlan = toolProviderGroups.match(
    /const PRODUCT_TOOL_PROVIDER_GROUP_PLAN:[\s\S]*?\n\];/u,
  )?.[0];
  assert.ok(productPlan, 'product Agent-tool provider plan must remain discoverable');
  const productTools = new Set(
    [...productPlan.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/gu)]
      .map((match) => match[1])
      .filter((name) => !name.includes('core')),
  );
  const delegatedTools = new Set(source.capabilities.flatMap((capability) =>
    capability.items.flatMap((item) => item.control.kind === 'delegate'
      ? (item.control.tools ?? [capability.agentControl?.tool]).filter(Boolean)
      : [])));
  const excludedTools = new Set(
    source.agentToolExclusions.map(({ tool }) => tool),
  );

  assert.deepEqual(
    new Set([...delegatedTools, ...excludedTools]),
    productTools,
    'new Agent tools must be mapped in the shared manual or receive a reviewed framework-only exclusion',
  );
  assert.deepEqual(excludedTools, new Set(['Task', 'GetToolSpec', 'CallDeferredTool']));
  assert.equal([...delegatedTools].filter((tool) => excludedTools.has(tool)).length, 0);

  const byId = new Map(source.capabilities.map((capability) => [capability.id, capability]));
  const item = (capabilityId, itemId) => byId.get(capabilityId)?.items
    .find(({ id }) => id === itemId);
  assert.ok(item('feature.remote-workspaces', 'remote-files').control.tools.includes('Read'));
  assert.deepEqual(item('feature.remote-workspaces', 'port-forwarding').control.tools, ['PortForward']);
  assert.ok(item('setting.tools.mcp', 'resources').control.tools.includes('ReadMCPResource'));
  assert.equal(byId.get('feature.desktop-pet').agentControl.tool, 'OpenBitFunControl');
  assert.equal(item('feature.desktop-pet', 'petdex-import').control.kind, 'delegate');
  const { publicCatalog } = buildCapabilityCatalog();
  const petSetting = publicCatalog.capabilities
    .find(({ id }) => id === 'setting.application.pet');
  assert.deepEqual(
    petSetting.operations.find(({ id }) => id === 'use-pet').argumentScopes,
    { path: 'productHostLocal' },
  );
  assert.deepEqual(
    petSetting.operations.find(({ id }) => id === 'delete-pet').argumentScopes,
    { packagePath: 'productHostLocal' },
  );
});

test('the built-in browser manual covers its element picker in both languages', () => {
  const { publicCatalog } = buildCapabilityCatalog();
  const browser = publicCatalog.capabilities.find(({ id }) => id === 'feature.browser');
  assert.ok(browser);
  assert.ok(browser.items.some(({ id, titleZh, titleEn }) =>
    id === 'element-picker' && titleZh.includes('元素选择器') && /element picker/iu.test(titleEn)));
  assert.ok(browser.items.some(({ id, titleZh, titleEn }) =>
    id === 'element-context' && titleZh.includes('CSS 路径') && /session context/iu.test(titleEn)));
  assert.ok(browser.searchTerms.includes('启动元素选择器，悬停时高亮页面元素并显示标签、ID 和 Class'));
  assert.ok(browser.searchTerms.includes('Start the element picker to highlight hovered elements and show tag, ID, and class details'));
});

test('the files and editor manual exposes provider-backed actions without retired LSP facts', async () => {
  const source = JSON.parse(await read('src/shared/interactive-capabilities/catalog.json'));
  const filesEditor = source.capabilities.find(({ id }) => id === 'feature.files-editor');
  assert.ok(filesEditor);
  assert.ok(filesEditor.items.some(({ id }) => id === 'language-actions'));
  assert.doesNotMatch(JSON.stringify(filesEditor), /\blsp\b|language server/iu);
  assert.equal(Object.hasOwn(source.implementationOwners, 'lsp'), false);
  assert.equal(Object.hasOwn(source.implementationOwners, 'lsp_workspace'), false);

  const { technicalMap } = buildCapabilityCatalog();
  assert.equal(technicalMap.commands.some(({ id }) => id.startsWith('lsp_')), false);
});

test('built-in and external browsers share one agent action contract', async () => {
  const { publicCatalog } = buildCapabilityCatalog();
  const browser = publicCatalog.capabilities.find(({ id }) => id === 'feature.browser');
  assert.ok(browser);
  assert.ok(browser.items.some(({ id }) => id === 'agent-page-automation'));
  assert.ok(browser.items.some(({ id }) => id === 'shared-browser-action-contract'));
  assert.ok(browser.searchTerms.some((term) => /智能体.*内置网页/u.test(term)));
  assert.ok(browser.searchTerms.some((term) => /one BrowserActions/iu.test(term)));
  assert.equal(browser.agentControl.tool, 'ControlHub');
  assert.ok(browser.agentControl.workflowZh.some((step) => step.includes('browser.open_builtin')));
  assert.ok(browser.agentControl.workflowZh.some((step) => step.includes('OpenBitFunControl') && step.includes('about:blank')));
  assert.ok(browser.agentControl.workflowEn.some((step) => /share.*contract/iu.test(step)));
  assert.ok(browser.agentControl.workflowEn.some((step) => /OpenBitFunControl/iu.test(step) && /about:blank/iu.test(step)));

  const actions = await read(
    'src/crates/assembly/core/src/agentic/tools/browser_control/actions.rs',
  );
  const clientContract = await read(
    'src/crates/assembly/core/src/agentic/tools/browser_control/automation_client.rs',
  );
  const cdpAdapter = await read(
    'src/crates/assembly/core/src/agentic/tools/browser_control/cdp_client.rs',
  );
  const builtinCoreAdapter = await read(
    'src/crates/assembly/core/src/agentic/tools/browser_control/builtin_browser.rs',
  );
  const builtinDesktopAdapter = await read('src/apps/desktop/src/builtin_browser_host.rs');
  const controlHub = await read(
    'src/crates/assembly/core/src/agentic/tools/implementations/control_hub_tool.rs',
  );
  const browserSurface = await read(
    'src/web-ui/src/app/scenes/browser/useEmbeddedBrowserWebview.ts',
  );

  assert.match(actions, /client: &'a dyn BrowserAutomationClient/u);
  assert.match(clientContract, /trait BrowserAutomationClient/u);
  assert.match(clientContract, /struct BrowserAutomationEvent/u);
  assert.doesNotMatch(clientContract, /use super::cdp_client/u);
  assert.match(cdpAdapter, /impl BrowserAutomationClient for CdpClient/u);
  assert.match(builtinCoreAdapter, /impl BrowserAutomationClient for BuiltInBrowserClient/u);
  assert.match(builtinDesktopAdapter, /EmbeddedWebviewAutomation/u);
  assert.doesNotMatch(builtinDesktopAdapter, /SNAPSHOT_SCRIPT|data-cdp-ref|element_center_js/u);
  assert.match(controlHub, /SHARED_BROWSER_ACTIONS/u);
  assert.match(controlHub, /BrowserActions::new\(target\.client\(\)\)/u);
  assert.match(browserSurface, /browser_webview_set_agent_target_state/u);
  assert.doesNotMatch(browserSurface, /BrowserActions|SHARED_BROWSER_ACTIONS/u);
});

test('docs, runtime, and technical views are generated projections of one semantic source', async () => {
  const { interactionAudit } = buildCapabilityCatalog();
  const source = JSON.parse(await read('src/shared/interactive-capabilities/catalog.json'));
  const publicCatalog = JSON.parse(await read('docs/interactive-capabilities/capabilities.json'));
  const runtimeCatalog = JSON.parse(await read(
    'src/web-ui/src/app/global-search/generated/interactive-capabilities.json',
  ));
  const productControlCatalog = JSON.parse(await read(
    'src/crates/contracts/product-domains/src/generated/product-control-catalog.json',
  ));
  const technicalMap = JSON.parse(await read(
    'docs/interactive-capabilities/technical/tauri-command-map.json',
  ));

  const sourceIds = source.capabilities.map(({ id }) => id);
  assert.deepEqual(interactionAudit.roots, ['src/web-ui/src']);
  assert.deepEqual(publicCatalog.capabilities.map(({ id }) => id), sourceIds);
  assert.deepEqual(publicCatalog.searchAcceptance, source.searchAcceptance);
  assert.deepEqual(runtimeCatalog.searchAcceptance, source.searchAcceptance);
  assert.deepEqual(productControlCatalog.searchAcceptance, source.searchAcceptance);
  assert.deepEqual(runtimeCatalog.capabilities.map(({ id }) => id), sourceIds);
  assert.deepEqual(productControlCatalog.capabilities.map(({ id }) => id), sourceIds);
  assert.equal(publicCatalog.digest, runtimeCatalog.digest);
  assert.equal(publicCatalog.digest, productControlCatalog.digest);
  assert.equal(publicCatalog.digest, technicalMap.catalogDigest);
  assert.equal(publicCatalog.digest, interactionAudit.catalogDigest);
  assert.deepEqual(publicCatalog.definitions, runtimeCatalog.definitions);
  assert.deepEqual(publicCatalog.definitions, productControlCatalog.definitions);
  assert.ok(publicCatalog.definitions.length > publicCatalog.capabilities.length);
  for (const definition of publicCatalog.definitions) {
    const peer = definition.availability.peer;
    if (peer.available) {
      assert.ok(
        peer.requiredCapabilities?.includes('product_control_v1'),
        `${definition.id} must negotiate the Peer ProductControl contract`,
      );
    }
  }
  assert.equal(interactionAudit.fileCount, interactionAudit.files.length);
  assert.equal(
    interactionAudit.interactionCount,
    interactionAudit.files.reduce((total, file) => total + file.interactionCount, 0),
  );
  assert.ok(interactionAudit.files.every(({ interactionCount, digest }) =>
    interactionCount > 0 && /^[a-f0-9]{64}$/u.test(digest)));
  const interactionSourceFiles = interactionAudit.files.map(({ sourceFile }) => sourceFile);
  assert.deepEqual(interactionSourceFiles, [...interactionSourceFiles].sort());
  assert.ok(interactionSourceFiles.every((sourceFile) => !sourceFile.includes('/generated/')));
  assert.ok(interactionAudit.files.some(({ sourceFile }) =>
    sourceFile.endsWith('/BrowserPanel.tsx')));
  assert.ok(interactionAudit.files.some(({ sourceFile }) =>
    sourceFile.endsWith('/AssistantDefaultsPage.tsx')));
  assert.ok(interactionAudit.files.some(({ sourceFile }) =>
    sourceFile.endsWith('/LanguageSettingsSection.tsx')));
  assert.ok(interactionAudit.files.some(({ sourceFile }) =>
    sourceFile.endsWith('/AppearancePackageConfigSection.tsx')));
  assert.equal(publicCatalog.source, 'src/shared/interactive-capabilities/catalog.json');

  const appearance = runtimeCatalog.capabilities
    .find(({ id }) => id === 'setting.application.appearance');
  const appearanceContract = JSON.parse(await read(
    'src/apps/desktop/src/generated/startup_appearance_bootstrap.json',
  ));
  const localeContract = JSON.parse(await read('src/shared/i18n/contract/locales.json'));
  assert.deepEqual(
    appearance.options.find(({ id }) => id === 'theme').valueSchema.enum,
    ['system', ...appearanceContract.appearances.map(({ id }) => id)],
  );
  assert.deepEqual(
    appearance.options.find(({ id }) => id === 'language').valueSchema.enum,
    localeContract.locales.map(({ id }) => id),
  );

  const publicById = new Map(publicCatalog.capabilities.map((capability) => [capability.id, capability]));
  for (const runtime of runtimeCatalog.capabilities) {
    const publicValue = publicById.get(runtime.id);
    assert.deepEqual(runtime.operations.map(({ handler: _handler, ...value }) => value), publicValue.operations);
    assert.deepEqual(runtime.options.map(({ handler: _handler, ...value }) => value), publicValue.options);
  }

  const docs = (await readdir(path.join(repositoryRoot, 'docs/interactive-capabilities/capabilities')))
    .filter((file) => file.endsWith('.md'));
  assert.equal(docs.length, sourceIds.length);
});

test('website, global search, and agent control consume generated semantic projections', async () => {
  const websiteBuild = await read('website/scripts/build.mjs');
  const frontendCatalog = await read('src/web-ui/src/app/global-search/interactiveCapabilityCatalog.ts');
  const searchProvider = await read(
    'src/web-ui/src/app/global-search/providers/interactiveCapabilitySearchProvider.ts',
  );
  const searchProviders = await read('src/web-ui/src/app/global-search/providers/index.ts');
  const controlBridge = await read('src/web-ui/src/app/global-search/openBitFunControlBridge.ts');
  const controlTool = await read(
    'src/crates/assembly/core/src/agentic/tools/implementations/openbitfun_control_tool.rs',
  );

  assert.match(websiteBuild, /docs\/interactive-capabilities\/capabilities\.json/u);
  assert.match(frontendCatalog, /generated\/interactive-capabilities\.json/u);
  assert.match(searchProvider, /INTERACTIVE_CAPABILITY_CATALOG/u);
  assert.doesNotMatch(searchProviders, /settingsSearchProvider/u);
  assert.match(controlBridge, /getInteractiveCapability/u);
  assert.match(controlBridge, /native ProductControl executor/u);
  assert.doesNotMatch(controlBridge, /discoverOpenBitFunCapabilities|configureOption|currentOptionValue/u);
  assert.doesNotMatch(controlTool, /include_(?:str|bytes)!/u);
  assert.match(controlTool, /two-step/u);
});

test('Desktop and Web UI share the OpenBitFunControl transport contract', async () => {
  const host = await read('src/apps/desktop/src/openbitfun_control_host.rs');
  const bridge = await read('src/web-ui/src/app/global-search/openBitFunControlBridge.ts');
  const desktopRegistration = await read('src/apps/desktop/src/lib.rs');

  for (const source of [host, bridge]) {
    assert.match(source, /agentic:\/\/openbitfun-control-request/u);
  }
  assert.match(host, /#\[serde\(rename_all = "camelCase"\)\]/u);
  assert.match(bridge, /api\.invoke\('mark_openbitfun_control_surface_ready',\s*\{\s*request:\s*\{\s*creationApiVersion:\s*1\s*\}\s*\}\)/u);
  assert.match(bridge, /api\.invoke\('report_openbitfun_control_result'/u);
  assert.match(desktopRegistration, /openbitfun_control_host::mark_openbitfun_control_surface_ready/u);
  assert.match(desktopRegistration, /openbitfun_control_host::report_openbitfun_control_result/u);
});

test('GUI, Agent, CLI, and Peer config writes converge on the ProductControl executors', async () => {
  const { publicCatalog } = buildCapabilityCatalog();
  const productControlApi = await read(
    'src/web-ui/src/infrastructure/api/service-api/ProductControlAPI.ts',
  );
  const systemApi = await read('src/web-ui/src/infrastructure/api/service-api/SystemAPI.ts');
  const generatedBindings = await read(
    'src/web-ui/src/infrastructure/api/generated/productControl.ts',
  );
  const sleepHost = await read('src/apps/desktop/src/sleep_prevention.rs');
  const desktopConfigApi = await read('src/apps/desktop/src/api/config_api.rs');
  const desktopHost = await read('src/apps/desktop/src/openbitfun_control_host.rs');
  const sharedExecutor = await read(
    'src/crates/assembly/core/src/agentic/tools/openbitfun_control_config.rs',
  );
  const controlTool = await read(
    'src/crates/assembly/core/src/agentic/tools/implementations/openbitfun_control_tool.rs',
  );
  const cliConfigHost = await read('src/apps/cli/src/peer_host/commands/config.rs');
  const cliProductControlHost = await read(
    'src/apps/cli/src/peer_host/commands/product_control.rs',
  );

  assert.match(productControlApi, /product_control_invoke/u);
  assert.match(productControlApi, /capabilityId/u);
  assert.match(productControlApi, /optionId/u);
  assert.match(productControlApi, /generated\/productControl/u);
  assert.doesNotMatch(productControlApi, /setConfig|configPath|commandName/u);
  assert.match(systemApi, /productControlAPI\.configure/u);
  assert.doesNotMatch(systemApi, /plugin-autostart/u);
  assert.match(sleepHost, /configure_option_from_gui/u);
  assert.match(desktopConfigApi, /set_config_from_gui/u);
  assert.doesNotMatch(desktopConfigApi, /config_service\.set_config/u);
  assert.match(desktopHost, /exact_config_binding/u);
  assert.match(desktopHost, /configure_option_transaction/u);
  assert.match(desktopHost, /apply_legacy_config_mutation/u);
  assert.match(sharedExecutor, /struct SharedProductControlExecutor/u);
  assert.match(sharedExecutor, /configure_legacy_path/u);
  assert.match(controlTool, /global_shared_product_control_executor/u);
  assert.match(cliConfigHost, /configure_legacy_path/u);
  assert.doesNotMatch(cliConfigHost, /config_service\.set_config/u);
  assert.match(cliProductControlHost, /global_shared_product_control_executor/u);
  assert.match(cliProductControlHost, /ProductControlSource::Peer/u);
  assert.match(generatedBindings, new RegExp(publicCatalog.digest, 'u'));
  assert.match(generatedBindings, /ProductControlOptionIdsByCapability/u);
});

test('the remote surface bindings are a projection of the compiled Product Operation Registry', async () => {
  const { raw, registry } = loadRemoteSurfaceRegistry();
  const registrations = parseRegisteredCommands(await read('src/apps/desktop/src/lib.rs'));
  const tauriRows = registry.operations.filter(({ surface }) => surface === 'tauri_command');
  assert.deepEqual(
    new Set(tauriRows.map(({ id }) => id)),
    new Set(registrations.map(({ id }) => id)),
    'every registered Tauri command has exactly one registry row and vice versa',
  );
  assert.equal(new Set(registry.operations.map(({ id }) => id)).size, registry.operations.length);
  assert.ok(registry.digest.startsWith('fnv1a64:'));

  const { technicalMap } = buildCapabilityCatalog();
  const stanceById = new Map(tauriRows.map(({ id, remoteWorkspace }) => [id, remoteWorkspace]));
  for (const command of technicalMap.commands) {
    assert.equal(command.remoteWorkspacePolicy, stanceById.get(command.id), command.id);
  }

  const committed = await read('src/crates/contracts/product-domains/src/generated/remote-surface-registry.json');
  assert.equal(committed, raw, 'committed registry export must match the compiled registry');
  const committedTs = await read('src/web-ui/src/infrastructure/api/generated/remoteSurface.ts');
  const rendered = renderRemoteSurfaceTsBindings(registry);
  assert.equal(committedTs, rendered, 'committed remoteSurface.ts must match the renderer');

  assert.match(rendered, /export const REMOTE_SURFACE_REGISTRY_DIGEST = "fnv1a64:[0-9a-f]{16}" as const;/u);
  assert.ok(rendered.includes('"account_login",'));
  assert.ok(rendered.includes('"peer_mode_ping",'));
  assert.equal(rendered.includes('"git_trust_repository",'), false, 'operator-only rows stay forwarded');
  assert.equal(rendered.includes('"dispatch_target_submit",'), false, 'HostInvoke-only rows never enter the FE local set');
  for (const capability of registry.capabilities.ids) {
    assert.ok(rendered.includes(`"${capability}",`), capability);
  }
  assert.ok(rendered.includes('"lsp_",'));
});
