import { beforeEach, expect, it, vi } from 'vitest';
import type { ExternalMcpImportPlanV1 } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import type { ExternalHookImportPlan } from '@/infrastructure/api/service-api/ExternalHooksAPI';
import type { SkillInfo } from '@/infrastructure/config/types';
import { applyEcosystemBatch, type BatchImportEntry, type BatchImportResult } from './ecosystemBatchImport';

const mocks = vi.hoisted(() => ({ add: vi.fn(), mcp: vi.fn(), hook: vi.fn(), planHook: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { addSkill: mocks.add } }));
vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({ externalSourcesAPI: { applyMcpImport: mocks.mcp } }));
vi.mock('@/infrastructure/api/service-api/ExternalHooksAPI', () => ({ externalHooksAPI: { applyImport: mocks.hook, planImport: mocks.planHook } }));

beforeEach(() => vi.resetAllMocks());

it('commits all MCP selections together and continues after an independent Skill failure without replaying it', async () => {
  mocks.mcp.mockResolvedValue({ outcome: { status: 'applied' } });
  mocks.add.mockRejectedValueOnce(new Error('conflict')).mockResolvedValueOnce('ok');
  const plan = { planFingerprint: 'reviewed' } as ExternalMcpImportPlanV1;
  const entries: BatchImportEntry[] = [
    ...['one', 'two'].map((id) => ({ id, name: id, kind: 'mcp' as const, candidateId: id, plan })),
    ...['conflict', 'good'].map((id) => ({ id, name: id, kind: 'skill' as const, level: 'user' as const,
      skill: { key: id, path: `/source/${id}` } as SkillInfo })),
  ];
  const results: BatchImportResult[] = [];
  await applyEcosystemBatch(entries, { workspaceId: 'workspace-1' }, (result) => results.push(result));
  expect(mocks.mcp).toHaveBeenCalledExactlyOnceWith('workspace-1', plan, [{ candidateId: 'one' }, { candidateId: 'two' }]);
  expect(mocks.add).toHaveBeenCalledTimes(2);
  expect(results.map(({ status }) => status)).toEqual(['imported', 'imported', 'failed', 'imported']);
  expect(mocks.add).toHaveBeenLastCalledWith({ sourceKey: 'good', sourcePath: '/source/good', level: 'user', workspaceId: 'workspace-1' });
});

it('refreshes a Hook target revision but refuses executable content changed since review', async () => {
  const plan = { source: { key: { providerId: 'codex.hooks', sourceId: 'user' } }, disposition: 'import',
    behaviorVersion: 'v1', handlers: [{ stableKey: 'stop', event: 'Stop', command: 'echo reviewed', dependencies: [] }],
    skipped: [], planFingerprint: 'old' } as unknown as ExternalHookImportPlan;
  const entries: BatchImportEntry[] = ['one', 'two'].map((id) => ({ id, name: id, kind: 'hook', plan }));
  mocks.planHook.mockResolvedValueOnce({ ...plan, planFingerprint: 'new-target-revision' })
    .mockResolvedValueOnce({ ...plan, handlers: [{ ...plan.handlers[0], command: 'echo changed' }] });
  mocks.hook.mockResolvedValue({ outcome: { kind: 'applied' } });
  const results: BatchImportResult[] = [];
  await applyEcosystemBatch(entries, {}, (result) => results.push(result));
  expect(mocks.hook).toHaveBeenCalledTimes(1);
  expect(mocks.hook.mock.calls[0][1].planFingerprint).toBe('new-target-revision');
  expect(results.map(({ status }) => status)).toEqual(['imported', 'stale']);
});

it('retains each reviewed Skill digest and continues after a stale package', async () => {
  mocks.add.mockRejectedValueOnce(new Error('skill_import_stale: changed')).mockResolvedValueOnce('ok');
  const entries: BatchImportEntry[] = ['changed', 'unchanged'].map((id) => ({
    id, name: id, kind: 'skill', skill: { key: id, path: `/source/${id}` } as SkillInfo,
    level: 'user', targetName: `${id}-alias`, preview: { fingerprint: `digest-${id}`, fileCount: 2, name: id, description: '' },
  }));
  const results: BatchImportResult[] = [];
  await applyEcosystemBatch(entries, {}, (result) => results.push(result));
  expect(results.map(({ status }) => status)).toEqual(['stale', 'imported']);
  expect(mocks.add.mock.calls.map(([request]) => request.expectedSourceFingerprint)).toEqual(['digest-changed', 'digest-unchanged']);
  expect(mocks.add.mock.calls[1][0].targetName).toBe('unchanged-alias');
});
