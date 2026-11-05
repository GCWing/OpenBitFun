import { describe, expect, it, vi } from 'vitest';
import { createGenUIAsyncRuntime, type GenUITargetEvent } from './genUIAsyncCapabilities';
import { mergeGenUIProviders } from './genUINativeProvider';

describe('merged GenUI providers', () => {
  it('does not deliver a shared local event handler twice', () => {
    const events: GenUITargetEvent[] = [];
    const localHandler = (event: GenUITargetEvent) => events.push(event);
    const primary = {
      capabilities: { 'event.map.marker.select': { kind: 'event' as const, target: 'local' as const } },
      call: vi.fn(async () => undefined),
      emit: localHandler,
    };
    const merged = mergeGenUIProviders(primary, { capabilities: {}, call: vi.fn(async () => undefined) }, localHandler);
    const runtime = createGenUIAsyncRuntime({
      provider: merged,
      appId: 'app',
      sourceKey: 'source',
      onTargetEvent: localHandler,
    });

    runtime?.emit('map.marker.select', { label: 'Home' });

    expect(events).toHaveLength(1);
  });

  it('keeps distinct provider event delivery', () => {
    const localEvents: GenUITargetEvent[] = [];
    const remoteEvents: GenUITargetEvent[] = [];
    const localHandler = (event: GenUITargetEvent) => localEvents.push(event);
    const remoteHandler = (event: GenUITargetEvent) => remoteEvents.push(event);
    const primary = {
      capabilities: { 'event.map.marker.select': { kind: 'event' as const, target: 'local' as const } },
      call: vi.fn(async () => undefined),
      emit: remoteHandler,
    };
    const merged = mergeGenUIProviders(primary, { capabilities: {}, call: vi.fn(async () => undefined) }, localHandler);
    const runtime = createGenUIAsyncRuntime({
      provider: merged,
      appId: 'app',
      sourceKey: 'source',
      onTargetEvent: localHandler,
    });

    runtime?.emit('map.marker.select', { label: 'Home' });

    expect(localEvents).toHaveLength(1);
    expect(remoteEvents).toHaveLength(1);
  });
});
