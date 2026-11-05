import { api } from '@/infrastructure/api/service-api/ApiClient';
import {
  normalizeGenUIAsyncProvider,
} from './genUIAsyncCapabilities';
import type {
  GenUIAsyncCapability,
  GenUIAsyncContext,
  GenUIAsyncProvider,
  GenUIProviderInput,
  GenUITargetEvent,
} from './genUIAsyncCapabilities';

/**
 * Built-in OpenUI media/map provider. It is deliberately an adapter around a
 * host command rather than a component-level fetch, so the desktop owns
 * network policy, timeouts and the provider fallback order.
 */
export function createGenUINativeProvider(target: GenUIAsyncCapability['target'] = 'local'): GenUIAsyncProvider {
  return {
    capabilities: {
      'image.search': { kind: 'image-search', target, description: 'Search image URLs through the host provider' },
      'map.lookup': { kind: 'map-query', target, description: 'Resolve a place name to map markers' },
      'map.route': { kind: 'map-query', target, description: 'Resolve a street route between markers' },
    },
    call: (name: string, args: Record<string, unknown>, context: GenUIAsyncContext) => api.invoke(
      'gen_ui_provider_call',
      { request: { capability: name, args } },
      { signal: context.signal, timeout: 20_000, retries: 0 },
    ),
  };
}

/** Merge an authorized MCP provider with the host-native fallback. MCP wins
 * when it explicitly advertises a semantic capability; native fills gaps. */
export function mergeGenUIProviders(
  primary: GenUIProviderInput | undefined,
  fallback: GenUIAsyncProvider,
  localEventHandler?: (event: GenUITargetEvent) => void | Promise<void>,
): GenUIAsyncProvider {
  const primaryProvider = primary ? normalizeGenUIAsyncProvider(primary) : undefined;
  const capabilities = { ...fallback.capabilities, ...(primaryProvider?.capabilities ?? {}) };
  return {
    capabilities,
    call: (name, args, context) => primaryProvider?.capabilities[name]
      ? primaryProvider.call(name, args, context)
      : fallback.call(name, args, context),
    cancel: (requestId, context) => {
      primaryProvider?.cancel?.(requestId, context);
      fallback.cancel?.(requestId, context);
    },
    emit: event => {
      // The runtime invokes its local handler separately. A provider may use
      // that same callback as a convenience adapter, so do not route it
      // through the merged provider a second time. Distinct provider emitters
      // still receive the event, which preserves remote mailbox delivery.
      const emitted = new Set<NonNullable<GenUIAsyncProvider['emit']>>();
      for (const emitter of [primaryProvider?.emit, fallback.emit]) {
        if (!emitter || emitter === localEventHandler || emitted.has(emitter)) continue;
        emitted.add(emitter);
        void Promise.resolve(emitter(event)).catch(() => undefined);
      }
    },
  };
}

