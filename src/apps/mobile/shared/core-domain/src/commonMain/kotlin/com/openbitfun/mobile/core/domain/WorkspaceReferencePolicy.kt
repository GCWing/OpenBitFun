package com.openbitfun.mobile.core.domain

/**
 * How a client decides what it may put in a workspace-bearing command.
 *
 * A reference that knows its workspace ID sends the ID and nothing else, so an
 * ID-aware host can never quietly fall back to the path. That requires the host
 * to advertise [WORKSPACE_ID_REFERENCES]; a host that does not is an explicit
 * unsupported state for such a reference, not a reason to send its path.
 * References that never had an ID (pre-ID caches, hand-typed paths) keep using
 * the legacy `(path, connection, ssh host)` projection on any host.
 */
public object WorkspaceReferencePolicy {
    /** Host capability under which `workspace_id` is honoured on every workspace command. */
    public const val WORKSPACE_ID_REFERENCES: String = "workspace_id_references_v1"

    public fun supportsWorkspaceIdReferences(capabilities: Collection<String>): Boolean =
        WORKSPACE_ID_REFERENCES in capabilities
}
