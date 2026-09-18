package com.openbitfun.mobile.core.feature.shell

import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.identity
import com.openbitfun.mobile.core.domain.belongsTo
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryStatus
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import com.openbitfun.mobile.core.feature.workspace.projectWorkspaceCatalog

/** One remote session with only the facts the unified sidebar renders. */
public data class RemoteSidebarSessionRow public constructor(
    public val id: String,
    public val title: String,
    public val agentType: String,
)

/**
 * How far the sidebar has got in learning a workspace's own sessions.
 *
 * `list_sessions` answers for one workspace at a time, so only the selected
 * workspace's rows arrive with the session list. Every other branch stays
 * [IDLE] until it is expanded, and an empty [IDLE] branch means "not asked
 * yet", not "no sessions" — the difference the sidebar has to show.
 */
public enum class RemoteSidebarWorkspaceLoad {
    IDLE,
    LOADING,
    READY,
    FAILED,
}

/** One remote workspace and the sessions filed under it in the sidebar tree. */
public data class RemoteSidebarWorkspaceRow public constructor(
    public val path: String,
    public val name: String,
    public val selected: Boolean,
    public val sessions: List<RemoteSidebarSessionRow>,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
    public val workspaceId: String?,
    public val load: RemoteSidebarWorkspaceLoad = RemoteSidebarWorkspaceLoad.READY,
) {
    public val key: String get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId).key
    public constructor(path: String, name: String, selected: Boolean, sessions: List<RemoteSidebarSessionRow>, remoteConnectionId: String?, remoteSshHost: String?) : this(path, name, selected, sessions, remoteConnectionId, remoteSshHost, null)
    public constructor(path: String, name: String, selected: Boolean, sessions: List<RemoteSidebarSessionRow>, remoteConnectionId: String?) : this(path, name, selected, sessions, remoteConnectionId, null)
    public constructor(path: String, name: String, selected: Boolean, sessions: List<RemoteSidebarSessionRow>) : this(path, name, selected, sessions, null)
}

/** Platform-neutral projection for HarmonyOS' device/workspace/session hierarchy. */
public object RemoteSidebarPresentation {
    public fun workspaces(
        workspaceState: RemoteWorkspaceUiState.Ready?,
        sessionState: RemoteSessionUiState.Ready?,
    ): List<RemoteSidebarWorkspaceRow> = workspacesForSessions(workspaceState, sessionState?.sessions.orEmpty())

    public fun workspacesForSessions(
        workspaceState: RemoteWorkspaceUiState.Ready?,
        sessions: List<RemoteSession>,
    ): List<RemoteSidebarWorkspaceRow> = project(workspaceState, sessions, null)

    /**
     * The sidebar tree with each branch's own `list_sessions` result folded in.
     *
     * [sessions] only ever describes the selected workspace, so every other
     * branch takes its rows and its status from [directory], which is what
     * `RemoteSessionIntent.LoadWorkspaceSessions` fills in on expand.
     */
    public fun workspacesWithDirectory(
        workspaceState: RemoteWorkspaceUiState.Ready?,
        sessionState: RemoteSessionUiState.Ready?,
        directory: WorkspaceSessionDirectoryUiState?,
    ): List<RemoteSidebarWorkspaceRow> = project(workspaceState, sessionState?.sessions.orEmpty(), directory)

    /**
     * [workspacesWithDirectory] for a caller that already flattened its session
     * list, which is the shape iOS keeps its projection in.
     */
    public fun workspacesForSessionsWithDirectory(
        workspaceState: RemoteWorkspaceUiState.Ready?,
        sessions: List<RemoteSession>,
        directory: WorkspaceSessionDirectoryUiState?,
    ): List<RemoteSidebarWorkspaceRow> = project(workspaceState, sessions, directory)

    private fun project(
        workspaceState: RemoteWorkspaceUiState.Ready?,
        sessions: List<RemoteSession>,
        directory: WorkspaceSessionDirectoryUiState?,
    ): List<RemoteSidebarWorkspaceRow> {
        if (workspaceState == null) return emptyList()
        val selected = workspaceState.selected
        val workspaceRows = (workspaceState.catalog ?: projectWorkspaceCatalog(
            workspaceState.workspaces, workspaceState.assistants,
        )).workspaces
        val catalogIdentities = workspaceRows.map { row -> row.identity() }
        return workspaceRows.map { workspace ->
            val identity = workspace.identity()
            // ID-first: IDs decide when both sides carry one; a pre-ID row falls back to the legacy triple.
            val isSelected = selected != null && identity.sameWorkspace(selected.identity())
            val bucketed = sessions.filter { it.belongsTo(identity, catalogIdentities) }
            val branch = directory?.workspace(identity)
            // The selected workspace is the one `list_sessions` was asked about,
            // so its bucket is authoritative even before any branch was loaded.
            val load = when {
                directory == null || isSelected -> RemoteSidebarWorkspaceLoad.READY
                branch == null -> RemoteSidebarWorkspaceLoad.IDLE
                else -> when (branch.status) {
                    WorkspaceSessionDirectoryStatus.IDLE -> RemoteSidebarWorkspaceLoad.IDLE
                    WorkspaceSessionDirectoryStatus.LOADING -> RemoteSidebarWorkspaceLoad.LOADING
                    WorkspaceSessionDirectoryStatus.READY -> RemoteSidebarWorkspaceLoad.READY
                    WorkspaceSessionDirectoryStatus.FAILED -> RemoteSidebarWorkspaceLoad.FAILED
                }
            }
            val owned = if (!isSelected && branch != null && branch.sessions.isNotEmpty()) {
                branch.sessions
            } else {
                bucketed
            }
            RemoteSidebarWorkspaceRow(
                path = workspace.path,
                name = workspace.name,
                selected = isSelected,
                remoteConnectionId = workspace.remoteConnectionId,
                remoteSshHost = workspace.remoteSshHost,
                workspaceId = workspace.workspaceId,
                load = load,
                sessions = owned.map { session ->
                    RemoteSidebarSessionRow(
                        id = session.id,
                        title = session.title,
                        agentType = session.agentType,
                    )
                },
            )
        }
    }
}
