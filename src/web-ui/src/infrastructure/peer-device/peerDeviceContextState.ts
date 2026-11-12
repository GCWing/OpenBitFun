import { createContext, useContext } from 'react';
import type {
  PeerConnectionHealth,
  PeerHostCapabilities,
} from './PeerConnectionManager';

/**
 * The device surface currently rendered by this window.
 *
 * Exactly one device is rendered at a time; every attached device keeps
 * executing regardless of which one that is.
 */
export type PeerModeState =
  | { active: false }
  | { active: true; deviceId: string; deviceName: string };

/** A peer whose control link is kept alive, rendered or not. */
export interface PeerAttachmentState {
  deviceId: string;
  deviceName: string;
  health: PeerConnectionHealth;
  /** The host's control plane answers but its product UI is still starting. */
  hostStarting?: boolean;
  /**
   * Host capabilities probed via `peer_mode_ping`. Null when the host has not
   * answered yet; consumers must fall back to a safe default (unsupported).
   */
  capabilities: PeerHostCapabilities | null;
}

/** A newer request may intentionally supersede an earlier rapid switch. */
export type SurfaceSwitchOutcome = 'activated' | 'superseded';

export interface PeerDeviceContextValue {
  /** Rendered surface. `active: false` means this machine. */
  peerMode: PeerModeState;
  /**
   * Peers this controller holds a live control link to, including the rendered
   * one. Attachments survive UI switches so their agents keep running and keep
   * reporting progress.
   */
  attachments: PeerAttachmentState[];
  /**
   * Capabilities of the currently rendered peer host, or null when rendering
   * this machine or the host has not answered `peer_mode_ping` yet. Consumers
   * gate peer-specific UI (e.g. Terminal Interrupt, tool catalog) on this
   * instead of guessing from surface state.
   */
  currentPeerCapabilities: PeerHostCapabilities | null;
  /** Render another device, attaching it first when needed. */
  switchToDevice: (deviceId: string, deviceName: string) => Promise<SurfaceSwitchOutcome>;
  /** Render this machine again. Peer attachments are left running. */
  switchToLocal: (reason?: string) => Promise<SurfaceSwitchOutcome>;
  /** Drop the control link to a peer, switching to local when it is rendered. */
  disconnectDevice: (deviceId: string, reason?: string) => Promise<void>;
  /** Drop every control link. Used on logout / account change. */
  disconnectAllDevices: (reason?: string) => Promise<void>;
}

export const PeerDeviceContext = createContext<PeerDeviceContextValue | null>(null);

export function usePeerDeviceMode(): PeerDeviceContextValue {
  const context = useContext(PeerDeviceContext);
  if (!context) {
    throw new Error('usePeerDeviceMode must be used within PeerDeviceProvider');
  }
  return context;
}

export function usePeerDeviceModeOptional(): PeerDeviceContextValue | null {
  return useContext(PeerDeviceContext);
}
