// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en-US/flow-chat.json';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { PageManageDisplay } from './PageManageToolDisplay';
import { PagePublishDisplay } from './PagePublishToolDisplay';
import { PageDeployDisplay } from './PageDeployToolDisplay';
import { getToolItemCardConfig } from './toolCardMetadata';
import type { FlowToolItem } from '../types/flow-chat';

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(), openExternal: vi.fn(), list: vi.fn(), error: vi.fn(),
  sessions: new Map<string, { parentSessionId?: string; config: { dispatchJobId?: string } }>(),
  listeners: new Set<() => void>(),
  peerActive: false,
  hostKind: null as 'cli' | 'desktop' | null,
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({ peerMode: { active: mocks.peerActive }, currentPeerCapabilities: { hostKind: mocks.hostKind } }),
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: mocks.sessions }),
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
} }));
vi.mock('@/infrastructure/api/service-api/PageAPI', () => ({ pageAPI: { createOpenLink: mocks.openLink, listPages: mocks.list } }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: { openExternal: mocks.openExternal } }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => String(key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en) ?? key),
}) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, params: Record<string, unknown> = {}) => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
    return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ''));
  },
  formatDate: (value: number) => `date:${value}`,
  formatNumber: (value: number) => String(value),
}) }));

let container: HTMLDivElement;
let root: Root;
function render(action: string, result: Record<string, unknown>, success = true, Card = PageManageDisplay, sessionId?: string) {
  const toolItem: FlowToolItem = {
    id: 'page-manage', type: 'tool', toolName: 'PageManage', timestamp: 0, status: 'completed',
    toolCall: { id: 'page-manage', input: { action, slug: 'demo', version_id: 'v1' } },
    toolResult: { success, result, error: success ? undefined : 'Permission denied' },
  };
  act(() => root.render(<Card toolItem={toolItem} config={getToolItemCardConfig(toolItem)} sessionId={sessionId} />));
}
function expand() {
  act(() => container.querySelector<HTMLElement>('[data-openbitfun-part="surface"]')!.click());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  mocks.sessions.clear();
  mocks.peerActive = false;
  mocks.hostKind = null;
  activateSurface('local');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

describe.each([
  ['PageManage', PageManageDisplay], ['PagePublish', PagePublishDisplay], ['PageDeploy', PageDeployDisplay],
] as const)('%s account link ownership', (_name, Card) => {
  const result = { slug: 'demo', generation: 'generation-a', version_id: 'v1', deployed: true, url: 'https://relay.example/p/demo' };
  const button = () => container.querySelector<HTMLButtonElement>('[aria-label="Open production URL"]')!;

  it('opens a normal session result with the recorded identity', async () => {
    mocks.sessions.set('normal', { config: {} });
    mocks.openLink.mockResolvedValue({ open_url: 'https://relay.example/access' });
    render('deploy', result, true, Card, 'normal');
    await act(async () => { button().click(); });
    expect(mocks.openLink).toHaveBeenCalledWith('demo', 'generation-a', undefined);
    expect(mocks.openExternal).toHaveBeenCalledWith('https://relay.example/access');
  });

  it('never asks the controller for access to a dispatched task or its child', async () => {
    mocks.sessions.set('dispatch', { config: { dispatchJobId: 'target-job' } });
    mocks.sessions.set('child', { parentSessionId: 'dispatch', config: {} });
    for (const sessionId of ['dispatch', 'child']) {
      render('deploy', result, true, Card, sessionId);
      expect(button().disabled).toBe(true);
      expect(button().title).toContain('device that ran the task');
      await act(async () => { button().click(); });
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.openLink).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('waits for session ownership to hydrate and reacts to removal', () => {
    render('deploy', result, true, Card, 'normal');
    expect(button().disabled).toBe(true);
    act(() => {
      mocks.sessions.set('normal', { config: {} });
      mocks.listeners.forEach(listener => listener());
    });
    expect(button().disabled).toBe(false);
    act(() => {
      mocks.sessions.delete('normal');
      mocks.listeners.forEach(listener => listener());
    });
    expect(button().disabled).toBe(true);
  });

  it('gates CLI and unknown peers while retaining the Desktop peer path', async () => {
    mocks.peerActive = true;
    for (const hostKind of ['cli', null] as const) {
      mocks.hostKind = hostKind;
      render('deploy', result, true, Card);
      expect(button().disabled).toBe(true);
      expect(button().title).toContain('does not support opening Pages');
      await act(async () => { button().click(); });
    }
    expect(mocks.openLink).not.toHaveBeenCalled();
    mocks.hostKind = 'desktop';
    mocks.openLink.mockResolvedValue({ open_url: 'https://relay.example/peer-access' });
    render('deploy', result, true, Card);
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://relay.example/peer-access');
  });

  it('abandons an old-result lookup after switching devices', async () => {
    let finish!: (value: { slug: string; generation: string }[]) => void;
    mocks.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render('deploy', { ...result, generation: undefined }, true, Card);
    await act(async () => { button().click(); });
    act(() => activateSurface('another-peer'));
    await act(async () => { finish([{ slug: 'demo', generation: 'other-device' }]); });
    expect(mocks.openLink).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
  });

  it('does not open a completed access request after switching devices', async () => {
    let finish!: (value: { open_url: string }) => void;
    mocks.openLink.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render('deploy', result, true, Card);
    await act(async () => { button().click(); });
    act(() => activateSurface('another-peer'));
    await act(async () => { finish({ open_url: 'https://relay.example/stale' }); });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PageManage result card', () => {
  it('shows names, URLs, access and localized update times in the page list', () => {
    render('list', { pages: [{ name: 'Release notes', slug: 'release', url: 'https://relay.example/p/release', visibility: 'private', updated_at: 123 }] });
    expect(container.textContent).toContain('1 items');
    expand();
    expect(container.textContent).toContain('Release notes');
    expect(container.textContent).toContain('https://relay.example/p/release');
    expect(container.textContent).toContain('Owner only');
    expect(container.textContent).toContain('date:123000');
  });

  it('distinguishes a known empty list from missing results and failed requests', () => {
    render('list', { pages: [] });
    expect(container.textContent).toContain('0 items');
    expand();
    expect(container.textContent).toContain('No Pages or versions found');
    render('list', {});
    expect(container.textContent).not.toContain('0 items');
    render('list', { pages: [] }, false);
    expect(container.textContent).not.toContain('0 items');
    expect(container.querySelector('[data-status="error"]')).not.toBeNull();
  });

  it('keeps a saved update distinct from a deployed version', () => {
    render('update', { slug: 'demo', version_id: 'v2', deployed: false, preview_url: '/preview/v2' });
    expect(container.textContent).toContain('Update Page');
    expect(container.textContent).toContain('Create page preview');
    expect(container.textContent).not.toContain('Page is live');
    render('deploy', { slug: 'demo', version_id: 'v2', deployed: true, url: '/p/demo' });
    expect(container.textContent).toContain('Page is live');
  });

  it('opens restricted pages through the scoped access API using the recorded generation', async () => {
    mocks.openLink.mockResolvedValue({ open_url: 'https://relay.example/access-handoff' });
    render('permissions', { slug: 'demo', generation: 'generation-a', visibility: 'private', published: true, url: 'https://relay.example/p/demo' });
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open production URL"]');
    expect(open).not.toBeNull();
    await act(async () => { open!.click(); });
    expect(mocks.openLink).toHaveBeenCalledWith('demo', 'generation-a', undefined);
    expect(mocks.openExternal).toHaveBeenCalledWith('https://relay.example/access-handoff');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('does not open a stale peer result after the active device changes', async () => {
    let finish!: (value: { open_url: string }) => void;
    mocks.openLink.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render('deploy', { slug: 'demo', generation: 'generation-a', deployed: true, url: '/p/demo' });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Open production URL"]')!.click(); });
    act(() => activateSurface('another-peer'));
    await act(async () => { finish({ open_url: 'https://relay.example/stale' }); });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Open production URL"]')!.disabled).toBe(true);
  });

  it('shows operation failure and never provides open controls for deletion', () => {
    render('delete', { deleted: false }, false);
    expand();
    expect(container.textContent).toContain('Permission denied');
    expect(container.querySelector('[aria-label="Open production URL"]')).toBeNull();
  });
});
