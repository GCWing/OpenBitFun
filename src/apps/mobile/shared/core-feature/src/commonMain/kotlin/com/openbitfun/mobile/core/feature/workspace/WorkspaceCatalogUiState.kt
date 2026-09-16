package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.WorkspaceAssistant
import com.openbitfun.mobile.core.protocol.RecentWorkspaceListResponse

public enum class WorkspaceCatalogSource { OPENED, RECENT }

/** Sidebar membership is separate from the recent history offered by the picker. */
public data class WorkspaceCatalogUiState public constructor(
    public val workspaces: List<RecentWorkspace>,
    public val source: WorkspaceCatalogSource,
    public val recentWorkspaces: List<RecentWorkspace>,
) {
    public constructor(workspaces: List<RecentWorkspace>, source: WorkspaceCatalogSource) : this(workspaces, source, workspaces)
}

internal fun RecentWorkspaceListResponse.sidebarCatalog(
    assistants: List<WorkspaceAssistant>,
): WorkspaceCatalogUiState {
    val rows = (openedWorkspaces ?: workspaces).map { item ->
        RecentWorkspace(item.path.orEmpty(), item.name.orEmpty(), item.lastOpened,
            item.workspaceKind.orEmpty(), item.remoteSshHost, item.remoteConnectionId)
    }
    return projectWorkspaceCatalog(rows, assistants, openedWorkspaces != null).copy(recentWorkspaces = workspaces.map { item ->
        RecentWorkspace(item.path.orEmpty(), item.name.orEmpty(), item.lastOpened,
            item.workspaceKind.orEmpty(), item.remoteSshHost, item.remoteConnectionId)
    }.filter { it.path.isNotBlank() })
}

internal fun projectWorkspaceCatalog(
    rows: List<RecentWorkspace>,
    assistants: List<WorkspaceAssistant>,
    opened: Boolean = false,
): WorkspaceCatalogUiState {
    val candidates = if (opened) rows else assistants.map {
        RecentWorkspace(it.path, it.name, "", "assistant")
    } + rows
    return WorkspaceCatalogUiState(
        candidates.filter { it.path.isNotBlank() }.map { row ->
            val assistant = if (row.remoteConnectionId.isNullOrEmpty() && row.remoteSshHost.isNullOrEmpty()) {
                assistants.find { it.path == row.path && it.name.isNotBlank() }
            } else null
            when {
                assistant != null -> row.copy(name = assistant.name, kind = "assistant")
                row.name.isBlank() -> row.copy(name = row.path.trimEnd('/').substringAfterLast('/'))
                else -> row
            }
        }.distinctBy { Triple(it.remoteConnectionId, it.remoteSshHost, it.path) },
        if (opened) WorkspaceCatalogSource.OPENED else WorkspaceCatalogSource.RECENT,
    )
}
