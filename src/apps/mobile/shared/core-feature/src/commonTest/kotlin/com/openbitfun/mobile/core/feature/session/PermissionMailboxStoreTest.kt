package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.test.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.*
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PermissionMailboxStoreTest {
    @Test fun requestsWithoutToolCallsRemainAnswerableAndEditsUseRequestIdentity() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        assertEquals(listOf("request-id"), latest.requests.map { it.requestId })
        assertNull(latest.requests.single().toolCallId)
        assertEquals("question-id", latest.questions.single().id)
        assertTrue(latest.ownsToolInteraction("question-id"))
        assertFalse(latest.ownsToolInteraction("request-id"))
        assertFalse(latest.ownsToolInteraction(""))
        val linked = latest.copy(requests = listOf(latest.requests.single().copy(toolCallId = "permission-tool")))
        assertTrue(linked.ownsToolInteraction("permission-tool"))
        assertFalse(linked.ownsToolInteraction("another-tool"))
        assertEquals("Continue?", latest.questions.single().question)
        store.respond("request-id", true, """{"path":"/new"}"""); advanceUntilIdle()
        val reply = host.commands.first { it.command == "respond_permission" }.args!!.jsonObject.getValue("request").jsonObject
        assertEquals("request-id", reply.getValue("requestId").jsonPrimitive.content)
        assertEquals("once", reply.getValue("reply").jsonPrimitive.content)
        assertEquals("/new", reply.getValue("updatedInput").jsonObject.getValue("path").jsonPrimitive.content)
        host.ok = false; store.invalidate(); advanceUntilIdle()
        assertTrue(latest.failed); assertEquals(1, latest.requests.size)
        store.select(null); assertTrue(latest.requests.isEmpty())
    }
    @Test fun malformedEditIsRejectedWithoutSendingApproval() = runTest {
        val host = Host(); var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle(); store.respond("request-id", true, "[]"); advanceUntilIdle()
        assertTrue(latest.failed); assertTrue(host.commands.none { it.command == "respond_permission" })
    }
    @Test fun rejectionIgnoresMalformedApprovalDraft() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        store.respond("request-id", false, "{invalid"); advanceUntilIdle()
        val reply = host.commands.single { it.command == "respond_permission" }
            .args!!.jsonObject.getValue("request").jsonObject
        assertEquals("reject", reply.getValue("reply").jsonPrimitive.content)
        assertFalse("updatedInput" in reply)
        assertFalse(latest.failed)
    }

    @Test fun questionFailureIsVisibleAndCanBeRetriedWithoutSendingUnknownIds() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        store.startQuestion("stale-question"); advanceUntilIdle()
        assertTrue(host.commands.none { it.cmd == "start_question_interaction" })
        host.questionError = true
        store.startQuestion("question-id"); advanceUntilIdle()
        assertTrue(latest.failed)
        host.questionError = false
        store.startQuestion("question-id"); advanceUntilIdle()
        store.startQuestion("question-id"); advanceUntilIdle()
        assertFalse(latest.failed)
        assertEquals(2, host.commands.count { it.cmd == "start_question_interaction" })
        store.select(null)
        store.startQuestion("question-id"); advanceUntilIdle()
        assertEquals(2, host.commands.count { it.cmd == "start_question_interaction" })
    }
    @Test fun replyRemainsBusyUntilAuthoritativeRefreshAndCannotBeSubmittedTwice() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        val refreshGate = CompletableDeferred<Unit>()
        host.refreshGate = refreshGate
        store.respond("request-id", true, null); runCurrent()
        assertTrue(latest.busy)
        store.respond("request-id", false, null); runCurrent()
        assertEquals(1, host.commands.count { it.command == "respond_permission" })
        refreshGate.complete(Unit); advanceUntilIdle()
        assertFalse(latest.busy)
    }

    @Test fun leavingSessionCancelsPendingReplyRefreshWithoutRestoringOldRows() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        val refreshGate = CompletableDeferred<Unit>()
        host.refreshGate = refreshGate
        store.respond("request-id", true, null); runCurrent()
        assertTrue(latest.busy)
        store.select(null)
        refreshGate.complete(Unit); advanceUntilIdle()
        assertFalse(latest.busy)
        assertTrue(latest.requests.isEmpty())
        assertFalse(latest.failed)
    }

    @Test fun invalidatedInflightSnapshotNeverReplacesTheVisibleMailbox() = runTest {
        val host = Host()
        val published = mutableListOf<PermissionMailboxUiState>()
        val store = PermissionMailboxStore(this, host) { published += it }
        store.select("session"); advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        host.refreshGate = gate
        host.requestId = "stale-request"
        store.invalidate(); runCurrent()
        host.requestId = "current-request"
        store.invalidate()
        gate.complete(Unit); advanceUntilIdle()
        assertEquals("current-request", published.last().requests.single().requestId)
        assertTrue(published.none { state -> state.requests.any { it.requestId == "stale-request" } })
        assertEquals(3, host.commands.count { it.command == "get_session_interaction_mailbox" })
    }

    @Test fun questionAnswerFailureRetainsMailboxAndSuccessfulRetryRefreshesIt() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        val answers = buildJsonObject { put("0", "Yes") }
        assertFalse(store.answer("other", "question-id", answers))
        host.questionError = true
        assertTrue(store.answer("session", "question-id", answers)); advanceUntilIdle()
        assertTrue(latest.failed)
        assertEquals("question-id", latest.questions.single().id)
        host.questionError = false
        val gate = CompletableDeferred<Unit>()
        host.refreshGate = gate
        assertTrue(store.answer("session", "question-id", answers)); runCurrent()
        assertTrue(latest.busy)
        assertTrue(store.answer("session", "question-id", answers)); runCurrent()
        assertEquals(2, host.commands.count { it.cmd == "answer_question" })
        gate.complete(Unit); advanceUntilIdle()
        assertFalse(latest.busy); assertFalse(latest.failed)
        assertTrue(latest.questions.isEmpty())
        assertTrue(latest.ownsToolInteraction("question-id"))
        assertEquals(2, host.commands.count { it.command == "get_session_interaction_mailbox" })
        store.select(null)
        assertFalse(latest.ownsToolInteraction("question-id"))
    }

    @Test fun reconnectReplacesQueueAndIgnoresRequestsAnsweredByAnotherController() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        host.requestIds = listOf("one", "two")
        store.select("session"); advanceUntilIdle()
        host.ok = false
        store.invalidate(); advanceUntilIdle()
        assertTrue(latest.failed)
        assertEquals(listOf("one", "two"), latest.requests.map { it.requestId })
        host.requestIds = listOf("two"); host.ok = true
        store.invalidate(); advanceUntilIdle()
        assertFalse(latest.failed)
        assertEquals(listOf("two"), latest.requests.map { it.requestId })
        store.respond("one", true, null); advanceUntilIdle()
        assertTrue(host.commands.none { it.command == "respond_permission" })
        host.requestIds = emptyList()
        store.respond("two", false, null); advanceUntilIdle()
        val reply = host.commands.single { it.command == "respond_permission" }
            .args!!.jsonObject.getValue("request").jsonObject
        assertEquals("two", reply.getValue("requestId").jsonPrimitive.content)
        assertEquals("reject", reply.getValue("reply").jsonPrimitive.content)
        assertTrue(latest.requests.isEmpty())
    }

    @Test fun invalidationDuringFailedReadStillFetchesCurrentMailbox() = runTest {
        val host = Host()
        var latest = PermissionMailboxUiState(emptyList(), false, false)
        val store = PermissionMailboxStore(this, host) { latest = it }
        store.select("session"); advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        host.refreshGate = gate
        store.invalidate(); runCurrent()
        host.refreshGate = null
        host.requestId = "current-request"
        store.invalidate()
        gate.completeExceptionally(IllegalStateException("Old connection closed"))
        advanceUntilIdle()
        assertEquals("current-request", latest.requests.single().requestId)
        assertFalse(latest.failed)
        assertEquals(3, host.commands.count { it.command == "get_session_interaction_mailbox" })
    }

    private class Host : RemoteCommandTransport {
        var requestId = "request-id"
        var requestIds: List<String>? = null
        var ok = true
        var questionError = false
        var answered = false
        var refreshGate: CompletableDeferred<Unit>? = null
        val commands = mutableListOf<RemoteCommand>()
        override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
            commands += command
            val snapshotRequestId = requestId
            val snapshotRequests = (requestIds ?: listOf(snapshotRequestId)).joinToString(",") {
                """{"requestId":"$it","sessionId":"session","action":"write","resources":["/file"],"source":{"identity":"agent"}}"""
            }
            if (command.command == "get_session_interaction_mailbox") refreshGate?.await()
            if (command.cmd == "start_question_interaction" || command.cmd == "answer_question") {
                if (command.cmd == "answer_question" && !questionError) answered = true
                return RelayJson.decodeFromString(deserializer,
                    if (questionError) """{"resp":"error","message":"Question is unavailable"}"""
                    else """{"resp":"ok"}""")
            }
            val pendingQuestions = if (answered) "[]" else """[{"sessionId":"session","toolId":"question-id","questions":{"questions":[{"question":"Continue?"}]}}]"""
            val foreignRequest = """{"requestId":"other","sessionId":"other","action":"write"}"""
            val allRequests = listOf(snapshotRequests, foreignRequest).filter { it.isNotEmpty() }.joinToString(",")
            val value = if (command.command == "get_session_interaction_mailbox") """{"sessionId":"session","permissions":{"requests":[$allRequests]},"userQuestions":{"questions":$pendingQuestions}}""" else "null"
            return RelayJson.decodeFromString(deserializer, """{"resp":"host_invoke_result","ok":$ok,"value":$value}""")
        }
    }
}
