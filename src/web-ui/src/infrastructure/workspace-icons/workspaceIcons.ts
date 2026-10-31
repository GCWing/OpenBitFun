import { api } from '@/infrastructure/api/service-api/ApiClient';
import { getActiveSurfaceScope, isLocalSurface, onSurfaceActivated, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { peerConnectionManager } from '@/infrastructure/peer-device/PeerConnectionManager';
import { isTauriRuntime } from '@/infrastructure/runtime';

export const iconColors = ['default', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'] as const;
export const workspaceIconGlyphs = ['default', 'code', 'learning', 'design', 'documents', 'research', 'web', 'mobile', 'games', 'data', 'business', 'tools', 'travel', 'food', 'fitness', 'music', 'reading', 'home', 'finance', 'photography', 'pets', 'nature', 'shopping', 'movies'] as const;
export interface WorkspaceIconRecord { version: 1; revision: number; mode: 'default' | 'image'; color: string; glyph?: string; assetId?: string; darkAssetId?: string }
export interface WorkspaceIconSnapshot { workspaceId: string; icon: WorkspaceIconRecord; imageData?: string; imageUnavailable: boolean; darkImageData?: string; darkImageUnavailable?: boolean; supportsThemedImages?: boolean; supportedGlyphs?: string[] }
export type WorkspaceIconInput = { kind: 'reset' } | { kind: 'default'; color: string; glyph?: string } | { kind: 'image'; color: string; dataBase64?: string; darkDataBase64?: string };
export interface IconState { snapshot?: WorkspaceIconSnapshot; error?: string; loading?: boolean; unsupported?: boolean }
const emptyState: IconState = {};
const cache = new Map<string, IconState>();
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let generation = 0;
const notify = () => { for (const listener of listeners) listener(); };

export function supportsWorkspaceIcons(scope = getActiveSurfaceScope()): boolean {
  return isLocalSurface(scope.surfaceId) ? isTauriRuntime()
    : peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.workspaceIconV1 === true;
}
const presetColors: Record<string, string> = {
  blue: 'var(--openbitfun-color-identity-project-blue)', cyan: 'var(--openbitfun-color-identity-project-cyan)',
  green: 'var(--openbitfun-color-identity-project-green)', yellow: 'var(--openbitfun-color-identity-project-yellow)',
  orange: 'var(--openbitfun-color-identity-project-orange)', red: 'var(--openbitfun-color-identity-project-red)',
  purple: 'var(--openbitfun-color-identity-project-purple)', pink: 'var(--openbitfun-color-identity-project-pink)',
};
export function iconColorStyle(color: string): string | undefined {
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  if (Object.prototype.hasOwnProperty.call(presetColors, color)) return presetColors[color];
  return undefined;
}
export function invalidateWorkspaceIcons(): void {
  generation += 1;
  cache.clear();
  notify();
}
export function getWorkspaceIconState(workspaceId: string): IconState {
  return cache.get(getActiveSurfaceScope().key(workspaceId)) ?? emptyState;
}
export function subscribeWorkspaceIcons(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) {
    let unlisten = api.listen('workspace-catalog-changed', invalidateWorkspaceIcons);
    const unsurface = onSurfaceActivated(() => {
      unlisten();
      unlisten = api.listen('workspace-catalog-changed', invalidateWorkspaceIcons);
      invalidateWorkspaceIcons();
    });
    let peerState = '';
    const unpeer = peerConnectionManager.subscribe(() => {
      const peer = peerConnectionManager.get(getActiveSurfaceScope().surfaceId)?.getState();
      const next = JSON.stringify([peer?.health, peer?.capabilities.workspaceIconV1]);
      if (next !== peerState) { peerState = next; invalidateWorkspaceIcons(); }
    });
    window.addEventListener('focus', invalidateWorkspaceIcons);
    window.addEventListener('online', invalidateWorkspaceIcons);
    stop = () => {
      unlisten(); unsurface(); unpeer();
      window.removeEventListener('focus', invalidateWorkspaceIcons);
      window.removeEventListener('online', invalidateWorkspaceIcons);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = undefined; generation += 1; cache.clear(); }
  };
}

function validateSnapshot(value: WorkspaceIconSnapshot): WorkspaceIconSnapshot {
  if (!value || !value.workspaceId || value.icon?.version !== 1
    || !Number.isSafeInteger(value.icon.revision) || value.icon.revision < 0
    || !['default', 'image'].includes(value.icon.mode)
    || (value.icon.color !== 'default' && !iconColorStyle(value.icon.color))
    || (value.icon.glyph !== undefined && typeof value.icon.glyph !== 'string')
    || (value.supportedGlyphs !== undefined && (!Array.isArray(value.supportedGlyphs) || !value.supportedGlyphs.every(glyph => typeof glyph === 'string')))
    || (value.supportsThemedImages !== undefined && typeof value.supportsThemedImages !== 'boolean')
    || (value.darkImageUnavailable !== undefined && typeof value.darkImageUnavailable !== 'boolean')
    || [value.imageData, value.darkImageData].some(image => image !== undefined
      && (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 720_000))) {
    throw new Error('Unsupported workspace icon response');
  }
  return value;
}

export async function loadWorkspaceIcon(workspaceId: string): Promise<void> {
  const scope = getActiveSurfaceScope();
  const key = scope.key(workspaceId);
  if (cache.has(key)) return;
  if (!supportsWorkspaceIcons(scope)) { cache.set(key, { unsupported: true }); notify(); return; }
  const ticket = generation;
  cache.set(key, { loading: true }); notify();
  try {
    const snapshot = validateSnapshot(await api.invoke<WorkspaceIconSnapshot>('get_workspace_icon', { request: { workspaceId } }));
    scope.assertCurrent('read workspace icon');
    if (ticket === generation) cache.set(key, { snapshot });
  } catch (error) {
    if (scope.isCurrent() && ticket === generation) cache.set(key, { error: String(error) });
  } finally { if (scope.isCurrent() && ticket === generation) notify(); }
}

export async function saveWorkspaceIcon(scope: SurfaceScope, workspaceId: string, revision: number, requestId: string, icon: WorkspaceIconInput): Promise<WorkspaceIconSnapshot> {
  scope.assertCurrent('save workspace icon');
  if (!supportsWorkspaceIcons(scope)) throw new Error('This host does not support workspace icons');
  if ((icon.kind === 'default' && icon.glyph !== undefined) || (icon.kind === 'image' && icon.darkDataBase64 !== undefined)) {
    // Re-negotiate before writing: the host may have changed version since the editor opened.
    const current = validateSnapshot(await api.invoke<WorkspaceIconSnapshot>('get_workspace_icon', { request: { workspaceId } }));
    scope.assertCurrent('edit workspace icon variants');
    if (icon.kind === 'default' && !current.supportedGlyphs?.includes(icon.glyph!)) throw new Error('This host does not support the selected workspace icon glyph');
    if (icon.kind === 'image' && current.supportsThemedImages !== true) throw new Error('This host does not support separate light and dark workspace icons');
  }
  const ticket = generation;
  const snapshot = validateSnapshot(await api.invoke<WorkspaceIconSnapshot>('set_workspace_icon', {
    request: { workspaceId, expectedRevision: revision, requestId, icon },
  }));
  scope.assertCurrent('save workspace icon');
  const changedWhileSaving = ticket !== generation;
  invalidateWorkspaceIcons();
  // Another controller's newer revision may already have arrived while this response
  // was in flight. Let subscribers re-read the authority after any invalidation.
  if (!changedWhileSaving) {
    cache.set(scope.key(workspaceId), { snapshot });
    notify();
  }
  return snapshot;
}
