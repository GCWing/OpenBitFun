package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.protocol.ActiveTurnSnapshotResponse
import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.ChatMessageResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse
import com.openbitfun.mobile.core.protocol.SessionItemResponse
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.domain.ChatTimelineStore
import com.openbitfun.mobile.core.domain.SessionListVisibility
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemoteResponseMapperTest {
    @Test
    fun legacySessionPayloadRoundTripRemainsVisibleWithoutNewMetadata() {
        val payload = """{"session_id":"legacy","name":"Existing session","workspace_path":"/repo"}"""
        val decoded = RelayJson.decodeFromString<SessionItemResponse>(payload)
        val encoded = RelayJson.encodeToString(decoded)
        val roundTrip = RelayJson.decodeFromString<SessionItemResponse>(encoded)
        assertEquals(decoded, roundTrip)
        val fields = RelayJson.parseToJsonElement(encoded).jsonObject
        assertFalse("parent_session_id" in fields)
        assertFalse("relationship_kind" in fields)
        assertFalse("workspace_id" in fields)

        val session = RemoteResponseMapper.session(roundTrip)
        assertEquals("legacy", session.id)
        assertEquals("Existing session", session.title)
        assertEquals("/repo", session.workspacePath)
        assertNull(session.workspaceIdentity)
        assertNull(session.parentSessionId)
        assertNull(session.relationshipKind)
        assertTrue(SessionListVisibility.isMobileVisible(session))
    }

    @Test
    fun childSessionPayloadRoundTripPreservesRelationshipAndWorkspaceIdentity() {
        for (kind in listOf("", ",\"relationship_kind\":\"btw\"")) {
            val payload = """{"id":"child","workspace_path":"/repo","workspace_id":"ssh-workspace","parent_session_id":"parent"$kind}"""
            val decoded = RelayJson.decodeFromString<SessionItemResponse>(payload)
            val roundTrip = RelayJson.decodeFromString<SessionItemResponse>(RelayJson.encodeToString(decoded))
            assertEquals(decoded, roundTrip)

            val session = RemoteResponseMapper.session(roundTrip)
            assertEquals("ssh-workspace", session.workspaceIdentity?.workspaceId)
            assertEquals("parent", session.parentSessionId)
            assertEquals(if (kind.isEmpty()) null else "btw", session.relationshipKind)
            assertFalse(SessionListVisibility.isMobileVisible(session))
        }
    }

    @Test
    fun activeTurnCarriesPollVersionAsRenderVersion() {
        val turn = ActiveTurnSnapshotResponse(turnId = "turn-version", status = "active")

        assertEquals(7, RemoteResponseMapper.activeTurn(turn, renderVersion = 7).renderVersion)
        // A mapper-only call has no poll cursor, so its documented default is zero.
        assertEquals(0, RemoteResponseMapper.activeTurn(turn).renderVersion)
    }

    @Test
    fun lowerVersionPollSnapshotDoesNotRegressHigherVersionContent() {
        val turn = ActiveTurnSnapshotResponse(turnId = "turn-order", status = "active")
        val newer = RemoteResponseMapper.activeTurn(
            turn.copy(items = listOf(ChatMessageItemResponse(type = "text", content = "newer"))),
            renderVersion = 5,
        )
        val stale = RemoteResponseMapper.activeTurn(
            turn.copy(items = listOf(ChatMessageItemResponse(type = "text", content = "stale"))),
            renderVersion = 2,
        )
        val store = ChatTimelineStore().also { it.reset("session-f2") }

        store.setActiveTurn(newer)
        store.setActiveTurn(stale)

        assertEquals("newer", store.snapshot().activeTurn?.items?.firstOrNull()?.content)
    }

    @Test
    fun lowerVersionPollSnapshotDoesNotRegressTextItemsOrTools() {
        val turn = ActiveTurnSnapshotResponse(turnId = "turn-order-all", status = "active")
        val newer = RemoteResponseMapper.activeTurn(
            turn.copy(
                text = "newer text",
                items = listOf(ChatMessageItemResponse(type = "text", content = "newer item")),
                tools = listOf(RemoteToolStatusResponse(id = "tool-1", name = "read_file", status = "completed")),
            ),
            renderVersion = 5,
        )
        val stale = RemoteResponseMapper.activeTurn(
            turn.copy(
                text = "stale text",
                items = listOf(ChatMessageItemResponse(type = "text", content = "stale item")),
                tools = listOf(RemoteToolStatusResponse(id = "tool-1", name = "read_file", status = "running")),
            ),
            renderVersion = 2,
        )
        val store = ChatTimelineStore().also { it.reset("session-f2-all") }

        store.setActiveTurn(newer)
        store.setActiveTurn(stale)

        val active = store.snapshot().activeTurn
        assertEquals("newer text", active?.text)
        assertEquals("newer item", active?.items?.firstOrNull()?.content)
        assertEquals("completed", active?.tools?.firstOrNull()?.status)
    }

    @Test
    fun mapsAssistantMessagesAndNestedTools() {
        val message = RemoteResponseMapper.chatMessage(
            ChatMessageResponse(
                id = "m1",
                turnId = "turn-m1",
                role = "assistant",
                content = "",
                status = "failed",
                error = "Desktop process exited",
                thinking = "Thinking out loud",
                timestamp = "2026-06-10T12:00:00.000Z",
                items = listOf(
                    ChatMessageItemResponse(
                        type = "tool",
                        tool = RemoteToolStatusResponse(id = "tool-1", name = "shell", status = "pending"),
                        subItems = listOf(
                            ChatMessageItemResponse(
                                type = "tool",
                                tool = RemoteToolStatusResponse(id = "tool-2", name = "edit", status = "done"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("m1", message.id)
        assertEquals("", message.text)
        assertEquals("Thinking out loud", message.thinking)
        assertEquals("failed", message.status)
        assertEquals("turn-m1", message.turnId)
        assertEquals("Desktop process exited", message.error)
        assertEquals("shell · pending\nedit · done", message.detail)
        assertEquals(2, message.tools?.size)
    }

    @Test
    fun mapsActiveTurnWithItemFallbackTextAndExplicitTools() {
        val message = RemoteResponseMapper.activeTurn(
            ActiveTurnSnapshotResponse(
                turnId = "turn-1",
                status = "active",
                error = "Connection interrupted",
                items = listOf(ChatMessageItemResponse(type = "text", content = "Working on it")),
                tools = listOf(RemoteToolStatusResponse(id = "tool-3", name = "read_file", status = "running")),
            ),
        )

        assertEquals("active-turn-1", message.id)
        assertEquals("turn-1", message.turnId)
        assertEquals("Working on it", message.text)
        assertEquals("read_file · running", message.detail)
        assertEquals("Connection interrupted", message.error)
    }

    @Test
    fun doesNotPromoteSubagentProgressToActiveText() {
        val message = RemoteResponseMapper.activeTurn(
            ActiveTurnSnapshotResponse(
                turnId = "turn-structured",
                status = "active",
                items = listOf(
                    ChatMessageItemResponse(
                        type = "subagent",
                        isSubagent = true,
                        content = "Subagent check",
                        subItems = listOf(
                            ChatMessageItemResponse(type = "text", content = "Nested progress"),
                            ChatMessageItemResponse(
                                type = "tool",
                                tool = RemoteToolStatusResponse(id = "tool-nested-1", name = "inspect", status = "running"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        assertEquals("", message.text)
        assertEquals(1, message.tools?.size)
        assertTrue(message.detail?.contains("inspect") == true)
    }

    @Test
    fun mapsAlternateSessionFieldsAndSafeDefaults() {
        val session = RemoteResponseMapper.session(
            SessionItemResponse(
                id = "session-1",
                title = null,
                agentType = null,
                status = null,
                updatedAt = "1781092800000",
                createdAt = "2026-06-09 12:00:00",
                messageCount = null,
                workspacePath = null,
                workspaceName = null,
            ),
        )

        assertEquals("session-1", session.id)
        assertEquals("Session sessio", session.title)
        assertEquals("code", session.agentType)
        assertEquals("idle", session.status)
        assertEquals("1781092800000", session.updatedAt)
        assertEquals(0, session.messageCount)
    }
}
