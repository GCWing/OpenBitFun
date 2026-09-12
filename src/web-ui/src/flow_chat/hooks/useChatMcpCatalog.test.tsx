/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatMcpCatalog, type ChatMcpCatalog } from '@/infrastructure/api/service-api/ChatMcpAPI';
import { useChatMcpCatalog } from './useChatMcpCatalog';

vi.mock('@/infrastructure/api/service-api/ChatMcpAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/ChatMcpAPI')>(),
  getChatMcpCatalog: vi.fn(),
}));
const catalog: ChatMcpCatalog = { tools: [{ name: 'mcp__docs__search', serverId: 'docs', serverName: 'Docs', toolName: 'search', description: '' }], modeRestricted: false };

describe('useChatMcpCatalog', () => {
  let root: Root;
  let latest: ReturnType<typeof useChatMcpCatalog>;
  let props: Parameters<typeof useChatMcpCatalog>[0];
  let requests: Array<{ resolve: (value: ChatMcpCatalog) => void; reject: (error: Error) => void }>;
  function Probe() { latest = useChatMcpCatalog(props); return null; }
  async function render(update = {}) {
    props = { ...props, ...update };
    await act(async () => root.render(<Probe />));
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    props = { enabled: true, surfaceEpoch: 1, modeId: 'Standard', workspacePath: '/project' };
    requests = [];
    vi.mocked(getChatMcpCatalog).mockReset().mockImplementation(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  });
  afterEach(async () => { await act(async () => root.unmount()); });

  it.each([{ modeId: 'Minimal' }, { workspacePath: '/another' }, { surfaceEpoch: 2 }, { remoteConnectionId: 'ssh-1' }])('discards stale catalogs on scope change %j', async update => {
    await render();
    await act(async () => requests[0].resolve(catalog));
    expect(latest.catalog).toEqual(catalog);
    await render(update);
    expect(latest.catalog).toBeUndefined();
    expect(latest.loading).toBe(true);
    await act(async () => requests[1].resolve({ tools: [], modeRestricted: true }));
    expect(latest.catalog?.tools).toEqual([]);
  });

  it('refreshes each opening and ignores a request from a closed picker', async () => {
    await render();
    await render({ enabled: false });
    await render({ enabled: true });
    await act(async () => requests[0].resolve(catalog));
    expect(latest.catalog).toBeUndefined();
    await act(async () => requests[1].resolve({ tools: [], modeRestricted: false }));
    expect(latest.catalog?.tools).toEqual([]);
  });

  it('clears unavailable tools on failure and retries without preserving stale results', async () => {
    await render();
    await act(async () => requests[0].reject(new Error('offline')));
    expect(latest.failed).toBe(true);
    await act(async () => latest.refresh());
    expect(latest.loading).toBe(true);
    expect(latest.failed).toBe(false);
    await act(async () => requests[1].resolve(catalog));
    expect(latest.catalog).toEqual(catalog);
  });
});
