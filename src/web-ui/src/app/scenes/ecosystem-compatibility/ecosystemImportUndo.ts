import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { MCPAPI } from '@/infrastructure/api/service-api/MCPAPI';
import { externalHooksAPI, type ExternalHookSource } from '@/infrastructure/api/service-api/ExternalHooksAPI';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { canDeleteSkill } from '@/infrastructure/config/skillSourcePresentation';
import type { SkillInfo } from '@/infrastructure/config/types';

export interface SkillImportReceipt {
  importId?: string;
  schemaVersion: 1;
  sourcePath: string;
  nativeKey: string;
  nativePath: string;
  level: 'user' | 'project';
}

const receipts = new Map<string, SkillImportReceipt>();
const receiptKey = (sourcePath: string, workspaceId?: string) =>
  `openbitfun:external-skill-import:v2:${JSON.stringify([getActiveSurfaceScope().surfaceId, workspaceId ?? '', sourcePath])}`;

/** Only native copy identities are saved; external content and credentials never enter browser storage. */
export function readSkillImportReceipt(sourcePath: string, workspaceId?: string): SkillImportReceipt | null {
  const readAt = (key: string, allowProject: boolean): SkillImportReceipt | null => {
    const valid = (value: SkillImportReceipt | null | undefined): value is SkillImportReceipt =>
      value?.schemaVersion === 1 && value.sourcePath === sourcePath
      && typeof value.nativeKey === 'string' && typeof value.nativePath === 'string'
      && (value.level === 'user' || (allowProject && value.level === 'project'));
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'null') return null;
      const value = raw ? JSON.parse(raw) : undefined;
      if (valid(value)) return value;
    } catch { /* Preserve unreadable storage; only the current session's own receipt may substitute. */ }
    const memory = receipts.get(key);
    return valid(memory) ? memory : null;
  };
  if (workspaceId) {
    const scoped = readAt(receiptKey(sourcePath, workspaceId), true);
    if (scoped) return scoped;
  }
  // User-level imports are shared. A malformed project receipt in the global
  // slot must never become a receipt for every workspace.
  return readAt(receiptKey(sourcePath), false);
}

export function rememberSkillImport(sourcePath: string, native: SkillInfo, workspaceId?: string) {
  if (!canDeleteSkill(native) || !['user', 'project'].includes(native.level)) return;
  if (native.level === 'project' && !workspaceId?.trim()) throw new Error('Project Skill import requires a workspace ID');
  const receipt: SkillImportReceipt = {
    schemaVersion: 1, sourcePath, nativeKey: native.key, nativePath: native.path,
    level: native.level as 'user' | 'project',
  };
  const key = receiptKey(sourcePath, native.level === 'project' ? workspaceId : undefined);
  receipts.set(key, receipt);
  try {
    // Do not overwrite an unknown version or an unreadable record.
    const existing = localStorage.getItem(key);
    if (existing && JSON.parse(existing)?.schemaVersion !== 1) return;
    localStorage.setItem(key, JSON.stringify(receipt));
  } catch { /* Retain the in-memory receipt when storage is unavailable. */ }
}

export function matchesSkillReceipt(skill: SkillInfo, receipt: SkillImportReceipt) {
  return canDeleteSkill(skill) && skill.key === receipt.nativeKey
    && skill.path === receipt.nativePath && skill.level === receipt.level
    && (!receipt.importId || skill.importOrigin?.importId === receipt.importId);
}

export type ImportUndoReview =
  | { kind: 'skill'; target: string; receipt: SkillImportReceipt }
  | { kind: 'mcp'; target: string; jsonConfig: string; fingerprint: string }
  | { kind: 'hook'; target: string; importId: string; revision: string };

function localScope() {
  const scope = getActiveSurfaceScope();
  if (!isLocalSurface(scope.surfaceId)) throw new Error('External import undo requires the local host');
  return scope;
}

export async function prepareMcpUndo(candidateId: string): Promise<ImportUndoReview> {
  const scope = localScope();
  const snapshot = await MCPAPI.loadMCPJsonConfig();
  scope.assertCurrent('review MCP import removal');
  const config = JSON.parse(snapshot.jsonConfig);
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP configuration');
  const matches = Object.entries(servers).filter(([, server]) => (
    (server as { _openbitfunImport?: { sourceCandidateId?: string } })?._openbitfunImport?.sourceCandidateId === candidateId
  ));
  if (matches.length !== 1) throw new Error('Imported MCP copy could not be identified');
  const [target] = matches[0];
  delete servers[target];
  return { kind: 'mcp', target, jsonConfig: JSON.stringify(config, null, 2), fingerprint: snapshot.fingerprint };
}

export async function prepareHookUndo(source: ExternalHookSource, workspaceId?: string): Promise<ImportUndoReview> {
  const scope = localScope();
  const snapshot = await externalHooksAPI.getImportSnapshot(workspaceId, true);
  scope.assertCurrent('review Hook import removal');
  const entry = snapshot.imports.find((item) => item.source.key.providerId === source.key.providerId
    && item.source.key.sourceId === source.key.sourceId && item.source.ecosystemId === source.ecosystemId);
  if (!entry) throw new Error('Imported Hook copy could not be identified');
  return { kind: 'hook', target: entry.source.displayName, importId: entry.importId, revision: snapshot.revision };
}

/** Called only after the user confirms removal of the displayed native copy, including its edits. */
export async function applyImportUndo(review: ImportUndoReview, workspaceId?: string): Promise<{ runtimeApplied: boolean; revision?: string }> {
  const scope = localScope();
  if (review.kind === 'mcp') return MCPAPI.saveMCPJsonConfig(review.jsonConfig, review.fingerprint);
  if (review.kind === 'hook') {
    const snapshot = await externalHooksAPI.mutateImport(workspaceId, review.revision, { kind: 'remove', importId: review.importId });
    scope.assertCurrent('confirm Hook import removal');
    return { runtimeApplied: true, revision: snapshot.revision };
  } else {
    if (review.receipt.level === 'project' && !workspaceId?.trim()) throw new Error('Project Skill removal requires a workspace ID');
    const report = await configAPI.getSkillScanReport({ workspaceId, forceRefresh: true });
    scope.assertCurrent('remove imported Skill copy');
    if (!report.skills.some((skill) => matchesSkillReceipt(skill, review.receipt))) {
      throw new Error('Imported Skill copy changed or is no longer available');
    }
    await configAPI.deleteSkill({ skillKey: review.receipt.nativeKey, workspaceId,
      ...(review.receipt.importId ? { expectedImportId: review.receipt.importId } : {}) });
    scope.assertCurrent('confirm Skill import removal');
    const key = receiptKey(review.receipt.sourcePath, review.receipt.level === 'project' ? workspaceId : undefined);
    receipts.delete(key);
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (stored?.schemaVersion === 1 && stored.nativeKey === review.receipt.nativeKey
        && stored.nativePath === review.receipt.nativePath) localStorage.setItem(key, 'null'); // Keep an ID tombstone so the old receipt cannot remigrate.
    } catch { /* Preserve unreadable records; never reset data to recover from a parse failure. */ }
  }
  scope.assertCurrent('confirm external import removal');
  return { runtimeApplied: true };
}
