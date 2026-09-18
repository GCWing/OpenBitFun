package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.domain.WorkspaceAssistant
import com.openbitfun.mobile.core.protocol.RecentWorkspaceListResponse
import com.openbitfun.mobile.core.protocol.RelayJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WorkspaceCatalogTest {
    @Test
    fun legacyLocalMarkersFollowKindAndRealLocalhostSshIsPreserved() {
        val response = decode("""{"workspaces":[
            {"path":"/local","workspace_kind":"normal","remote_ssh_host":"localhost"},
            {"path":"/remote","workspace_kind":"remote","remote_ssh_host":"localhost","remote_connection_id":"saved"}
        ]}""")
        val catalog = response.sidebarCatalog(emptyList())
        assertNull(catalog.workspaces[0].remoteSshHost)
        assertNull(catalog.recentWorkspaces[0].remoteSshHost)
        assertEquals("localhost", catalog.workspaces[1].remoteSshHost)
        assertEquals("saved", catalog.workspaces[1].remoteConnectionId)
    }

    private val assistants = listOf(WorkspaceAssistant("/assistant", "My assistant", "a"))

    @Test
    fun authoritativeEmptyDoesNotLeakHistoryOrAssistantsAndSurvivesRoundTrip() {
        val response = decode("""{"workspaces":[{"path":"/closed"}],"opened_workspaces":[]}""")
        val roundTrip = decode(RelayJson.encodeToString(RecentWorkspaceListResponse.serializer(), response))
        val catalog = roundTrip.sidebarCatalog(assistants)
        assertEquals(WorkspaceCatalogSource.OPENED, catalog.source)
        assertTrue(catalog.workspaces.isEmpty())
        assertEquals("/closed", roundTrip.workspaces.single().path)
        assertEquals("/closed", catalog.recentWorkspaces.single().path)
    }

    @Test
    fun oldHostPayloadSelectsExplicitRecentFallback() {
        for (wire in listOf("""{"workspaces":[{"path":"/history"}]}""",
            """{"workspaces":[{"path":"/history"}],"opened_workspaces":null}""")) {
            val response = decode(wire)
            assertNull(response.openedWorkspaces)
            val catalog = response.sidebarCatalog(assistants)
            assertEquals(WorkspaceCatalogSource.RECENT, catalog.source)
            assertEquals(listOf("/assistant", "/history"), catalog.workspaces.map { it.path })
        }
    }

    @Test
    fun openedMembershipAndHostIdentityWinWhileLocalAssistantNamesAreEnriched() {
        val response = decode("""{"workspaces":[{"path":"/closed"}],"opened_workspaces":[
            {"path":"/assistant","name":"folder"},
            {"path":"/assistant","name":"SSH","remote_connection_id":"ssh-a","remote_ssh_host":"host"},
            {"path":"/assistant","name":"SSH B","remote_connection_id":"ssh-b","remote_ssh_host":"host"},
            {"path":"/assistant","name":"duplicate"},
            {"path":""}] }""")
        val catalog = response.sidebarCatalog(assistants)
        assertEquals(listOf("My assistant", "SSH", "SSH B"), catalog.workspaces.map { it.name })
        assertEquals("assistant", catalog.workspaces.first().kind)
        assertEquals(listOf(null, "ssh-a", "ssh-b"), catalog.workspaces.map { it.remoteConnectionId })
    }

    @Test
    fun idsSurviveWireRoundTripAndSamePathCatalogRows() {
        val response = decode("""{"workspaces":[],"opened_workspaces":[
            {"workspace_id":"local-id","path":"/shared","name":"Local","workspace_kind":"normal","remote_ssh_host":"localhost"},
            {"workspace_id":"remote-id","path":"/shared","name":"Remote","workspace_kind":"remote","remote_ssh_host":"localhost","remote_connection_id":"ssh"}
        ]}""")
        val catalog = response.sidebarCatalog(emptyList())
        assertEquals(listOf("local-id", "remote-id"), catalog.workspaces.map { it.workspaceId })
        assertNull(catalog.workspaces[0].remoteSshHost)
        assertEquals("localhost", catalog.workspaces[1].remoteSshHost)
    }

    private fun decode(wire: String): RecentWorkspaceListResponse = RelayJson.decodeFromString(wire)
}
