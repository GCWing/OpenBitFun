package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
public data class WorkspaceInfoResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("has_workspace") val hasWorkspace: Boolean? = null,
    @SerialName("workspace_path") val workspacePath: String? = null,
    @SerialName("workspace_name") val workspaceName: String? = null,
    @SerialName("path") val path: String? = null,
    @SerialName("project_name") val projectName: String? = null,
    @SerialName("git_branch") val gitBranch: String? = null,
    @SerialName("workspace_kind") val workspaceKind: String? = null,
    @SerialName("assistant_id") val assistantId: String? = null,
    @SerialName("remote_connection_id") val remoteConnectionId: String? = null,
    @SerialName("remote_ssh_host") val remoteSshHost: String? = null,
    @SerialName("capabilities") val capabilities: List<String> = emptyList(),
) : CommandStatus {
    /** `path` wins over `workspace_path`, matching `RemoteResponseMapper.workspaceFromResponse`. */
    public val resolvedPath: String? get() = path ?: workspacePath

    /** `project_name` wins over `workspace_name`. */
    public val resolvedName: String? get() = projectName ?: workspaceName
}

/**
 * A recent-workspace entry. Like [SessionItemResponse], the timestamp arrives
 * under one of several keys and may be a number.
 */
@Serializable(with = RecentWorkspaceEntryResponseSerializer::class)
public data class RecentWorkspaceEntryResponse(
    val path: String? = null,
    val name: String? = null,
    /** Resolved from [RECENT_WORKSPACE_TIME_KEYS]; empty string when absent. */
    val lastOpened: String = "",
    val workspaceKind: String? = null,
    val remoteSshHost: String? = null,
    val remoteConnectionId: String? = null,
)

public object RecentWorkspaceEntryResponseSerializer : KSerializer<RecentWorkspaceEntryResponse> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): RecentWorkspaceEntryResponse {
        val json = decoder.requireJsonObject("RecentWorkspaceEntryResponse")
        return RecentWorkspaceEntryResponse(
            path = json.wireString("path"),
            name = json.wireString("name"),
            lastOpened = json.firstWireTime(RECENT_WORKSPACE_TIME_KEYS),
            workspaceKind = json.wireString("workspace_kind"),
            remoteSshHost = json.wireString("remote_ssh_host"),
            remoteConnectionId = json.wireString("remote_connection_id"),
        )
    }

    override fun serialize(encoder: Encoder, value: RecentWorkspaceEntryResponse) {
        encoder.requireJsonEncoder("RecentWorkspaceEntryResponse").encodeJsonElement(
            buildJsonObject {
                value.path?.let { put("path", it) }
                value.name?.let { put("name", it) }
                if (value.lastOpened.isNotEmpty()) put("last_opened", value.lastOpened)
                value.workspaceKind?.let { put("workspace_kind", it) }
                value.remoteSshHost?.let { put("remote_ssh_host", it) }
                value.remoteConnectionId?.let { put("remote_connection_id", it) }
            },
        )
    }
}

@Serializable
public data class RecentWorkspaceListResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("workspaces") val workspaces: List<RecentWorkspaceEntryResponse> = emptyList(),
    /** Null means legacy host; an empty list is an authoritative empty catalog. */
    @SerialName("opened_workspaces") val openedWorkspaces: List<RecentWorkspaceEntryResponse>? = null,
) : CommandStatus

@Serializable
public data class SetWorkspaceResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("success") val success: Boolean? = null,
    @SerialName("path") val path: String? = null,
    @SerialName("project_name") val projectName: String? = null,
    @SerialName("error") val error: String? = null,
) : CommandStatus

@Serializable
public data class AssistantEntry(
    @SerialName("path") val path: String,
    @SerialName("name") val name: String,
    @SerialName("assistant_id") val assistantId: String? = null,
)

@Serializable
public data class AssistantListResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("assistants") val assistants: List<AssistantEntry> = emptyList(),
) : CommandStatus

@Serializable
public data class SetAssistantResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("success") val success: Boolean? = null,
    @SerialName("path") val path: String? = null,
    @SerialName("name") val name: String? = null,
    @SerialName("error") val error: String? = null,
) : CommandStatus

@Serializable
public data class PermissionModeResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("mode") val mode: RemotePermissionMode? = null,
) : CommandStatus

@Serializable
public data class SavedRuntimeConnection(
    val id: String,
    val name: String,
    val host: String = "",
)

@Serializable
public data class SavedRuntimeConnectionsResponse(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    val ok: Boolean = false,
    val value: List<SavedRuntimeConnection> = emptyList(),
    val error: String? = null,
) : CommandStatus
