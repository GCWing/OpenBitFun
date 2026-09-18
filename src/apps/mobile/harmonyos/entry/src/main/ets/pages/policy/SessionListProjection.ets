import { RecentWorkspaceEntry, RemoteSession, RemoteWorkspaceIdentity } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { LegacyWorkspaceCompatibility } from '../../services/LegacyWorkspaceCompatibility';
import { remoteWorkspaceIdentityMatches, remoteWorkspaceKey } from '../../services/RemoteSessionIdentity';
import { TimeFormat } from '../../services/TimeFormat';
import { ConversationSessionFilterPolicy } from './ConversationSessionFilterPolicy';

/** Everything the sidebar's grouping depends on. */
export interface SessionListInputs {
  sessions: RemoteSession[];
  query: string;
  sortMode: string;
  workspaceName: string;
  workspacePath: string;
  /** Stable record ID of the active workspace; absent on pre-ID hosts. */
  workspaceId?: string;
  workspaceConnectionId?: string;
  workspaceSshHost?: string;
  workspaceKind: string;
  recentWorkspaces: RecentWorkspaceEntry[];
  workspaceFilter: string;
  agentFilter: string;
  statusFilter: string;
  showWorkspaceMetadata: boolean;
  showUpdatedMetadata: boolean;
  showStatusMetadata: boolean;
}

/**
 * The session list, already filtered, grouped and labelled.
 *
 * Every array here is shared, not copied, and must be treated as read-only:
 * a cache hands the same instance to every caller until the inputs change.
 */
export interface SessionListProjection {
  filtered: RemoteSession[];
  chats: RemoteSession[];
  byTime: RemoteSession[];
  today: RemoteSession[];
  yesterday: RemoteSession[];
  earlier: RemoteSession[];
  projects: RecentWorkspaceEntry[];
  /** Keyed by `remoteWorkspaceKey` of the owning project entry. */
  projectSessions: Map<string, RemoteSession[]>;
  metadata: Map<string, string>;
  hasActiveFilter: boolean;
}

const EMPTY_SESSIONS: RemoteSession[] = [];

/** The catalog rows and current workspace, resolved once per projection. */
interface WorkspaceAttribution {
  /** Every reference the legacy resolver may attribute an ID-less session to. */
  catalog: RemoteWorkspaceIdentity[];
  /** Section keys of assistant-kind rows. */
  assistantKeys: Set<string>;
  /** The active workspace as a catalog row, when the host has one open. */
  current: RecentWorkspaceEntry | undefined;
}

/**
 * Turns the raw session list into the shape the sidebar renders, in one pass.
 *
 * The sidebar used to derive this inline, and its builders asked for the
 * derived values rather than holding them: `filteredSessions()` alone was
 * reached around twenty times per build — once per section header, once per
 * project group, three times per row — and re-scanned the whole array every
 * time, each scan re-deciding whether a session was an assistant session by
 * searching the recent-workspace list again. Traced on device, one selection
 * change spent 690ms inside the list's rerender with no child layout beneath
 * it: all of it was this arithmetic, run again for inputs that had not moved.
 */
export class SessionListProjector {
  static project(inputs: SessionListInputs): SessionListProjection {
    const attribution = SessionListProjector.workspaceAttribution(inputs);
    const hasActiveFilter = inputs.query.trim().length > 0 || inputs.workspaceFilter.length > 0 ||
      inputs.agentFilter.length > 0 || inputs.statusFilter.length > 0;
    const wantsMetadata = inputs.showWorkspaceMetadata || inputs.showUpdatedMetadata || inputs.showStatusMetadata;

    const filtered: RemoteSession[] = [];
    const chats: RemoteSession[] = [];
    const projectSessions: Map<string, RemoteSession[]> = new Map();
    const metadata: Map<string, string> = new Map();
    const nowMs = Date.now();
    const projectEntries = SessionListProjector.projectEntries(inputs, attribution);
    // Sessions pinned to a workspace ID land in their section by one map
    // lookup; only ID-less sessions pay for the legacy resolver.
    const keysByWorkspaceId: Map<string, string> = new Map();
    projectEntries.forEach((entry: RecentWorkspaceEntry) => {
      if (entry.workspaceId) {
        keysByWorkspaceId.set(entry.workspaceId, remoteWorkspaceKey(entry));
      }
    });

    inputs.sessions.forEach((item: RemoteSession) => {
      // Decided once and carried through the rest of the pass. It is the
      // expensive predicate — it searches the recent-workspace list — and it
      // feeds the filter, the chat/project split and the agent grouping alike.
      const assistant = SessionListProjector.isAssistantSession(item, inputs, attribution);
      const matches = ConversationSessionFilterPolicy.matches(
        item,
        inputs.query,
        inputs.workspacePath,
        inputs.workspaceFilter,
        inputs.agentFilter,
        inputs.statusFilter,
        assistant
      );
      if (!matches) {
        return;
      }
      filtered.push(item);
      if (assistant) {
        chats.push(item);
      } else {
        const key = SessionListProjector.sectionKey(item, inputs, attribution, projectEntries, keysByWorkspaceId);
        const bucket = projectSessions.get(key);
        if (bucket === undefined) {
          projectSessions.set(key, [item]);
        } else {
          bucket.push(item);
        }
      }
      if (wantsMetadata) {
        metadata.set(item.id, SessionListProjector.metadataText(item, inputs, nowMs));
      }
    });

    const projects = SessionListProjector.visibleProjectEntries(projectEntries, hasActiveFilter, projectSessions);
    // Sorting by time parses two timestamps per session per comparison, so it
    // stays behind the mode that asks for it.
    const byTime = inputs.sortMode === 'time' ? SessionListProjector.sortByTime(filtered) : EMPTY_SESSIONS;

    return {
      filtered,
      chats,
      byTime,
      today: SessionListProjector.bucket(byTime, 'today', nowMs),
      yesterday: SessionListProjector.bucket(byTime, 'yesterday', nowMs),
      earlier: SessionListProjector.bucket(byTime, 'earlier', nowMs),
      projects,
      projectSessions,
      metadata,
      hasActiveFilter
    };
  }

  /**
   * The sessions filed under a workspace, or an empty list when there are none.
   *
   * A reference with an ID reads its section directly. A pre-ID reference is
   * attributed to a project entry through the legacy resolver first, so a
   * trailing slash or a missing connection id cannot hide a section.
   */
  static sessionsForProject(projection: SessionListProjection, workspace: RemoteWorkspaceIdentity): RemoteSession[] {
    const direct = projection.projectSessions.get(remoteWorkspaceKey(workspace));
    if (direct !== undefined) {
      return direct;
    }
    if (workspace.workspaceId) {
      return EMPTY_SESSIONS;
    }
    const owner = projection.projects.find((entry: RecentWorkspaceEntry): boolean =>
      remoteWorkspaceIdentityMatches(workspace, entry, projection.projects));
    const bucket = owner === undefined ? undefined : projection.projectSessions.get(remoteWorkspaceKey(owner));
    return bucket === undefined ? EMPTY_SESSIONS : bucket;
  }

  /** The key a project entry's section is filed under. */
  static sectionKeyFor(entry: RemoteWorkspaceIdentity): string {
    return remoteWorkspaceKey(entry);
  }

  static metadataFor(projection: SessionListProjection, sessionId: string): string {
    const value = projection.metadata.get(sessionId);
    return value === undefined ? '' : value;
  }

  static empty(): SessionListProjection {
    return {
      filtered: EMPTY_SESSIONS,
      chats: EMPTY_SESSIONS,
      byTime: EMPTY_SESSIONS,
      today: EMPTY_SESSIONS,
      yesterday: EMPTY_SESSIONS,
      earlier: EMPTY_SESSIONS,
      projects: [],
      projectSessions: new Map(),
      metadata: new Map(),
      hasActiveFilter: false
    };
  }

  /**
   * The active workspace as a catalog row.
   *
   * The page state may carry less than the catalog does — an older cache
   * without the connection id, or a host that has not sent the ID — so an
   * ID-less current workspace is completed from its unique catalog match.
   */
  private static currentWorkspaceEntry(inputs: SessionListInputs): RecentWorkspaceEntry | undefined {
    const workspaceId = inputs.workspaceId?.trim() || '';
    if (inputs.workspacePath.length === 0 && workspaceId.length === 0) {
      return undefined;
    }
    const reference: RemoteWorkspaceIdentity = {
      workspaceId: workspaceId.length > 0 ? workspaceId : undefined,
      path: inputs.workspacePath,
      remoteConnectionId: inputs.workspaceConnectionId?.trim() || undefined,
      remoteSshHost: inputs.workspaceSshHost?.trim() || undefined
    };
    const resolved = LegacyWorkspaceCompatibility.resolve(reference, inputs.recentWorkspaces);
    return {
      workspaceId: reference.workspaceId || resolved?.workspaceId,
      path: inputs.workspacePath.length > 0 ? inputs.workspacePath : (resolved?.path || ''),
      name: inputs.workspaceName,
      remoteConnectionId: reference.remoteConnectionId !== undefined ? reference.remoteConnectionId : resolved?.remoteConnectionId,
      remoteSshHost: reference.remoteSshHost !== undefined ? reference.remoteSshHost : resolved?.remoteSshHost,
      lastOpened: '',
      workspaceKind: inputs.workspaceKind.toLowerCase() === 'assistant' ? 'assistant' : 'normal'
    };
  }

  private static workspaceAttribution(inputs: SessionListInputs): WorkspaceAttribution {
    const current = SessionListProjector.currentWorkspaceEntry(inputs);
    const catalog: RemoteWorkspaceIdentity[] = [];
    const assistantKeys: Set<string> = new Set();
    inputs.recentWorkspaces.forEach((item: RecentWorkspaceEntry) => {
      catalog.push(item);
      if (item.workspaceKind.toLowerCase() === 'assistant') {
        assistantKeys.add(remoteWorkspaceKey(item));
      }
    });
    if (current !== undefined) {
      // The current workspace joins the catalog only when no row already
      // names it; a duplicate would make every path lookup ambiguous.
      const known = inputs.recentWorkspaces.some((item: RecentWorkspaceEntry): boolean =>
        remoteWorkspaceIdentityMatches(item, current, inputs.recentWorkspaces));
      if (!known) {
        catalog.push(current);
      }
      if (current.workspaceKind === 'assistant') {
        assistantKeys.add(remoteWorkspaceKey(current));
      }
    }
    return { catalog, assistantKeys, current };
  }

  /**
   * Whether a reference names an assistant workspace.
   *
   * Kind is a fact of the catalog row, so the reference is attributed to its
   * row first: by ID when it has one, otherwise through the legacy resolver.
   * An unresolvable reference is not an assistant.
   */
  private static isAssistantWorkspace(reference: RemoteWorkspaceIdentity, attribution: WorkspaceAttribution): boolean {
    if (attribution.assistantKeys.size === 0) {
      return false;
    }
    if (reference.workspaceId) {
      return attribution.assistantKeys.has(remoteWorkspaceKey(reference));
    }
    const resolved = LegacyWorkspaceCompatibility.resolve(reference, attribution.catalog);
    return resolved !== undefined && attribution.assistantKeys.has(remoteWorkspaceKey(resolved));
  }

  private static isAssistantSession(
    item: RemoteSession,
    inputs: SessionListInputs,
    attribution: WorkspaceAttribution
  ): boolean {
    const agentType = (item.agentType ? item.agentType : '').toLowerCase();
    if (agentType === 'claw' || agentType === 'assistant' || agentType === 'chat') {
      return true;
    }
    if (item.workspaceIdentity) {
      return SessionListProjector.isAssistantWorkspace(item.workspaceIdentity, attribution);
    }
    const path = item.workspacePath ? item.workspacePath : '';
    if (path.length === 0) {
      return inputs.workspaceKind.toLowerCase() === 'assistant';
    }
    return SessionListProjector.isAssistantWorkspace({ path }, attribution);
  }

  /** The section a filtered, non-assistant session is filed under. */
  private static sectionKey(
    item: RemoteSession,
    inputs: SessionListInputs,
    attribution: WorkspaceAttribution,
    projectEntries: RecentWorkspaceEntry[],
    keysByWorkspaceId: Map<string, string>
  ): string {
    const identity = item.workspaceIdentity;
    if (identity !== undefined && identity.workspaceId) {
      const known = keysByWorkspaceId.get(identity.workspaceId);
      // An ID the catalog does not list still keys its own section rather than
      // being guessed onto a row by path.
      return known === undefined ? remoteWorkspaceKey(identity) : known;
    }
    // Pre-ID sessions: a legacy reference, attributed to a row through the
    // single compatibility resolver. Sessions that name no workspace at all
    // belong to the workspace the list was fetched for.
    const path = identity !== undefined ? identity.path : (item.workspacePath ? item.workspacePath : '');
    if (path.length === 0 && identity === undefined) {
      return attribution.current !== undefined ? remoteWorkspaceKey(attribution.current) :
        remoteWorkspaceKey({ path: inputs.workspacePath });
    }
    const reference: RemoteWorkspaceIdentity = identity !== undefined ? identity : { path };
    const owner = projectEntries.find((entry: RecentWorkspaceEntry): boolean =>
      remoteWorkspaceIdentityMatches(reference, entry, attribution.catalog));
    if (owner !== undefined) {
      return remoteWorkspaceKey(owner);
    }
    const resolved = LegacyWorkspaceCompatibility.resolve(reference, attribution.catalog);
    return remoteWorkspaceKey(resolved !== undefined ? resolved : reference);
  }

  private static projectEntries(inputs: SessionListInputs, attribution: WorkspaceAttribution): RecentWorkspaceEntry[] {
    const entries: RecentWorkspaceEntry[] = [];
    const current = attribution.current;
    if (current !== undefined && current.workspaceKind !== 'assistant' && current.path.length > 0) {
      entries.push(current);
    }
    inputs.recentWorkspaces.forEach((item: RecentWorkspaceEntry) => {
      if (item.path.length === 0 || SessionListProjector.isAssistantWorkspace(item, attribution)) {
        return;
      }
      if (entries.some((entry: RecentWorkspaceEntry) => remoteWorkspaceIdentityMatches(entry, item, attribution.catalog))) {
        return;
      }
      entries.push(item);
    });
    return entries;
  }

  private static visibleProjectEntries(
    entries: RecentWorkspaceEntry[],
    hasActiveFilter: boolean,
    projectSessions: Map<string, RemoteSession[]>
  ): RecentWorkspaceEntry[] {
    if (!hasActiveFilter) {
      return entries;
    }
    // A filter narrow enough to empty a project takes that project's header off
    // the list too, so the sidebar does not read as a wall of empty groups.
    return entries.filter((item: RecentWorkspaceEntry) => {
      const bucket = projectSessions.get(remoteWorkspaceKey(item));
      return bucket !== undefined && bucket.length > 0;
    });
  }

  private static sortByTime(sessions: RemoteSession[]): RemoteSession[] {
    // Timestamps are parsed once each and sorted alongside their session, rather
    // than re-parsed inside the comparator for every comparison it makes.
    const stamped: TimestampedSession[] = sessions.map((item: RemoteSession): TimestampedSession => {
      return { session: item, timestamp: SessionListProjector.sessionTimestamp(item) };
    });
    stamped.sort((left: TimestampedSession, right: TimestampedSession) => right.timestamp - left.timestamp);
    return stamped.map((item: TimestampedSession) => item.session);
  }

  private static bucket(sessions: RemoteSession[], bucket: string, nowMs: number): RemoteSession[] {
    if (sessions.length === 0) {
      return EMPTY_SESSIONS;
    }
    return sessions.filter((item: RemoteSession) => SessionListProjector.timeBucket(item, nowMs) === bucket);
  }

  private static timeBucket(item: RemoteSession, nowMs: number): string {
    const timestamp = SessionListProjector.sessionTimestamp(item);
    if (timestamp <= 0) {
      return 'earlier';
    }
    const sessionDate = new Date(timestamp);
    const now = new Date(nowMs);
    if (SessionListProjector.sameCalendarDay(sessionDate, now)) {
      return 'today';
    }
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return SessionListProjector.sameCalendarDay(sessionDate, yesterday) ? 'yesterday' : 'earlier';
  }

  private static sessionTimestamp(item: RemoteSession): number {
    const updated = TimeFormat.timestampMs(item.updatedAt ? item.updatedAt : '');
    if (!Number.isNaN(updated) && updated > 0) {
      return updated;
    }
    const created = TimeFormat.timestampMs(item.createdAt ? item.createdAt : '');
    return !Number.isNaN(created) && created > 0 ? created : 0;
  }

  private static sameCalendarDay(left: Date, right: Date): boolean {
    return left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate();
  }

  private static metadataText(item: RemoteSession, inputs: SessionListInputs, nowMs: number): string {
    const values: string[] = [];
    if (inputs.showWorkspaceMetadata) {
      const workspace = item.workspaceName ? item.workspaceName : (item.workspacePath ? item.workspacePath : '');
      if (workspace.length > 0) {
        values.push(workspace);
      }
    }
    if (inputs.showUpdatedMetadata && !Number.isNaN(TimeFormat.timestampMs(item.updatedAt))) {
      values.push(TimeFormat.relative(item.updatedAt, nowMs));
    }
    if (inputs.showStatusMetadata && item.status.length > 0) {
      values.push(item.status === 'archived' ? RemoteI18n.t('sidebar.archived') : item.status);
    }
    return values.join(' · ');
  }
}

interface TimestampedSession {
  session: RemoteSession;
  timestamp: number;
}

/**
 * Holds the last projection and rebuilds it only when its inputs move.
 *
 * The point of the cache is the selection change: picking a session rebuilds
 * the sidebar's whole builder tree, but touches none of the inputs here, so the
 * rerender becomes a property diff over lists that were already computed.
 *
 * The fast path is reference identity on the two arrays. When that misses —
 * a caller handing out a freshly filtered array each build would defeat it —
 * the contents are compared field by field, which is still one cheap pass
 * instead of twenty expensive ones.
 */
export class SessionListProjectionCache {
  private key: string = ' ';
  private sessionsRef: RemoteSession[] = EMPTY_SESSIONS;
  private workspacesRef: RecentWorkspaceEntry[] = [];
  private sessionFingerprint: string[] = [];
  private workspaceFingerprint: string[] = [];
  private projection: SessionListProjection = SessionListProjector.empty();

  get(inputs: SessionListInputs): SessionListProjection {
    const key = SessionListProjectionCache.scalarKey(inputs);
    if (key === this.key && inputs.sessions === this.sessionsRef &&
      inputs.recentWorkspaces === this.workspacesRef) {
      return this.projection;
    }
    const sessionFingerprint = SessionListProjectionCache.sessionFingerprint(inputs.sessions);
    const workspaceFingerprint = SessionListProjectionCache.workspaceFingerprint(inputs.recentWorkspaces);
    if (key === this.key &&
      SessionListProjectionCache.sameFingerprint(sessionFingerprint, this.sessionFingerprint) &&
      SessionListProjectionCache.sameFingerprint(workspaceFingerprint, this.workspaceFingerprint)) {
      // Same contents behind a new array. Adopt the new references so the next
      // call takes the identity fast path.
      this.sessionsRef = inputs.sessions;
      this.workspacesRef = inputs.recentWorkspaces;
      return this.projection;
    }
    this.key = key;
    this.sessionsRef = inputs.sessions;
    this.workspacesRef = inputs.recentWorkspaces;
    this.sessionFingerprint = sessionFingerprint;
    this.workspaceFingerprint = workspaceFingerprint;
    this.projection = SessionListProjector.project(inputs);
    return this.projection;
  }

  private static scalarKey(inputs: SessionListInputs): string {
    // Relative timestamps are rendered from the projection, so when they are on
    // screen the minute they were rendered in is part of what the projection
    // depends on. Off — which is the default — nothing here moves on its own.
    const minute = inputs.showUpdatedMetadata ? Math.floor(Date.now() / 60000) : 0;
    return `${inputs.query} ${inputs.sortMode} ${inputs.workspaceName} ${inputs.workspacePath}` +
      ` ${inputs.workspaceId || ''} ${inputs.workspaceConnectionId || ''} ${inputs.workspaceSshHost || ''}` +
      ` ${inputs.workspaceKind} ${inputs.workspaceFilter} ${inputs.agentFilter}` +
      ` ${inputs.statusFilter} ${inputs.showWorkspaceMetadata ? 1 : 0}` +
      `${inputs.showUpdatedMetadata ? 1 : 0}${inputs.showStatusMetadata ? 1 : 0} ${minute}`;
  }

  private static sessionFingerprint(sessions: RemoteSession[]): string[] {
    return sessions.map((item: RemoteSession): string => {
      const identity = item.workspaceIdentity;
      return `${item.deviceId || ''}${item.id}${item.title}${item.status}${item.agentType}` +
        `${item.workspacePath}${item.workspaceName}${item.updatedAt}${item.createdAt}` +
        `${identity === undefined ? '' : remoteWorkspaceKey(identity)}`;
    });
  }

  private static workspaceFingerprint(entries: RecentWorkspaceEntry[]): string[] {
    return entries.map((item: RecentWorkspaceEntry): string => {
      return `${remoteWorkspaceKey(item)}${item.name}${item.workspaceKind}${item.remoteSshHost || ''}`;
    });
  }

  private static sameFingerprint(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) {
        return false;
      }
    }
    return true;
  }
}
