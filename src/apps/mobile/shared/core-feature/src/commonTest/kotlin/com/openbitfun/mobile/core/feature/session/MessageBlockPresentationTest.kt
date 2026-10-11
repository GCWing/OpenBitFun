package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MessageBlockPresentationTest {
    @Test
    fun markedOwnerKeepsLiveChildrenAndStableIdentity() {
        val owner = item(tool = tool("owner", name = "Task", status = "running")).copy(isSubagent = true)
        val thought = item(type = "thinking", content = "Inspecting").copy(isSubagent = true)
        val before = messageBlocks(message(items = listOf(owner)), true).single() as MessageBlock.Subagent
        val after = messageBlocks(message(items = listOf(owner, thought)), true).single() as MessageBlock.Subagent
        assertEquals(before.id, after.id)
        assertEquals("Inspecting", (after.children.single() as MessageBlock.Thinking).text)
        val completed = messageBlocks(message(items = listOf(owner.copy(tool = owner.tool!!.copy(status = "completed")), thought)), false).single() as MessageBlock.Subagent
        assertEquals(after.id, completed.id)
        assertEquals(1, completed.children.size)
        assertEquals(false, completed.running)
    }

    @Test
    fun orphanReasoningHasOnlyOneCopyInsideItsBranch() {
        val orphan = item(type = "thinking", content = "Early reasoning").copy(isSubagent = true)
        val block = messageBlocks(message(items = listOf(orphan)), true).single() as MessageBlock.Subagent
        assertEquals("", block.title)
        assertEquals("", block.text)
        assertEquals("Early reasoning", (block.children.single() as MessageBlock.Thinking).text)
    }

    @Test
    fun markedFlatChildrenBelongToTheirTaskNotTheMainTranscript() {
        val task1 = item(tool = tool("task1", name = "Task", status = "running"))
        val task2 = item(tool = tool("task2", name = "Task", status = "completed"))
        val thought = item(type = "thinking", content = "Private reasoning").copy(isSubagent = true)
        val childTool = item(tool = tool("read", status = "completed")).copy(isSubagent = true)
        val childText = item(type = "text", content = "Subtask result").copy(isSubagent = true)
        val blocks = messageBlocks(message(items = listOf(task1, thought, childTool, task2, childText,
            item(type = "text", content = "Parent answer")), tools = listOf(childTool.tool!!)), true)
        assertEquals(listOf("subagent", "subagent", "Parent answer"), blocks.map(::describe))
        assertEquals(listOf("Private reasoning", "tools"), (blocks[0] as MessageBlock.Subagent).children.map(::describe))
        assertEquals(listOf("Subtask result"), (blocks[1] as MessageBlock.Subagent).children.map(::describe))
    }

    @Test
    fun legacyUnmarkedChildrenUseOnlyARunningTaskScope() {
        for (status in listOf("running", "queued", "completed")) {
            val blocks = messageBlocks(message(items = listOf(item(tool = tool("task", name = "Task", status = status)),
                item(type = "thinking", content = "Legacy thinking"), item(tool = tool("read", status = "completed")))), true)
            val task = blocks.first() as MessageBlock.Subagent
            assertEquals(if (status == "completed") 0 else 2, task.children.size)
        }
    }

    @Test
    fun alreadyNestedMarkersRenderAsChildrenAndDoNotDuplicate() {
        val nested = item(type = "thinking", content = "Nested").copy(isSubagent = true)
        val task = messageBlocks(message(items = listOf(item(tool = tool("task", name = "Task", status = "running"),
            subItems = listOf(nested)))), true).single() as MessageBlock.Subagent
        assertTrue(task.children.single() is MessageBlock.Thinking)
        val orphan = messageBlocks(message(items = listOf(nested)), true).single() as MessageBlock.Subagent
        assertEquals("Nested", (orphan.children.single() as MessageBlock.Thinking).text,
            "Partial legacy snapshots retain orphan content inside a collapsed branch")
    }

    @Test
    fun subagentStatusPreservesHostVocabularyAndOwnActiveScope() {
        for (status in listOf("running", "active", "preparing", "pending", "queued", "failed", "error", "timeout", "cancelled", "canceled", "rejected", "completed")) {
            val blocks = messageBlocks(message(items = listOf(
                item(type = "subagent", tool = tool("task", name = "Task", status = status)),
                item(type = "thinking", content = "child").copy(isSubagent = true),
                item(type = "text", content = "Parent continues"))), true)
            val child = blocks.first() as MessageBlock.Subagent
            val running = status in listOf("running", "active", "preparing", "pending", "queued")
            assertEquals(status, child.status)
            assertEquals(running, child.running)
            assertEquals(running, (child.children.single() as MessageBlock.Thinking).streaming)
        }
    }

    @Test
    fun legacySubagentWithoutToolInheritsActiveScope() {
        val payload = message(items = listOf(item(type = "subagent", content = "Legacy", subItems = listOf(item(type = "thinking", content = "Working")))))
        assertTrue((messageBlocks(payload, true).single() as MessageBlock.Subagent).running)
        assertEquals("completed", (messageBlocks(payload, false).single() as MessageBlock.Subagent).status)
        val oldConstructor = MessageBlock.Subagent("id", "title", false, "", emptyList())
        assertEquals("completed", oldConstructor.status)
    }

    @Test
    fun legacyTaskTitleAliasesRemainReadable() {
        for (key in listOf("description", "task", "title", "prompt", "message", "task_name", "taskName", "name", "content")) {
            val child = messageBlocks(message(items = listOf(item(type = "tool", content = "Result",
                tool = tool("task", name = "Task", status = "completed", inputPreview = """{"$key":"Inspect"}""")))), false).single() as MessageBlock.Subagent
            assertEquals("Inspect", child.title)
        }
    }

    @Test
    fun taskDescriptionWinsOverResultAndDoesNotBecomeAnotherBody() {
        val child = messageBlocks(message(items = listOf(item(type = "tool", content = "Finished",
            tool = tool("task", name = "Task", status = "completed", inputPreview = """{"description":"**Audit security**"}""")))), false).single() as MessageBlock.Subagent
        assertEquals("Audit security", child.title)
        assertEquals("", child.text)
        val legacy = messageBlocks(message(items = listOf(item(type = "subagent", content = "## Legacy title"))), false).single() as MessageBlock.Subagent
        assertEquals("Legacy title", legacy.title)
        assertEquals("", legacy.text)
    }

    @Test
    fun aPlainAnswerHasNoBlocksSoTheAppKeepsItsFlatPath() {
        val blocks = messageBlocks(message(text = "Done."), false)

        assertTrue(blocks.isEmpty())
    }

    @Test
    fun theTurnKeepsTheOrderTheAgentProducedIt() {
        val blocks = messageBlocks(
            message(
                items = listOf(
                    item(type = "text", content = "Reading the config."),
                    item(tool = tool(id = "t-1", status = "completed")),
                    item(type = "text", content = "It sets the port to 8080."),
                ),
            ),
            false,
        )

        assertEquals(
            listOf("Reading the config.", "tools", "It sets the port to 8080."),
            blocks.map(::describe),
        )
    }

    @Test
    fun toolsRunBackToBackShareOneBlockSoTheyCanFold() {
        val blocks = messageBlocks(
            message(
                items = listOf(
                    item(tool = tool(id = "t-1", status = "completed")),
                    item(tool = tool(id = "t-2", status = "completed")),
                    item(type = "text", content = "Both read."),
                ),
            ),
            false,
        )

        val tools = blocks.filterIsInstance<MessageBlock.Tools>().single()
        assertEquals(listOf("t-1", "t-2"), tools.tools.map { it.id })
    }

    @Test
    fun aSubagentCarriesItsOwnTurnUnderIt() {
        val blocks = messageBlocks(
            message(
                items = listOf(
                    item(
                        type = "subagent",
                        content = "Audit the auth flow",
                        tool = tool(id = "t-1", name = "Task", status = "running"),
                        subItems = listOf(
                            item(tool = tool(id = "t-2", status = "completed")),
                            item(type = "text", content = "No leaks found."),
                        ),
                    ),
                ),
            ),
            false,
        )

        val subagent = blocks.single() as MessageBlock.Subagent
        assertEquals("Audit the auth flow", subagent.title)
        assertTrue(subagent.running)
        assertEquals(listOf("tools", "No leaks found."), subagent.children.map(::describe))
    }

    @Test
    fun aTaskToolIsTheSubagentRatherThanSomethingItDid() {
        // No `is_subagent` flag and no `subagent` type — only the tool's name.
        val blocks = messageBlocks(
            message(
                items = listOf(
                    item(
                        type = "tool",
                        tool = tool(
                            id = "t-1",
                            name = "Task",
                            status = "completed",
                            inputPreview = """{"description":"Sweep the migrations"}""",
                        ),
                    ),
                ),
            ),
            false,
        )

        val subagent = blocks.single() as MessageBlock.Subagent
        assertEquals("Sweep the migrations", subagent.title)
    }

    @Test
    fun liveReasoningKeepsChronologicalOrderAndStableBlockIds() {
        val items = listOf(
            item(type = "thinking", content = "which file first"),
            item(type = "text", content = "Starting with the manifest."),
            item(type = "thinking", content = "now the gradle file"),
        )

        val settled = messageBlocks(message(items = items), false)
        assertEquals(
            listOf("which file first", "Starting with the manifest.", "now the gradle file"),
            settled.map(::describe),
        )

        val live = messageBlocks(message(items = items), true)
        assertEquals(settled.map(::describe), live.map(::describe))
        assertEquals(settled.map { it.id }, live.map { it.id })
        assertTrue(!(live.first() as MessageBlock.Thinking).streaming)
        assertTrue((live.last() as MessageBlock.Thinking).streaming)
    }

    @Test
    fun answerAfterThinkingDoesNotMoveAboveItWhileStreaming() {
        val thought = item(type = "thinking", content = "Consider the request.")
        val before = messageBlocks(message(items = listOf(thought)), true)
        val withAnswer = message(items = listOf(thought, item(type = "text", content = "Answer")))
        val live = messageBlocks(withAnswer, true)
        val done = messageBlocks(withAnswer, false)
        assertEquals(listOf("Consider the request.", "Answer"), live.map(::describe))
        assertEquals(before.first().id, live.first().id)
        assertEquals(live.map { it.id }, done.map { it.id })
        assertTrue(!(live.first() as MessageBlock.Thinking).streaming)
        assertTrue((live.last() as MessageBlock.Text).streaming)
    }

    @Test
    fun thinkingStaysBeforeToolsAndAnswerAcrossCompletion() {
        val source = message(items = listOf(
            item(type = "thinking", content = "Inspect first"),
            item(tool = tool(id = "t-1", status = "completed")),
            item(type = "text", content = "Result"),
        ))
        val live = messageBlocks(source, true)
        val done = messageBlocks(source, false)
        assertTrue(live[0] is MessageBlock.Thinking)
        assertTrue(live[1] is MessageBlock.Tools)
        assertTrue(live[2] is MessageBlock.Text)
        assertEquals(live.map { it.id }, done.map { it.id })
    }

    @Test
    fun aToolReportedBothFlatAndInlineIsNotDrawnTwice() {
        val blocks = messageBlocks(
            message(
                tools = listOf(tool(id = "t-1", status = "completed")),
                items = listOf(item(tool = tool(id = "t-1", status = "completed"))),
            ),
            false,
        )

        assertEquals(listOf("t-1"), blocks.filterIsInstance<MessageBlock.Tools>().flatMap { it.tools }.map { it.id })
    }

    @Test
    fun aToolTheItemsNeverMentionIsStillDrawn() {
        val blocks = messageBlocks(
            message(
                tools = listOf(tool(id = "t-2", status = "running")),
                items = listOf(item(tool = tool(id = "t-1", status = "completed"))),
            ),
            false,
        )

        val ids = blocks.filterIsInstance<MessageBlock.Tools>().flatMap { it.tools }.map { it.id }
        assertEquals(listOf("t-1", "t-2"), ids)
    }

    @Test
    fun anIdlessToolIsMatchedByWhatItIsInstead() {
        // Some agents send no ids at all; matching on the id alone would then
        // treat every flat tool as uncovered and draw the whole run twice.
        val anonymous = tool(id = null, status = "completed", inputPreview = "ls -la")
        val blocks = messageBlocks(
            message(tools = listOf(anonymous), items = listOf(item(tool = anonymous))),
            false,
        )

        assertEquals(1, blocks.filterIsInstance<MessageBlock.Tools>().flatMap { it.tools }.size)
    }

    @Test
    fun aRunningTaskDoesNotDrawItsChildrenTwiceWhenTheyAlsoArriveFlat() {
        val task = item(
            tool = tool("task", name = "Task", status = "running"),
            subItems = listOf(
                item(type = "thinking", content = "child reasoning"),
                item(tool = tool("read", status = "completed")),
            ),
        )
        val flatCopies = listOf(
            item(type = "thinking", content = "child reasoning"),
            item(tool = tool("read", status = "completed")),
        )

        val subagent = messageBlocks(message(items = listOf(task) + flatCopies), true).single() as MessageBlock.Subagent

        assertEquals(2, subagent.children.size)
    }

    @Test
    fun aChildThatRepeatsInsideTheTaskIsNotTreatedAsARestatement() {
        val task = item(
            tool = tool("task", name = "Task", status = "running"),
            subItems = listOf(item(type = "thinking", content = "checking")),
        )
        val flatTail = listOf(
            item(type = "thinking", content = "checking"),
            item(type = "thinking", content = "checking"),
        )

        val subagent = messageBlocks(message(items = listOf(task) + flatTail), true).single() as MessageBlock.Subagent

        assertEquals(2, subagent.children.size)
    }

    @Test
    fun repeatedFlatChildrenOnlyConsumeOriginalNestedOccurrences() {
        for (marked in listOf(true, false)) {
            for (nestedCount in listOf(0, 1, 2)) {
                val child = item(type = "text", content = "Checking again").copy(isSubagent = marked)
                val task = item(tool = tool("task", name = "Task", status = "running"),
                    subItems = List(nestedCount) { child })
                val shown = messageBlocks(message(items = listOf(task) + List(5) { child }), true)
                    .single() as MessageBlock.Subagent
                assertEquals(5, shown.children.size, "Only $nestedCount nested copies may be matched")
                assertEquals(nestedCount, task.subItems!!.size, "Projection must not mutate the source")
            }
        }
    }

    @Test
    fun flatToolRestatementUpdatesStatusOutputAndContentWithoutLosingNestedDetails() {
        for (marked in listOf(true, false)) {
            val nested = item(type = "tool", content = "old", tool = tool("read", status = "running", inputPreview = "original input"),
                subItems = listOf(item(type = "text", content = "nested detail")))
            val task = item(tool = tool("task", name = "Task", status = "running"), subItems = listOf(nested))
            val complete = item(type = "tool", content = "new", tool = tool("read", status = "completed")
                .copy(name = null, resultPreview = "new output")).copy(isSubagent = marked)
            val shown = messageBlocks(message(items = listOf(task, complete)), true).single() as MessageBlock.Subagent
            val card = (shown.children.single() as MessageBlock.Tools).tools.single()
            assertEquals(ToolPhase.COMPLETED, card.phase)
            assertEquals("new output", card.output)
            assertEquals("Read", card.name)
            assertEquals("original input", card.input)
            assertEquals("running", task.subItems!!.single().tool!!.status)
        }
    }

    @Test
    fun thinkingBlocksKeepTheirIdsWhenAToolArrivesBeforeThem() {
        val reasoning = (1..3).map { item(type = "thinking", content = "reasoning $it") }

        val before = messageBlocks(message(items = reasoning), true).filterIsInstance<MessageBlock.Thinking>()
        val after = messageBlocks(
            message(items = listOf(item(tool = tool("read", status = "running"))) + reasoning),
            true,
        ).filterIsInstance<MessageBlock.Thinking>()

        assertEquals(before.map { it.id }, after.map { it.id })
        assertEquals(before.map { it.text }, after.map { it.text })
    }

    @Test
    fun aTaskKeepsItsIdAndItsChildrenWhenAnEarlierItemArrivesLate() {
        val task = item(
            tool = tool("task", name = "Task", status = "running"),
            subItems = listOf(item(type = "thinking", content = "child reasoning")),
        )

        val first = messageBlocks(message(items = listOf(task)), true).single() as MessageBlock.Subagent
        val later = messageBlocks(
            message(items = listOf(item(type = "thinking", content = "parent note"), task)),
            true,
        ).filterIsInstance<MessageBlock.Subagent>().single()

        assertEquals(first.id, later.id)
        assertEquals(first.children.map { it.id }, later.children.map { it.id })
    }

    @Test
    fun theWaitingIndicatorIsOnlyForATurnThatHasProducedNothing() {
        assertTrue(isTyping(message(), true))
        assertTrue(!isTyping(message(), false))
        assertTrue(!isTyping(message(text = "On it."), true))
        assertTrue(!isTyping(message(thinking = "hmm"), true))
        assertTrue(!isTyping(message(tools = listOf(tool(id = "t-1", status = "running"))), true))
        assertTrue(!isTyping(message(items = listOf(item(type = "text", content = "hi"))), true))
    }
}

private fun describe(block: MessageBlock): String = when (block) {
    is MessageBlock.Text -> block.text
    is MessageBlock.Thinking -> block.text
    is MessageBlock.Tools -> "tools"
    is MessageBlock.Subagent -> "subagent"
}

private fun message(
    text: String = "",
    thinking: String? = null,
    tools: List<RemoteToolStatusResponse>? = null,
    items: List<ChatMessageItemResponse>? = null,
) = ChatMessage(
    id = "m-1",
    role = "assistant",
    text = text,
    status = "completed",
    renderVersion = null,
    turnId = null,
    detail = null,
    timestamp = null,
    thinking = thinking,
    tools = tools,
    items = items,
    images = null,
    error = null,
)

private fun item(
    type: String? = null,
    content: String? = null,
    tool: RemoteToolStatusResponse? = null,
    subItems: List<ChatMessageItemResponse>? = null,
) = ChatMessageItemResponse(type = type, content = content, tool = tool, subItems = subItems)

private fun tool(
    id: String?,
    status: String,
    name: String = "Read",
    inputPreview: String? = null,
) = RemoteToolStatusResponse(id = id, name = name, status = status, inputPreview = inputPreview)
