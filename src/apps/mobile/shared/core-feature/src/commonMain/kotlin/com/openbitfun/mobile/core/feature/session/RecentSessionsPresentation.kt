package com.openbitfun.mobile.core.feature.session

/** Platform-neutral facts needed to select the remote landing-page entries. */
public data class RecentSessionUiState public constructor(
    public val id: String,
    public val status: String,
    public val updatedAt: String,
    public val createdAt: String,
)

public object RecentSessionsPresentation {
    public fun sessionIds(sessions: List<RecentSessionUiState>): List<String> = sessions
        .filter { it.id.isNotBlank() && it.status != "archived" }
        .sortedByDescending {
            SessionTimePresentation.timestampMs(it.updatedAt)?.takeIf { time -> time > 0 }
                ?: SessionTimePresentation.timestampMs(it.createdAt) ?: 0
        }
        .distinctBy { it.id }
        .take(3)
        .map { it.id }
}
