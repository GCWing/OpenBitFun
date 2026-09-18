package com.openbitfun.mobile.core.feature.shell

import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.SelectedWorkspace
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionAgentFilter
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryEntry
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryStatus
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteFilePreviewUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RemoteSidebarPresentationTest {
    @Test
    fun selectionDoesNotReorderOrRenameHostCatalog() {
        val rows = RemoteSidebarPresentation.workspaces(
            workspaceState = workspaceReady(
                selected = selected("/repo/b", "Beta"),
                recent = listOf(
                    recent("/repo/a", "Alpha"),
                    recent("/repo/b", "Old Beta"),
                ),
            ),
            sessionState = sessionReady(
                listOf(
                    session("b-1", "/repo/b", "code"),
                    session("a-1", "/repo/a", "chat"),
                ),
            ),
        )

        assertEquals(listOf("/repo/a", "/repo/b"), rows.map { it.path })
        assertEquals("Old Beta", rows.last().name)
        assertTrue(rows.last().selected)
        assertEquals(listOf("b-1"), rows.last().sessions.map { it.id })
        assertEquals(listOf("a-1"), rows.first().sessions.map { it.id })
    }

    @Test
    fun selectedWorkspaceAndLegacySessionsCannotCreateCatalogRows() {
        val rows = RemoteSidebarPresentation.workspaces(
            workspaceState = workspaceReady(selected("/repo/current", "Current"), emptyList()),
            sessionState = sessionReady(listOf(session("legacy", null, "assistant"))),
        )

        assertTrue(rows.isEmpty())
    }

    @Test
    fun sharedNativeProjectionDistinguishesHostsAndHonorsEmptyOpenedCatalog() {
        val a = recent("/repo", "A").copy(remoteConnectionId = "saved", remoteSshHost = "host-a")
        val b = a.copy(name = "B", remoteSshHost = "host-b")
        val ready = workspaceReady(selected("/repo", "Selected").copy(remoteConnectionId = "saved", remoteSshHost = "host-b"), listOf(a, b))
        val sessions = listOf(
            session("a", "/repo", "code").copy(workspaceIdentity = com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity("/repo", "saved", "host-a")),
            session("b", "/repo", "code").copy(workspaceIdentity = com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity("/repo", "saved", "host-b")),
            session("legacy", "/repo", "code"),
        )
        val rows = RemoteSidebarPresentation.workspacesForSessions(ready, sessions)
        assertEquals(listOf(false, true), rows.map { it.selected })
        assertEquals(listOf(listOf("a"), listOf("b")), rows.map { it.sessions.map { row -> row.id } })
        val empty = ready.copy(catalog = com.openbitfun.mobile.core.feature.workspace.WorkspaceCatalogUiState(
            emptyList(), com.openbitfun.mobile.core.feature.workspace.WorkspaceCatalogSource.OPENED))
        assertTrue(RemoteSidebarPresentation.workspacesForSessions(empty, sessions).isEmpty())
    }

    @Test
    fun undisclosedBranchesReadAsUnaskedRatherThanEmpty() {
        // `list_sessions` answers for the selected workspace only, so a branch
        // nobody expanded has no rows for a reason the reader has to be told.
        val rows = RemoteSidebarPresentation.workspacesWithDirectory(
            workspaceState = workspaceReady(
                selected = selected("/repo/b", "Beta"),
                recent = listOf(recent("/repo/a", "Alpha"), recent("/repo/b", "Beta")),
            ),
            sessionState = sessionReady(listOf(session("b-1", "/repo/b", "code"))),
            directory = WorkspaceSessionDirectoryUiState(emptyList()),
        )

        assertEquals(RemoteSidebarWorkspaceLoad.IDLE, rows.first().load)
        assertTrue(rows.first().sessions.isEmpty())
        // The selected branch is the one that was asked about; it is not IDLE.
        assertEquals(RemoteSidebarWorkspaceLoad.READY, rows.last().load)
        assertEquals(listOf("b-1"), rows.last().sessions.map { it.id })
    }

    @Test
    fun disclosedBranchTakesItsRowsAndStatusFromTheDirectory() {
        val workspace = workspaceReady(
            selected = selected("/repo/b", "Beta"),
            recent = listOf(recent("/repo/a", "Alpha"), recent("/repo/b", "Beta")),
        )
        val sessions = sessionReady(listOf(session("b-1", "/repo/b", "code")))

        val loading = RemoteSidebarPresentation.workspacesWithDirectory(
            workspace, sessions,
            directory(entry("/repo/a", WorkspaceSessionDirectoryStatus.LOADING, emptyList())),
        )
        assertEquals(RemoteSidebarWorkspaceLoad.LOADING, loading.first().load)

        val ready = RemoteSidebarPresentation.workspacesWithDirectory(
            workspace, sessions,
            directory(entry("/repo/a", WorkspaceSessionDirectoryStatus.READY, listOf(session("a-1", "/repo/a", "chat")))),
        )
        assertEquals(RemoteSidebarWorkspaceLoad.READY, ready.first().load)
        assertEquals(listOf("a-1"), ready.first().sessions.map { it.id })

        val failed = RemoteSidebarPresentation.workspacesWithDirectory(
            workspace, sessions,
            directory(entry("/repo/a", WorkspaceSessionDirectoryStatus.FAILED, emptyList())),
        )
        assertEquals(RemoteSidebarWorkspaceLoad.FAILED, failed.first().load)
    }

    @Test
    fun directoryRowsDoNotLeakAcrossHostsSharingAPath() {
        val a = recent("/repo", "A").copy(remoteConnectionId = "saved", remoteSshHost = "host-a")
        val b = a.copy(name = "B", remoteSshHost = "host-b")
        val ready = workspaceReady(
            selected("/repo", "Selected").copy(remoteConnectionId = "saved", remoteSshHost = "host-b"),
            listOf(a, b),
        )
        val rows = RemoteSidebarPresentation.workspacesWithDirectory(
            ready, sessionReady(emptyList()),
            directory(
                entry("/repo", WorkspaceSessionDirectoryStatus.READY, listOf(session("a-1", "/repo", "code")))
                    .copy(remoteConnectionId = "saved", remoteSshHost = "host-a"),
            ),
        )

        assertEquals(listOf("a-1"), rows.first().sessions.map { it.id })
        assertEquals(RemoteSidebarWorkspaceLoad.READY, rows.first().load)
        // The other host shares the path but was never disclosed.
        assertEquals(RemoteSidebarWorkspaceLoad.READY, rows.last().load)
        assertTrue(rows.last().sessions.isEmpty())
    }

    @Test
    fun theDirectorylessProjectionStaysReady() {
        val rows = RemoteSidebarPresentation.workspaces(
            workspaceState = workspaceReady(selected("/repo/b", "Beta"), listOf(recent("/repo/a", "Alpha"))),
            sessionState = sessionReady(emptyList()),
        )

        assertEquals(listOf(RemoteSidebarWorkspaceLoad.READY), rows.map { it.load })
    }

    private fun directory(vararg entries: WorkspaceSessionDirectoryEntry) =
        WorkspaceSessionDirectoryUiState(entries.toList())

    private fun entry(
        path: String,
        status: WorkspaceSessionDirectoryStatus,
        sessions: List<RemoteSession>,
    ) = WorkspaceSessionDirectoryEntry(path, status, sessions, null, null)

    private fun workspaceReady(
        selected: SelectedWorkspace,
        recent: List<RecentWorkspace>,
    ) = RemoteWorkspaceUiState.Ready(
        workspaces = recent,
        assistants = emptyList(),
        selected = selected,
        preview = RemoteFilePreviewUiState.None,
        busy = false,
        download = com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState.None,
    )

    private fun sessionReady(sessions: List<RemoteSession>) = RemoteSessionUiState.Ready(
        sessions = sessions,
        selectedSessionId = null,
        timeline = null,
        busy = false,
        permissionMode = null,
        permissionModeFailure = null,
        query = "",
        agentFilter = SessionAgentFilter.ALL,
        hasMore = false,
        hasMoreMessages = false,
        modelCatalog = null,
    )

    private fun selected(path: String, name: String) = SelectedWorkspace(path, name, "main", "git", null)

    private fun recent(path: String, name: String) = RecentWorkspace(path, name, "", "git")

    private fun session(id: String, workspacePath: String?, agentType: String) = RemoteSession(
        id = id,
        title = id,
        agentType = agentType,
        status = "idle",
        updatedAt = "",
        createdAt = "",
        messageCount = 0,
        workspacePath = workspacePath,
        workspaceName = null,
    )
}
