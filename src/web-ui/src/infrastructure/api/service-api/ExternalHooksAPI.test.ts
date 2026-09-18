import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: { invoke: invokeMock },
}));

import { ExternalSourceApiError } from './ExternalSourcesAPI';
import { externalHooksAPI } from './ExternalHooksAPI';

const validSnapshot = {
  schemaVersion: 1,
  discoveryPending: false,
  providers: [{
    providerId: 'claude-code.hooks',
    ecosystemId: 'claude-code',
    displayName: 'Claude Code Hooks',
  }],
  sources: [{
    key: { providerId: 'claude-code.hooks', sourceId: 'project-settings' },
    ecosystemId: 'claude-code',
    displayName: 'Claude Code project Hooks',
    sourceKind: 'settings',
    scope: 'project',
    locationHint: '.claude/settings.json',
    health: 'available',
    contentVersion: 'v1',
    diagnostics: [],
  }],
  entries: [{
    stableKey: 'claude-code-project-pre-tool-use-0',
    source: { providerId: 'claude-code.hooks', sourceId: 'project-settings' },
    nativeEvent: 'PreToolUse',
    matcher: { kind: 'pattern', display: 'Bash|Read' },
    handlerKind: 'command',
    projectionStatus: 'mapped',
    nativeActivation: 'unknown',
    mapping: { hookPoint: 'tool_before' },
    contentVersion: 'v1',
  }],
  staleProviderIds: [],
  failedProviderIds: [],
  diagnostics: [],
};

const validImportPlan = {
  schemaVersion: 1,
  source: validSnapshot.sources[0],
  disposition: 'import',
  behaviorVersion: 'sha256:behavior',
  handlers: [{
    stableKey: 'pre-tool-use-0',
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'python D:/managed/hooks/check.py',
    commandWindows: 'py D:/managed/hooks/check.py',
    timeoutSeconds: 30,
    dependencies: [{ kind: 'managed', relativePath: 'hooks/check.py' }],
  }],
  skipped: [{ reasonCode: 'unsupported_event', count: 1 }],
  planFingerprint: 'sha256:plan',
};

const validImportSnapshot = {
  schemaVersion: 1,
  revision: 'sha256:revision',
  catalog: validSnapshot,
  imports: [{
    importId: 'sha256:source',
    source: validSnapshot.sources[0],
    enabled: true,
    behaviorVersion: 'sha256:behavior',
    state: 'current',
  }],
  diagnostics: [],
};

describe('ExternalHooksAPI', () => {
  beforeEach(() => invokeMock.mockReset());

  it('uses the structured Hook request and returns the runtime-free catalog', async () => {
    invokeMock.mockResolvedValue(validSnapshot);

    await expect(externalHooksAPI.getCatalog(' workspace-1 ', true))
      .resolves.toEqual(validSnapshot);
    expect(invokeMock).toHaveBeenCalledWith('get_external_hook_catalog', {
      request: { workspaceId: 'workspace-1', forceRefresh: true },
    });
  });

  it('fails closed when a Host injects executable handler data into the catalog', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      entries: [{ ...validSnapshot.entries[0], command: 'curl secret.example' }],
    });

    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('fails closed for unknown v1 enum values and invented Hook mappings', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      entries: [{
        ...validSnapshot.entries[0],
        projectionStatus: 'mapped_elsewhere',
        mapping: { hookPoint: 'session_start' },
      }],
    });

    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });

    invokeMock.mockResolvedValue({
      ...validSnapshot,
      entries: [{
        ...validSnapshot.entries[0],
        mapping: { hookPoint: 'session_start' },
      }],
    });

    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('fails closed when source/provider identity facts disagree', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      providers: [{ ...validSnapshot.providers[0], ecosystemId: 'codex' }],
    });

    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('fails closed when provider status references an unknown or conflicting provider', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      failedProviderIds: ['unknown.hooks'],
    });
    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });

    invokeMock.mockResolvedValue({
      ...validSnapshot,
      staleProviderIds: ['claude-code.hooks'],
      failedProviderIds: ['claude-code.hooks'],
    });
    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('fails closed for duplicate identities and diagnostics with the wrong source', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      sources: [validSnapshot.sources[0], validSnapshot.sources[0]],
    });
    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });

    invokeMock.mockResolvedValue({
      ...validSnapshot,
      entries: [validSnapshot.entries[0], validSnapshot.entries[0]],
    });
    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });

    invokeMock.mockResolvedValue({
      ...validSnapshot,
      sources: [{
        ...validSnapshot.sources[0],
        diagnostics: [{
          severity: 'warning',
          assetKind: 'hook',
          code: 'claude.hook.invalid',
          message: 'invalid source identity',
          source: { providerId: 'claude-code.hooks', sourceId: 'another-source' },
        }],
      }],
    });
    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('fails closed when source diagnostics exceed the Rust contract limit', async () => {
    invokeMock.mockResolvedValue({
      ...validSnapshot,
      sources: [{
        ...validSnapshot.sources[0],
        diagnostics: Array.from({ length: 257 }, (_, index) => ({
          severity: 'warning',
          assetKind: 'hook',
          code: `claude.hook.issue_${index}`,
          message: `issue ${index}`,
          source: validSnapshot.sources[0].key,
        })),
      }],
    });

    await expect(externalHooksAPI.getCatalog()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });

  it('uses one shared plan for preview and explicit apply', async () => {
    invokeMock.mockResolvedValueOnce(validImportPlan).mockResolvedValueOnce({
      schemaVersion: 1,
      outcome: { kind: 'applied', snapshot: validImportSnapshot },
    });

    const plan = await externalHooksAPI.planImport(
      ' workspace-1 ',
      validSnapshot.sources[0].key,
    );
    await expect(externalHooksAPI.applyImport('workspace-1', plan)).resolves.toMatchObject({
      outcome: { kind: 'applied' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'plan_external_hook_import_command', {
      request: {
        workspaceId: 'workspace-1',
        source: validSnapshot.sources[0].key,
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'apply_external_hook_import_command', {
      request: {
        workspaceId: 'workspace-1',
        importRequest: {
          schemaVersion: 1,
          source: validSnapshot.sources[0].key,
          planFingerprint: 'sha256:plan',
        },
      },
    });
  });

  it('normalizes import snapshots and fails closed on unreviewed executable fields', async () => {
    invokeMock.mockResolvedValueOnce(validImportSnapshot);
    await expect(externalHooksAPI.getImportSnapshot(undefined, true))
      .resolves.toEqual(validImportSnapshot);

    invokeMock.mockResolvedValueOnce({
      ...validImportSnapshot,
      imports: [{ ...validImportSnapshot.imports[0], command: 'not-reviewed' }],
    });
    await expect(externalHooksAPI.getImportSnapshot()).rejects.toMatchObject<ExternalSourceApiError>({
      code: 'invalid_response',
    });
  });
});
