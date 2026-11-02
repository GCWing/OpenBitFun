// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClosedTabRecord } from '@/app/components/panels/content-canvas/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import { AuxPaneEmptyState } from './AuxPaneEmptyState';
const mock = vi.hoisted(() => ({
  workspace: { id: 'remote-project', name: 'Project Atlas', rootPath: '/srv/project', workspaceKind: 'remote', connectionId: 'ssh-1', connectionName: 'Build host' } as { id: string; name: string; rootPath: string; workspaceKind: string; connectionId?: string; connectionName?: string } | null,
  canvas: { closedTabs: [] as ClosedTabRecord[], scopeKey: 'session-a', reopenClosedTab: vi.fn() },
  expand: vi.fn(),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: mock.workspace, workspaceName: mock.workspace?.name ?? '' }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string, options?: { title?: string }) => options?.title ? `${key}:${options.title}` : key }) }));
vi.mock('@/app/components/panels/content-canvas', () => ({ useCanvasStore: (selector: (state: typeof mock.canvas) => unknown) => selector(mock.canvas) }));
vi.mock('./sessionPanelLayout', () => ({ expandSessionAuxPane: mock.expand }));
let host: HTMLDivElement, root: Root;
const render = async () => { await act(async () => root.render(<AuxPaneEmptyState workspacePath="/srv/project" sessionId="session-a" />)); };
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(button => button.textContent === name)!;
beforeEach(() => {
  vi.clearAllMocks(); resetDeviceSurfaceForTest();
  mock.workspace = { id: 'remote-project', name: 'Project Atlas', rootPath: '/srv/project', workspaceKind: 'remote', connectionId: 'ssh-1', connectionName: 'Build host' };
  mock.canvas.closedTabs = []; mock.canvas.scopeKey = 'session-a';
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); useNavSceneStore.getState().closeNavScene(); });
it('routes file browsing and terminal creation to the explicit workspace on the active peer', async () => {
  activateSurface('peer-host');
  const requested = vi.fn(); window.addEventListener('terminal-create-requested', requested);
  await render();
  expect(host.querySelector('[data-openbitfun-part="title"]')?.textContent).toBe('Project Atlas');
  expect(host.querySelector('[data-openbitfun-name="playing-cards-fan"]')).not.toBeNull();
  expect(host.textContent).not.toContain('Build host');
  expect(host.textContent).not.toContain('/srv/project');
  await act(async () => button('canvas.empty.browseFiles').click());
  expect(useNavSceneStore.getState().resourceWorkspace).toEqual({ surfaceId: 'peer-host', workspaceId: 'remote-project' });
  await act(async () => button('canvas.empty.newTerminal').click());
  expect(requested.mock.calls[0][0].detail).toEqual({ surfaceId: 'peer-host', resourceScope: { surfaceId: 'peer-host', workspaceId: 'remote-project', workspacePath: '/srv/project', remoteConnectionId: 'ssh-1' } });
  window.removeEventListener('terminal-create-requested', requested);
  expect(button('canvas.hidePanel')).toBeUndefined();
});
it.each(['missing', 'disconnected', 'other-workspace'] as const)('gates actions for a %s workspace without a local fallback', async state => {
  if (state === 'missing') mock.workspace = null;
  else if (state === 'disconnected') mock.workspace!.connectionId = undefined;
  else mock.workspace!.rootPath = '/another-project';
  await render();
  expect(button('canvas.empty.browseFiles').disabled).toBe(true);
  expect(button('canvas.empty.newTerminal').disabled).toBe(true);
  expect(host.textContent).toContain(state === 'disconnected' ? 'canvas.empty.workspaceUnavailable' : 'canvas.empty.selectWorkspace');
  expect(host.querySelector('[data-openbitfun-part="title"]')?.textContent).toBe(state === 'disconnected' ? 'Project Atlas' : 'canvas.empty.title');
});
it('reopens only content owned by this session, workspace and surface', async () => {
  mock.canvas.closedTabs = [{ tab: { title: 'Notes', content: { type: 'markdown-viewer', title: 'Notes', metadata: {
    resourceScope: { surfaceId: 'local', workspaceId: 'remote-project' },
  } } } } as ClosedTabRecord];
  await render();
  await act(async () => button('canvas.empty.reopen:Notes').click());
  expect(mock.canvas.reopenClosedTab).toHaveBeenCalledOnce();
  expect(mock.expand).toHaveBeenCalledOnce();
  mock.canvas.scopeKey = 'other-session';
  await render();
  expect(button('canvas.empty.reopen:Notes')).toBeUndefined();
  mock.canvas.scopeKey = 'session-a';
  await act(async () => activateSurface('new-peer'));
  expect(button('canvas.empty.reopen:Notes')).toBeUndefined();
});
