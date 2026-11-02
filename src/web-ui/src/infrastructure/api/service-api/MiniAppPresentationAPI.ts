import { api } from './ApiClient';
import { getActiveSurfaceScope, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';

export type MiniAppViewKind = 'window' | 'tab';
export interface MiniAppView { viewId: string; kind: MiniAppViewKind }
export interface MiniAppInstance {
  instanceId: string;
  appId: string;
  workspacePath: string | null;
  primaryView: MiniAppView | null;
  pendingView: MiniAppView | null;
  contentCapabilities: string[];
}
export interface MiniAppInstanceSnapshot {
  protocolVersion: number;
  hostEpoch: string;
  revision: number;
  instances: MiniAppInstance[];
}
export interface MiniAppViewTicket { instance: MiniAppInstance; view: MiniAppView }

export function hasLocalMiniAppPresentation(): boolean {
  return isTauriRuntime() && getActiveSurfaceScope().surfaceId === LOCAL_SURFACE_ID;
}

async function invoke<T>(request: Record<string, unknown>): Promise<T> {
  if (!hasLocalMiniAppPresentation()) throw new Error('Independent MiniApp windows are unavailable on this device surface');
  const scope = getActiveSurfaceScope();
  const result = await api.invoke<T>('miniapp_presentation', { request });
  scope.assertCurrent('MiniApp presentation');
  return result;
}

export const miniAppPresentationAPI = {
  contentAction: (request: { instanceId: string; requestId: string; action: string; arguments: unknown }) =>
    invoke<unknown>({ operation: 'contentAction', request }),
  snapshot: () => invoke<MiniAppInstanceSnapshot>({ operation: 'snapshot' }),
  open: (appId: string, kind: MiniAppViewKind, workspacePath?: string | null, iconSvg?: string) =>
    invoke<MiniAppViewTicket>({ operation: 'open', appId, kind, workspacePath: workspacePath || null, iconSvg }),
  install: (appId: string, workspacePath?: string | null, iconSvg?: string) =>
    invoke<{ path: string }>({ operation: 'install', appId, workspacePath: workspacePath || null, iconSvg }),
  installation: (appId: string) => invoke<{ paths: string[] }>({ operation: 'installation', appId }),
  uninstall: (appId: string) => invoke<void>({ operation: 'uninstall', appId }),
  ready: (ticket: MiniAppViewTicket) => invoke<void>({ operation: 'ready', instanceId: ticket.instance.instanceId, viewId: ticket.view.viewId }),
  heartbeat: (ticket: MiniAppViewTicket) => invoke<MiniAppInstance>({ operation: 'heartbeat', instanceId: ticket.instance.instanceId, viewId: ticket.view.viewId }),
  detach: (ticket: MiniAppViewTicket) => invoke<MiniAppInstanceSnapshot | null>({ operation: 'detach', instanceId: ticket.instance.instanceId, viewId: ticket.view.viewId }),
  stop: (instanceId: string) => invoke<void>({ operation: 'stop', instanceId }),
};
