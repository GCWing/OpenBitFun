package com.openbitfun.mobile.core.domain

/** A path belongs to the serving runtime's saved connection, not the phone. */
public data class RemoteWorkspaceIdentity public constructor(
    public val path: String,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
    public val workspaceId: String?,
) {
    /** A pre-ID reference: caches and hosts that never assigned a workspace ID. */
    public constructor(path: String, remoteConnectionId: String?, remoteSshHost: String?) : this(path, remoteConnectionId, remoteSshHost, null)

    public val key: String get() = workspaceId?.let { "workspace:${it.length}:$it" } ?: legacyKey

    /** Upgrade-only key for caches and peers predating workspace IDs. */
    private val legacyKey: String get() = listOf(remoteConnectionId.orEmpty(), remoteSshHost.orEmpty(), normalizedPath(path))
        .joinToString("") { "${it.length}:$it" }

    public fun matches(other: RemoteWorkspaceIdentity): Boolean = key == other.key

    /**
     * ID-first equality for UI selection state. When both sides carry a workspace
     * ID only the IDs are compared; when either side predates IDs the legacy
     * triple decides, so a pre-ID cache row still highlights its live workspace.
     */
    public fun sameWorkspace(other: RemoteWorkspaceIdentity): Boolean {
        val ownId = workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        val otherId = other.workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        if (ownId != null && otherId != null) return ownId == otherId
        return legacyKey == other.legacyKey
    }

    public companion object {
        private fun normalizedPath(path: String): String = path.trim().let { it.trimEnd('/').ifEmpty { it } }
    }
}

public fun RecentWorkspace.identity(): RemoteWorkspaceIdentity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)

public fun WorkspaceAssistant.identity(): RemoteWorkspaceIdentity = RemoteWorkspaceIdentity(path, null, null, workspaceId)

public fun SelectedWorkspace.identity(): RemoteWorkspaceIdentity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)

/**
 * Whether this session is filed under [workspace].
 *
 * When both sides carry a workspace ID the IDs decide alone. An owned identity
 * without an ID goes through [LegacyWorkspaceCompatibility]; an owned ID the
 * catalog does not know resolves to nothing rather than to a same-path row.
 * Old cache rows have no provenance: only an unambiguous local root can own them.
 */
public fun RemoteSession.belongsTo(workspace: RemoteWorkspaceIdentity, catalog: List<RemoteWorkspaceIdentity>): Boolean {
    workspaceIdentity?.let { owned ->
        val ownedId = owned.workspaceId
        val targetId = workspace.workspaceId
        if (ownedId != null && targetId != null) return ownedId == targetId
        val resolved = LegacyWorkspaceCompatibility.resolveReference(owned, catalog).identityOrNull ?: return false
        return resolved.matches(workspace)
    }
    if (!workspace.remoteConnectionId.isNullOrEmpty() || !workspace.remoteSshHost.isNullOrEmpty()) return false
    val local = LegacyWorkspaceCompatibility.resolve(RemoteWorkspaceIdentity(workspacePath.orEmpty(), null, null), catalog)
    return local?.matches(workspace) == true
}
