import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { getCachedToolInfo, resetToolInfoCache } from './toolInfoCache';

const getToolInfo = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/api/service-api/ToolAPI', () => ({ toolAPI: { getToolInfo } }));

describe('tool info cache', () => {
  beforeEach(() => {
    activateSurface('local');
    resetToolInfoCache();
    getToolInfo.mockReset();
  });

  it('reuses a description only on the device that reported it', async () => {
    getToolInfo
      .mockResolvedValueOnce({ name: 'mcp_search', description: 'local server' })
      .mockResolvedValueOnce({ name: 'mcp_search', description: 'peer server' });

    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'local server' });
    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'local server' });
    activateSurface('peer-b');
    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'peer server' });
    activateSurface('local');
    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'local server' });
    expect(getToolInfo).toHaveBeenCalledTimes(2);
  });

  it('retries after a failure without dropping a newer request', async () => {
    getToolInfo
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValueOnce({ name: 'mcp_search', description: 'recovered' });

    await expect(getCachedToolInfo('mcp_search')).rejects.toThrow('host unavailable');
    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'recovered' });
    await expect(getCachedToolInfo('mcp_search')).resolves.toMatchObject({ description: 'recovered' });
    expect(getToolInfo).toHaveBeenCalledTimes(2);
  });
});
