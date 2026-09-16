package com.openbitfun.mobile.core.domain

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertNotEquals

class RemoteWorkspaceIdentityTest {
    private val local = RemoteWorkspaceIdentity("/repo", null, null)
    private val ssh = RemoteWorkspaceIdentity("/repo", "saved", "host")
    private val legacy = RemoteSession("s", "Session", "code", "idle", "", "", 0, "/repo/", null)

    @Test
    fun onlyUnambiguousLocalCatalogCanAdoptAnOldUnscopedSession() {
        assertTrue(legacy.belongsTo(local, listOf(local)))
        assertFalse(legacy.belongsTo(ssh, listOf(ssh)))
        assertFalse(legacy.belongsTo(local, listOf(local, ssh)))
        assertFalse(legacy.copy(workspacePath = null).belongsTo(local, listOf(local)))
    }

    @Test
    fun explicitOwnershipSurvivesSamePathAcrossConnections() {
        val session = legacy.copy(workspaceIdentity = ssh)
        assertTrue(session.belongsTo(ssh, listOf(local, ssh)))
        assertFalse(session.belongsTo(local, listOf(local, ssh)))
        assertFalse(session.belongsTo(ssh.copy(remoteConnectionId = "other"), listOf(ssh)))
        assertTrue(ssh.matches(ssh.copy(path = "/repo/")))
    }

    @Test
    fun identityKeysCannotCollideAcrossEmbeddedSeparators() {
        assertNotEquals(RemoteWorkspaceIdentity("/c", "a:b", "c").key,
            RemoteWorkspaceIdentity("/c", "a", "b:c").key)
        assertNotEquals(RemoteWorkspaceIdentity("/", null, null).key,
            RemoteWorkspaceIdentity("", null, null).key)
    }
}
