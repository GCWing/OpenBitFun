import type { AssistantEntry, RecentWorkspaceEntry, SessionInfo } from './RemoteSessionManager';

export interface WorkspaceCatalog {
  workspaces: RecentWorkspaceEntry[];
  /** Absent opened_workspaces on the wire means a legacy host, not an empty catalog. */
  source: 'opened' | 'recent';
}

export function projectWorkspaceCatalog(
  response: { workspaces: RecentWorkspaceEntry[]; opened_workspaces?: RecentWorkspaceEntry[] | null },
  assistants: AssistantEntry[] = [],
): WorkspaceCatalog {
  const source = Array.isArray(response.opened_workspaces) ? 'opened' : 'recent';
  const rows = source === 'opened' ? response.opened_workspaces! : [
    ...assistants.map((assistant): RecentWorkspaceEntry => ({
      workspace_id: assistant.workspace_id,
      path: assistant.path, name: assistant.name, last_opened: '', workspace_kind: 'assistant',
    })),
    ...response.workspaces,
  ];
  const seen = new Set<string>();
  return {
    source,
    workspaces: rows.map(normalizeWorkspaceRouting).map((workspace) => {
      if (workspace.remote_connection_id || workspace.remote_ssh_host) return workspace;
      const assistant = assistants.find(candidate => sameWorkspace(candidate, workspace));
      return assistant?.name.trim()
        ? { ...workspace, name: assistant.name, workspace_kind: 'assistant' as const }
        : workspace;
    }).filter((workspace) => {
      if (!workspace.path) return false;
      const key = workspaceIdentityKey(workspace);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export type WorkspaceIdentity = Pick<
  RecentWorkspaceEntry,
  'workspace_id' | 'path' | 'remote_connection_id' | 'remote_ssh_host'
>;

/**
 * A workspace reference as carried by wire payloads and cache records. The
 * path may be absent on ID-only references; the ID may be absent on rows from
 * pre-ID hosts and old caches.
 */
export interface WorkspaceReference {
  workspace_id?: string;
  path?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
}

function trimmedText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Root comparison for legacy references. Trailing slashes are not identity. */
function normalizedLegacyRoot(path: string | undefined): string {
  const trimmed = (path ?? '').trim();
  const withoutSlash = trimmed.replace(/\/+$/, '');
  return withoutSlash || trimmed;
}

export function workspaceIdentityKey(workspace: WorkspaceReference): string {
  if (workspace.workspace_id) return workspace.workspace_id;
  return legacyWorkspaceKey(workspace);
}

/** Upgrade-only key for rows received from pre-ID hosts. Never sent as an ID. */
export function legacyWorkspaceKey(workspace: WorkspaceReference): string {
  return JSON.stringify([
    trimmedText(workspace.remote_connection_id) ?? null,
    trimmedText(workspace.remote_ssh_host) ?? null,
    normalizedLegacyRoot(workspace.path),
  ]);
}

/**
 * Identity comparison. When both sides carry a workspace ID only the IDs are
 * compared; a missing ID on either side falls back to the legacy triple.
 */
export function sameWorkspace(
  left: WorkspaceReference | null | undefined,
  right: WorkspaceReference | null | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.workspace_id && right.workspace_id) return left.workspace_id === right.workspace_id;
  return legacyWorkspaceKey(left) === legacyWorkspaceKey(right);
}

/**
 * Single upgrade-only compatibility helper for pre-ID references. Mirrors the
 * Kotlin `LegacyWorkspaceCompatibility.resolve` and the Rust
 * `resolve_legacy_workspace_reference` semantics: an explicit ID resolves by
 * ID only and never falls back to a path; a path-only reference resolves only
 * when exactly one catalog entry matches its root and any supplied SSH
 * selectors. Ambiguous roots stay unresolved.
 */
export function resolveLegacyWorkspaceReference<T extends WorkspaceReference>(
  reference: WorkspaceReference,
  catalog: readonly T[],
): T | undefined {
  const workspaceId = trimmedText(reference.workspace_id);
  if (workspaceId) {
    const byId = catalog.filter((candidate) => candidate.workspace_id === workspaceId);
    return byId.length === 1 ? byId[0] : undefined;
  }
  const root = normalizedLegacyRoot(reference.path);
  if (!root) return undefined;
  const connection = trimmedText(reference.remote_connection_id);
  const host = trimmedText(reference.remote_ssh_host);
  const matches = catalog.filter((candidate) => normalizedLegacyRoot(candidate.path) === root
    && (!connection || candidate.remote_connection_id === connection)
    && (!host
      || (!connection && host === 'localhost')
      || candidate.remote_ssh_host === host));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The workspace a session claims, merged from host facts and cache provenance. */
function sessionWorkspaceReference(session: SessionInfo): WorkspaceReference | undefined {
  const provenance = session.workspace_identity;
  const workspaceId = session.workspace_id ?? provenance?.workspace_id;
  if (!provenance && !workspaceId) return undefined;
  return {
    workspace_id: workspaceId,
    path: provenance?.path ?? session.workspace_path,
    remote_connection_id: provenance?.remote_connection_id,
    remote_ssh_host: provenance?.remote_ssh_host,
  };
}

/**
 * Attribute a session to a workspace row. IDs win when both sides have one.
 * Provenance written by this client encodes a missing SSH selector as local, so
 * an ID-less provenance row compares its exact legacy triple and stays
 * unresolved when several catalog rows share that triple. Rows without any
 * provenance (pre-provenance caches) follow the unique-local rule: they are
 * attributed only when exactly one catalog entry has that root and it is the
 * local workspace being asked about.
 */
export function sessionMatchesWorkspace(
  session: SessionInfo,
  workspace: WorkspaceIdentity,
  catalog: readonly WorkspaceIdentity[] = [],
): boolean {
  const candidates = catalog.length > 0 ? catalog : [workspace];
  const reference = sessionWorkspaceReference(session);
  if (reference) {
    if (reference.workspace_id && workspace.workspace_id) {
      return reference.workspace_id === workspace.workspace_id;
    }
    if (reference.workspace_id) {
      // The catalog row predates IDs; resolve the ID and compare its projection.
      const resolved = resolveLegacyWorkspaceReference(reference, candidates);
      return resolved !== undefined && sameWorkspace(resolved, workspace);
    }
    const key = legacyWorkspaceKey(reference);
    const owners = candidates.filter((candidate) => legacyWorkspaceKey(candidate) === key);
    return owners.length === 1 && legacyWorkspaceKey(workspace) === key;
  }
  if (workspace.remote_connection_id || workspace.remote_ssh_host) return false;
  if (!session.workspace_path) return false;
  const local = resolveLegacyWorkspaceReference({ path: session.workspace_path }, candidates);
  return local !== undefined && sameWorkspace(local, workspace);
}

export function mergeWorkspaceSessions(
  existing: SessionInfo[],
  incoming: SessionInfo[],
  workspace: WorkspaceReference | undefined,
  replaceWorkspace: boolean,
): SessionInfo[] {
  const retained = !replaceWorkspace
    ? existing
    : workspace
      ? existing.filter((session) => !session.workspace_identity
        || !sameWorkspace(session.workspace_identity, workspace))
      : [];
  const merged = new Map(retained.map((session) => [session.session_id, session]));
  incoming.forEach((session) => {
    const previous = merged.get(session.session_id);
    const identity = session.workspace_identity ?? workspace ?? previous?.workspace_identity;
    merged.set(session.session_id, {
      ...session,
      // A listing scoped by ID owns its rows; only fill the ID from that scope.
      workspace_id: session.workspace_id ?? workspace?.workspace_id ?? previous?.workspace_id,
      workspace_path: session.workspace_path || workspace?.path,
      workspace_identity: identity,
    });
  });
  return [...merged.values()];
}

/** Old hosts included sshHost=localhost on normal records. Kind is authoritative;
 * missing kinds retain legacy selectors for the owning host to resolve. */
export function normalizeWorkspaceRouting<T extends {
  workspace_kind?: string; remote_connection_id?: string; remote_ssh_host?: string;
}>(workspace: T): T {
  return (workspace.workspace_kind === 'normal' || workspace.workspace_kind === 'assistant')
      && (workspace.remote_connection_id !== undefined || workspace.remote_ssh_host !== undefined)
    ? { ...workspace, remote_connection_id: undefined, remote_ssh_host: undefined }
    : workspace;
}
