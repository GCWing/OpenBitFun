import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPAPI } from '@/infrastructure/api/service-api/MCPAPI';
import type { ChatMcpCatalog } from '@/infrastructure/api/service-api/ChatMcpAPI';
import { createGenUIMcpProvider } from './genUIMcpProvider';
import { createGenUIAsyncRuntime } from './genUIAsyncCapabilities';

vi.mock('@/infrastructure/api/service-api/MCPAPI', () => ({
  MCPAPI: { sendMCPAppMessage: vi.fn() },
}));

const catalog: ChatMcpCatalog = {
  modeRestricted: false,
  tools: [{ name: 'mcp__docs__search', serverId: 'docs', serverName: 'Docs', toolName: 'search', description: 'Search docs' }],
};

describe('GenUI MCP provider', () => {
  beforeEach(() => vi.mocked(MCPAPI.sendMCPAppMessage).mockReset());

  it('admits only catalog tools and unwraps structured JSON-RPC results', async () => {
    vi.mocked(MCPAPI.sendMCPAppMessage).mockResolvedValue({ result: { structuredContent: { rows: [{ id: 1 }] } } });
    const provider = createGenUIMcpProvider(catalog);
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    await expect(runtime?.execute('mcp__docs__search', { q: 'OpenUI' })).resolves.toEqual({ rows: [{ id: 1 }] });
    expect(MCPAPI.sendMCPAppMessage).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'docs', method: 'tools/call', params: { name: 'search', arguments: { q: 'OpenUI' } },
      signal: expect.any(AbortSignal),
    }));
    expect(runtime?.can('mcp__other__delete')).toBe(false);
  });

  it('keeps writes opt-in and propagates JSON-RPC errors', async () => {
    vi.mocked(MCPAPI.sendMCPAppMessage).mockResolvedValue({ error: { code: -32000, message: 'denied' } });
    const provider = createGenUIMcpProvider(catalog, { mutationTools: ['mcp__docs__search'] });
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    await expect(runtime?.execute('mcp__docs__search', {})).rejects.toThrow('denied');
    expect(provider.capabilities['mcp__docs__search'].kind).toBe('mutation');
  });

  it('passes cancellation to the MCP transport', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(MCPAPI.sendMCPAppMessage).mockImplementation(async request => {
      signal = request?.signal;
      return await new Promise(resolve => setTimeout(() => resolve({ result: { structuredContent: { ok: true } } }), 100));
    });
    const provider = createGenUIMcpProvider(catalog);
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    const pending = runtime!.execute('mcp__docs__search', {});
    await Promise.resolve();
    await Promise.resolve();
    runtime!.abortAll('replaced');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
  });

  it('admits target events only when the host declares them separately', () => {
    const events: unknown[] = [];
    const provider = createGenUIMcpProvider(catalog, {
      eventCapabilities: { 'map.marker.select': { target: 'local' } },
      onTargetEvent: event => events.push(event),
    });
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source' });
    runtime?.emit('map.marker.select', { label: 'Home' });
    expect(events).toHaveLength(1);
    expect(provider.capabilities['map.marker.select'].kind).toBe('event');
  });

  it('exposes only exact authorized image and map semantic aliases', async () => {
    const semanticCatalog: ChatMcpCatalog = {
      modeRestricted: false,
      tools: [
        { name: 'photos', serverId: 'media', serverName: 'Media', toolName: 'image_search', description: 'Search images' },
        { name: 'routing', serverId: 'maps', serverName: 'Maps', toolName: 'street_route', description: 'Route streets' },
        { name: 'unrelated', serverId: 'other', serverName: 'Other', toolName: 'search_anything', description: 'Unrelated' },
      ],
    };
    vi.mocked(MCPAPI.sendMCPAppMessage).mockResolvedValue({ result: { structuredContent: { ok: true } } });
    const provider = createGenUIMcpProvider(semanticCatalog, { permissions: { 'image.search': 'images.read' } });
    const runtime = createGenUIAsyncRuntime({ provider, appId: 'app', sourceKey: 'source', policy: { permissions: ['images.read'] } });
    expect(runtime.can('image.search')).toBe(true);
    expect(runtime.can('map.route')).toBe(true);
    expect(runtime.can('map.lookup')).toBe(false);
    expect(runtime.can('unrelated')).toBe(true);
    expect(runtime.can('image.search.anything')).toBe(false);
    await runtime.execute('image.search', { query: 'Shanghai' });
    expect(MCPAPI.sendMCPAppMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      serverId: 'media', params: { name: 'image_search', arguments: { query: 'Shanghai' } },
    }));
  });
});
