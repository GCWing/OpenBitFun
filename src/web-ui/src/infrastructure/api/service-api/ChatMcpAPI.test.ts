import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatMcpCatalog } from './ChatMcpAPI';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getPeer: vi.fn(), scope: { surfaceId: 'local', assertCurrent: vi.fn() } }));
vi.mock('./ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({ peerConnectionManager: { get: mocks.getPeer } }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => mocks.scope, isLocalSurface: (id: string) => id === 'local' }));

const request = { modeId: 'Standard', workspacePath: '/project' };
const catalog = { tools: [], modeRestricted: false };
describe('MCP chat catalog API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.scope.surfaceId = 'local';
    mocks.invoke.mockResolvedValue(catalog);
  });
  it('queries the scoped host catalog using a structured request', async () => {
    expect(await getChatMcpCatalog(request)).toEqual(catalog);
    expect(mocks.invoke).toHaveBeenCalledWith('get_chat_mcp_catalog', { request });
  });
  it('rejects remote workspaces without querying controller tools', async () => {
    await expect(getChatMcpCatalog({ ...request, remoteConnectionId: 'ssh-1' })).rejects.toMatchObject({ reason: 'remoteWorkspace' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it.each([undefined, false])('does not query an old peer without explicit capability %s', async value => {
    mocks.scope.surfaceId = 'peer-1';
    mocks.getPeer.mockReturnValue({ getState: () => ({ capabilities: { chatMcpCatalogV1: value } }) });
    await expect(getChatMcpCatalog(request)).rejects.toMatchObject({ reason: 'unsupportedHost' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it('uses the negotiated peer catalog and rejects late results after a device switch', async () => {
    mocks.scope.surfaceId = 'peer-1';
    mocks.getPeer.mockReturnValue({ getState: () => ({ capabilities: { chatMcpCatalogV1: true } }) });
    expect(await getChatMcpCatalog(request)).toEqual(catalog);
    mocks.scope.assertCurrent.mockImplementationOnce(() => { throw new Error('Surface changed'); });
    await expect(getChatMcpCatalog(request)).rejects.toThrow('Surface changed');
  });
  it('does not convert malformed responses or request failures into an empty list', async () => {
    mocks.invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'));
    await expect(getChatMcpCatalog(request)).rejects.toMatchObject({ reason: 'unsupportedHost' });
    await expect(getChatMcpCatalog(request)).rejects.toThrow('offline');
  });
});
