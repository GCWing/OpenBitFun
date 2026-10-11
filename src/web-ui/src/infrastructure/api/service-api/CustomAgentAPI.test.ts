import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomAgentAPI } from './CustomAgentAPI';
import { globalEventBus } from '@/infrastructure/event-bus';
import { activateSurface, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));

describe('CustomAgentAPI device ownership', () => {
  beforeEach(() => {
    activateSurface('local');
    invoke.mockReset();
  });

  it('does not publish a completed mutation into the next device catalog', async () => {
    invoke.mockImplementationOnce(() => {
      queueMicrotask(() => queueMicrotask(() => activateSurface('other-device')));
      return Promise.resolve();
    });
    const changed = vi.fn();
    const unsubscribe = globalEventBus.on('mode:config:updated', changed);
    try {
      await expect(CustomAgentAPI.deleteCustomAgent('same-agent', 'same-workspace'))
        .rejects.toSatisfy(isSurfaceChangedError);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
