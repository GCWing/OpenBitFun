import type { AssistantEntry, RecentWorkspaceEntry, SessionInfo, WorkspaceInfo } from './RemoteSessionManager';

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
    workspaces: rows.map((workspace) => ({
      ...workspace,
      name: workspaceDisplayName(
        workspace.name,
        workspace.path,
        workspace.remote_ssh_host,
        workspace.remote_connection_id,
      ),
    })).map(normalizeWorkspaceRouting).map((workspace) => {
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

/** The workspace facts a session row or a `session_created` reply can carry. */
export type SessionWorkspaceFacts = Partial<
  Pick<SessionInfo, 'workspace_id' | 'workspace_path' | 'workspace_name' | 'workspace_identity'>
>;

/** The workspace a session claims, merged from host facts and cache provenance. */
function sessionWorkspaceReference(session: SessionWorkspaceFacts): WorkspaceReference | undefined {
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
  session: SessionWorkspaceFacts,
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

/** Display fallback for remote root workspaces created by older hosts. */
export function workspaceDisplayName(
  name: string | undefined,
  path: string | undefined,
  remoteSshHost?: string,
  remoteConnectionId?: string,
): string {
  const value = name?.trim() ?? '';
  const normalized = value.toLowerCase();
  if (value && normalized !== 'unknown' && normalized !== 'unknown project'
    && value !== '\u672A\u77E5' && value !== '\u672A\u77E5\u9879\u76EE') {
    return value;
  }
  const root = (path ?? '').trim().replace(/\/+$/, '');
  const basename = root.split('/').pop()?.trim() ?? '';
  if (basename) return basename;
  return remoteSshHost?.trim() || remoteConnectionId?.trim() || 'Workspace';
}

/** Claw sessions run in an assistant workspace, which is never a project checkout. */
export function isClawAgent(agentType: string): boolean {
  return agentType === 'claw' || agentType === 'Claw';
}

/**
 * The workspace a session belongs to, captured when the session is opened. Every
 * field is optional because pre-ID hosts and old navigation records omit them.
 */
export interface SessionWorkspaceContext extends WorkspaceReference {
  name?: string;
  workspace_kind?: RecentWorkspaceEntry['workspace_kind'];
}

export function workspaceContext(workspace: WorkspaceReference & {
  name?: string;
  project_name?: string;
  workspace_kind?: RecentWorkspaceEntry['workspace_kind'];
}): SessionWorkspaceContext {
  return {
    workspace_id: workspace.workspace_id,
    path: workspace.path,
    remote_connection_id: workspace.remote_connection_id,
    remote_ssh_host: workspace.remote_ssh_host,
    name: workspace.name ?? workspace.project_name,
    workspace_kind: workspace.workspace_kind,
  };
}

/**
 * Merge a session's own facts with the workspace row that owns it. The session
 * decides identity because the host pinned it; the owner supplies the display
 * name and kind, since `workspace_name` is only the workspace's root label.
 */
export function sessionWorkspaceContext(
  session: SessionWorkspaceFacts,
  owner?: SessionWorkspaceContext,
): SessionWorkspaceContext | undefined {
  const provenance = session.workspace_identity;
  const context: SessionWorkspaceContext = {
    workspace_id: session.workspace_id ?? provenance?.workspace_id ?? owner?.workspace_id,
    path: provenance?.path || session.workspace_path || owner?.path,
    remote_connection_id: provenance?.remote_connection_id ?? owner?.remote_connection_id,
    remote_ssh_host: provenance?.remote_ssh_host ?? owner?.remote_ssh_host,
    name: owner?.name ?? session.workspace_name,
    workspace_kind: owner?.workspace_kind,
  };
  return context.workspace_id || context.path || context.name ? context : undefined;
}

/** For a selection that may have moved on: its display facts apply only if it owns the session. */
export function selectedSessionWorkspaceContext(
  session: SessionWorkspaceFacts,
  selection?: SessionWorkspaceContext,
): SessionWorkspaceContext | undefined {
  return sessionWorkspaceContext(
    session,
    selection?.path && sessionMatchesWorkspace(session, { ...selection, path: selection.path })
      ? selection
      : undefined,
  );
}

export interface ChatHeaderContext {
  workspaceName: string;
  gitBranch?: string;
}

/**
 * Header facts for one session. The store's current workspace and assistant are
 * selections, not the session's owner: they only contribute when they are the
 * same workspace. A branch is known only for the current workspace, and an
 * unattributed non-assistant session shows nothing rather than a guess.
 */
export function resolveChatHeaderContext({
  agentType,
  session: sessionContext,
  currentWorkspace,
  currentAssistant,
  assistantLabel,
}: {
  agentType: string;
  session?: SessionWorkspaceContext;
  currentWorkspace?: WorkspaceInfo | null;
  currentAssistant?: AssistantEntry | null;
  assistantLabel: string;
}): ChatHeaderContext {
  // Older hosts mark local records with sshHost=localhost, so compare both sides routed.
  const session = sessionContext && normalizeWorkspaceRouting(sessionContext);
  const sessionIsCurrentAssistant = sameWorkspace(session, currentAssistant);
  if (isClawAgent(agentType) || session?.workspace_kind === 'assistant' || sessionIsCurrentAssistant) {
    const selectedAssistant = !session || sessionIsCurrentAssistant ? currentAssistant : undefined;
    return { workspaceName: selectedAssistant?.name.trim() || session?.name?.trim() || assistantLabel };
  }
  if (!session) return { workspaceName: '' };
  const current = currentWorkspace && sameWorkspace(session, normalizeWorkspaceRouting(currentWorkspace))
    ? currentWorkspace
    : undefined;
  return {
    workspaceName: workspaceDisplayName(
      current?.project_name || session.name,
      session.path,
      session.remote_ssh_host,
      session.remote_connection_id,
    ),
    gitBranch: current?.git_branch,
  };
}

function hasRemoteRouting(workspace: {
  workspace_kind?: string; remote_connection_id?: string; remote_ssh_host?: string;
}): boolean {
  const routed = normalizeWorkspaceRouting(workspace);
  return routed.workspace_kind === 'remote'
    || Boolean(routed.remote_connection_id)
    || Boolean(routed.remote_ssh_host);
}

/**
 * Whether the open session may run on an SSH workspace, which keeps rollback off.
 * Only Claw/assistant or explicit routing facts on the session can decide alone.
 * A path-only context (for example an old cached row) is unknown, so it stays
 * remote if the selected workspace is remote or a known workspace with the same
 * ID or root is remote.
 */
export function isRemoteSessionWorkspace(
  agentType: string,
  session: SessionWorkspaceContext | undefined,
  currentWorkspace: WorkspaceInfo | null | undefined,
  knownWorkspaces: readonly RecentWorkspaceEntry[] = [],
): boolean {
  if (isClawAgent(agentType) || session?.workspace_kind === 'assistant') return false;
  if (session && (session.workspace_kind || session.remote_connection_id || session.remote_ssh_host)) {
    return hasRemoteRouting(session);
  }
  if (currentWorkspace && hasRemoteRouting(currentWorkspace)) return true;
  if (!session) return false;
  const root = normalizedLegacyRoot(session.path);
  return knownWorkspaces.some((workspace) => hasRemoteRouting(workspace) && (
    (Boolean(session.workspace_id) && workspace.workspace_id === session.workspace_id)
    || (Boolean(root) && normalizedLegacyRoot(workspace.path) === root)
  ));
}
