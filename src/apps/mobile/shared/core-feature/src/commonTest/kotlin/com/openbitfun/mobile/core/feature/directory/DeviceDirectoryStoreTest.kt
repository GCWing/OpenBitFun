package com.openbitfun.mobile.core.feature.directory

import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.feature.session.RemoteSessionStore
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceStore
import com.openbitfun.mobile.core.persistence.ChatLocalStore
import com.openbitfun.mobile.core.persistence.DraftStore
import com.openbitfun.mobile.core.persistence.MobilePersistenceStores
import com.openbitfun.mobile.core.persistence.PersistedChatMessage
import com.openbitfun.mobile.core.persistence.PersistedChatSession
import com.openbitfun.mobile.core.persistence.PersistedRemoteSession
import com.openbitfun.mobile.core.persistence.PersistedRemoteWorkspace
import com.openbitfun.mobile.core.persistence.RemoteSessionListStore
import com.openbitfun.mobile.core.persistence.RemoteWorkspaceListStore
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.transport.RelayFailure
import com.openbitfun.mobile.core.transport.RelayTransportException
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.DeserializationStrategy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceDirectoryStoreTest {
    @Test
    fun workspaceDisclosureSurvivesRefreshAndOfflineRoundTrip() = runTest {
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to FakeDeviceTransport("a"))))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        advanceUntilIdle()
        for (online in listOf(true, false, true)) {
            store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", online))))
            val entry = store.state.value.device("a")!!
            assertTrue(entry.workspaceDirectory.single().expanded)
        }
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", false))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertFalse(store.state.value.device("a")!!.workspaceDirectory.single().expanded)
        store.stop()
    }

    @Test
    fun devicesLoadIndependentlyAndOneFailureDoesNotClearOthers() = runTest {
        val transports = mutableMapOf(
            "a" to FakeDeviceTransport("a"),
            "b" to FakeDeviceTransport("b"),
        )
        transports.getValue("b").workspaceFailure = RelayFailure.Timeout
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(transports))

        store.dispatch(
            DeviceDirectoryIntent.Sync(
                listOf(
                    DeviceDirectoryDevice("a", "Alpha", true),
                    DeviceDirectoryDevice("b", "Beta", true),
                ),
            ),
        )
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        store.dispatch(DeviceDirectoryIntent.Load("b"))
        advanceUntilIdle()

        val a = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.READY, a.status)
        assertEquals(listOf("/repo-a"), a.workspaces.map { it.path })
        assertTrue(a.sessions.isEmpty())

        val failedB = store.state.value.device("b")!!
        assertEquals(DeviceDirectoryStatus.FAILED, failedB.status)
        assertEquals(DeviceDirectoryFailure.LOAD_FAILED, failedB.error)

        // A retry recovers b without disturbing a's already-loaded content.
        transports.getValue("b").workspaceFailure = null
        store.dispatch(DeviceDirectoryIntent.Retry("b"))
        advanceUntilIdle()

        val recoveredB = store.state.value.device("b")!!
        assertEquals(DeviceDirectoryStatus.READY, recoveredB.status)
        assertTrue(recoveredB.sessions.isEmpty())
        val stillA = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.READY, stillA.status)
        assertTrue(stillA.sessions.isEmpty())
    }

    @Test
    fun authoritativeCloseRetainsSessionsAndCannotBeUndoneByOfflineCacheHydration() = runTest {
        val transport = FakeDeviceTransport("a")
        val history = MemoryDirectoryWorkspaces()
        val cache = MemoryDirectorySessions()
        val store = DeviceDirectoryStore.create(this, CachedDeviceStoreFactory(transport, cache, history))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        advanceUntilIdle()
        assertEquals(listOf("s-a"), store.state.value.device("a")!!.sessions.map { it.id })
        transport.openedJson = "[]"
        transport.assistantJson = """[{"path":"/assistant","name":"Assistant"}]"""
        store.dispatch(DeviceDirectoryIntent.Retry("a"))
        advanceUntilIdle()
        val ready = store.state.value.device("a")!!
        assertTrue(ready.workspaces.isEmpty())
        assertEquals("OPENED", ready.catalogSource?.name)
        assertEquals(listOf("/repo-a"), ready.recentWorkspaces.map { it.path })
        assertEquals(listOf("s-a"), ready.sessions.map { it.id })
        assertTrue(history.byDevice.getValue("a").any { it.path == "/repo-a" })
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", false))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        assertTrue(store.state.value.device("a")!!.workspaces.isEmpty())
        assertEquals(listOf("s-a"), store.state.value.device("a")!!.sessions.map { it.id })
        store.stop()
    }

    @Test
    fun samePathSshDirectoriesLoadIndependentlyAndRefreshOnlyTheirOwnSessions() = runTest {
        val transport = FakeDeviceTransport("a")
        transport.openedJson = """[{"path":"/shared","remote_connection_id":"ssh-a","remote_ssh_host":"a"},{"path":"/shared","remote_connection_id":"ssh-b","remote_ssh_host":"b"}]"""
        transport.sessionJsonByConnection["ssh-a"] = """[{"id":"session-a","agent_type":"code"}]"""
        transport.sessionJsonByConnection["ssh-b"] = """[{"id":"session-b","agent_type":"code"}]"""
        val sessions = MemoryDirectorySessions()
        val store = DeviceDirectoryStore.create(this, CachedDeviceStoreFactory(transport, sessions, MemoryDirectoryWorkspaces()))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a")); advanceUntilIdle()
        val gateA = CompletableDeferred<Unit>(); val gateB = CompletableDeferred<Unit>()
        transport.sessionGateByConnection["ssh-a"] = gateA
        transport.sessionGateByConnection["ssh-b"] = gateB
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/shared", true, "ssh-a", "a"))
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/shared", true, "ssh-b", "b"))
        runCurrent()
        assertEquals(2, transport.commands.count { it.cmd == "list_sessions" })
        gateB.complete(Unit); runCurrent()
        assertEquals(WorkspaceDirectoryStatus.READY, store.state.value.device("a")!!.workspace("/shared", "ssh-b", "b")!!.status)
        assertEquals(WorkspaceDirectoryStatus.LOADING, store.state.value.device("a")!!.workspace("/shared", "ssh-a", "a")!!.status)
        gateA.complete(Unit); advanceUntilIdle()
        val ready = store.state.value.device("a")!!
        assertEquals(listOf("session-a"), ready.sessionsForWorkspace("/shared", "ssh-a", "a").map { it.id })
        assertEquals(listOf("session-b"), ready.sessionsForWorkspace("/shared", "ssh-b", "b").map { it.id })
        assertTrue(ready.sessionsForWorkspace("/shared", null, null).isEmpty())
        assertEquals(setOf("ssh-a", "ssh-b"), sessions.byDevice.getValue("a").map { it.workspaceIdentity?.remoteConnectionId }.toSet())
        transport.sessionJsonByConnection["ssh-a"] = "[]"
        store.dispatch(DeviceDirectoryIntent.RetryWorkspace("a", "/shared", "ssh-a", "a")); advanceUntilIdle()
        assertEquals(listOf("session-b"), store.state.value.device("a")!!.sessions.map { it.id })
        assertEquals("a", transport.commands.last { it.cmd == "list_sessions" }.remoteSshHost)
        store.stop()
    }

    @Test
    fun duplicateLoadCollapsesToOneFetch() = runTest {
        val transport = FakeDeviceTransport("a")
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()

        val a = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.READY, a.status)
        assertEquals(1, transport.commands.count { it.cmd == "list_recent_workspaces" })
        assertEquals(1, transport.commands.count { it.cmd == "list_assistants" })
        assertEquals(0, transport.commands.count { it.cmd == "get_workspace_info" })
        assertEquals(0, transport.commands.count { it.cmd == "list_sessions" })
    }

    @Test
    fun loadingReadyDirectoryPreservesDataWithoutRefetching() = runTest {
        val transport = FakeDeviceTransport("a")
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()

        val first = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.READY, first.status)
        assertTrue(first.sessions.isEmpty())
        val listSessionsBefore = transport.commands.count { it.cmd == "list_sessions" }
        assertEquals(0, listSessionsBefore)

        // Revisiting a ready device keeps its data instead of re-fetching.
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()

        val again = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.READY, again.status)
        assertTrue(again.sessions.isEmpty())
        assertEquals(listSessionsBefore, transport.commands.count { it.cmd == "list_sessions" })
    }

    @Test
    fun stopCancelsRunningLoadsButKeepsLoadedData() = runTest {
        val transports = mutableMapOf(
            "a" to FakeDeviceTransport("a"),
            "b" to FakeDeviceTransport("b"),
        )
        val bGate = CompletableDeferred<Unit>()
        transports.getValue("b").workspaceGate = bGate
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(transports))

        store.dispatch(
            DeviceDirectoryIntent.Sync(
                listOf(
                    DeviceDirectoryDevice("a", true),
                    DeviceDirectoryDevice("b", true),
                ),
            ),
        )
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertEquals(DeviceDirectoryStatus.READY, store.state.value.device("a")!!.status)

        store.dispatch(DeviceDirectoryIntent.Load("b"))
        runCurrent()

        // b reached its workspace request and is blocked, so it is still loading.
        assertEquals(DeviceDirectoryStatus.LOADING, store.state.value.device("b")!!.status)
        assertTrue(transports.getValue("b").commands.any { it.cmd == "list_recent_workspaces" })

        store.dispatch(DeviceDirectoryIntent.Stop)
        advanceUntilIdle()

        // Loaded data survives; the in-flight load is cancelled, not turned into a failure.
        assertEquals(DeviceDirectoryStatus.READY, store.state.value.device("a")!!.status)
        assertEquals(listOf("/repo-a"), store.state.value.device("a")!!.workspaces.map { it.path })
        assertEquals(DeviceDirectoryStatus.IDLE, store.state.value.device("b")!!.status)
        assertFalse(bGate.isCompleted)
    }

    @Test
    fun offlineTransitionCancelsLoadAndCachedDataCanReloadAfterReconnect() = runTest {
        val transport = FakeDeviceTransport("a")
        val factory = FakeDeviceStoreFactory(mutableMapOf("a" to transport))
        val store = DeviceDirectoryStore.create(this, factory)
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertEquals(DeviceDirectoryStatus.READY, store.state.value.device("a")!!.status)

        val gate = CompletableDeferred<Unit>()
        transport.workspaceGate = gate
        store.dispatch(DeviceDirectoryIntent.Retry("a"))
        runCurrent()
        assertEquals(DeviceDirectoryStatus.LOADING, store.state.value.device("a")!!.status)

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", "Alpha", false))))
        assertEquals(DeviceDirectoryStatus.CACHED, store.state.value.device("a")!!.status)
        assertFalse(store.state.value.device("a")!!.online)
        assertEquals(2, transport.commands.count { it.cmd == "list_recent_workspaces" })
        transport.workspaceGate = null

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", "Alpha", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertEquals(DeviceDirectoryStatus.READY, store.state.value.device("a")!!.status)
    }

    @Test
    fun stopThenImmediateReloadIgnoresCancelledJobFinally() = runTest {
        val transport = FakeDeviceTransport("a")
        val gate = CompletableDeferred<Unit>()
        transport.workspaceGate = gate
        val factory = FakeDeviceStoreFactory(mutableMapOf("a" to transport))
        val store = DeviceDirectoryStore.create(this, factory)
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        runCurrent()
        store.dispatch(DeviceDirectoryIntent.Stop)
        transport.workspaceGate = null
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertEquals(DeviceDirectoryStatus.READY, store.state.value.device("a")!!.status)
        assertEquals(2, transport.commands.count { it.cmd == "list_recent_workspaces" })
        assertFalse(gate.isCompleted)
    }

    @Test
    fun failedRefreshRetainsTheLastWorkspaceAndSessionProjection() = runTest {
        val transport = FakeDeviceTransport("a")
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        advanceUntilIdle()
        assertEquals(listOf("/repo-a"), store.state.value.device("a")!!.workspaces.map { it.path })
        assertEquals(listOf("s-a"), store.state.value.device("a")!!.sessions.map { it.id })

        transport.workspaceFailure = RelayFailure.Timeout
        store.dispatch(DeviceDirectoryIntent.Retry("a"))
        advanceUntilIdle()

        val failed = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.FAILED, failed.status)
        assertEquals(listOf("/repo-a"), failed.workspaces.map { it.path })
        assertEquals(listOf("s-a"), failed.sessions.map { it.id })
    }

    @Test
    fun assistantCatalogEntriesAreProjectedAsDeviceWorkspaces() = runTest {
        val transport = FakeDeviceTransport("a").apply {
            assistantJson = """[{"path":"/assistant-a","name":"Assistant A","assistant_id":"assistant-a"}]"""
        }
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()

        val workspaces = store.state.value.device("a")!!.workspaces
        assertEquals(listOf("/assistant-a", "/repo-a"), workspaces.map { it.path })
        assertEquals("assistant", workspaces.first().kind)
    }

    @Test
    fun workspaceDisclosureLoadsOnlyThatWorkspaceAndDeduplicatesTaps() = runTest {
        val transport = FakeDeviceTransport("a")
        val gate = CompletableDeferred<Unit>()
        transport.sessionGate = gate
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        assertEquals(0, transport.commands.count { it.cmd == "list_sessions" })

        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        runCurrent()

        val loading = store.state.value.device("a")!!.workspace("/repo-a")!!
        assertTrue(loading.expanded)
        assertEquals(WorkspaceDirectoryStatus.LOADING, loading.status)
        assertEquals(1, transport.commands.count { it.cmd == "list_sessions" })
        assertEquals("/repo-a", transport.commands.first { it.cmd == "list_sessions" }.workspacePath)

        gate.complete(Unit)
        advanceUntilIdle()
        val ready = store.state.value.device("a")!!
        assertEquals(WorkspaceDirectoryStatus.READY, ready.workspace("/repo-a")!!.status)
        assertEquals(listOf("s-a"), ready.sessions.map { it.id })
    }

    @Test
    fun workspaceFailureKeepsSiblingSessionsAndCanRetry() = runTest {
        val transport = FakeDeviceTransport("a")
        transport.extraWorkspaces = """,{"path":"/other","name":"Other","workspace_kind":"normal"}"""
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        advanceUntilIdle()
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/repo-a", true))
        advanceUntilIdle()
        assertEquals(listOf("s-a"), store.state.value.device("a")!!.sessions.map { it.id })

        transport.sessionFailure = RelayFailure.Timeout
        store.dispatch(DeviceDirectoryIntent.RetryWorkspace("a", "/other"))
        advanceUntilIdle()
        val failed = store.state.value.device("a")!!
        assertEquals(WorkspaceDirectoryStatus.FAILED, failed.workspace("/other")!!.status)
        assertEquals(listOf("s-a"), failed.sessions.map { it.id })

        transport.sessionFailure = null
        transport.sessionJson = """[{"id":"s-other","title":"Other","agent_type":"code"}]"""
        store.dispatch(DeviceDirectoryIntent.RetryWorkspace("a", "/other"))
        advanceUntilIdle()
        val recovered = store.state.value.device("a")!!
        assertEquals(WorkspaceDirectoryStatus.READY, recovered.workspace("/other")!!.status)
        assertEquals(listOf("s-other", "s-a"), recovered.sessions.map { it.id })
    }

    @Test
    fun partialSlotCreationStopsTheSessionStore() = runTest {
        val transport = FakeDeviceTransport("a")
        val factory = FakeDeviceStoreFactory(mutableMapOf("a" to transport), failWorkspace = setOf("a"))
        val store = DeviceDirectoryStore.create(this, factory)
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        assertEquals(DeviceDirectoryFailure.NOT_SIGNED_IN, store.state.value.device("a")!!.error)
        assertTrue(transport.commands.none { it.cmd == "list_sessions" })
    }

    @Test
    fun confirmedCreateReconcilesOnlyOwningDeviceAndServerEventuallyCalibratesIt() = runTest {
        val transports = mutableMapOf(
            "a" to FakeDeviceTransport("a"),
            "b" to FakeDeviceTransport("b"),
        )
        transports.getValue("a").extraWorkspaces = """,{"path":"/assistant-not-current","name":"Assistant","workspace_kind":"normal"}"""
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(transports))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", true), DeviceDirectoryDevice("b", true))))
        store.dispatch(DeviceDirectoryIntent.Load("a"))
        store.dispatch(DeviceDirectoryIntent.Load("b"))
        advanceUntilIdle()
        val key = store.reconcileKey("a")!!
        val confirmed = RemoteSession(
            id = "created", title = "Confirmed", agentType = "cowork", status = "active",
            updatedAt = "created-time", createdAt = "created-time", messageCount = 1,
            workspacePath = "/assistant-not-current", workspaceName = "Assistant",
        )

        assertTrue(store.reconcileCreatedSession(key, confirmed))
        assertTrue(store.reconcileCreatedSession(key, confirmed))
        assertEquals(listOf("created"), store.state.value.device("a")!!.sessions.map { it.id })
        assertEquals("/assistant-not-current", store.state.value.device("a")!!.sessions.first().workspacePath)
        assertTrue(store.state.value.device("b")!!.sessions.isEmpty())

        // The first server list is behind the confirmed create; the local row survives.
        store.dispatch(DeviceDirectoryIntent.RetryWorkspace("a", "/assistant-not-current"))
        advanceUntilIdle()
        assertEquals(1, store.state.value.device("a")!!.sessions.count { it.id == "created" })

        // Once the source returns the id, its newer fields replace the projection without duplication.
        transports.getValue("a").sessionJson =
            """[{"id":"created","title":"Server title","agent_type":"cowork","status":"idle","workspace_path":"/assistant-not-current","workspace_name":"Server assistant"}]"""
        store.dispatch(DeviceDirectoryIntent.RetryWorkspace("a", "/assistant-not-current"))
        advanceUntilIdle()
        val calibrated = store.state.value.device("a")!!.sessions.single { it.id == "created" }
        assertEquals("Server title", calibrated.title)
        assertEquals("Server assistant", calibrated.workspaceName)
        assertEquals(1, store.state.value.device("a")!!.sessions.count { it.id == "created" })
    }

    @Test
    fun staleReconcileCannotReviveRemovedStoppedOrReconnectedDevice() = runTest {
        val transport = FakeDeviceTransport("a")
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(mutableMapOf("a" to transport)))
        val device = DeviceDirectoryDevice("a", true)
        val confirmed = RemoteSession(
            id = "created", title = "Created", agentType = "code", status = "active",
            updatedAt = "", createdAt = "", messageCount = 0,
            workspacePath = "/repo-a", workspaceName = null,
        )

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(device)))
        val removedKey = store.reconcileKey("a")!!
        store.dispatch(DeviceDirectoryIntent.Sync(emptyList()))
        assertFalse(store.reconcileCreatedSession(removedKey, confirmed))

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(device)))
        val stoppedKey = store.reconcileKey("a")!!
        store.dispatch(DeviceDirectoryIntent.Stop)
        assertFalse(store.reconcileCreatedSession(stoppedKey, confirmed))

        val reconnectKey = store.reconcileKey("a")!!
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", false))))
        store.dispatch(DeviceDirectoryIntent.Sync(listOf(device)))
        assertFalse(store.reconcileCreatedSession(reconnectKey, confirmed))
        assertTrue(store.state.value.device("a")!!.sessions.none { it.id == "created" })
    }

    @Test
    fun offlineDevicesWithoutCacheRemainIdleAndMissingStoresFailTyped() = runTest {
        val transports = mutableMapOf("a" to FakeDeviceTransport("a"))
        val store = DeviceDirectoryStore.create(this, FakeDeviceStoreFactory(transports, missing = setOf("b")))

        store.dispatch(
            DeviceDirectoryIntent.Sync(
                listOf(
                    DeviceDirectoryDevice("a", true),
                    DeviceDirectoryDevice("b", "Offline", false),
                ),
            ),
        )
        store.dispatch(DeviceDirectoryIntent.Load("b"))
        advanceUntilIdle()

        // Offline rows stay idle; they are never asked for content.
        val offline = store.state.value.device("b")!!
        assertEquals(DeviceDirectoryStatus.IDLE, offline.status)
        assertTrue(offline.workspaces.isEmpty())
        assertTrue(offline.sessions.isEmpty())
        assertEquals(0, transports.getValue("a").commands.count { it.cmd == "list_sessions" })

        // An online device whose store cannot be created fails as NOT_SIGNED_IN.
        val missingTransports = mutableMapOf<String, FakeDeviceTransport>()
        val missingStore = DeviceDirectoryStore.create(
            this,
            FakeDeviceStoreFactory(missingTransports, missing = setOf("x")),
        )
        missingStore.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("x", true))))
        missingStore.dispatch(DeviceDirectoryIntent.Load("x"))
        advanceUntilIdle()
        val x = missingStore.state.value.device("x")!!
        assertEquals(DeviceDirectoryStatus.FAILED, x.status)
        assertEquals(DeviceDirectoryFailure.NOT_SIGNED_IN, x.error)
    }

    @Test
    fun offlineDeviceHydratesItsWorkspaceAndSessionCatalogFromDisk() = runTest {
        val transport = FakeDeviceTransport("a")
        val cachedSessions = MemoryDirectorySessions().apply {
            byDevice["a"] = listOf(
                PersistedRemoteSession(
                    sessionId = "cached-session",
                    title = "Cached",
                    agentType = "code",
                    workspacePath = "/cached/repo/",
                ),
            )
        }
        val cachedWorkspaces = MemoryDirectoryWorkspaces().apply {
            byDevice["a"] = listOf(
                PersistedRemoteWorkspace(path = "/cached/repo", name = "Cached repo"),
            )
        }
        val factory = CachedDeviceStoreFactory(
            transport = transport,
            sessions = cachedSessions,
            workspaces = cachedWorkspaces,
        )
        val store = DeviceDirectoryStore.create(this, factory)

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", "Alpha", false))))

        val cached = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.CACHED, cached.status)
        assertEquals(listOf("/cached/repo"), cached.workspaces.map { it.path })
        assertEquals(listOf("cached-session"), cached.sessions.map { it.id })
        assertEquals(WorkspaceDirectoryStatus.READY, cached.workspace("/cached/repo/")?.status)
        store.dispatch(DeviceDirectoryIntent.SetWorkspaceExpanded("a", "/cached/repo/", true))
        assertEquals(0, transport.commands.count { it.cmd == "list_sessions" })
        assertTrue(transport.commands.isEmpty())
    }

    @Test
    fun legacySessionCacheIsRetainedWithoutInventingOpenedWorkspaces() = runTest {
        val transport = FakeDeviceTransport("a")
        val cachedSessions = MemoryDirectorySessions().apply {
            byDevice["a"] = listOf(
                PersistedRemoteSession(
                    sessionId = "legacy-session",
                    title = "Legacy",
                    workspacePath = "/legacy/repo/",
                    workspaceName = "Legacy repo",
                ),
            )
        }
        val store = DeviceDirectoryStore.create(
            this,
            CachedDeviceStoreFactory(transport, cachedSessions, MemoryDirectoryWorkspaces()),
        )

        store.dispatch(DeviceDirectoryIntent.Sync(listOf(DeviceDirectoryDevice("a", false))))

        val cached = store.state.value.device("a")!!
        assertEquals(DeviceDirectoryStatus.CACHED, cached.status)
        assertTrue(cached.workspaces.isEmpty())
        assertEquals(listOf("legacy-session"), cached.sessions.map { it.id })
    }
}

private class FakeDeviceStoreFactory(
    private val transports: MutableMap<String, FakeDeviceTransport>,
    private val missing: Set<String> = emptySet(),
    private val failWorkspace: Set<String> = emptySet(),
) : DeviceStoreFactory {
    override fun createSessionStore(scope: CoroutineScope, deviceId: String): RemoteSessionStore? {
        if (deviceId in missing) return null
        return RemoteSessionStore.create(scope, transports.getValue(deviceId))
    }

    override fun createWorkspaceStore(scope: CoroutineScope, deviceId: String): RemoteWorkspaceStore? {
        if (deviceId in missing || deviceId in failWorkspace) return null
        return RemoteWorkspaceStore.create(scope, transports.getValue(deviceId))
    }
}

private class FakeDeviceTransport(private val deviceId: String) : RemoteCommandTransport {
    val commands = mutableListOf<RemoteCommand>()
    var workspacePath: String = "/repo-$deviceId"
    var sessionFailure: RelayFailure? = null
    var workspaceFailure: RelayFailure? = null
    var sessionGate: CompletableDeferred<Unit>? = null
    var workspaceGate: CompletableDeferred<Unit>? = null
    val sessionJsonByConnection = mutableMapOf<String, String>()
    val sessionGateByConnection = mutableMapOf<String, CompletableDeferred<Unit>>()
    var sessionJson: String =
        """[{"id":"s-$deviceId","title":"Session $deviceId","agent_type":"code"}]"""
    var assistantJson: String = "[]"
    var openedJson: String = "null"
    var extraWorkspaces: String = ""

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        commands += command
        val json = when (command.cmd) {
            "list_recent_workspaces" -> {
                workspaceFailure?.let { throw RelayTransportException(it) }
                workspaceGate?.await()
                """{"resp":"ok","workspaces":[{"path":"/repo-$deviceId","name":"Repo $deviceId","last_opened":"2026-08-09","workspace_kind":"local"}$extraWorkspaces],"opened_workspaces":$openedJson}"""
            }
            "list_assistants" -> """{"resp":"ok","assistants":$assistantJson}"""
            "get_workspace_info" ->
                """{"resp":"ok","has_workspace":true,"path":"$workspacePath","project_name":"Repo","git_branch":"main"}"""
            "list_sessions" -> {
                sessionFailure?.let { throw RelayTransportException(it) }
                sessionGate?.await()
                sessionGateByConnection[command.remoteConnectionId]?.await()
                val selectedJson = sessionJsonByConnection[command.remoteConnectionId] ?: sessionJson
                """{"resp":"ok","has_more":false,"sessions":$selectedJson}"""
            }
            "get_model_catalog" -> """{"resp":"ok"}"""
            else -> error("Unexpected command ${command.cmd}")
        }
        return RelayJson.decodeFromString(deserializer, json)
    }
}

private class CachedDeviceStoreFactory(
    private val transport: FakeDeviceTransport,
    private val sessions: MemoryDirectorySessions,
    private val workspaces: MemoryDirectoryWorkspaces,
) : DeviceStoreFactory {
    private val persistence = MobilePersistenceStores(
        drafts = NoOpDirectoryDrafts,
        chats = NoOpDirectoryChats,
        remoteSessions = sessions,
        remoteWorkspaces = workspaces,
    )

    override fun createSessionStore(scope: CoroutineScope, deviceId: String): RemoteSessionStore =
        RemoteSessionStore.create(scope, transport, deviceId, persistence)

    override fun createWorkspaceStore(scope: CoroutineScope, deviceId: String): RemoteWorkspaceStore =
        RemoteWorkspaceStore.create(scope, transport, Dispatchers.Unconfined, deviceId, workspaces)
}

private class MemoryDirectorySessions : RemoteSessionListStore {
    val byDevice = mutableMapOf<String, List<PersistedRemoteSession>>()
    override fun load(deviceKey: String): List<PersistedRemoteSession> = byDevice[deviceKey].orEmpty()
    override fun save(deviceKey: String, sessions: List<PersistedRemoteSession>, hasMore: Boolean) {
        byDevice[deviceKey] = sessions
    }
    override fun hasMore(deviceKey: String): Boolean = false
}

private class MemoryDirectoryWorkspaces : RemoteWorkspaceListStore {
    val byDevice = mutableMapOf<String, List<PersistedRemoteWorkspace>>()
    override fun load(deviceKey: String): List<PersistedRemoteWorkspace> = byDevice[deviceKey].orEmpty()
    override fun save(deviceKey: String, workspaces: List<PersistedRemoteWorkspace>) {
        byDevice[deviceKey] = workspaces
    }
}

private object NoOpDirectoryDrafts : DraftStore {
    override fun load(draftId: String): String? = null
    override fun save(draftId: String, text: String) = Unit
    override fun delete(draftId: String) = Unit
}

private object NoOpDirectoryChats : ChatLocalStore {
    override fun listSessions(agentType: String): List<PersistedChatSession> = emptyList()
    override fun loadSession(sessionId: String): PersistedChatSession? = null
    override fun loadMessages(sessionId: String): List<PersistedChatMessage> = emptyList()
    override fun saveSession(session: PersistedChatSession) = Unit
    override fun saveMessage(message: PersistedChatMessage) = Unit
    override fun pinSession(agentType: String, sessionId: String, pinned: Boolean) = Unit
    override fun setSessionStatus(sessionId: String, status: String) = Unit
    override fun deleteSession(sessionId: String) = Unit
}
