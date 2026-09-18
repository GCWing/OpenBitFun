import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { externalSourcesAPI, type ExternalMcpImportPlanV1 } from '@/infrastructure/api/service-api/ExternalSourcesAPI';
import { externalHooksAPI, type ExternalHookImportPlan } from '@/infrastructure/api/service-api/ExternalHooksAPI';
import type { SkillInfo, SkillLevel, SkillImportPreview } from '@/infrastructure/config/types';
import { importErrorMessage } from './ecosystemSkillImport';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';

export type BatchImportEntry = { id: string; name: string } & (
  | { kind: 'skill'; skill: SkillInfo; level: SkillLevel; targetName?: string; preview?: SkillImportPreview }
  | { kind: 'mcp'; candidateId: string; plan: ExternalMcpImportPlanV1 }
  | { kind: 'hook'; plan: ExternalHookImportPlan }
);
export interface BatchImportResult { id: string; name: string; status: 'imported' | 'failed' | 'stale'; error?: string }

/** One reviewed MCP transaction; independent Skill/Hook failures do not erase successful copies. */
export async function applyEcosystemBatch(
  entries: BatchImportEntry[], workspace: { workspaceId?: string },
  onResult: (result: BatchImportResult) => void,
): Promise<void> {
  const { workspaceId } = workspace;
  const scope = getActiveSurfaceScope();
  if (!isLocalSurface(scope.surfaceId)) throw new Error('External batch import requires the local host');
  const mcpEntries = entries.filter((entry) => entry.kind === 'mcp');
  if (mcpEntries.length) {
    let status: BatchImportResult['status'] = 'failed';
    let error: string | undefined;
    try {
      scope.assertCurrent('apply reviewed MCP batch');
      const response = await externalSourcesAPI.applyMcpImport(workspaceId, mcpEntries[0].plan,
        mcpEntries.map(({ candidateId }) => ({ candidateId })));
      scope.assertCurrent('confirm MCP batch');
      status = response.outcome.status === 'stale' ? 'stale' : 'imported';
    } catch (cause) { error = importErrorMessage(cause); }
    mcpEntries.forEach(({ id, name }) => onResult({ id, name, status, ...(error ? { error } : {}) }));
  }
  for (const entry of entries) {
    if (entry.kind === 'mcp') continue;
    let status: BatchImportResult['status'] = 'failed';
    let error: string | undefined;
    try {
      scope.assertCurrent('apply reviewed external import');
      if (entry.kind === 'skill') {
        await configAPI.addSkill({ sourcePath: entry.skill.path, sourceKey: entry.skill.key,
          level: entry.level, workspaceId, ...(entry.targetName ? { targetName: entry.targetName } : {}),
          ...(entry.preview ? { expectedSourceFingerprint: entry.preview.fingerprint } : {}) });
        status = 'imported';
      } else {
        // Earlier imports change the target revision. Refresh it while requiring the
        // exact source behavior and executable handlers that the user reviewed.
        const fresh = await externalHooksAPI.planImport(workspaceId, entry.plan.source.key);
        scope.assertCurrent('apply reviewed Hook import');
        if (fresh.behaviorVersion !== entry.plan.behaviorVersion
          || JSON.stringify(fresh.handlers) !== JSON.stringify(entry.plan.handlers)
          || JSON.stringify(fresh.skipped) !== JSON.stringify(entry.plan.skipped)
          || fresh.disposition === 'unavailable') status = 'stale';
        else {
          const response = await externalHooksAPI.applyImport(workspaceId, fresh);
          status = response.outcome.kind === 'stale' ? 'stale' : 'imported';
        }
      }
    } catch (cause) {
      error = importErrorMessage(cause);
      if (error.includes('skill_import_stale:')) status = 'stale';
    }
    onResult({ id: entry.id, name: entry.name, status, ...(error ? { error } : {}) });
  }
}
