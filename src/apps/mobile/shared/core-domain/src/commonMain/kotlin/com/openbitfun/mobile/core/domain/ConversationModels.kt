package com.openbitfun.mobile.core.domain

import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.ImageAttachment
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse

/**
 * A normalized conversation message used by the timeline state machine.
 *
 * Status remains a raw value on purpose. The relay currently uses overlapping
 * vocabularies for messages and tools, so forcing both through one enum would
 * erase distinctions that the existing clients rely on.
 */
public data class ChatMessage public constructor(
    public val id: String,
    public val role: String,
    public val text: String,
    public val status: String,
    public val renderVersion: Int?,
    public val turnId: String?,
    public val detail: String?,
    public val timestamp: String?,
    public val thinking: String?,
    public val tools: List<RemoteToolStatusResponse>?,
    public val items: List<ChatMessageItemResponse>?,
    public val images: List<ImageAttachment>?,
    /** Relay failure detail for an assistant message or active turn. */
    public val error: String?,
)

public data class SessionSummary public constructor(
    public val sessionId: String,
    public val title: String,
    public val workspacePath: String,
    public val agentType: String,
    public val initialTurnId: String?,
)

public data class RemoteSession public constructor(
    public val id: String,
    public val title: String,
    public val agentType: String,
    public val status: String,
    public val updatedAt: String,
    public val createdAt: String,
    public val messageCount: Int,
    public val workspacePath: String?,
    public val workspaceName: String?,
    public val workspaceIdentity: RemoteWorkspaceIdentity?,
    /** Set when the session hangs off another one (btw/review/miniapp/subagent). */
    public val parentSessionId: String? = null,
    public val relationshipKind: String? = null,
) {
    public constructor(id: String, title: String, agentType: String, status: String, updatedAt: String,
        createdAt: String, messageCount: Int, workspacePath: String?, workspaceName: String?) :
        this(id, title, agentType, status, updatedAt, createdAt, messageCount, workspacePath, workspaceName, null)
}

public data class ChatSessionCursor public constructor(
    public val pollVersion: Int,
    public val knownMessageCount: Int,
    public val knownModelCatalogVersion: Long,
)

public data class ChatSessionSnapshot public constructor(
    public val sessionId: String,
    public val cursor: ChatSessionCursor,
    public val changed: Boolean,
    public val title: String,
    public val sessionState: String,
    public val newMessages: List<ChatMessage>,
    public val activeTurn: ChatMessage?,
    public val modelCatalog: RemoteModelCatalog?,
    public val shouldSyncAfterTurnEnded: Boolean,
    /** Authoritative persisted history, distinct from an additive poll tail. */
    public val messageSnapshot: List<ChatMessage>?,
    /** The desktop reports fewer persisted messages than the client cursor. */
    public val historyRewritten: Boolean,
)

public data class PollSessionResult public constructor(
    public val version: Int,
    public val changed: Boolean,
    public val sessionState: String,
    public val title: String,
    public val newMessages: List<ChatMessage>,
    public val totalMessageCount: Int,
    public val activeTurn: ChatMessage?,
    public val modelCatalog: RemoteModelCatalog?,
    /** Authoritative persisted history, distinct from [newMessages]. */
    public val messageSnapshot: List<ChatMessage>?,
    /** Whether [totalMessageCount] came from the peer instead of a local fallback. */
    public val hasAuthoritativeMessageCount: Boolean,
)

public enum class ChatTimelineItemType {
    USER_MESSAGE,
    ASSISTANT_MESSAGE,
    OPTIMISTIC_USER_MESSAGE,
    ASSISTANT_LIVE_TURN,
    EMPTY_STATE,
}

public data class ChatTimelineItem public constructor(
    public val id: String,
    public val type: ChatTimelineItemType,
    public val message: ChatMessage?,
    public val isStreaming: Boolean,
    public val isFinalizing: Boolean,
    public val showRetryAction: Boolean,
)
