/**
 * Live MiniApp surfaces that the Agent may control.
 *
 * The registry is the only place that knows which mounted frame belongs to
 * which app. `MiniAppRunner` registers on mount and unregisters on unmount, so a
 * closed tab, a reload, or a transfer to a separate window removes the surface
 * instead of leaving a stale handle behind.
 */

import { MiniAppAgentBridge, type MiniAppAgentBridgeSurface } from './miniAppAgentBridge';
import { surfaceError } from './miniAppAgentProtocol';

export interface MiniAppAgentSurfaceRegistration extends MiniAppAgentBridgeSurface {
  strictRuntime: boolean;
  instanceId?: string;
  ready: boolean;
}

export interface MiniAppAgentSurfaceEntry extends MiniAppAgentSurfaceRegistration {
  bridge: MiniAppAgentBridge;
}

const surfaces = new Map<string, MiniAppAgentSurfaceEntry>();

const WAIT_POLL_MS = 50;

/** Register one mounted frame. Returns an idempotent unregister function. */
export function registerMiniAppAgentSurface(
  registration: MiniAppAgentSurfaceRegistration,
): () => void {
  const previous = surfaces.get(registration.appId);
  if (previous && previous.iframe !== registration.iframe) {
    // A new frame replaced the old one; its handles must not answer for it.
    previous.bridge.stop();
  }
  const entry: MiniAppAgentSurfaceEntry = {
    ...registration,
    bridge: previous && previous.iframe === registration.iframe ? previous.bridge : new MiniAppAgentBridge(registration),
  };
  entry.bridge.start();
  surfaces.set(registration.appId, entry);
  return () => {
    const current = surfaces.get(registration.appId);
    if (current !== entry) return;
    surfaces.delete(registration.appId);
    entry.bridge.stop();
  };
}

/** Mount-time readiness is separate from registration, so it can change freely. */
export function updateMiniAppAgentSurfaceStatus(
  appId: string,
  patch: { ready?: boolean; instanceId?: string },
): void {
  const entry = surfaces.get(appId);
  if (!entry) return;
  if (patch.ready !== undefined) entry.ready = patch.ready;
  if (patch.instanceId !== undefined) entry.instanceId = patch.instanceId;
}

export function getMiniAppAgentSurface(appId: string): MiniAppAgentSurfaceEntry | undefined {
  return surfaces.get(appId);
}

export function listMiniAppAgentSurfaces(): MiniAppAgentSurfaceEntry[] {
  return [...surfaces.values()];
}

/** Drop every surface; used when the surface host itself shuts down. */
export function releaseMiniAppAgentSurfaces(): void {
  for (const entry of surfaces.values()) entry.bridge.stop();
  surfaces.clear();
}

/** Wait for the frame the Agent asked to open. Never resolves to a guess. */
export async function waitForMiniAppAgentSurface(
  appId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MiniAppAgentSurfaceEntry> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (signal?.aborted) {
      throw surfaceError('SURFACE_UNAVAILABLE', 'The MiniApp device surface is no longer active.');
    }
    const entry = surfaces.get(appId);
    if (entry?.ready) return entry;
    if (Date.now() >= deadline) {
      throw surfaceError(
        'TIMEOUT',
        `The MiniApp '${appId}' surface did not become ready within ${timeoutMs}ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}
