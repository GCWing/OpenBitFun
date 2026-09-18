package com.openbitfun.mobile.core.domain

/**
 * Outcome of matching one workspace reference against a host catalog.
 *
 * The cases are deliberately separate: an [UnknownId] is a reference the host no
 * longer serves and must surface as an error, never retried through the path it
 * happened to carry; [Ambiguous] and [Unresolved] only ever arise for pre-ID
 * references and must not pick a row on the caller's behalf.
 */
public sealed interface WorkspaceReferenceResolution {
    /** Exactly one catalog row owns the reference. */
    public data class Resolved(public val identity: RemoteWorkspaceIdentity) : WorkspaceReferenceResolution

    /** The reference carried a workspace ID the catalog does not contain. */
    public data class UnknownId(public val workspaceId: String) : WorkspaceReferenceResolution

    /** A pre-ID reference matched more than one catalog row. */
    public data class Ambiguous(public val candidates: List<RemoteWorkspaceIdentity>) : WorkspaceReferenceResolution

    /** A pre-ID reference matched no catalog row. */
    public data object Unresolved : WorkspaceReferenceResolution

    public val identityOrNull: RemoteWorkspaceIdentity?
        get() = (this as? Resolved)?.identity

    /** True only for [UnknownId]: the caller knows the ID and must not downgrade to a path. */
    public val isUnknownId: Boolean
        get() = this is UnknownId
}

/**
 * Upgrade-only conversion for pre-ID mobile caches and host projections.
 * Paths are not workspace keys. New state and commands retain workspaceId.
 * Remove when all supported caches have migrated and peers negotiate ID references.
 * Unknown IDs never fall back to a path; ambiguous old roots stay unresolved.
 *
 * The legacy matching mirrors the host resolver
 * (`src/crates/assembly/core/src/service/workspace/legacy_compat.rs`): blank
 * connection and host values are absent, a saved connection id narrows the
 * candidates, and an ssh host narrows them too except that a bare `localhost`
 * host without a connection id is ignored because 1.0.0 stamped it on local
 * workspaces.
 */
public object LegacyWorkspaceCompatibility {
    /** Full outcome; callers that must distinguish unknown IDs from legacy misses use this. */
    public fun resolveReference(
        reference: RemoteWorkspaceIdentity,
        catalog: List<RemoteWorkspaceIdentity>,
    ): WorkspaceReferenceResolution {
        reference.workspaceId?.trim()?.takeIf { it.isNotEmpty() }?.let { id -> return resolveById(id, catalog) }
        val root = normalizedRoot(reference.path)
        val connectionId = reference.remoteConnectionId?.trim()?.takeIf { it.isNotEmpty() }
        val sshHost = reference.remoteSshHost?.trim()?.takeIf { it.isNotEmpty() }
            ?.takeIf { host -> host != LOCALHOST || connectionId != null }
        val candidates = catalog.filter { candidate ->
            normalizedRoot(candidate.path) == root &&
                (connectionId == null || candidate.remoteConnectionId?.trim() == connectionId) &&
                (sshHost == null || candidate.remoteSshHost?.trim() == sshHost)
        }
        return when (candidates.size) {
            0 -> WorkspaceReferenceResolution.Unresolved
            1 -> WorkspaceReferenceResolution.Resolved(candidates.single())
            else -> WorkspaceReferenceResolution.Ambiguous(candidates)
        }
    }

    /** An explicit ID is authoritative: it resolves to its row or is an error, never a path lookup. */
    public fun resolveById(workspaceId: String, catalog: List<RemoteWorkspaceIdentity>): WorkspaceReferenceResolution {
        val id = workspaceId.trim()
        if (id.isEmpty()) return WorkspaceReferenceResolution.UnknownId(workspaceId)
        val matches = catalog.filter { it.workspaceId == id }
        return when (matches.size) {
            1 -> WorkspaceReferenceResolution.Resolved(matches.single())
            0 -> WorkspaceReferenceResolution.UnknownId(id)
            // Two catalog rows sharing an ID is a corrupt catalog; refusing is the only safe answer.
            else -> WorkspaceReferenceResolution.Ambiguous(matches)
        }
    }

    /**
     * Convenience for callers that only need the match. Unknown IDs, ambiguous
     * roots, and misses all read as `null`; use [resolveReference] when the
     * difference matters.
     */
    public fun resolve(reference: RemoteWorkspaceIdentity, catalog: List<RemoteWorkspaceIdentity>): RemoteWorkspaceIdentity? =
        resolveReference(reference, catalog).identityOrNull

    private const val LOCALHOST: String = "localhost"

    private fun normalizedRoot(path: String): String = path.trim().let { it.trimEnd('/').ifEmpty { it } }
}
