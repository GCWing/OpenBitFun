// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listSessions: vi.fn(),
  onEvent: vi.fn(() => () => {}),
  setTrackedSessions: vi.fn(),
  clearTrackedSessions: vi.fn(),
}));

vi.mock('@/tools/terminal/services/TerminalService', () => ({ getTerminalService: () => service }));
vi.mock('@/shared/services/createManualTerminalSession', () => ({ createManualTerminalSession: vi.fn() }));

import { useTerminalSessions } from './useTerminalSessions';

const scope = {
  surfaceId: 'peer-host',
  isCurrent: () => true,
  assertCurrent: () => {},
  key: (...parts: unknown[]) => parts.join(':'),
} as never;
const savedSessionIds = new Set<string>();

function Harness() {
  useTerminalSessions({
    workspaceId: 'workspace-a', workspacePath: '/a', isRemote: false, currentConnectionId: null,
    scope, savedSessionIds,
  });
  return null;
}

describe('useTerminalSessions', () => {
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tracks only the sessions this workspace shows and stops when it unmounts', async () => {
    service.listSessions.mockResolvedValue([
      { id: 'mine', workspaceId: 'workspace-a', name: 'A', cwd: '/a' },
      { id: 'other', workspaceId: 'workspace-b', name: 'B', cwd: '/b' },
    ]);
    await act(async () => root.render(<Harness />));

    expect(service.setTrackedSessions).toHaveBeenLastCalledWith(expect.anything(), ['mine']);
    const owner = service.setTrackedSessions.mock.calls.at(-1)?.[0];
    await act(async () => root.unmount());
    expect(service.clearTrackedSessions).toHaveBeenCalledWith(owner);
  });
});
