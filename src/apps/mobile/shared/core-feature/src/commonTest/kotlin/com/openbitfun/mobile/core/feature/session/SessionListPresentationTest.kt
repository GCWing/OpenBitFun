package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SessionListPresentationTest {
    private val now = 1_754_726_400_000L // 2025-08-09T08:00:00Z

    private val workspace = SessionWorkspaceContext(
        selectedPath = "/work/openbitfun",
        selectedName = "OpenBitFun",
        selectedKind = "normal",
        recent = listOf(
            RecentWorkspace(path = "/work/other", name = "Other", lastOpened = "", kind = "normal"),
            RecentWorkspace(path = "/work/chat", name = "Chat", lastOpened = "", kind = "assistant"),
        ),
    )

    private val defaults = SessionListOptions(
        groupMode = SessionGroupMode.PROJECT,
        query = "",
        workspaceFilter = "",
        agentFilter = null,
        statusFilter = "",
    )

    @Test
    fun archivedSessionsAreNotInTheListAtAll() {
        val view = SessionListPresentation.view(
            sessions = listOf(session("a"), session("b", status = "archived")),
            workspace = workspace,
            options = defaults,
            nowMs = now,
        )
        assertEquals(listOf("a"), view.sections.flatMap { it.sessions }.map { it.id })
        // Nothing was filtered by the user, so the empty-state copy must not
        // claim the filters hid anything.
        assertEquals(false, view.filtered)
    }

    @Test
    fun aSessionWithoutAPathJoinsTheWorkspaceWeAreLookingAt() {
        val view = SessionListPresentation.view(
            sessions = listOf(session("a", path = null)),
            workspace = workspace,
            options = defaults,
            nowMs = now,
        )
        val project = view.sections.filterIsInstance<SessionListSection.Project>()
            .first { it.path == "/work/openbitfun" }
        assertEquals(listOf("a"), project.sessions.map { it.id })
    }

    @Test
    fun aTrailingSlashIsNotADifferentProject() {
        val view = SessionListPresentation.view(
            sessions = listOf(session("a", path = "/work/other/")),
            workspace = workspace,
            options = defaults,
            nowMs = now,
        )
        val project = view.sections.filterIsInstance<SessionListSection.Project>()
            .first { it.path == "/work/other" }
        assertEquals(listOf("a"), project.sessions.map { it.id })
    }

    @Test
    fun chatSessionsMoveToTheTopInChatMode() {
        val sessions = listOf(session("code"), session("chat", agentType = "claw", path = null))
        val project = SessionListPresentation.view(sessions, workspace, defaults, now)
        val chatFirst = SessionListPresentation.view(
            sessions,
            workspace,
            defaults.copy(groupMode = SessionGroupMode.CHAT),
            now,
        )
        assertTrue(project.sections.first() is SessionListSection.Project)
        assertTrue(chatFirst.sections.first() is SessionListSection.Chat)
        // The chat session must not also appear under a project heading.
        assertEquals(
            1,
            chatFirst.sections.flatMap { it.sessions }.count { it.id == "chat" },
        )
    }

    @Test
    fun aSessionInAnAssistantWorkspaceIsAChatSessionWhateverItsAgentTypeSays() {
        val view = SessionListPresentation.view(
            sessions = listOf(session("a", agentType = "code", path = "/work/chat")),
            workspace = workspace,
            options = defaults,
            nowMs = now,
        )
        assertTrue(view.sections.any { it is SessionListSection.Chat })
        assertEquals(
            SessionAgentGroup.CHAT,
            SessionListPresentation.agentGroup(
                session("a", agentType = "code", path = "/work/chat"),
                workspace,
            ),
        )
    }

    @Test
    fun timeModeBucketsByCalendarDayNewestFirst() {
        val day = 24L * 60L * 60L * 1000L
        val view = SessionListPresentation.view(
            sessions = listOf(
                session("old", updatedAt = (now - 5L * day).toString()),
                session("now", updatedAt = now.toString()),
                session("yesterday", updatedAt = (now - day).toString()),
            ),
            workspace = workspace,
            options = defaults.copy(groupMode = SessionGroupMode.TIME),
            nowMs = now,
        )
        assertEquals(
            listOf("now", "yesterday", "old"),
            view.sections.flatMap { it.sessions }.map { it.id },
        )
        assertTrue(view.sections[0] is SessionListSection.Today)
        assertTrue(view.sections[1] is SessionListSection.Yesterday)
        assertTrue(view.sections[2] is SessionListSection.Earlier)
    }

    @Test
    fun anUnreadableUpdatedAtFallsBackToCreatedAt() {
        val view = SessionListPresentation.view(
            sessions = listOf(session("a", updatedAt = "", createdAt = now.toString())),
            workspace = workspace,
            options = defaults.copy(groupMode = SessionGroupMode.TIME),
            nowMs = now,
        )
        assertTrue(view.sections.single() is SessionListSection.Today)
    }

    @Test
    fun anEmptyProjectKeepsItsHeadingUntilAFilterIsOn() {
        val unfiltered = SessionListPresentation.view(emptyList(), workspace, defaults, now)
        assertEquals(
            listOf("/work/openbitfun", "/work/other"),
            unfiltered.sections.filterIsInstance<SessionListSection.Project>().map { it.path },
        )
        // The assistant workspace is never a project heading.
        assertTrue(unfiltered.sections.none { it is SessionListSection.Project && it.path == "/work/chat" })

        val filtered = SessionListPresentation.view(
            emptyList(),
            workspace,
            defaults.copy(query = "nothing"),
            now,
        )
        assertEquals(emptyList(), filtered.sections)
        assertEquals(true, filtered.filtered)
    }

    @Test
    fun eachFilterNarrowsOnItsOwnTerms() {
        val sessions = listOf(
            session("code", agentType = "code", status = "running"),
            session("cowork", agentType = "cowork", status = "idle", path = "/work/other"),
            session("chat", agentType = "chat", path = null),
        )
        fun ids(options: SessionListOptions) =
            SessionListPresentation.view(sessions, workspace, options, now)
                .sections.flatMap { it.sessions }.map { it.id }.sorted()

        assertEquals(listOf("cowork"), ids(defaults.copy(agentFilter = SessionAgentGroup.COWORK)))
        assertEquals(listOf("code"), ids(defaults.copy(statusFilter = "running")))
        assertEquals(listOf("cowork"), ids(defaults.copy(workspaceFilter = "/work/other")))
        // Title search is case-insensitive and matches anywhere in the title.
        assertEquals(listOf("cowork"), ids(defaults.copy(query = "  COWORK ")))
        // A chat session has no project, so filtering by the selected workspace
        // must not sweep it in.
        assertEquals(listOf("code"), ids(defaults.copy(workspaceFilter = "/work/openbitfun")))
    }

    @Test
    fun theOptionListsOnlyOfferWhatIsThere() {
        val sessions = listOf(
            session("a", agentType = "cowork", status = "Running"),
            session("b", agentType = "chat", status = "idle", path = null),
            session("c", agentType = "code", status = "", path = "/work/elsewhere"),
        )
        assertEquals(
            listOf(SessionAgentGroup.CHAT, SessionAgentGroup.CODE, SessionAgentGroup.COWORK),
            SessionListPresentation.agentGroups(sessions, workspace),
        )
        assertEquals(listOf("idle", "running"), SessionListPresentation.statusOptions(sessions))
        // A workspace only a session knows about is still offered, named after
        // its last path segment when the desktop sent no name.
        val options = SessionListPresentation.workspaceOptions(sessions, workspace)
        assertEquals(
            listOf("/work/openbitfun", "/work/other", "/work/chat", "/work/elsewhere"),
            options.map { it.path },
        )
        assertEquals("elsewhere", options.last().name)
    }

    @Test
    fun onlyTheStatusesWeHaveAWordForAreRenamed() {
        assertEquals(SessionStatusLabel.RUNNING, SessionListPresentation.statusLabel("Active"))
        assertEquals(SessionStatusLabel.RUNNING, SessionListPresentation.statusLabel("running"))
        assertEquals(SessionStatusLabel.READY, SessionListPresentation.statusLabel("idle"))
        assertEquals(SessionStatusLabel.ARCHIVED, SessionListPresentation.statusLabel("archived"))
        assertEquals(SessionStatusLabel.RAW, SessionListPresentation.statusLabel("compacting"))
    }

    @Test
    fun sectionsRevealSessionsThreeAtATime() {
        val sessions = (1..8).map { session(it.toString()) }

        val initial = SessionListPresentation.batch(sessions, revealedSteps = 0)
        assertEquals(listOf("1", "2", "3"), initial.visible.map { it.id })
        assertEquals(5, initial.remaining)
        assertEquals(3, initial.nextCount)

        val second = SessionListPresentation.batch(sessions, revealedSteps = 1)
        assertEquals(6, second.visible.size)
        assertEquals(2, second.remaining)
        assertEquals(2, second.nextCount)

        val complete = SessionListPresentation.batch(sessions, revealedSteps = 2)
        assertEquals(8, complete.visible.size)
        assertEquals(0, complete.remaining)
        assertEquals(0, complete.nextCount)
    }

    private val identityWorkspace = SessionWorkspaceContext(
        selectedPath = "/repo",
        selectedName = "Local",
        selectedKind = "normal",
        recent = listOf(
            RecentWorkspace("/repo", "Local", "", "normal", null, null, "ws-local"),
            RecentWorkspace("/repo", "SSH", "", "remote", "host", "saved-1", "ws-ssh"),
            RecentWorkspace("/repo", "Helper", "", "assistant", null, null, "ws-helper"),
        ),
        selectedWorkspaceId = "ws-local",
        selectedRemoteConnectionId = null,
        selectedRemoteSshHost = null,
    )

    @Test
    fun workspacesSharingAPathAreSeparateProjectsKeyedByWorkspaceId() {
        val sessions = listOf(
            session("local", path = "/repo", workspaceId = "ws-local"),
            session("ssh", path = "/repo", workspaceId = "ws-ssh"),
            session("gone", path = "/repo", workspaceId = "ws-gone"),
        )
        val view = SessionListPresentation.view(sessions, identityWorkspace, defaults, now)
        val projects = view.sections.filterIsInstance<SessionListSection.Project>()
        assertEquals(listOf("ws-local", "ws-ssh"), projects.map { it.workspaceId })
        assertEquals(listOf("/repo", "/repo"), projects.map { it.path }, "the path is display text only")
        assertTrue(projects[0].key != projects[1].key)
        assertEquals(listOf("local"), projects[0].sessions.map { it.id })
        assertEquals(listOf("ssh"), projects[1].sessions.map { it.id })
        // An ID the catalog does not know is filed nowhere; it must not land on a same-path row.
        assertTrue(view.sections.flatMap { it.sessions }.none { it.id == "gone" })
    }

    @Test
    fun aPreIdSessionResolvesThroughTheLegacyTripleAndAnAmbiguousRootIsFiledNowhere() {
        val sessions = listOf(
            session("by-connection", path = "/repo", remoteConnectionId = "saved-1"),
            session("bare-path", path = "/repo"),
        )
        val view = SessionListPresentation.view(sessions, identityWorkspace, defaults, now)
        val projects = view.sections.filterIsInstance<SessionListSection.Project>()
        assertEquals(listOf("by-connection"), projects.first { it.workspaceId == "ws-ssh" }.sessions.map { it.id })
        // "/repo" alone matches the local and the SSH row (the assistant row has kind assistant but
        // still shares the root), so nothing may be picked on the user's behalf.
        assertTrue(view.sections.flatMap { it.sessions }.none { it.id == "bare-path" })
    }

    @Test
    fun assistantDetectionUsesTheCatalogRowKindByIdNotThePath() {
        val helper = session("helper", agentType = "code", path = "/repo", workspaceId = "ws-helper")
        val project = session("project", agentType = "code", path = "/repo", workspaceId = "ws-local")
        assertEquals(SessionAgentGroup.CHAT, SessionListPresentation.agentGroup(helper, identityWorkspace))
        assertEquals(SessionAgentGroup.CODE, SessionListPresentation.agentGroup(project, identityWorkspace))
        val view = SessionListPresentation.view(listOf(helper, project), identityWorkspace, defaults, now)
        assertEquals(listOf("helper"), view.sections.filterIsInstance<SessionListSection.Chat>().single().sessions.map { it.id })
        assertTrue(view.sections.none { it is SessionListSection.Project && it.workspaceId == "ws-helper" })
    }

    @Test
    fun workspaceOptionsCarryIdsAndFiltersMatchByKeyWithLegacyPathFallback() {
        val sessions = listOf(
            session("local", path = "/repo", workspaceId = "ws-local"),
            session("ssh", path = "/repo", workspaceId = "ws-ssh"),
            session("stray", path = "/elsewhere"),
        )
        val options = SessionListPresentation.workspaceOptions(sessions, identityWorkspace)
        assertEquals(listOf("ws-local", "ws-ssh", "ws-helper", null), options.map { it.workspaceId })
        assertEquals(4, options.map { it.key }.toSet().size, "same-path rows are distinct options")
        fun ids(filter: String) = SessionListPresentation.view(sessions, identityWorkspace, defaults.copy(workspaceFilter = filter), now)
            .sections.flatMap { it.sessions }.map { it.id }.sorted()
        assertEquals(listOf("ssh"), ids(options.first { it.workspaceId == "ws-ssh" }.key))
        assertEquals(listOf("local"), ids(options.first { it.workspaceId == "ws-local" }.key))
        // A filter persisted as a bare path before IDs existed keeps matching by path.
        assertEquals(listOf("local", "ssh"), ids("/repo"))
    }

    private fun session(
        id: String,
        agentType: String = "code",
        status: String = "idle",
        updatedAt: String = "1754726400000",
        createdAt: String = "1754726400000",
        path: String? = "/work/openbitfun",
        workspaceId: String? = null,
        remoteConnectionId: String? = null,
    ) = if (workspaceId == null && remoteConnectionId == null) RemoteSession(
        id = id,
        title = id,
        agentType = agentType,
        status = status,
        updatedAt = updatedAt,
        createdAt = createdAt,
        messageCount = 0,
        workspacePath = path,
        workspaceName = null,
    ) else RemoteSession(
        id = id,
        title = id,
        agentType = agentType,
        status = status,
        updatedAt = updatedAt,
        createdAt = createdAt,
        messageCount = 0,
        workspacePath = path,
        workspaceName = null,
        workspaceIdentity = RemoteWorkspaceIdentity(path.orEmpty(), remoteConnectionId, null, workspaceId),
    )
}
