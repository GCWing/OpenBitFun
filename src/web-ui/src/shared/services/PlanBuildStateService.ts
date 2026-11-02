/** Shared, turn-owned plan execution state for chat cards and the editor. */
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { getActiveSurfaceId, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';
import { observeSurfaceEvents } from '@/infrastructure/peer-device/deviceSurfaceRouting';

export type PlanBuildStatus = 'build' | 'building' | 'built';
export type BuildStateCallback = (status: PlanBuildStatus) => void;

export interface PlanFileRef {
  planFilePath: string;
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
}

export interface StartPlanBuildRequest extends PlanFileRef {
  sessionId: string;
  /** Draft sessions already reserve the identity of their first turn. */
  turnId?: string;
}

interface BuildEntry {
  surfaceId: string;
  sessionId: string;
  turnId: string;
  status: 'building' | 'built';
}

interface TurnSettledEvent {
  sessionId?: string;
  session_id?: string;
  turnId?: string;
  turn_id?: string;
  success?: boolean;
}

class PlanBuildStateService {
  private builds = new Map<string, BuildEntry>();
  private subscribers = new Map<string, Set<BuildStateCallback>>();

  constructor() {
    // API listeners cover WebSocket hosts. The routed observer also receives
    // background peer events before active-surface filtering.
    agentAPI.onDialogTurnCompleted(event => this.settle(event, true));
    agentAPI.onDialogTurnFailed(event => this.settle(event, false));
    agentAPI.onDialogTurnCancelled(event => this.settle(event, false));
    agentAPI.onDialogTurnInterrupted(event => this.settle(event, false));
    observeSurfaceEvents((name, deviceId, payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (name === 'agentic://dialog-turn-completed') {
        this.settle(payload, true, surfaceIdForDevice(deviceId));
      } else if (['agentic://dialog-turn-failed', 'agentic://dialog-turn-cancelled',
        'agentic://dialog-turn-interrupted'].includes(name)) {
        this.settle(payload, false, surfaceIdForDevice(deviceId));
      }
    });
  }

  startBuild(request: StartPlanBuildRequest): string | null {
    const key = this.targetKey(request);
    if (this.builds.get(key)?.status === 'building') return null;
    const turnId = request.turnId || `dialog_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.builds.set(key, {
      surfaceId: getActiveSurfaceId(),
      sessionId: request.sessionId,
      turnId,
      status: 'building',
    });
    this.notify(key, 'building');
    return turnId;
  }

  getBuildStatus(target: PlanFileRef): PlanBuildStatus {
    return this.builds.get(this.targetKey(target))?.status ?? 'build';
  }

  cancelBuild(target: PlanFileRef): void {
    const key = this.targetKey(target);
    this.builds.delete(key);
    this.notify(key, 'build');
  }

  subscribe(target: PlanFileRef, callback: BuildStateCallback): () => void {
    const key = this.targetKey(target);
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set());
    this.subscribers.get(key)!.add(callback);
    return () => {
      const subscribers = this.subscribers.get(key);
      subscribers?.delete(callback);
      if (!subscribers?.size) this.subscribers.delete(key);
    };
  }

  private targetKey(target: PlanFileRef): string {
    const normalize = (path: string) => path.replace(/\\/g, '/');
    const owner = target.workspaceId?.trim()
      ? ['workspace', target.workspaceId.trim()]
      : [target.remoteConnectionId ?? 'local', normalize(target.workspacePath ?? '')];
    return JSON.stringify([getActiveSurfaceId(), ...owner, normalize(target.planFilePath)]);
  }

  private notify(key: string, status: PlanBuildStatus): void {
    this.subscribers.get(key)?.forEach(callback => callback(status));
  }

  private settle(event: TurnSettledEvent, completed: boolean, surfaceId = getActiveSurfaceId()): void {
    const sessionId = event.sessionId ?? event.session_id;
    const turnId = event.turnId ?? event.turn_id;
    if (!sessionId || !turnId) return;
    for (const [key, entry] of this.builds) {
      if (entry.surfaceId !== surfaceId || entry.sessionId !== sessionId
        || entry.turnId !== turnId || entry.status !== 'building') continue;
      const status = completed && event.success !== false ? 'built' : 'build';
      if (status === 'built') entry.status = status;
      else this.builds.delete(key);
      this.notify(key, status);
    }
  }
}

export const planBuildStateService = new PlanBuildStateService();
