package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.Serializable

@Serializable
public data class RemoteGoal(
    val goalId: String = "",
    val sessionId: String = "",
    val objective: String = "",
    val status: String = "unknown",
    val tokensUsed: Long = 0,
    val timeUsedSeconds: Long = 0,
    val tokenBudget: Long? = null,
)

@Serializable
public data class RemoteGoalResponse(
    override val resp: String? = null,
    val goal: RemoteGoal? = null,
    override val message: String? = null,
) : CommandStatus
