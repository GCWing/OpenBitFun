/**
 * Transport adapter for the host-driven MiniApp surface runtime.
 *
 * The native side asks this window to open, inspect, or act on a MiniApp frame
 * and waits for one correlated result. UI components must not call these Tauri
 * commands directly; the MiniApp surface runtime goes through this adapter.
 */

import { api } from './ApiClient';

/** Event emitted by the native host for every surface request. */
export const MINIAPP_AGENT_SURFACE_REQUEST_EVENT = 'agentic://miniapp-web-request';

export interface MiniAppAgentSurfaceRequest {
  requestId: string;
  expiresAt?: number;
  action: 'open' | 'execute';
  appId?: string;
  name?: string;
  strictRuntime?: boolean;
  command?: {
    appId: string;
    instanceId?: string;
    method: string;
    params?: Record<string, unknown> | null;
  };
}

export interface MiniAppAgentSurfaceReport {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// A device switch or StrictMode remount can enqueue detach and attach together.
// Preserve their order so a late detach cannot retire the newly active surface.
let readinessUpdate: Promise<void> = Promise.resolve();

export const miniAppAgentSurfaceAPI = {
  /** Announce whether this window can answer surface requests right now. */
  markReady: (ready: boolean): Promise<void> => {
    readinessUpdate = readinessUpdate.catch(() => undefined).then(() =>
      api.invoke<void>('mark_miniapp_web_surface_ready', { request: { ready } }));
    return readinessUpdate;
  },

  /** Return one result to the waiting host call. */
  reportResult: (report: MiniAppAgentSurfaceReport) =>
    api.invoke<void>('report_miniapp_web_result', { request: report }),

  listenRequests: (handler: (request: MiniAppAgentSurfaceRequest) => void) =>
    api.listen<MiniAppAgentSurfaceRequest>(MINIAPP_AGENT_SURFACE_REQUEST_EVENT, handler),
};
