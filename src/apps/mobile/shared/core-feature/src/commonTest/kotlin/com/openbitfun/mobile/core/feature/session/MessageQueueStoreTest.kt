package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.*
import kotlinx.serialization.DeserializationStrategy
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MessageQueueStoreTest {
    @Test fun legacySnapshotsRetainRowsAndDoNotSendUnsupportedReorder() = runTest {
        val host = Host().apply { supportsReorder = false }
        var state = MessageQueueUiState()
        val store = MessageQueueStore(backgroundScope, host) { state = it }
        store.select("session", true); runCurrent()
        assertEquals(listOf("a", "b"), state.items.map { it.id })
        assertFalse(state.supportsReorder)
        store.move("b", "a"); runCurrent()
        assertEquals(MessageQueueFailure.UNSUPPORTED, state.failure)
        assertEquals(listOf("list"), host.requests.map { it.action })
    }

    @Test fun mutationUsesObservedEpochRevisionAndDoesNotOptimisticallyReorder() = runTest {
        val host = Host()
        var state = MessageQueueUiState()
        val store = MessageQueueStore(backgroundScope, host) { state = it }
        store.select("session", true); runCurrent()
        host.gate = CompletableDeferred()
        store.move("b", "a"); runCurrent()
        assertTrue(state.busy)
        assertEquals(listOf("a", "b"), state.items.map { it.id })
        val move = host.requests.last()
        assertEquals("reorder", move.action)
        assertEquals("epoch", move.queueEpoch)
        assertEquals(7, move.expectedRevision)
        assertEquals("a", move.beforeTurnId)
        assertNotNull(move.operationId)
        host.gate!!.complete(Unit); runCurrent()
        assertFalse(state.busy)
        assertEquals(listOf("b", "a"), state.items.map { it.id })
        assertEquals("epoch:8", state.revisionKey)
    }

    @Test fun lostMutationReplyKeepsRowsAndCannotAutomaticallyResubmit() = runTest {
        val host = Host()
        var state = MessageQueueUiState()
        val store = MessageQueueStore(backgroundScope, host) { state = it }
        store.select("session", true); runCurrent()
        host.failMutation = true
        store.move("b", "a"); runCurrent()
        assertEquals(MessageQueueFailure.OUTCOME_UNKNOWN, state.failure)
        assertEquals(listOf("a", "b"), state.items.map { it.id })
        store.move("b", "a"); runCurrent()
        assertEquals(1, host.requests.count { it.action == "reorder" })
        store.invalidate(); runCurrent()
        assertNull(state.failure)
        assertEquals(listOf("b", "a"), state.items.map { it.id })
        assertEquals(1, host.requests.count { it.action == "reorder" })
    }

    @Test fun changingSessionDuringMutationCannotPublishOldRows() = runTest {
        val host = Host()
        var state = MessageQueueUiState()
        val store = MessageQueueStore(backgroundScope, host) { state = it }
        store.select("session", true); runCurrent()
        host.gate = CompletableDeferred()
        store.move("b", "a"); runCurrent()
        store.select("another", true); runCurrent()
        host.gate!!.complete(Unit); runCurrent()
        assertEquals("another", state.sessionId)
        assertFalse(state.busy)
        assertEquals(listOf("other"), state.items.map { it.id })
    }

    @Test fun losingHostCapabilityRetainsTheVisibleMessages() = runTest {
        val host = Host()
        var state = MessageQueueUiState()
        val store = MessageQueueStore(backgroundScope, host) { state = it }
        store.select("session", true); runCurrent()
        store.select("session", false); runCurrent()
        assertEquals(listOf("a", "b"), state.items.map { it.id })
        assertEquals(MessageQueueFailure.UNSUPPORTED, state.failure)
        assertFalse(state.supported)
    }

    @Test fun backgroundAndUnsupportedHostDoNotPoll() = runTest {
        val host = Host()
        val store = MessageQueueStore(backgroundScope, host) {}
        store.select("session", false); runCurrent()
        assertTrue(host.requests.isEmpty())
        store.setForeground(false); store.select("session", true); runCurrent()
        assertTrue(host.requests.isEmpty())
        store.setForeground(true); runCurrent()
        assertEquals(1, host.requests.size)
        store.select(null, false); advanceTimeBy(20_000); runCurrent()
        assertEquals(1, host.requests.size)
    }

    private class Host : RemoteCommandTransport {
        val requests = mutableListOf<DialogQueueRequest>()
        var supportsReorder = true
        var order = listOf("a", "b")
        var revision = 7
        var gate: CompletableDeferred<Unit>? = null
        var failMutation = false
        override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
            val request = requireNotNull(command.request)
            requests += request
            if (request.action == "reorder") {
                gate?.await()
                order = listOf("b", "a"); revision++
                if (failMutation) error("Connection lost after acceptance")
            }
            val items = (if (request.sessionId == "another") listOf("other") else order).joinToString(",") {
                """{"turnId":"$it","displayContent":"$it","status":"queued","futureField":true}"""
            }
            val capability = if (supportsReorder) ",\"supportsReorder\":true" else ""
            return RelayJson.decodeFromString(deserializer, """{"resp":"dialog_queue_result","snapshot":{"sessionId":"${request.sessionId}","queueEpoch":"epoch","revision":$revision,"items":[$items]$capability}}""")
        }
    }
}
