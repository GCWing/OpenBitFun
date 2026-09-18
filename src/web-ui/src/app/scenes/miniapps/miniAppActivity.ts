import type { SceneTab, SceneTabId } from '@/app/components/SceneBar/types';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';

const MINIAPP_SCENE_PREFIX = 'miniapp:';

export interface MiniAppActivity {
  app: MiniAppMeta;
  /** The installed app has an open Runner scene mounted. */
  runnerMounted: boolean;
  /** The app owns a live background JavaScript worker. */
  workerRunning: boolean;
}

export interface StopMiniAppActivityPorts {
  stopWorker: (appId: string) => Promise<void>;
  markWorkerStopped: (appId: string) => void;
  closeScene: (sceneId: SceneTabId) => void | Promise<void>;
}

export function getMiniAppSceneId(appId: string): SceneTabId {
  return `${MINIAPP_SCENE_PREFIX}${appId}`;
}

export function getMiniAppIdFromSceneId(sceneId: SceneTabId): string | null {
  if (!sceneId.startsWith(MINIAPP_SCENE_PREFIX)) return null;
  const appId = sceneId.slice(MINIAPP_SCENE_PREFIX.length);
  return appId || null;
}

/**
 * Projects the two independent ways a MiniApp can be active for the user:
 * a mounted Runner scene and a live background worker. Scene order is preserved,
 * with worker-only apps appended in the order reported by the runtime.
 */
export function projectMiniAppActivity(
  apps: MiniAppMeta[],
  mountedScenes: SceneTab[],
  runningWorkerIds: string[],
): MiniAppActivity[] {
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const activities = new Map<string, MiniAppActivity>();

  const record = (appId: string, source: 'scene' | 'worker') => {
    const app = appsById.get(appId);
    if (!app) return;

    const current = activities.get(appId) ?? {
      app,
      runnerMounted: false,
      workerRunning: false,
    };
    activities.set(appId, {
      ...current,
      runnerMounted: current.runnerMounted || source === 'scene',
      workerRunning: current.workerRunning || source === 'worker',
    });
  };

  for (const scene of mountedScenes) {
    const appId = getMiniAppIdFromSceneId(scene.id);
    if (appId) record(appId, 'scene');
  }
  for (const appId of runningWorkerIds) {
    record(appId, 'worker');
  }

  return Array.from(activities.values());
}

/**
 * Mounted apps use the scene's shared shutdown gate. Worker-only apps still
 * stop through the runtime without requiring a view to be opened first.
 */
export async function stopMiniAppActivity(
  activity: MiniAppActivity,
  ports: StopMiniAppActivityPorts,
): Promise<void> {
  const appId = activity.app.id;
  if (activity.runnerMounted) {
    await ports.closeScene(getMiniAppSceneId(appId));
    return;
  }
  if (activity.workerRunning) {
    await ports.stopWorker(appId);
    ports.markWorkerStopped(appId);
  }
}
