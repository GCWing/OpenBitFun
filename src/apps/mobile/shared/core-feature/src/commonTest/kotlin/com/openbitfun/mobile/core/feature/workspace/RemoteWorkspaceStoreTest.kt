package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.persistence.PersistedRemoteWorkspace
import com.openbitfun.mobile.core.persistence.RemoteWorkspaceListStore
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.test.assertContentEquals

@OptIn(ExperimentalCoroutinesApi::class)
class RemoteWorkspaceStoreTest {
    @Test
    fun rejectedProviderDoesNotPublishPreviousDirectoryResponse() = runTest {
        val base = FakeWorkspaceTransport()
        val response = CompletableDeferred<Unit>()
        val transport = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                if (command.command == "get_directory_children_paginated") {
                    withContext(NonCancellable) { response.await() }
                    return RelayJson.decodeFromString(deserializer,
                        """{"resp":"host_invoke_result","ok":true,"value":{"children":[],"hasMore":false}}""")
                }
                return base.send(deserializer, command, timeoutMs)
            }
        }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTools("/previous", null)); runCurrent()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTools("/next", "missing-provider")); runCurrent()
        assertTrue(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).deviceTools.failed)
        response.complete(Unit); advanceUntilIdle()
        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertTrue(ready.files.failed)
        assertEquals("", ready.files.directory)
        store.stop()
    }

    @Test
    fun explicitLocalWorkspaceDoesNotInheritAnSshCatalogMatch() = runTest {
        val base = FakeWorkspaceTransport()
        val transport = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                if (command.cmd == "list_recent_workspaces") return RelayJson.decodeFromString(deserializer,
                    """{"resp":"ok","workspaces":[{"path":"/repo","name":"SSH","remote_connection_id":"ssh-saved","remote_ssh_host":"host"}]}""")
                return base.send(deserializer, command, timeoutMs)
            }
        }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.SelectWorkspace("/repo", null, null, false)); advanceUntilIdle()
        val explicit = base.commands.last { it.cmd == "set_workspace" }
        assertEquals(null, explicit.remoteConnectionId)
        assertEquals(null, explicit.remoteSshHost)
        // Existing callers retain their saved-identity inference behavior.
        store.dispatch(RemoteWorkspaceIntent.SelectWorkspace("/repo")); advanceUntilIdle()
        assertEquals("ssh-saved", base.commands.last { it.cmd == "set_workspace" }.remoteConnectionId)
        store.stop()
    }

    @Test
    fun deviceToolsUseRuntimeHomeAndExplicitProviderWithoutWorkspaceSelection() = runTest {
        val base = FakeWorkspaceTransport()
        val calls = mutableListOf<RemoteCommand>()
        var terminalCount = 0
        val transport = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                calls += command
                val wire = when {
                    command.cmd == "list_recent_workspaces" -> """{"resp":"ok","workspaces":[{"path":"/repo","name":"Local"},{"path":"/repo","name":"SSH","workspace_kind":"remote","remote_connection_id":"saved-1"}]}"""
                    command.command == "get_system_info" -> """{"resp":"host_invoke_result","ok":true,"value":{"homeDir":"/home/runtime"}}"""
                    command.command == "get_directory_children_paginated" -> """{"resp":"host_invoke_result","ok":true,"value":{"children":[],"hasMore":false}}"""
                    command.command == "terminal_create" -> { terminalCount++; """{"resp":"host_invoke_result","ok":true,"value":{"id":"terminal-$terminalCount"}}""" }
                    else -> null
                }
                return if (wire == null) base.send(deserializer, command, timeoutMs) else RelayJson.decodeFromString(deserializer, wire)
            }
        }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        calls.clear()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("", null)); advanceUntilIdle()
        assertEquals("/home/runtime", calls.last().args!!.jsonObject.getValue("request").jsonObject.getValue("path").jsonPrimitive.content)
        assertTrue(calls.none { it.cmd == "get_workspace_info" || it.cmd == "list_recent_workspaces" })
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("", "saved-1")); advanceUntilIdle()
        assertEquals("/", calls.last().args!!.jsonObject.getValue("request").jsonObject.getValue("path").jsonPrimitive.content)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("/repo", "saved-1")); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.BrowseFiles("/repo/sub", false)); advanceUntilIdle()
        val ssh = calls.last().args!!.jsonObject.getValue("request").jsonObject
        assertEquals("saved-1", ssh.getValue("remoteConnectionId").jsonPrimitive.content)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("/repo", null)); advanceUntilIdle()
        assertEquals("", calls.last().args!!.jsonObject.getValue("request").jsonObject.getValue("remoteConnectionId").jsonPrimitive.content)
        assertFalse(calls.any { it.cmd == "set_workspace" })
        assertEquals("/repo", assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).selected?.path)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTerminal("/repo", "saved-1")); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTerminal("/repo", null)); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTerminal("/repo", "saved-1")); advanceUntilIdle()
        assertEquals(2, terminalCount)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTools("/unified", "saved-1")); advanceUntilIdle()
        var ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertTrue(ready.deviceTools.visible)
        assertEquals(DeviceToolsPanel.FILES, ready.deviceTools.panel)
        assertEquals("/unified", ready.deviceTools.path)
        assertEquals("saved-1", ready.deviceTools.connectionId)
        assertEquals(null, ready.terminal.sessionId)
        store.dispatch(RemoteWorkspaceIntent.SelectDeviceToolsPanel(DeviceToolsPanel.TERMINAL)); advanceUntilIdle()
        assertEquals(2, terminalCount, "Selecting the terminal tab must not create a PTY")
        store.dispatch(RemoteWorkspaceIntent.StartDeviceToolsTerminal); advanceUntilIdle()
        val terminalId = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).terminal.sessionId
        assertEquals(3, terminalCount)
        store.dispatch(RemoteWorkspaceIntent.SelectDeviceToolsPanel(DeviceToolsPanel.FILES)); advanceUntilIdle()
        assertEquals(terminalId, assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).terminal.sessionId)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTools("/unified", null)); advanceUntilIdle()
        assertEquals(null, assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).terminal.sessionId)
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceTools("/unified", "saved-1")); advanceUntilIdle()
        assertEquals(terminalId, assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).terminal.sessionId)
        assertEquals(3, terminalCount, "Returning to a location reuses its PTY")
        store.dispatch(RemoteWorkspaceIntent.CloseDeviceTools); advanceUntilIdle()
        ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertFalse(ready.deviceTools.visible)
        assertEquals(terminalId, ready.terminal.sessionId)
        assertFalse(calls.any { it.cmd == "set_workspace" })
        store.stop()
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).deviceTools.visible)
    }

    @Test
    fun loadsWorkspaceAssistantAndCurrentSelection() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))

        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertEquals(listOf("/repo"), ready.workspaces.map { it.path })
        assertEquals(listOf("/assistant"), ready.assistants.map { it.path })
        assertEquals("/repo", ready.selected?.path)
        assertEquals(
            setOf("list_recent_workspaces", "list_assistants", "get_workspace_info", "host_invoke"),
            transport.commands.map { it.cmd }.toSet(),
        )
    }

    @Test
    fun switchesWorkspaceAndRefreshesSelection() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteWorkspaceIntent.SelectWorkspace(" /next "))
        advanceUntilIdle()

        assertEquals("/next", transport.commands.first { it.cmd == "set_workspace" }.path)
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).busy)
    }

    @Test
    fun rejectedSelectionRetainsWorkspaceAndDoesNotRefreshAsSuccess() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        transport.selectionAccepted = false
        transport.commands.clear()
        store.dispatch(RemoteWorkspaceIntent.SelectWorkspace("/denied", "ssh-id", "host"))
        advanceUntilIdle()
        val state = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertEquals("/repo", state.selected?.path)
        assertTrue(state.loadFailure)
        assertFalse(state.busy)
        assertEquals(listOf("set_workspace"), transport.commands.map { it.cmd })
        assertEquals("ssh-id", transport.commands.single().remoteConnectionId)
        assertEquals("host", transport.commands.single().remoteSshHost)
    }

    @Test
    fun cachedCatalogStaysVisibleWhenTheLiveRefreshFails() = runTest {
        val cache = MemoryWorkspaceListStore().apply {
            rows["device-a"] = listOf(
                PersistedRemoteWorkspace("/cached", "Cached", "yesterday", "local"),
                PersistedRemoteWorkspace("/assistant", "Assistant", "", "assistant"),
            )
        }
        val store = RemoteWorkspaceStore.create(
            this,
            FailingWorkspaceTransport(),
            StandardTestDispatcher(testScheduler),
            "device-a",
            cache,
        )

        store.dispatch(RemoteWorkspaceIntent.Load)
        val cached = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertTrue(cached.busy)
        assertEquals(listOf("/cached"), cached.workspaces.map { it.path })
        assertEquals(listOf("/assistant"), cached.assistants.map { it.path })
        advanceUntilIdle()

        val failed = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertFalse(failed.busy)
        assertTrue(failed.loadFailure)
        assertEquals(listOf("/cached"), failed.workspaces.map { it.path })
        assertEquals(listOf("/assistant"), failed.assistants.map { it.path })
    }

    @Test
    fun successfulCatalogRefreshReplacesAndPersistsCachedRows() = runTest {
        val cache = MemoryWorkspaceListStore()
        val store = RemoteWorkspaceStore.create(
            this,
            FakeWorkspaceTransport(),
            StandardTestDispatcher(testScheduler),
            "device-a",
            cache,
        )
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        assertEquals(listOf("/repo", "/assistant"), cache.rows.getValue("device-a").map { it.path })
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).loadFailure)
    }

    @Test
    fun unavailableWorkspaceCacheDoesNotOverrideRemoteCatalog() = runTest {
        val store = RemoteWorkspaceStore.create(
            this,
            FakeWorkspaceTransport(),
            StandardTestDispatcher(testScheduler),
            "device-a",
            FailingWorkspaceListStore(),
        )

        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertEquals(listOf("/repo"), ready.workspaces.map { it.path })
        assertEquals(listOf("/assistant"), ready.assistants.map { it.path })
        assertFalse(ready.busy)
        assertFalse(ready.loadFailure)
    }

    @Test
    fun invalidPreviewRetainsRequestIdentityAndReplacesPreviousRequest() = runTest {
        val store = RemoteWorkspaceStore.create(this, FakeWorkspaceTransport(), StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("https://example.com/file", "file", "s1", "invalid-preview"))
        runCurrent()
        val failed = assertIs<RemoteFilePreviewUiState.Failed>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
        assertEquals("invalid-preview", failed.identity.requestId)
        assertEquals("device-a", failed.identity.deviceKey)
        assertEquals("s1", failed.identity.sessionId)
        store.stop()
    }

    @Test
    fun previewDoesNotCancelWorkspaceRefresh() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport)
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["get_workspace_info"] = gate
        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("src/main.rs", "main.rs", "s1", "preview"))
        runCurrent()
        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).busy)
        store.stop()
    }

    @Test
    fun workspaceRefreshDoesNotLeaveCancelledDownloadPermanentlyLoading() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["get_file_info"] = gate
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("src/main.rs", "main.rs", "s1"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download is RemoteFileDownloadUiState.Loading)
        gate.complete(Unit)
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("src/main.rs", "main.rs", "s1"))
        advanceUntilIdle()
        assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        store.stop()
    }

    @Test
    fun workspaceSelectionRetainsDownloadCancellationInsteadOfRestoringLoading() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        transport.commandGates["get_file_info"] = CompletableDeferred<Unit>()
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("src/main.rs", "main.rs", "s1"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.SelectWorkspace("/repo"))
        runCurrent()
        assertIs<RemoteFileDownloadUiState.Failed>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        store.stop()
    }

    @Test
    fun previewDoesNotCancelAnInFlightDownload() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        val gate = CompletableDeferred<Unit>()
        transport.commandGates["get_file_info"] = gate
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("src/main.rs", "main.rs", "s1"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("src/main.rs", "main.rs", "s1", "preview"))
        runCurrent()
        gate.complete(Unit)
        advanceUntilIdle()
        assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        store.stop()
    }

    @Test
    fun loadsBoundedTextPreviewThroughCommandTransport() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://src/main.rs#L2", "main.rs", "session-1", "ios-preview-1"))
        advanceUntilIdle()
        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val preview = assertIs<RemoteFilePreviewUiState.Text>(ready.preview)
        assertEquals("ios-preview-1", preview.identity.requestId)
        assertEquals("device-a", preview.identity.deviceKey)
        assertEquals("session-1", preview.identity.sessionId)
        assertEquals("src/main.rs", preview.identity.path)
        assertEquals("fn main() {}", preview.content)
        assertFalse(preview.truncated)
        val read = transport.commands.first { it.cmd == "read_file_chunk" }
        assertEquals("src/main.rs", read.path)
        assertEquals("session-1", read.sessionId)
        assertEquals(16, read.limit)
    }

    /**
     * The header line under the file name says what the file is and how big it
     * is, and the truncation banner says how much of it arrived. None of that
     * survives unless the read carries it out of the store, so this asserts the
     * three numbers rather than the rendering that consumes them.
     */
    @Test
    fun aTextPreviewCarriesTheTypeSizeAndHowMuchArrived() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://src/main.rs", "main.rs", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val preview = assertIs<RemoteFilePreviewUiState.Text>(ready.preview)
        assertEquals("text/plain", preview.mimeType)
        assertEquals(12, preview.sizeBytes)
        assertEquals(12, preview.loadedBytes)
    }

    /**
     * A refusal that arrives before `get_file_info` answers has no type or size
     * to show; the header falls back to the path rather than inventing one.
     */
    @Test
    fun aFailureBeforeTheFileInfoAnswersCarriesNoMetadata() = runTest {
        val transport = FakeWorkspaceTransport()
        transport.fileInfoError = "path is outside workspace"
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://src/main.rs", "main.rs", "session-1", "failed-preview"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val failed = assertIs<RemoteFilePreviewUiState.Failed>(ready.preview)
        assertEquals("failed-preview", failed.identity.requestId)
        assertEquals("", failed.mimeType)
        assertEquals(0, failed.sizeBytes)
    }

    /**
     * The desktop reports Markdown as `text/plain`, so the name is the only
     * thing that can ask for the rendered body instead of numbered source.
     */
    @Test
    fun aMarkdownFileAsksForTheRenderedBody() = runTest {
        val transport = FakeWorkspaceTransport()
        transport.fileName = "README.md"
        transport.chunkBase64 = "IyBUaXRsZQoKQm9keSB0ZXh0Lg=="
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://README.md", "README.md", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val preview = assertIs<RemoteFilePreviewUiState.Text>(ready.preview)
        assertTrue(preview.markdown)
        assertEquals("# Title\n\nBody text.", preview.content)
    }

    @Test
    fun aSourceFileIsShownAsSourceRatherThanRendered() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://src/main.rs", "main.rs", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertFalse(assertIs<RemoteFilePreviewUiState.Text>(ready.preview).markdown)
    }

    /**
     * A desktop that calls an ELF binary `text/plain` gets the unsupported
     * body rather than a screen of replacement characters.
     */
    @Test
    fun bytesThatAreNotTextAreRefusedEvenWhenTheTypeSaysTheyAre() = runTest {
        val transport = FakeWorkspaceTransport()
        transport.chunkBase64 = "f0VMRgABAgM="
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://src/main.rs", "main.rs", "session-1", "unsupported-preview"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val unsupported = assertIs<RemoteFilePreviewUiState.Unsupported>(ready.preview)
        assertEquals("unsupported-preview", unsupported.identity.requestId)
        assertEquals("text/plain", unsupported.mimeType)
    }

    @Test
    fun anExternalLinkIsNotSomethingRetryingWillOpen() = runTest {
        val transport = FakeWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteWorkspaceIntent.OpenFile("https://example.com/a.rs", "a.rs", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val failed = assertIs<RemoteFilePreviewUiState.Failed>(ready.preview)
        assertEquals(FilePreviewFailureKind.UNAVAILABLE, failed.kind)
        assertFalse(transport.commands.any { it.cmd == "read_file_chunk" })
    }

    /**
     * The desktop's own sentence is classified in the core; only the cause
     * reaches the app, and an out-of-workspace path is not worth a Retry button.
     */
    @Test
    fun theDesktopsRefusalArrivesAsACauseRatherThanItsWording() = runTest {
        val transport = FakeWorkspaceTransport()
        transport.fileInfoError = "path is outside workspace"
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://../secret.env", "secret.env", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val failed = assertIs<RemoteFilePreviewUiState.Failed>(ready.preview)
        assertEquals(FilePreviewFailureKind.ACCESS_DENIED, failed.kind)
        assertFalse(failed.retryable)
    }

    @Test
    fun samePathRapidReopenRejectsFirstLateResponse() = runTest {
        val transport = DelayedPreviewTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://same.txt", "same.txt", "session-1", "reused-request"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://same.txt", "same.txt", "session-1", "reused-request"))
        runCurrent()
        transport.release(1)
        runCurrent()
        transport.release(0)
        runCurrent()
        assertEquals("reused-request", assertIs<RemoteFilePreviewUiState.Text>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview).identity.requestId)
    }

    @Test
    fun differentPathLateResponseCannotReplaceCurrentPreview() = runTest {
        val transport = DelayedPreviewTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://old.txt", "old.txt", "session-1", "old"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://new.txt", "new.txt", "session-1", "new"))
        runCurrent()
        transport.release(1)
        runCurrent()
        transport.release(0)
        runCurrent()
        val preview = assertIs<RemoteFilePreviewUiState.Text>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
        assertEquals("new", preview.identity.requestId)
        assertEquals("new.txt", preview.identity.path)
    }

    @Test
    fun dismissAndStopRejectLatePreviewResponses() = runTest {
        val transport = DelayedPreviewTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://late.txt", "late.txt", "session-1", "dismissed"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.DismissPreview)
        transport.release(0)
        runCurrent()
        assertIs<RemoteFilePreviewUiState.None>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)

        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://stop.txt", "stop.txt", "session-1", "stopped"))
        runCurrent()
        store.stop()
        transport.release(1)
        runCurrent()
        assertIs<RemoteFilePreviewUiState.Loading>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
    }

    @Test
    fun workspaceLoadInvalidatesLatePreviewResponse() = runTest {
        val transport = DelayedPreviewTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler), "device-a")
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://late.txt", "late.txt", "session-1", "before-load"))
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()
        transport.release(0)
        advanceUntilIdle()
        assertIs<RemoteFilePreviewUiState.None>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
    }

    @Test
    fun initialWorkspaceRequestsOverlapAndReadyWaitsForAllAuthoritativeResults() = runTest {
        val transport = OverlappingWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))

        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()

        assertEquals(
            setOf("list_recent_workspaces", "list_assistants", "get_workspace_info"),
            transport.started,
        )
        assertIs<RemoteWorkspaceUiState.Loading>(store.state.value)

        transport.release("list_recent_workspaces")
        runCurrent()
        assertIs<RemoteWorkspaceUiState.Loading>(store.state.value)
        transport.release("list_assistants")
        runCurrent()
        assertIs<RemoteWorkspaceUiState.Loading>(store.state.value)
        transport.release("get_workspace_info")
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        assertEquals("/authoritative", ready.selected?.path)
    }

    @Test
    fun switchingLoadRejectsLateResultsFromThePreviousTargetGeneration() = runTest {
        val transport = SwitchingWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))

        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        assertEquals("/new", assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).selected?.path)

        transport.releaseFirstLoad()
        advanceUntilIdle()
        assertEquals("/new", assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).selected?.path)
    }

    @Test
    fun initialWorkspaceFailureRemainsExplicit() = runTest {
        val transport = FailingWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))

        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        assertIs<RemoteWorkspaceUiState.Failed>(store.state.value)
    }

    @Test
    fun anImmediateInitialFailureCancelsHeldSiblingAndPublishesFailure() = runTest {
        val transport = FailingAndHeldWorkspaceTransport()
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))

        store.dispatch(RemoteWorkspaceIntent.Load)
        runCurrent()

        assertTrue(transport.heldRequestCancelled)
        assertIs<RemoteWorkspaceUiState.Failed>(store.state.value)
    }

    @Test
    fun imagePreviewReadsEveryChunkFromItsOriginSession() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true, imageChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("computer://preview.png", "Preview", "origin-session"))
        advanceUntilIdle()
        val image = assertIs<RemoteFilePreviewUiState.Image>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
        assertContentEquals("fn main() {}".encodeToByteArray(), image.bytes)
        val reads = transport.commands.filter { it.cmd == "read_file_chunk" }
        assertEquals(listOf(0L, 6L), reads.map { it.offset })
        assertTrue(reads.all { it.sessionId == "origin-session" })
    }

    @Test
    fun changedRevisionRejectsAnOtherwiseValidImageTransfer() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true, imageChunks = true, revisionChanges = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("preview.png", "Preview", "origin-session"))
        advanceUntilIdle()
        assertIs<RemoteFilePreviewUiState.Failed>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
    }

    @Test
    fun incompleteImageIsAnErrorInsteadOfATruncatedPreview() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true, imageChunks = true, truncate = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenFile("preview.png", "Preview", "origin-session"))
        advanceUntilIdle()
        assertIs<RemoteFilePreviewUiState.Failed>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).preview)
    }

    @Test fun workspaceDownloadRetryRetainsOriginalSshScopeWithoutAChat() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true).apply { savedConnection = "saved-ssh" }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("/repo/main.rs", "main.rs", "")); advanceUntilIdle()
        val first = assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        store.dispatch(RemoteWorkspaceIntent.DownloadSaveFailed(first.target.path))
        // Device tools may move to another location while the export error is visible.
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("/other", null)); advanceUntilIdle()
        transport.commands.clear()
        store.dispatch(RemoteWorkspaceIntent.RetryDownload); advanceUntilIdle()
        val retried = assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        assertEquals(first.target, retried.target)
        val reads = transport.commands.filter { it.cmd in setOf("get_file_info", "read_file_chunk") }
        assertEquals(3, reads.size)
        assertTrue(reads.all { it.sessionId == null && it.workspacePath == "/repo" && it.remoteConnectionId == "saved-ssh" })
        store.dispatch(RemoteWorkspaceIntent.DownloadSaveFailed(retried.target.path))
        store.stop()
        transport.commands.clear()
        store.dispatch(RemoteWorkspaceIntent.RetryDownload); advanceUntilIdle()
        assertTrue(transport.commands.isEmpty(), "A stopped device must not accept an old retry")
    }

    @Test fun deviceLocalDownloadDoesNotInheritSelectedSshWorkspace() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true).apply { savedConnection = "saved-ssh" }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("/repo", null)); advanceUntilIdle()
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).files.failed)
        transport.commands.clear()
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("/repo/main.rs", "main.rs", "")); advanceUntilIdle()
        val download = assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        val reads = transport.commands.filter { it.cmd in setOf("get_file_info", "read_file_chunk") }
        assertEquals(3, reads.size)
        assertTrue(reads.all { it.sessionId == null && it.workspacePath == "/repo" && it.remoteConnectionId == null })
        store.dispatch(RemoteWorkspaceIntent.DownloadSaved(download.target.path)); store.stop()
    }

    @Test fun deviceSshDownloadDoesNotInheritSelectedLocalWorkspace() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.OpenDeviceFiles("/", "saved-1")); advanceUntilIdle()
        assertFalse(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).files.failed)
        transport.commands.clear()
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("/tmp/main.rs", "main.rs", "")); advanceUntilIdle()
        val download = assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        val reads = transport.commands.filter { it.cmd in setOf("get_file_info", "read_file_chunk") }
        assertEquals(3, reads.size)
        assertTrue(reads.all { it.sessionId == null && it.workspacePath == "/" && it.remoteConnectionId == "saved-1" })
        store.dispatch(RemoteWorkspaceIntent.DownloadSaved(download.target.path)); store.stop()
    }

    @Test fun workspaceDownloadCapturesSavedConnectionForEveryChunk() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true).apply { savedConnection = "saved-ssh" }
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load); advanceUntilIdle()
        store.dispatch(RemoteWorkspaceIntent.DownloadFile("/repo/main.rs", "main.rs", "")); advanceUntilIdle()
        val download = assertIs<RemoteFileDownloadUiState.AwaitingSave>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
        val reads = transport.commands.filter { it.cmd in setOf("get_file_info", "read_file_chunk") }
        assertEquals(3, reads.size)
        assertTrue(reads.all { it.sessionId == null && it.workspacePath == "/repo" && it.remoteConnectionId == "saved-ssh" })
        store.dispatch(RemoteWorkspaceIntent.DownloadSaved(download.target.path)); store.stop()
    }

    @Test
    fun downloadsAFileInChunksAndWaitsForThePlatformSaver() = runTest {
        val transport = FakeWorkspaceTransport(downloadChunks = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteWorkspaceIntent.DownloadFile("computer://src/main.rs", "main.rs", "session-1"))
        advanceUntilIdle()

        val ready = assertIs<RemoteWorkspaceUiState.Ready>(store.state.value)
        val download = assertIs<RemoteFileDownloadUiState.AwaitingSave>(ready.download)
        assertTrue(download.localReference.isNotBlank())
        assertEquals(listOf(0L, 6L), transport.commands.filter { it.cmd == "read_file_chunk" }.map { it.offset })

        store.dispatch(RemoteWorkspaceIntent.DownloadSaved(download.target.path))
        assertIs<RemoteFileDownloadUiState.Saved>(assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download)
    }

    @Test
    fun anOlderPeerWithoutChunkReadsFailsLoudly() = runTest {
        val transport = FakeWorkspaceTransport(readFileUnsupported = true)
        val store = RemoteWorkspaceStore.create(this, transport, StandardTestDispatcher(testScheduler))
        store.dispatch(RemoteWorkspaceIntent.Load)
        advanceUntilIdle()

        store.dispatch(RemoteWorkspaceIntent.DownloadFile("computer://src/main.rs", "main.rs", "session-1"))
        advanceUntilIdle()

        val download = assertIs<RemoteFileDownloadUiState.Failed>(
            assertIs<RemoteWorkspaceUiState.Ready>(store.state.value).download,
        )
        assertEquals(FilePreviewFailureKind.LOAD_FAILED, download.kind)
    }
}

private class OverlappingWorkspaceTransport : RemoteCommandTransport {
    val started = mutableSetOf<String>()
    private val gates = mutableMapOf<String, CompletableDeferred<Unit>>()

    fun release(command: String) {
        gates.getValue(command).complete(Unit)
    }

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        started += command.cmd
        if (command.cmd == "host_invoke") return RelayJson.decodeFromString(deserializer, """{"resp":"host_invoke_result","ok":true,"value":[]}""")
        val gate = CompletableDeferred<Unit>().also { gates[command.cmd] = it }
        gate.await()
        val json = when (command.cmd) {
            "host_invoke" -> """{"resp":"host_invoke_result","ok":true,"value":[{"id":"saved-1","name":"Saved host","host":"host"}]}"""
            "list_recent_workspaces" -> """{"resp":"ok","workspaces":[{"path":"/repo"}]}"""
            "list_assistants" -> """{"resp":"ok","assistants":[]}"""
            "get_workspace_info" -> """{"resp":"ok","has_workspace":true,"path":"/authoritative"}"""
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}

private class SwitchingWorkspaceTransport : RemoteCommandTransport {
    private var loadCount = 0
    private val firstLoadGates = mutableListOf<CompletableDeferred<Unit>>()

    fun releaseFirstLoad() {
        firstLoadGates.forEach { it.complete(Unit) }
    }

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        val firstLoad = loadCount < 3
        if (command.cmd in setOf("list_recent_workspaces", "list_assistants", "get_workspace_info")) loadCount += 1
        if (firstLoad) {
            val gate = CompletableDeferred<Unit>()
            firstLoadGates += gate
            withContext(NonCancellable) { gate.await() }
        }
        val path = if (firstLoad) "/old" else "/new"
        val json = when (command.cmd) {
            "host_invoke" -> """{"resp":"host_invoke_result","ok":true,"value":[{"id":"saved-1","name":"Saved host","host":"host"}]}"""
            "list_recent_workspaces" -> """{"resp":"ok","workspaces":[{"path":"$path"}]}"""
            "list_assistants" -> """{"resp":"ok","assistants":[]}"""
            "get_workspace_info" -> """{"resp":"ok","has_workspace":true,"path":"$path"}"""
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}

private class FailingWorkspaceTransport : RemoteCommandTransport {
    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        error("workspace catalog unavailable")
    }
}

private class FailingAndHeldWorkspaceTransport : RemoteCommandTransport {
    var heldRequestCancelled = false

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        when (command.cmd) {
            "list_recent_workspaces" -> {
                try {
                    CompletableDeferred<Unit>().await()
                } catch (cancelled: kotlinx.coroutines.CancellationException) {
                    heldRequestCancelled = true
                    throw cancelled
                }
            }
            "get_workspace_info" -> error("workspace info failed")
            "list_assistants" -> Unit
            else -> error("Unexpected command ${command.cmd}")
        }
        error("held request should not complete")
    }
}

private class DelayedPreviewTransport : RemoteCommandTransport {
    private val gates = mutableListOf<CompletableDeferred<Unit>>()
    private var readIndex: Int = 0

    fun release(index: Int) {
        gates[index].complete(Unit)
    }

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        val json = when (command.cmd) {
            "host_invoke" -> """{"resp":"host_invoke_result","ok":true,"value":[{"id":"saved-1","name":"Saved host","host":"host"}]}"""
            "list_recent_workspaces" -> """{"resp":"ok","workspaces":[{"path":"/repo","name":"Repo"}]}"""
            "list_assistants" -> """{"resp":"ok","assistants":[]}"""
            "get_workspace_info" -> """{"resp":"ok","has_workspace":true,"path":"/repo"}"""
            "get_file_info" -> """{"resp":"ok","name":"${command.path}","size":4,"mime_type":"text/plain"}"""
            "read_file_chunk" -> {
                val index = readIndex++
                val gate = CompletableDeferred<Unit>().also(gates::add)
                withContext(NonCancellable) { gate.await() }
                """{"resp":"ok","name":"${command.path}","chunk_base64":"dGV4dA==","offset":0,"chunk_size":4,"total_size":4,"mime_type":"text/plain"}"""
            }
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}

private class FakeWorkspaceTransport(
    private val downloadChunks: Boolean = false,
    private val readFileUnsupported: Boolean = false,
    private val imageChunks: Boolean = false,
    private val truncate: Boolean = false,
    private val revisionChanges: Boolean = false,
) : RemoteCommandTransport {
    val commands = mutableListOf<RemoteCommand>()
    var selectionAccepted: Boolean = true

    val commandGates = mutableMapOf<String, CompletableDeferred<Unit>>()
    var fileInfoError: String? = null
    var savedConnection: String? = null

    /** What the desktop calls the file, and the bytes it hands back for it. */
    var fileName: String = "main.rs"
    var chunkBase64: String = "Zm4gbWFpbigpIHt9"

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        commands += command
        commandGates[command.cmd]?.await()
        val json = when (command.cmd) {
            "host_invoke" -> if (command.command == "get_directory_children_paginated") {
                """{"resp":"host_invoke_result","ok":true,"value":{"children":[],"hasMore":false}}"""
            } else """{"resp":"host_invoke_result","ok":true,"value":[{"id":"saved-1","name":"Saved host","host":"host"}]}"""
            "list_recent_workspaces" ->
                """{"resp":"ok","workspaces":[{"path":"/repo","name":"Repo","last_opened":"2026-08-09"}]}"""
            "list_assistants" ->
                """{"resp":"ok","assistants":[{"path":"/assistant","name":"Assistant","assistant_id":"a1"}]}"""
            "get_workspace_info" ->
                """{"resp":"ok","has_workspace":true,"path":"/repo","project_name":"Repo","git_branch":"main","workspace_kind":"${if (savedConnection == null) "local" else "remote"}","remote_connection_id":${savedConnection?.let { "\"$it\"" } ?: "null"}}"""
            "set_workspace" -> """{"resp":"ok","success":$selectionAccepted,"path":"${command.path}"}"""
            "set_assistant" -> """{"resp":"ok","success":$selectionAccepted,"path":"${command.path}"}"""
            "get_file_info" -> {
                fileInfoError?.let { error(it) }
                """{"resp":"ok","name":"$fileName","size":${if (downloadChunks) 12 else 16},"mime_type":"text/plain"}"""
            }
            "read_file_chunk" -> if (readFileUnsupported) {
                error("unsupported command read_file_chunk")
            } else if (downloadChunks && command.offset == 0L) {
                """{"resp":"ok","name":"main.rs","chunk_base64":"Zm4gbWFp","offset":0,"chunk_size":6,"total_size":12,"mime_type":"text/plain"}"""
            } else if (downloadChunks) {
                """{"resp":"ok","name":"main.rs","chunk_base64":"bigpIHt9","offset":6,"chunk_size":6,"total_size":12,"mime_type":"text/plain"}"""
            } else {
                """{"resp":"ok","name":"$fileName","chunk_base64":"$chunkBase64","offset":0,"chunk_size":12,"total_size":12,"mime_type":"text/plain"}"""
            }
            else -> error("Unexpected command ${command.cmd}")
        }
        var response = if (imageChunks) json.replace("main.rs", "preview.png").replace("text/plain", "image/png") else json
        if (truncate && command.cmd == "read_file_chunk" && command.offset != 0L) {
            response = response.replace("bigpIHt9", "").replace("\"chunk_size\":6", "\"chunk_size\":0")
        }
        if (revisionChanges && command.cmd == "read_file_chunk") {
            response = response.dropLast(1) + ",\"revision\":\"12:${command.offset}\"}"
        }
        return RelayJson.decodeFromString(deserializer, response)
    }
}

private class MemoryWorkspaceListStore : RemoteWorkspaceListStore {
    val rows = mutableMapOf<String, List<PersistedRemoteWorkspace>>()
    override fun load(deviceKey: String): List<PersistedRemoteWorkspace> = rows[deviceKey].orEmpty()
    override fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>) {
        rows[deviceKey] = workspaces
    }
}

private class FailingWorkspaceListStore : RemoteWorkspaceListStore {
    override fun load(deviceKey: String): List<PersistedRemoteWorkspace> = error("workspace cache read failed")
    override fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>): Unit =
        error("workspace cache write failed")
}
