package com.openbitfun.mobile.core.feature.session

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class ToolRowPresentationTest {
    @Test
    fun foldsConsecutiveCompletedActivitiesAcrossToolKinds() {
        val rows = collapseToolRows(
            listOf(
                tool("read", ToolKind.DOCUMENT),
                tool("shell", ToolKind.COMMAND),
                tool("git", ToolKind.GIT),
            ),
        )

        assertEquals(3, assertIs<ToolRow.Collapsed>(rows.single()).tools.size)
    }

    @Test
    fun failedCallsFoldWithCompletedWorkWithoutLosingTheirDetails() {
        val failed = tool("fetch", ToolKind.WEB, ToolPhase.FAILED).copy(output = "HTTP 404")
        val rows = collapseToolRows(listOf(tool("read", ToolKind.DOCUMENT), failed))
        val group = assertIs<ToolRow.Collapsed>(rows.single())
        assertEquals(ToolPhase.FAILED, group.tools.last().phase)
        assertEquals("HTTP 404", group.tools.last().output)
    }

    @Test
    fun leavesAttentionAndPlanToolsVisible() {
        val rows = collapseToolRows(
            listOf(
                tool("running", ToolKind.COMMAND, ToolPhase.RUNNING),
                tool("failed", ToolKind.SEARCH, ToolPhase.FAILED),
                tool("question", ToolKind.QUESTION),
                tool("CreatePlan", ToolKind.CREATE),
                tool("Write", ToolKind.CREATE, filePath = "/repo/work.plan.md"),
            ),
        )

        assertEquals(5, rows.size)
        rows.forEach { assertIs<ToolRow.Single>(it) }
    }

    private fun tool(
        id: String,
        kind: ToolKind,
        phase: ToolPhase = ToolPhase.COMPLETED,
        filePath: String = "",
    ): ToolCard = ToolCard(
        id = id,
        name = id,
        phase = phase,
        kind = kind,
        operation = ToolOperation.UNKNOWN,
        target = "",
        filePath = filePath,
        fileLabel = "",
        input = "",
        output = "",
        question = null,
        actions = emptySet(),
    )
}
