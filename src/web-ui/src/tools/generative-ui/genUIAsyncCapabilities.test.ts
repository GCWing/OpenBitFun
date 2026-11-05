import { describe, expect, it, vi } from 'vitest';
import {
  GenUIAsyncCapabilityError,
  createGenUIAsyncRuntime,
  isAbortError,
  type GenUIAsyncContext,
  type GenUITargetEvent,
} from './genUIAsyncCapabilities';

describe('GenUI async capability runtime', () => {
  it('passes a cancellable context and enforces permission and peer ownership', async () => {
    let context: GenUIAsyncContext | undefined;
    const provider = {
      capabilities: { lookup: { kind: 'query' as const, permission: 'places.read', target: 'peer' as const } },
      call: vi.fn(async (_name: string, _args: Record<string, unknown>, next: GenUIAsyncContext) => {
        context = next;
        return { value: 'ok' };
      }),
    };
    const runtime = createGenUIAsyncRuntime({
      provider,
      appId: 'app',
      sourceKey: 'source',
      policy: { target: 'peer', targetId: 'phone-1', permissions: ['places.read'] },
    });
    await expect(runtime?.execute('lookup', { q: 'Paris' })).resolves.toEqual({ value: 'ok' });
    expect(context).toMatchObject({ appId: 'app', sourceKey: 'source', operation: 'query', target: 'peer', targetId: 'phone-1', permission: 'places.read' });
    expect(context?.signal).toBeInstanceOf(AbortSignal);
    expect(provider.call).toHaveBeenCalledWith('lookup', { q: 'Paris' }, context);

    const denied = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    await expect(denied?.execute('lookup', {})).rejects.toMatchObject<GenUIAsyncCapabilityError>({ code: 'target-denied' });
  });

  it('rejects a pending provider immediately and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const cancel = vi.fn();
    const provider = {
      capabilities: { slow: { kind: 'query' as const } },
      call: vi.fn((_name: string, _args: Record<string, unknown>, context: GenUIAsyncContext) => {
        signal = context.signal;
        return new Promise<unknown>(() => undefined);
      }),
      cancel,
    };
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'first' });
    const pending = runtime!.execute('slow', {});
    await Promise.resolve();
    runtime!.abortAll('source replaced');
    await expect(pending).rejects.toSatisfy(isAbortError);
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels immediately when the caller signal is already aborted', async () => {
    const cancel = vi.fn();
    const provider = {
      capabilities: { slow: { kind: 'query' as const } },
      call: vi.fn(async () => new Promise<unknown>(() => undefined)),
      cancel,
    };
    const signal = new AbortController();
    signal.abort('caller stopped');
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    await expect(runtime?.execute('slow', {}, { signal: signal.signal })).rejects.toSatisfy(isAbortError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('adapts an OpenUI MCP provider and extracts structured results', async () => {
    let signal: AbortSignal | undefined;
    const mcp = {
      capabilities: { lookup: { kind: 'query' as const, target: 'local' as const } },
      callTool: vi.fn(async (_request: unknown, options?: unknown) => {
        signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        return { content: [], structuredContent: { value: 'from mcp' } };
      }),
    };
    const runtime = createGenUIAsyncRuntime({ provider: mcp, appId: 'app', sourceKey: 'source' });
    await expect(runtime?.execute('lookup', { q: 'Paris' })).resolves.toEqual({ value: 'from mcp' });
    expect(mcp.callTool).toHaveBeenCalledWith(
      { name: 'lookup', arguments: { q: 'Paris' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(signal?.aborted).toBe(false);
  });

  it('passes the runtime context to plain tool-map providers', async () => {
    let context: GenUIAsyncContext | undefined;
    const provider = {
      lookup: vi.fn(async (_args: Record<string, unknown>, next?: GenUIAsyncContext) => {
        context = next;
        return { value: 'from map' };
      }),
    };
    const runtime = createGenUIAsyncRuntime({
      provider,
      appId: 'map-app',
      sourceKey: 'map-source',
    });
    await expect(runtime?.execute('lookup', { q: 'Paris' })).resolves.toEqual({ value: 'from map' });
    expect(context).toMatchObject({
      appId: 'map-app',
      sourceKey: 'map-source',
      target: 'local',
      capability: 'lookup',
    });
    expect(context?.signal).toBeInstanceOf(AbortSignal);
  });

  it('delivers target events with the selected remote target', () => {
    const events: GenUITargetEvent[] = [];
    const provider = {
      capabilities: { 'event.map.marker.select': { kind: 'event' as const, target: 'workspace' as const } },
      call: vi.fn(async () => undefined),
      emit: vi.fn((event: GenUITargetEvent) => events.push(event)),
    };
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source', policy: { target: 'workspace', targetId: 'ws-1' }, onTargetEvent: event => events.push(event) });
    runtime?.emit('map.marker.select', { label: 'Home' }, 'request-1');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'map.marker.select', appId: 'app', sourceKey: 'source', target: 'workspace', targetId: 'ws-1', requestId: 'request-1', payload: { label: 'Home' } });
  });

  it('does not deliver the same target event twice when local and provider handlers are shared', () => {
    const events: GenUITargetEvent[] = [];
    const handler = (event: GenUITargetEvent) => events.push(event);
    const provider = {
      capabilities: { 'event.map.marker.select': { kind: 'event' as const, target: 'local' as const } },
      call: vi.fn(async () => undefined),
      emit: handler,
    };
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source', onTargetEvent: handler });
    runtime?.emit('map.marker.select', { label: 'Home' });
    expect(events).toHaveLength(1);
  });

  it('keeps unregistered target events unsupported', () => {
    const onTargetEvent = vi.fn();
    const runtime = createGenUIAsyncRuntime({
      provider: { capabilities: {}, call: vi.fn(async () => undefined) },
      appId: 'app', sourceKey: 'source', onTargetEvent,
    });
    runtime?.emit('map.marker.select', { label: 'Home' });
    expect(onTargetEvent).not.toHaveBeenCalled();
  });
});

