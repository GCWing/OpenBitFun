import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExternalSourceCatalogSnapshot } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { getProductBrandIcon } from '@/shared/ui/productBrandIcons';
import {
  buildEcosystemImportItems,
  buildEcosystemProductRuntimes,
  ECOSYSTEM_IMPORT_ITEM_KINDS,
  totalDiscoveredAssets,
} from './ecosystemCompatibilityModel';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('ecosystem compatibility scene presentation contract', () => {
  it('opens inside Settings and removes the standalone menu entry', () => {
    const footerActions = source('../../components/NavPanel/components/PersistentFooterActions.tsx');
    const navigation = source('./ecosystemCompatibilityStore.ts');
    const page = source('../settings/pages/tools/ExternalImportSettingsPage.tsx');
    const scene = source('./EcosystemCompatibilityScene.tsx');
    const content = source('./ExternalAgentContent.tsx');

    expect(footerActions).not.toContain('data-testid="ecosystem-compatibility-tab"');
    expect(navigation).toContain("openPage('tools.external-import')");
    expect(navigation).toContain("openScene('settings')");
    expect(page).toContain('<SettingsPage pageId="tools.external-import">');
    expect(scene).not.toContain('ecosystem-compatibility__scroll');
    expect(scene).toContain('<ConfigPageSection');
    expect(content).toContain('<FieldGroup appearance="subtle" fieldSurface="ambient" dividers={false}');
  });

  it('uses real external-source import and ACP owners while keeping unfinished actions explicit', () => {
    const scene = source('./EcosystemCompatibilityScene.tsx');
    const model = source('./ecosystemCompatibilityModel.ts');

    expect(scene).toContain('externalSourcesAPI.getDiscoverySnapshot(workspace?.id, forceRefresh)');
    expect(scene).not.toContain('getDiscoverySnapshot(workspacePath');
    const content = source('./ExternalAgentContent.tsx');
    expect(content).toContain('externalSourcesAPI.planMcpImport(workspace?.id)');
    expect(content).not.toContain('planMcpImport(workspacePath');
    expect(content).toContain('externalSourcesAPI.applyMcpImport(');
    expect(scene).toContain('ACPClientAPI.getClients()');
    expect(scene).toContain('ACPClientAPI.updateClientSubagentConfig({');
    expect(scene).not.toContain("import('@/infrastructure/config/components/ExternalSourcesConfig')");
    expect(scene).toContain('<ExternalDiscoveryToggle');
    expect(scene).not.toContain('SkillsConfig');
    expect(scene).not.toContain('HooksConfig');
    expect(scene).not.toContain('McpToolsConfig');
    expect(scene).toContain('onSnapshotChange={setSnapshot}');
    expect(scene).toContain('<AcpAgentsConfig');
    expect(scene).toContain('clientIds={[...selectedRuntime.acpClients.map((client) => client.id)');
    expect(scene).toContain("new CustomEvent('openbitfun:create-acp-session'");
    expect(scene).toContain("t('run.session.title')");
    expect(scene).toContain("t('run.subagent.title')");
    expect(scene).toContain("t('run.subagent.responsibilityLabel')");
    expect(scene).toContain("t('run.subagent.bestForLabel')");
    expect(scene).toContain("notification.info(t('comingSoon.notice'");
    expect(scene).not.toContain("openScene('settings')");
    expect(model).toContain("id: 'pi'");
    expect(model).toContain("pi: ['skill', 'hook']");
    expect(model).toContain("dsh: ['skill', 'hook', 'mcp']");
  });

  it('preserves legacy management links while registering the settings destination', () => {
    const registry = source('../settings/settingsRegistry.ts');
    const settingsTypes = source('../settings/settingsTypes.ts');
    const destination = source('../settings/settingsDestination.ts');
    const quickActions = source('../../../shared/services/ide-control/api.ts');
    const agents = source('../agents/AgentsScene.tsx');
    const externalMcp = source('../../../infrastructure/config/components/ExternalMcpOverview.tsx');

    expect(registry).toContain("id: 'tools.external-import'");
    expect(settingsTypes).not.toContain("| 'tools.integrations'");
    expect(destination).toContain("'external-sources'");
    expect(destination).toContain("'tools.integrations'");
    expect(quickActions).toContain('isLegacyEcosystemCompatibilityDestination(destination)');
    expect(quickActions).toContain("ownerSurface: 'external-sources'");
    expect(agents).toContain("openEcosystemCompatibility({ ownerSurface: 'external-sources' })");
    expect(externalMcp).toContain("openEcosystemCompatibility({ ownerSurface: 'external-sources' })");
  });

  it('projects discovered content into the complete applicable product catalog', () => {
    const productSource = { providerId: 'opencode', sourceId: 'user-config' };
    const snapshot = {
      hostCapabilities: {
        canRefresh: true,
        canMutatePolicy: true,
        canManageSources: true,
        canApproveRuntime: true,
        canExecuteExternalAssets: true,
        canSetSafeMode: true,
        canRevealSourceLocation: true,
      },
      generation: 1,
      discoveryPending: false,
      sources: [{
        stableKey: 'opencode-user-config',
        record: {
          key: productSource,
          ecosystemId: 'opencode',
          displayName: 'OpenCode user config',
          sourceKind: 'reference',
          scope: 'user_global',
          location: '/home/user/.config/opencode',
          executionDomainId: 'local',
          health: 'available',
          contentVersion: '1',
        },
        lifecycle: 'available',
      }],
      commands: [{
        candidateId: 'command-1',
        definition: {
          id: { source: productSource, localId: 'review' },
          name: 'Review',
          description: 'Review changes',
          availability: { state: 'available' },
          contentVersion: '1',
        },
      }],
      tools: [{
        definition: {
          id: { target: { source: productSource, localId: 'tool-1' }, exportId: 'search' },
          name: 'Search',
          descriptionPreview: 'Search files',
        },
      }],
      subagents: [{
        candidateId: 'agent-1',
        displayName: 'Reviewer',
        description: 'Reviews code',
        sourceKeys: [productSource],
      }],
      mcpServers: [{
        candidateId: 'mcp-1',
        definition: {
          id: { source: productSource, localId: 'filesystem' },
          name: 'Filesystem',
          transport: 'local_stdio',
        },
      }],
      integrationPolicy: {
        registeredEcosystems: [{
          ecosystemId: 'opencode',
          displayName: 'OpenCode',
          adapterRevision: 'r1',
          capabilities: [],
        }],
      },
    } as ExternalSourceCatalogSnapshot;
    const runtime = buildEcosystemProductRuntimes(snapshot, [])
      .find((candidate) => candidate.spec.id === 'opencode');

    expect(runtime).toBeDefined();
    const items = buildEcosystemImportItems(snapshot, runtime!);
    expect(runtime!.capabilityCounts).not.toHaveProperty('reference');
    expect(totalDiscoveredAssets(runtime!.capabilityCounts)).toBe(4);
    expect(items.filter((item) => item.discovered).map((item) => item.kind)).toEqual([
      'command',
      'tool',
      'subagent',
      'mcp',
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'command', 'tool', 'subagent', 'skill', 'mcp', 'hook', 'instruction',
      'account', 'settings', 'memory', 'plugin',
    ]);
    expect(items.find((item) => item.kind === 'mcp')?.discoverySupport).toBe('supported');
    expect(items.find((item) => item.kind === 'skill')).toEqual(expect.objectContaining({
      discovered: false,
      discoverySupport: 'supported',
      detection: 'owner',
    }));
    expect(items.find((item) => item.kind === 'memory')?.discoverySupport).toBe('unsupported');
    expect(items.find((item) => item.kind === 'pet')).toBeUndefined();
    expect(items.find((item) => item.kind === 'account')?.discoverySupport).toBe('unsupported');
    expect(items.find((item) => item.kind === 'plugin')?.discoverySupport).toBe('unsupported');
    expect(items.find((item) => item.kind === 'skill')?.usageState).toBeUndefined();

    const scene = source('./EcosystemCompatibilityScene.tsx');
    const content = source('./ExternalAgentContent.tsx');
    expect(content).toContain('disabled={confirmDisabled}');
    expect(content).toContain('data-discovery-support={item.discoverySupport}');
    expect(content).toContain('data-import-discovered={item.discovered');
    expect(scene).not.toContain("'notApplicable'");
    expect(scene).not.toContain('getWorkspaceReferences');
    expect(ECOSYSTEM_IMPORT_ITEM_KINDS).not.toContain('reference');
    expect(ECOSYSTEM_IMPORT_ITEM_KINDS).not.toContain('miniapp');
    expect(ECOSYSTEM_IMPORT_ITEM_KINDS).not.toContain('appearance');
  });

  it('keeps all applicable kinds visible and disabled when a product has no discovered items', () => {
    const runtime = buildEcosystemProductRuntimes(null, [])
      .find((candidate) => candidate.spec.id === 'codex');

    expect(runtime).toBeDefined();
    const items = buildEcosystemImportItems(null, runtime!);

    expect(items.map((item) => item.kind)).toEqual([
      'subagent', 'skill', 'mcp', 'hook', 'instruction', 'pet',
      'account', 'settings', 'memory', 'plugin',
    ]);
    expect(items.every((item) => item.discovered === false)).toBe(true);
    expect(items.every((item) => item.candidateId === undefined)).toBe(true);
    expect(items.find((item) => item.kind === 'command')).toBeUndefined();
    expect(items.find((item) => item.kind === 'tool')).toBeUndefined();
    expect(items.find((item) => item.kind === 'subagent')).toEqual(expect.objectContaining({
      discoverySupport: 'supported',
      detection: 'catalog',
    }));
    expect(items.find((item) => item.kind === 'skill')).toEqual(expect.objectContaining({
      discoverySupport: 'supported',
      detection: 'owner',
    }));
    expect(items.find((item) => item.kind === 'memory')?.discoverySupport).toBe('unsupported');
    expect(items.find((item) => item.kind === 'pet')?.discoverySupport).toBe('supported');
  });

  it('uses product-specific compatibility instead of one shared capability set', () => {
    const runtimes = buildEcosystemProductRuntimes(null, []);
    const support = (productId: 'claude-code' | 'codex' | 'pi' | 'dsh' | 'opencode') => (
      Object.fromEntries(buildEcosystemImportItems(
        null,
        runtimes.find((runtime) => runtime.spec.id === productId)!,
      ).map((item) => [item.kind, item.discoverySupport]))
    );

    const openCodeSupport = support('opencode');
    expect(openCodeSupport).toMatchObject({
      command: 'supported',
      tool: 'supported',
      subagent: 'supported',
      skill: 'supported',
      mcp: 'supported',
      hook: 'supported',
      memory: 'unsupported',
    });
    expect(openCodeSupport).not.toHaveProperty('pet');

    const claudeSupport = support('claude-code');
    expect(claudeSupport).toMatchObject({
      command: 'supported',
      memory: 'unsupported',
    });
    expect(claudeSupport).not.toHaveProperty('tool');
    expect(claudeSupport).not.toHaveProperty('pet');

    const codexSupport = support('codex');
    expect(codexSupport).toMatchObject({
      memory: 'unsupported',
      pet: 'supported',
    });
    expect(codexSupport).not.toHaveProperty('command');
    expect(codexSupport).not.toHaveProperty('tool');

    const piSupport = support('pi');
    expect(piSupport).toMatchObject({
      memory: 'unsupported',
      skill: 'supported',
      hook: 'supported',
    });
    expect(piSupport).not.toHaveProperty('pet');
    expect(support('dsh')).toMatchObject({ skill: 'supported', hook: 'supported', mcp: 'supported' });
  });

  it('keeps use and import in one page', () => {
    const scene = source('./EcosystemCompatibilityScene.tsx');
    const model = source('./ecosystemCompatibilityModel.ts');
    const runPosition = scene.lastIndexOf('renderRun()');
    const importPosition = scene.search(/<ExternalAgentContent\s/);

    expect(runPosition).toBeGreaterThan(-1);
    expect(importPosition).toBeGreaterThan(runPosition);
    expect(scene).toContain('ecosystem-compatibility__unified-stack');
    expect(scene).not.toContain('renderDiagnostics');
    expect(scene).toContain('actionsRef={externalContentRef}');
    expect(scene).not.toContain('<MoreHorizontal');
    expect(scene).not.toContain("t('diagnostics.refresh')");
    expect(scene).not.toContain('role="tablist"');
    expect(scene).not.toContain('renderOverview');
    expect(scene).not.toContain('activeView');
    expect(model).not.toContain('EcosystemCompatibilityView');
    expect(model).not.toContain('isEcosystemCompatibilityViewAvailable');
  });

  it('uses user-facing copy and lets sections fill the available content width', () => {
    const scene = source('./EcosystemCompatibilityScene.tsx');
    const styles = source('./EcosystemCompatibilityScene.scss');
    const zhCN = source('../../../locales/zh-CN/scenes/ecosystem-compatibility.json');

    expect(styles).not.toContain('width: min(100%, 980px);');
    expect(styles).not.toContain('max-width: 68ch;');
    expect(zhCN).toContain('"title": "导入与复用"');
    expect(zhCN).not.toMatch(/真实能力|适配范围|全部对象|直接导入链路|能力模块|第二套客户端状态/);
    const content = source('./ExternalAgentContent.tsx');
    expect(content).toContain("t('content.prepareImport')");
    expect(content).toContain("t('content.setupRequired')");
    expect(scene).not.toContain('ecosystem-compatibility__import-action-placeholder');
  });

  it('preserves design-system alert insets and consistent dialog spacing', () => {
    const styles = source('./EcosystemCompatibilityScene.scss');
    const block = (name: string) => styles.slice(styles.indexOf(`&__${name} {`)).split('\n  }')[0];

    expect(block('notice')).not.toMatch(/(?:padding|border|background|font):/);
    expect(block('batch-status')).toContain('var(--openbitfun-overlay-dialog-content-padding-lg)');
    expect(block('content-expanded')).toContain('padding: 0 var(--openbitfun-space-4) var(--openbitfun-space-4)');
    expect(block('import-action')).toContain('flex-wrap: wrap');
    expect(block('metadata')).toContain('align-items: baseline');
    expect(block('metadata')).toContain('margin: 0');
    expect(block('content-detail')).not.toContain('margin-block-end:');
  });

  it('uses heading and action slots for every import dialog header', () => {
    for (const file of ['ExternalAgentContent.tsx', 'EcosystemPets.tsx', 'EcosystemCompatibilityScene.tsx']) {
      const headers = [...source(`./${file}`).matchAll(/<DialogHeader>([\s\S]*?)<\/DialogHeader>/g)];
      expect(headers.length).toBeGreaterThan(0);
      for (const [, header] of headers) {
        expect(header).toContain('<DialogHeading>');
        expect(header).toContain('<DialogHeaderActions>');
      }
    }
  });

  it('lets the page inherit the surrounding scene surface', () => {
    const styles = source('./EcosystemCompatibilityScene.scss');

    expect(styles).not.toContain('background: var(--openbitfun-color-surface-scene);');
    expect(styles).not.toContain('background: var(--openbitfun-color-surface-canvas);');
  });

  it('keeps Oh My Pi and generic ACP agents out of the product catalog', () => {
    const clients = ['omp', 'custom-acp'].map((id) => ({
      id,
      name: id === 'omp' ? 'Oh My Pi' : 'Custom ACP',
      command: id,
      args: ['acp'],
      enabled: true,
      readonly: true,
      permissionMode: 'ask' as const,
      status: 'configured' as const,
      toolName: id,
      sessionCount: 0,
    }));
    const runtimes = buildEcosystemProductRuntimes(null, clients);

    expect(runtimes.map((runtime) => runtime.spec.id)).toEqual([
      'claude-code',
      'codex',
      'zcode',
      'pi',
      'dsh',
      'opencode',
      'cursor',
    ]);
    expect(runtimes.flatMap((runtime) => runtime.acpClients)).toEqual([]);
    const zcode = runtimes.find((runtime) => runtime.spec.id === 'zcode')!;
    expect(zcode.spec.sessionImport).toBe('zcode');
    expect(zcode.spec.acpClientId).toBeUndefined();
    expect(zcode.capabilityIds).not.toContain('runtime');
  });

  it('uses locally cached official product marks instead of generic product glyphs', () => {
    const scene = source('./EcosystemCompatibilityScene.tsx');
    for (const productId of ['claude-code', 'codex', 'zcode', 'pi', 'dsh', 'opencode', 'cursor']) {
      const icon = getProductBrandIcon(productId);
      expect(icon).toBeDefined();
      for (const path of [icon!.src, icon!.darkSrc].filter(Boolean)) {
        expect(path).toMatch(/^\/assets\/ecosystem-compatibility\//);
        expect(source(`../../../../public${path}`).length).toBeGreaterThan(0);
      }
    }
    expect(getProductBrandIcon('zcode_cn')).toBe(getProductBrandIcon('zcode'));
    expect(scene).toContain("from '@/shared/ui/ProductBrandIcon'");
    expect(scene).toContain('<ProductBrandIcon productId={runtime.spec.id} size="100%" />');
    expect(scene).toContain('<ProductBrandIcon productId={selectedRuntime.spec.id} size={38} />');
    expect(scene).not.toContain('PRODUCT_ICON_SOURCES');
    expect(scene).not.toContain('PRODUCT_FALLBACK_ICONS');
    expect(scene).not.toContain("'other-acp'");
  });

  it('does not expose the removed use-OpenBitFun-in-product view', () => {
    const scene = source('./EcosystemCompatibilityScene.tsx');
    const model = source('./ecosystemCompatibilityModel.ts');

    expect(scene).not.toContain("'use-openbitfun'");
    expect(model).not.toContain("'use-openbitfun'");
  });
});
