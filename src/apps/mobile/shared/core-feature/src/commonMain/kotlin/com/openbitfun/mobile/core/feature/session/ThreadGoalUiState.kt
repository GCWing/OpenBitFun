package com.openbitfun.mobile.core.feature.session

public enum class ThreadGoalAction { OPEN, CLOSE, READ, START, EDIT, PAUSE, RESUME, CLEAR }
public enum class ThreadGoalFailure { UNSUPPORTED, LOAD, SAVE, ATTACHMENTS }

public data class ThreadGoalUiState(
    public val sessionId: String,
    public val visible: Boolean,
    public val busy: Boolean,
    public val loaded: Boolean,
    public val objective: String?,
    public val status: String,
    public val tokensUsed: Long,
    public val tokenBudget: Long?,
    public val failure: ThreadGoalFailure?,
) {
    public constructor(sessionId: String) : this(sessionId, false, false, false, null, "unknown", 0, null, null)
    public constructor() : this("")
    public val canResume: Boolean get() = status in setOf("paused", "blocked", "usageLimited")
}

/** Controls match whole arguments; `/goal pause\nthen verify` is an objective. */
internal fun parseThreadGoalCommand(text: String): Pair<ThreadGoalAction, String?>? {
    val value = text.trim()
    if (!value.startsWith("/goal", ignoreCase = true) ||
        (value.length > 5 && !value[5].isWhitespace())) return null
    val argument = value.drop(5).trim()
    return when (argument.lowercase()) {
        "", "edit" -> ThreadGoalAction.OPEN to null
        "pause" -> ThreadGoalAction.PAUSE to null
        "resume" -> ThreadGoalAction.RESUME to null
        "clear" -> ThreadGoalAction.CLEAR to null
        else -> ThreadGoalAction.START to argument
    }
}
