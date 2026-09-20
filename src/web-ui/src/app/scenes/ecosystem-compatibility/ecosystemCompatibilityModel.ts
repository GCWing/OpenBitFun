import { contentUsageState, type ContentUsageState } from './ecosystemContentPresentation';
import type { AcpClientInfo } from '@/infrastructure/api/service-api/ACPClientAPI';
import type { ExternalSourceCatalogSnapshot } from '@/infrastructure/api/service-api/ExternalSourcesAPI';

export type EcosystemProductId =
  | 'cursor'
  | 'claude-code'
  | 'codex'
  | 'pi'
  | 'dsh'
  | 'opencode';

export type CompatibilityCapabilityId =
  | 'command'
  | 'tool'
  | 'subagent'
  | 'mcp'
  | 'runtime';

export type EcosystemProductGroup = 'identified' | 'more' | 'other';

export interface EcosystemProductSpec {
  id: EcosystemProductId;
  name: string;
  ecosystemId: string;
  acpClientId?: string;
  development?: boolean;
  searchTerms: readonly string[];
}

export interface CompatibilityCapabilityCounts {
  command: number;
  tool: number;
  subagent: number;
  mcp: number;
  runtime: number;
}

export interface EcosystemProductRuntime {
  spec: EcosystemProductSpec;
  group: EcosystemProductGroup;
  sources: ExternalSourceCatalogSnapshot['sources'];
  acpClients: AcpClientInfo[];
  acpClient?: AcpClientInfo;
  capabilityIds: CompatibilityCapabilityId[];
  capabilityCounts: CompatibilityCapabilityCounts;
  adapterRevision?: string;
  sourceLocation?: string;
  executionDomainId?: string;
}

/**
 * Product-level objects that can participate in import and reuse. This catalog
 * is intentionally broader than the external-runtime capability contract: the
 * UI keeps every applicable object type in the compatibility catalog visible
 * even when the selected product exposes no candidates or no direct import
 * bridge yet. Object types absent from the upstream product are omitted.
 */
export type EcosystemImportItemKind =
  | 'account'
  | 'settings'
  | 'command'
  | 'tool'
  | 'subagent'
  | 'skill'
  | 'mcp'
  | 'hook'
  | 'instruction'
  | 'memory'
  | 'plugin'
  | 'pet';

export type EcosystemDiscoverySupport =
  | 'supported'
  | 'unsupported'
  | 'notApplicable';

export type EcosystemCompatibilityDetection = 'catalog' | 'owner';

export interface EcosystemImportItem {
  id: string;
  kind: EcosystemImportItemKind;
  name: string;
  description?: string;
  sourceName: string;
  sourceLocation?: string;
  candidateId?: string;
  discoverySupport: EcosystemDiscoverySupport;
  usageState?: ContentUsageState;
  detection: EcosystemCompatibilityDetection;
  discovered: boolean;
}

export const ECOSYSTEM_IMPORT_ITEM_KINDS: readonly EcosystemImportItemKind[] = [
  'account',
  'settings',
  'command',
  'tool',
  'subagent',
  'skill',
  'mcp',
  'hook',
  'instruction',
  'memory',
  'plugin',
  'pet',
];

/**
 * Discovery coverage in this page, not import or runtime support. These are deliberately explicit:
 * a missing discovery result must not imply that every upstream product offers
 * every object type. Catalog-backed kinds are discovered by this page; Skill
 * and Hook discovery stays with their existing capability owners.
 */
const PRODUCT_DISCOVERY_KINDS = {
  cursor: ['skill'],
  'claude-code': ['command', 'subagent', 'skill', 'mcp', 'hook'],
  codex: ['subagent', 'skill', 'mcp', 'hook', 'pet'],
  pi: ['skill', 'hook'],
  dsh: ['skill', 'hook', 'mcp'],
  opencode: ['command', 'tool', 'subagent', 'skill', 'mcp', 'hook'],
} as const satisfies Record<EcosystemProductId, readonly EcosystemImportItemKind[]>;

const PRODUCT_NOT_APPLICABLE_KINDS = {
  cursor: ECOSYSTEM_IMPORT_ITEM_KINDS.filter((kind) => kind !== 'skill'),
  'claude-code': ['tool', 'pet'],
  codex: ['command', 'tool'],
  pi: ['pet'],
  dsh: ['pet'],
  opencode: ['pet'],
} as const satisfies Record<EcosystemProductId, readonly EcosystemImportItemKind[]>;

const OWNER_DETECTED_KINDS = new Set<EcosystemImportItemKind>(['skill', 'hook', 'instruction', 'pet']);

export function ecosystemDiscoverySupport(
  productId: EcosystemProductId,
  kind: EcosystemImportItemKind,
): EcosystemDiscoverySupport {
  // The instruction owner also reports shared workspace AGENTS documents.
  if (kind === 'instruction' && productId !== 'cursor') return 'supported';
  const discoveryKinds = PRODUCT_DISCOVERY_KINDS[productId] as readonly EcosystemImportItemKind[];
  if (discoveryKinds.includes(kind)) return 'supported';

  const notApplicableKinds = PRODUCT_NOT_APPLICABLE_KINDS[productId] as readonly EcosystemImportItemKind[];
  return notApplicableKinds.includes(kind) ? 'notApplicable' : 'unsupported';
}

/**
 * Presentation catalog for product families already represented by a shipped
 * adapter or ACP preset. Skill and Hook discovery does not imply ACP execution.
 */
export const ECOSYSTEM_PRODUCT_SPECS: readonly EcosystemProductSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    ecosystemId: 'claude-code',
    acpClientId: 'claude-code',
    searchTerms: ['claude', 'anthropic', 'agent', 'mcp', 'command', 'acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    ecosystemId: 'codex',
    acpClientId: 'codex',
    searchTerms: ['openai', 'agent', 'mcp', 'acp'],
  },
  {
    id: 'pi',
    name: 'Pi',
    ecosystemId: 'pi',
    searchTerms: ['pi', 'agent'],
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    ecosystemId: 'deepseek-harness',
    acpClientId: 'dsh',
    searchTerms: ['deepseek', 'harness', 'dsh', 'agent', 'acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    ecosystemId: 'opencode',
    acpClientId: 'opencode',
    searchTerms: ['open code', 'agent', 'command', 'tool', 'mcp', 'acp'],
  },
  { id: 'cursor', name: 'Cursor', ecosystemId: 'cursor', searchTerms: ['.cursor', 'skills'] },
] as const;

function sourcePairKey(providerId: string, sourceId: string): string {
  return `${providerId}\u0000${sourceId}`;
}

function itemSource(
  sources: ExternalSourceCatalogSnapshot['sources'],
  source: { providerId: string; sourceId: string },
) {
  const key = sourcePairKey(source.providerId, source.sourceId);
  return sources.find((candidate) => sourcePairKey(
    candidate.record.key.providerId,
    candidate.record.key.sourceId,
  ) === key);
}

function productSources(
  snapshot: ExternalSourceCatalogSnapshot | null,
  ecosystemId: string | undefined,
): ExternalSourceCatalogSnapshot['sources'] {
  if (!snapshot || !ecosystemId) return [];
  return snapshot.sources.filter((source) => source.record.ecosystemId === ecosystemId);
}

export function catalogDiscoveryState(
  snapshot: ExternalSourceCatalogSnapshot | null,
  ecosystemId: string | undefined,
  capabilityId: string,
): 'checking' | 'notScanned' | 'discoveryDisabled' | 'discoveryUnavailable' | 'notDetected' {
  if (!snapshot) return 'checking';
  if (snapshot.discovery) {
    if (snapshot.discovery.retainedKinds?.includes(capabilityId)) return 'discoveryUnavailable';
    if (snapshot.discovery.discoverableCapabilities
      && !snapshot.discovery.discoverableCapabilities[ecosystemId ?? '']?.includes(capabilityId)) return 'notScanned';
    if (!snapshot.discovery.hasScanned) return snapshot.discovery.enabled ? 'checking' : 'notScanned';
    if (snapshot.discoveryPending) return 'checking';
    const failed = productSources(snapshot, ecosystemId).some((source) => (
      ['unavailable', 'degraded'].includes(source.record.health)
      && (!source.record.diagnostics?.length || source.record.diagnostics.some((diagnostic) =>
        !diagnostic.assetKind || diagnostic.assetKind === 'source' || diagnostic.assetKind === capabilityId))
    ));
    const failedScan = snapshot.diagnostics?.some((diagnostic) =>
      !diagnostic.assetKind || diagnostic.assetKind === 'source' || diagnostic.assetKind === capabilityId);
    return failed || failedScan ? 'discoveryUnavailable' : 'notDetected';
  }
  const policy = snapshot.integrationPolicy;
  if (policy?.status !== 'compatible') return 'discoveryUnavailable';
  if (policy.effective?.enabled === false) return 'discoveryDisabled';
  if (policy.effective?.enabled !== true) return 'discoveryUnavailable';
  const access = ecosystemId
    ? policy.effective.ecosystems?.[ecosystemId]?.capabilities?.[capabilityId]
    : undefined;
  if (access === 'disabled') return 'discoveryDisabled';
  if (!access || !['discover_only', 'ask_before_use', 'auto'].includes(access)) {
    return 'discoveryUnavailable';
  }
  if (snapshot.discoveryPending) return 'checking';
  const failedSource = productSources(snapshot, ecosystemId).some((source) => (
    ['unavailable', 'degraded'].includes(source.record.health)
    && source.record.diagnostics?.some((diagnostic) => diagnostic.assetKind === capabilityId)
  ));
  return failedSource ? 'discoveryUnavailable' : 'notDetected';
}

function capabilityCounts(
  snapshot: ExternalSourceCatalogSnapshot | null,
  sources: ExternalSourceCatalogSnapshot['sources'],
  acpClients: AcpClientInfo[],
): CompatibilityCapabilityCounts {
  if (!snapshot) {
    return {
      command: 0,
      tool: 0,
      subagent: 0,
      mcp: 0,
      runtime: acpClients.filter((client) => client.enabled).length,
    };
  }

  const sourcePairs = new Set(sources.map((source) => sourcePairKey(
    source.record.key.providerId,
    source.record.key.sourceId,
  )));
  const belongsToProduct = (source: { providerId: string; sourceId: string }): boolean => (
    sourcePairs.has(sourcePairKey(source.providerId, source.sourceId))
  );

  return {
    command: snapshot.commands.filter((command) => belongsToProduct(command.definition.id.source)).length,
    tool: (snapshot.tools ?? []).filter((tool) => (
      belongsToProduct(tool.definition.id.target.source)
    )).length,
    subagent: (snapshot.subagents ?? []).filter((agent) => (
      agent.sourceKeys.some(belongsToProduct)
    )).length,
    mcp: (snapshot.mcpServers ?? []).filter((server) => (
      belongsToProduct(server.definition.id.source)
    )).length,
    runtime: acpClients.filter((client) => client.enabled).length,
  };
}

function runtimeGroup(spec: EcosystemProductSpec, sources: EcosystemProductRuntime['sources'], clients: AcpClientInfo[]): EcosystemProductGroup {
  if (spec.development) return 'other';
  const identifiedSource = sources.some((source) => source.lifecycle !== 'removed'
    && ['available', 'partial'].includes(source.record.health));
  const configuredByUser = clients.some((client) => client.readonly === false
    || client.status === 'running' || client.status === 'starting');
  return identifiedSource || configuredByUser ? 'identified' : 'more';
}

function knownCapabilityId(value: string): value is Exclude<CompatibilityCapabilityId, 'runtime'> {
  return value === 'command'
    || value === 'tool'
    || value === 'subagent'
    || value === 'mcp';
}

export function buildEcosystemProductRuntimes(
  snapshot: ExternalSourceCatalogSnapshot | null,
  clients: readonly AcpClientInfo[],
): EcosystemProductRuntime[] {
  return ECOSYSTEM_PRODUCT_SPECS.map((spec) => {
    const sources = productSources(snapshot, spec.ecosystemId);
    const descriptor = spec.ecosystemId
      ? snapshot?.integrationPolicy?.registeredEcosystems?.find(
          (candidate) => candidate.ecosystemId === spec.ecosystemId,
        )
      : undefined;
    const acpClients = spec.acpClientId
      ? clients.filter((client) => client.id === spec.acpClientId)
      : [];
    const acpClient = spec.acpClientId
      ? acpClients.find((client) => client.id === spec.acpClientId)
      : undefined;
    const capabilityIds: CompatibilityCapabilityId[] = descriptor?.capabilities
      .map((capability) => capability.capabilityId)
      .filter(knownCapabilityId) ?? [];
    if (spec.acpClientId && !capabilityIds.includes('runtime')) {
      capabilityIds.push('runtime');
    }
    const counts = capabilityCounts(snapshot, sources, acpClients);

    return {
      spec,
      group: totalDiscoveredAssets(counts) > 0
        ? 'identified' : runtimeGroup(spec, sources, acpClients),
      sources,
      acpClients,
      acpClient,
      capabilityIds,
      capabilityCounts: counts,
      adapterRevision: descriptor?.adapterRevision,
      sourceLocation: sources[0]?.record.location ?? acpClients[0]?.command,
      executionDomainId: sources[0]?.record.executionDomainId,
    };
  });
}

export function buildEcosystemImportItems(
  snapshot: ExternalSourceCatalogSnapshot | null,
  runtime: EcosystemProductRuntime,
): EcosystemImportItem[] {
  const belongsToProduct = (source: { providerId: string; sourceId: string }): boolean => (
    itemSource(runtime.sources, source) !== undefined
  );
  const sourceFacts = (source: { providerId: string; sourceId: string }) => {
    const match = itemSource(runtime.sources, source);
    return {
      sourceName: match?.record.displayName ?? runtime.spec.name,
      sourceLocation: match?.record.location,
    };
  };
  // Only a host that explicitly advertises execution can attest to direct usability.
  const usage = (source: { providerId: string; sourceId: string }, kind: string, state?: string): ContentUsageState => {
    // The static discovery endpoint does not attest to runtime activation.
    if (snapshot?.discovery) return 'unknown';
    if (snapshot?.hostCapabilities?.canExecuteExternalAssets !== true) {
      return snapshot?.hostCapabilities?.canExecuteExternalAssets === false ? 'runtimeUnavailable' : 'unknown';
    }
    const access = snapshot.integrationPolicy?.effective?.ecosystems?.[runtime.spec.ecosystemId]?.capabilities?.[kind];
    if (access === 'disabled' || access === 'discover_only') return 'disabled';
    if (access !== 'auto' && access !== 'ask_before_use') return 'unknown';
    const lifecycle = itemSource(runtime.sources, source)?.lifecycle;
    if (lifecycle === 'suppressed') return 'disabled';
    if (lifecycle === 'removed' || lifecycle === 'unavailable') return 'runtimeUnavailable';
    if (lifecycle === 'restricted') return 'blocked';
    return contentUsageState(state);
  };
  const items: EcosystemImportItem[] = [];

  for (const command of snapshot?.commands ?? []) {
    const source = command.definition.id.source;
    if (!belongsToProduct(source)) continue;
    const conflict = snapshot?.commandConflicts?.find((entry) => entry.commandName === command.definition.name);
    const commandUsage = usage(source, 'command', command.definition.availability?.state);
    items.push({
      id: `command:${command.candidateId ?? `${source.providerId}/${source.sourceId}:${command.definition.id.localId}`}`,
      kind: 'command',
      name: command.definition.name,
      description: command.definition.description,
      usageState: commandUsage === 'available' && conflict
        && (!command.candidateId || conflict.selectedCandidateId !== command.candidateId) ? 'conflict' : commandUsage,
      ...sourceFacts(source),
      discoverySupport: 'supported',
      detection: 'catalog',
      discovered: true,
    });
  }

  for (const tool of snapshot?.tools ?? []) {
    const source = tool.definition.id.target.source;
    if (!belongsToProduct(source)) continue;
    items.push({
      id: `tool:${source.providerId}/${source.sourceId}:${tool.definition.id.exportId}`,
      kind: 'tool',
      name: tool.definition.name,
      description: tool.definition.descriptionPreview,
      usageState: usage(source, 'tool', tool.activation?.state),
      ...sourceFacts(source),
      discoverySupport: 'supported',
      detection: 'catalog',
      discovered: true,
    });
  }

  for (const agent of snapshot?.subagents ?? []) {
    const source = agent.sourceKeys.find(belongsToProduct);
    if (!source) continue;
    items.push({
      id: `subagent:${agent.candidateId}`,
      kind: 'subagent',
      name: agent.displayName,
      description: agent.description,
      usageState: usage(source, 'subagent', agent.activationState?.state),
      ...sourceFacts(source),
      discoverySupport: 'supported',
      detection: 'catalog',
      discovered: true,
    });
  }

  for (const server of snapshot?.mcpServers ?? []) {
    const source = server.definition.id.source;
    if (!belongsToProduct(source)) continue;
    items.push({
      id: `mcp:${server.candidateId}`,
      kind: 'mcp',
      name: server.definition.name,
      ...sourceFacts(source),
      candidateId: server.candidateId,
      discoverySupport: 'supported',
      detection: 'catalog',
      discovered: true,
    });
  }

  for (const kind of ECOSYSTEM_IMPORT_ITEM_KINDS) {
    if (items.some((item) => item.kind === kind)) continue;
    const support = ecosystemDiscoverySupport(runtime.spec.id, kind);
    if (support === 'notApplicable') continue;
    items.push({
      id: `undetected:${kind}`,
      kind,
      name: kind,
      sourceName: runtime.spec.name,
      discoverySupport: support,
      detection: support === 'supported' && OWNER_DETECTED_KINDS.has(kind)
        ? 'owner'
        : 'catalog',
      discovered: false,
    });
  }

  const kindOrder: Record<EcosystemImportItemKind, number> = {
    account: 0,
    settings: 1,
    command: 2,
    tool: 3,
    subagent: 4,
    skill: 5,
    mcp: 6,
    hook: 7,
    instruction: 8,
    memory: 9,
    plugin: 10,
    pet: 11,
  };
  return items.sort((left, right) => (
    Number(right.discoverySupport === 'supported') - Number(left.discoverySupport === 'supported')
    || kindOrder[left.kind] - kindOrder[right.kind]
    || left.name.localeCompare(right.name)
  ));
}

export function totalDiscoveredAssets(counts: CompatibilityCapabilityCounts): number {
  return counts.command + counts.tool + counts.subagent + counts.mcp;
}

/** Native subscription connections are separate from external credential discovery. */
export function ecosystemAccountProvider(product: EcosystemProductId): 'codex' | 'opencode' | undefined {
  return product === 'codex' || product === 'opencode' ? product : undefined;
}
