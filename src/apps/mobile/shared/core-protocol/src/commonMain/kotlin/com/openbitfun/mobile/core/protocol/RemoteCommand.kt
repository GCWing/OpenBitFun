package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement

/** Permission modes the desktop peer accepts for a session. */
@Serializable(with = RemotePermissionModeSerializer::class)
public enum class RemotePermissionMode {
    Ask,
    Auto,
    FullAccess,
    Unknown,
}

public object RemotePermissionModeSerializer : KSerializer<RemotePermissionMode> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(
        "com.openbitfun.mobile.core.protocol.RemotePermissionMode",
        PrimitiveKind.STRING,
    )

    override fun serialize(encoder: Encoder, value: RemotePermissionMode) {
        encoder.encodeString(
            when (value) {
                RemotePermissionMode.Ask -> "ask"
                RemotePermissionMode.Auto -> "auto"
                RemotePermissionMode.FullAccess -> "full_access"
                RemotePermissionMode.Unknown -> "unknown"
            },
        )
    }

    override fun deserialize(decoder: Decoder): RemotePermissionMode = when (decoder.decodeString()) {
        "ask" -> RemotePermissionMode.Ask
        "auto" -> RemotePermissionMode.Auto
        "full_access" -> RemotePermissionMode.FullAccess
        else -> RemotePermissionMode.Unknown
    }
}

/**
 * The single outbound command envelope, ported from `RemoteCommand` in
 * `model/RemoteModels.ets`.
 *
 * Every field except [cmd] is optional because one shape serves all ~22
 * commands. `RelayJson` is configured with `explicitNulls = false`, so absent
 * fields are omitted rather than sent as `null` — some desktop handlers
 * distinguish "not supplied" from "supplied as null".
 */
@Serializable
public data class RemoteCommand(
    @SerialName("cmd") val cmd: String,
    @SerialName("command") val command: String? = null,
    @SerialName("args") val args: JsonElement? = null,
    @SerialName("_request_id") val requestId: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("content") val content: String? = null,
    @SerialName("display_content") val displayContent: String? = null,
    @SerialName("plan_file_path") val planFilePath: String? = null,
    @SerialName("plan_name") val planName: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("workspace_path") val workspacePath: String? = null,
    @SerialName("path") val path: String? = null,
    @SerialName("remote_connection_id") val remoteConnectionId: String? = null,
    @SerialName("remote_ssh_host") val remoteSshHost: String? = null,
    @SerialName("agent_type") val agentType: String? = null,
    @SerialName("session_name") val sessionName: String? = null,
    @SerialName("title") val title: String? = null,
    @SerialName("limit") val limit: Int? = null,
    @SerialName("offset") val offset: Long? = null,
    @SerialName("query") val query: String? = null,
    @SerialName("before_message_id") val beforeMessageId: String? = null,
    @SerialName("since_version") val sinceVersion: Int? = null,
    @SerialName("known_msg_count") val knownMessageCount: Int? = null,
    // A [Long] for the same reason [RemoteModelCatalog.version] is: this is that
    // number echoed back, and truncating it here would ask for the catalog on
    // every poll.
    @SerialName("known_model_catalog_version") val knownModelCatalogVersion: Long? = null,
    @SerialName("turn_id") val turnId: String? = null,
    @SerialName("tool_id") val toolId: String? = null,
    /**
     * The desktop confirm_tool handler accepts only tool_id today. This client
     * never sends updated_input until a peer advertises support, and the
     * core-feature store gates edited approvals to an explicit unsupported state
     * so an edit is never silently dropped.
     */
    @SerialName("updated_input") val updatedInput: JsonElement? = null,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("reason") val reason: String? = null,
    @SerialName("mode") val mode: RemotePermissionMode? = null,
    @SerialName("answers") val answers: JsonElement? = null,
    @SerialName("image_contexts") val imageContexts: List<RemoteImageContext>? = null,
    @SerialName("images") val images: List<ImageAttachment>? = null,
)
