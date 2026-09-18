package com.openbitfun.mobile.core.persistence

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.openbitfun.mobile.core.persistence.db.MobileDatabase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class RemotePersistenceStoreTest {
    @Test fun workspaceHostSurvivesCacheRoundTripAndLegacyRecords() {
        val legacy = Json.decodeFromString<PersistedRemoteWorkspace>("""{"path":"/app","name":"App"}""")
        assertEquals(null, legacy.remoteSshHost)
        val remote = legacy.copy(remoteSshHost = "10.0.0.8")
        assertEquals(remote, Json.decodeFromString<PersistedRemoteWorkspace>(Json.encodeToString(remote)))
    }

    private suspend fun stores(): Pair<RemoteSessionListStore, RemoteTranscriptStore> {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        MobileDatabase.Schema.create(driver).await()
        return SqlDelightRemoteSessionListStore(driver) to SqlDelightRemoteTranscriptStore(driver)
    }

    @Test
    fun roundTripsSessionListAndTranscriptInSequenceOrder() = runTest {
        val (sessions, transcript) = stores()
        sessions.save("device-a", listOf(session("s1", "2026-01-01")), hasMore = true)
        assertEquals("s1", sessions.load("device-a").single().sessionId)
        assertTrue(sessions.hasMore("device-a"))
        transcript.append("device-a", "s1", 0, listOf(message("m0", "zero"), message("m1", "one")))
        assertEquals(listOf("zero", "one"), transcript.load("device-a", "s1").map { it.text })
    }

    @Test
    fun pendingConfirmedMarkerRoundTripsAndLegacySerializationRemainsCompatible() = runTest {
        val (sessions, _) = stores()
        sessions.save(
            "device-a",
            listOf(session("pending", "2026-01-01").copy(pendingConfirmed = true)),
        )
        assertTrue(sessions.load("device-a").single().pendingConfirmed)

        val legacyPayload = """{"sessionId":"legacy","title":"Legacy"}"""
        val decoded = Json.decodeFromString<PersistedRemoteSession>(legacyPayload)
        assertEquals(false, decoded.pendingConfirmed)
        val currentPayload = Json.encodeToString(decoded)
        val redecoded = Json.decodeFromString<PersistedRemoteSession>(currentPayload)
        assertEquals(decoded, redecoded)
        assertEquals(false, redecoded.pendingConfirmed)
    }

    @Test
    fun migratesV3RemoteSessionRowToV4AndCurrentStoreCanLoadAndSaveIt() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.execute(
            identifier = null,
            sql = """
                CREATE TABLE remote_session_list (
                    device_key TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    agent_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    message_count INTEGER NOT NULL,
                    last_message_id TEXT NOT NULL,
                    workspace_path TEXT,
                    workspace_name TEXT,
                    has_more INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (device_key, session_id)
                )
            """.trimIndent(),
            parameters = 0,
        ).await()
        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO remote_session_list(
                    device_key, session_id, title, agent_type, status, updated_at, created_at,
                    message_count, last_message_id, workspace_path, workspace_name, has_more
                ) VALUES (
                    'device-v3', 'session-v3', 'Legacy title', 'remote', 'ready',
                    '2026-02-03', '2026-01-02', 7, 'message-7', '/legacy/workspace', 'Legacy workspace', 1
                )
            """.trimIndent(),
            parameters = 0,
        ).await()

        // The current store reads the v7 identity columns, so the v3 row has to be
        // carried through every migration up to the current version.
        MobileDatabase.Schema.migrate(driver, 3, MobileDatabase.Schema.version).await()
        val migratedPendingValue = driver.executeQuery(
            identifier = null,
            sql = "SELECT pending_confirmed FROM remote_session_list WHERE session_id = 'session-v3'",
            mapper = { cursor ->
                check(cursor.next().value)
                QueryResult.Value(cursor.getLong(0))
            },
            parameters = 0,
        ).await()
        assertEquals(0L, migratedPendingValue)

        val sessions = SqlDelightRemoteSessionListStore(driver)
        val migrated = sessions.load("device-v3").single()
        assertEquals("session-v3", migrated.sessionId)
        assertEquals("Legacy title", migrated.title)
        assertEquals("remote", migrated.agentType)
        assertEquals("ready", migrated.status)
        assertEquals("2026-02-03", migrated.updatedAt)
        assertEquals("2026-01-02", migrated.createdAt)
        assertEquals(7, migrated.messageCount)
        assertEquals("message-7", migrated.lastMessageId)
        assertEquals("/legacy/workspace", migrated.workspacePath)
        assertEquals("Legacy workspace", migrated.workspaceName)
        assertEquals(false, migrated.pendingConfirmed)
        assertTrue(sessions.hasMore("device-v3"))

        sessions.save(
            "device-v3",
            listOf(migrated.copy(title = "Current title", pendingConfirmed = true)),
        )
        assertEquals(
            migrated.copy(title = "Current title", pendingConfirmed = true),
            sessions.load("device-v3").single(),
        )
    }

    @Test
    fun emptyServerListClearsCachedSessionsOnColdStart() = runTest {
        val (sessions, _) = stores()
        sessions.save("device-a", listOf(session("s1", "2026-01-01")), hasMore = true)
        assertTrue(sessions.load("device-a").isNotEmpty())
        sessions.save("device-a", emptyList())
        assertTrue(sessions.load("device-a").isEmpty())
        assertEquals(false, sessions.hasMore("device-a"))
    }

    @Test
    fun appendIsIdempotentWhenRetried() = runTest {
        val (_, transcript) = stores()
        val value = listOf(message("m0", "zero"))
        transcript.append("device-a", "s1", 0, value)
        transcript.append("device-a", "s1", 0, value)
        assertEquals(listOf("m0"), transcript.load("device-a", "s1").map { it.messageId })
    }

    @Test
    fun legacyAndCorruptPayloadsRemainOpaqueAndRetained() = runTest {
        val (_, transcript) = stores()
        transcript.replace("device-a", "s1", listOf(message("legacy", "column text").copy(payloadJson = "{}")))
        transcript.append("device-a", "s1", 1, listOf(message("broken", "safe text").copy(payloadJson = "not-json")))
        assertEquals(listOf("column text", "safe text"), transcript.load("device-a", "s1").map { it.text })
        assertEquals(listOf("legacy", "broken"), transcript.load("device-a", "s1").map { it.messageId })
        assertEquals(listOf("{}", "not-json"), transcript.load("device-a", "s1").map { it.payloadJson })
    }

    @Test
    fun sessionListPrunesOldestPerDevice() = runTest {
        val (sessions, _) = stores()
        sessions.save("device-a", (60 downTo 0).map { session("s$it", "%04d".format(it)) })
        assertEquals(60, sessions.load("device-a").size)
        assertTrue(sessions.load("device-a").none { it.sessionId == "s0" })
    }

    @Test
    fun cursorRoundTripsPollAndCatalogVersions() = runTest {
        val (_, transcript) = stores()
        transcript.saveCursor("device-a", "s1", PersistedRemoteCursor("poll-7", 12, "models-3"))
        assertEquals(PersistedRemoteCursor("poll-7", 12, "models-3"), transcript.loadCursor("device-a", "s1"))
    }

    @Test
    fun sessionListRewriteObservesTitleOnlyChanges() = runTest {
        val (sessions, _) = stores()
        val original = session("s1", "2026-01-01")
        sessions.save("device-a", listOf(original))
        sessions.save("device-a", listOf(original.copy(title = "Renamed")))
        assertEquals("Renamed", sessions.load("device-a").single().title)
    }

    @Test
    fun deletingTranscriptAlsoDeletesItsCursorAndResidentCopy() = runTest {
        val (_, transcript) = stores()
        transcript.replace("device-a", "s1", listOf(message("m0", "cached")))
        transcript.saveCursor("device-a", "s1", PersistedRemoteCursor("poll-7", 1, "models-3"))
        assertEquals(1, transcript.load("device-a", "s1").size)

        transcript.delete("device-a", "s1")

        assertTrue(transcript.load("device-a", "s1").isEmpty())
        assertEquals(null, transcript.loadCursor("device-a", "s1"))
    }

    @Test
    fun workspaceCatalogRoundTripsInOrderAndRemainsDeviceScoped() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        MobileDatabase.Schema.create(driver).await()
        val workspaces = SqlDelightRemoteWorkspaceListStore(driver)
        workspaces.save(
            "device-a",
            listOf(
                PersistedRemoteWorkspace("/repo", "Repo", "today", "local"),
                PersistedRemoteWorkspace("/assistant", "Assistant", "", "assistant"),
            ),
        )
        workspaces.save("device-b", listOf(PersistedRemoteWorkspace("/other", "Other")))

        assertEquals(listOf("/repo", "/assistant"), workspaces.load("device-a").map { it.path })
        assertEquals(listOf("/other"), workspaces.load("device-b").map { it.path })
    }

    @Test
    fun migratesV4DatabaseWithAnEmptyWorkspaceCache() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        // Build the v4 schema the way a device did (v2 created the remote session
        // tables), then carry it through every later migration: the v5 workspace
        // cache is created empty and the v7 identity columns the current store
        // reads are added on top.
        MobileDatabase.Schema.migrate(driver, 2, 4).await()
        MobileDatabase.Schema.migrate(driver, 4, MobileDatabase.Schema.version).await()
        val workspaces = SqlDelightRemoteWorkspaceListStore(driver)
        assertTrue(workspaces.load("device-a").isEmpty())
        workspaces.save("device-a", listOf(PersistedRemoteWorkspace("/repo", "Repo")))
        assertEquals("/repo", workspaces.load("device-a").single().path)
    }

    /**
     * v5 introduced replica tables holding decrypted relay stream fragments.
     * Streams are now read on demand from the online host, so upgrading a v7
     * device removes those copies while every other cache survives.
     */
    @Test
    fun migratingAV7DatabaseDropsTheRelayStreamReplicaAndKeepsOtherCaches() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        MobileDatabase.Schema.migrate(driver, 2, 7).await()
        driver.execute(null, "INSERT INTO relay_stream_cursor(stream, seq) VALUES ('account:session:s1', 9)", 0).await()
        driver.execute(null, "INSERT INTO relay_stream_fragment(stream, event_id, part_index, content) VALUES ('account:session:s1', 'e1', 0, 'secret')", 0).await()
        val workspaces = SqlDelightRemoteWorkspaceListStore(driver)
        workspaces.save("device-a", listOf(PersistedRemoteWorkspace("/repo", "Repo")))

        MobileDatabase.Schema.migrate(driver, 7, MobileDatabase.Schema.version).await()
        val replicaTables = driver.executeQuery(
            identifier = null,
            sql = "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('relay_stream_cursor', 'relay_stream_fragment')",
            mapper = { cursor ->
                check(cursor.next().value)
                QueryResult.Value(cursor.getLong(0))
            },
            parameters = 0,
        ).await()
        assertEquals(0L, replicaTables)
        assertEquals("/repo", workspaces.load("device-a").single().path)
        // A fresh install never has the tables either.
        val fresh = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        MobileDatabase.Schema.create(fresh).await()
        val freshTables = fresh.executeQuery(
            identifier = null,
            sql = "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'relay_stream_%'",
            mapper = { cursor -> check(cursor.next().value); QueryResult.Value(cursor.getLong(0)) },
            parameters = 0,
        ).await()
        assertEquals(0L, freshTables)
    }

    @Test
    fun workspaceIdentityColumnsRoundTripAndSamePathRowsCoexist() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        MobileDatabase.Schema.create(driver).await()
        val workspaces = SqlDelightRemoteWorkspaceListStore(driver)
        val local = PersistedRemoteWorkspace("/repo", "Repo", "today", "normal", workspaceId = "local-id")
        val ssh = PersistedRemoteWorkspace("/repo", "Repo", "today", "remote", "host", "saved", "ssh-id")
        val legacyLocal = PersistedRemoteWorkspace("/repo", "Old", "", "normal")
        val legacySsh = PersistedRemoteWorkspace("/repo", "Old SSH", "", "remote", "host", "saved")
        workspaces.save("device-a", listOf(local, ssh, legacyLocal, legacySsh, local.copy(name = "Duplicate")))
        val loaded = workspaces.load("device-a")
        assertEquals(listOf(local, ssh, legacyLocal, legacySsh), loaded, "IDs dedupe, the same path with a different identity does not")
        assertEquals(listOf("local-id", "ssh-id", null, null), loaded.map { it.workspaceId })
        assertEquals(listOf(null, "saved", null, "saved"), loaded.map { it.remoteConnectionId })
        assertEquals(listOf(null, "host", null, "host"), loaded.map { it.remoteSshHost })
        assertTrue(local.key != ssh.key && legacyLocal.key != legacySsh.key && local.key != legacyLocal.key)
        assertEquals(local.key, local.copy(path = "/elsewhere", name = "Renamed").key, "an ID row keeps its identity when its projection changes")
    }

    @Test
    fun sessionWorkspaceIdentityRoundTripsIncludingExplicitLocalOwnership() = runTest {
        val (sessions, _) = stores()
        val rows = listOf(
            session("legacy", "2026-01-04"),
            session("local", "2026-01-03").copy(workspacePath = "/repo", workspaceIdentity = PersistedWorkspaceIdentity("/repo")),
            session("ssh", "2026-01-02").copy(workspacePath = "/repo", workspaceIdentity = PersistedWorkspaceIdentity("/repo", "saved", "host")),
            session("id", "2026-01-01").copy(workspacePath = "/moved", workspaceIdentity = PersistedWorkspaceIdentity("/repo", null, null, "ws-1")),
        )
        sessions.save("device-a", rows)
        assertEquals(rows, sessions.load("device-a"))
        // Identity-only edits must not be swallowed by the rewrite signature.
        sessions.save("device-a", rows.map { if (it.sessionId == "legacy") it.copy(workspaceIdentity = PersistedWorkspaceIdentity("/repo", null, null, "ws-2")) else it })
        assertEquals("ws-2", sessions.load("device-a").first { it.sessionId == "legacy" }.workspaceIdentity?.workspaceId)
    }

    @Test
    fun migratesV6RowsWithoutIdentityAsLegacyAndKeepsSamePathWorkspaces() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        // The remote tables are entirely created by migrations 2..5, so replaying
        // them yields the exact v6 shape an upgrading install carries.
        MobileDatabase.Schema.migrate(driver, 2, 6).await()
        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO remote_session_list(device_key, session_id, title, agent_type, status, updated_at, created_at,
                    message_count, last_message_id, workspace_path, workspace_name, has_more, pending_confirmed)
                VALUES ('device-v6', 'session-v6', 'Old', 'code', 'idle', '2026-02-03', '2026-01-02', 1, 'm1', '/repo', 'Repo', 0, 0)
            """.trimIndent(),
            parameters = 0,
        ).await()
        driver.execute(
            identifier = null,
            sql = """
                INSERT INTO remote_workspace_list(device_key, path, name, last_opened, workspace_kind, seq)
                VALUES ('device-v6', '/repo', 'Repo', 'yesterday', 'normal', 1), ('device-v6', '/assistant', 'Assistant', '', 'assistant', 0)
            """.trimIndent(),
            parameters = 0,
        ).await()

        MobileDatabase.Schema.migrate(driver, 6, 7).await()

        val sessions = SqlDelightRemoteSessionListStore(driver)
        val legacySession = sessions.load("device-v6").single()
        assertEquals("session-v6", legacySession.sessionId)
        assertEquals("/repo", legacySession.workspacePath)
        assertEquals(null, legacySession.workspaceIdentity, "pre-identity rows stay legacy; ownership is resolved by the reader")

        val workspaces = SqlDelightRemoteWorkspaceListStore(driver)
        val legacyRows = workspaces.load("device-v6")
        assertEquals(listOf("/assistant", "/repo"), legacyRows.map { it.path }, "original order survives the table rebuild")
        assertTrue(legacyRows.all { it.workspaceId == null && it.remoteConnectionId == null && it.remoteSshHost == null })

        // The rebuilt table accepts what the old primary key forbade.
        workspaces.save("device-v6", legacyRows + listOf(
            PersistedRemoteWorkspace("/repo", "Repo", "today", "remote", "host", "saved", "ssh-id"),
            PersistedRemoteWorkspace("/repo", "Repo", "today", "normal", workspaceId = "local-id"),
        ))
        assertEquals(listOf(null, null, "ssh-id", "local-id"), workspaces.load("device-v6").map { it.workspaceId })
        sessions.save("device-v6", listOf(legacySession.copy(workspaceIdentity = PersistedWorkspaceIdentity("/repo", null, null, "local-id"))))
        assertEquals("local-id", sessions.load("device-v6").single().workspaceIdentity?.workspaceId)
    }

    private fun session(id: String, updated: String) = PersistedRemoteSession(
        sessionId = id, title = "Title $id", agentType = "remote", status = "ready",
        updatedAt = updated, createdAt = updated, messageCount = 1, lastMessageId = "m0",
    )

    private fun message(id: String, text: String) = PersistedRemoteMessage(
        messageId = id, sessionId = "s1", role = "assistant", text = text,
        status = "completed", timestamp = id, thinking = null, payloadJson = "{}",
    )
}
