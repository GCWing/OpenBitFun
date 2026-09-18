import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cronAPI } from './CronAPI';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));
describe('scheduled job workspace identity', () => {
  beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue([]); });
  it('sends only an ID when filtering jobs', async () => {
    await cronAPI.listJobs({ workspaceId: 'remote-workspace', targetKind: 'workspace' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('list_cron_jobs', {
      request: { workspaceId: 'remote-workspace', targetKind: 'workspace' },
    });
  });
  it('upgrades an old response only when the host catalog identifies one workspace', async () => {
    const local = { id: 'local-id', rootPath: '/same', workspaceKind: 'normal' };
    const remote = { id: 'remote-id', rootPath: '/same', workspaceKind: 'remote', connectionId: 'ssh-1' };
    const jobs = [
      { id: 'remote-job', target: { workspace: { workspacePath: '/same', remoteConnectionId: 'ssh-1' } } },
      { id: 'ambiguous-job', target: { workspace: { workspacePath: '/same' } } },
      { id: 'stale-id-job', target: { workspace: { workspacePath: '/same', workspaceId: 'deleted-id' } } },
    ];
    invoke.mockImplementation(async (command: string) => command === 'list_cron_jobs' ? jobs : [local, remote]);
    const result = await cronAPI.listJobs();
    expect(result[0].target.workspace.workspaceId).toBe('remote-id');
    expect(result[1].target.workspace.workspaceId).toBeUndefined();
    expect(result[2].target.workspace.workspaceId).toBe('deleted-id');
    expect(jobs[0].target.workspace).not.toHaveProperty('workspaceId');
  });
  it('does not widen an empty ID filter to all jobs', async () => {
    await expect(cronAPI.listJobs({ workspaceId: '' })).rejects.toThrow('Workspace ID');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('creates and edits targets by ID without a root or connection hint', async () => {
    const target = { kind: 'workspace' as const, workspace: { workspaceId: 'remote-workspace' }, launch: { agentType: 'Standard' } };
    const request = { name: 'job', schedule: { kind: 'every' as const, everyMs: 60000 }, payload: { text: 'hello' }, target };
    await cronAPI.createJob(request);
    expect(invoke).toHaveBeenLastCalledWith('create_cron_job', { request });
    await cronAPI.updateJob('job-1', { target });
    expect(invoke).toHaveBeenLastCalledWith('update_cron_job', { request: { jobId: 'job-1', target } });
  });
});
