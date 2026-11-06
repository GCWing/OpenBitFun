package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.Serializable

@Serializable
public data class DialogQueueRequest(
    val sessionId: String,
    val action: String,
    val queueEpoch: String? = null,
    val turnId: String? = null,
    val operationId: String? = null,
    val beforeTurnId: String? = null,
    val expectedRevision: Long? = null,
    val expectedActiveTurnId: String? = null,
)

@Serializable
public data class DialogQueueItem(
    val turnId: String,
    val displayContent: String,
    val status: String,
    val attachmentCount: Int = 0,
    val reason: String? = null,
)

@Serializable
public data class DialogQueueSnapshot(
    val sessionId: String,
    val queueEpoch: String,
    val revision: Long,
    val items: List<DialogQueueItem> = emptyList(),
    val supportsReorder: Boolean = false,
    val activeTurnId: String? = null,
)

@Serializable
public data class DialogQueueResponse(
    override val resp: String? = null,
    override val message: String? = null,
    val snapshot: DialogQueueSnapshot? = null,
) : CommandStatus
