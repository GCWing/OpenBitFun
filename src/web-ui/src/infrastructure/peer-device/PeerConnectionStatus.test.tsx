// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerConnectionStatus } from './PeerConnectionStatus';
import { PeerDeviceContext, type PeerDeviceContextValue } from './peerDeviceContextState';

const t = (key: string, values?: { name?: string }) => (
  key === 'peerConnection.reconnecting' ? `Reconnecting to ${values?.name}` : key
);
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t }) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PeerConnectionStatus', () => {
  let container: HTMLDivElement;
  let root: Root;
  let peer: PeerDeviceContextValue;
  const render = async (value: PeerDeviceContextValue | null = peer) => {
    await act(async () => root.render(
      <PeerDeviceContext.Provider value={value}><PeerConnectionStatus /></PeerDeviceContext.Provider>,
    ));
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    peer = {
      peerMode: { active: true, deviceId: 'peer-a', deviceName: 'Studio' },
      attachments: [{ deviceId: 'peer-a', deviceName: 'Studio', health: 'degraded', capabilities: null }],
      currentPeerCapabilities: null,
      switchToLocal: vi.fn().mockResolvedValue('activated'),
      switchToDevice: vi.fn(),
      disconnectDevice: vi.fn(),
      disconnectAllDevices: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the current peer and a manual return action until recovery', async () => {
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('peerConnection.reconnectingShort');
    await act(async () => container.querySelector('button')!.click());
    expect(peer.switchToLocal).toHaveBeenCalledExactlyOnceWith('manual');
    expect(peer.disconnectDevice).not.toHaveBeenCalled();

    peer = { ...peer, attachments: [{ ...peer.attachments[0], health: 'ready' }] };
    await render();
    expect(container.textContent).toBe('');
  });

  it('shows that a reachable host is still starting its UI', async () => {
    peer = { ...peer, attachments: [{ ...peer.attachments[0], health: 'ready', hostStarting: true }] };
    await render();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('peerConnection.startingShort');
    expect(status?.getAttribute('data-peer-connection-state')).toBe('starting');

    peer = { ...peer, attachments: [{ ...peer.attachments[0], hostStarting: false }] };
    await render();
    expect(container.textContent).toBe('');
  });

  it('does not warn for a background peer or a local-only surface', async () => {
    await render({ ...peer, peerMode: { active: true, deviceId: 'peer-b', deviceName: 'Other' } });
    expect(container.textContent).toBe('');
    await render({ ...peer, peerMode: { active: false } });
    expect(container.textContent).toBe('');
    await render(null);
    expect(container.textContent).toBe('');
  });

  it('keeps a failed return action visible and re-enables the button for retry', async () => {
    peer.switchToLocal = vi.fn().mockRejectedValue(new Error('Local surface could not be restored'));
    await render();
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('Local surface could not be restored');
    expect(container.querySelector('button')!.disabled).toBe(false);
  });
});
