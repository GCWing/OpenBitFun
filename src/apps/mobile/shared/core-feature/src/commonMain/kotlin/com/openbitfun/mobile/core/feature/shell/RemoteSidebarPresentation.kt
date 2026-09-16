package com.openbitfun.mobile.core.feature.shell

import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.identity
import com.openbitfun.mobile.core.domain.belongsTo
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import com.openbitfun.mobile.core.feature.workspace.projectWorkspaceCatalog

/** One remote session with only the facts the unified sidebar renders. */
public data class RemoteSidebarSessionRow public constructor(
    public val id: String,
    public val title: String,
    public val agentType: String,
)

/** One remote workspace and the sessions filed under it in the sidebar tree. */
public data class RemoteSidebarWorkspaceRow public constructor(
    public val path: String,
    public val name: String,
    public val selected: Boolean,
    public val sessions: List<RemoteSidebarSessionRow>,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
) {
    public val key: String get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost).key
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
    ): List<RemoteSidebarWorkspaceRow> {
        if (workspaceState == null) return emptyList()
        val selected = workspaceState.selected
        val workspaceRows = (workspaceState.catalog ?: projectWorkspaceCatalog(
            workspaceState.workspaces, workspaceState.assistants,
        )).workspaces
        return workspaceRows.map { workspace ->
            val path = workspace.path
            val connectionId = workspace.remoteConnectionId
            RemoteSidebarWorkspaceRow(
                path = path,
                name = workspace.name,
                selected = selected != null && workspace.identity().matches(
                    RemoteWorkspaceIdentity(selected.path, selected.remoteConnectionId, selected.remoteSshHost)),
                remoteConnectionId = connectionId,
                remoteSshHost = workspace.remoteSshHost,
                sessions = sessions
                    .filter { it.belongsTo(workspace.identity(), workspaceRows.map { row -> row.identity() }) }
                    .map { session ->
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
