package com.openbitfun.mobile.core.feature.directory

import com.openbitfun.mobile.core.persistence.PersistedRemoteSession
import com.openbitfun.mobile.core.persistence.PersistedWorkspaceIdentity
import com.openbitfun.mobile.core.protocol.RelayJson
import kotlinx.serialization.encodeToString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorkspaceSessionPersistenceTest {
    @Test
    fun legacyRecordsRemainReadableWithoutInventingLocalOwnership() {
        val legacy = RelayJson.decodeFromString<PersistedRemoteSession>(
            """{"sessionId":"old","workspacePath":"/repo","workspaceName":"Project","pendingConfirmed":true}""",
        )
        assertNull(legacy.workspaceIdentity)
        val restored = RelayJson.decodeFromString<PersistedRemoteSession>(RelayJson.encodeToString(legacy))
        assertEquals(legacy, restored)
    }

    @Test
    fun explicitLocalAndSshIdentitySurviveCacheRoundTrip() {
        for (identity in listOf(PersistedWorkspaceIdentity("/repo"), PersistedWorkspaceIdentity("/repo", "ssh", "host"))) {
            val session = PersistedRemoteSession(sessionId = "s", workspacePath = "/repo", workspaceIdentity = identity)
            assertEquals(session, RelayJson.decodeFromString<PersistedRemoteSession>(RelayJson.encodeToString(session)))
        }
    }
}
