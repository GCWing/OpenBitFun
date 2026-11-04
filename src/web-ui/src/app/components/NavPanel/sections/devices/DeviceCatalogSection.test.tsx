// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/peer-device/useDeviceWorkspaceCatalog', () => ({
  useDeviceWorkspaceCatalog: () => ({
    status: 'ready', live: true, sessions: {},
    workspaces: [
      { id: 'assistant', name: 'Fu', rootPath: '/a', workspaceKind: 'assistant', tags: [], languages: [] },
      { id: 'project', name: 'OpenBitFun', rootPath: '/p', workspaceKind: 'normal', tags: [], languages: [] },
    ],
  }),
}));
vi.mock('./BackgroundSessionList', () => ({
  BackgroundSessionList: () => <div data-testid="session-list"><div data-testid="session-row" /></div>,
}));
const open = vi.hoisted(() => ({ action: vi.fn(async () => undefined), resources: vi.fn(async () => undefined) }));
vi.mock('./openOnDevice', () => ({
  createDeviceSession: vi.fn(async () => undefined),
  openDeviceAssistant: vi.fn(async () => undefined),
  openDeviceWorkspaceAction: open.action,
  openDeviceProjectResources: open.resources,
}));

import DeviceCatalogSection from './DeviceCatalogSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const slot = { surfaceId: 'peer', deviceId: 'peer', name: 'Win', isLocal: false, rendered: false, hostKind: 'desktop' as const, os: 'Windows', controllable: true };

describe('DeviceCatalogSection rows', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<DeviceCatalogSection slot={slot} />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('keeps a project row actions inside its header card, never next to session rows', () => {
    const project = host.querySelector('[data-workspace-id="project"]')!;
    const card = project.querySelector('.openbitfun-nav-panel__workspace-item-card')!;
    const actions = project.querySelector('.openbitfun-nav-panel__workspace-item-actions')!;
    expect(card.contains(actions)).toBe(true);
    expect(actions.closest('[data-testid="session-list"]')).toBeNull();
    expect([...actions.querySelectorAll('button')].map(button => button.getAttribute('data-testid'))).toEqual([
      'nav-device-workspace-menu-btn', 'nav-device-project-resources-btn', 'nav-device-new-session-btn',
    ]);
  });

  it('offers the live rows actions and runs them on the owning device', async () => {
    const project = host.querySelector('[data-workspace-id="project"]')!;
    await act(async () => { project.querySelector<HTMLButtonElement>('[data-testid="nav-device-workspace-menu-btn"]')!.click(); });
    expect(open.action).toHaveBeenCalledWith(null, slot, 'project', 'menu');
    const assistant = host.querySelector('[data-workspace-id="assistant"]')!;
    expect(assistant.querySelector('[data-testid="nav-device-workspace-menu-btn"]')).not.toBeNull();
    expect(assistant.querySelector('[data-testid="nav-device-assistant-history-btn"]')).not.toBeNull();
  });
});
