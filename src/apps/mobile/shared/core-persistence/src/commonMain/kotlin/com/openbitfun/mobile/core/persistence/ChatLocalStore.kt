package com.openbitfun.mobile.core.persistence

import app.cash.sqldelight.db.SqlDriver
import com.openbitfun.mobile.core.persistence.db.Chat_session
import com.openbitfun.mobile.core.persistence.db.MobileDatabase
import kotlinx.serialization.Serializable

public data class PersistedChatSession public constructor(
    public val sessionId: String,
    public val title: String,
    public val agentType: String,
    public val status: String,
    public val updatedAt: String,
    public val createdAt: String,
    public val messageCount: Int,
    /** At most one session of a kind is pinned; see [ChatLocalStore.pinSession]. */
    public val pinned: Boolean,
)

public data class PersistedChatMessage public constructor(
    public val messageId: String,
    public val sessionId: String,
    public val role: String,
    public val text: String,
    public val status: String,
    public val timestamp: String?,
    public val thinking: String?,
    public val payloadJson: String,
)

public interface ChatLocalStore {
    /** Sessions of one kind, newest first. */
    public fun listSessions(agentType: String): List<PersistedChatSession>

    public fun loadSession(sessionId: String): PersistedChatSession?

    public fun loadMessages(sessionId: String): List<PersistedChatMessage>

    public fun saveSession(session: PersistedChatSession)

    public fun saveMessage(message: PersistedChatMessage)

    /**
     * Moves the pin, which at most one session of [agentType] may hold.
     *
     * Exclusive rather than a per-row flag because the sidebar shows a single
     * pinned slot above the recent list; two pinned rows would have no order
     * between them and no room to show both.
     */
    public fun pinSession(agentType: String, sessionId: String, pinned: Boolean)

    /** Writes only the status, so archiving cannot race a transcript being saved. */
    public fun setSessionStatus(sessionId: String, status: String)

    /** Removes the session row and every message that belonged to it. */
    public fun deleteSession(sessionId: String)
}

public class SqlDelightChatLocalStore public constructor(
    driver: SqlDriver,
) : ChatLocalStore {
    private val queries = MobileDatabase(driver).mobileQueries

    override fun listSessions(agentType: String): List<PersistedChatSession> =
        queries.selectSessionsByAgent(agentType).executeAsList().map(::session)

    override fun loadSession(sessionId: String): PersistedChatSession? =
        queries.selectSession(sessionId).executeAsOneOrNull()?.let(::session)

    override fun loadMessages(sessionId: String): List<PersistedChatMessage> =
        queries.selectMessages(sessionId).executeAsList().map { row ->
            PersistedChatMessage(
                messageId = row.message_id,
                sessionId = row.session_id,
                role = row.role,
                text = row.text,
                status = row.status,
                timestamp = row.timestamp,
                thinking = row.thinking,
                payloadJson = row.payload_json,
            )
        }

    override fun saveSession(session: PersistedChatSession) {
        queries.upsertSession(
            session.sessionId,
            session.title,
            session.agentType,
            session.status,
            session.updatedAt,
            session.createdAt,
            session.messageCount.toLong(),
            null,
            null,
            if (session.pinned) 1L else 0L,
        )
    }

    override fun pinSession(agentType: String, sessionId: String, pinned: Boolean) {
        queries.transaction {
            queries.clearPinnedSessions(agentType)
            if (pinned) queries.setPinnedSession(sessionId)
        }
    }

    override fun setSessionStatus(sessionId: String, status: String) {
        queries.setSessionStatus(status, sessionId)
    }

    override fun saveMessage(message: PersistedChatMessage) {
        queries.upsertMessage(
            message.messageId,
            message.sessionId,
            message.role,
            message.text,
            message.status,
            message.timestamp,
            message.thinking,
            message.payloadJson,
        )
    }

    override fun deleteSession(sessionId: String) {
        queries.transaction {
            queries.deleteMessagesForSession(sessionId)
            queries.deleteSession(sessionId)
        }
    }

    private fun session(row: Chat_session): PersistedChatSession = PersistedChatSession(
        sessionId = row.session_id,
        title = row.title,
        agentType = row.agent_type,
        status = row.status,
        updatedAt = row.updated_at,
        createdAt = row.created_at,
        messageCount = row.message_count.toInt(),
        pinned = row.pinned != 0L,
    )
}

@Serializable
public data class PersistedWorkspaceIdentity(
    public val path: String = "",
    public val remoteConnectionId: String? = null,
    public val remoteSshHost: String? = null,
    public val workspaceId: String? = null,
)

/**
 * Cache row identity: the workspace ID when the host gave one, else the legacy
 * `(connection, ssh host, path)` triple. Length-prefixed so embedded separators
 * cannot make two different identities collide.
 */
public fun persistedWorkspaceKey(path: String, remoteConnectionId: String?, remoteSshHost: String?, workspaceId: String?): String {
    workspaceId?.trim()?.takeIf { it.isNotEmpty() }?.let { return "workspace:${it.length}:$it" }
    val root = path.trim().let { it.trimEnd('/').ifEmpty { it } }
    return listOf(remoteConnectionId.orEmpty(), remoteSshHost.orEmpty(), root).joinToString("") { "${it.length}:$it" }
}

public val PersistedWorkspaceIdentity.key: String
    get() = persistedWorkspaceKey(path, remoteConnectionId, remoteSshHost, workspaceId)

@Serializable
public data class PersistedRemoteSession public constructor(
    public val sessionId: String = "",
    public val title: String = "",
    public val agentType: String = "",
    public val status: String = "",
    public val updatedAt: String = "",
    public val createdAt: String = "",
    public val messageCount: Int = 0,
    public val lastMessageId: String = "",
    public val workspacePath: String? = null,
    public val workspaceName: String? = null,
    /** True until a later server list observes this confirmed-created session id. */
    public val pendingConfirmed: Boolean = false,
    /** Absent on legacy records; absence must not be interpreted as local ownership. */
    public val workspaceIdentity: PersistedWorkspaceIdentity? = null,
)

@Serializable
public data class PersistedRemoteMessage public constructor(
    public val messageId: String = "",
    public val sessionId: String = "",
    public val role: String = "",
    public val text: String = "",
    public val status: String = "",
    public val timestamp: String? = null,
    public val thinking: String? = null,
    public val payloadJson: String = "{}",
)

@Serializable
public data class PersistedRemoteCursor public constructor(
    public val pollVersion: String = "",
    public val knownMessageCount: Int = 0,
    public val knownModelCatalogVersion: String = "",
)

@Serializable
public data class PersistedRemoteWorkspace public constructor(
    public val path: String = "",
    public val name: String = "",
    public val lastOpened: String = "",
    public val workspaceKind: String = "",
    public val remoteSshHost: String? = null,
    public val remoteConnectionId: String? = null,
    public val workspaceId: String? = null,
) {
    /** `workspaceId` when present, otherwise the legacy triple; see [persistedWorkspaceKey]. */
    public val key: String get() = persistedWorkspaceKey(path, remoteConnectionId, remoteSshHost, workspaceId)
}

public interface RemoteSessionListStore {
    public fun load(deviceKey: String): List<PersistedRemoteSession>
    public fun save(deviceKey: String, sessions: List<PersistedRemoteSession>, hasMore: Boolean = false)
    public fun hasMore(deviceKey: String): Boolean
}

public interface RemoteTranscriptStore {
    public fun load(deviceKey: String, sessionId: String): List<PersistedRemoteMessage>
    public fun append(deviceKey: String, sessionId: String, startSeq: Int, messages: List<PersistedRemoteMessage>)
    public fun replace(deviceKey: String, sessionId: String, messages: List<PersistedRemoteMessage>)
    public fun loadCursor(deviceKey: String, sessionId: String): PersistedRemoteCursor?
    public fun saveCursor(deviceKey: String, sessionId: String, cursor: PersistedRemoteCursor)
    public fun delete(deviceKey: String, sessionId: String)
}

public interface RemoteWorkspaceListStore {
    public fun load(deviceKey: String): List<PersistedRemoteWorkspace>
    public fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>)
}

public class SqlDelightRemoteSessionListStore public constructor(
    driver: SqlDriver,
) : RemoteSessionListStore {
    private val queries = MobileDatabase(driver).mobileQueries
    private var lastSignature = ""

    override fun load(deviceKey: String): List<PersistedRemoteSession> =
        queries.selectRemoteSessions(deviceKey).executeAsList().map { row ->
            // Rows written before the identity columns existed have NULL in all of
            // them and stay legacy: ownership is then attributed by the caller
            // through LegacyWorkspaceCompatibility, never invented here.
            val identity = row.workspace_identity_path?.let { path ->
                PersistedWorkspaceIdentity(path, row.remote_connection_id, row.remote_ssh_host, row.workspace_id)
            }
            PersistedRemoteSession(row.session_id, row.title, row.agent_type, row.status,
                row.updated_at, row.created_at, row.message_count.toInt(), row.last_message_id,
                row.workspace_path, row.workspace_name, row.pending_confirmed == 1L, identity)
        }

    override fun hasMore(deviceKey: String): Boolean =
        queries.selectRemoteSessions(deviceKey).executeAsList().firstOrNull()?.has_more == 1L

    override fun save(deviceKey: String, sessions: List<PersistedRemoteSession>, hasMore: Boolean) {
        if (deviceKey.isBlank()) return
        val kept = sessions.take(60)
        val signature = buildString {
            append(deviceKey)
            append('|')
            append(hasMore)
            kept.forEach { session ->
                append('\u0002')
                append(session.sessionId)
                append('\u0001')
                append(session.title)
                append('\u0001')
                append(session.agentType)
                append('\u0001')
                append(session.status)
                append('\u0001')
                append(session.updatedAt)
                append('\u0001')
                append(session.createdAt)
                append('\u0001')
                append(session.messageCount)
                append('\u0001')
                append(session.lastMessageId)
                append('\u0001')
                append(session.workspacePath.orEmpty())
                append('\u0001')
                append(session.workspaceName.orEmpty())
                append('\u0001')
                append(session.pendingConfirmed)
                session.workspaceIdentity?.let { identity ->
                    append('\u0001')
                    append(identity.path)
                    append('\u0001')
                    append(identity.workspaceId.orEmpty())
                    append('\u0001')
                    append(identity.remoteConnectionId.orEmpty())
                    append('\u0001')
                    append(identity.remoteSshHost.orEmpty())
                }
            }
        }
        if (signature == lastSignature) return
        queries.transaction {
            queries.deleteRemoteSessionsForDevice(deviceKey)
            kept.forEach { session ->
                val identity = session.workspaceIdentity
                queries.upsertRemoteSession(
                    deviceKey, session.sessionId, session.title, session.agentType, session.status,
                    session.updatedAt, session.createdAt, session.messageCount.toLong(), session.lastMessageId,
                    session.workspacePath, session.workspaceName, if (hasMore) 1L else 0L,
                    if (session.pendingConfirmed) 1L else 0L,
                    identity?.path, identity?.workspaceId, identity?.remoteConnectionId, identity?.remoteSshHost,
                )
            }
        }
        lastSignature = signature
    }
}

public typealias RemoteSessionListRdbStore = SqlDelightRemoteSessionListStore

public typealias RemoteChatLocalRdbStore = SqlDelightRemoteTranscriptStore

public class SqlDelightRemoteTranscriptStore public constructor(
    driver: SqlDriver,
) : RemoteTranscriptStore {
    private val queries = MobileDatabase(driver).mobileQueries
    private val resident = LinkedHashMap<String, List<PersistedRemoteMessage>>()

    override fun load(deviceKey: String, sessionId: String): List<PersistedRemoteMessage> {
        val key = "$deviceKey::$sessionId"
        resident[key]?.let { return it }
        val result = queries.selectRemoteMessages(deviceKey, sessionId).executeAsList().map { row ->
            PersistedRemoteMessage(
                messageId = row.message_id,
                sessionId = row.session_id,
                role = row.role,
                text = row.text,
                status = row.status,
                timestamp = row.timestamp,
                thinking = row.thinking,
                payloadJson = row.payload_json,
            )
        }
        remember(key, result)
        return result
    }

    override fun append(deviceKey: String, sessionId: String, startSeq: Int, messages: List<PersistedRemoteMessage>) {
        if (messages.isEmpty()) return
        queries.transaction {
            // Replacing the range makes retries idempotent and safely repairs a partial append.
            queries.deleteRemoteMessagesFrom(deviceKey, sessionId, startSeq.toLong())
            messages.forEachIndexed { index, message -> saveRow(deviceKey, sessionId, startSeq + index, message) }
        }
        resident.remove("$deviceKey::$sessionId")
    }

    override fun replace(deviceKey: String, sessionId: String, messages: List<PersistedRemoteMessage>) {
        queries.transaction {
            queries.deleteRemoteMessages(deviceKey, sessionId)
            messages.forEachIndexed { index, message -> saveRow(deviceKey, sessionId, index, message) }
        }
        remember("$deviceKey::$sessionId", messages)
    }

    override fun loadCursor(deviceKey: String, sessionId: String): PersistedRemoteCursor? =
        queries.selectRemoteCursor(deviceKey, sessionId).executeAsOneOrNull()?.let {
            PersistedRemoteCursor(it.poll_version, it.known_message_count.toInt(), it.known_model_catalog_version)
        }

    override fun saveCursor(deviceKey: String, sessionId: String, cursor: PersistedRemoteCursor) {
        queries.upsertRemoteCursor(deviceKey, sessionId, cursor.pollVersion,
            cursor.knownMessageCount.toLong(), cursor.knownModelCatalogVersion)
    }

    override fun delete(deviceKey: String, sessionId: String) {
        queries.transaction {
            queries.deleteRemoteMessages(deviceKey, sessionId)
            queries.deleteRemoteCursor(deviceKey, sessionId)
        }
        resident.remove("$deviceKey::$sessionId")
    }

    private fun saveRow(deviceKey: String, sessionId: String, seq: Int, message: PersistedRemoteMessage) {
        queries.upsertRemoteMessage(deviceKey, sessionId, seq.toLong(), message.messageId, message.role,
            message.text, message.status, message.timestamp, message.thinking, message.payloadJson)
    }

    private fun remember(key: String, messages: List<PersistedRemoteMessage>) {
        resident[key] = messages
        while (resident.size > 3) resident.remove(resident.entries.first().key)
    }
}

public class SqlDelightRemoteWorkspaceListStore public constructor(
    driver: SqlDriver,
) : RemoteWorkspaceListStore {
    private val queries = MobileDatabase(driver).mobileQueries
    private var lastSignature = ""

    override fun load(deviceKey: String): List<PersistedRemoteWorkspace> =
        queries.selectRemoteWorkspaces(deviceKey).executeAsList().map { row ->
            PersistedRemoteWorkspace(
                path = row.path,
                name = row.name,
                lastOpened = row.last_opened,
                workspaceKind = row.workspace_kind,
                remoteSshHost = row.remote_ssh_host,
                remoteConnectionId = row.remote_connection_id,
                workspaceId = row.workspace_id,
            )
        }

    override fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>) {
        if (deviceKey.isBlank()) return
        // Identity, not path, decides duplicates: a local folder and an SSH folder
        // at the same path are two workspaces and both rows are kept.
        val kept = workspaces.distinctBy { it.key }.take(60)
        val signature = "$deviceKey|${kept.joinToString("\u0002") { workspace ->
            listOf(workspace.path, workspace.name, workspace.lastOpened, workspace.workspaceKind,
                workspace.workspaceId.orEmpty(), workspace.remoteConnectionId.orEmpty(), workspace.remoteSshHost.orEmpty())
                .joinToString("\u0001")
        }}"
        if (signature == lastSignature) return
        queries.transaction {
            queries.deleteRemoteWorkspacesForDevice(deviceKey)
            kept.forEachIndexed { index, workspace ->
                queries.insertRemoteWorkspace(
                    deviceKey,
                    workspace.path,
                    workspace.name,
                    workspace.lastOpened,
                    workspace.workspaceKind,
                    index.toLong(),
                    workspace.workspaceId,
                    workspace.remoteConnectionId,
                    workspace.remoteSshHost,
                )
            }
        }
        lastSignature = signature
    }
}

private object EmptyRemoteSessionListStore : RemoteSessionListStore {
    override fun load(deviceKey: String): List<PersistedRemoteSession> = emptyList()
    override fun save(deviceKey: String, sessions: List<PersistedRemoteSession>, hasMore: Boolean) = Unit
    override fun hasMore(deviceKey: String): Boolean = false
}

private object EmptyRemoteTranscriptStore : RemoteTranscriptStore {
    override fun load(deviceKey: String, sessionId: String): List<PersistedRemoteMessage> = emptyList()
    override fun append(deviceKey: String, sessionId: String, startSeq: Int, messages: List<PersistedRemoteMessage>) = Unit
    override fun replace(deviceKey: String, sessionId: String, messages: List<PersistedRemoteMessage>) = Unit
    override fun loadCursor(deviceKey: String, sessionId: String): PersistedRemoteCursor? = null
    override fun saveCursor(deviceKey: String, sessionId: String, cursor: PersistedRemoteCursor) = Unit
    override fun delete(deviceKey: String, sessionId: String) = Unit
}

private object EmptyRemoteWorkspaceListStore : RemoteWorkspaceListStore {
    override fun load(deviceKey: String): List<PersistedRemoteWorkspace> = emptyList()
    override fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>) = Unit
}

public data class MobilePersistenceStores public constructor(
    public val drafts: DraftStore,
    public val chats: ChatLocalStore,
    public val remoteSessions: RemoteSessionListStore = EmptyRemoteSessionListStore,
    public val remoteTranscripts: RemoteTranscriptStore = EmptyRemoteTranscriptStore,
    public val remoteWorkspaces: RemoteWorkspaceListStore = EmptyRemoteWorkspaceListStore,
)

public fun mobilePersistenceStores(driver: SqlDriver): MobilePersistenceStores = MobilePersistenceStores(
    drafts = SqlDelightDraftStore(driver), chats = SqlDelightChatLocalStore(driver),
    remoteSessions = SqlDelightRemoteSessionListStore(driver),
    remoteTranscripts = SqlDelightRemoteTranscriptStore(driver),
    remoteWorkspaces = SqlDelightRemoteWorkspaceListStore(driver),
)
