package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One session as the relay reports it.
 *
 * This type resolves alternative *spellings* of a field (`id` vs `session_id`,
 * fourteen timestamp keys) because that is wire-format tolerance. It does not
 * apply defaults — no "Session ab12cd" title, no `"code"` agent type. Those are
 * product policy and belong to `core-domain`, which is what keeps this module
 * free of decisions the UI might reasonably want to change.
 *
 * Ported from `SessionItemResponse` in `model/RemoteModels.ets` together with
 * the resolution order in `RemoteResponseMapper.sessions`.
 */
@Serializable(with = SessionItemResponseSerializer::class)
public data class SessionItemResponse(
    /** `id`, falling back to `session_id`. Null when the peer sent neither. */
    val id: String? = null,
    /** `title`, falling back to `name`. */
    val title: String? = null,
    val agentType: String? = null,
    val status: String? = null,
    /** Resolved from [SESSION_UPDATED_AT_KEYS]; empty string when absent. */
    val updatedAt: String = "",
    /** Resolved from [SESSION_CREATED_AT_KEYS]; empty string when absent. */
    val createdAt: String = "",
    val messageCount: Int? = null,
    val workspacePath: String? = null,
    val workspaceName: String? = null,
    val workspaceId: String? = null,
    /** Set when the session hangs off another one (btw/review/miniapp/subagent). */
    val parentSessionId: String? = null,
    val relationshipKind: String? = null,
)

public object SessionItemResponseSerializer : KSerializer<SessionItemResponse> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): SessionItemResponse {
        val json = decoder.requireJsonObject("SessionItemResponse")
        return SessionItemResponse(
            id = json.firstWireString("id", "session_id"),
            title = json.firstWireString("title", "name"),
            agentType = json.wireString("agent_type"),
            status = json.wireString("status"),
            updatedAt = json.firstWireTime(SESSION_UPDATED_AT_KEYS),
            createdAt = json.firstWireTime(SESSION_CREATED_AT_KEYS),
            messageCount = json.wireInt("message_count"),
            workspacePath = json.wireString("workspace_path"),
            workspaceName = json.wireString("workspace_name"),
            workspaceId = json.wireString("workspace_id"),
            parentSessionId = json.wireString("parent_session_id"),
            relationshipKind = json.wireString("relationship_kind"),
        )
    }

    /**
     * Writes the canonical spelling only. The client never echoes a session back
     * to the relay, so this exists for fixtures and debugging; round-tripping a
     * payload that used an alias normalizes it.
     */
    override fun serialize(encoder: Encoder, value: SessionItemResponse) {
        val output = encoder.requireJsonEncoder("SessionItemResponse")
        output.encodeJsonElement(
            buildJsonObject {
                value.id?.let { put("id", it) }
                value.title?.let { put("title", it) }
                value.agentType?.let { put("agent_type", it) }
                value.status?.let { put("status", it) }
                if (value.updatedAt.isNotEmpty()) put("updated_at", value.updatedAt)
                if (value.createdAt.isNotEmpty()) put("created_at", value.createdAt)
                value.messageCount?.let { put("message_count", it) }
                value.workspacePath?.let { put("workspace_path", it) }
                value.workspaceName?.let { put("workspace_name", it) }
                value.workspaceId?.let { put("workspace_id", it) }
                value.parentSessionId?.let { put("parent_session_id", it) }
                value.relationshipKind?.let { put("relationship_kind", it) }
            },
        )
    }
}

@Serializable
public data class SessionListResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("sessions") val sessions: List<SessionItemResponse> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
) : CommandStatus

@Serializable
public data class InitialSyncResponse(
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("has_workspace") val hasWorkspace: Boolean? = null,
    @SerialName("path") val path: String? = null,
    @SerialName("project_name") val projectName: String? = null,
    @SerialName("git_branch") val gitBranch: String? = null,
    @SerialName("workspace_kind") val workspaceKind: String? = null,
    @SerialName("assistant_id") val assistantId: String? = null,
    @SerialName("remote_connection_id") val remoteConnectionId: String? = null,
    @SerialName("remote_ssh_host") val remoteSshHost: String? = null,
    /** Host feature list; `workspace_id_references_v1` is what allows ID-only workspace commands. */
    @SerialName("capabilities") val capabilities: List<String> = emptyList(),
    @SerialName("sessions") val sessions: List<SessionItemResponse> = emptyList(),
    @SerialName("has_more_sessions") val hasMoreSessions: Boolean = false,
    @SerialName("authenticated_user_id") val authenticatedUserId: String? = null,
) : CommandStatus

@Serializable
public data class CreateSessionResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("id") val id: String? = null,
    @SerialName("title") val title: String? = null,
    /** Set by ID-aware hosts; the created session's workspace identity is this ID. */
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("workspace_path") val workspacePath: String? = null,
    @SerialName("remote_connection_id") val remoteConnectionId: String? = null,
    @SerialName("remote_ssh_host") val remoteSshHost: String? = null,
) : CommandStatus {
    /** `session_id` and `id` are the same field under two spellings. */
    public val resolvedSessionId: String? get() = sessionId ?: id
}

@Serializable
public data class SendMessageResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("turn_id") val turnId: String? = null,
) : CommandStatus
