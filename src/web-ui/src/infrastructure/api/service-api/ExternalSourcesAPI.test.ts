import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalSourceApiError, externalSourcesAPI } from './ExternalSourcesAPI';
import { webSocketResponseError } from '../adapters/websocket-adapter';
import { PeerProductCommandError } from '../adapters/peer-device-adapter';
import { ApiClient } from './ApiClient';
import { globalEventBus } from '@/infrastructure/event-bus';
import { MCP_CONFIG_CHANGED } from '@/infrastructure/mcp/configEvents';

const invokeMock = vi.hoisted(() => vi.fn());
const adapterMocks = vi.hoisted(() => ({
  request: vi.fn(),
  listen: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
}));

function surface(catalog: Record<string, unknown>) {
  const generation = typeof catalog.generation === 'number' ? catalog.generation : 0;
  return {
    control: {
      schemaVersion: 1,
      executionDomainId: 'local-user',
      refreshGeneration: generation,
      preferenceRevision: typeof catalog.preferenceRevision === 'number'
        ? catalog.preferenceRevision
        : 0,
      safeMode: false,
      hostCapabilities: {
        canRefresh: true,
        canMutatePolicy: true,
        canManageSources: true,
        canApproveRuntime: true,
        canExecuteExternalAssets: true,
        canSetSafeMode: true,
        canRevealSourceLocation: true,
      },
      sources: [],
      capabilities: [],
      diagnostics: [],
      recoveryActions: [],
    },
    catalog,
  };
}

vi.mock('../adapters', async importOriginal => ({
  ...await importOriginal<typeof import('../adapters')>(),
  getTransportAdapter: () => adapterMocks,
}));

vi.mock('./ApiClient', async importOriginal => {
  const actual = await importOriginal<typeof import('./ApiClient')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      invoke: invokeMock,
    },
  };
});

describe('ExternalSourcesAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(surface({}));
    adapterMocks.isConnected.mockReturnValue(true);
  });

  const discovery = () => ({
    schemaVersion: 1, automaticDiscovery: true, canChangeAutomaticDiscovery: true,
    hasScanned: true, preferenceRevision: 9, discoverableCapabilities: { codex: ['mcp'] },
    catalog: { ...surface({}).catalog, generation: 2, discoveryPending: false, sources: [], commands: [],
      integrationPolicy: { status: 'compatible', effective: { enabled: false, ecosystems: {} }, registeredEcosystems: [] } },
  });

  it('negotiates independent catalog discovery while keeping runtime authorization off', async () => {
    invokeMock.mockResolvedValue(discovery());
    const result = await externalSourcesAPI.getDiscoverySnapshot(' /project ', true);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('get_external_source_discovery_snapshot', {
      request: { workspaceId: '/project', forceRefresh: true },
    });
    expect(result.discovery).toEqual({ enabled: true, canChange: true, hasScanned: true,
      preferenceRevision: 9, discoverableCapabilities: { codex: ['mcp'] } });
    expect(result.integrationPolicy.effective.enabled).toBe(false);
  });

  it('keeps old hosts viewable without exposing the new mutation', async () => {
    invokeMock.mockRejectedValueOnce(new ExternalSourceApiError('incompatible_version', 'Unknown command', false))
      .mockResolvedValueOnce(surface({ generation: 1 }));
    const result = await externalSourcesAPI.getDiscoverySnapshot('/project');
    expect(result.discovery).toBeUndefined();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'get_external_source_discovery_snapshot', 'get_external_source_control_snapshot',
    ]);
  });

  it.each([null, { ...discovery(), automaticDiscovery: 'true' }, { ...discovery(), discoverableCapabilities: [] }])(
    'reports malformed discovery responses without masking them with a legacy read', async (value) => {
      invokeMock.mockResolvedValue(value);
      await expect(externalSourcesAPI.getDiscoverySnapshot('/project')).rejects.toMatchObject({ code: 'invalid_response' });
      expect(invokeMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([[' /project ', 'workspace', '/project'], [undefined, 'user', undefined]])(
    'updates only discovery with normalized scope %s', async (workspace, scope, path) => {
      invokeMock.mockResolvedValueOnce({}).mockResolvedValueOnce(discovery());
      const runtimeChanged = vi.fn();
      const unsubscribe = globalEventBus.on('mode:config:updated', runtimeChanged);
      try {
        await externalSourcesAPI.setAutomaticDiscovery(workspace, false, 8);
        expect(runtimeChanged).not.toHaveBeenCalled();
      } finally { unsubscribe(); }
      expect(invokeMock).toHaveBeenNthCalledWith(1, 'update_external_integration_policy_command', {
        request: { workspaceId: path, mutation: { expectedPreferenceRevision: 8, scope,
          change: { operation: 'set_automatic_discovery', enabled: false } } },
      });
    },
  );

  it('reads and acknowledges backend-owned ecosystem awareness', async () => {
    invokeMock
      .mockResolvedValueOnce({ unacknowledgedEcosystemIds: ['opencode', 'codex'] })
      .mockResolvedValueOnce(undefined);

    await expect(externalSourcesAPI.getEcosystemAwareness('workspace-1'))
      .resolves.toEqual(['opencode', 'codex']);
    await externalSourcesAPI.acknowledgeEcosystems(
      'workspace-1',
      ['opencode', 'codex'],
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_external_ecosystem_awareness_command', {
      request: { workspaceId: 'workspace-1' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'acknowledge_external_ecosystems_command', {
      request: {
        workspaceId: 'workspace-1',
        ecosystemIds: ['opencode', 'codex'],
      },
    });
  });

  it('keeps workspace ownership and refresh intent in the public snapshot request', async () => {
    await externalSourcesAPI.getSnapshot('workspace-1', true);

    expect(invokeMock).toHaveBeenCalledWith('get_external_source_control_snapshot', {
      request: {
        workspaceId: 'workspace-1',
        forceRefresh: true,
      },
    });
  });

  it('keeps the execution root and workspace metadata identity in reference discovery', async () => {
    invokeMock.mockResolvedValueOnce({
      generation: 3,
      discoveryPending: false,
      references: [],
    });

    await externalSourcesAPI.getWorkspaceReferences(
      'workspace-1',
      true,
    );

    expect(invokeMock).toHaveBeenCalledWith('get_workspace_reference_snapshot', {
      request: {
        workspaceId: 'workspace-1',
        forceRefresh: true,
      },
    });
  });

  it('rejects an unresolved workspace instead of selecting global scope', async () => {
    await expect(externalSourcesAPI.getSnapshot('', false)).rejects.toThrow('Workspace identity is unresolved');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('sends only typed selection intent when applying an MCP import plan', async () => {
    invokeMock.mockResolvedValueOnce({ schemaVersion: 1, outcome: { status: 'applied', imported: [] } });
    const plan = {
      schemaVersion: 1 as const,
      planFingerprint: 'sha256:plan-v1',
      items: [],
    };
    await externalSourcesAPI.applyMcpImport('workspace-1', plan, [{
      candidateId: 'opencode:mcp:docs',
    }]);

    expect(invokeMock).toHaveBeenCalledWith('apply_external_mcp_import_command', {
      request: {
        workspaceId: 'workspace-1',
        importRequest: {
          schemaVersion: 1,
          planFingerprint: 'sha256:plan-v1',
          selections: [{ candidateId: 'opencode:mcp:docs' }],
        },
      },
    });
  });

  it('invalidates native MCP lists on applied import, but not on a stale plan', async () => {
    const changed = vi.fn();
    const unsubscribe = globalEventBus.on(MCP_CONFIG_CHANGED, changed);
    const plan = { schemaVersion: 1 as const, planFingerprint: 'plan', items: [] };
    try {
      invokeMock.mockResolvedValueOnce({ schemaVersion: 1, outcome: { status: 'stale', refreshedPlan: plan } });
      await externalSourcesAPI.applyMcpImport(undefined, plan, []);
      expect(changed).not.toHaveBeenCalled();
      invokeMock.mockResolvedValueOnce({ schemaVersion: 1, outcome: { status: 'applied', imported: [] } });
      await externalSourcesAPI.applyMcpImport(undefined, plan, []);
      expect(changed).toHaveBeenCalledWith({ surfaceId: 'local' });
    } finally { unsubscribe(); }
  });

  it('reveals a source by stable identity without sending its display location', async () => {
    await externalSourcesAPI.revealSourceLocation(
      'workspace-1',
      'opencode.commands:project',
    );

    expect(invokeMock).toHaveBeenCalledWith('reveal_external_source_location', {
      request: {
        workspaceId: 'workspace-1',
        sourceKey: 'opencode.commands:project',
      },
    });
  });

  it('expands a prompt command only with the selected candidate and behavior version', async () => {
    invokeMock.mockResolvedValueOnce({
      state: 'ready',
      content: 'expanded prompt',
      executionTarget: {
        kind: 'fresh_external_subagent',
        ecosystemId: 'opencode',
        logicalId: 'reviewer',
      },
    });

    const outcome = await externalSourcesAPI.expandPromptCommand(
      'workspace-1',
      'review',
      'focus on auth',
      'claude-code.commands:project:review',
      'behavior-v1',
      [{
        commandName: 'review',
        candidateId: 'openbitfun.desktop:action:review',
        behaviorVersion: 'action:review:v1',
      }],
      {
        conflictKey: 'native:prompt_command:local-user:review:v1',
        expectedPreferenceRevision: 7,
      },
      {
        planFingerprint: 'sha256:shell-plan',
        mode: 'run_once',
        expectedPreferenceRevision: 7,
      },
    );

    expect(outcome).toMatchObject({
      state: 'ready',
      executionTarget: {
        kind: 'fresh_external_subagent',
        ecosystemId: 'opencode',
        logicalId: 'reviewer',
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('expand_external_prompt_command_command', {
      request: {
        workspaceId: 'workspace-1',
        name: 'review',
        arguments: 'focus on auth',
        nativeCommands: [{
          commandName: 'review',
          candidateId: 'openbitfun.desktop:action:review',
          behaviorVersion: 'action:review:v1',
        }],
        candidateId: 'claude-code.commands:project:review',
        expectedContentVersion: 'behavior-v1',
        expectedNativeConflictKey: 'native:prompt_command:local-user:review:v1',
        expectedPreferenceRevision: 7,
        shellReviewDecision: {
          planFingerprint: 'sha256:shell-plan',
          mode: 'run_once',
          expectedPreferenceRevision: 7,
        },
      },
    });
  });

  it.each([
    ['a missing execution target', { state: 'ready', content: 'expanded prompt' }],
    ['an unknown execution target', {
      state: 'ready',
      content: 'expanded prompt',
      executionTarget: { kind: 'future_target' },
    }],
  ])('rejects prompt command expansion with %s', async (_label, response) => {
    invokeMock.mockResolvedValueOnce(response);

    await expect(externalSourcesAPI.expandPromptCommand(
      'workspace-1',
      'review',
      '',
      'opencode.commands:project:review',
      'behavior-v1',
      [],
    )).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it('projects native prompt command conflicts through the shared control plane', async () => {
    invokeMock.mockResolvedValueOnce({ preferenceRevision: 3, conflicts: [] });
    const nativeCommands = [{
      commandName: 'review',
      candidateId: 'openbitfun.desktop:action:review',
      behaviorVersion: 'action:review:v1',
    }];

    await externalSourcesAPI.getNativePromptCommandConflicts(
      'workspace-1',
      nativeCommands,
    );

    expect(invokeMock).toHaveBeenCalledWith('get_native_prompt_command_conflicts_command', {
      request: {
        workspaceId: 'workspace-1',
        nativeCommands,
      },
    });
  });

  it('persists a native prompt command choice with optimistic concurrency', async () => {
    invokeMock.mockResolvedValueOnce({ preferenceRevision: 4, conflicts: [] });
    const nativeCommands = [{
      commandName: 'review',
      candidateId: 'openbitfun.desktop:action:review',
      behaviorVersion: 'action:review:v1',
    }];

    await externalSourcesAPI.setNativePromptCommandConflictChoice(
      'workspace-1',
      nativeCommands,
      'openbitfun.desktop:action:review',
      3,
    );

    expect(invokeMock).toHaveBeenCalledWith(
      'set_native_prompt_command_conflict_choice_command',
      {
        request: {
          workspaceId: 'workspace-1',
          nativeCommands,
          selectedCandidateId: 'openbitfun.desktop:action:review',
          expectedPreferenceRevision: 3,
        },
      },
    );
  });

  it('falls back to the legacy read path for an older Peer Host', async () => {
    invokeMock
      .mockRejectedValueOnce(
        "command 'get_external_source_control_snapshot' is not supported on CLI peer host",
      )
      .mockResolvedValueOnce({
        generation: 3,
        discoveryPending: false,
        preferenceRevision: 2,
        hostCapabilities: {
          canRefresh: true,
          canMutatePolicy: true,
          canManageSources: true,
          canApproveRuntime: true,
          canExecuteExternalAssets: true,
          canSetSafeMode: false,
        },
        sources: [],
        commands: [],
      });

    const result = await externalSourcesAPI.getSnapshot('workspace-1');

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_external_source_snapshot', {
      request: {
        workspaceId: 'workspace-1',
        forceRefresh: false,
      },
    });
    expect(result.control).toMatchObject({
      executionDomainId: 'legacy-host',
      safeMode: false,
      hostCapabilities: {
        canManageSources: true,
        canSetSafeMode: false,
        canRevealSourceLocation: false,
      },
      recoveryActions: [{ type: 'reconnect_host' }],
    });
  });

  it('accepts a complete older Host surface when both capability copies omit additive fields', async () => {
    const legacyCapabilities = {
      canRefresh: true,
      canMutatePolicy: true,
      canManageSources: true,
      canApproveRuntime: true,
      canExecuteExternalAssets: true,
      canSetSafeMode: true,
    };
    invokeMock.mockResolvedValue({
      control: {
        ...surface({}).control,
        hostCapabilities: legacyCapabilities,
      },
      catalog: {
        generation: 0,
        discoveryPending: false,
        preferenceRevision: 0,
        hostCapabilities: legacyCapabilities,
        sources: [],
        commands: [],
      },
    });

    const result = await externalSourcesAPI.getSnapshot();

    expect(result.hostCapabilities.canRevealSourceLocation).toBe(false);
    expect(result.control?.hostCapabilities.canRevealSourceLocation).toBe(false);
  });

  it('preserves a legacy Server Host read-only boundary through ApiClient wrapping', async () => {
    const client = new ApiClient({ enableLogging: false, retries: 0 });
    adapterMocks.request.mockRejectedValueOnce(webSocketResponseError({
      code: -32004,
      message: 'Unknown Server Host operation',
      data: {
        code: 'host_capability_unavailable',
        detail: 'Unknown Server Host operation',
        retryable: false,
        stage: 'execute_remote',
        correlationId: 'server-legacy-1',
        recoveryActions: [{ type: 'reconnect_host' }],
      },
    }));
    invokeMock
      .mockImplementationOnce((command, args) => client.invoke(command, args))
      .mockResolvedValueOnce({
        generation: 3,
        discoveryPending: false,
        preferenceRevision: 2,
        hostCapabilities: {
          canRefresh: false,
          canMutatePolicy: false,
          canManageSources: false,
          canApproveRuntime: false,
          canExecuteExternalAssets: false,
          canSetSafeMode: false,
        },
        sources: [],
        commands: [],
      });

    const result = await externalSourcesAPI.getSnapshot('workspace-1');

    expect(result.control.hostCapabilities).toEqual({
      canRefresh: false,
      canMutatePolicy: false,
      canManageSources: false,
      canApproveRuntime: false,
      canExecuteExternalAssets: false,
      canSetSafeMode: false,
      canRevealSourceLocation: false,
    });
    expect(result.hostCapabilities).toEqual(result.control.hostCapabilities);
  });

  it('uses the legacy source mutation when an older Peer Host lacks control actions', async () => {
    invokeMock
      .mockRejectedValueOnce(
        "command 'apply_external_source_control_action_command' is not supported on CLI peer host",
      )
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        "command 'get_external_source_control_snapshot' is not supported on CLI peer host",
      )
      .mockResolvedValueOnce({
        generation: 4,
        discoveryPending: false,
        preferenceRevision: 3,
        sources: [],
        commands: [],
      });

    await externalSourcesAPI.setSourceEnabled(
      'workspace-1',
      'opencode.commands:project',
      false,
      2,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'set_external_source_enabled_command', {
      request: {
        workspaceId: 'workspace-1',
        sourceKey: 'opencode.commands:project',
        enabled: false,
        expectedPreferenceRevision: 2,
      },
    });
  });

  it('sends exact owner-scoped decision sets for bulk resource changes', async () => {
    const toolDecisions = [{ approvalKey: 'tool-approval-v1', decisionKey: 'tool-v1' }];
    const subagentDecisions = [{ candidateId: 'agent-review', decisionKey: 'agent-v1' }];
    const mcpDecisions = [{ candidateId: 'mcp-docs', decisionKey: 'mcp-v1' }];

    await externalSourcesAPI.setToolTargetsEnabled(
      'workspace-1', toolDecisions, true, 11, 7,
    );
    await externalSourcesAPI.setSubagentsEnabled(
      'workspace-1', subagentDecisions, false, 12, 8,
    );
    await externalSourcesAPI.setMcpServersEnabled(
      'workspace-1', mcpDecisions, true, 13, 9,
    );

    expect(invokeMock).toHaveBeenCalledWith('set_external_tool_targets_enabled_command', {
      request: {
        workspaceId: 'workspace-1',
        decisions: toolDecisions,
        enabled: true,
        expectedCatalogGeneration: 11,
        expectedPreferenceRevision: 7,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('set_external_subagents_enabled_command', {
      request: {
        workspaceId: 'workspace-1',
        decisions: subagentDecisions,
        enabled: false,
        expectedSubagentGeneration: 12,
        expectedPreferenceRevision: 8,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('set_external_mcp_servers_enabled_command', {
      request: {
        workspaceId: 'workspace-1',
        decisions: mcpDecisions,
        enabled: true,
        expectedMcpGeneration: 13,
        expectedPreferenceRevision: 9,
      },
    });
  });

  it('sends policy scope and optimistic revision as one atomic mutation', async () => {
    const catalogUpdated = vi.fn();
    const unsubscribe = globalEventBus.on('mode:config:updated', catalogUpdated);

    await externalSourcesAPI.updateIntegrationPolicy('workspace-1', {
      expectedPreferenceRevision: 8,
      scope: 'workspace',
      change: {
        operation: 'set_capability_access',
        ecosystemId: 'opencode',
        capabilityId: 'mcp',
        access: 'ask_before_use',
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('update_external_integration_policy_command', {
      request: {
        workspaceId: 'workspace-1',
        mutation: {
          expectedPreferenceRevision: 8,
          scope: 'workspace',
          change: {
            operation: 'set_capability_access',
            ecosystemId: 'opencode',
            capabilityId: 'mcp',
            access: 'ask_before_use',
          },
        },
      },
    });
    expect(catalogUpdated).toHaveBeenCalledWith({
      reason: 'external-agent-catalog-updated',
      workspaceId: 'workspace-1',
    });
    unsubscribe();
  });

  it('normalizes typed host errors without matching user-visible strings', async () => {
    invokeMock.mockRejectedValue({
      details: {
        originalError: JSON.stringify({
          code: 'host_capability_unavailable',
          detail: 'This host is read-only',
          retryable: false,
        }),
      },
    });

    const request = externalSourcesAPI.getSnapshot();
    await expect(request).rejects.toBeInstanceOf(ExternalSourceApiError);
    await expect(request).rejects.toMatchObject({
      code: 'host_capability_unavailable',
      detail: 'This host is read-only',
      retryable: false,
    });
  });

  it('fails closed when a legacy host omits capabilities and policy', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 1,
      discoveryPending: false,
      sources: [],
      commands: [],
    }));

    const result = await externalSourcesAPI.getSnapshot();

    expect(result.hostCapabilities).toEqual({
      canRefresh: false,
      canMutatePolicy: false,
      canManageSources: false,
      canApproveRuntime: false,
      canExecuteExternalAssets: false,
      canSetSafeMode: false,
      canRevealSourceLocation: false,
    });
    expect(result.integrationPolicy).toMatchObject({
      status: 'unknown',
      schemaMajor: 0,
      userDefaults: { enabled: false },
      globalEffective: { enabled: false, ecosystems: {} },
      effective: { enabled: false, ecosystems: {} },
    });
  });

  it('keeps an incompatible schema identifiable while projecting it safely off', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 1,
      discoveryPending: false,
      sources: [],
      commands: [],
      integrationPolicy: {
        schemaMajor: 13,
        status: 'incompatible_schema',
        futurePolicyField: { doNotExpose: true },
      },
    }));

    const result = await externalSourcesAPI.getSnapshot();

    expect(result.integrationPolicy).toEqual(expect.objectContaining({
      status: 'incompatible_schema',
      schemaMajor: 13,
      effective: { enabled: false, ecosystems: {} },
    }));
    expect(result.integrationPolicy).not.toHaveProperty('futurePolicyField');
  });

  it('normalizes partial snapshots returned from mutations too', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 2,
      discoveryPending: false,
      sources: [],
      commands: [],
    }));

    const result = await externalSourcesAPI.setSourceEnabled(
      'workspace-1',
      'opencode:project',
      false,
      4,
    );

    expect(result.hostCapabilities.canManageSources).toBe(false);
    expect(result.integrationPolicy.status).toBe('unknown');
    expect(result.integrationPolicy.effective.enabled).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith(
      'apply_external_source_control_action_command',
      {
        request: {
          workspaceId: 'workspace-1',
          control: {
            schemaVersion: 1,
            operationId: expect.any(String),
            expectedPreferenceRevision: 4,
            action: {
              type: 'set_source_enabled',
              sourceKey: 'opencode:project',
              enabled: false,
            },
          },
        },
      },
    );
  });

  it('normalizes legacy subagent role and model-binding fields at the API boundary', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 2,
      discoveryPending: false,
      sources: [],
      commands: [],
      subagents: [{
        candidateId: 'opencode-review',
        logicalId: 'review',
        displayName: 'Review',
        description: 'Review changes',
        providerLabel: 'OpenCode',
        scope: 'project',
        sourceKeys: [],
        sourceLocationLabels: [],
        sourceCount: 1,
        effectiveToolLabels: [],
        unavailableToolLabels: [],
        supportsFollowUp: false,
        compatibilityState: 'ready',
        diagnostics: [],
        activationState: { state: 'approval_required' },
        decisionKey: 'decision-v1',
      }],
    }));

    const result = await externalSourcesAPI.getSnapshot();

    expect(result.subagentModelBindingGroups).toEqual([]);
    expect(result.subagentModelBindingOptions).toEqual([]);
    expect(result.subagents?.[0]).toMatchObject({
      mode: 'subagent',
      requestedModel: { kind: 'default' },
      modelBindingMethod: 'default',
    });
  });

  it('sends typed subagent model bindings and clears them through the same command', async () => {
    await externalSourcesAPI.setSubagentModelBinding(
      'workspace-1',
      'external_subagent_model_binding:review',
      { kind: 'model', modelId: 'anthropic/claude-sonnet-4' },
      5,
      8,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'set_external_subagent_model_binding_command',
      {
        request: {
          workspaceId: 'workspace-1',
          bindingKey: 'external_subagent_model_binding:review',
          target: { kind: 'model', modelId: 'anthropic/claude-sonnet-4' },
          expectedSubagentGeneration: 5,
          expectedPreferenceRevision: 8,
        },
      },
    );

    invokeMock.mockClear();
    await externalSourcesAPI.setSubagentModelBinding(
      'workspace-1',
      'external_subagent_model_binding:review',
      undefined,
      6,
      9,
    );

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      'set_external_subagent_model_binding_command',
      {
        request: {
          workspaceId: 'workspace-1',
          bindingKey: 'external_subagent_model_binding:review',
          target: undefined,
          expectedSubagentGeneration: 6,
          expectedPreferenceRevision: 9,
        },
      },
    );
  });

  it('restores omitted empty MCP collections at the API boundary', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 3,
      discoveryPending: false,
      sources: [{
        stableKey: 'opencode-user',
        lifecycle: 'available',
        record: {
          key: { providerId: 'opencode.mcp', sourceId: 'user' },
          ecosystemId: 'opencode',
          displayName: 'OpenCode user configuration',
          sourceKind: 'opencode_mcp_config',
          scope: 'user_global',
          location: '~/.config/opencode/opencode.json',
          executionDomainId: 'local-user',
          health: 'available',
          contentVersion: '1',
        },
      }],
      commands: [],
      mcpServers: [{
        candidateId: 'opencode-user-docs',
        approvalKey: 'approval',
        decisionKey: 'decision',
        activationState: { state: 'approval_required' },
        definition: {
          id: {
            source: { providerId: 'opencode.mcp', sourceId: 'user' },
            localId: 'docs',
          },
          name: 'docs',
          transport: 'streamable_http',
          argumentCount: 0,
          timeouts: {
            startupMs: 9007199254740992,
            catalogMs: 'invalid',
            executionMs: 3000,
            futurePhaseMs: 4000,
          },
          sourceEnabled: true,
          behaviorVersion: '1',
          staticStatus: { state: 'ready' },
        },
      }],
    }));

    const result = await externalSourcesAPI.getSnapshot();

    expect(result.sources[0].record.diagnostics).toEqual([]);
    expect(result.mcpServers?.[0].definition).toMatchObject({
      provenance: [],
      environmentKeys: [],
      environmentReferenceNames: [],
      headerNames: [],
      timeouts: { executionMs: 3000 },
    });
    expect(result.mcpServers?.[0].definition.timeouts).toEqual({ executionMs: 3000 });
    expect(result.mcpApprovalRequests).toEqual([]);
    expect(result.toolConflicts).toEqual([]);
    expect(result.pendingSubagentApprovals).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects non-array collection fields instead of presenting them as empty', async () => {
    invokeMock.mockResolvedValue(surface({
      generation: 4,
      discoveryPending: false,
      sources: [],
      commands: [],
      mcpServers: 'not-an-array',
    }));

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'internal',
      retryable: true,
    });

    invokeMock.mockResolvedValue(surface({
      generation: 5,
      discoveryPending: false,
      sources: [],
      commands: [],
      mcpServers: [{
        candidateId: 'invalid-collections',
        approvalKey: 'approval',
        decisionKey: 'decision',
        activationState: { state: 'approval_required' },
        definition: {
          id: {
            source: { providerId: 'opencode.mcp', sourceId: 'user' },
            localId: 'docs',
          },
          name: 'docs',
          transport: 'streamable_http',
          argumentCount: 0,
          environmentKeys: { unexpected: true },
          sourceEnabled: true,
          behaviorVersion: '1',
          staticStatus: { state: 'ready' },
        },
      }],
    }));

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'internal',
      retryable: true,
    });
  });

  it('preserves structured error facts for consistent recovery UX', async () => {
    invokeMock.mockRejectedValue(JSON.stringify({
      code: 'runtime_unavailable',
      detail: 'Node.js is not available',
      retryable: false,
      correlationId: 'correlation-1',
      causationId: 'refresh-8',
      stage: 'activate_runtime',
      recoveryActions: [{ type: 'install_runtime' }, { type: 'refresh' }],
    }));

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'runtime_unavailable',
      correlationId: 'correlation-1',
      causationId: 'refresh-8',
      stage: 'activate_runtime',
      recoveryActions: [{ type: 'install_runtime' }, { type: 'refresh' }],
    });
  });

  it('fails closed when the shared control projection contains malformed recovery actions', async () => {
    const malformed = surface({
      generation: 8,
      discoveryPending: false,
      sources: [],
      commands: [],
    });
    malformed.control.recoveryActions = [{ type: 'run_arbitrary_command' }];
    invokeMock.mockResolvedValue(malformed);

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });
  });

  it('fails closed when v1 host capability facts are malformed or inconsistent', async () => {
    const malformed = surface({
      generation: 9,
      discoveryPending: false,
      sources: [],
      commands: [],
    });
    malformed.control.hostCapabilities.canSetSafeMode = 'yes' as unknown as boolean;
    invokeMock.mockResolvedValue(malformed);

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });

    const inconsistent = surface({
      generation: 10,
      discoveryPending: false,
      sources: [],
      commands: [],
      hostCapabilities: {
        canRefresh: true,
        canMutatePolicy: true,
        canManageSources: true,
        canApproveRuntime: true,
        canExecuteExternalAssets: true,
        canSetSafeMode: false,
      },
    });
    invokeMock.mockResolvedValue(inconsistent);

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    });

    const stalePreferences = surface({
      generation: 11,
      preferenceRevision: 3,
      discoveryPending: false,
      sources: [],
      commands: [],
    });
    stalePreferences.control.preferenceRevision = 2;
    invokeMock.mockResolvedValue(stalePreferences);

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: true,
    });
  });

  it('preserves Peer Host typed recovery through ApiClient wrapping', async () => {
    const client = new ApiClient({ enableLogging: false, retries: 0 });
    adapterMocks.request.mockRejectedValueOnce(new PeerProductCommandError(JSON.stringify({
      code: 'stale_revision',
      detail: 'Refresh and try again',
      retryable: true,
      stage: 'apply_preference',
      causationId: 'peer-preference-8',
      recoveryActions: [{ type: 'refresh' }],
    })));
    invokeMock.mockImplementationOnce((command, args) => client.invoke(command, args));

    await expect(externalSourcesAPI.setSafeMode(
      'workspace-1',
      true,
      8,
    )).rejects.toMatchObject({
      code: 'stale_revision',
      stage: 'apply_preference',
      causationId: 'peer-preference-8',
      recoveryActions: [{ type: 'refresh' }],
    });
  });

  it('bounds untrusted legacy error references before they reach a product surface', async () => {
    invokeMock.mockRejectedValue(JSON.stringify({
      code: 'stale_revision',
      detail: `retry\n${'x'.repeat(5000)}`,
      retryable: true,
      correlationId: 'forged\nreference',
      recoveryActions: [{ type: 'refresh' }],
    }));

    await expect(externalSourcesAPI.getSnapshot()).rejects.toMatchObject({
      code: 'stale_revision',
      correlationId: undefined,
      recoveryActions: [{ type: 'refresh' }],
    });
    await externalSourcesAPI.getSnapshot().catch((error: ExternalSourceApiError) => {
      expect(Array.from(error.message)).toHaveLength(4096);
      expect(error.message).not.toContain('\n');
    });
  });
});
