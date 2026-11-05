import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPAPI } from './MCPAPI';
import { globalEventBus } from '@/infrastructure/event-bus';
import { MCP_CONFIG_CHANGED } from '@/infrastructure/mcp/configEvents';

const invokeMock = vi.hoisted(() => vi.fn());
const scopeMock = vi.hoisted(() => ({ surfaceId: 'local', assertCurrent: vi.fn() }));
vi.mock('./ApiClient', () => ({ api: { invoke: invokeMock } }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => scopeMock,
}));

describe('MCP JSON save acknowledgement', () => {
  beforeEach(() => { invokeMock.mockReset(); scopeMock.assertCurrent.mockReset(); });

  it('passes GenUI cancellation to the MCP app transport without serializing the signal', async () => {
    invokeMock.mockResolvedValue({ jsonrpc: '2.0', id: 'request-1', result: {} });
    const controller = new AbortController();
    await MCPAPI.sendMCPAppMessage({ serverId: 'docs', jsonrpc: '2.0', id: 'request-1', method: 'tools/call', signal: controller.signal });
    expect(invokeMock).toHaveBeenCalledWith('send_mcp_app_message', {
      request: { serverId: 'docs', jsonrpc: '2.0', id: 'request-1', method: 'tools/call' },
    }, { signal: controller.signal });
  });

  it('enables one imported server with CAS and preserves origin, secrets and unrelated settings', async () => {
    const config = { mcpServers: {
      imported: { enabled: false, autoStart: false, env: { TEST_KEY: 'private-value' }, _openbitfunImport: { sourceCandidateId: 'codex:mcp' }, futureOption: 3 },
      other: { enabled: false, command: 'other' },
    }, futureRoot: true };
    invokeMock.mockResolvedValueOnce({ jsonConfig: JSON.stringify(config), fingerprint: 'before-enable' }).mockResolvedValueOnce(undefined);
    await expect(MCPAPI.enableServer('imported')).resolves.toEqual({ runtimeApplied: true });
    const saved = invokeMock.mock.calls[1];
    expect(saved[0]).toBe('save_mcp_json_config');
    expect(saved[1].expectedFingerprint).toBe('before-enable');
    expect(JSON.parse(saved[1].jsonConfig)).toEqual({ ...config, mcpServers: { ...config.mcpServers, imported: { ...config.mcpServers.imported, enabled: true } } });
    expect(invokeMock.mock.calls.map(call => call[0])).not.toContain('start_mcp_server');
  });

  it('does not recreate a removed server or write to a changed host while enabling', async () => {
    invokeMock.mockResolvedValueOnce({ jsonConfig: '{"mcpServers":{}}', fingerprint: 'current' });
    await expect(MCPAPI.enableServer('removed')).rejects.toThrow('unavailable');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();
    invokeMock.mockResolvedValueOnce({ jsonConfig: '{"mcpServers":{"imported":{"enabled":false}}}', fingerprint: 'current' });
    scopeMock.assertCurrent.mockImplementationOnce(() => { throw new Error('Surface changed'); });
    await expect(MCPAPI.enableServer('imported')).rejects.toThrow('Surface changed');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('notifies cached lists only for acknowledged persistence, including pending runtime cleanup', async () => {
    const changed = vi.fn();
    const unsubscribe = globalEventBus.on(MCP_CONFIG_CHANGED, changed);
    try {
      invokeMock.mockResolvedValueOnce(undefined);
      await MCPAPI.saveMCPJsonConfig('{}', 'revision');
      expect(changed).toHaveBeenCalledWith({ surfaceId: 'local' });
      changed.mockClear();
      invokeMock.mockRejectedValueOnce('MCP configuration changed; reload before saving');
      await expect(MCPAPI.saveMCPJsonConfig('{}', 'revision')).rejects.toBeDefined();
      expect(changed).not.toHaveBeenCalled();
      invokeMock.mockRejectedValueOnce('MCP config was saved, but runtime reconciliation failed: offline');
      await MCPAPI.saveMCPJsonConfig('{}', 'revision');
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('publishes native MCP deletions only after acknowledged writes on the same host', async () => {
    const changed = vi.fn();
    const unsubscribe = globalEventBus.on(MCP_CONFIG_CHANGED, changed);
    try {
      let finish!: () => void;
      invokeMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const deleting = MCPAPI.deleteServer({ serverId: 'imported-copy' });
      expect(changed).not.toHaveBeenCalled();
      finish();
      await deleting;
      expect(invokeMock).toHaveBeenCalledWith('delete_mcp_server', { request: { serverId: 'imported-copy' } });
      expect(changed).toHaveBeenCalledExactlyOnceWith({ surfaceId: 'local' });
      changed.mockClear();
      invokeMock.mockRejectedValueOnce(new Error('Delete failed'));
      await expect(MCPAPI.deleteServer({ serverId: 'kept-copy' })).rejects.toThrow('Delete failed');
      expect(changed).not.toHaveBeenCalled();
      invokeMock.mockResolvedValueOnce(undefined);
      scopeMock.assertCurrent.mockImplementationOnce(() => { throw new Error('Surface changed'); });
      await expect(MCPAPI.deleteServer({ serverId: 'previous-device-copy' })).rejects.toThrow('Surface changed');
      expect(changed).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('accepts the existing void success response', async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(MCPAPI.saveMCPJsonConfig('{}', 'revision')).resolves.toEqual({ runtimeApplied: true });
    expect(invokeMock).toHaveBeenCalledWith('save_mcp_json_config', {
      jsonConfig: '{}', expectedFingerprint: 'revision',
    });
  });

  it.each([
    'MCP config was saved, but runtime reconciliation failed: connection refused',
    new Error('MCP config was saved, but runtime reconciliation failed: connection refused'),
  ])('recognizes an explicit persisted acknowledgement: %s', async (error) => {
    invokeMock.mockRejectedValue(error);
    await expect(MCPAPI.saveMCPJsonConfig('{}', 'revision')).resolves.toEqual({ runtimeApplied: false });
  });

  it.each([
    'Failed to save config: permission denied',
    'MCP configuration changed; reload before saving',
    new Error('Request timeout: save_mcp_json_config'),
    'connection refused',
  ])('does not assume an unacknowledged write succeeded: %s', async (error) => {
    invokeMock.mockRejectedValue(error);
    await expect(MCPAPI.saveMCPJsonConfig('{}', 'revision')).rejects.toBe(error);
  });

  it('confirms a timed-out save by reading back the same JSON regardless of key order', async () => {
    const error = Object.assign(new Error('Request timeout'), { code: 'REQUEST_TIMEOUT' });
    invokeMock.mockRejectedValueOnce(error).mockResolvedValueOnce({
      jsonConfig: '{"mcpServers":{"offline":{"autoStart":true,"args":["a","b"]}}}',
      fingerprint: 'saved',
    });
    await expect(MCPAPI.saveMCPJsonConfig(
      '{"mcpServers":{"offline":{"args":["a","b"],"autoStart":true}}}', 'revision',
    )).resolves.toEqual({ runtimeApplied: false });
    expect(invokeMock.mock.calls.map(call => call[0])).toEqual(['save_mcp_json_config', 'load_mcp_json_config']);
  });

  it.each([
    { jsonConfig: '{"mcpServers":{"offline":{"args":["b","a"]}}}', fingerprint: 'other' },
    null,
  ])('retains a timeout when read-back cannot confirm the requested content: %s', async (snapshot) => {
    const error = Object.assign(new Error('Request timeout'), { code: 'REQUEST_TIMEOUT' });
    invokeMock.mockRejectedValueOnce(error);
    if (snapshot) invokeMock.mockResolvedValueOnce(snapshot);
    else invokeMock.mockRejectedValueOnce(new Error('Host disconnected'));
    await expect(MCPAPI.saveMCPJsonConfig(
      '{"mcpServers":{"offline":{"args":["a","b"]}}}', 'revision',
    )).rejects.toBe(error);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('does not read configuration from a newly selected device after a timeout', async () => {
    const changed = new Error('Surface changed');
    scopeMock.assertCurrent.mockImplementation(() => { throw changed; });
    invokeMock.mockRejectedValueOnce(Object.assign(new Error('Request timeout'), { code: 'REQUEST_TIMEOUT' }));
    await expect(MCPAPI.saveMCPJsonConfig('{}', 'revision')).rejects.toBe(changed);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
