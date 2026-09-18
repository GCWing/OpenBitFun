package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.persistence.ChatLocalStore
import com.openbitfun.mobile.core.persistence.DraftStore
import com.openbitfun.mobile.core.persistence.MobilePersistenceStores
import com.openbitfun.mobile.core.persistence.PersistedChatMessage
import com.openbitfun.mobile.core.persistence.PersistedChatSession
import com.openbitfun.mobile.core.persistence.PersistedRemoteCursor
import com.openbitfun.mobile.core.persistence.PersistedRemoteMessage
import com.openbitfun.mobile.core.persistence.PersistedRemoteSession
import com.openbitfun.mobile.core.persistence.RemoteSessionListStore
import com.openbitfun.mobile.core.persistence.RemoteTranscriptStore
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.transport.RelayFailure
import com.openbitfun.mobile.core.transport.RelayTransportException
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlinx.coroutines.flow.*
import com.openbitfun.mobile.core.transport.RemoteSessionStreamTransport
import kotlinx.serialization.DeserializationStrategy
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteSessionPersistenceTest {
    @Test
    fun coldStartShowsCachedListThenServerList() = runTest {
        val stores = MemoryPersistence()
        stores.sessions.rows = listOf(PersistedRemoteSession(sessionId = "cached", title = "Cached"))
        val transport = PersistenceTransport()
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Load)
        assertEquals("cached", assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.single().id)
        advanceUntilIdle()
        assertEquals("server", assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.single().id)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun unavailableSessionCacheDoesNotOverrideRemoteList() = runTest {
        val stores = MemoryPersistence()
        stores.sessions.failLoad = true
        stores.sessions.failSave = true
        val store = RemoteSessionStore.create(this, PersistenceTransport(), "device-a", stores.stores)

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("server"), ready.sessions.map { it.id })
        assertEquals(false, ready.busy)
        store.stop()
    }

    @Test
    fun confirmedCreateReconcilePersistsByDeviceAndRebuildRestoresIt() = runTest {
        val stores = MemoryPersistence()
        stores.sessions.byDevice["device-b"] = listOf(PersistedRemoteSession(sessionId = "other", title = "Other"))
        val first = RemoteSessionStore.create(this, PersistenceTransport(), "device-a", stores.stores)
        val confirmed = RemoteSession(
            id = "created", title = "Created", agentType = "cowork", status = "active",
            updatedAt = "now", createdAt = "now", messageCount = 1,
            workspacePath = "/assistant", workspaceName = "Assistant",
        )

        assertEquals(true, first.reconcileConfirmedCreatedSession(confirmed))
        assertEquals(listOf("created"), stores.sessions.byDevice.getValue("device-a").map { it.sessionId })
        assertEquals(listOf("other"), stores.sessions.byDevice.getValue("device-b").map { it.sessionId })
        assertEquals("/assistant", stores.sessions.byDevice.getValue("device-a").single().workspacePath)

        assertEquals(true, stores.sessions.byDevice.getValue("device-a").single().pendingConfirmed)

        val laggingTransport = PersistenceTransport().apply { sessionsJson = "[]" }
        val rebuilt = RemoteSessionStore.create(this, laggingTransport, "device-a", stores.stores)
        rebuilt.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        val afterLaggingList = assertIs<RemoteSessionUiState.Ready>(rebuilt.state.value).sessions.single()
        assertEquals("created", afterLaggingList.id)
        assertEquals("/assistant", afterLaggingList.workspacePath)
        assertEquals(true, stores.sessions.byDevice.getValue("device-a").single().pendingConfirmed)

        laggingTransport.sessionsJson =
            """[{"id":"created","title":"Server calibrated","agent_type":"cowork","status":"idle","workspace_path":"/assistant","workspace_name":"Server assistant"}]"""
        rebuilt.dispatch(RemoteSessionIntent.Refresh)
        advanceUntilIdle()
        val calibrated = assertIs<RemoteSessionUiState.Ready>(rebuilt.state.value).sessions.single()
        assertEquals("Server calibrated", calibrated.title)
        assertEquals("Server assistant", calibrated.workspaceName)
        assertEquals(false, stores.sessions.byDevice.getValue("device-a").single().pendingConfirmed)
        first.stop()
        rebuilt.stop()
    }

    @Test
    fun validCreateIdIsDurableBeforeGatedModelInitializationAndSurvivesStop() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport()
        transport.commandGates["set_session_model"] = CompletableDeferred()
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(
            RemoteSessionIntent.CreateSessionOperation(
                "durable-create", "cowork", "Created", "", "model-primary", "/assistant",
            ),
        )
        runCurrent()

        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        val persisted = stores.sessions.byDevice.getValue("device-a").single()
        assertEquals("created", persisted.sessionId)
        assertEquals("/assistant", persisted.workspacePath)
        assertEquals(true, persisted.pendingConfirmed)
        store.stop()
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)

        val rebuiltTransport = PersistenceTransport().apply { sessionsJson = "[]" }
        val rebuilt = RemoteSessionStore.create(this, rebuiltTransport, "device-a", stores.stores)
        rebuilt.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        assertEquals("created", assertIs<RemoteSessionUiState.Ready>(rebuilt.state.value).sessions.single().id)
        rebuilt.stop()
    }

    @Test
    fun draftIsSavedRestoredAndClearedAfterSend() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport()
        val first = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        first.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        first.dispatch(RemoteSessionIntent.UpdateDraft("keep me"))
        assertEquals("keep me", stores.drafts.values["remote-composer:device-a:server"])
        val second = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        second.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals("keep me", assertIs<RemoteSessionUiState.Ready>(second.state.value).draft)
        second.dispatch(RemoteSessionIntent.SendMessage("server", "keep me")); runCurrent()
        assertEquals(null, stores.drafts.values["remote-composer:device-a:server"])
        first.dispatch(RemoteSessionIntent.Stop)
        second.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun completedRecordIsPersistedAndRestoredBeforeReconnect() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "t-1", 0, 1, "inprogress", "All "))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        transport.records.emit(richRecord("server", "t-1", 0, 2, "completed", "All done")); runCurrent()
        assertEquals("All done", stores.transcripts.rows.getValue("device-a::server").last().text)
        store.stop()
        val reopened = RemoteSessionStore.create(this, PersistenceTransport(), "device-a", stores.stores)
        reopened.dispatch(RemoteSessionIntent.Open("server"))
        assertEquals("All done", assertIs<RemoteSessionUiState.Ready>(reopened.state.value).timeline?.persistedMessages?.last()?.text)
        runCurrent(); reopened.stop()
    }

    @Test
    fun replayRebuildsTheTranscriptOnceInsteadOfPerRecord() = runTest {
        // A long session replays record by record, and rebuilding the whole
        // transcript on each of them is what made the first seconds after an
        // open impossible to scroll. Nothing can read the result before
        // catch-up, so one rebuild and one write is the whole job.
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply {
            initialRecords = (0 until 8).map { richRecord("server", "t-$it", it, 1, "completed", "msg $it") }
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals(1, stores.transcripts.replaces)
        val timeline = assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline
        assertEquals("msg 7", timeline?.persistedMessages?.last()?.text)
        store.stop()
    }

    @Test
    fun streamingChunksShareOneTranscriptWriteAndSettleImmediately() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "t-1", 0, 1, "completed", "done"))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        val afterOpen = stores.transcripts.replaces
        (2..6).forEach { revision ->
            transport.records.emit(richRecord("server", "t-2", 1, revision.toLong(), "inprogress", "chunk $revision"))
            runCurrent()
        }
        assertEquals(afterOpen, stores.transcripts.replaces)
        advanceTimeBy(600); runCurrent()
        assertEquals(afterOpen + 1, stores.transcripts.replaces)
        transport.records.emit(richRecord("server", "t-2", 1, 7, "completed", "chunk done")); runCurrent()
        assertEquals(afterOpen + 2, stores.transcripts.replaces)
        assertEquals("chunk done", stores.transcripts.rows.getValue("device-a::server").last().text)
        store.stop()
    }

    @Test
    fun streamDisconnectRetainsPersistedTranscriptAndRecovers() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "t-1", 0, 1, "completed", "cached"))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        transport.streamFailure?.invoke(RelayTransportException(RelayFailure.NetworkUnreachable))
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        assertEquals("cached", stores.transcripts.rows.getValue("device-a::server").last().text)
        transport.caughtUp?.invoke()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        store.stop()
    }

    @Test
    fun partialRereadDoesNotTruncateOlderCachedMessages() = runTest {
        val stores = MemoryPersistence()
        stores.transcripts.rows["device-a::server"] = (0 until 120).map { i ->
            PersistedRemoteMessage(
                messageId = "m-$i", sessionId = "server", role = "assistant",
                text = "msg $i", payloadJson = "{}",
            )
        }
        val transport = PersistenceTransport()
        transport.messagesJson = (20 until 120).joinToString(prefix = "[", postfix = "]") { i ->
            "{\"id\":\"m-$i\",\"role\":\"assistant\",\"content\":\"msg $i\"}"
        }
        transport.hasMore = true
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals(120, stores.transcripts.rows["device-a::server"]?.size)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun completeCachedTranscriptAttachesStreamWithoutFullFetch() = runTest {
        val stores = MemoryPersistence()
        stores.transcripts.rows["device-a::server"] = listOf(
            PersistedRemoteMessage(
                messageId = "m-1", sessionId = "server", role = "assistant", text = "cached",
                payloadJson = "{}",
            ),
        )
        stores.transcripts.cursors["device-a::server"] = PersistedRemoteCursor("9", 1, "3")
        val transport = PersistenceTransport()
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)

        store.dispatch(RemoteSessionIntent.Open("server"))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("cached", ready.timeline?.persistedMessages?.single()?.text)
        assertFalse(ready.busy)
        assertTrue(transport.commands.none { it.cmd == "get_session_messages" })
        assertEquals(1, transport.subscriptions)
        assertTrue(transport.commands.none { it.cmd == "poll_session" })
        store.stop()
    }

    @Test
    fun authoritativeRecordRepairsHollowCachedAssistant() = runTest {
        val stores = MemoryPersistence()
        stores.transcripts.rows["device-a::server"] = listOf(PersistedRemoteMessage(
            messageId = "t-1_assistant", sessionId = "server", role = "assistant", text = "", payloadJson = "{}"))
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "t-1", 0, 1, "completed", "restored body"))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals("restored body", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.persistedMessages?.last()?.text)
        assertTrue(transport.commands.none { it.cmd in listOf("get_session_messages", "poll_session") })
        store.stop()
    }

    @Test
    fun canonicalHistoryReplacesLegacyCachedRows() = runTest {
        val stores = MemoryPersistence()
        stores.transcripts.rows["device-a::server"] = listOf(PersistedRemoteMessage(
            messageId = "obsolete", sessionId = "server", role = "assistant", text = "old", payloadJson = "{}"))
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "new", 0, 1, "completed", "replacement"))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals(listOf("new_user", "new_assistant"), stores.transcripts.rows.getValue("device-a::server").map { it.messageId })
        store.stop()
    }

    @Test
    fun deletedTurnCannotReappearFromTranscriptCache() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply {
            initialRecords = listOf(richRecord("server", "old", 0, 1, "completed", "removed"), richRecord("server", "keep", 1, 1, "completed", "retained"))
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        transport.records.emit(buildJsonObject {
            put("session_id", "server"); put("event", "session-record")
            put("payload", buildJsonObject { put("sessionId", "server"); put("id", "turn/old"); put("revision", 2); put("deleted", true) })
        }); runCurrent()
        assertEquals(listOf("keep_user", "keep_assistant"), stores.transcripts.rows.getValue("device-a::server").map { it.messageId })
        store.stop()
    }

    @Test
    fun deleteRemovesPersistedListDraftTranscriptAndCursor() = runTest {
        val stores = MemoryPersistence()
        stores.sessions.byDevice["device-a"] = listOf(
            PersistedRemoteSession(sessionId = "server", title = "Server"),
            PersistedRemoteSession(sessionId = "keep", title = "Keep"),
        )
        stores.sessions.more = true
        stores.drafts.values["remote-composer:device-a:server"] = "draft"
        stores.transcripts.rows["device-a::server"] = listOf(
            PersistedRemoteMessage(messageId = "m-1", sessionId = "server", text = "cached"),
        )
        stores.transcripts.cursors["device-a::server"] = PersistedRemoteCursor("7", 1, "2")
        val transport = PersistenceTransport().apply {
            sessionsJson = """[{"id":"server","title":"Server"},{"id":"keep","title":"Keep"}]"""
        }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        val expectedHasMore = stores.sessions.more

        store.dispatch(RemoteSessionIntent.DeleteSession("server"))
        advanceUntilIdle()

        assertEquals(listOf("keep"), stores.sessions.byDevice.getValue("device-a").map { it.sessionId })
        assertEquals(expectedHasMore, stores.sessions.more)
        assertEquals(null, stores.drafts.values["remote-composer:device-a:server"])
        assertEquals(null, stores.transcripts.rows["device-a::server"])
        assertEquals(null, stores.transcripts.cursors["device-a::server"])
        store.stop()
    }

    @Test
    fun deleteKeepsServerResultWhenSessionListCacheWriteFails() = runTest {
        val stores = MemoryPersistence()
        stores.drafts.values["remote-composer:device-a:server"] = "draft"
        stores.transcripts.rows["device-a::server"] = listOf(
            PersistedRemoteMessage(messageId = "m-1", sessionId = "server", text = "cached"),
        )
        val store = RemoteSessionStore.create(this, PersistenceTransport(), "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        stores.sessions.failSave = true

        store.dispatch(RemoteSessionIntent.DeleteSession("server"))
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(emptyList(), ready.sessions)
        assertEquals(false, ready.busy)
        assertEquals(null, stores.drafts.values["remote-composer:device-a:server"])
        assertEquals(null, stores.transcripts.rows["device-a::server"])
        store.stop()
    }

    @Test
    fun renameUpdatesPersistedListForOfflineRestore() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport()
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.RenameSession("server", "Renamed"))
        advanceUntilIdle()

        assertEquals("Renamed", stores.sessions.byDevice.getValue("device-a").single().title)
        store.stop()
    }

    @Test
    fun staleLoadMoreDoesNotWriteSessionPersistence() = runTest {
        val stores = MemoryPersistence()
        val transport = PersistenceTransport().apply { hasMore = true }
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        val savesBeforeLatePage = stores.sessions.saveCount

        transport.nonCancellableCommands += "list_sessions"
        store.dispatch(RemoteSessionIntent.LoadMore)
        runCurrent()
        val lateLoadMore = transport.lateCommandContinuations.remove("list_sessions")!!
        store.dispatch(RemoteSessionIntent.Open("server"))
        runCurrent()
        lateLoadMore.resume(Unit)
        runCurrent()

        assertEquals(savesBeforeLatePage, stores.sessions.saveCount)
        store.stop()
    }

    @Test
    fun corruptedPayloadIsRetainedAsDegradedMessage() = runTest {
        val stores = MemoryPersistence()
        stores.transcripts.rows["device-a::server"] = listOf(PersistedRemoteMessage(messageId = "bad", sessionId = "server", role = "assistant", text = "retained", payloadJson = "not-json"))
        val transport = PersistenceTransport()
        transport.messagesJson = "[{\"id\":\"bad\",\"role\":\"assistant\",\"content\":\"retained\"}]"
        val store = RemoteSessionStore.create(this, transport, "device-a", stores.stores)
        store.dispatch(RemoteSessionIntent.Open("server")); runCurrent()
        assertEquals("bad", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.persistedMessages?.single()?.id)
        assertEquals(1, stores.transcripts.rows["device-a::server"]?.size)
        store.dispatch(RemoteSessionIntent.Stop)
    }
}

private class MemoryPersistence {
    val drafts = MemoryDrafts()
    val sessions = MemorySessions()
    val transcripts = MemoryTranscripts()
    val stores = MobilePersistenceStores(drafts, NoOpChats(), sessions, transcripts)
}

private class MemoryDrafts : DraftStore {
    val values = mutableMapOf<String, String>()
    override fun load(draftId: String): String? = values[draftId]
    override fun save(draftId: String, text: String) { values[draftId] = text }
    override fun delete(draftId: String) { values.remove(draftId) }
}

private class NoOpChats : ChatLocalStore {
    override fun listSessions(agentType: String): List<PersistedChatSession> = emptyList()
    override fun loadSession(sessionId: String): PersistedChatSession? = null
    override fun loadMessages(sessionId: String): List<PersistedChatMessage> = emptyList()
    override fun saveSession(session: PersistedChatSession) = Unit
    override fun saveMessage(message: PersistedChatMessage) = Unit
    override fun pinSession(agentType: String, sessionId: String, pinned: Boolean) = Unit
    override fun setSessionStatus(sessionId: String, status: String) = Unit
    override fun deleteSession(sessionId: String) = Unit
}

private class MemorySessions : RemoteSessionListStore {
    var rows = emptyList<PersistedRemoteSession>()
    val byDevice = mutableMapOf<String, List<PersistedRemoteSession>>()
    var more = false
    var saveCount = 0
    var failLoad = false
    var failSave = false
    override fun load(deviceKey: String): List<PersistedRemoteSession> {
        if (failLoad) error("session cache read failed")
        return byDevice[deviceKey] ?: rows
    }
    override fun save(deviceKey: String, sessions: List<PersistedRemoteSession>, hasMore: Boolean) {
        if (failSave) error("session cache write failed")
        saveCount += 1
        rows = sessions
        byDevice[deviceKey] = sessions
        more = hasMore
    }
    override fun hasMore(deviceKey: String): Boolean = more
}

private class MemoryTranscripts : RemoteTranscriptStore {
    val rows = mutableMapOf<String, List<PersistedRemoteMessage>>()
    val cursors = mutableMapOf<String, PersistedRemoteCursor>()
    var replaces = 0
    override fun load(deviceKey: String, sessionId: String) = rows["$deviceKey::$sessionId"].orEmpty()
    override fun append(deviceKey: String, sessionId: String, startSeq: Int, messages: List<PersistedRemoteMessage>) = Unit
    override fun replace(deviceKey: String, sessionId: String, messages: List<PersistedRemoteMessage>) { replaces++; rows["$deviceKey::$sessionId"] = messages }
    override fun loadCursor(deviceKey: String, sessionId: String) = cursors["$deviceKey::$sessionId"]
    override fun saveCursor(deviceKey: String, sessionId: String, cursor: PersistedRemoteCursor) { cursors["$deviceKey::$sessionId"] = cursor }
    override fun delete(deviceKey: String, sessionId: String) {
        rows.remove("$deviceKey::$sessionId")
        cursors.remove("$deviceKey::$sessionId")
    }
}

private class PersistenceTransport : RemoteCommandTransport, RemoteSessionStreamTransport {
    var initialRecords = emptyList<JsonObject>()
    val records = MutableSharedFlow<JsonObject>(extraBufferCapacity = 10)
    var streamFailure: ((Throwable) -> Unit)? = null
    var caughtUp: (() -> Unit)? = null
    var subscriptions = 0
    override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> = flow {
        subscriptions++
        streamFailure = onError; caughtUp = onCaughtUp
        initialRecords.forEach { emit(it) }
        onCaughtUp()
        records.collect { emit(it) }
    }

    val commandGates = mutableMapOf<String, CompletableDeferred<Unit>>()
    val nonCancellableCommands = mutableSetOf<String>()
    val lateCommandContinuations = mutableMapOf<String, Continuation<Unit>>()
    var sessionsJson: String = """[{"id":"server","title":"Server","agent_type":"code"}]"""
    var messagesJson: String = "[]"
    var hasMore: Boolean = false
    var polls: List<String> = listOf("""{"resp":"ok","version":1,"changed":false,"session_state":"idle"}""")
    private var pollIndex = 0
    var pollFailure: RelayFailure? = null
    val commands = mutableListOf<RemoteCommand>()
    val sinceVersions = mutableListOf<Int>()
    val knownMessageCounts = mutableListOf<Int>()
    override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
        commands += command
        commandGates[command.cmd]?.await()
        if (nonCancellableCommands.remove(command.cmd)) {
            suspendCoroutine { continuation -> lateCommandContinuations[command.cmd] = continuation }
        }
        if (command.cmd == "poll_session") {
            sinceVersions += command.sinceVersion ?: 0
            knownMessageCounts += command.knownMessageCount ?: 0
            pollFailure?.let { throw RelayTransportException(it) }
        }
        val json = when (command.cmd) {
            "get_workspace_info" -> "{\"resp\":\"ok\",\"path\":\"/repo\",\"capabilities\":[\"host_stream_v1\"]}"
            "create_session" -> "{\"resp\":\"ok\",\"session_id\":\"created\",\"title\":\"Created\"}"
            "set_session_model" -> "{\"resp\":\"ok\",\"model_id\":\"model-primary\"}"
            "list_sessions" -> "{\"resp\":\"ok\",\"sessions\":$sessionsJson,\"has_more\":$hasMore}"
            "get_session_messages" -> "{\"resp\":\"ok\",\"messages\":$messagesJson,\"has_more\":$hasMore}"
            "get_permission_mode" -> "{\"resp\":\"ok\",\"mode\":\"ask\"}"
            "get_model_catalog" -> "{\"resp\":\"ok\",\"catalog\":{\"version\":0,\"models\":[],\"default_models\":{}}}"
            "poll_session" -> polls[minOf(pollIndex++, polls.lastIndex)]
            "send_message" -> "{\"resp\":\"ok\",\"turn_id\":\"t\"}"
            else -> "{\"resp\":\"ok\"}"
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}
