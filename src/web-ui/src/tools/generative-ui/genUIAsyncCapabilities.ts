/**
 * Host-owned asynchronous capabilities used by the OpenUI renderer.
 *
 * OpenUI owns query caching, loading and retry states. This module owns the
 * boundary around those calls: admission, target selection, cancellation and
 * delivery events. Components only see the small runtime interface below and
 * never decide permissions or remote ownership themselves.
 */

export type GenUIAsyncOperationKind = 'query' | 'mutation' | 'image-search' | 'map-query' | 'event';
export type GenUIAsyncTarget = 'local' | 'workspace' | 'peer' | 'unsupported';

export interface GenUIAsyncCapability {
  kind: GenUIAsyncOperationKind;
  permission?: string;
  /** The target this capability is allowed to use. `any` is host-controlled. */
  target?: GenUIAsyncTarget | 'any';
  /** Alias used by the HTML bridge registry; accepted so both host bridges share admission semantics. */
  remote?: GenUIAsyncTarget | 'any';
  description?: string;
}

export interface GenUIAsyncTargetContext {
  target: GenUIAsyncTarget;
  targetId?: string;
}

export interface GenUIAsyncContext extends GenUIAsyncTargetContext {
  appId: string;
  sourceKey: string;
  requestId: string;
  generation: number;
  statementId?: string;
  operation: GenUIAsyncOperationKind;
  capability: string;
  permission?: string;
  signal: AbortSignal;
}

export interface GenUITargetEvent extends GenUIAsyncTargetContext {
  type: string;
  appId: string;
  sourceKey: string;
  payload: unknown;
  requestId?: string;
}

export interface GenUIAsyncProvider {
  capabilities: Record<string, GenUIAsyncCapability>;
  call(name: string, args: Record<string, unknown>, context: GenUIAsyncContext): Promise<unknown>;
  cancel?(requestId: string, context: Pick<GenUIAsyncContext, 'appId' | 'sourceKey' | 'target' | 'targetId'>): void;
  emit?(event: GenUITargetEvent): void | Promise<void>;
}

/**
 * A host may expose a plain function map for small local providers. The
 * second argument is optional on purpose: existing one-argument handlers stay
 * valid, while new handlers can observe the same cancellation/target context
 * as MCP and native providers.
 */
export type GenUIAsyncToolMap = Record<string, (
  args: Record<string, unknown>,
  context?: GenUIAsyncContext,
) => Promise<unknown>>;

/**
 * OpenUI's native MCP shape. The capability registry is deliberately still
 * required: an MCP client can expose arbitrary tools, while GenUI must only
 * admit the tools the owning host explicitly advertised for this source.
 * `options` is intentionally open so an adapter can pass AbortSignal and
 * host-specific request metadata without coupling this module to an MCP SDK.
 */
export interface GenUIAsyncMcpProvider {
  capabilities: Record<string, GenUIAsyncCapability>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: unknown,
  ): Promise<{
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
    structuredContent?: unknown;
    isError?: boolean;
    [key: string]: unknown;
  }>;
  cancel?(requestId: string, context: Pick<GenUIAsyncContext, 'appId' | 'sourceKey' | 'target' | 'targetId'>): void;
  emit?(event: GenUITargetEvent): void | Promise<void>;
}

export type GenUIProviderInput = GenUIAsyncProvider | GenUIAsyncMcpProvider | GenUIAsyncToolMap;

export interface GenUIAsyncPolicy extends GenUIAsyncTargetContext {
  /** A capability with a permission is denied unless it is explicitly listed. */
  permissions?: readonly string[];
}

export interface GenUIAsyncExecuteOptions {
  kind?: GenUIAsyncOperationKind;
  statementId?: string;
  signal?: AbortSignal;
}

export interface GenUIAsyncRuntime {
  can(name: string): boolean;
  execute(name: string, args: Record<string, unknown>, options?: GenUIAsyncExecuteOptions): Promise<unknown>;
  emit(type: string, payload: unknown, requestId?: string): void;
  abortAll(reason?: string): void;
  /** Update source identity without replacing the runtime object. */
  updateSourceKey?(sourceKey: string, abortActive?: boolean): void;
  setTargetEventHandler?(handler?: (event: GenUITargetEvent) => void | Promise<void>): void;
}

export class GenUIAsyncCapabilityError extends Error {
  readonly code: 'unknown-capability' | 'permission-denied' | 'target-denied' | 'target-required';
  readonly capability: string;

  constructor(code: GenUIAsyncCapabilityError['code'], capability: string, message: string) {
    super(message);
    this.name = 'GenUIAsyncCapabilityError';
    this.code = code;
    this.capability = capability;
  }
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError');
}

function abortError(reason = 'The asynchronous operation was cancelled'): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

function extractMcpToolResult(result: Awaited<ReturnType<GenUIAsyncMcpProvider['callTool']>>): unknown {
  if (result?.isError) {
    const message = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n') || 'Unknown MCP tool error';
    const error = new Error(message);
    error.name = 'McpToolError';
    throw error;
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function normalizeGenUIAsyncProvider(input: GenUIProviderInput): GenUIAsyncProvider {
  if ('call' in input && typeof input.call === 'function' && input.capabilities) return input as GenUIAsyncProvider;
  if ('callTool' in input && typeof input.callTool === 'function' && input.capabilities) {
    const mcp = input as GenUIAsyncMcpProvider;
    return {
      capabilities: mcp.capabilities,
      call: async (name, args, context) => extractMcpToolResult(await mcp.callTool({ name, arguments: args }, { signal: context.signal, context })),
      cancel: mcp.cancel,
      emit: mcp.emit,
    };
  }
  const map = input as GenUIAsyncToolMap;
  const capabilities = Object.fromEntries(Object.keys(map).map(name => [name, { kind: 'query' as const, target: 'local' as const }]));
  return {
    capabilities,
    call: (name, args, context) => {
      const handler = map[name];
      if (!handler) throw new GenUIAsyncCapabilityError('unknown-capability', name, `GenUI capability ${name} is unavailable`);
      return handler(args, context);
    },
  };
}

function linkAbortSignals(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

/**
 * One controller is created per mounted OpenUI source. Replacing the source
 * or unmounting the source calls abortAll, so providers receive a real signal
 * and late promises cannot update a stale document.
 */
export class GenUIAsyncRuntimeController implements GenUIAsyncRuntime {
  private readonly provider: GenUIAsyncProvider;
  private readonly appId: string;
  private sourceKey: string;
  private readonly policy: GenUIAsyncPolicy;
  private generation = 0;
  private sequence = 0;
  private readonly active = new Map<string, { controller: AbortController; capability: GenUIAsyncContext }>();
  private onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;

  constructor(options: {
    provider: GenUIProviderInput;
    appId: string;
    sourceKey: string;
    policy?: Partial<GenUIAsyncPolicy>;
    onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
  }) {
    this.provider = normalizeGenUIAsyncProvider(options.provider);
    this.appId = options.appId;
    this.sourceKey = options.sourceKey;
    this.policy = {
      target: options.policy?.target ?? 'local',
      targetId: options.policy?.targetId,
      permissions: options.policy?.permissions,
    };
    this.onTargetEvent = options.onTargetEvent;
  }

  setTargetEventHandler(handler?: (event: GenUITargetEvent) => void | Promise<void>) {
    this.onTargetEvent = handler;
  }

  updateSourceKey(sourceKey: string, abortActive = true): void {
    if (sourceKey === this.sourceKey) return;
    this.sourceKey = sourceKey;
    if (abortActive) this.abortAll('GenUI source was replaced');
  }

  can(name: string): boolean {
    const capability = this.provider.capabilities[name];
    if (!capability || capability.kind === 'event') return false;
    try {
      this.admit(name, capability);
      return true;
    } catch {
      return false;
    }
  }

  execute(name: string, args: Record<string, unknown>, options: GenUIAsyncExecuteOptions = {}): Promise<unknown> {
    const capability = this.provider.capabilities[name];
    if (!capability) return Promise.reject(new GenUIAsyncCapabilityError('unknown-capability', name, `GenUI capability ${name} is unavailable`));
    try {
      this.admit(name, capability);
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const requestId = `${this.appId}:${this.generation}:${++this.sequence}`;
    const context: GenUIAsyncContext = {
      appId: this.appId,
      sourceKey: this.sourceKey,
      requestId,
      generation: this.generation,
      statementId: options.statementId,
      operation: options.kind ?? capability.kind,
      capability: name,
      permission: capability.permission,
      target: this.policy.target,
      targetId: this.policy.targetId,
      signal: controller.signal,
    };
    this.active.set(requestId, { controller, capability: context });
    const cancelProvider = () => this.provider.cancel?.(requestId, context);
    controller.signal.addEventListener('abort', cancelProvider, { once: true });
    // Register the provider cancellation hook before linking an already
    // aborted caller signal; AbortSignal does not replay an abort event to
    // listeners added after the signal has transitioned.
    const unlink = linkAbortSignals(controller, options.signal);
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError(typeof controller.signal.reason === 'string' ? controller.signal.reason : undefined);
      return this.provider.call(name, args, context);
    });
    let removeCancellation: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(abortError(typeof controller.signal.reason === 'string' ? controller.signal.reason : undefined));
      if (controller.signal.aborted) rejectAbort();
      else {
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        removeCancellation = () => controller.signal.removeEventListener('abort', rejectAbort);
      }
    });
    return Promise.race([pending, cancelled]).then(value => {
      if (controller.signal.aborted) throw abortError(typeof controller.signal.reason === 'string' ? controller.signal.reason : undefined);
      return value;
    }).finally(() => {
      unlink();
      removeCancellation();
      controller.signal.removeEventListener('abort', cancelProvider);
      this.active.delete(requestId);
    });
  }

  emit(type: string, payload: unknown, requestId?: string): void {
    if (this.policy.target === 'unsupported' || (this.policy.target === 'peer' && !this.policy.targetId)) return;
    const eventCapabilityName = this.provider.capabilities[type] ? type : `event.${type}`;
    const eventCapability = this.provider.capabilities[eventCapabilityName];
    // Events are side effects too. They must be explicitly advertised as an
    // event capability; a query/mutation with the same name cannot be reused
    // as an event and an absent capability stays unsupported.
    if (!eventCapability || eventCapability.kind !== 'event') return;
    try { this.admit(eventCapabilityName, eventCapability); } catch { return; }
    const event: GenUITargetEvent = {
      type,
      appId: this.appId,
      sourceKey: this.sourceKey,
      target: this.policy.target,
      targetId: this.policy.targetId,
      payload,
      requestId: requestId ?? `${this.appId}:${this.generation}:event:${++this.sequence}`,
    };
    // A host callback is the local delivery path. Providers may also expose
    // an independent remote mailbox delivery path. The MCP adapter can be
    // configured with the same callback for small hosts, so avoid invoking
    // that exact function twice while still allowing two distinct targets.
    const localHandler = this.onTargetEvent;
    const providerHandler = this.provider.emit;
    void Promise.resolve(localHandler?.(event)).catch(() => undefined);
    if (providerHandler && providerHandler !== localHandler) {
      void Promise.resolve(providerHandler(event)).catch(() => undefined);
    }
  }

  abortAll(reason = 'GenUI source was replaced'): void {
    this.generation += 1;
    for (const entry of this.active.values()) {
      entry.controller.abort(reason);
    }
    this.active.clear();
  }

  private admit(name: string, capability: GenUIAsyncCapability): void {
    const target = this.policy.target;
    const capabilityTarget = capability.target ?? capability.remote;
    if (capabilityTarget === 'unsupported' || (capabilityTarget && capabilityTarget !== 'any' && capabilityTarget !== target)) {
      throw new GenUIAsyncCapabilityError('target-denied', name, `GenUI capability ${name} is unavailable for target ${target}`);
    }
    if (target === 'peer' && !this.policy.targetId) {
      throw new GenUIAsyncCapabilityError('target-required', name, `GenUI capability ${name} requires a peer target id`);
    }
    if (capability.permission && !this.policy.permissions?.includes(capability.permission)) {
      throw new GenUIAsyncCapabilityError('permission-denied', name, `Permission ${capability.permission} is required for GenUI capability ${name}`);
    }
  }
}

export function createGenUIAsyncRuntime(options: {
  provider?: GenUIProviderInput;
  appId: string;
  sourceKey: string;
  policy?: Partial<GenUIAsyncPolicy>;
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
}): GenUIAsyncRuntimeController | undefined {
  if (!options.provider) return undefined;
  return new GenUIAsyncRuntimeController({
    provider: options.provider,
    appId: options.appId,
    sourceKey: options.sourceKey,
    policy: options.policy,
    onTargetEvent: options.onTargetEvent,
  });
}

/** Adapt the host runtime back to the function-map shape expected by OpenUI. */
export function createOpenUIToolProvider(input: GenUIProviderInput, runtime: GenUIAsyncRuntime): GenUIAsyncToolMap {
  const provider = normalizeGenUIAsyncProvider(input);
  return Object.fromEntries(Object.entries(provider.capabilities)
    .filter(([, capability]) => capability.kind !== 'event')
    .map(([name]) => [name, (args: Record<string, unknown>) => runtime.execute(name, args)]));
}

