import type {
  LoopxActionKind,
  LoopxActionRequest,
  LoopxAttachRequest,
  LoopxCreateTaskRequest,
  LoopxEventsSinceRequest,
  LoopxIssueKey,
  LoopxItemKind,
  LoopxPermissionScope,
  LoopxResolveIntakeRequest,
  LoopxTurnOutputSinceRequest,
} from '@/infrastructure/api/service-api/LoopxAPI';

export const LOOPX_BUILTIN_APP_ID = 'builtin-bitfun-loopx';

type LoopxBridgeCall =
  | { kind: 'attach'; request: LoopxAttachRequest }
  | { kind: 'listModels' }
  | { kind: 'resolveIntake'; request: LoopxResolveIntakeRequest }
  | { kind: 'createTask'; request: LoopxCreateTaskRequest }
  | { kind: 'action'; request: LoopxActionRequest }
  | { kind: 'eventsSince'; request: LoopxEventsSinceRequest }
  | { kind: 'turnOutputSince'; request: LoopxTurnOutputSinceRequest };

const LOOPX_METHODS = new Set([
  'loopx.attach',
  'loopx.listModels',
  'loopx.resolveIntake',
  'loopx.createTask',
  'loopx.action',
  'loopx.eventsSince',
  'loopx.turnOutputSince',
]);

const HOST_CONTROLLED_KEYS = new Set([
  'argv',
  'argvprefix',
  'binary',
  'cliargs',
  'command',
  'cwd',
  'executable',
  'executiondomain',
  'peerdeviceid',
  'projectdir',
  'workspacepath',
  'worktreepath',
]);

const ITEM_KINDS = new Set<LoopxItemKind>(['issue', 'pr']);
const PERMISSION_SCOPES = new Set<LoopxPermissionScope>([
  'workspace_read',
  'workspace_write',
  'git_local',
  'github_read',
  'agent_execution',
  'publish',
  'public_comment',
  'pull_request',
  'merge',
  'production_action',
]);
const ACTION_KINDS = new Set<LoopxActionKind>([
  'pause',
'abort',
  'resume',
  'resume_repository',
  'reset_all',
  'approve',
  'reject',
  'archive',
  'restore',
  'install_loopx',
  'retry_environment',
]);

function normalizedKey(key: string): string {
  return key.replace(/_/g, '').toLowerCase();
}

function assertNoHostControlledFields(value: unknown, path = 'params'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoHostControlledFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (HOST_CONTROLLED_KEYS.has(normalizedKey(key))) {
      throw new Error(
        `LoopX MiniApps cannot provide host-controlled field '${path}.${key}'. `
        + 'Execution targets, filesystem paths, and CLI arguments are selected by the host.',
      );
    }
    assertNoHostControlledFields(child, `${path}.${key}`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new Error(`Unsupported LoopX parameter '${path}.${unsupported}'.`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LoopX parameter '${path}' must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`LoopX parameter '${path}' must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  return requiredString(value, path);
}

function unsignedInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`LoopX parameter '${path}' must be a non-negative safe integer.`);
  }
  return value;
}

function optionalUnsignedInteger(value: unknown, path: string): number | undefined {
  if (value == null) return undefined;
  return unsignedInteger(value, path);
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`LoopX parameter '${path}' must be a boolean.`);
  }
  return value;
}

function parseIssueKey(value: unknown, path: string): LoopxIssueKey {
  const item = asRecord(value, path);
  assertAllowedKeys(item, ['repository', 'kind', 'number'], path);

  const kind = item.kind;
  if (typeof kind !== 'string' || !ITEM_KINDS.has(kind as LoopxItemKind)) {
    throw new Error(`LoopX parameter '${path}.kind' must be 'issue' or 'pr'.`);
  }

  return {
    repository: parseRepositoryKey(item.repository, `${path}.repository`),
    kind: kind as LoopxItemKind,
    number: unsignedInteger(item.number, `${path}.number`),
  };
}

function parseRepositoryKey(value: unknown, path: string) {
  const repository = asRecord(value, path);
  assertAllowedKeys(repository, ['host', 'owner', 'repository'], path);
  return {
    host: requiredString(repository.host, `${path}.host`),
    owner: requiredString(repository.owner, `${path}.owner`),
    repository: requiredString(repository.repository, `${path}.repository`),
  };
}

function parsePermissionScopes(value: unknown): LoopxPermissionScope[] {
  if (!Array.isArray(value)) {
    throw new Error("LoopX parameter 'params.grantedScopes' must be an array.");
  }
  return value.map((scope, index) => {
    if (typeof scope !== 'string' || !PERMISSION_SCOPES.has(scope as LoopxPermissionScope)) {
      throw new Error(`Unsupported LoopX permission scope at 'params.grantedScopes[${index}]'.`);
    }
    return scope as LoopxPermissionScope;
  });
}

export function isLoopxBridgeMethod(method: string): boolean {
  return method.startsWith('loopx.');
}

export function parseLoopxBridgeCall(
  method: string,
  rawParams: Record<string, unknown>,
): LoopxBridgeCall {
  if (!LOOPX_METHODS.has(method)) {
    throw new Error(`Unknown LoopX method: ${method}`);
  }
  assertNoHostControlledFields(rawParams);

  if (method === 'loopx.attach') {
    assertAllowedKeys(rawParams, ['knownStreamId', 'afterCursor', 'resumeDetected'], 'params');
    return {
      kind: 'attach',
      request: {
        knownStreamId: optionalString(rawParams.knownStreamId, 'params.knownStreamId'),
        afterCursor: optionalUnsignedInteger(rawParams.afterCursor, 'params.afterCursor'),
        resumeDetected: rawParams.resumeDetected === undefined
          ? undefined
          : requiredBoolean(rawParams.resumeDetected, 'params.resumeDetected'),
      },
    };
  }

  if (method === 'loopx.listModels') {
    assertAllowedKeys(rawParams, [], 'params');
    return { kind: 'listModels' };
  }

  if (method === 'loopx.resolveIntake') {
    assertAllowedKeys(rawParams, ['input', 'modelId'], 'params');
    return {
      kind: 'resolveIntake',
      request: {
        input: requiredString(rawParams.input, 'params.input'),
        modelId: requiredString(rawParams.modelId, 'params.modelId'),
      },
    };
  }

  if (method === 'loopx.createTask') {
    assertAllowedKeys(rawParams, [
      'clientRequestId',
      'previewFingerprint',
      'selectedItems',
      'modelId',
      'grantedScopes',
      'retryTerminal',
    ], 'params');
    if (!Array.isArray(rawParams.selectedItems) || rawParams.selectedItems.length === 0) {
      throw new Error("LoopX parameter 'params.selectedItems' must contain at least one item.");
    }
    return {
      kind: 'createTask',
      request: {
        clientRequestId: requiredString(rawParams.clientRequestId, 'params.clientRequestId'),
        previewFingerprint: requiredString(
          rawParams.previewFingerprint,
          'params.previewFingerprint',
        ),
        selectedItems: rawParams.selectedItems.map((item, index) =>
          parseIssueKey(item, `params.selectedItems[${index}]`)),
        modelId: requiredString(rawParams.modelId, 'params.modelId'),
        grantedScopes: parsePermissionScopes(rawParams.grantedScopes),
        retryTerminal: requiredBoolean(rawParams.retryTerminal, 'params.retryTerminal'),
      },
    };
  }

  if (method === 'loopx.action') {
    assertAllowedKeys(rawParams, [
      'taskId',
      'repository',
      'action',
      'clientRequestId',
      'expectedRevision',
      'gateId',
      'note',
    ], 'params');
    if (
      typeof rawParams.action !== 'string'
      || !ACTION_KINDS.has(rawParams.action as LoopxActionKind)
    ) {
      throw new Error("Unsupported LoopX action at 'params.action'.");
    }
    return {
      kind: 'action',
      request: {
        taskId: optionalString(rawParams.taskId, 'params.taskId'),
        repository: rawParams.repository == null
          ? undefined
          : parseRepositoryKey(rawParams.repository, 'params.repository'),
        action: rawParams.action as LoopxActionKind,
        clientRequestId: requiredString(rawParams.clientRequestId, 'params.clientRequestId'),
        expectedRevision: unsignedInteger(rawParams.expectedRevision, 'params.expectedRevision'),
        gateId: optionalString(rawParams.gateId, 'params.gateId'),
        note: optionalString(rawParams.note, 'params.note'),
      },
    };
  }

  if (method === 'loopx.eventsSince') {
    assertAllowedKeys(rawParams, ['streamId', 'afterCursor', 'limit'], 'params');
    return {
      kind: 'eventsSince',
      request: {
        streamId: requiredString(rawParams.streamId, 'params.streamId'),
        afterCursor: unsignedInteger(rawParams.afterCursor, 'params.afterCursor'),
        limit: optionalUnsignedInteger(rawParams.limit, 'params.limit'),
      },
    };
  }

  assertAllowedKeys(rawParams, ['taskId', 'turnId', 'streamId', 'afterCursor', 'limit'], 'params');
  return {
    kind: 'turnOutputSince',
    request: {
      taskId: requiredString(rawParams.taskId, 'params.taskId'),
      turnId: optionalString(rawParams.turnId, 'params.turnId'),
      streamId: optionalString(rawParams.streamId, 'params.streamId'),
      afterCursor: unsignedInteger(rawParams.afterCursor, 'params.afterCursor'),
      limit: optionalUnsignedInteger(rawParams.limit, 'params.limit'),
    },
  };
}
