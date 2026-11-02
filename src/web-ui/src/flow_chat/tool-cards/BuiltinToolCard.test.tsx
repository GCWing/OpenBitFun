// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import type { PeerHostCapabilities } from '@/infrastructure/peer-device/PeerConnectionManager';
import { BuiltinToolCard } from './BuiltinToolCard';
import { getToolItemCardConfig } from './toolCardMetadata';

const state = vi.hoisted(() => ({
  peer: false,
  capabilities: null as Partial<PeerHostCapabilities> | null,
  sessions: new Map<string, Session>(),
  openExternal: vi.fn(),
  openPanel: vi.fn(),
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => state.peer
    ? { peerMode: { active: true }, currentPeerCapabilities: state.capabilities }
    : null,
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: state.sessions }),
  subscribe: () => () => {},
} }));
vi.mock('../services/sessionActivation', () => ({ openMainSession: vi.fn() }));
vi.mock('../services/btwSessionPane', () => ({ openBtwSessionInAuxPane: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: { openExternal: state.openExternal } }));
vi.mock('@/shared/utils/tabUtils', () => ({ createReviewPlatformTab: state.openPanel }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));

const url = 'https://github.com/GCWing/OpenBitFun/pull/3573';
const call: FlowToolItem = {
  id: 'review-call', type: 'tool', toolName: 'ReviewPlatform', status: 'completed', timestamp: 1,
  toolCall: { id: 'review-call', input: { action: 'get_pull_request', repository_path: '/workspace' } },
  toolResult: { success: true, result: { result: { number: 3573, webUrl: url } } },
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state.peer = false;
  state.capabilities = null;
  state.sessions = new Map([['current', {
    sessionId: 'current', title: 'Session', sessionKind: 'normal', status: 'idle', config: {}, dialogTurns: [],
    workspaceId: 'workspace-1', createdAt: 1, lastActiveAt: 1, error: null,
  }]]);
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.openPanel.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render() {
  act(() => root.render(<BuiltinToolCard toolItem={call} config={getToolItemCardConfig(call)} sessionId="current" />));
}
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe('ReviewPlatform tool card entry points', () => {
  it('disables the CLI panel action while keeping the PR URL usable in the system browser', async () => {
    state.peer = true;
    state.capabilities = { hostKind: 'cli' };
    render();
    expect(button('toolCards.builtin.links.openReviewPanel')?.disabled).toBe(true);
    act(() => host.querySelector<HTMLElement>('[data-openbitfun-part="surface"]')?.click());
    expect(host.textContent).toContain('common:reviewPlatform.messages.hostUnsupported');
    await act(async () => button('toolCards.builtin.links.openReview')?.click());
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    expect(state.openPanel).not.toHaveBeenCalled();
  });

  it('keeps the local panel action and updates it when peer capabilities change', async () => {
    render();
    expect(button('toolCards.builtin.links.openReviewPanel')?.disabled).toBe(false);
    await act(async () => button('toolCards.builtin.links.openReviewPanel')?.click());
    expect(state.openPanel).toHaveBeenCalledWith('workspace-1', '/workspace');
    state.peer = true;
    state.capabilities = { hostKind: 'cli' };
    render();
    expect(button('toolCards.builtin.links.openReviewPanel')?.disabled).toBe(true);
    state.capabilities = { hostKind: 'desktop' };
    render();
    expect(button('toolCards.builtin.links.openReviewPanel')?.disabled).toBe(false);
  });
});
