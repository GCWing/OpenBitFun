// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpSessionNotifications } from './AcpSessionNotifications';
import { NotificationContainer } from '@/shared/notification-system/components/NotificationContainer';
import { notificationStore } from '@/shared/notification-system/store/NotificationStore';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { emitAcpSessionStartup, type AcpSessionStartupDetail } from '@/flow_chat/services/acpSessionStartup';
import { openMainSession } from '@/flow_chat/services/sessionActivation';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/i18n/core/I18nService', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: vi.fn(async () => {}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ACP session startup feedback', () => {
  let root: Root;
  let container: HTMLDivElement;
  const start = (overrides: Partial<AcpSessionStartupDetail> = {}): AcpSessionStartupDetail => ({
    phase: 'start', action: 'create', clientId: 'codex', requestId: 'create-1',
    scope: getActiveSurfaceScope(), workspaceId: 'workspace-1', ...overrides,
  });

  beforeEach(() => {
    resetDeviceSurfaceForTest();
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<><AcpSessionNotifications /><NotificationContainer /></>));
  });

  afterEach(() => {
    act(() => root.unmount());
    notificationStore.clearHistory();
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders a persistent spinner before a session exists, then clears it on success', () => {
    const detail = start();
    act(() => emitAcpSessionStartup(detail));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('nav.workspaces.startingAcpSession');
    expect(document.querySelector('[data-openbitfun-component="spinner"]')).not.toBeNull();
    expect(notificationStore.getState().activeNotifications[0]).toMatchObject({ duration: 0, closable: false, variant: 'toast' });
    act(() => vi.advanceTimersByTime(60_000));
    expect(notificationStore.getState().activeNotifications).toHaveLength(1);
    act(() => emitAcpSessionStartup({ ...detail, phase: 'finish', succeeded: true }));
    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelector('.notification-item')).toBeNull();
  });

  it('shows the actual failure and retries on the same workspace before opening the session', async () => {
    const retry = vi.fn(async () => 'new-session');
    const detail = start({ retry });
    act(() => emitAcpSessionStartup(detail));
    act(() => emitAcpSessionStartup({ ...detail, phase: 'finish', succeeded: false, error: 'Agent initialize timed out' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Agent initialize timed out');
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'nav.workspaces.retryAcpSession');
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(openMainSession).toHaveBeenCalledWith('new-session', { workspaceId: 'workspace-1' });
  });

  it('keeps simultaneous requests for the same agent independent', () => {
    const first = start();
    const second = start({ requestId: 'create-2', workspaceId: 'workspace-2' });
    act(() => { emitAcpSessionStartup(first); emitAcpSessionStartup(second); });
    expect(notificationStore.getState().activeNotifications).toHaveLength(2);
    act(() => emitAcpSessionStartup({ ...first, phase: 'finish', succeeded: true }));
    expect(notificationStore.getState().activeNotifications).toHaveLength(1);
    expect(notificationStore.getState().activeNotifications[0].metadata?.requestId).toBe('create-2');
  });

  it('clears the old device feedback and ignores its late failure', () => {
    const detail = start();
    act(() => emitAcpSessionStartup(detail));
    act(() => activateSurface('peer-b'));
    act(() => emitAcpSessionStartup({ ...detail, phase: 'finish', succeeded: false, error: 'Old failure' }));
    expect(notificationStore.getState().activeNotifications).toHaveLength(0);
  });

  it('does not open a retry result after switching devices', async () => {
    let resolve!: (value: string) => void;
    const retry = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const detail = start({ retry });
    act(() => emitAcpSessionStartup({ ...detail, phase: 'finish', succeeded: false }));
    act(() => [...document.querySelectorAll('button')].find(item => item.textContent === 'nav.workspaces.retryAcpSession')!.click());
    await act(async () => { activateSurface('peer-b'); resolve('old-session'); });
    expect(openMainSession).not.toHaveBeenCalled();
  });

  it('labels the protocol session initialization separately', () => {
    act(() => emitAcpSessionStartup(start({ action: 'restore' })));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('nav.workspaces.initializingAcpSession');
  });

  it('dismisses an abandoned view without reporting an agent failure', () => {
    const detail = start({ action: 'restore' });
    act(() => emitAcpSessionStartup(detail));
    act(() => emitAcpSessionStartup({ ...detail, phase: 'finish', cancelled: true }));
    expect(notificationStore.getState().activeNotifications).toHaveLength(0);
  });
});
