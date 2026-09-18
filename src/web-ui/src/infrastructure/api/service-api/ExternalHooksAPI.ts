import {
  ExternalSourceApiError,
  invokeExternalSourceCommand,
  normalizeOptionalWorkspaceId,
} from './ExternalSourcesAPI';

export interface ExternalHookSourceKey {
  providerId: string;
  sourceId: string;
}

export interface ExternalHookDiagnostic {
  severity: 'info' | 'warning' | 'error';
  assetKind: 'hook';
  code: string;
  message: string;
  source?: ExternalHookSourceKey;
}

export interface ExternalHookProviderIdentity {
  providerId: string;
  ecosystemId: string;
  displayName: string;
}

export interface ExternalHookSource {
  key: ExternalHookSourceKey;
  ecosystemId: string;
  displayName: string;
  sourceKind: 'settings' | 'plugin_file' | 'package_declaration' | 'hooks_file' | 'inline_configuration';
  scope: 'user_global' | 'project' | 'workspace_local' | 'remote_user' | 'remote_project';
  locationHint: string;
  health: 'available' | 'partial' | 'degraded' | 'unavailable';
  contentVersion: string;
  diagnostics: ExternalHookDiagnostic[];
}

export type ExternalHookMatcher =
  | { kind: 'any' }
  | { kind: 'pattern'; display: string }
  | { kind: 'dynamic' }
  | { kind: 'unavailable' };

export interface ExternalHookCatalogEntry {
  stableKey: string;
  source: ExternalHookSourceKey;
  nativeEvent: string;
  matcher: ExternalHookMatcher;
  handlerKind: 'function' | 'command' | 'http' | 'mcp_tool' | 'prompt' | 'agent';
  projectionStatus: 'mapped' | 'native_only' | 'opaque';
  nativeActivation: 'disabled' | 'unsupported' | 'unknown';
  mapping?: { hookPoint: 'tool_before' | 'tool_after' };
  contentVersion: string;
}

export interface ExternalHookCatalogSnapshot {
  schemaVersion: 1;
  discoveryPending: boolean;
  providers: ExternalHookProviderIdentity[];
  sources: ExternalHookSource[];
  entries: ExternalHookCatalogEntry[];
  staleProviderIds: string[];
  failedProviderIds: string[];
  diagnostics: ExternalHookDiagnostic[];
}

export type ExternalHookImportDependency =
  | { kind: 'managed'; relativePath: string }
  | { kind: 'external'; location: string };

export interface ExternalHookImportHandler {
  stableKey: string;
  event: string;
  matcher?: string;
  command: string;
  commandWindows?: string;
  timeoutSeconds?: number;
  statusMessage?: string;
  dependencies: ExternalHookImportDependency[];
}

export interface ExternalHookImportPlan {
  schemaVersion: 1;
  source: ExternalHookSource;
  disposition: 'import' | 'update' | 'unchanged' | 'unavailable';
  behaviorVersion: string;
  handlers: ExternalHookImportHandler[];
  skipped: Array<{ reasonCode: string; count: number }>;
  planFingerprint: string;
}

export interface ImportedHookSourceSnapshot {
  importId: string;
  source: ExternalHookSource;
  enabled: boolean;
  behaviorVersion: string;
  state: 'current' | 'update_available' | 'source_missing' | 'update_check_failed'
    | 'bundle_missing';
}

export interface ExternalHookImportSnapshot {
  schemaVersion: 1;
  revision: string;
  catalog: ExternalHookCatalogSnapshot;
  imports: ImportedHookSourceSnapshot[];
  diagnostics: ExternalHookDiagnostic[];
}

export type ExternalHookImportApplyResult = {
  schemaVersion: 1;
  outcome:
    | { kind: 'applied' | 'unchanged'; snapshot: ExternalHookImportSnapshot }
    | { kind: 'stale'; refreshedPlan: ExternalHookImportPlan };
};

export type ExternalHookImportMutation =
  | { kind: 'set_enabled'; importId: string; enabled: boolean }
  | { kind: 'remove'; importId: string }
  | { kind: 'reset_corrupt_store'; scope: ExternalHookSource['scope'] };

const MAX_CATALOG_ITEMS = 8192;
const MAX_PROVIDER_ITEMS = 2048;
const MAX_SOURCE_DIAGNOSTICS = 256;

function enumString<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  const candidate = boundedString(value, 64);
  if (!allowed.includes(candidate)) invalidResponse();
  return candidate;
}

function invalidResponse(): never {
  throw new ExternalSourceApiError(
    'invalid_response',
    'The Host returned an invalid external Hook catalog',
    false,
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  return record;
}

function boundedString(value: unknown, maxLength = 512): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })) {
    invalidResponse();
  }
  return value;
}

function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ITEMS) invalidResponse();
  return value;
}

function sourceKey(value: unknown): ExternalHookSourceKey {
  const record = exactRecord(value, ['providerId', 'sourceId']);
  return {
    providerId: boundedString(record.providerId, 160),
    sourceId: boundedString(record.sourceId, 160),
  };
}

function provider(value: unknown): ExternalHookProviderIdentity {
  const record = exactRecord(value, ['providerId', 'ecosystemId', 'displayName']);
  return {
    providerId: boundedString(record.providerId, 160),
    ecosystemId: boundedString(record.ecosystemId, 160),
    displayName: boundedString(record.displayName),
  };
}

function diagnostic(value: unknown): ExternalHookDiagnostic {
  const record = exactRecord(
    value,
    ['severity', 'assetKind', 'code', 'message'],
    ['source'],
  );
  return {
    severity: enumString(record.severity, ['info', 'warning', 'error'] as const),
    assetKind: enumString(record.assetKind, ['hook'] as const),
    code: boundedString(record.code, 160),
    message: boundedString(record.message, 4096),
    ...(record.source === undefined ? {} : { source: sourceKey(record.source) }),
  };
}

function diagnostics(value: unknown, maxItems = MAX_CATALOG_ITEMS): ExternalHookDiagnostic[] {
  if (value === undefined) return [];
  const items = boundedArray(value);
  if (items.length > maxItems) invalidResponse();
  return items.map(diagnostic);
}

function matcher(value: unknown): ExternalHookMatcher {
  const tagged = exactRecord(value, ['kind'], ['display']);
  switch (tagged.kind) {
    case 'any':
    case 'dynamic':
    case 'unavailable':
      if (tagged.display !== undefined) invalidResponse();
      return { kind: tagged.kind };
    case 'pattern':
      return { kind: 'pattern', display: boundedString(tagged.display) };
    default:
      return invalidResponse();
  }
}

function source(value: unknown): ExternalHookSource {
  const record = exactRecord(value, [
    'key',
    'ecosystemId',
    'displayName',
    'sourceKind',
    'scope',
    'locationHint',
    'health',
    'contentVersion',
  ], ['diagnostics']);
  const key = sourceKey(record.key);
  const sourceDiagnostics = diagnostics(record.diagnostics, MAX_SOURCE_DIAGNOSTICS);
  if (sourceDiagnostics.some((item) => item.source !== undefined
    && (item.source.providerId !== key.providerId || item.source.sourceId !== key.sourceId))) {
    invalidResponse();
  }
  return {
    key,
    ecosystemId: boundedString(record.ecosystemId, 160),
    displayName: boundedString(record.displayName),
    sourceKind: enumString(record.sourceKind, [
      'settings',
      'plugin_file',
      'package_declaration',
      'hooks_file',
      'inline_configuration',
    ] as const),
    scope: enumString(record.scope, [
      'user_global',
      'project',
      'workspace_local',
      'remote_user',
      'remote_project',
    ] as const),
    locationHint: boundedString(record.locationHint),
    health: enumString(record.health, [
      'available',
      'partial',
      'degraded',
      'unavailable',
    ] as const),
    contentVersion: boundedString(record.contentVersion, 160),
    diagnostics: sourceDiagnostics,
  };
}

function entry(value: unknown): ExternalHookCatalogEntry {
  const record = exactRecord(value, [
    'stableKey',
    'source',
    'nativeEvent',
    'matcher',
    'handlerKind',
    'projectionStatus',
    'nativeActivation',
    'contentVersion',
  ], ['mapping']);
  const projectionStatus = enumString(record.projectionStatus, [
    'mapped',
    'native_only',
    'opaque',
  ] as const);
  let mapping: ExternalHookCatalogEntry['mapping'];
  if (record.mapping !== undefined) {
    const mapped = exactRecord(record.mapping, ['hookPoint']);
    mapping = {
      hookPoint: enumString(mapped.hookPoint, ['tool_before', 'tool_after'] as const),
    };
  }
  if ((projectionStatus === 'mapped') !== Boolean(mapping)) invalidResponse();
  return {
    stableKey: boundedString(record.stableKey, 160),
    source: sourceKey(record.source),
    nativeEvent: boundedString(record.nativeEvent, 160),
    matcher: matcher(record.matcher),
    handlerKind: enumString(record.handlerKind, [
      'function',
      'command',
      'http',
      'mcp_tool',
      'prompt',
      'agent',
    ] as const),
    projectionStatus,
    nativeActivation: enumString(record.nativeActivation, [
      'disabled',
      'unsupported',
      'unknown',
    ] as const),
    ...(mapping ? { mapping } : {}),
    contentVersion: boundedString(record.contentVersion, 160),
  };
}

function normalizeCatalog(value: unknown): ExternalHookCatalogSnapshot {
  const record = exactRecord(value, [
    'schemaVersion',
    'discoveryPending',
    'providers',
    'sources',
    'entries',
  ], ['staleProviderIds', 'failedProviderIds', 'diagnostics']);
  if (record.schemaVersion !== 1 || typeof record.discoveryPending !== 'boolean') {
    invalidResponse();
  }
  const providers = boundedArray(record.providers).map(provider);
  const providerIds = new Set<string>();
  if (providers.some((item) => {
    if (providerIds.has(item.providerId)) return true;
    providerIds.add(item.providerId);
    return false;
  })) invalidResponse();
  const sources = boundedArray(record.sources).map(source);
  const entries = boundedArray(record.entries).map(entry);
  const sourceKeys = new Set<string>();
  if (sources.some((item) => {
    const key = `${item.key.providerId}\u0000${item.key.sourceId}`;
    if (sourceKeys.has(key)) return true;
    sourceKeys.add(key);
    return false;
  })) invalidResponse();
  const entryKeys = new Set<string>();
  if (entries.some((item) => {
    if (entryKeys.has(item.stableKey)) return true;
    entryKeys.add(item.stableKey);
    return false;
  })) invalidResponse();
  const providerSourceCounts = new Map<string, number>();
  const providerEntryCounts = new Map<string, number>();
  for (const item of sources) {
    providerSourceCounts.set(
      item.key.providerId,
      (providerSourceCounts.get(item.key.providerId) ?? 0) + 1,
    );
  }
  for (const item of entries) {
    providerEntryCounts.set(
      item.source.providerId,
      (providerEntryCounts.get(item.source.providerId) ?? 0) + 1,
    );
  }
  if (sources.some((item) => {
    const identity = providers.find((candidate) => candidate.providerId === item.key.providerId);
    return !identity || identity.ecosystemId !== item.ecosystemId;
  }) || entries.some((item) => !sourceKeys.has(
    `${item.source.providerId}\u0000${item.source.sourceId}`,
  )) || [...providerSourceCounts.values(), ...providerEntryCounts.values()]
    .some((count) => count > MAX_PROVIDER_ITEMS)) {
    invalidResponse();
  }
  const staleProviderIds = record.staleProviderIds === undefined
    ? []
    : boundedArray(record.staleProviderIds).map((item) => boundedString(item, 160));
  const failedProviderIds = record.failedProviderIds === undefined
    ? []
    : boundedArray(record.failedProviderIds).map((item) => boundedString(item, 160));
  const staleSet = new Set(staleProviderIds);
  const failedSet = new Set(failedProviderIds);
  if (staleSet.size !== staleProviderIds.length
    || failedSet.size !== failedProviderIds.length
    || staleProviderIds.some((id) => !providerIds.has(id) || failedSet.has(id))
    || failedProviderIds.some((id) => !providerIds.has(id))) {
    invalidResponse();
  }
  const catalogDiagnostics = diagnostics(record.diagnostics);
  if (catalogDiagnostics.some((item) => item.source !== undefined && !sourceKeys.has(
    `${item.source.providerId}\u0000${item.source.sourceId}`,
  ))) {
    invalidResponse();
  }
  return {
    schemaVersion: 1,
    discoveryPending: record.discoveryPending,
    providers,
    sources,
    entries,
    staleProviderIds,
    failedProviderIds,
    diagnostics: catalogDiagnostics,
  };
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidResponse();
  return value as number;
}

function dependency(value: unknown): ExternalHookImportDependency {
  const tagged = exactRecord(value, ['kind'], ['relativePath', 'location']);
  if (tagged.kind === 'managed' && tagged.location === undefined) {
    return { kind: 'managed', relativePath: boundedString(tagged.relativePath, 4096) };
  }
  if (tagged.kind === 'external' && tagged.relativePath === undefined) {
    return { kind: 'external', location: boundedString(tagged.location, 4096) };
  }
  return invalidResponse();
}

function importHandler(value: unknown): ExternalHookImportHandler {
  const record = exactRecord(value, ['stableKey', 'event', 'command'], [
    'matcher',
    'commandWindows',
    'timeoutSeconds',
    'statusMessage',
    'dependencies',
  ]);
  const dependencies = record.dependencies === undefined
    ? []
    : boundedArray(record.dependencies).map(dependency);
  if (dependencies.length > 256) invalidResponse();
  const timeoutSeconds = record.timeoutSeconds === undefined
    ? undefined
    : positiveInteger(record.timeoutSeconds);
  return {
    stableKey: boundedString(record.stableKey, 160),
    event: boundedString(record.event, 160),
    command: boundedString(record.command, 65_536),
    ...(optionalString(record.matcher, 512) === undefined
      ? {} : { matcher: optionalString(record.matcher, 512) }),
    ...(optionalString(record.commandWindows, 65_536) === undefined
      ? {} : { commandWindows: optionalString(record.commandWindows, 65_536) }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(optionalString(record.statusMessage, 4096) === undefined
      ? {} : { statusMessage: optionalString(record.statusMessage, 4096) }),
    dependencies,
  };
}

function normalizeImportPlan(value: unknown): ExternalHookImportPlan {
  const record = exactRecord(value, [
    'schemaVersion',
    'source',
    'disposition',
    'behaviorVersion',
    'handlers',
    'skipped',
    'planFingerprint',
  ]);
  if (record.schemaVersion !== 1) invalidResponse();
  const handlers = boundedArray(record.handlers).map(importHandler);
  const skipped = boundedArray(record.skipped).map((item) => {
    const skippedItem = exactRecord(item, ['reasonCode', 'count']);
    return {
      reasonCode: boundedString(skippedItem.reasonCode, 160),
      count: positiveInteger(skippedItem.count),
    };
  });
  if (handlers.length > 2048 || skipped.length > 256) invalidResponse();
  return {
    schemaVersion: 1,
    source: source(record.source),
    disposition: enumString(record.disposition, [
      'import',
      'update',
      'unchanged',
      'unavailable',
    ] as const),
    behaviorVersion: boundedString(record.behaviorVersion, 160),
    handlers,
    skipped,
    planFingerprint: boundedString(record.planFingerprint, 160),
  };
}

function importedSource(value: unknown): ImportedHookSourceSnapshot {
  const record = exactRecord(value, [
    'importId',
    'source',
    'enabled',
    'behaviorVersion',
    'state',
  ]);
  if (typeof record.enabled !== 'boolean') invalidResponse();
  return {
    importId: boundedString(record.importId, 160),
    source: source(record.source),
    enabled: record.enabled,
    behaviorVersion: boundedString(record.behaviorVersion, 160),
    state: enumString(record.state, [
      'current',
      'update_available',
      'source_missing',
      'update_check_failed',
      'bundle_missing',
    ] as const),
  };
}

function normalizeImportSnapshot(value: unknown): ExternalHookImportSnapshot {
  const record = exactRecord(value, [
    'schemaVersion',
    'revision',
    'catalog',
    'imports',
  ], ['diagnostics']);
  if (record.schemaVersion !== 1) invalidResponse();
  const imports = boundedArray(record.imports).map(importedSource);
  if (imports.length > 4096) invalidResponse();
  return {
    schemaVersion: 1,
    revision: boundedString(record.revision, 160),
    catalog: normalizeCatalog(record.catalog),
    imports,
    diagnostics: diagnostics(record.diagnostics),
  };
}

function normalizeApplyResult(value: unknown): ExternalHookImportApplyResult {
  const record = exactRecord(value, ['schemaVersion', 'outcome']);
  if (record.schemaVersion !== 1) invalidResponse();
  const outcome = exactRecord(record.outcome, ['kind'], ['snapshot', 'refreshedPlan']);
  if ((outcome.kind === 'applied' || outcome.kind === 'unchanged')
    && outcome.refreshedPlan === undefined) {
    return {
      schemaVersion: 1,
      outcome: { kind: outcome.kind, snapshot: normalizeImportSnapshot(outcome.snapshot) },
    };
  }
  if (outcome.kind === 'stale' && outcome.snapshot === undefined) {
    return {
      schemaVersion: 1,
      outcome: { kind: 'stale', refreshedPlan: normalizeImportPlan(outcome.refreshedPlan) },
    };
  }
  return invalidResponse();
}

export const externalHooksAPI = {
  async getCatalog(workspaceId?: string, forceRefresh = false) {
    const response = await invokeExternalSourceCommand<unknown>('get_external_hook_catalog', {
      request: {
        workspaceId: normalizeOptionalWorkspaceId(workspaceId),
        forceRefresh,
      },
    });
    return normalizeCatalog(response);
  },
  async getImportSnapshot(workspaceId?: string, refreshUpdates = false) {
    const response = await invokeExternalSourceCommand<unknown>(
      'get_external_hook_import_snapshot',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          refreshUpdates,
        },
      },
    );
    return normalizeImportSnapshot(response);
  },
  async planImport(workspaceId: string | undefined, sourceKey: ExternalHookSourceKey) {
    const response = await invokeExternalSourceCommand<unknown>(
      'plan_external_hook_import_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          source: sourceKey,
        },
      },
    );
    return normalizeImportPlan(response);
  },
  async applyImport(workspaceId: string | undefined, plan: ExternalHookImportPlan) {
    const response = await invokeExternalSourceCommand<unknown>(
      'apply_external_hook_import_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          importRequest: {
            schemaVersion: 1,
            source: plan.source.key,
            planFingerprint: plan.planFingerprint,
          },
        },
      },
    );
    return normalizeApplyResult(response);
  },
  async mutateImport(
    workspaceId: string | undefined,
    expectedRevision: string,
    action: ExternalHookImportMutation,
  ) {
    const response = await invokeExternalSourceCommand<unknown>(
      'mutate_external_hook_import_command',
      {
        request: {
          workspaceId: normalizeOptionalWorkspaceId(workspaceId),
          mutation: { schemaVersion: 1, expectedRevision, action },
        },
      },
    );
    return normalizeImportSnapshot(response);
  },
};
