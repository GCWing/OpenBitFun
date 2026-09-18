/** Upgrade-only adapter for pre-ID HostInvoke protocols, including 1.0.0.
 * Paths are never workspace keys. Resolve the host-owned object by ID first;
 * serialize its root only for an explicitly negotiated legacy peer.
 * Sunset after the minimum supported peer supports workspace_id_references_v1.
 * New commands must accept workspaceId and must not import this adapter.
 */
import { normalizePath, normalizeRemoteWorkspacePath } from '@/shared/utils/pathUtils';
import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';

export async function legacyWorkspacePayload(workspaceId: string, assertCurrent: () => void) {
  const { api } = await import('./ApiClient');
  assertCurrent();
  type Record = {
    id: string; rootPath: string; workspaceKind: string; connectionId?: string; sshHost?: string;
  };
  const [opened, recent] = await Promise.all([
    api.invoke<Record[]>('get_opened_workspaces'), api.invoke<Record[]>('get_recent_workspaces'),
  ]);
  const workspaces = [...opened, ...recent];
  assertCurrent();
  const workspace = workspaces.find(candidate => candidate.id === workspaceId);
  if (!workspace) throw new Error(`Workspace is unavailable on this host: ${workspaceId}`);
  return {
    workspacePath: workspace.rootPath,
    remoteConnectionId: workspace.workspaceKind === 'remote' ? workspace.connectionId : undefined,
    remoteSshHost: workspace.workspaceKind === 'remote' ? workspace.sshHost : undefined,
  };
}

/** Read old session projections once, before putting their ID in current state.
 * Explicit stale IDs never fall back to a path, and ambiguity stays unresolved.
 */
export function resolveLegacySessionWorkspace<T extends {
  id: string; rootPath: string; workspaceKind?: string; connectionId?: string; sshHost?: string;
}>(session: {
  workspaceId?: string; workspacePath?: string; projectWorkspacePath?: string;
  remoteConnectionId?: string; remoteSshHost?: string;
}, records: T[]): T | undefined {
  if (session.workspaceId) return records.find(record => record.id === session.workspaceId);
  const roots = [session.workspacePath, session.projectWorkspacePath].filter(Boolean);
  const candidates = records.filter(record => {
    const normalize = record.workspaceKind === 'remote' ? normalizeRemoteWorkspacePath : normalizePath;
    const matchesPath = roots.some(root => root && normalize(root).replace(/\/$/, '') === normalize(record.rootPath).replace(/\/$/, ''));
    return matchesPath
    && (!session.remoteConnectionId || (record.workspaceKind === 'remote' && record.connectionId === session.remoteConnectionId))
    && (!session.remoteSshHost || session.remoteSshHost === 'localhost'
      || (record.workspaceKind === 'remote' && record.sshHost === session.remoteSshHost));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Negotiated outbound serialization for the temporary pre-ID host protocol. */
export async function workspaceIdRequest(workspaceId: string, legacyPathField: 'path' | 'workspacePath' | 'repositoryPath' | 'rootPath') {
  if (!workspaceId.trim()) throw new Error('Workspace ID is required');
  const scope = getActiveSurfaceScope();
  if (isLocalSurface(scope.surfaceId)) return { workspaceId };
  const { peerConnectionManager } = await import('@/infrastructure/peer-device/PeerConnectionManager');
  scope.assertCurrent('negotiate workspace identity protocol');
  if (peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.workspaceIdReferencesV1 === true) {
    return { workspaceId };
  }
  const legacy = await legacyWorkspacePayload(workspaceId, () => scope.assertCurrent('resolve legacy workspace'));
  return { [legacyPathField]: legacy.workspacePath, remoteConnectionId: legacy.remoteConnectionId, remoteSshHost: legacy.remoteSshHost };
}

export async function sessionWorkspaceIdRequest(workspaceId: string) {
  const request = await workspaceIdRequest(workspaceId, 'workspacePath');
  if ('workspaceId' in request) return { workspace_id: request.workspaceId };
  return { workspace_path: request.workspacePath, remote_connection_id: request.remoteConnectionId };
}

/** Upgrade-only migration of 1.0.0 controller-local terminal profile keys.
 * Copy the original bytes and preserve the old record for rollback. Parsing and
 * validation remain with the profile owner; migration never repairs user data.
 */
export function migrateLegacyTerminalProfiles(
  storage: Storage,
  prefix: string,
  targetKey: string,
  reference: { surfaceId: string; workspaceId: string },
  records: Array<{ id: string; rootPath: string; workspaceKind?: string; connectionId?: string }>,
): void {
  if (storage.getItem(targetKey) !== null) return;
  const workspace = records.find(record => record.id === reference.workspaceId);
  if (!workspace) throw new Error('Workspace ID is unavailable for legacy profile migration');
  const legacyKey = (record: typeof workspace) => reference.surfaceId === 'local' && record.workspaceKind !== 'remote'
    ? record.rootPath
    : JSON.stringify([reference.surfaceId, 'terminal-profiles', record.connectionId ?? '', record.rootPath]);
  const oldIdentity = legacyKey(workspace);
  const raw = storage.getItem(`${prefix}:${oldIdentity}`);
  if (raw === null) return;
  const owners = new Set(records.filter(record => legacyKey(record) === oldIdentity).map(record => record.id));
  if (owners.size !== 1) throw new Error('Legacy terminal profile workspace is ambiguous');
  storage.setItem(targetKey, raw);
}

/** Upgrade-only terminal DTO conversion for hosts without terminal workspace IDs. */
export function resolveLegacyTerminalWorkspace(
  terminal: { workspaceId?: string; initialCwd?: string; cwd: string; shellType: string; connectionId?: string },
  records: Array<{ id: string; rootPath: string; workspaceKind?: string; connectionId?: string }>,
): string | undefined {
  if (terminal.workspaceId) return terminal.workspaceId;
  const remote = terminal.shellType === 'Remote' || !!terminal.connectionId;
  const origin = terminal.initialCwd || terminal.cwd;
  const candidates = records.filter(record => {
    if ((record.workspaceKind === 'remote') !== remote) return false;
    if (remote && (!terminal.connectionId || record.connectionId !== terminal.connectionId)) return false;
    const normalize = remote ? normalizeRemoteWorkspacePath : normalizePath;
    const root = normalize(record.rootPath).replace(/\/$/, '');
    const path = normalize(origin).replace(/\/$/, '');
    return path === root || path.startsWith(`${root}/`);
  });
  // A legacy record cannot distinguish nested or same-path workspace owners.
  const ids = new Set(candidates.map(record => record.id));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Serializes workspace identity only at the temporary old-host protocol boundary. */
export async function workspaceScopedRequest<T extends { workspaceId?: string }>(input: T) {
  const { workspaceId, ...fields } = input;
  if (workspaceId === undefined) return fields;
  if (!workspaceId.trim()) throw new Error('Workspace ID must not be empty');
  return { ...fields, ...await workspaceIdRequest(workspaceId, 'workspacePath') };
}

/** Upgrade-only projection for 1.0.0 catalogs lacking the worktree owner ID.
 * Ambiguous roots remain unresolved; navigation must never guess the owner.
 * Current hosts persist this relationship and normal consumers compare IDs.
 */
export function upgradeLegacyWorktreeReferences<T extends {
  id: string; rootPath: string; workspaceKind?: string;
  worktree?: { isMain: boolean; mainRepoPath: string; mainWorkspaceId?: string } | null;
}>(records: T[]): T[] {
  return records.map(record => {
    const tree = record.worktree;
    if (record.workspaceKind === 'remote' || !tree || tree.mainWorkspaceId) return record;
    const owners = tree.isMain ? [record] : records.filter(candidate =>
      candidate.workspaceKind !== 'remote'
      && normalizePath(candidate.rootPath) === normalizePath(tree.mainRepoPath));
    const ids = new Set(owners.map(owner => owner.id));
    if (ids.size !== 1) return record;
    return { ...record, worktree: { ...tree, mainWorkspaceId: owners[0].id } };
  });
}

/** Upgrade-only rollback wire projection. Older hosts require the local host
 * marker to avoid looking up a same-named remote root. Current requests use IDs.
 */
export async function workspaceHistoryRequest(workspaceId: string) {
  if (!workspaceId) throw new Error('A workspace ID is required for history mutation');
  const scope = await workspaceIdRequest(workspaceId, 'workspacePath');
  return 'workspaceId' in scope ? scope : {
    ...scope, workspaceHostname: scope.remoteConnectionId ? undefined : 'localhost',
  };
}

/** Temporary outbound search serializer for pre-ID hosts. */
export async function workspaceSearchRequest<T extends { workspaceId: string }>(request: T) {
  const { workspaceId, ...query } = request;
  if (!workspaceId) throw new Error('Workspace ID is required for search');
  return { ...query, ...await workspaceIdRequest(workspaceId, 'rootPath') };
}

/** Temporary flat 1.0.0 file-watch payload; current hosts use structured ID requests. */
export async function workspaceWatchRequest(workspaceId: string, path: string, recursive?: boolean) {
  if (!workspaceId) throw new Error('Workspace ID is required for filesystem watching');
  const scope = await workspaceIdRequest(workspaceId, 'workspacePath');
  return 'workspaceId' in scope ? { request: { workspaceId, path, recursive } } : { path, recursive };
}

/** Upgrade-only copy of controller-local 1.0.0 Skill import receipts. Keep source
 * bytes and unknown records; explicit ID tombstones prevent repeated migration.
 */
export function migrateLegacySkillReceipts(storage: Storage, records: Array<{
  id: string; rootPath: string; workspaceKind?: string;
}>): void {
  const prefix = 'openbitfun:external-skill-import:';
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(prefix) || key.startsWith(`${prefix}v2:`)) continue;
    try {
      const tuple = JSON.parse(key.slice(prefix.length));
      if (!Array.isArray(tuple) || tuple.length !== 2 || tuple.some(value => typeof value !== 'string')) continue;
      const [root, source] = tuple;
      const ids = new Set(records.filter(record => record.workspaceKind !== 'remote'
        && normalizePath(record.rootPath) === normalizePath(root)).map(record => record.id));
      if (root && ids.size !== 1) continue;
      const id = root ? [...ids][0] : '';
      const target = `${prefix}v2:${JSON.stringify(['local', id, source])}`;
      if (storage.getItem(target) !== null) continue;
      const raw = storage.getItem(key);
      if (!root && raw !== null) {
        const receipt = JSON.parse(raw);
        if (receipt?.schemaVersion !== 1 || receipt.level !== 'user' || receipt.sourcePath !== source) continue;
      }
      if (raw !== null) storage.setItem(target, raw);
    } catch { /* Preserve unreadable old entries without changing unrelated records. */ }
  }
}

/** Temporary inbound upgrade for pre-ID scheduled-job responses. Never guess
 * on ambiguity; the editor must require explicit selection for such records.
 */
export async function upgradeLegacyCronJobs<T extends { target: { workspace: {
  workspaceId?: string | null; workspacePath: string;
  remoteConnectionId?: string | null; remoteSshHost?: string | null;
} } }>(jobs: T[], assertCurrent: () => void): Promise<T[]> {
  if (!jobs.some(job => !job.target.workspace.workspaceId)) return jobs;
  const { api } = await import('./ApiClient');
  assertCurrent();
  type Record = { id: string; rootPath: string; workspaceKind?: string; connectionId?: string; sshHost?: string };
  const [opened, recent] = await Promise.all([
    api.invoke<Record[]>('get_opened_workspaces'), api.invoke<Record[]>('get_recent_workspaces'),
  ]);
  assertCurrent();
  const records = [...new Map([...recent, ...opened].map(record => [record.id, record])).values()];
  return jobs.map(job => {
    const ref = job.target.workspace;
    if (ref.workspaceId) return job;
    const record = resolveLegacySessionWorkspace({ workspacePath: ref.workspacePath,
      remoteConnectionId: ref.remoteConnectionId ?? undefined, remoteSshHost: ref.remoteSshHost ?? undefined,
    }, records);
    return record ? { ...job, target: { ...job.target, workspace: { ...ref, workspaceId: record.id } } } : job;
  });
}

/** Temporary adapter for pre-ID persisted editor scopes; never use a file path as a workspace key. */
export async function upgradeLegacyEditorWorkspaceId(scope: {
  surfaceId: string; workspaceId?: string; workspacePath?: string; remoteConnectionId?: string;
}): Promise<string> {
  const active = getActiveSurfaceScope();
  if (active.surfaceId !== scope.surfaceId) throw new Error('The document is on an inactive device.');
  if (scope.workspaceId) return scope.workspaceId;
  if (!scope.workspacePath) throw new Error('The document has no workspace ID to restore.');
  const { api } = await import('./ApiClient');
  type Record = { id: string; rootPath: string; workspaceKind?: string; connectionId?: string; sshHost?: string };
  active.assertCurrent('upgrade editor workspace ID');
  const [opened, recent] = await Promise.all([
    api.invoke<Record[]>('get_opened_workspaces'), api.invoke<Record[]>('get_recent_workspaces'),
  ]);
  active.assertCurrent('upgrade editor workspace ID');
  const records = [...new Map([...opened, ...recent].map(record => [record.id, record])).values()];
  const record = resolveLegacySessionWorkspace(scope, records);
  if (!record) throw new Error('The legacy document workspace is unavailable or ambiguous; select its workspace ID.');
  return record.id;
}
