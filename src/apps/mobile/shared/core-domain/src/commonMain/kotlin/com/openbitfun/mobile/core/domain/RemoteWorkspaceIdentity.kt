package com.openbitfun.mobile.core.domain

/** A path belongs to the serving runtime's saved connection, not the phone. */
public data class RemoteWorkspaceIdentity public constructor(
    public val path: String,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
) {
    public val key: String get() = listOf(remoteConnectionId.orEmpty(), remoteSshHost.orEmpty(), normalizedPath(path))
        .joinToString("") { "${it.length}:$it" }

    public fun matches(other: RemoteWorkspaceIdentity): Boolean = key == other.key

    public companion object {
        private fun normalizedPath(path: String): String = path.trim().let { it.trimEnd('/').ifEmpty { it } }
    }
}

public fun RecentWorkspace.identity(): RemoteWorkspaceIdentity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost)

/** Old cache rows have no provenance: only an unambiguous local root can own them. */
public fun RemoteSession.belongsTo(workspace: RemoteWorkspaceIdentity, catalog: List<RemoteWorkspaceIdentity>): Boolean {
    workspaceIdentity?.let { return it.matches(workspace) }
    if (!workspace.remoteConnectionId.isNullOrEmpty() || !workspace.remoteSshHost.isNullOrEmpty()) return false
    val local = RemoteWorkspaceIdentity(workspacePath.orEmpty(), null, null)
    return local.matches(workspace) && catalog.none {
        RemoteWorkspaceIdentity(it.path, null, null).matches(workspace) &&
            (!it.remoteConnectionId.isNullOrEmpty() || !it.remoteSshHost.isNullOrEmpty())
    }
}
