import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { invokePrepared } from './invokePrepared';
import { upgradeLegacyCronJobs, workspaceIdRequest } from './legacyWorkspaceCompatibility';
import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import { isTauriRuntime } from '@/infrastructure/runtime';

export type CronJobRunStatus = 'queued' | 'running' | 'ok' | 'error' | 'cancelled';
export type CronJobTargetKind = 'session' | 'workspace';

export type CronSchedule =
  | {
    kind: 'at';
    at: string;
  }
  | {
    kind: 'every';
    everyMs: number;
    anchorMs?: number | null;
  }
  | {
    kind: 'cron';
    expr: string;
    tz?: string | null;
  };

export interface CronJobPayload {
  text: string;
}

export interface CronWorkspaceRef {
  workspaceId?: string | null;
  workspacePath: string;
  remoteConnectionId?: string | null;
  remoteSshHost?: string | null;
}

export interface CronLaunchSpec {
  agentType: string;
  modelId?: string | null;
}

export type CronJobTarget =
  | {
    kind: 'session';
    sessionId: string;
    workspace: CronWorkspaceRef;
  }
  | {
    kind: 'workspace';
    workspace: CronWorkspaceRef;
    launch: CronLaunchSpec;
  };

export interface CronJobState {
  nextRunAtMs?: number | null;
  pendingTriggerAtMs?: number | null;
  retryAtMs?: number | null;
  lastTriggerAtMs?: number | null;
  lastEnqueuedAtMs?: number | null;
  lastRunStartedAtMs?: number | null;
  lastRunFinishedAtMs?: number | null;
  lastDurationMs?: number | null;
  lastRunStatus?: CronJobRunStatus | null;
  lastError?: string | null;
  activeTurnId?: string | null;
  consecutiveFailures: number;
  coalescedRunCount: number;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  payload: CronJobPayload;
  enabled: boolean;
  target: CronJobTarget;
  createdAtMs: number;
  configUpdatedAtMs: number;
  updatedAtMs: number;
  state: CronJobState;
}

export interface ListCronJobsRequest {
  workspaceId?: string;
  sessionId?: string;
  targetKind?: CronJobTargetKind;
}

export type CronJobTargetRequest =
  | { kind: 'session'; sessionId: string; workspace: { workspaceId: string } }
  | { kind: 'workspace'; workspace: { workspaceId: string }; launch: CronLaunchSpec };

export interface CreateCronJobRequest {
  name: string;
  schedule: CronSchedule;
  payload: CronJobPayload;
  enabled?: boolean;
  target: CronJobTargetRequest;
}

export interface UpdateCronJobRequest {
  name?: string;
  schedule?: CronSchedule;
  payload?: CronJobPayload;
  enabled?: boolean;
  target?: CronJobTargetRequest;
}

export class CronAPI {
  /**
   * Register a listener for backend scheduled-job change hints. The backend
   * emits these when the job set or a job's run state changes (agent tool
   * calls, scheduler runs, session cleanup); the payload is only a hint, so
   * consumers re-read the job list. Returns an unlisten function.
   */
  onJobsChanged(callback: (payload: { reason?: string; jobId?: string | null }) => void): () => void {
    return api.listen<{ reason?: string; jobId?: string | null }>(
      'cron://jobs-changed',
      callback,
    );
  }

  async notifyHostReady(): Promise<void> {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      // Tauri listener registration is async. Wait for listeners already issued
      // by FlowChat before allowing cron to emit startup events.
      await invokePrepared<void>('notify_cron_host_ready', async () => {
        await api.waitForListenerRegistrations();
        return undefined;
      });
    } catch (error) {
      throw createTauriCommandError('notify_cron_host_ready', error);
    }
  }

  async listJobs(request: ListCronJobsRequest = {}): Promise<CronJob[]> {
    try {
      const { workspaceId, ...filters } = request;
      let scope!: SurfaceScope;
      const jobs = await invokePrepared<CronJob[]>('list_cron_jobs', async (current) => {
        scope = current;
        const identity = workspaceId !== undefined ? await workspaceIdRequest(workspaceId, 'workspacePath') : {};
        return { request: { ...filters, ...identity } };
      });
      return await upgradeLegacyCronJobs(jobs, () => scope.assertCurrent('upgrade scheduled job references'));
    } catch (error) {
      throw createTauriCommandError('list_cron_jobs', error, request);
    }
  }

  async createJob(request: CreateCronJobRequest): Promise<CronJob> {
    try {
      return await invokePrepared<CronJob>('create_cron_job', async () => ({
        request: {
          ...request,
          target: {
            ...request.target,
            workspace: await workspaceIdRequest(request.target.workspace.workspaceId, 'workspacePath'),
          },
        },
      }));
    } catch (error) {
      throw createTauriCommandError('create_cron_job', error, request);
    }
  }

  async updateJob(jobId: string, changes: UpdateCronJobRequest): Promise<CronJob> {
    try {
      return await invokePrepared<CronJob>('update_cron_job', async () => {
        const target = changes.target ? { ...changes.target,
          workspace: await workspaceIdRequest(changes.target.workspace.workspaceId, 'workspacePath'),
        } : undefined;
        return {
          request: {
            jobId,
            ...changes,
            ...(target ? { target } : {}),
          },
        };
      });
    } catch (error) {
      throw createTauriCommandError('update_cron_job', error, { jobId, ...changes });
    }
  }

  async deleteJob(jobId: string): Promise<boolean> {
    try {
      return await api.invoke<boolean>('delete_cron_job', {
        request: { jobId },
      });
    } catch (error) {
      throw createTauriCommandError('delete_cron_job', error, { jobId });
    }
  }
}

export const cronAPI = new CronAPI();
