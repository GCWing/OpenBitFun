package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.persistence.RelayStreamStore
import com.openbitfun.mobile.core.persistence.PersistedRelayFragment
import com.openbitfun.mobile.core.transport.RemoteSessionStreamTransport
import com.openbitfun.mobile.core.transport.SessionStreamReplica
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.transport.RelayFailure
import com.openbitfun.mobile.core.transport.RelayTransportException
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceStore
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.DeserializationStrategy
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteSessionStoreTest {
    @Test
    fun firstHistoryReadDoesNotPublishAnEmptyOrPartialConversation() = runTest {
        val transport = FakeSessionTransport().apply {
            initialHistoryGate = CompletableDeferred()
            initialEvents = listOf(richRecord("s-code", "first", 0, 1, "completed", "answer"))
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load); runCurrent()
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        assertNull((store.state.value as? RemoteSessionUiState.Ready)?.timeline)
        transport.initialHistoryGate!!.complete(Unit); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-code", ready.selectedSessionId)
        assertTrue(ready.timeline!!.persistedMessages.isNotEmpty())
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun anEmptySessionIsEmptyOnlyAfterTheHistoryReadCompletes() = runTest {
        val transport = FakeSessionTransport().apply { initialHistoryGate = CompletableDeferred() }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        assertFalse(store.state.value is RemoteSessionUiState.Ready)
        transport.initialHistoryGate!!.complete(Unit); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertTrue(ready.timeline!!.persistedMessages.isEmpty())
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun initialHistoryCanRecoverAfterTransientStreamFailure() = runTest {
        val transport = FakeSessionTransport().apply { initialHistoryGate = CompletableDeferred() }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        transport.streamError!!.invoke(IllegalStateException("Temporary disconnect")); runCurrent()
        assertFalse(store.state.value is RemoteSessionUiState.Ready)
        transport.initialHistoryGate!!.complete(Unit); runCurrent()
        assertEquals("s-code", assertIs<RemoteSessionUiState.Ready>(store.state.value).selectedSessionId)
        store.stop()
    }

    @Test
    fun switchingSessionsCancelsThePreviousInitialHistoryWait() = runTest {
        val previousGate = CompletableDeferred<Unit>()
        val transport = FakeSessionTransport().apply { initialHistoryGate = previousGate }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        transport.initialHistoryGate = null
        store.dispatch(RemoteSessionIntent.Open("s-cowork")); runCurrent()
        assertEquals("s-cowork", assertIs<RemoteSessionUiState.Ready>(store.state.value).selectedSessionId)
        previousGate.complete(Unit); runCurrent()
        assertEquals("s-cowork", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline!!.sessionId)
        assertEquals(1, transport.activeSubscriptions)
        store.stop()
    }

    @Test
    fun additiveRevisionConstructorsKeepLegacySourceShape() {
        val succeeded = CreateSessionOperationState.Succeeded("request", "session", null)
        assertEquals(0, succeeded.commitRevision)
        val ready = RemoteSessionUiState.Ready(
            emptyList(), null, null, false, null, null, "", SessionAgentFilter.ALL,
            false, false, null, null, "",
        )
        assertEquals(0, ready.revision)
    }

    @Test
    fun listsSessionsForTheWorkspaceTheDesktopHasOpen() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("s-code", "s-cowork", "s-agentic"), ready.sessions.map { it.id })
        val list = transport.commands.first { it.cmd == "list_sessions" }
        // The desktop rejects list_sessions outright without a workspace, which is
        // why the store resolves one first instead of sending a bare command.
        assertEquals("/repo", list.workspacePath)
        assertEquals(30, list.limit)
        assertEquals(0, list.offset)
        assertNull(list.query)
        assertEquals("model-primary", ready.modelCatalog?.defaultModels?.primary)
        assertNull(ready.modelCatalogFailure)
    }

    @Test
    fun workspaceDirectoryIntentLoadsOnlyTheRequestedBranchWithoutChangingActiveState() = runTest {
        val transport = FakeSessionTransport().apply {
            listSessionsOverride = { _ ->
                """{"resp":"ok","has_more":false,"sessions":[{"id":"branch","title":"Branch","agent_type":"code"}]}"""
            }
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.LoadWorkspaceSessions("/other/repo/"))
        store.dispatch(RemoteSessionIntent.LoadWorkspaceSessions("/other/repo"))
        advanceUntilIdle()

        assertIs<RemoteSessionUiState.Idle>(store.state.value)
        val branch = store.workspaceDirectory.value.workspace("/other/repo")!!
        assertEquals(WorkspaceSessionDirectoryStatus.READY, branch.status)
        assertEquals(listOf("branch"), branch.sessions.map { it.id })
        assertEquals("/other/repo", branch.sessions.single().workspacePath)
        val requests = transport.commands.filter { it.cmd == "list_sessions" }
        assertEquals(1, requests.size)
        assertEquals("/other/repo", requests.single().workspacePath)
        assertEquals(50, requests.single().limit)
        assertTrue(transport.commands.none { it.cmd == "get_workspace_info" })
    }

    @Test
    fun workspaceDirectorySeparatesSamePathSshLoadsAndRetry() = runTest {
        val transport = FakeSessionTransport().apply {
            listSessionsOverride = { command ->
                """{"resp":"ok","has_more":false,"sessions":[{"id":"${command.remoteConnectionId}","title":"Branch","agent_type":"code"}]}"""
            }
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.LoadWorkspaceSessions("/repo", "a", "host-a"))
        store.dispatch(RemoteSessionIntent.LoadWorkspaceSessions("/repo", "b", "host-b"))
        advanceUntilIdle()
        val first = store.workspaceDirectory.value.workspace("/repo", "a", "host-a")!!
        val second = store.workspaceDirectory.value.workspace("/repo", "b", "host-b")!!
        assertEquals(listOf("a"), first.sessions.map { it.id })
        assertEquals(listOf("b"), second.sessions.map { it.id })
        assertEquals("host-a", first.sessions.single().workspaceIdentity?.remoteSshHost)
        assertNull(store.workspaceDirectory.value.workspace("/repo"))
        store.dispatch(RemoteSessionIntent.RetryWorkspaceSessions("/repo/", "a", "host-a"))
        advanceUntilIdle()
        val requests = transport.commands.filter { it.cmd == "list_sessions" }
        assertEquals(listOf("a", "b", "a"), requests.map { it.remoteConnectionId })
        assertEquals(listOf("host-a", "host-b", "host-a"), requests.map { it.remoteSshHost })
        assertEquals(2, store.workspaceDirectory.value.workspaces.size)
        assertEquals(second, store.workspaceDirectory.value.workspace("/repo", "b", "host-b"))
    }

    @Test
    fun slowCatalogDoesNotBlockAuthoritativeSessionNavigation() = runTest {
        val transport = FakeSessionTransport()
        val listGate = CompletableDeferred<Unit>()
        val catalogGate = CompletableDeferred<Unit>()
        transport.commandGates["list_sessions"] = listGate
        transport.commandGates["get_model_catalog"] = catalogGate
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        runCurrent()

        // Workspace discovery remains authoritative and precedes both requests;
        // once it completes, the independent requests are in flight together.
        assertEquals("get_workspace_info", transport.commands.first().cmd)
        assertEquals(
            setOf("get_workspace_info", "list_sessions", "get_model_catalog"),
            transport.commands.map { it.cmd }.toSet(),
        )
        assertIs<RemoteSessionUiState.Loading>(store.state.value)

        listGate.complete(Unit)
        runCurrent()
        val listing = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertFalse(listing.busy)
        assertEquals(listOf("s-code", "s-cowork", "s-agentic"), listing.sessions.map { it.id })
        assertNull(listing.modelCatalog)

        catalogGate.complete(Unit)
        advanceUntilIdle()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("s-code", "s-cowork", "s-agentic"), ready.sessions.map { it.id })
        assertEquals("model-primary", ready.modelCatalog?.defaultModels?.primary)
    }

    @Test
    fun conversationOpensWhileInitialCatalogRequestIsStillPending() = runTest {
        val transport = FakeSessionTransport()
        val catalogGate = CompletableDeferred<Unit>()
        transport.commandGates["get_model_catalog"] = catalogGate
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        runCurrent()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val opened = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-code", opened.selectedSessionId)
        assertNotNull(opened.timeline)
        assertFalse(opened.busy)
        assertFalse(catalogGate.isCompleted)
        store.dispatch(RemoteSessionIntent.UpdateDraft("draft after navigation"))
        catalogGate.complete(Unit)
        runCurrent()
        assertEquals("draft after navigation", assertIs<RemoteSessionUiState.Ready>(store.state.value).draft)
        store.stop()
    }

    @Test
    fun cancelledInitialCatalogCannotOverwriteANewerTargetLoad() = runTest {
        val transport = FakeSessionTransport()
        // Keep the catalog uncached so the replacement load has a real request
        // whose late completion can be exercised.
        transport.modelCatalogFailure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        transport.modelCatalogFailure = null
        transport.nonCancellableCommands += "get_model_catalog"

        // Start the delayed request from an already usable state. This lets the
        // replacement search exercise target switching rather than being rejected
        // by the cold-start Loading guard.
        store.dispatch(RemoteSessionIntent.Search("old target"))
        runCurrent()
        val lateCatalog = transport.lateCommandContinuations.remove("get_model_catalog")!!

        store.dispatch(RemoteSessionIntent.Search("new target"))
        runCurrent()
        val current = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("new target", current.query)

        // Complete the cancelled request after the replacement is authoritative.
        // Its result must not restore the previous query or generation's state.
        lateCatalog.resume(Unit)
        runCurrent()
        val afterLateCatalog = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("new target", afterLateCatalog.query)
        assertEquals(current.sessions, afterLateCatalog.sessions)
    }

    @Test
    fun modelCatalogRemoteRejectedIsRetryableAndRefreshRecovers() = runTest {
        val transport = FakeSessionTransport()
        transport.modelCatalogFailure = RelayFailure.RemoteRejected("Unknown command")
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val failed = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertNull(failed.modelCatalog)
        // A rejection is not proof of an old peer: a modern desktop can refuse
        // the catalog command transiently, so it stays retryable.
        assertEquals(ModelCatalogFailure.LOAD_FAILED, failed.modelCatalogFailure)
        assertTrue(failed.sessions.isNotEmpty())

        transport.modelCatalogFailure = null
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.RefreshModelCatalog)
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("model-primary", ready.modelCatalog?.defaultModels?.primary)
        assertNull(ready.modelCatalogFailure)
        assertFalse(ready.busy)
        assertEquals(listOf("get_model_catalog"), transport.commands.map { it.cmd })
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun modelCatalogMalformedResponseIsTypedAsRetryableFailure() = runTest {
        val transport = FakeSessionTransport()
        transport.modelCatalogFailure = RelayFailure.MalformedResponse
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertNull(ready.modelCatalog)
        // Malformed is a local protocol fault, not a peer capability statement.
        assertEquals(ModelCatalogFailure.LOAD_FAILED, ready.modelCatalogFailure)
        assertTrue(ready.sessions.isNotEmpty())
    }

    @Test
    fun modelCatalogNetworkFailureIsTypedWithoutFailingTheSession() = runTest {
        val transport = FakeSessionTransport()
        transport.modelCatalogFailure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertNull(ready.modelCatalog)
        assertEquals(ModelCatalogFailure.LOAD_FAILED, ready.modelCatalogFailure)
        assertTrue(ready.sessions.isNotEmpty())
    }

    @Test
    fun refreshModelCatalogRecoversFromATransientFailureAndUpdatesTheTimeline() = runTest {
        val transport = FakeSessionTransport()
        transport.modelCatalogFailure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        assertEquals(
            ModelCatalogFailure.LOAD_FAILED,
            assertIs<RemoteSessionUiState.Ready>(store.state.value).modelCatalogFailure,
        )
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("keep-draft"))
        assertEquals("keep-draft", assertIs<RemoteSessionUiState.Ready>(store.state.value).draft)
        assertNull(assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.modelCatalog?.defaultModels?.primary)

        transport.modelCatalogFailure = null
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.RefreshModelCatalog)
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("model-primary", ready.modelCatalog?.defaultModels?.primary)
        assertNull(ready.modelCatalogFailure)
        assertFalse(ready.busy)
        assertEquals("s-code", ready.selectedSessionId)
        assertEquals("model-primary", ready.timeline?.modelCatalog?.defaultModels?.primary)
        assertEquals("keep-draft", ready.draft)
        assertTrue(ready.sessions.isNotEmpty())
        // The refresh is the catalog command alone; it does not re-read the
        // session list or the transcript it must keep on screen.
        assertEquals(listOf("get_model_catalog"), transport.commands.map { it.cmd })
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun optionalSettingsReadsCoalesceAndDoNotBlockSending() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        transport.commands.clear()
        val catalogGate = CompletableDeferred<Unit>()
        val permissionGate = CompletableDeferred<Unit>()
        transport.commandGates["get_model_catalog"] = catalogGate
        transport.commandGates["get_permission_mode"] = permissionGate
        repeat(2) {
            store.dispatch(RemoteSessionIntent.RefreshModelCatalog)
            store.dispatch(RemoteSessionIntent.RefreshPermissionMode)
            runCurrent()
        }
        assertFalse(assertIs<RemoteSessionUiState.Ready>(store.state.value).busy)
        assertEquals(1, transport.commands.count { it.cmd == "get_model_catalog" })
        assertEquals(1, transport.commands.count { it.cmd == "get_permission_mode" })
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "send during optional refresh")); runCurrent()
        assertEquals(1, transport.commands.count { it.cmd == "send_message" })
        store.dispatch(RemoteSessionIntent.UpdateDraft("next message"))
        catalogGate.complete(Unit); permissionGate.complete(Unit); runCurrent()
        assertEquals("next message", assertIs<RemoteSessionUiState.Ready>(store.state.value).draft)
        store.stop()
    }

    @Test
    fun cancelledSettingsReadCannotOverwriteAnotherConversation() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        transport.nonCancellableCommands += "get_model_catalog"
        store.dispatch(RemoteSessionIntent.RefreshModelCatalog); runCurrent()
        val late = transport.lateCommandContinuations.remove("get_model_catalog")!!
        store.dispatch(RemoteSessionIntent.Open("s-cowork")); runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("other conversation"))
        val before = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        late.resume(Unit); runCurrent()
        val after = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-cowork", after.selectedSessionId)
        assertEquals(before.modelCatalog, after.modelCatalog)
        assertEquals(before.timeline, after.timeline)
        assertEquals("other conversation", after.draft)
        store.stop()
    }

    @Test
    fun sendingPublishesPendingAndFailedMessagesWithoutPolling() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["send_message"] = gate
        transport.sendMessageFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "hello"))
        runCurrent()
        val pending = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("hello", pending.timeline?.optimisticMessages?.single()?.text)
        assertTrue(pending.busy)
        store.dispatch(RemoteSessionIntent.UpdateDraft("new typing"))
        gate.complete(Unit)
        runCurrent()
        val failed = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("failed", failed.timeline?.optimisticMessages?.single()?.status)
        assertEquals("new typing", failed.draft)
        assertFalse(failed.busy)
        store.stop()
    }

    @Test
    fun staleModelSelectionCannotMutateTheNewlyOpenedSession() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.SelectModel("old-session", "model-primary"))
        runCurrent()
        assertTrue(transport.commands.none { it.cmd == "set_session_model" })
        assertFalse(assertIs<RemoteSessionUiState.Ready>(store.state.value).busy)
        store.stop()
    }

    @Test
    fun modelFailurePreservesTypingThatArrivedWhileRequestWasPending() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["set_session_model"] = gate
        transport.modelSelectionFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SelectModel("s-code", "model-primary"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("new typing"))
        gate.complete(Unit)
        runCurrent()
        assertEquals("new typing", assertIs<RemoteSessionUiState.Ready>(store.state.value).draft)
        store.stop()
    }

    @Test
    fun selectingModelPublishesConfirmedSelectionWithoutAnotherPoll() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("keep-draft"))
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.SelectModel("s-code", "requested-model"))
        runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        // The host's confirmed model wins even if it differs from the request.
        assertEquals("model-primary", ready.timeline?.selectedModelId)
        assertEquals("model-primary", ready.createModelOptions("Model").single { it.selected }.id)
        assertEquals("keep-draft", ready.draft)
        assertEquals("s-code", ready.selectedSessionId)
        assertFalse(ready.busy)
        assertEquals(listOf("set_session_model"), transport.commands.map { it.cmd })
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun hostCatalogInvalidationRefreshesSelectedSessionModel() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("keep this draft"))
        val notices = kotlinx.coroutines.flow.MutableSharedFlow<com.openbitfun.mobile.core.feature.relay.HostCatalogNotice>()
        store.bindCatalog(notices)
        runCurrent()
        transport.catalogSessionModelId = "model-from-another-controller"
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["get_model_catalog"] = gate
        transport.commands.clear()
        notices.emit(com.openbitfun.mobile.core.feature.relay.HostCatalogNotice.Changed)
        runCurrent()
        notices.emit(com.openbitfun.mobile.core.feature.relay.HostCatalogNotice.Changed)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(2, transport.commands.count { it.cmd == "get_model_catalog" })
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("model-from-another-controller", ready.timeline?.selectedModelId)
        assertEquals("keep this draft", ready.draft)
        assertTrue(transport.commands.any { it.cmd == "get_model_catalog" && it.sessionId == "s-code" })
        store.stop()
    }

    @Test
    fun openingSessionLoadsItsModelWithoutBlockingReadyOrLeakingAcrossNavigation() = runTest {
        val transport = FakeSessionTransport()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["get_model_catalog"] = gate
        transport.catalogSessionModelId = "old-session-model"
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertFalse(ready.busy)
        assertTrue(transport.commands.any { it.cmd == "get_model_catalog" && it.sessionId == "s-code" })
        store.dispatch(RemoteSessionIntent.UpdateDraft("old draft"))
        store.dispatch(RemoteSessionIntent.Open("s-new"))
        runCurrent()
        transport.catalogSessionModelId = "new-session-model"
        gate.complete(Unit)
        runCurrent()
        val newSession = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-new", newSession.selectedSessionId)
        assertEquals("new-session-model", newSession.timeline?.selectedModelId)
        assertFalse(newSession.busy)
        store.stop()
    }

    @Test
    fun catalogRefreshReadsCurrentSessionSelectionWithoutLosingDraft() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.SelectModel("s-code", "model-primary"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("unsent draft"))
        transport.catalogSessionModelId = "externally-selected-model"
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.RefreshModelCatalog)
        runCurrent()
        val request = transport.commands.single { it.cmd == "get_model_catalog" }
        assertEquals("s-code", request.sessionId)
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("externally-selected-model", ready.timeline?.selectedModelId)
        assertEquals("unsent draft", ready.draft)
        assertFalse(ready.busy)
        // Older peers may omit the session-specific selection.
        transport.catalogSessionModelId = null
        store.dispatch(RemoteSessionIntent.RefreshModelCatalog)
        runCurrent()
        assertEquals("externally-selected-model", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.selectedModelId)
        store.stop()
    }

    @Test
    fun modelCatalogContractIsTheStaticSupportedFact() {
        assertEquals("get_model_catalog", ModelCatalogContract.commandName)
        assertEquals(ModelCatalogSupport.SUPPORTED, ModelCatalogContract.support)
    }

    @Test
    fun hidesDesktopOnlyAcpSessions() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("s-code", "s-cowork", "s-agentic"), ready.sessions.map { it.id })
    }

    @Test
    fun reportsNoWorkspaceWithoutAskingForSessions() = runTest {
        val transport = FakeSessionTransport()
        transport.workspacePath = ""
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val failed = assertIs<RemoteSessionUiState.Failed>(store.state.value)
        assertEquals(RemoteSessionFailureReason.NO_WORKSPACE, failed.reason)
        assertTrue(transport.commands.none { it.cmd == "list_sessions" })
    }

    @Test
    fun searchSendsATrimmedQueryAndKeepsTheListOnScreen() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.Search("  parser  "))
        runCurrent()
        assertIs<RemoteSessionUiState.Ready>(store.state.value)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("  parser  ", ready.query)
        assertEquals("parser", transport.commands.last { it.cmd == "list_sessions" }.query)
    }

    @Test
    fun agentFilterKeepsLegacyAgenticSessionsInTheCodeTab() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.SetAgentFilter(SessionAgentFilter.CODE))
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("s-code", "s-agentic"), ready.sessions.map { it.id })
        // Narrowing happens on the client, so pages are pulled at the desktop's cap.
        assertEquals(100, transport.commands.last { it.cmd == "list_sessions" }.limit)
    }

    @Test
    fun initialLoadFollowsServerPagesWithoutRepeatingRows() = runTest {
        val transport = FakeSessionTransport()
        transport.paged = true
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("page-0", "page-1"), ready.sessions.map { it.id })
        assertFalse(ready.hasMore)
        assertEquals(1, transport.commands.last { it.cmd == "list_sessions" }.offset)
    }

    @Test
    fun createSessionNamesTheSessionAndOpensIt() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.CreateSession("code", "", "review the parser", null))
        runCurrent()

        val create = transport.commands.first { it.cmd == "create_session" }
        assertEquals("Remote Code Session", create.sessionName)
        assertEquals("/repo", create.workspacePath)
        assertEquals("code", create.agentType)
        assertEquals("review the parser", transport.commands.first { it.cmd == "send_message" }.content)
        // The desktop routes send_message by agent type, so it must match the
        // session that create_session just opened, not fall back to "agentic".
        assertEquals("code", transport.commands.first { it.cmd == "send_message" }.agentType)
        assertEquals("s-new", assertIs<RemoteSessionUiState.Ready>(store.state.value).selectedSessionId)
        val outcome = assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        assertEquals("s-new", outcome.createdSessionId)
        assertEquals("/repo", outcome.confirmedSession?.workspacePath)
        assertTrue(outcome.requestId.isNotBlank())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun createPreemptsBlockedRefreshAndPublishesRevisionLinkedCommit() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        val beforeRefreshReady = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        val beforeRefresh = beforeRefreshReady.revision

        transport.nonCancellableCommands += "list_sessions"
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()
        val lateRefresh = transport.lateCommandContinuations.remove("list_sessions")!!
        store.dispatch(
            RemoteSessionIntent.CreateSessionOperation(
                "create-preempts-refresh", "code", "", "", null, "/repo",
            ),
        )
        runCurrent()

        val succeeded = assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertTrue(succeeded.commitRevision > beforeRefresh)
        assertTrue(ready.revision >= succeeded.commitRevision)
        assertTrue(ready.sessions.any { it.id == succeeded.createdSessionId })
        assertEquals("s-new", ready.selectedSessionId)

        lateRefresh.resume(Unit)
        runCurrent()
        val afterLateRefresh = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(ready.revision, afterLateRefresh.revision)
        assertEquals(ready.sessions, afterLateRefresh.sessions)
        assertEquals("s-new", afterLateRefresh.selectedSessionId)
        store.stop()
    }

    @Test
    fun staleCommittedCreateCancellationDoesNotClearNewerBusyState() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        transport.commandGates["get_permission_mode"] = CompletableDeferred()
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("committed-cancel", "code", "", "", null, "/repo"))
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)

        transport.commandGates["list_sessions"] = CompletableDeferred()
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()

        assertTrue(assertIs<RemoteSessionUiState.Ready>(store.state.value).busy)
        transport.commandGates.remove("list_sessions")?.complete(Unit)
        runCurrent()
        store.stop()
    }

    @Test
    fun lateNonCancellableLoadMoreCannotOverwriteNewerRefresh() = runTest {
        val transport = FakeSessionTransport().apply {
            paged = true
            pagedLimit = 40
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        transport.nonCancellableCommands += "list_sessions"
        store.dispatch(RemoteSessionIntent.LoadMore)
        runCurrent()
        val lateLoadMore = transport.lateCommandContinuations.remove("list_sessions")!!
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()
        val refreshed = assertIs<RemoteSessionUiState.Ready>(store.state.value)

        lateLoadMore.resume(Unit)
        runCurrent()
        val afterLatePage = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(refreshed.revision, afterLatePage.revision)
        assertEquals(refreshed.sessions, afterLatePage.sessions)
        store.stop()
    }

    @Test
    fun staleLoadMoreCannotReconcileAwayLocallyCreatedSession() = runTest {
        val transport = FakeSessionTransport().apply {
            paged = true
            pagedLimit = 40
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.reconcileConfirmedCreatedSession(RemoteSession(
            "local-created", "Local", "code", "active", "", "", 0, "/repo", null,
        ))

        transport.listSessionsOverride = {
            """{"resp":"ok","has_more":false,"sessions":[{"id":"local-created","title":"Confirmed","agent_type":"code"}]}"""
        }
        transport.nonCancellableCommands += "list_sessions"
        store.dispatch(RemoteSessionIntent.LoadMore)
        runCurrent()
        val lateLoadMore = transport.lateCommandContinuations.remove("list_sessions")!!

        transport.listSessionsOverride = {
            """{"resp":"ok","has_more":false,"sessions":[{"id":"server-only","title":"Server","agent_type":"code"}]}"""
        }
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()
        lateLoadMore.resume(Unit)
        runCurrent()
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()

        assertTrue(assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.any { it.id == "local-created" })
        store.stop()
    }

    @Test
    fun staleDeleteCannotResetNewlyOpenedTimeline() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        transport.nonCancellableCommands += "delete_session"
        store.dispatch(RemoteSessionIntent.DeleteSession("s-code"))
        runCurrent()
        val lateDelete = transport.lateCommandContinuations.remove("delete_session")!!
        store.dispatch(RemoteSessionIntent.Open("s-cowork"))
        runCurrent()
        lateDelete.resume(Unit)
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-cowork", ready.selectedSessionId)
        assertEquals("s-cowork", ready.timeline?.sessionId)
        store.dispatch(RemoteSessionIntent.SendMessage("s-cowork", "still active"))
        runCurrent()
        assertTrue(transport.commands.any { it.cmd == "send_message" && it.sessionId == "s-cowork" })
        store.stop()
    }

    @Test
    fun createTransportFailureIsTypedAndRetryable() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        transport.createFailure = RelayFailure.Timeout

        store.dispatch(
            RemoteSessionIntent.CreateSessionOperation(
                requestId = "request-timeout",
                agentType = "code",
                title = "",
                instruction = "",
                modelId = null,
            ),
        )
        advanceUntilIdle()

        val failed = assertIs<CreateSessionOperationState.Failed>(store.createOperation.value)
        assertEquals("request-timeout", failed.requestId)
        assertEquals(CreateSessionOperationFailure.TRANSPORT, failed.reason)
        assertTrue(failed.retryable)
        assertFalse(failed.unsupported)
    }

    @Test
    fun malformedCreateResponseIsUnsupported() = runTest {
        val transport = FakeSessionTransport()
        transport.createFailure = RelayFailure.MalformedResponse
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("malformed-create", "code", "", "", null))
        runCurrent()
        val failed = assertIs<CreateSessionOperationState.Failed>(store.createOperation.value)
        assertEquals(CreateSessionOperationFailure.UNSUPPORTED, failed.reason)
        assertTrue(failed.unsupported)
    }

    @Test
    fun rejectedCreateIsNotUnsupported() = runTest {
        val transport = FakeSessionTransport()
        transport.createFailure = RelayFailure.RemoteRejected("denied")
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("rejected-create", "code", "", "", null))
        runCurrent()
        val failed = assertIs<CreateSessionOperationState.Failed>(store.createOperation.value)
        assertEquals(CreateSessionOperationFailure.TRANSPORT, failed.reason)
        assertFalse(failed.unsupported)
    }

    @Test
    fun repeatedCreateRequestIdUsesLatestInternalGeneration() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        transport.createFailure = RelayFailure.RemoteRejected("first")
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("reused", "code", "", "", null))
        runCurrent()
        assertIs<CreateSessionOperationState.Failed>(store.createOperation.value)
        transport.createFailure = null
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("reused", "code", "", "", null))
        runCurrent()
        val succeeded = assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        assertEquals("reused", succeeded.requestId)
        assertEquals("s-new", succeeded.createdSessionId)
        store.stop()
    }

    @Test
    fun stopWhileModelInitializationIsGatedKeepsCommittedCreateSucceeded() = runTest {
        val transport = FakeSessionTransport()
        transport.commandGates["set_session_model"] = CompletableDeferred()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("model-gate", "code", "", "", "model-primary", "/repo"))
        runCurrent()

        val committed = assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        assertEquals("s-new", committed.createdSessionId)
        val committedReady = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(committed.commitRevision, committedReady.revision)
        assertTrue(committedReady.sessions.any { it.id == committed.createdSessionId })
        store.stop()
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
    }

    @Test
    fun stopWhileOpenInitializationIsGatedKeepsCommittedProjection() = runTest {
        val transport = FakeSessionTransport()
        transport.commandGates["get_session_messages"] = CompletableDeferred()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("open-gate", "code", "", "", null, "/repo"))
        runCurrent()

        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        assertEquals("s-new", assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.first().id)
        store.stop()
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
    }

    @Test
    fun stopWhileInitialMessageIsGatedKeepsCommittedCreateSucceeded() = runTest {
        val transport = FakeSessionTransport()
        transport.commandGates["send_message"] = CompletableDeferred()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("send-gate", "code", "", "hello", null, "/repo"))
        runCurrent()

        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        store.stop()
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
    }

    @Test
    fun postCreateInitializationFailureDoesNotRollBackSucceededOutcome() = runTest {
        val transport = FakeSessionTransport().apply { sendMessageFailure = RelayFailure.Timeout }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("send-fails", "code", "", "hello", null, "/repo"))
        runCurrent()

        val succeeded = assertIs<CreateSessionOperationState.Succeeded>(store.createOperation.value)
        assertEquals("s-new", succeeded.createdSessionId)
        assertTrue(assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.any { it.id == "s-new" })
        store.stop()
    }

    @Test
    fun sessionStoreStopCancelsCreateOperation() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSessionOperation("stop-create", "code", "", "", null))
        store.stop()
        assertIs<CreateSessionOperationState.Cancelled>(store.createOperation.value)
    }

    @Test
    fun ordinaryOpenAndWorkspaceSelectionDoNotChangeCreateOperation() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport()
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")
        session.dispatch(RemoteSessionIntent.CreateSessionOperation("stable-create", "code", "", "", null))
        runCurrent()
        val succeeded = assertIs<CreateSessionOperationState.Succeeded>(session.createOperation.value)

        session.dispatch(RemoteSessionIntent.Open("s-code"))
        workspace.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()
        workspace.dispatch(RemoteWorkspaceIntent.SelectAssistant("/assistant"))
        runCurrent()

        assertEquals(succeeded, session.createOperation.value)
        session.stop()
    }

    @Test
    fun assistantCreateLoadsCatalogWithoutChangingRuntimeSelection() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport()
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")

        session.createAssistantSession(workspace, "assistant-1", "/assistant", "", "", null)
        runCurrent()

        assertIs<CreateSessionOperationState.Succeeded>(session.createOperation.value)
        assertEquals(listOf("list_recent_workspaces", "list_assistants", "get_workspace_info", "host_invoke"), workspaceTransport.commands.map { it.cmd })
        assertTrue(sessionTransport.commands.any { it.cmd == "create_session" && it.workspacePath == "/assistant" && it.agentType == "Claw" })
        session.stop()
    }

    @Test
    fun assistantCreateLoadFailureIsTypedWithoutSelecting() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport(loadFailure = true)
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")

        session.createAssistantSession(workspace, "assistant-load-fail", "/assistant", "", "", null)
        advanceUntilIdle()

        assertEquals(CreateSessionOperationFailure.WORKSPACE, assertIs<CreateSessionOperationState.Failed>(session.createOperation.value).reason)
        assertTrue(workspaceTransport.commands.none { it.cmd == "set_assistant" })
        assertTrue(sessionTransport.commands.none { it.cmd == "create_session" })
    }

    @Test
    fun unknownAssistantFailsImmediatelyWithoutSelection() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport()
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")
        workspace.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        workspaceTransport.commands.clear()

        session.createAssistantSession(workspace, "assistant-unknown", "/missing", "", "", null)
        runCurrent()

        assertEquals(CreateSessionOperationFailure.WORKSPACE, assertIs<CreateSessionOperationState.Failed>(session.createOperation.value).reason)
        assertTrue(workspaceTransport.commands.isEmpty())
        assertTrue(sessionTransport.commands.none { it.cmd == "create_session" })
    }

    @Test
    fun assistantCreateWaitsWhileSameSelectionIsBusy() = runTest {
        val gate = CompletableDeferred<Unit>()
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport(selectionGate = gate, initialSelectedPath = "/assistant")
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")
        workspace.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        workspace.dispatch(RemoteWorkspaceIntent.SelectAssistant("/assistant"))
        runCurrent()

        session.createAssistantSession(workspace, "assistant-busy", "/assistant", "", "", null)
        runCurrent()
        assertIs<CreateSessionOperationState.InFlight>(session.createOperation.value)
        assertTrue(assertIs<RemoteWorkspaceUiState.Ready>(workspace.state.value).busy)
        assertTrue(sessionTransport.commands.none { it.cmd == "create_session" })

        gate.complete(Unit)
        runCurrent()
        assertIs<CreateSessionOperationState.Succeeded>(session.createOperation.value)
        session.stop()
    }

    @Test
    fun assistantCreationDoesNotDependOnChangingGlobalSelection() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport(selectionFailure = true)
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")

        session.createAssistantSession(workspace, "assistant-select-fail", "/assistant", "", "", null)
        runCurrent()

        assertIs<CreateSessionOperationState.Succeeded>(session.createOperation.value)
        assertTrue(workspaceTransport.commands.none { it.cmd == "set_assistant" })
        assertTrue(sessionTransport.commands.any { it.cmd == "create_session" && it.workspacePath == "/assistant" && it.agentType == "Claw" })
        session.stop()
    }

    @Test
    fun assistantDeviceMismatchSendsNoCommands() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport()
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-b")

        session.createAssistantSession(workspace, "assistant-mismatch", "/assistant", "", "", null)

        assertEquals(CreateSessionOperationFailure.DEVICE_MISMATCH, assertIs<CreateSessionOperationState.Failed>(session.createOperation.value).reason)
        assertTrue(workspaceTransport.commands.isEmpty())
        assertTrue(sessionTransport.commands.isEmpty())
    }

    @Test
    fun workspaceStoppedBeforeAssistantCoroutineRunsCancelsWithoutCommands() = runTest {
        val sessionTransport = FakeSessionTransport()
        val workspaceTransport = AssistantWorkspaceTransport()
        val session = RemoteSessionStore.create(this, sessionTransport, "device-a", null)
        val workspace = RemoteWorkspaceStore.create(this, workspaceTransport, StandardTestDispatcher(testScheduler), "device-a")

        session.createAssistantSession(workspace, "assistant-stop", "/assistant", "", "", null)
        workspace.stop()
        runCurrent()

        assertIs<CreateSessionOperationState.Cancelled>(session.createOperation.value)
        assertTrue(workspaceTransport.commands.isEmpty())
        assertTrue(sessionTransport.commands.none { it.cmd == "create_session" })
    }

    @Test
    fun loadOlderMessagesUsesHistoryCursorEvenWhenLatestPageHasNoVisibleMessages() = runTest {
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(buildJsonObject {
                put("session_id", "s-code"); put("event", "session-record")
                put("payload", buildJsonObject {
                    put("sessionId", "s-code"); put("id", "turn/deleted")
                    put("revision", 10); put("deleted", true)
                })
            }, historyReady(true))
            olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "older"), historyReady(false))
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        val initial = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertTrue(initial.hasMoreMessages)
        assertTrue(initial.timeline?.persistedMessages.orEmpty().isEmpty())
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        assertEquals(1, transport.olderRequests)
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("old_user", "old_assistant"), ready.timeline?.persistedMessages?.map { it.id })
        assertFalse(ready.hasMoreMessages)
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun loadOlderMessagesPrependsThePreviousTranscriptPage() = runTest {
        val transport = FakeSessionTransport()
        transport.initialEvents = listOf(richRecord("s-code", "new", 1, 2, "completed", "new"), historyReady(true))
        transport.olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "old"), historyReady(false))
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        assertTrue(assertIs<RemoteSessionUiState.Ready>(store.state.value).hasMoreMessages)
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("old_user", "old_assistant", "new_user", "new_assistant"), ready.timeline?.persistedMessages?.map { it.id })
        assertFalse(ready.hasMoreMessages)
        assertEquals(1, transport.olderRequests)
        assertTrue(transport.commands.none { it.cmd == "get_session_messages" })
        store.stop()
    }


    @Test
    fun createSessionUsesTheWorkspaceTheDesktopIsOnNow() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        // What the new-session screen does: pick a workspace, which goes out as
        // `set_workspace` on the workspace store, then create. The path cached
        // at load time is stale by the time the create lands.
        transport.workspacePath = "/other"
        store.dispatch(RemoteSessionIntent.CreateSession("code", "", "review the parser", null))
        runCurrent()

        assertEquals("/other", transport.commands.first { it.cmd == "create_session" }.workspacePath)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun defaultClawCreationLetsRuntimeResolveAndReturnAssistantWorkspace() = runTest {
        val base = FakeSessionTransport()
        val commands = mutableListOf<RemoteCommand>()
        val transport = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                commands += command
                return if (command.cmd == "create_session") RelayJson.decodeFromString(deserializer, """{"resp":"ok","session_id":"s-new","workspace_path":"/runtime/assistant"}""") else base.send(deserializer, command, timeoutMs)
            }
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSession("Claw")); runCurrent()
        val create = commands.first { it.cmd == "create_session" }
        assertEquals(null, create.workspacePath)
        assertTrue(commands.none { it.cmd == "get_workspace_info" || it.cmd == "set_assistant" || it.cmd == "set_workspace" })
        val created = assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.first { it.id == "s-new" }
        assertEquals("/runtime/assistant", created.workspacePath)
        store.stop()
    }

    @Test
    fun remoteCreateUsesReturnedWorkspaceIdentityBeforeRequestedScope() = runTest {
        val base = FakeSessionTransport()
        val transport = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                return if (command.cmd == "create_session") RelayJson.decodeFromString(deserializer,
                    """{"resp":"ok","session_id":"s-new","workspace_path":"/actual","remote_connection_id":"actual-connection","remote_ssh_host":"actual-host"}""")
                else base.send(deserializer, command, timeoutMs)
            }
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.CreateSession("code", "", "", null, "/requested", "requested-connection", "requested-host"))
        runCurrent()
        val created = assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.first { it.id == "s-new" }
        assertEquals("/actual", created.workspacePath)
        assertEquals("actual-connection", created.workspaceIdentity?.remoteConnectionId)
        assertEquals("actual-host", created.workspaceIdentity?.remoteSshHost)
        store.stop()
    }

    @Test
    fun crossWorkspaceCreateDoesNotSwitchTheDesktopAndStaysProjected() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        transport.commands.clear()

        store.dispatch(
            RemoteSessionIntent.CreateSession(
                agentType = "code",
                title = "",
                instruction = "",
                modelId = null,
                workspacePath = "/other",
                remoteConnectionId = "saved-ssh",
                remoteSshHost = "ssh.example",
            ),
        )
        runCurrent()

        assertTrue(transport.commands.none { it.cmd == "get_workspace_info" })
        assertEquals("/other", transport.commands.first { it.cmd == "create_session" }.workspacePath)
        assertEquals("saved-ssh", transport.commands.first { it.cmd == "create_session" }.remoteConnectionId)
        assertEquals("ssh.example", transport.commands.first { it.cmd == "create_session" }.remoteSshHost)
        val created = assertIs<RemoteSessionUiState.Ready>(store.state.value)
            .sessions.first { it.id == "s-new" }
        assertEquals("/other", created.workspacePath)
        assertEquals("saved-ssh", created.workspaceIdentity?.remoteConnectionId)
        assertEquals("ssh.example", created.workspaceIdentity?.remoteSshHost)
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()
        assertTrue(assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions.any { it.id == "s-new" })
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun deleteSessionDropsTheRowAndClosesTheOpenConversation() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        store.dispatch(RemoteSessionIntent.DeleteSession("s-code"))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("s-cowork", "s-agentic"), ready.sessions.map { it.id })
        assertNull(ready.selectedSessionId)
        assertNull(ready.timeline)
        assertEquals("s-code", transport.commands.first { it.cmd == "delete_session" }.sessionId)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun renameSessionUpdatesTheRowInPlace() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.RenameSession("s-code", "  Parser work  "))
        advanceUntilIdle()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("Parser work", ready.sessions.first { it.id == "s-code" }.title)
        assertEquals("Parser work", transport.commands.first { it.cmd == "update_session_title" }.title)
    }

    @Test
    fun answerQuestionSendsBothSpellingsTheDesktopForwards() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteSessionIntent.AnswerQuestion("s-code", "tool-1", "yes"))
        advanceUntilIdle()

        val answer = transport.commands.first { it.cmd == "answer_question" }
        assertEquals("tool-1", answer.toolId)
        assertEquals("""{"answer":"yes","0":"yes"}""", answer.answers.toString())
    }

    @Test
    fun structuredQuestionAnswersUseIndexedTextAndChoiceValues() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        store.dispatch(
            RemoteSessionIntent.AnswerStructuredQuestion(
                "s-code",
                "tool-1",
                listOf(
                    QuestionAnswer(0, QuestionAnswerValue.Text("yes")),
                    QuestionAnswer(1, QuestionAnswerValue.Choice(listOf("a", "b"))),
                ),
            ),
        )
        advanceUntilIdle()

        val answer = transport.commands.first { it.cmd == "answer_question" }
        assertEquals("tool-1", answer.toolId)
        assertEquals("""{"0":"yes","1":["a","b"]}""", answer.answers.toString())
    }

    @Test
    fun theDesktopsOwnRejectionReachesTheScreen() = runTest {
        val transport = FakeSessionTransport()
        transport.rejection = "Session is busy running a turn"
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val failed = assertIs<RemoteSessionUiState.Failed>(store.state.value)
        assertEquals(RemoteSessionFailureReason.REMOTE_REJECTED, failed.reason)
        // Written by the peer, so it is shown verbatim rather than translated.
        assertEquals("Session is busy running a turn", failed.remoteMessage)
    }

    @Test
    fun aTimeoutIsNotReportedAsAGenericTransportFailure() = runTest {
        val transport = FakeSessionTransport()
        transport.failure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()

        val failed = assertIs<RemoteSessionUiState.Failed>(store.state.value)
        assertEquals(RemoteSessionFailureReason.TIMEOUT, failed.reason)
        assertNull(failed.remoteMessage)
    }

    @Test
    fun unknownPermissionModeSurfacesAsUnknownNotAsk() = runTest {
        val transport = FakeSessionTransport()
        transport.permissionModeJson = """{"resp":"ok","mode":"future_mode"}"""
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(SessionPermissionMode.UNKNOWN, ready.permissionMode)
        assertNull(ready.permissionModeFailure)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun missingPermissionModeSurfacesAsUnknown() = runTest {
        val transport = FakeSessionTransport()
        transport.permissionModeJson = """{"resp":"ok"}"""
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(SessionPermissionMode.UNKNOWN, ready.permissionMode)
        assertNull(ready.permissionModeFailure)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun editedToolApprovalPreservesTheJsonPatchOnTheWire() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(
            RemoteSessionIntent.ApproveTool("s-code", "tool-1", updatedInput = """{"x":1}"""),
        )
        runCurrent()

        assertEquals("{\"x\":1}", transport.commands.single { it.cmd == "confirm_tool" }.updatedInput.toString())
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertFalse(ready.busy)
        assertEquals(ToolApprovalEditSupport.SUPPORTED, ToolApprovalEditContract.support)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun plainToolApprovalStillSendsConfirmTool() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.ApproveTool("s-code", "tool-1"))
        runCurrent()

        val approval = transport.commands.last { it.cmd == "confirm_tool" }
        assertEquals("tool-1", approval.toolId)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun aSessionStillOpensWhenItsPermissionModeCannotBeRead() = runTest {
        val transport = FakeSessionTransport()
        transport.permissionFailure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())

        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        // The transcript loaded; only the settings section is missing, and it
        // says so rather than taking the session down with it.
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-code", ready.selectedSessionId)
        assertNull(ready.permissionMode)
        assertEquals(PermissionModeFailure.LOAD, ready.permissionModeFailure)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun runningDraftNegotiatesSteeringAndKeepsLegacyQueue() = runTest {
        for (supported in listOf(false, true)) {
            val transport = FakeSessionTransport().apply {
                capabilitiesJson = if (supported) "[\"dialog_steer_v1\"]" else "[]"
                initialEvents = listOf(richRecord("s-code", "active-1", 0, 1, "inprogress", "Working"))
            }
            val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
            store.dispatch(RemoteSessionIntent.Load); advanceUntilIdle()
            store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
            store.dispatch(RemoteSessionIntent.UpdateDraft("steer me"))
            val image = ComposerImage("photo", "data:image/png;base64,abc", "image/png")
            store.dispatch(RemoteSessionIntent.SendMessage("s-code", "steer me", listOf(image))); runCurrent()
            val sent = transport.commands.last { it.cmd in listOf("send_message", "steer_turn") }
            assertEquals(if (supported) "steer_turn" else "send_message", sent.cmd)
            assertEquals(if (supported) "active-1" else null, sent.turnId)
            assertEquals(if (supported) "steer me" else null, sent.displayContent)
            assertEquals(image.dataUrl, sent.imageContexts!!.single().dataUrl)
            val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
            assertEquals("", ready.draft)
            assertEquals("active-1", ready.timeline?.activeTurn?.turnId)
            store.stop()
        }
    }

    @Test
    fun buildPlanRequiresCapabilityAndDoesNotConsumeUnsentDraft() = runTest {
        for (supported in listOf(false, true)) {
            val transport = FakeSessionTransport().apply {
                capabilitiesJson = if (supported) "[\"plan_build_v1\"]" else "[]"
            }
            val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
            store.dispatch(RemoteSessionIntent.Load); advanceUntilIdle()
            store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
            store.dispatch(RemoteSessionIntent.UpdateDraft("keep draft"))
            store.dispatch(RemoteSessionIntent.BuildPlan("s-code", "/repo/design.plan.md", "Design")); runCurrent()
            val sent = transport.commands.lastOrNull { it.cmd == "build_plan" }
            assertEquals(supported, sent != null)
            if (supported) {
                assertEquals("/repo/design.plan.md", sent?.planFilePath)
                assertEquals("Design", sent?.planName)
                assertEquals("code", sent?.agentType)
            }
            val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
            assertEquals("keep draft", ready.draft)
            assertEquals("s-code", ready.selectedSessionId)
            assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
            store.stop()
        }
    }

    @Test
    fun sendMessageCarriesTheSessionsAgentType() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "hello"))
        runCurrent()

        val sent = transport.commands.last { it.cmd == "send_message" }
        assertEquals("s-code", sent.sessionId)
        assertEquals("hello", sent.content)
        // Matches the session opened above; without it the desktop defaults to
        // "agentic" and rejects a turn for a differently typed session.
        assertEquals("code", sent.agentType)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun imageOnlyMessagesAreSentAndAcknowledgedForNativePickers() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val images = listOf(ComposerImage("photo-1", "data:image/png;base64,abc", "image/png"))
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "", images))
        runCurrent()
        val sent = transport.commands.last { it.cmd == "send_message" }
        assertEquals("", sent.content)
        assertEquals(images.single().dataUrl, sent.imageContexts?.single()?.dataUrl)
        assertNull(sent.imageContexts?.single()?.imagePath)
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertFalse(ready.busy)
        assertEquals(listOf("photo-1"), ready.lastSentMessage?.imageIds)
        assertEquals("s-code", ready.lastSentMessage?.sessionId)
        store.stop()
    }

    @Test
    fun refreshCancellingSendDoesNotLeavePendingTurnForever() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        transport.commandGates["send_message"] = CompletableDeferred<Unit>()
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "waiting"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.Refresh)
        runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertFalse(ready.timeline?.activeTurn?.id?.startsWith("active-pending-") == true)
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun sendPublishesPendingTurnBeforeAckAndClearsItOnFailure() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["send_message"] = gate
        transport.sendMessageFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "hello"))
        runCurrent()
        val pending = assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline!!
        assertTrue(pending.activeTurn!!.id.startsWith("active-pending-"))
        val command = transport.commands.last { it.cmd == "send_message" }
        assertEquals(pending.optimisticMessages.single().turnId, command.turnId)
        assertTrue(!command.turnId.isNullOrBlank())
        gate.complete(Unit)
        runCurrent()
        val failed = assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline!!
        assertNull(failed.activeTurn)
        assertEquals("failed", failed.optimisticMessages.single().status)
        store.stop()
    }

    @Test
    fun imageSendFailureDoesNotConsumeAttachmentsAndAckKeepsNewTyping() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val images = listOf(ComposerImage("photo-1", "data:image/png;base64,abc", "image/png"))
        store.dispatch(RemoteSessionIntent.UpdateDraft("look"))
        transport.sendMessageFailure = RelayFailure.NetworkUnreachable
        val failureGate = CompletableDeferred<Unit>()
        transport.commandGates["send_message"] = failureGate
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "look", images))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("edited while waiting"))
        failureGate.complete(Unit)
        runCurrent()
        val failed = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("edited while waiting", failed.draft)
        assertNull(failed.lastSentMessage)
        assertFalse(failed.busy)

        transport.sendMessageFailure = null
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["send_message"] = gate
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "look", images))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("next question"))
        gate.complete(Unit)
        runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("next question", ready.draft)
        assertEquals(listOf("photo-1"), ready.lastSentMessage?.imageIds)
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun acknowledgementDoesNotClearAnIdenticalNewDraft() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("same question"))
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["send_message"] = gate
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "same question"))
        runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft(""))
        store.dispatch(RemoteSessionIntent.UpdateDraft("same question"))
        gate.complete(Unit)
        runCurrent()
        assertEquals("same question", assertIs<RemoteSessionUiState.Ready>(store.state.value).draft)
        store.stop()
    }

    @Test
    fun sendMessageFallsBackToTheLocallyCreatedRecordWhenTheFilterHidesTheSession() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.SetAgentFilter(SessionAgentFilter.CODE))
        advanceUntilIdle()

        // Cowork is not visible in the Code tab, so after a no-instruction
        // create the session stays selected but is filtered out of
        // Ready.sessions. send_message must still resolve its agent type from
        // the locally created record instead of omitting agent_type.
        store.dispatch(RemoteSessionIntent.CreateSession("cowork", "", "", null))
        runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-new", ready.selectedSessionId)
        assertTrue(ready.sessions.none { it.id == "s-new" })

        store.dispatch(RemoteSessionIntent.SendMessage("s-new", "hello"))
        runCurrent()

        val sent = transport.commands.last { it.cmd == "send_message" }
        assertEquals("s-new", sent.sessionId)
        // The desktop normalizes cowork/Cowork case on its side; the store must
        // simply forward the created session's agent type instead of null.
        assertEquals("cowork", sent.agentType)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun sendFailureKeepsTheDraftTheComposerWasAboutToSend() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        store.dispatch(RemoteSessionIntent.UpdateDraft("keep me"))
        transport.sendMessageFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SendMessage("s-code", "keep me"))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("keep me", ready.draft)
        assertEquals(false, ready.busy)
        store.dispatch(RemoteSessionIntent.Stop)
    }

    @Test
    fun explicitRefreshAfterStreamFailureKeepsSelectedTranscriptAndDraft() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("keep this unsent draft")); runCurrent()
        val before = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        transport.streamError?.invoke(RelayTransportException(RelayFailure.NetworkUnreachable))
        runCurrent()
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        store.dispatch(RemoteSessionIntent.Refresh); runCurrent()
        val after = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(before.selectedSessionId, after.selectedSessionId)
        assertEquals(before.timeline, after.timeline)
        assertEquals(before.draft, after.draft)
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        store.stop()
    }

    @Test
    fun idleHealthRecoversWithoutDiscardingListAndStopsInBackground() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load); advanceUntilIdle()
        val sessions = assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions
        transport.pingFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SetForeground(true)); runCurrent()
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        assertEquals(10_000L, transport.pingTimeoutMs)
        assertEquals(sessions, assertIs<RemoteSessionUiState.Ready>(store.state.value).sessions)
        transport.pingFailure = null
        advanceTimeBy(15_000); runCurrent()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        store.dispatch(RemoteSessionIntent.SetForeground(false))
        val count = transport.commands.count { it.cmd == "ping" }
        advanceTimeBy(60_000); runCurrent()
        assertEquals(count, transport.commands.count { it.cmd == "ping" })
        store.stop()
    }

    @Test
    fun healthDeadlineIncludesTransportPreparationAndCanRecover() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load); advanceUntilIdle()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        transport.commandGates["ping"] = gate
        store.dispatch(RemoteSessionIntent.SetForeground(true)); runCurrent()
        advanceTimeBy(9_999); runCurrent()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        advanceTimeBy(1); runCurrent()
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        gate.complete(Unit)
        advanceTimeBy(15_000); runCurrent()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        store.stop()
    }

    @Test
    fun slowHealthProbesDoNotOverlapAndLateResultsCannotChangeStoppedState() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Load); advanceUntilIdle()
        transport.nonCancellableCommands += "ping"
        store.dispatch(RemoteSessionIntent.SetForeground(true)); runCurrent()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(1, transport.commands.count { it.cmd == "ping" })
        store.stop()
        val stoppedPhase = store.connectionPhase.value
        val stoppedState = store.state.value
        transport.lateCommandContinuations.getValue("ping").resume(Unit)
        runCurrent()
        assertEquals(stoppedPhase, store.connectionPhase.value)
        assertEquals(stoppedState, store.state.value)
    }

    @Test
    fun openTranscriptStillProbesHostHealthWithoutPollingOrDiscardingDraft() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("retain this draft")); runCurrent()
        val before = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        transport.pingFailure = RelayFailure.NetworkUnreachable
        store.dispatch(RemoteSessionIntent.SetForeground(true)); runCurrent()
        assertEquals(1, transport.commands.count { it.cmd == "ping" })
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        val disconnected = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(before.timeline, disconnected.timeline)
        assertEquals(before.draft, disconnected.draft)
        transport.pingFailure = null
        advanceTimeBy(15_000); runCurrent()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        assertTrue(transport.commands.none { it.cmd == "poll_session" })
        store.dispatch(RemoteSessionIntent.SetForeground(false))
        val count = transport.commands.count { it.cmd == "ping" }
        advanceTimeBy(30_000); runCurrent()
        assertEquals(count, transport.commands.count { it.cmd == "ping" })
        store.stop()
    }

    @Test
    fun aDroppedStreamKeepsTranscriptAndRecoveryRestoresConnectionWithoutPolling() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()
        val before = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        transport.streamError?.invoke(RelayTransportException(RelayFailure.NetworkUnreachable))
        runCurrent()
        assertEquals(before.timeline?.sessionId, assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.sessionId)
        assertEquals(ConnectionPhase.RECONNECTING, store.connectionPhase.value)
        transport.streamCaughtUp?.invoke()
        runCurrent()
        assertEquals(ConnectionPhase.CONNECTED, store.connectionPhase.value)
        advanceTimeBy(60_000); runCurrent()
        assertTrue(transport.commands.none { it.cmd == "poll_session" })
        store.stop()
    }

    @Test
    fun rapidCacheMissesIssueOnlyTheFirstAndLatestTranscriptRequests() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        for (session in listOf("s-code", "s-cowork", "s-agentic")) { store.dispatch(RemoteSessionIntent.Open(session)); runCurrent() }
        transport.streamEvents.emit(richRecord("s-agentic", "latest", 0, 1, "completed", "current")); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-agentic", ready.timeline?.sessionId)
        assertEquals("current", ready.timeline?.persistedMessages?.last()?.text)
        assertTrue(transport.commands.none { it.cmd == "get_session_messages" })
        assertEquals(1, transport.activeSubscriptions)
        store.stop(); runCurrent(); assertEquals(0, transport.activeSubscriptions)
    }


    @Test
    fun refreshRetriesThePermissionModeAlone() = runTest {
        val transport = FakeSessionTransport()
        transport.permissionFailure = RelayFailure.Timeout
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        transport.permissionFailure = null
        transport.commands.clear()
        store.dispatch(RemoteSessionIntent.RefreshPermissionMode)
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(SessionPermissionMode.ASK, ready.permissionMode)
        assertNull(ready.permissionModeFailure)
        // The transcript is already on screen, so nothing re-fetches it.
        assertTrue(transport.commands.any { it.cmd == "get_permission_mode" })
        assertTrue(transport.commands.none { it.cmd == "get_session_messages" })
        store.dispatch(RemoteSessionIntent.Stop)
    }

    /**
     * The poll's last word on a turn is that it finished, and the store holds the
     * finished turn on screen until its text arrives as a stored message. The
     * poll never sends that message — from its side nothing changed after the
     * turn ended — so without the re-read the transcript reads correctly while
     * the composer keeps offering Stop for a turn that is over.
     */
    @Test
    fun durableTurnCompletionReconcilesHistoryWithoutPerTokenRpc() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent(); transport.commands.clear()
        repeat(50) { transport.streamEvents.emit(richRecord("s-code", "t-1", 0, it.toLong()+1, "inprogress", "x".repeat(it+1))); runCurrent() }
        assertEquals("x".repeat(50), assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.activeTurn?.text)
        transport.streamEvents.emit(richRecord("s-code", "t-1", 0, 51, "completed", "All done")); runCurrent()
        val timeline = assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline
        assertNull(timeline?.activeTurn)
        assertEquals("All done", timeline?.persistedMessages?.last()?.text)
        assertTrue(transport.commands.isEmpty())
        store.stop()
    }


    @Test
    fun durableCompletionPreservesLoadedOlderRecords() = runTest {
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(richRecord("s-code", "new", 1, 1, "completed", "question"), historyReady(true))
            olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "older"), historyReady(false))
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        transport.streamEvents.emit(richRecord("s-code", "t-1", 2, 1, "inprogress", "All ")); runCurrent()
        transport.streamEvents.emit(richRecord("s-code", "t-1", 2, 2, "completed", "All done")); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("old_assistant", "new_assistant", "t-1_assistant"),
            ready.timeline?.persistedMessages?.filter { it.role == "assistant" }?.map { it.id })
        assertFalse(ready.hasMoreMessages)
        assertNull(ready.timeline?.activeTurn)
        store.stop()
    }

    @Test
    fun olderPageInFlightDoesNotReplaceLiveCompletionWithAnOlderRevision() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(richRecord("s-code", "live", 1, 2, "inprogress", "partial"), historyReady(true))
            olderGate = gate
            olderEvents = listOf(
                richRecord("s-code", "old", 0, 1, "completed", "older"),
                richRecord("s-code", "live", 1, 1, "inprogress", "obsolete"),
                historyReady(false),
            )
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        assertEquals(1, transport.olderRequests)
        assertFalse(assertIs<RemoteSessionUiState.Ready>(store.state.value).busy)
        store.dispatch(RemoteSessionIntent.UpdateDraft("draft while loading history"))
        assertEquals(HistoryLoadState.LOADING, assertIs<RemoteSessionUiState.Ready>(store.state.value).historyLoadState)
        transport.streamEvents.emit(richRecord("s-code", "live", 1, 3, "inprogress", "updated")); runCurrent()
        assertEquals("updated", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.activeTurn?.text)
        transport.streamEvents.emit(richRecord("s-code", "live", 1, 4, "completed", "final reply")); runCurrent()
        gate.complete(Unit); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(listOf("old_user", "old_assistant", "live_user", "live_assistant"), ready.timeline?.persistedMessages?.map { it.id })
        assertEquals("final reply", ready.timeline?.persistedMessages?.last()?.text)
        assertEquals("draft while loading history", ready.draft)
        assertEquals(HistoryLoadState.IDLE, ready.historyLoadState)
        assertNull(ready.timeline?.activeTurn)
        assertFalse(ready.hasMoreMessages)
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun loadingOlderMessagesDoesNotCancelInitialModelHydration() = runTest {
        val catalogGate = CompletableDeferred<Unit>()
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(richRecord("s-code", "new", 1, 1, "completed", "new"), historyReady(true))
            olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "old"), historyReady(false))
            commandGates["get_model_catalog"] = catalogGate
            catalogSessionModelId = "hydrated-model"
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        catalogGate.complete(Unit); runCurrent()
        assertEquals("hydrated-model", assertIs<RemoteSessionUiState.Ready>(store.state.value).timeline?.selectedModelId)
        store.stop()
    }

    @Test
    fun olderPageFailureKeepsTranscriptAndExposesRetryWithoutBlockingComposer() = runTest {
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(richRecord("s-code", "new", 1, 1, "completed", "new"), historyReady(true))
            olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "old"), historyReady(false))
            olderFailure = true
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.UpdateDraft("keep this draft"))
        store.dispatch(RemoteSessionIntent.LoadOlderMessages)
        assertEquals(HistoryLoadState.LOADING, assertIs<RemoteSessionUiState.Ready>(store.state.value).historyLoadState)
        runCurrent()
        val failed = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(HistoryLoadState.FAILED, failed.historyLoadState)
        assertFalse(failed.busy)
        assertTrue(failed.hasMoreMessages)
        assertEquals("new", failed.timeline?.persistedMessages?.last()?.text)
        assertEquals("keep this draft", failed.draft)
        transport.olderFailure = false
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals(HistoryLoadState.IDLE, ready.historyLoadState)
        assertEquals(2, transport.olderRequests)
        assertEquals("keep this draft", ready.draft)
        assertEquals(listOf("old_user", "old_assistant", "new_user", "new_assistant"), ready.timeline?.persistedMessages?.map { it.id })
        store.stop()
    }

    @Test
    fun switchingSessionsCancelsTheIndependentOlderPage() = runTest {
        val gate = CompletableDeferred<Unit>()
        val transport = FakeSessionTransport().apply {
            initialEvents = listOf(richRecord("s-code", "new", 1, 1, "completed", "new"), historyReady(true))
            olderEvents = listOf(richRecord("s-code", "old", 0, 1, "completed", "old"), historyReady(false))
            olderGate = gate
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.LoadOlderMessages); runCurrent()
        transport.initialEvents = emptyList()
        store.dispatch(RemoteSessionIntent.Open("s-agentic")); runCurrent()
        gate.complete(Unit); runCurrent()
        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        assertEquals("s-agentic", ready.selectedSessionId)
        assertTrue(ready.timeline?.persistedMessages.orEmpty().none { it.id == "old_user" })
        assertEquals(HistoryLoadState.IDLE, ready.historyLoadState)
        assertFalse(ready.busy)
        store.stop()
    }

    @Test
    fun permissionSaveUsesHostModeInsteadOfRequestedMode() = runTest {
        val transport = FakeSessionTransport().apply {
            permissionSaveJson = """{"resp":"ok","mode":"auto"}"""
        }
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        store.dispatch(RemoteSessionIntent.SetPermissionMode(SessionPermissionMode.FULL_ACCESS)); runCurrent()
        assertEquals(SessionPermissionMode.AUTO, assertIs<RemoteSessionUiState.Ready>(store.state.value).permissionMode)
        store.stop()
    }

    @Test
    fun legacyPermissionSaveReadsBackAuthorityAndDoesNotInventMissingMode() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code")); runCurrent()
        transport.commands.clear()
        transport.permissionModeJson = """{"resp":"ok"}"""
        store.dispatch(RemoteSessionIntent.SetPermissionMode(SessionPermissionMode.FULL_ACCESS)); runCurrent()
        assertEquals(listOf("set_permission_mode", "get_permission_mode"), transport.commands.map { it.cmd })
        assertEquals(SessionPermissionMode.UNKNOWN, assertIs<RemoteSessionUiState.Ready>(store.state.value).permissionMode)
        store.stop()
    }

    @Test
    fun aRefusedPermissionChangeLeavesTheSessionStanding() = runTest {
        val transport = FakeSessionTransport()
        val store = RemoteSessionStore(this, transport, relayStreamStore = TestRelayStreamStore())
        store.dispatch(RemoteSessionIntent.Open("s-code"))
        runCurrent()

        transport.permissionFailure = RelayFailure.Timeout
        store.dispatch(RemoteSessionIntent.SetPermissionMode(SessionPermissionMode.FULL_ACCESS))
        runCurrent()

        val ready = assertIs<RemoteSessionUiState.Ready>(store.state.value)
        // The mode shown is still the desktop's, not the one we failed to set.
        assertEquals(SessionPermissionMode.ASK, ready.permissionMode)
        assertEquals(PermissionModeFailure.SAVE, ready.permissionModeFailure)
        assertEquals(false, ready.busy)
        store.dispatch(RemoteSessionIntent.Stop)
    }
}

private class AssistantWorkspaceTransport(
    private val loadFailure: Boolean = false,
    private val selectionFailure: Boolean = false,
    val selectionGate: CompletableDeferred<Unit>? = null,
    initialSelectedPath: String = "/repo",
) : RemoteCommandTransport {
    val commands = mutableListOf<RemoteCommand>()
    private var selectedPath: String = initialSelectedPath

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        commands += command
        if (loadFailure && command.cmd == "list_recent_workspaces") error("load failed")
        if (selectionFailure && command.cmd == "set_assistant") error("selection failed")
        val json = when (command.cmd) {
            "list_recent_workspaces" -> """{"resp":"ok","workspaces":[{"path":"/repo","name":"Repo"}]}"""
            "list_assistants" -> """{"resp":"ok","assistants":[{"path":"/assistant","name":"Assistant","assistant_id":"a1"}]}"""
            "set_assistant" -> {
                selectionGate?.await()
                selectedPath = command.path.orEmpty()
                """{"resp":"ok","success":true,"path":"$selectedPath"}"""
            }
            "get_workspace_info" -> """{"resp":"ok","has_workspace":true,"path":"$selectedPath","workspace_kind":"${if (selectedPath == "/assistant") "assistant" else "code"}"}"""
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}

private class FakeSessionTransport : RemoteCommandTransport, RemoteSessionStreamTransport {
    var initialHistoryGate: CompletableDeferred<Unit>? = null
    var initialEvents = emptyList<JsonObject>()
    var olderEvents = emptyList<JsonObject>()
    var olderRequests = 0
    var olderGate: CompletableDeferred<Unit>? = null
    var olderFailure = false
    var activeSubscriptions = 0
    override suspend fun loadOlder(sessionId: String) {
        olderRequests++; olderGate?.await()
        if (olderFailure) error("History read failed")
        olderEvents.forEach { streamEvents.emit(it) }
    }
    val streamEvents = MutableSharedFlow<JsonObject>(extraBufferCapacity = 10)
    var streamError: ((Throwable) -> Unit)? = null
    var streamCaughtUp: (() -> Unit)? = null
    override val streamIdentity = "test-account/device"
    override suspend fun subscribe(sessionId: String, replica: SessionStreamReplica, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> = flow {
        streamError = onError; streamCaughtUp = onCaughtUp
        activeSubscriptions++
        try { initialEvents.forEach { emit(it) }; initialHistoryGate?.await(); onCaughtUp(); streamEvents.collect { emit(it) } }
        finally { activeSubscriptions-- }
    }

    val commands = mutableListOf<RemoteCommand>()
    var workspacePath: String = "/repo"
    var capabilitiesJson: String = "[]"

    /** When set, the permission commands fail while everything else works. */
    var permissionFailure: RelayFailure? = null

    var permissionModeJson: String? = null
    var permissionSaveJson: String? = null

    /** When set, `list_sessions` serves one row per offset so paging is observable. */
    var paged: Boolean = false
    var pagedLimit: Int = 1
    var listSessionsOverride: ((RemoteCommand) -> String)? = null

    /** When set, `list_sessions` is refused the way a desktop refuses it. */
    var rejection: String? = null

    /** When set, `list_sessions` fails below the desktop instead. */
    var failure: RelayFailure? = null

    /** When set, `get_model_catalog` fails with the selected transport result. */
    var modelCatalogFailure: RelayFailure? = null
    var catalogSessionModelId: String? = null

    /** When set, the open conversation's health poll fails below the desktop. */
    var pollFailure: RelayFailure? = null
    var pingFailure: RelayFailure? = null
    var pingTimeoutMs: Long? = null

    /** When set, `send_message` fails below the desktop while the draft is kept. */
    var sendMessageFailure: RelayFailure? = null
    var modelSelectionFailure: RelayFailure? = null

    /** When set, `create_session` fails below the desktop. */
    var createFailure: RelayFailure? = null

    /** Optional command-stage gates used to exercise post-create cancellation races. */
    val commandGates = mutableMapOf<String, CompletableDeferred<Unit>>()

    /** Commands suspended by a primitive continuation, so cancellation cannot consume their late result. */
    val nonCancellableCommands = mutableSetOf<String>()
    val lateCommandContinuations = mutableMapOf<String, Continuation<Unit>>()

    /** Poll payloads served in order; the last one repeats, as a quiet desktop does. */
    var polls: List<String> = listOf(IDLE_POLL)
    private var pollIndex = 0

    /** What `get_session_messages` is holding right now, re-read on every call. */
    var messages: String = "[]"

    /** Optional previous page, served only for a cursor-bearing message request. */
    var olderMessages: String? = null

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        commands += command
        val preparedListSessions = if (command.cmd == "list_sessions") {
            listSessionsOverride?.invoke(command)
        } else {
            null
        }
        commandGates[command.cmd]?.await()
        if (command.cmd == "set_session_model") {
            modelSelectionFailure?.let { throw RelayTransportException(it) }
        }
        if (nonCancellableCommands.remove(command.cmd)) {
            suspendCoroutine { continuation -> lateCommandContinuations[command.cmd] = continuation }
        }
        if (command.cmd == "list_sessions") {
            rejection?.let { throw RelayTransportException(RelayFailure.RemoteRejected(it)) }
            failure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "ping") {
            pingTimeoutMs = timeoutMs
            pingFailure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "poll_session") {
            pollFailure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "send_message" || command.cmd == "steer_turn") {
            sendMessageFailure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "create_session") {
            createFailure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "get_permission_mode" || command.cmd == "set_permission_mode") {
            permissionFailure?.let { throw RelayTransportException(it) }
        }
        if (command.cmd == "get_model_catalog") {
            modelCatalogFailure?.let { throw RelayTransportException(it) }
        }
        val json = when (command.cmd) {
            "get_workspace_info" ->
                """{"resp":"ok","has_workspace":${workspacePath.isNotEmpty()},"path":"$workspacePath","capabilities":$capabilitiesJson}"""
            "get_model_catalog" -> """{
                "resp":"ok",
                "catalog":{
                  "version":7,
                  "session_model_id":${catalogSessionModelId?.let { "\"$it\"" } ?: "null"},
                  "models":[{
                    "id":"model-primary","name":"Primary","provider":"account",
                    "base_url":"","model_name":"primary","enabled":true
                  }],
                  "default_models":{"primary":"model-primary"}
                }
            }""".trimIndent()
            "list_sessions" -> preparedListSessions ?: if (paged) pagedSessions(command.offset?.toInt() ?: 0) else allSessions()
            "get_session_messages" -> if (command.beforeMessageId != null) {
                """{"resp":"ok","messages":${olderMessages ?: "[]"},"has_more":false}"""
            } else {
                """{"resp":"ok","messages":$messages,"has_more":${olderMessages != null}}"""
            }
            "get_permission_mode" -> permissionModeJson ?: """{"resp":"ok","mode":"ask"}"""
            "poll_session" -> polls[minOf(pollIndex++, polls.lastIndex)]
            "create_session" -> """{"resp":"ok","session_id":"s-new"}"""
            "set_session_model" -> """{"resp":"ok","model_id":"model-primary"}"""
            "send_message", "steer_turn", "build_plan" -> """{"resp":"ok","turn_id":"t-1"}"""
            "set_permission_mode" -> permissionSaveJson ?: """{"resp":"ok"}"""
            "ping", "delete_session", "update_session_title", "answer_question", "confirm_tool" ->
                """{"resp":"ok"}"""
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }

    private fun allSessions(): String = """
        {"resp":"ok","has_more":false,"sessions":[
          {"id":"s-code","title":"Code","agent_type":"code"},
          {"id":"s-cowork","title":"Cowork","agent_type":"cowork"},
          {"id":"s-agentic","title":"Legacy","agent_type":"agentic"},
          {"id":"s-acp","title":"Desktop ACP","agent_type":"acp:codex"}
        ]}
    """.trimIndent()

    private fun pagedSessions(offset: Int): String =
        """{"resp":"ok","has_more":${offset < pagedLimit},"sessions":[{"id":"page-$offset","title":"Page $offset","agent_type":"code"}]}"""

    private companion object {
        const val IDLE_POLL = """{"resp":"ok","version":1,"changed":false,"session_state":"idle"}"""
    }
}

internal class TestRelayStreamStore : RelayStreamStore {
    override fun eventIds(stream: String) = emptyList<String>()
    override fun cursor(stream: String) = 0L
    override fun fragments(stream: String, eventId: String) = emptyList<String>()
    override fun commit(stream: String, fragments: List<PersistedRelayFragment>, cursor: Long) {}
}
private fun streamEvent(name: String, text: String = ""): JsonObject = buildJsonObject {
    put("session_id", "s-code"); put("event", "agentic://$name")
    put("payload", buildJsonObject { put("sessionId", "s-code"); put("turnId", "t-1"); put("text", text) })
}

internal fun richRecord(session: String, turn: String, index: Int, revision: Long, status: String, text: String): JsonObject = buildJsonObject {
    put("session_id", session); put("event", "session-record")
    put("payload", buildJsonObject {
        put("sessionId", session); put("id", "item/$turn-text"); put("revision", revision)
        put("turn", buildJsonObject { put("sessionId", session); put("turnId", turn); put("turnIndex", index); put("status", status); put("userMessage", buildJsonObject { put("id", "${turn}_user"); put("content", "question"); put("timestamp", 1) }) })
        put("round", buildJsonObject { put("id", "$turn-round"); put("turnId", turn); put("roundIndex", 0) })
        put("item", buildJsonObject { put("type", "text"); put("data", buildJsonObject { put("id", "$turn-text"); put("content", text); put("orderIndex", 0) }) })
    })
}
private fun historyReady(more: Boolean): JsonObject = buildJsonObject { put("session_id", "s-code"); put("event", "relay://session-ready"); put("payload", buildJsonObject { put("hasMore", more) }) }
