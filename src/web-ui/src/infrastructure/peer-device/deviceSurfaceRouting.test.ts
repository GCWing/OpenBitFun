import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PEER_EVENT_SOURCE_KEY,
  PEER_EVENT_WRAPPED_PAYLOAD_KEY,
  isSurfaceScopedEvent,
  observeSurfaceEvents,
  routeSurfaceEvent,
  setActiveSurfaceDeviceId,
} from './deviceSurfaceRouting';

function peerPayload(deviceId: string, payload: Record<string, unknown>) {
  return { ...payload, [PEER_EVENT_SOURCE_KEY]: deviceId };
}

afterEach(() => {
  setActiveSurfaceDeviceId(null);
});

describe('isSurfaceScopedEvent', () => {
  it('scopes agentic, backend and fanned-out product events', () => {
    expect(isSurfaceScopedEvent('agentic://text-chunk')).toBe(true);
    expect(isSurfaceScopedEvent('backend-event-toolexecutionstarted')).toBe(true);
    expect(isSurfaceScopedEvent('terminal_event')).toBe(true);
    expect(isSurfaceScopedEvent('permission://event')).toBe(true);
    expect(isSurfaceScopedEvent('session_title_generated')).toBe(true);
    expect(isSurfaceScopedEvent('workspace-catalog-changed')).toBe(true);
  });

  it('leaves control-plane events unscoped so they always pass', () => {
    expect(isSurfaceScopedEvent('account://device-presence')).toBe(false);
    expect(isSurfaceScopedEvent('account://login-state')).toBe(false);
    expect(isSurfaceScopedEvent('workspace-identity-changed')).toBe(false);
  });
});

describe('routeSurfaceEvent', () => {
  it('delivers local events only while the local surface is rendered', () => {
    setActiveSurfaceDeviceId(null);
    expect(routeSurfaceEvent('agentic://text-chunk', { sessionId: 's1' }).deliver).toBe(true);

    setActiveSurfaceDeviceId('device-b');
    expect(routeSurfaceEvent('agentic://text-chunk', { sessionId: 's1' }).deliver).toBe(false);
  });

  it('delivers a peer event only to the surface rendering that peer', () => {
    setActiveSurfaceDeviceId('device-b');
    expect(
      routeSurfaceEvent('agentic://text-chunk', peerPayload('device-b', { sessionId: 's1' })).deliver,
    ).toBe(true);
    expect(
      routeSurfaceEvent('agentic://text-chunk', peerPayload('device-c', { sessionId: 's1' })).deliver,
    ).toBe(false);
  });

  it('keeps local work out of a rendered peer surface', () => {
    // The regression this routing exists for: a turn still running on this
    // machine must not stream into the peer's chat.
    setActiveSurfaceDeviceId('device-b');
    const localChunk = routeSurfaceEvent('agentic://text-chunk', { sessionId: 'local-session' });
    expect(localChunk.deliver).toBe(false);
  });

  it('strips the routing tag from delivered payloads', () => {
    setActiveSurfaceDeviceId('device-b');
    const route = routeSurfaceEvent(
      'agentic://text-chunk',
      peerPayload('device-b', { sessionId: 's1', content: 'hi' }),
    );
    expect(route.payload).toEqual({ sessionId: 's1', content: 'hi' });
    expect(PEER_EVENT_SOURCE_KEY in (route.payload as object)).toBe(false);
  });

  it('unwraps non-object peer payloads', () => {
    setActiveSurfaceDeviceId('device-b');
    const route = routeSurfaceEvent('terminal_event', {
      [PEER_EVENT_SOURCE_KEY]: 'device-b',
      [PEER_EVENT_WRAPPED_PAYLOAD_KEY]: 'raw-string',
    });
    expect(route.deliver).toBe(true);
    expect(route.payload).toBe('raw-string');
  });

  it('always delivers control-plane events regardless of surface', () => {
    setActiveSurfaceDeviceId('device-b');
    expect(routeSurfaceEvent('account://device-presence', { devices: [] }).deliver).toBe(true);
  });

  it('reports events from devices that are not rendered to observers', () => {
    const observer = vi.fn();
    const dispose = observeSurfaceEvents(observer);
    try {
      setActiveSurfaceDeviceId(null);
      routeSurfaceEvent(
        'agentic://dialog-turn-started',
        peerPayload('device-b', { sessionId: 's1' }),
      );
      expect(observer).toHaveBeenCalledWith(
        'agentic://dialog-turn-started',
        'device-b',
        { sessionId: 's1' },
      );
    } finally {
      dispose();
    }
  });
});
