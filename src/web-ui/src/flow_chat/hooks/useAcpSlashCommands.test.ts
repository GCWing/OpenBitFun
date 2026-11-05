// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

import { ACPClientAPI, type AcpAvailableCommand } from '@/infrastructure/api/service-api/ACPClientAPI';
import { acpSessionRef, acpSlashCommandText } from '../utils/acpSession';
import { filterSlashCommands, useAcpSlashCommands } from './useAcpSlashCommands';

vi.mock('@/infrastructure/api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: { getSessionCommands: vi.fn(), onAvailableCommandsUpdated: vi.fn() },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const commands: AcpAvailableCommand[] = [
  { name: 'compact', description: 'Compact the conversation context' },
  { name: 'init', description: 'Initialize the project' },
  { name: 'create_plan', description: 'Draft an execution plan', inputHint: 'what to plan' },
];

describe('ACP command subscriptions', () => {
  let root: Root;
  let container: HTMLDivElement;
  const session = { sessionId: 'same-session', clientId: 'codex', workspaceId: 'same-workspace' };
  function View() {
    const { commands: list } = useAcpSlashCommands(session);
    return createElement('div', null, list.map(command => command.name).join(','));
  }
  beforeEach(() => {
    resetDeviceSurfaceForTest();
    vi.clearAllMocks();
    vi.mocked(ACPClientAPI.onAvailableCommandsUpdated).mockReturnValue(vi.fn());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reloads commands and subscribes again when devices have identical session IDs', async () => {
    vi.mocked(ACPClientAPI.getSessionCommands).mockResolvedValueOnce(commands)
      .mockResolvedValueOnce([{ name: 'peer-command', description: 'Peer' }]);
    await act(async () => root.render(createElement(View)));
    expect(container.textContent).toContain('compact');
    await act(async () => { activateSurface('peer-b'); });
    expect(ACPClientAPI.getSessionCommands).toHaveBeenCalledTimes(2);
    expect(ACPClientAPI.onAvailableCommandsUpdated).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('peer-command');
    const oldCallback = vi.mocked(ACPClientAPI.onAvailableCommandsUpdated).mock.calls[0][0];
    act(() => oldCallback({ sessionId: session.sessionId, clientId: session.clientId, commands }));
    expect(container.textContent).toBe('peer-command');
  });

  it('does not overwrite the new device commands with an old pending read', async () => {
    let resolve!: (value: AcpAvailableCommand[]) => void;
    vi.mocked(ACPClientAPI.getSessionCommands).mockReturnValueOnce(new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce([{ name: 'peer-command', description: 'Peer' }]);
    await act(async () => root.render(createElement(View)));
    await act(async () => { activateSurface('peer-b'); });
    await act(async () => resolve(commands));
    expect(container.textContent).toBe('peer-command');
  });
});

describe('filterSlashCommands', () => {
  it('returns all commands for an empty query', () => {
    expect(filterSlashCommands(commands, '')).toHaveLength(3);
    expect(filterSlashCommands(commands, '   ')).toHaveLength(3);
  });

  it('tolerates a leading slash', () => {
    expect(filterSlashCommands(commands, '/comp').map((command) => command.name)).toEqual([
      'compact',
    ]);
  });

  it('matches command names case-insensitively', () => {
    expect(filterSlashCommands(commands, 'INIT').map((command) => command.name)).toEqual([
      'init',
    ]);
  });

  it('matches descriptions', () => {
    expect(filterSlashCommands(commands, 'plan').map((command) => command.name)).toEqual([
      'create_plan',
    ]);
  });

  it('returns empty when nothing matches', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([]);
  });
});

describe('acpSlashCommandText', () => {
  it('formats command names as invokable prompt text', () => {
    expect(acpSlashCommandText('create_plan')).toBe('/create_plan ');
  });
});

describe('acpSessionRef', () => {
  it('returns null for a non-ACP session', () => {
    expect(
      acpSessionRef({
        sessionId: 's1',
        config: { agentType: 'Standard' },
        mode: 'Standard',
      } as never),
    ).toBeNull();
  });

  it('returns null when there is no session', () => {
    expect(acpSessionRef(null)).toBeNull();
    expect(acpSessionRef(undefined)).toBeNull();
  });

  it('derives the client id from an acp agent type', () => {
    const ref = acpSessionRef({
      sessionId: 's1',
      config: { agentType: 'acp:omp', workspacePath: '/ws' },
      workspacePath: '/ws',
      remoteConnectionId: 'conn-1',
      remoteSshHost: 'host-1',
    } as never);

    expect(ref).toEqual({
      sessionId: 's1',
      clientId: 'omp',
      workspacePath: '/ws',
      remoteConnectionId: 'conn-1',
      remoteSshHost: 'host-1',
    });
  });

  it('falls back to mode when config.agentType is not acp', () => {
    const ref = acpSessionRef({
      sessionId: 's2',
      config: {},
      mode: 'acp:claude-code',
    } as never);

    expect(ref?.clientId).toBe('claude-code');
    expect(ref?.sessionId).toBe('s2');
  });
});
