package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.persistence.*
import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.*
import kotlin.test.*
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RuntimeTerminalStoreTest {
    @Test fun unsupportedHostReasonRemainsVisibleWithoutCreatingTerminal() = runTest {
        val host = FakeTerminalHost(false).apply { failureDetail = "Unsupported host operation: terminal_create" }
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null); advanceUntilIdle()
        assertTrue(store.state.value.failed)
        assertEquals(host.failureDetail, store.state.value.errorDetail)
        assertNull(store.state.value.sessionId)
        assertFalse(store.state.value.busy)
        store.stop()
        assertNull(store.state.value.errorDetail)
    }

    @Test fun recoveredEmptyHistoryClearsConnectionFailureWithoutChangingOutput() = runTest {
        val host = FakeTerminalHost().apply { live = true }
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null); advanceUntilIdle()
        val before = store.state.value
        host.errors.single()(IllegalStateException("Disconnected"))
        assertTrue(store.state.value.failed)
        host.events.emit(buildJsonObject { put("event", "relay://session-resumed") })
        advanceUntilIdle()
        assertFalse(store.state.value.failed)
        assertEquals(before.output, store.state.value.output)
        assertEquals(before.revision, store.state.value.revision)
        host.refuseWrite = true
        store.write("pwd\r"); advanceUntilIdle()
        assertTrue(store.state.value.failed)
        host.events.emit(buildJsonObject { put("event", "terminal-output") })
        advanceUntilIdle()
        assertTrue(store.state.value.failed)
        store.stop()
    }

    @Test fun nonAdvancingHistoryStopsWithoutDuplicatingOutput() = runTest {
        val host = FakeTerminalHost().apply { stalledHistory = true }
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null); advanceUntilIdle()
        assertEquals(listOf(0L, 5L), host.offsets)
        assertEquals("hello", store.state.value.output)
        assertTrue(store.state.value.failed)
        store.stop()
    }

    @Test fun hostOwnsTerminalAndPushNotificationReadsOnlyNewOutput() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", "saved-ssh")
        advanceUntilIdle()
        assertEquals("hello world", store.state.value.output)
        assertEquals(listOf(0L, 5L), host.offsets)
        val create = host.commands.first().args!!.jsonObject.getValue("request").jsonObject
        assertEquals("saved-ssh", create.getValue("connectionId").jsonPrimitive.content)
        assertEquals("/workspace", create.getValue("workingDirectory").jsonPrimitive.content)
        assertEquals("terminal-term1", host.stream)
        store.write("pwd\r")
        advanceUntilIdle()
        assertEquals("terminal_write", host.commands.last().command)
        store.close()
        advanceUntilIdle()
        assertNull(store.state.value.sessionId)
        assertEquals("terminal_close", host.commands.last().command)
        store.stop()
    }

    @Test fun rapidInputAndResizeAreBatchedAndStopDiscardsQueuedInput() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null); advanceUntilIdle()
        "pwd\r".forEach { store.write(it.toString()) }
        store.resize(100, 30); store.resize(120, 40)
        advanceUntilIdle()
        val writes = host.commands.filter { it.command == "terminal_write" }
        assertEquals(1, writes.size)
        assertEquals("pwd\r", writes.single().args!!.jsonObject.getValue("request").jsonObject.getValue("data").jsonPrimitive.content)
        val sizes = host.commands.filter { it.command == "terminal_resize" }
        assertEquals(1, sizes.size)
        assertEquals(120, sizes.single().args!!.jsonObject.getValue("request").jsonObject.getValue("cols").jsonPrimitive.int)
        assertEquals(2L, store.state.value.revision)
        store.write("must-not-send"); store.stop(); advanceUntilIdle()
        assertEquals(1, host.commands.count { it.command == "terminal_write" })
    }

    @Test fun callbacksFromStoppedStreamCannotFailReplacementTerminal() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/first", null); advanceUntilIdle()
        val staleError = host.errors.single()
        store.stop()
        store.open("/second", "ssh"); advanceUntilIdle()
        val replacement = store.state.value
        staleError(IllegalStateException("Old transport closed"))
        advanceUntilIdle()
        assertEquals(replacement, store.state.value)
        host.errors.last()(IllegalStateException("Current transport closed"))
        assertTrue(store.state.value.failed)
        store.stop()
    }

    @Test fun lateCloseCannotStopReplacementTerminal() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/first", null); advanceUntilIdle()
        host.holdClose = true
        store.close(); advanceUntilIdle()
        store.stop()
        store.open("/second", "ssh"); advanceUntilIdle()
        val replacement = store.state.value
        host.closeContinuation!!.resume(Unit)
        advanceUntilIdle()
        assertEquals(replacement, store.state.value)
        store.stop()
    }

    @Test fun hostRefusalDoesNotReportAnOpenTerminal() = runTest {
        val host = FakeTerminalHost(false)
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null)
        advanceUntilIdle()
        assertNull(store.state.value.sessionId)
        assertTrue(store.state.value.failed)
        store.stop()
    }

    @Test fun refusedClosePreservesTerminalAndAllowsRetry() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/workspace", null); advanceUntilIdle()
        val original = store.state.value
        host.refuseClose = true
        store.close(); advanceUntilIdle()
        assertEquals(original.sessionId, store.state.value.sessionId)
        assertEquals(original.output, store.state.value.output)
        assertTrue(store.state.value.failed)
        assertFalse(store.state.value.busy)
        host.refuseClose = false
        store.close(); advanceUntilIdle()
        assertNull(store.state.value.sessionId)
        assertFalse(store.state.value.failed)
        store.stop()
    }

    @Test fun reopeningUsesOriginalSshLocationAndDisconnectForgetsIt() = runTest {
        val host = FakeTerminalHost()
        val store = RuntimeTerminalStore(this, host, MemoryReplica())
        store.open("/ssh/project", "saved-ssh"); advanceUntilIdle()
        store.close(); advanceUntilIdle()
        store.reopen(); advanceUntilIdle()
        val creations = host.commands.filter { it.command == "terminal_create" }
        assertEquals(2, creations.size)
        assertEquals(creations.first().args, creations.last().args)
        store.stop()
        store.reopen(); advanceUntilIdle()
        assertEquals(2, host.commands.count { it.command == "terminal_create" })
        assertNull(store.state.value.sessionId)
    }
}

private class FakeTerminalHost(private val accepted: Boolean = true) : RemoteCommandTransport, RemoteSessionStreamTransport {
    val commands = mutableListOf<RemoteCommand>()
    val offsets = mutableListOf<Long>()
    var stream = ""
    var failureDetail = ""
    var live = false
    val events = kotlinx.coroutines.flow.MutableSharedFlow<JsonObject>(extraBufferCapacity = 4)
    var holdClose = false
    var stalledHistory = false
    var refuseClose = false
    var refuseWrite = false
    var closeContinuation: Continuation<Unit>? = null
    val errors = mutableListOf<(Throwable) -> Unit>()
    override val streamIdentity = "test-account-target"
    override suspend fun subscribe(sessionId: String, replica: SessionStreamReplica, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> {
        stream = sessionId
        errors += onError
        return flow { onCaughtUp(); emit(buildJsonObject { put("event", "terminal-output") }); if (live) events.collect { emit(it) } }
    }
    override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
        commands += command
        if (command.command == "terminal_close" && holdClose) suspendCoroutine<Unit> { closeContinuation = it }
        val value = when (command.command) {
            "terminal_create" -> """{"id":"term1"}"""
            "terminal_get_history" -> {
                val offset = command.args!!.jsonObject.getValue("afterOffset").jsonPrimitive.long
                offsets += offset
                if (offset == 11L) """{"data":"","nextOffset":11,"cursor":11,"truncated":false}"""
                else if (offset == 0L) """{"data":"hello","nextOffset":5,"cursor":11,"truncated":false}"""
                else if (stalledHistory) """{"data":"duplicate","nextOffset":5,"cursor":11,"truncated":false}"""
                else """{"data":" world","nextOffset":11,"cursor":11,"truncated":false}"""
            }
            else -> "null"
        }
        val ok = accepted && !(refuseClose && command.command == "terminal_close") && !(refuseWrite && command.command == "terminal_write")
        return RelayJson.decodeFromString(deserializer, """{"resp":"host_invoke_result","ok":$ok,"value":$value,"error":${JsonPrimitive(failureDetail)}}""")
    }
}
private class MemoryReplica : RelayStreamStore {
    override fun eventIds(stream: String) = emptyList<String>()
    override fun cursor(stream: String) = 0L
    override fun fragments(stream: String, eventId: String) = emptyList<String>()
    override fun commit(stream: String, fragments: List<PersistedRelayFragment>, cursor: Long) {}
}
