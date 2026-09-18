import { getActiveSurfaceScope, isSurfaceChangedError, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useConversationDockStore } from '@/app/stores/conversationDockStore';
import { createLogger } from '@/shared/utils/logger';
import { useMiniAppStore } from './miniAppStore';
import { pickLocalizedString } from './utils/pickLocalizedString';

const log = createLogger('MiniAppLifecycle');
const closing = new Map<string, { scope: SurfaceScope; request: Promise<void> }>();
const operations = new Map<string, Set<Promise<void>>>();
const streams = new Map<string, Set<string>>();

export function isMiniAppClosing(appId: string, scope = getActiveSurfaceScope()): boolean {
  return closing.get(scope.key(appId))?.scope.epoch === scope.epoch;
}

/** Drain already accepted start requests before stopping their worker/Agent. */
export function beginMiniAppOperation(appId: string, scope: SurfaceScope): () => void {
  scope.assertCurrent('start MiniApp operation');
  if (isMiniAppClosing(appId, scope)) throw new Error('MiniApp is closing');
  const key = scope.key(appId);
  const pending = operations.get(key) ?? new Set<Promise<void>>();
  let finish!: () => void;
  const operation = new Promise<void>(resolve => { finish = resolve; });
  pending.add(operation);
  operations.set(key, pending);
  return () => {
    finish();
    pending.delete(operation);
    if (!pending.size && operations.get(key) === pending) operations.delete(key);
  };
}

export function trackMiniAppStream(appId: string, streamId: string, scope: SurfaceScope, active: boolean): void {
  const key = scope.key(appId);
  const current = streams.get(key) ?? new Set<string>();
  if (active) current.add(streamId);
  else current.delete(streamId);
  if (current.size) streams.set(key, current);
  else streams.delete(key);
}

/** Explicit tab closure only. Unmount, refresh and device switches never call this. */
export function requestMiniAppClose(appId: string, closeView: () => void | Promise<void>): Promise<void> {
  const scope = getActiveSurfaceScope();
  const key = scope.key(appId);
  const existing = closing.get(key);
  if (existing?.scope.epoch === scope.epoch) return existing.request;
  const app = useMiniAppStore.getState().apps.find(candidate => candidate.id === appId);
  const request = Promise.resolve().then(async () => {
    await Promise.all(operations.get(key) ?? []);
    scope.assertCurrent('close MiniApp');
    if (!app) streams.delete(key); // Authoritative deletion has already retired the app.
    for (const streamId of streams.get(key) ?? []) {
      await miniAppAPI.aiCancel(appId, streamId);
      scope.assertCurrent('cancel MiniApp stream');
      trackMiniAppStream(appId, streamId, scope, false);
    }
    if (app?.permissions?.agent?.enabled) {
      await miniAppAPI.agentCancelStaleRuns(appId);
      scope.assertCurrent('stop MiniApp Agent');
    }
    if ((app && app.permissions?.node?.enabled !== false) || useMiniAppStore.getState().runningWorkerIds.includes(appId)) {
      await miniAppAPI.workerStop(appId);
      scope.assertCurrent('stop MiniApp worker');
      useMiniAppStore.getState().markWorkerStopped(appId);
    }
    await closeView();
    scope.assertCurrent('close MiniApp view');
    const claim = useMiniAppStore.getState().composerClaims[appId];
    if (claim?.surfaceId === scope.surfaceId) useMiniAppStore.getState().releaseComposer(appId, claim.token);
    useConversationDockStore.getState().closeMiniApp(scope.surfaceId, appId);
  }).catch(async error => {
    if (isSurfaceChangedError(error) || !scope.isCurrent()) return;
    log.error('Failed to close MiniApp', { appId, error });
    const { i18nService } = await import('@/infrastructure/i18n');
    const { notificationService } = await import('@/shared/notification-system');
    await i18nService.loadNamespace('scenes/miniapp');
    if (!scope.isCurrent()) return;
    const t = i18nService.getI18nInstance().getFixedT(null, 'scenes/miniapp');
    notificationService.error(t('stopFailed', {
      name: app ? pickLocalizedString(app, i18nService.getCurrentLocale(), 'name') : appId,
      error: String(error instanceof Error ? error.message : error),
    }));
  }).finally(() => { if (closing.get(key)?.request === request) closing.delete(key); });
  closing.set(key, { scope, request });
  return request;
}
