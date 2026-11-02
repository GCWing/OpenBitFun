/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { useMiniAppCreation } from './useMiniAppCreation';

const mocks = vi.hoisted(() => ({
  workspace: null as WorkspaceInfo | null,
  createSession: vi.fn(), openSession: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: mocks.workspace }) }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: {} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error, success: mocks.success }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: { createChatSession: mocks.createSession } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: mocks.openSession }));

let root: Root;
let container: HTMLDivElement;
let creation: ReturnType<typeof useMiniAppCreation>;
function Harness() { creation = useMiniAppCreation(); return null; }
const render = () => act(async () => { root.render(<Harness />); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  mocks.workspace = { id: 'workspace-1', rootPath: '/project', workspaceKind: WorkspaceKind.Normal } as WorkspaceInfo;
  mocks.createSession.mockReset().mockResolvedValue('creative-session');
  mocks.openSession.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  mocks.success.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  resetDeviceSurfaceForTest();
});

describe('MiniApp creation entry', () => {
  it('creates and opens a Creative session for the selected workspace', async () => {
    await render();
    await act(async () => { await creation.createMiniApp(); });
    expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: 'workspace-1', workspacePath: '/project' }, 'Creative');
    expect(mocks.openSession).toHaveBeenCalledWith('creative-session');
    expect(mocks.success).toHaveBeenCalledWith('creationMode.started');
    expect(creation.creating).toBe(false);
  });

  it.each(['missing', 'remote'] as const)('explains a %s workspace without creating a session', async kind => {
    mocks.workspace = kind === 'missing' ? null : { ...mocks.workspace!, workspaceKind: WorkspaceKind.Remote };
    await render();
    await act(async () => { await creation.createMiniApp(); });
    expect(mocks.error).toHaveBeenCalledWith(kind === 'missing' ? 'creationMode.noWorkspace' : 'creationMode.remoteUnsupported');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('does not open a late creation result on a different device surface', async () => {
    let finish!: (id: string) => void;
    mocks.createSession.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = creation.createMiniApp(); });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    await act(async () => { activateSurface('peer-host'); finish('old-session'); await pending; });
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('coalesces repeated clicks and allows retry after failure', async () => {
    mocks.createSession.mockRejectedValueOnce(new Error('Host unavailable'));
    await render();
    await act(async () => { await Promise.all([creation.createMiniApp(), creation.createMiniApp()]); });
    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith('creationMode.startFailed');
    expect(creation.creating).toBe(false);
    await act(async () => { await creation.createMiniApp(); });
    expect(mocks.openSession).toHaveBeenCalledWith('creative-session');
  });
});
