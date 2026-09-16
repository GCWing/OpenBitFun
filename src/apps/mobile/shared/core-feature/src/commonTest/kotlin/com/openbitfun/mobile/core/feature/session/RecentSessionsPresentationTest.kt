package com.openbitfun.mobile.core.feature.session

import kotlin.test.Test
import kotlin.test.assertEquals

class RecentSessionsPresentationTest {
    @Test fun recentEntriesExcludeArchivedAndUseCreatedTimeWhenUpdateIsInvalid() {
        fun row(id: String, updated: String, created: String = "", status: String = "idle") =
            RecentSessionUiState(id, status, updated, created)
        val source = listOf(
            row("older", "2026-09-10T00:00:00Z"),
            row("archived", "2026-09-16T00:00:00Z", status = "archived"),
            row("fallback", "invalid", "2026-09-14T00:00:00Z"),
            row("newest", "2026-09-15T00:00:00Z"),
            row("newest", "2026-09-15T00:00:00Z"),
            row("", "2026-09-16T00:00:00Z"),
            row("unknown", "invalid"),
        )
        assertEquals(listOf("newest", "fallback", "older"), RecentSessionsPresentation.sessionIds(source))
        assertEquals("older", source.first().id)
        assertEquals(emptyList(), RecentSessionsPresentation.sessionIds(emptyList()))
    }
}
