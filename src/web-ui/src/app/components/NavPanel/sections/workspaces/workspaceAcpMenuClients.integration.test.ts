// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { loadWorkspaceAcpMenuClients } from './workspaceAcpMenuClients';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke } }));

beforeEach(() => {
  activateSurface('local');
  invoke.mockReset();
});

it('settles an empty remote menu without a probe-completion feedback loop', async () => {
  let probes = 0;
  invoke.mockImplementation(async command => {
    if (command === 'get_acp_clients') return [{ id: 'codex', enabled: true }];
    if (command === 'probe_acp_client_requirements') {
      // Bound a broken fixture so the assertion reports the feedback loop.
      if (++probes > 4) throw new Error('Probe completion restarted probing');
      return [];
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const options = { remoteWorkspace: true, remoteConnectionId: 'ssh-empty' };
  const loads: Promise<unknown>[] = [];
  const onCompletion = () => {
    loads.push(loadWorkspaceAcpMenuClients({ ...options, refreshIfMissing: false }).catch(error => error));
  };
  window.addEventListener('openbitfun:acp-requirements-changed', onCompletion);
  try {
    const initial = loadWorkspaceAcpMenuClients(options);
    await initial;
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    await Promise.all(loads);
    expect(probes).toBe(2); // One cached-snapshot read and one live probe.
    expect(await initial).toEqual([]);
  } finally {
    window.removeEventListener('openbitfun:acp-requirements-changed', onCompletion);
  }
});
