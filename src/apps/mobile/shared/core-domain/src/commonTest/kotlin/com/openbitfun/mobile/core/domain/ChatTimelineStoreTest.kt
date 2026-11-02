package com.openbitfun.mobile.core.domain

import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatTimelineStoreTest {
    @Test
    fun oneAliasPairAcknowledgesOnlyOneRepeatedLegacySend() {
        val store = ChatTimelineStore()
        store.reset("s")
        store.appendOptimisticMessage(message("local-1", "user", "same"))
        store.appendOptimisticMessage(message("local-2", "user", "same"))
        val provisional = message("t-user", "user", "same").copy(turnId = "t")
        store.mergePersistedMessages(listOf(provisional, provisional.copy(id = "durable")))
        assertEquals(listOf("durable"), store.snapshot().persistedMessages.map { it.id })
        assertEquals(listOf("local-2"), store.snapshot().optimisticMessages.map { it.id })
    }

    @Test
    fun durableUserReplacesLiveTurnPlaceholderBeforeReplyEnds() {
        val store = ChatTimelineStore()
        store.reset("s")
        val provisional = message("turn-live-user", "user", "hello").copy(turnId = "turn-live")
        val durable = provisional.copy(id = "user_remote_123")
        store.mergePersistedMessages(listOf(provisional))
        store.setActiveTurn(message("active-turn-live", "assistant", "Thinking", "active").copy(turnId = "turn-live"))
        store.mergePersistedMessages(listOf(durable))
        assertEquals(listOf(durable), store.snapshot().persistedMessages)
        assertEquals(1, store.project(false).count { it.message?.role == "user" })
        assertTrue(store.snapshot().activeTurn != null)
        store.mergePersistedMessages(listOf(provisional.copy(text = "stale")))
        assertEquals(listOf(durable), store.snapshot().persistedMessages)
        store.setPersistedMessages(listOf(provisional, durable))
        assertEquals(listOf(durable), store.snapshot().persistedMessages)
        store.setPersistedMessages(listOf(durable, provisional))
        assertEquals(listOf(durable), store.snapshot().persistedMessages)
    }

    @Test
    fun provisionalAliasReplayCannotConsumeAnotherIdenticalSend() {
        val store = ChatTimelineStore()
        store.reset("s")
        val provisional = message("t-user", "user", "same").copy(turnId = "t")
        store.setPersistedMessages(listOf(provisional.copy(id = "durable")))
        store.appendOptimisticMessage(message("local-new", "user", "same"))
        store.mergePersistedMessages(listOf(provisional))
        assertEquals(listOf("local-new"), store.snapshot().optimisticMessages.map { it.id })
    }

    @Test
    fun distinctDurableMessagesAndTurnsNeverCollapseByContent() {
        val store = ChatTimelineStore()
        store.reset("s")
        val first = message("durable-1", "user", "same").copy(turnId = "t")
        val second = first.copy(id = "durable-2")
        val otherTurn = first.copy(id = "other-user", turnId = "other")
        val legacy = first.copy(id = "t-user", turnId = null)
        store.mergePersistedMessages(listOf(first, second, otherTurn, legacy))
        assertEquals(listOf(first, second, otherTurn, legacy), store.snapshot().persistedMessages)
    }

    @Test
    fun legacyTopLevelToolSnapshotsRetainMetadataAndDoNotRegress() {
        val store = ChatTimelineStore()
        store.reset("s")
        val turn = message("active-t", "assistant", "", "active").copy(turnId = "t")
        store.setActiveTurn(turn.copy(tools = listOf(
            RemoteToolStatusResponse(id = "tool", name = "Task", status = "running", inputPreview = "Inspect"))))
        store.setActiveTurn(turn.copy(tools = listOf(
            RemoteToolStatusResponse(id = "tool", status = "completed", resultPreview = "Done"))))
        store.setActiveTurn(turn.copy(tools = listOf(
            RemoteToolStatusResponse(id = "tool", status = "running"))))
        store.setActiveTurn(turn.copy(tools = emptyList()))
        val tool = store.snapshot().activeTurn!!.tools!!.single()
        assertEquals("Task", tool.name)
        assertEquals("Inspect", tool.inputPreview)
        assertEquals("completed", tool.status)
        assertEquals("Done", tool.resultPreview)
    }

    @Test
    fun delayedSendAckDoesNotResurrectCompletedReply() {
        val store = ChatTimelineStore()
        store.reset("s")
        store.appendOptimisticMessage(message("local", "user", "hello").copy(turnId = "client"))
        store.setPendingActiveTurn("local")
        store.mergePersistedMessages(listOf(
            message("user-final", "user", "hello").copy(turnId = "host"),
            message("answer", "assistant", "Finished", "completed").copy(turnId = "host"),
        ))
        store.acknowledgeOptimisticTurn("local", "host")
        store.setLocalActiveTurn("host")
        assertNull(store.snapshot().activeTurn)
        assertTrue(store.snapshot().optimisticMessages.isEmpty())
        assertEquals(ChatSyncPhase.IDLE, store.snapshot().syncPhase)
    }

    @Test
    fun turnAcknowledgementHandlesOldHostAndPollBeforeAckWithoutConsumingAnotherSend() {
        val store = ChatTimelineStore()
        store.reset("s")
        store.appendOptimisticMessage(message("local-1", "user", "same").copy(turnId = "client-1"))
        store.appendOptimisticMessage(message("local-2", "user", "same").copy(turnId = "client-2"))
        store.mergePersistedMessages(listOf(message("server", "user", "same").copy(turnId = "host-1")))
        assertEquals(2, store.snapshot().optimisticMessages.size)
        store.acknowledgeOptimisticTurn("local-1", "host-1")
        assertEquals(listOf("local-2"), store.snapshot().optimisticMessages.map { it.id })
        store.acknowledgeOptimisticTurn("local-2", "host-2")
        store.mergePersistedMessages(listOf(message("server-2", "user", "same").copy(turnId = "host-2")))
        assertTrue(store.snapshot().optimisticMessages.isEmpty())
    }

    @Test
    fun partialToolCompletionRetainsInvocationAndOutput() {
        val store = ChatTimelineStore()
        store.reset("s")
        val running = RemoteToolStatusResponse(id = "tool", name = "Task", status = "running",
            inputPreview = "Inspect files", stdout = "progress")
        store.setActiveTurn(message("active-t", "assistant", "", "active").copy(
            turnId = "t", items = listOf(ChatMessageItemResponse(type = "tool", tool = running))))
        store.setActiveTurn(message("active-t", "assistant", "", "active").copy(
            turnId = "t", items = listOf(ChatMessageItemResponse(type = "tool",
                tool = RemoteToolStatusResponse(id = "tool", status = "completed", resultPreview = "done")))))
        val tool = store.snapshot().activeTurn!!.items!!.single().tool!!
        assertEquals("completed", tool.status)
        assertEquals("Task", tool.name)
        assertEquals("Inspect files", tool.inputPreview)
        assertEquals("progress", tool.stdout)
        assertEquals("done", tool.resultPreview)
    }

    @Test
    fun ownsOptimisticMergeAndActiveTurnCleanupRules() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.appendOptimisticMessage(message("msg-local-1", "user", "Please edit"))
        store.setActiveTurn(message("active-turn-1", "assistant", "Final text", "completed"))
        store.mergePersistedMessages(listOf(message("remote-user-1", "user", "Please edit")))

        var state = store.snapshot()
        assertEquals(1, state.persistedMessages.size)
        assertEquals(0, state.optimisticMessages.size)
        assertEquals("active-turn-1", state.activeTurn?.id)
        assertEquals(ChatSyncPhase.FINALIZING, state.syncPhase)

        val final = message("assistant-final-1", "assistant", "Final text")
        store.mergePersistedMessages(listOf(final))
        state = store.snapshot()
        assertEquals(2, state.persistedMessages.size)
        assertEquals(null, state.activeTurn)
        assertEquals(listOf("message-remote-user-1", "message-assistant-final-1"), store.project(false).map { it.id })

        store.mergePersistedMessages(listOf(final))
        assertEquals(2, store.snapshot().persistedMessages.size)
        assertEquals(listOf("message-remote-user-1", "message-assistant-final-1"), store.project(false).map { it.id })
    }

    @Test
    fun onePersistedMessageAcknowledgesOnlyOneRepeatedOptimisticSend() {
        val store = ChatTimelineStore()
        store.reset("session-repeated")
        store.appendOptimisticMessage(message("msg-local-1", "user", "same request"))
        store.appendOptimisticMessage(message("msg-local-2", "user", "same request"))

        store.mergePersistedMessages(listOf(message("remote-user-1", "user", "same request")))

        assertEquals(listOf("msg-local-2"), store.snapshot().optimisticMessages.map { it.id })
    }

    @Test
    fun replayedHistoryCannotAcknowledgeANewRepeatedSend() {
        val store = ChatTimelineStore()
        store.reset("session-replay")
        val history = message("remote-user-1", "user", "same request")
        store.setPersistedMessages(listOf(history))
        store.appendOptimisticMessage(message("msg-local-2", "user", "same request"))

        store.mergePersistedMessages(listOf(history))

        assertEquals(listOf("msg-local-2"), store.snapshot().optimisticMessages.map { it.id })
    }

    @Test
    fun anOlderIdenticalAssistantMessageDoesNotHideTheActiveTurn() {
        val store = ChatTimelineStore()
        store.reset("session-repeat-assistant")
        store.setPersistedMessages(listOf(message("older", "assistant", "same answer")))
        store.setActiveTurn(activeMessage("new-turn", "same answer", "completed"))

        assertEquals("active-new-turn", store.snapshot().activeTurn?.id)

        store.mergePersistedMessages(listOf(message("new-final", "assistant", "same answer")))
        assertNull(store.snapshot().activeTurn)
    }

    @Test
    fun appliesTransportNeutralTurnEvents() {
        val store = ChatTimelineStore()
        store.reset("session-events")
        store.applyEvent(ConversationEvent.TurnStarted("session-events", "turn-1"))
        store.applyEvent(ConversationEvent.AssistantDelta("session-events", "turn-1", "Hello"))
        store.applyEvent(ConversationEvent.AssistantDelta("session-events", "turn-1", " world"))

        val state = store.snapshot()
        assertEquals("Hello world", state.activeTurn?.text)
        assertEquals("turn-1", state.activeTurn?.turnId)
        assertEquals(ChatSyncPhase.STREAMING, state.syncPhase)
    }

    @Test
    fun ignoresEventsFromDifferentSession() {
        val store = ChatTimelineStore()
        store.reset("session-current")
        store.applyEvent(ConversationEvent.TurnStarted("session-other", "turn-other"))
        store.applyEvent(ConversationEvent.AssistantDelta("session-other", "turn-other", "stale"))

        assertEquals(null, store.snapshot().activeTurn)
    }

    @Test
    fun replacesPendingActiveTurnWithRemoteTurn() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        val pendingId = store.setPendingActiveTurn("msg-local-1")

        assertEquals("active-pending-msg-local-1", pendingId)
        assertEquals(ChatSyncPhase.STREAMING, store.snapshot().syncPhase)
        store.setLocalActiveTurn("turn-remote-1")

        assertEquals("active-turn-remote-1", store.snapshot().activeTurn?.id)
        assertEquals("turn-remote-1", store.snapshot().activeTurn?.turnId)
    }

    @Test
    fun keepsStreamedTextFromGoingBackwards() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-stream-1", "abcdef"))
        store.setActiveTurn(activeMessage("turn-stream-1", "abc", "active", 2))

        val state = store.snapshot()
        assertEquals("abcdef", state.activeTurn?.text)
        assertEquals("turn-stream-1", state.activeTurn?.turnId)
        assertEquals(2, state.activeTurn?.renderVersion)
    }

    @Test
    fun monotonicallyMergesStructuredTextItems() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        val first = activeMessage("turn-items-1", "")
            .copy(items = listOf(ChatMessageItemResponse(type = "text", content = "abcdef")))
        val second = activeMessage("turn-items-1", "", "active", 2)
            .copy(items = listOf(ChatMessageItemResponse(type = "text", content = "abc")))

        store.setActiveTurn(first)
        store.setActiveTurn(second)

        assertEquals("abcdef", store.snapshot().activeTurn?.items?.firstOrNull()?.content)
    }

    @Test
    fun exactContentMatchRetainsEarlierPreviousItemWithoutDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1a")
        store.setActiveTurn(activeMessage("turn-r1a", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "Hello world"),
        )))
        store.setActiveTurn(activeMessage("turn-r1a", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello world"),
        )))

        assertEquals(listOf("Hello", "Hello world"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun concatenatedAdjacentTextItemsAreCollapsedByIncomingPrefix() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1b")
        store.setActiveTurn(activeMessage("turn-r1b", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1b", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello World"),
        )))

        assertEquals(listOf("Hello World"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun partialPrefixTextSnapshotKeepsTrailingTextBlock() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1f")
        store.setActiveTurn(activeMessage("turn-r1f", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1f", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello W"),
        )))

        assertEquals(listOf("Hello W", "World"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun partialPrefixThinkingSnapshotKeepsTrailingThinkingBlock() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-thinking-partial")
        store.setActiveTurn(activeMessage("turn-r1-thinking-partial", "").copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "Hello"),
            ChatMessageItemResponse(type = "thinking", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1-thinking-partial", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "Hello W"),
        )))

        assertEquals(listOf("Hello W", "World"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun partialPrefixWithInterleavedToolKeepsToolAndTrailingBlock() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-tool-partial")
        store.setActiveTurn(activeMessage("turn-r1-tool-partial", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
            ChatMessageItemResponse(
                type = "tool",
                tool = RemoteToolStatusResponse(id = "tool-r1-partial", name = "read_file", status = "running"),
            ),
        )))
        store.setActiveTurn(activeMessage("turn-r1-tool-partial", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello W"),
        )))

        assertEquals(
            listOf("Hello W", "World", "tool-r1-partial"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun incomingCoveringFullSpacedJoinCollapsesWithoutDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-spaced-full")
        store.setActiveTurn(activeMessage("turn-r1-spaced-full", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1-spaced-full", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello World!"),
        )))

        assertEquals(listOf("Hello World!"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun thinkingCoveringFullSpacedJoinCollapsesWithoutDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-thinking-full")
        store.setActiveTurn(activeMessage("turn-r1-thinking-full", "").copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "Hello"),
            ChatMessageItemResponse(type = "thinking", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1-thinking-full", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "Hello World!"),
        )))

        assertEquals(listOf("Hello World!"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun incomingCoveringFullCompactJoinCollapsesWithoutDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-compact-full")
        store.setActiveTurn(activeMessage("turn-r1-compact-full", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1-compact-full", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "HelloWorld!"),
        )))

        assertEquals(listOf("HelloWorld!"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun singleTextBlockSplitAcrossIncomingItemsDoesNotDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1c")
        store.setActiveTurn(activeMessage("turn-r1c", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "abcdef"),
        )))
        store.setActiveTurn(activeMessage("turn-r1c", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "abc"),
            ChatMessageItemResponse(type = "text", content = "def"),
        )))

        assertEquals(listOf("abc", "def"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun thinkingBlockSplitAcrossIncomingItemsDoesNotDuplicate() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1-thinking")
        store.setActiveTurn(activeMessage("turn-r1-thinking", "").copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "abcdef"),
        )))
        store.setActiveTurn(activeMessage("turn-r1-thinking", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "thinking", content = "abc"),
            ChatMessageItemResponse(type = "thinking", content = "def"),
        )))

        assertEquals(listOf("abc", "def"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun splitAroundNewToolKeepsTextAndToolOrder() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r2c")
        store.setActiveTurn(activeMessage("turn-r2c", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "abcdef"),
        )))
        store.setActiveTurn(activeMessage("turn-r2c", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "abc"),
            ChatMessageItemResponse(
                type = "tool",
                tool = RemoteToolStatusResponse(id = "tool-r2c", name = "read_file", status = "running"),
            ),
            ChatMessageItemResponse(type = "text", content = "def"),
        )))

        assertEquals(
            listOf("abc", "tool-r2c", "def"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun boundaryShiftBetweenAdjacentBlocksKeepsTotalText() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1d")
        store.setActiveTurn(activeMessage("turn-r1d", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "ab"),
            ChatMessageItemResponse(type = "text", content = "c"),
        )))
        store.setActiveTurn(activeMessage("turn-r1d", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "a"),
            ChatMessageItemResponse(type = "text", content = "bc"),
        )))

        assertEquals(listOf("a", "bc"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun shorterPrefixSnapshotDoesNotSwallowAdjacentBlocks() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r1e")
        store.setActiveTurn(activeMessage("turn-r1e", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hello"),
            ChatMessageItemResponse(type = "text", content = "World"),
        )))
        store.setActiveTurn(activeMessage("turn-r1e", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "Hell"),
        )))

        assertEquals(listOf("Hello", "World"), store.snapshot().activeTurn?.items.orEmpty().map { it.content })
    }

    @Test
    fun newToolAnchorsBeforeItsNextMatchedPreviousItem() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r2")
        store.setActiveTurn(activeMessage("turn-r2", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "text A"),
            ChatMessageItemResponse(type = "text", content = "text B"),
        )))
        store.setActiveTurn(activeMessage("turn-r2", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(
                type = "tool",
                tool = RemoteToolStatusResponse(id = "tool-r2", name = "read_file", status = "running"),
            ),
            ChatMessageItemResponse(type = "text", content = "text B'"),
        )))

        assertEquals(
            listOf("text A", "tool-r2", "text B'"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun continuousDeltasKeepStableProjectedRowAndMonotonicText() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.applyEvent(ConversationEvent.AssistantDelta("session-1", "turn-delta-1", "Hello"))
        val first = store.project(false)
        store.applyEvent(ConversationEvent.AssistantDelta("session-1", "turn-delta-1", " world"))
        val second = store.project(false)

        assertEquals("Hello world", store.snapshot().activeTurn?.text)
        assertEquals("active-turn-delta-1", first.single().id)
        assertEquals(first.single().id, second.single().id)
    }

    @Test
    fun interleavedToolSnapshotDoesNotDuplicateTextItems() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        val first = activeMessage("turn-interleaved-1", "").copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A"),
                ChatMessageItemResponse(type = "text", content = "text B"),
            ),
        )
        val second = activeMessage("turn-interleaved-1", "", "active", 2).copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A'"),
                ChatMessageItemResponse(
                    type = "tool",
                    tool = RemoteToolStatusResponse(id = "tool-interleaved-1", name = "read_file", status = "completed"),
                ),
                ChatMessageItemResponse(type = "text", content = "text B'"),
            ),
        )

        store.setActiveTurn(first)
        store.setActiveTurn(second)

        assertEquals(
            listOf("text A'", "tool-interleaved-1", "text B'"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun omittedToolKeepsItsOriginalServerOrderSlot() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-omitted-tool-1", "").copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A"),
                ChatMessageItemResponse(
                    type = "tool",
                    tool = RemoteToolStatusResponse(id = "tool-omitted-1", name = "read_file", status = "completed"),
                ),
                ChatMessageItemResponse(type = "text", content = "text B"),
            ),
        ))
        store.setActiveTurn(activeMessage("turn-omitted-tool-1", "", "active", 1).copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A'"),
                ChatMessageItemResponse(type = "text", content = "text B'"),
            ),
        ))

        assertEquals(
            listOf("text A'", "tool-omitted-1", "text B'"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun newToolWithOmittedOldTextKeepsOldBlockAndDoesNotJumpIt() {
        val store = ChatTimelineStore()
        store.reset("session-merge-r2d")
        store.setActiveTurn(activeMessage("turn-r2d", "").copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "text A"),
            ChatMessageItemResponse(type = "text", content = "text B"),
            ChatMessageItemResponse(type = "text", content = "text C"),
        )))
        store.setActiveTurn(activeMessage("turn-r2d", "", "active", 1).copy(items = listOf(
            ChatMessageItemResponse(type = "text", content = "text A'"),
            ChatMessageItemResponse(
                type = "tool",
                tool = RemoteToolStatusResponse(id = "tool-r2d", name = "read_file", status = "running"),
            ),
            ChatMessageItemResponse(type = "text", content = "text C'"),
        )))

        assertEquals(
            listOf("text A'", "text B", "tool-r2d", "text C'"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content ?: it.tool?.id },
        )
    }

    @Test
    fun adjacentSameTypeBlocksUseContentAffinityForPartialSnapshots() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-adjacent-1", "").copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A"),
                ChatMessageItemResponse(type = "text", content = "text B"),
            ),
        ))
        store.setActiveTurn(activeMessage("turn-adjacent-1", "", "active", 1).copy(
            items = listOf(
                ChatMessageItemResponse(type = "text", content = "text A'"),
                ChatMessageItemResponse(type = "text", content = "text C"),
            ),
        ))

        assertEquals(
            listOf("text A'", "text B", "text C"),
            store.snapshot().activeTurn?.items.orEmpty().map { it.content },
        )
    }

    @Test
    fun staleStructuredSnapshotCannotRegressNewerText() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-order-1", "", "active", 2).copy(
            items = listOf(ChatMessageItemResponse(type = "text", content = "newer text")),
        ))
        store.setActiveTurn(activeMessage("turn-order-1", "", "active", 1).copy(
            items = listOf(ChatMessageItemResponse(type = "text", content = "stale")),
        ))

        assertEquals("newer text", store.snapshot().activeTurn?.items?.single()?.content)
    }

    @Test
    fun updatesToolStatusFromLatestStructuredSnapshot() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        val first = activeMessage("turn-tool-1", "").copy(
            items = listOf(
                ChatMessageItemResponse(
                    type = "tool",
                    tool = RemoteToolStatusResponse(id = "tool-1", name = "read_file", status = "running"),
                ),
            ),
        )
        val second = activeMessage("turn-tool-1", "", "active", 2).copy(
            items = listOf(
                ChatMessageItemResponse(
                    type = "tool",
                    tool = RemoteToolStatusResponse(
                        id = "tool-1",
                        name = "read_file",
                        status = "completed",
                        durationMs = 50,
                    ),
                ),
            ),
        )

        store.setActiveTurn(first)
        store.setActiveTurn(second)

        val tool = store.snapshot().activeTurn?.items?.firstOrNull()?.tool
        assertEquals("completed", tool?.status)
        assertEquals(50, tool?.durationMs)
    }

    @Test
    fun clearsActiveTurnWhenPersistedAssistantMatchesTurn() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-final-store-1", "partial active text", "completed", 0))
        store.mergePersistedMessages(listOf(message("turn-final-store-1_assistant", "assistant", "rewritten final text")))

        assertEquals(1, store.snapshot().persistedMessages.size)
        assertEquals(null, store.snapshot().activeTurn)
    }

    @Test
    fun holdsCompletedTurnUntilPersistedAssistantHasFinalContent() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setActiveTurn(activeMessage("turn-final-wait-1", "final answer", "completed", 0))
        store.mergePersistedMessages(
            listOf(message("turn-final-wait-1_assistant", "assistant", "Still reasoning", thinking = "Still reasoning")),
        )
        store.setActiveTurn(null)

        assertEquals("active-turn-final-wait-1", store.snapshot().activeTurn?.id)
        assertEquals(ChatSyncPhase.FINALIZING, store.snapshot().syncPhase)
        store.mergePersistedMessages(listOf(message("turn-final-wait-1_assistant", "assistant", "final answer")))
        assertEquals(null, store.snapshot().activeTurn)
    }

    @Test
    fun keepsFirstReplyUnderTheMessageThatStartedIt() {
        val store = ChatTimelineStore()
        store.reset("session-anchor")
        store.appendOptimisticMessage(message("local-1", "user", "Question"))
        store.setPendingActiveTurn("local-1")

        assertEquals("local-1", store.activeTurnAnchorId())
        assertEquals(
            listOf(
                ChatTimelineItemType.OPTIMISTIC_USER_MESSAGE,
                ChatTimelineItemType.ASSISTANT_LIVE_TURN,
            ),
            store.project(false).map { it.type },
        )

        store.setLocalActiveTurn("turn-1")
        assertEquals("local-1", store.activeTurnAnchorId())
        assertEquals(
            listOf("pending-local-1", "active-turn-1"),
            store.project(false).map { it.id },
        )
    }

    @Test
    fun keepsMessageSentMidRunBelowTheReply() {
        val store = ChatTimelineStore()
        store.reset("session-mid-run")
        store.mergePersistedMessages(listOf(message("user-1", "user", "First")))
        store.setLocalActiveTurn("turn-1")
        store.appendOptimisticMessage(message("local-2", "user", "Second"))

        assertEquals(
            listOf("message-user-1", "active-turn-1", "pending-local-2"),
            store.project(false).map { it.id },
        )
    }

    @Test
    fun clearsAnchorWhenActiveTurnIsPersisted() {
        val store = ChatTimelineStore()
        store.reset("session-handoff")
        store.appendOptimisticMessage(message("local-1", "user", "Question"))
        store.setPendingActiveTurn("local-1")
        store.setLocalActiveTurn("turn-1")

        store.applyEvent(ConversationEvent.AssistantMessage(message("turn-1_assistant", "assistant", "Reply")))

        assertEquals("", store.activeTurnAnchorId())
        assertNull(store.snapshot().activeTurn)
    }

    @Test
    fun rendersActiveTurnWithMissingAnchor() {
        val store = ChatTimelineStore()
        store.reset("session-no-anchor")
        store.mergePersistedMessages(listOf(message("user-1", "user", "First")))
        store.setLocalActiveTurn("turn-1")

        assertEquals("", store.activeTurnAnchorId())
        assertEquals("active-turn-1", store.project(false).single { it.type == ChatTimelineItemType.ASSISTANT_LIVE_TURN }.id)
    }

    @Test
    fun filtersSeedMessagesWhenSettingPersistedHistory() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setPersistedMessages(
            listOf(
                message("system-seed", "assistant", "Welcome", "ready"),
                message("user-1", "user", "Hello"),
            ),
        )

        assertEquals(listOf("user-1"), store.snapshot().persistedMessages.map { it.id })
    }

    @Test
    fun eventErrorMovesStoreToErrorPhase() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.applyEvent(ConversationEvent.Error("transport failure"))

        assertEquals(ChatSyncPhase.ERROR, store.snapshot().syncPhase)
        assertTrue(store.project(false).isNotEmpty())
        assertFalse(store.snapshot().selectedModelId.isNotEmpty())
    }

    @Test
    fun transcriptStartsAsThisDevicesCopyAndResetsBackToIt() {
        val store = ChatTimelineStore()
        store.reset("session-1")
        store.setPersistedMessages(listOf(message("user-1", "user", "Hello")))
        assertEquals(ChatTranscriptOrigin.CACHE, store.snapshot().origin)

        store.setTranscriptOrigin(ChatTranscriptOrigin.HOST)
        assertEquals(ChatTranscriptOrigin.HOST, store.snapshot().origin)
        store.setPersistedMessages(listOf(message("user-1", "user", "Hello"), message("a-1", "assistant", "Hi")))
        assertEquals(ChatTranscriptOrigin.HOST, store.snapshot().origin)

        // A restarted stream drops everything derived from the previous replay,
        // including the fact that the host had answered for it.
        store.reset("session-1")
        assertEquals(ChatTranscriptOrigin.CACHE, store.snapshot().origin)
        store.reset()
        assertEquals(ChatTranscriptOrigin.CACHE, store.snapshot().origin)
    }

    private fun message(
        id: String,
        role: String,
        text: String,
        status: String = if (role == "assistant") "done" else "sent",
        thinking: String? = null,
    ): ChatMessage = ChatMessage(
        id = id,
        role = role,
        text = text,
        status = status,
        renderVersion = null,
        turnId = null,
        detail = null,
        timestamp = null,
        thinking = thinking,
        tools = null,
        items = null,
        images = null,
        error = null,
    )

    private fun activeMessage(
        turnId: String,
        text: String,
        status: String = "active",
        renderVersion: Int? = null,
    ): ChatMessage = ChatMessage(
        id = "active-$turnId",
        role = "assistant",
        text = text,
        status = status,
        renderVersion = renderVersion,
        turnId = turnId,
        detail = null,
        timestamp = null,
        thinking = null,
        tools = null,
        items = null,
        images = null,
        error = null,
    )
}
