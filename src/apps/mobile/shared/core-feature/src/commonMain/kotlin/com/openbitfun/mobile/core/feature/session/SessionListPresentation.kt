package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.LegacyWorkspaceCompatibility
import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.SessionAgentTypes
import com.openbitfun.mobile.core.domain.SessionWorkspacePaths
import com.openbitfun.mobile.core.domain.identity
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

/** How the session list is carved up, from `viewSettings.grouping`. */
public enum class SessionGroupMode {
    /** Projects first, then the chat sessions that belong to no project. */
    PROJECT,

    /** One flat list, newest first, split into today / yesterday / earlier. */
    TIME,

    /** Like [PROJECT] with the chat group lifted to the top. */
    CHAT,
}

/** Which of the three kinds of session a row is, from `agentGroup`. */
public enum class SessionAgentGroup { CHAT, CODE, COWORK }

/**
 * The statuses worth a word of our own.
 *
 * Everything else is [RAW]: the desktop invents status strings faster than
 * either client can translate them, and showing one verbatim is more honest
 * than mapping it onto the nearest word we happen to have.
 */
public enum class SessionStatusLabel { RUNNING, READY, ARCHIVED, RAW }

/**
 * A workspace the list can be filtered down to.
 *
 * [key] is the value a filter stores: the workspace ID when the host gave one,
 * otherwise the legacy `(connection, ssh host, path)` triple. [path] is display
 * text and the upgrade fallback for filters persisted before IDs existed.
 */
public data class SessionWorkspaceOption public constructor(
    public val path: String,
    public val name: String,
    public val workspaceId: String?,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
) {
    public constructor(path: String, name: String) : this(path, name, null, null, null)

    public val identity: RemoteWorkspaceIdentity
        get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)

    /** Stable filter and section key: `workspaceId ?: legacy triple`. */
    public val key: String get() = identity.key
}

/**
 * Where the list is being shown from.
 *
 * The selected workspace is not just another entry: it is the fallback for
 * sessions the desktop sent no `workspacePath` for, so a session created before
 * the desktop started reporting paths still lands in the project the user is
 * looking at. Its identity fields let sessions that carry a workspace ID be
 * matched by ID alone; pre-ID hosts leave them null.
 */
public data class SessionWorkspaceContext public constructor(
    public val selectedPath: String,
    public val selectedName: String,
    public val selectedKind: String,
    public val recent: List<RecentWorkspace>,
    public val selectedWorkspaceId: String?,
    public val selectedRemoteConnectionId: String?,
    public val selectedRemoteSshHost: String?,
) {
    public constructor(
        selectedPath: String,
        selectedName: String,
        selectedKind: String,
        recent: List<RecentWorkspace>,
    ) : this(selectedPath, selectedName, selectedKind, recent, null, null, null)

    /** The selected workspace as a reference, or null when nothing is selected. */
    public val selectedIdentity: RemoteWorkspaceIdentity?
        get() = if (selectedPath.isEmpty() && selectedWorkspaceId.isNullOrEmpty()) null
        else RemoteWorkspaceIdentity(selectedPath, selectedRemoteConnectionId, selectedRemoteSshHost, selectedWorkspaceId)
}

/**
 * The view settings, as one value.
 *
 * A record rather than five parameters because these travel together — the
 * sheet edits them as a unit and every query below needs all of them. An empty
 * string means "no filter" for the two free-text filters, matching the source.
 */
public data class SessionListOptions public constructor(
    public val groupMode: SessionGroupMode,
    public val query: String,
    public val workspaceFilter: String,
    public val agentFilter: SessionAgentGroup?,
    public val statusFilter: String,
)

/** One headed group of rows. */
public sealed interface SessionListSection {
    public val sessions: List<RemoteSession>

    public data class Chat public constructor(
        override val sessions: List<RemoteSession>,
    ) : SessionListSection

    /**
     * One project heading. [key] is `workspaceId ?: legacy triple` and is what
     * the platforms should key collapse state and create menus by; [path] is
     * display text, since two open workspaces may share a root.
     */
    public data class Project public constructor(
        public val path: String,
        public val name: String,
        override val sessions: List<RemoteSession>,
        public val workspaceId: String?,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
    ) : SessionListSection {
        public constructor(path: String, name: String, sessions: List<RemoteSession>) :
            this(path, name, sessions, null, null, null)

        public val identity: RemoteWorkspaceIdentity
            get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)

        public val key: String get() = identity.key
    }

    public data class Today public constructor(
        override val sessions: List<RemoteSession>,
    ) : SessionListSection

    public data class Yesterday public constructor(
        override val sessions: List<RemoteSession>,
    ) : SessionListSection

    public data class Earlier public constructor(
        override val sessions: List<RemoteSession>,
    ) : SessionListSection
}

/**
 * The list as it should be drawn.
 *
 * [filtered] separates the two empty states: "this desktop has no sessions" and
 * "your filters hid them all" need different words and different buttons, and
 * only the caller of [SessionListPresentation.view] knows which it is.
 */
public data class SessionListView public constructor(
    public val sections: List<SessionListSection>,
    public val filtered: Boolean,
)

/** One section after the incremental three-row disclosure is applied. */
public data class SessionListBatch public constructor(
    public val visible: List<RemoteSession>,
    public val remaining: Int,
    public val nextCount: Int,
)

/**
 * Port of the grouping and filtering in `pages/components/RemoteSessionList.ets`
 * and the option lists in `pages/components/ConversationViewSettings.ets`,
 * together with `pages/policy/ConversationSessionFilterPolicy.ets`.
 *
 * It sits in `core-feature` rather than `core-domain` for the usual reason: the
 * app has to `when` over [SessionListSection] and [SessionAgentGroup] to draw a
 * header, and the architecture guardrail keeps `core-domain` off the app's
 * import list. The rules that are only about strings — path normalisation, which
 * `agent_type` values mean "chat" — stay in `core-domain`.
 *
 * Two deliberate deviations from the source:
 *
 * 1. Workspace identity is `workspaceId ?: (connection, ssh host, path)`, never
 *    the path alone. Sections, options, filters, and the assistant decision all
 *    resolve a reference through [LegacyWorkspaceCompatibility]: IDs compare by
 *    ID, pre-ID references by normalised root plus saved-connection identity, and
 *    an ambiguous root is filed nowhere. The ArkTS version compares raw paths,
 *    which both mis-groups a trailing slash and merges two workspaces that share
 *    a root. Filters persisted as bare paths keep matching by path.
 * 2. Sections are returned whole and [batch] applies the incremental disclosure
 *    separately. Group identity and filtering stay stable while each platform
 *    owns the transient count of how many batches the user has opened.
 */
public object SessionListPresentation {
    /** Groups [sessions] the way [options] asks for; [nowMs] dates the buckets. */
    public fun view(
        sessions: List<RemoteSession>,
        workspace: SessionWorkspaceContext,
        options: SessionListOptions,
        nowMs: Long,
    ): SessionListView {
        val filtered = sessions.filter { matches(it, workspace, options) }
        val active = options.hasActiveFilter()
        val (chat, project) = filtered.partition { isAssistant(it, workspace) }
        val sections = when (options.groupMode) {
            SessionGroupMode.TIME -> timeSections(filtered, nowMs)
            SessionGroupMode.CHAT ->
                chatSections(chat) + projectSections(project, workspace, active)
            SessionGroupMode.PROJECT ->
                projectSections(project, workspace, active) + chatSections(chat)
        }
        return SessionListView(sections = sections, filtered = active)
    }

    /**
     * Every workspace the filter could name: the selected one, the desktop's
     * recents, and any workspace only a session knows about.
     */
    public fun workspaceOptions(
        sessions: List<RemoteSession>,
        workspace: SessionWorkspaceContext,
    ): List<SessionWorkspaceOption> {
        val catalog = WorkspaceCatalog(workspace)
        val result = mutableListOf<SessionWorkspaceOption>()
        fun add(identity: RemoteWorkspaceIdentity, name: String) {
            if (identity.path.isEmpty()) return
            if (result.any { it.key == identity.key }) return
            result += SessionWorkspaceOption(
                path = identity.path,
                name = name.ifBlank { SessionWorkspacePaths.basename(identity.path) },
                workspaceId = identity.workspaceId,
                remoteConnectionId = identity.remoteConnectionId,
                remoteSshHost = identity.remoteSshHost,
            )
        }
        catalog.rows.forEach { add(it.identity, it.name) }
        sessions.forEach { session ->
            // A workspace only a session knows about is still offered; one the
            // catalog already lists must not appear twice under a pre-ID reference.
            val own = ownIdentity(session) ?: return@forEach
            val known = catalog.resolve(own)
            if (known != null) add(known.identity, known.name) else add(own, session.workspaceName.orEmpty())
        }
        return result
    }

    /** The agent groups actually present, in the source's fixed order. */
    public fun agentGroups(
        sessions: List<RemoteSession>,
        workspace: SessionWorkspaceContext,
    ): List<SessionAgentGroup> {
        val present = sessions.map { agentGroup(it, workspace) }.toSet()
        return listOf(
            SessionAgentGroup.CHAT,
            SessionAgentGroup.CODE,
            SessionAgentGroup.COWORK,
        ).filter { it in present }
    }

    /** The statuses actually present, lowercased and sorted. */
    public fun statusOptions(sessions: List<RemoteSession>): List<String> =
        sessions.map { it.status.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .distinct()
            .sorted()

    /** Reveals three rows initially and three more for every completed step. */
    public fun batch(sessions: List<RemoteSession>, revealedSteps: Int): SessionListBatch {
        val limit = INITIAL_VISIBLE + revealedSteps.coerceAtLeast(0) * REVEAL_STEP
        val visible = sessions.take(limit)
        val remaining = (sessions.size - visible.size).coerceAtLeast(0)
        return SessionListBatch(
            visible = visible,
            remaining = remaining,
            nextCount = minOf(REVEAL_STEP, remaining),
        )
    }

    /** Which of our words, if any, names [status]. */
    public fun statusLabel(status: String): SessionStatusLabel =
        when (status.trim().lowercase()) {
            "active", "running" -> SessionStatusLabel.RUNNING
            "ready", "idle" -> SessionStatusLabel.READY
            ARCHIVED -> SessionStatusLabel.ARCHIVED
            else -> SessionStatusLabel.RAW
        }

    /** Which group a single row belongs to; exposed because the row shows it. */
    public fun agentGroup(
        session: RemoteSession,
        workspace: SessionWorkspaceContext,
    ): SessionAgentGroup = when {
        isAssistant(session, workspace) -> SessionAgentGroup.CHAT
        SessionAgentTypes.isCowork(session.agentType) -> SessionAgentGroup.COWORK
        else -> SessionAgentGroup.CODE
    }

    private fun SessionListOptions.hasActiveFilter(): Boolean =
        query.trim().isNotEmpty() ||
            workspaceFilter.isNotEmpty() ||
            agentFilter != null ||
            statusFilter.isNotEmpty()

    private fun matches(
        session: RemoteSession,
        workspace: SessionWorkspaceContext,
        options: SessionListOptions,
    ): Boolean {
        // An archived session is not hidden by a filter — it is not part of the
        // list at all, the way the source drops it before anything else runs.
        if (session.id.isEmpty() || session.status == ARCHIVED) return false

        val query = options.query.trim().lowercase()
        if (query.isNotEmpty() && !session.title.lowercase().contains(query)) return false

        val assistant = isAssistant(session, workspace)
        if (options.workspaceFilter.isNotEmpty() &&
            !matchesWorkspaceFilter(session, workspace, assistant, options.workspaceFilter)
        ) {
            return false
        }

        if (options.agentFilter != null && agentGroup(session, workspace) != options.agentFilter) {
            return false
        }

        val status = session.status.trim().lowercase()
        return options.statusFilter.isEmpty() || status == options.statusFilter
    }

    /**
     * A filter stores a [SessionWorkspaceOption.key]. Settings persisted before
     * workspace IDs hold a bare path; those keep matching by path so an upgrade
     * does not silently clear the user's filter.
     */
    private fun matchesWorkspaceFilter(
        session: RemoteSession,
        workspace: SessionWorkspaceContext,
        assistant: Boolean,
        filter: String,
    ): Boolean {
        val catalog = WorkspaceCatalog(workspace)
        val identity = sessionIdentity(session, workspace, assistant)
        val key = identity?.let { catalog.resolve(it)?.identity?.key ?: it.key }
        if (key == filter) return true
        return SessionWorkspacePaths.equal(identity?.path.orEmpty(), filter)
    }

    /** The reference the session itself carries: its identity, else its bare path. */
    private fun ownIdentity(session: RemoteSession): RemoteWorkspaceIdentity? {
        session.workspaceIdentity?.takeIf { it.path.isNotEmpty() || !it.workspaceId.isNullOrEmpty() }?.let { return it }
        val path = session.workspacePath.orEmpty()
        return if (path.isEmpty()) null else RemoteWorkspaceIdentity(path, null, null)
    }

    /**
     * A chat session has no project of its own, so it must not inherit the
     * selected workspace the way a code session does.
     */
    private fun sessionIdentity(
        session: RemoteSession,
        workspace: SessionWorkspaceContext,
        assistant: Boolean,
    ): RemoteWorkspaceIdentity? {
        ownIdentity(session)?.let { return it }
        return if (assistant) null else workspace.selectedIdentity
    }

    private fun isAssistant(session: RemoteSession, workspace: SessionWorkspaceContext): Boolean =
        SessionAgentTypes.isAssistant(session.agentType) ||
            isAssistantWorkspace(session, workspace)

    /**
     * Whether the session's workspace is an assistant one, decided by the
     * catalog row's `workspaceKind` after resolving the reference by ID first
     * and by the legacy triple only for pre-ID references. Paths alone never
     * decide: an assistant and a project may share a root.
     */
    private fun isAssistantWorkspace(session: RemoteSession, workspace: SessionWorkspaceContext): Boolean {
        val selectedIsAssistant = workspace.selectedKind.lowercase() == ASSISTANT
        // No reference at all means "wherever we are", which is the selected one.
        val own = ownIdentity(session) ?: return selectedIsAssistant
        return WorkspaceCatalog(workspace).resolve(own)?.kind?.lowercase() == ASSISTANT
    }

    private fun chatSections(chat: List<RemoteSession>): List<SessionListSection> =
        if (chat.isEmpty()) emptyList() else listOf(SessionListSection.Chat(chat))

    private fun projectSections(
        project: List<RemoteSession>,
        workspace: SessionWorkspaceContext,
        activeFilter: Boolean,
    ): List<SessionListSection> {
        val catalog = WorkspaceCatalog(workspace)
        val entries = catalog.rows.filterNot { it.kind.lowercase() == ASSISTANT }
        // Each session is filed once, under the row its reference resolves to.
        // Ambiguous pre-ID paths resolve to nothing and stay out of every heading.
        val filed = project.groupBy { session ->
            val identity = sessionIdentity(session, workspace, assistant = false)
            identity?.let { catalog.resolve(it)?.identity?.key }
        }
        return entries.mapNotNull { entry ->
            val rows = filed[entry.identity.key].orEmpty()
            // With no filter on, an empty project still gets a heading: it is
            // how the user creates the first session in it. With one on, an
            // empty heading is just noise the filter was meant to remove.
            if (activeFilter && rows.isEmpty()) {
                null
            } else {
                SessionListSection.Project(
                    path = entry.identity.path,
                    name = entry.name,
                    sessions = rows,
                    workspaceId = entry.identity.workspaceId,
                    remoteConnectionId = entry.identity.remoteConnectionId,
                    remoteSshHost = entry.identity.remoteSshHost,
                )
            }
        }
    }

    private class CatalogRow(val identity: RemoteWorkspaceIdentity, val name: String, val kind: String)

    /**
     * The selected workspace and the desktop's recents as one catalog keyed by
     * `workspaceId ?: legacy triple`, with the single resolver every grouping
     * decision goes through.
     */
    private class WorkspaceCatalog(workspace: SessionWorkspaceContext) {
        val rows: List<CatalogRow>
        private val identities: List<RemoteWorkspaceIdentity>

        init {
            val result = mutableListOf<CatalogRow>()
            fun add(identity: RemoteWorkspaceIdentity, name: String, kind: String) {
                if (identity.path.isEmpty() && name.isEmpty()) return
                if (result.any { it.identity.key == identity.key }) return
                result += CatalogRow(identity, name.ifBlank { SessionWorkspacePaths.basename(identity.path) }, kind)
            }
            workspace.selectedIdentity?.let { add(it, workspace.selectedName, workspace.selectedKind) }
            workspace.recent.forEach { if (it.path.isNotEmpty()) add(it.identity(), it.name, it.kind) }
            rows = result
            identities = result.map { it.identity }
        }

        /** ID first; an unknown ID is nothing, never a same-path row. */
        fun resolve(reference: RemoteWorkspaceIdentity): CatalogRow? {
            val resolved = LegacyWorkspaceCompatibility.resolve(reference, identities) ?: return null
            return rows.firstOrNull { it.identity.key == resolved.key }
        }
    }

    private fun timeSections(sessions: List<RemoteSession>, nowMs: Long): List<SessionListSection> {
        val ordered = sessions.sortedByDescending { timestamp(it) }
        val today = mutableListOf<RemoteSession>()
        val yesterday = mutableListOf<RemoteSession>()
        val earlier = mutableListOf<RemoteSession>()
        val zone = TimeZone.currentSystemDefault()
        val nowDate = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(zone).date
        ordered.forEach { session ->
            val stamp = timestamp(session)
            val bucket = if (stamp <= 0L) {
                earlier
            } else {
                val date = Instant.fromEpochMilliseconds(stamp).toLocalDateTime(zone).date
                when (nowDate.toEpochDays() - date.toEpochDays()) {
                    0L -> today
                    1L -> yesterday
                    else -> earlier
                }
            }
            bucket += session
        }
        return listOfNotNull(
            today.takeIf { it.isNotEmpty() }?.let { SessionListSection.Today(it) },
            yesterday.takeIf { it.isNotEmpty() }?.let { SessionListSection.Yesterday(it) },
            earlier.takeIf { it.isNotEmpty() }?.let { SessionListSection.Earlier(it) },
        )
    }

    /** `updatedAt` if the desktop sent a readable one, else `createdAt`, else 0. */
    private fun timestamp(session: RemoteSession): Long {
        val updated = SessionTimePresentation.timestampMs(session.updatedAt)
        if (updated != null && updated > 0L) return updated
        val created = SessionTimePresentation.timestampMs(session.createdAt)
        return if (created != null && created > 0L) created else 0L
    }

    private const val ARCHIVED: String = "archived"
    private const val ASSISTANT: String = "assistant"
    private const val INITIAL_VISIBLE: Int = 3
    private const val REVEAL_STEP: Int = 3
}
