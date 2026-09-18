package com.openbitfun.mobile.core.feature.directory

import com.openbitfun.mobile.core.domain.LegacyWorkspaceCompatibility
import com.openbitfun.mobile.core.domain.identity
import com.openbitfun.mobile.core.domain.belongsTo
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.feature.workspace.WorkspaceCatalogSource

/**
 * Where one device's directory entry is in its load lifecycle.
 *
 * [CACHED] means an offline device still has non-empty workspace or session
 * data retained from an earlier successful load. An offline device with no
 * retained data remains [IDLE]; `online = false` carries the offline fact.
 * [CACHED] is therefore not a generic offline marker. It may be restored from
 * the device-scoped disk cache or retained from this process. Online entries
 * transition IDLE -> LOADING -> READY/FAILED;
 * online -> offline changes READY/LOADING to CACHED only when data exists, and
 * offline -> online permits a new load/retry.
 */
public enum class DeviceDirectoryStatus {
    IDLE,
    CACHED,
    LOADING,
    READY,
    FAILED,
}

public enum class WorkspaceDirectoryStatus {
    IDLE,
    LOADING,
    READY,
    FAILED,
}

/** Disclosure and request state for one workspace inside one device row. */
public data class WorkspaceDirectoryEntry public constructor(
    public val path: String,
    public val expanded: Boolean,
    public val status: WorkspaceDirectoryStatus,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
    public val workspaceId: String?,
) {
    public constructor(path: String, expanded: Boolean, status: WorkspaceDirectoryStatus, remoteConnectionId: String?, remoteSshHost: String?) : this(path, expanded, status, remoteConnectionId, remoteSshHost, null)
    public constructor(path: String, expanded: Boolean, status: WorkspaceDirectoryStatus) : this(path, expanded, status, null, null)
    public val identity: RemoteWorkspaceIdentity get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)
}

/** Why a device's directory content cannot be shown. */
public enum class DeviceDirectoryFailure {
    NOT_SIGNED_IN,
    NO_WORKSPACE,
    REJECTED,
    NETWORK,
    TIMEOUT,
    RATE_LIMITED,
    LOAD_FAILED,
}

/** One device the account directory knows about. */
public data class DeviceDirectoryDevice public constructor(
    public val deviceId: String,
    public val deviceName: String,
    public val online: Boolean,
) {
    /** A device whose display name is unknown; the id stands in until one arrives. */
    public constructor(deviceId: String, online: Boolean) : this(deviceId, deviceId, online)
}

/** One device's directory state: identity plus the content it loaded. */
public data class DeviceDirectoryEntry public constructor(
    public val deviceId: String,
    public val deviceName: String,
    public val online: Boolean,
    public val status: DeviceDirectoryStatus,
    public val error: DeviceDirectoryFailure?,
    public val workspaces: List<RecentWorkspace>,
    public val sessions: List<RemoteSession>,
    public val workspaceDirectory: List<WorkspaceDirectoryEntry>,
    public val catalogSource: WorkspaceCatalogSource?,
    public val recentWorkspaces: List<RecentWorkspace>,
) {
    /**
     * Sessions filed under [workspace]. An ID resolves by ID alone (an unknown ID
     * owns nothing); a pre-ID reference resolves through [LegacyWorkspaceCompatibility]
     * and an ambiguous root owns nothing rather than one arbitrary row.
     */
    public fun sessionsForWorkspace(workspace: RemoteWorkspaceIdentity): List<RemoteSession> {
        val catalog = workspaces.map { it.identity() }
        val identity = LegacyWorkspaceCompatibility.resolve(workspace, catalog) ?: return emptyList()
        return sessions.filter { it.belongsTo(identity, catalog) }
    }

    /** ID-first lookup; use when the caller holds a workspace ID. */
    public fun sessionsForWorkspaceId(workspaceId: String): List<RemoteSession> =
        sessionsForWorkspace(RemoteWorkspaceIdentity("", null, null, workspaceId))

    /** Pre-ID lookup for callers that only hold the legacy triple; delegates through the compatibility resolver. */
    public fun sessionsForWorkspace(path: String, remoteConnectionId: String?, remoteSshHost: String?): List<RemoteSession> =
        sessionsForWorkspace(RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost))

    /** Directory entry for [workspace], resolved the same way as [sessionsForWorkspace]. */
    public fun workspace(workspace: RemoteWorkspaceIdentity): WorkspaceDirectoryEntry? {
        val identity = LegacyWorkspaceCompatibility.resolve(workspace, workspaces.map { it.identity() }) ?: return null
        return workspaceDirectory.firstOrNull { it.identity.matches(identity) }
    }

    /** ID-first lookup; use when the caller holds a workspace ID. */
    public fun workspaceById(workspaceId: String): WorkspaceDirectoryEntry? =
        workspace(RemoteWorkspaceIdentity("", null, null, workspaceId))

    public fun workspace(path: String): WorkspaceDirectoryEntry? = workspace(path, null, null)

    /** Pre-ID lookup for callers that only hold the legacy triple; delegates through the compatibility resolver. */
    public fun workspace(path: String, remoteConnectionId: String?, remoteSshHost: String?): WorkspaceDirectoryEntry? =
        workspace(RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost))

    public companion object {
        public fun empty(deviceId: String, deviceName: String, online: Boolean): DeviceDirectoryEntry =
            DeviceDirectoryEntry(
                deviceId = deviceId,
                deviceName = deviceName,
                online = online,
                status = DeviceDirectoryStatus.IDLE,
                error = null,
                workspaces = emptyList(),
                sessions = emptyList(),
                workspaceDirectory = emptyList(),
                catalogSource = null,
                recentWorkspaces = emptyList(),
            )
    }
}

/** The whole device directory a sidebar renders. */
public data class DeviceDirectoryUiState public constructor(
    public val devices: List<DeviceDirectoryEntry>,
) {
    public fun device(deviceId: String): DeviceDirectoryEntry? =
        devices.firstOrNull { it.deviceId == deviceId }
}

/**
 * Capability for reconciling a create result into one authenticated device row.
 *
 * The opaque [epoch] binds a result to the device membership snapshot in which
 * the create started. Callers obtain this immediately before creating and must
 * return the same key with the confirmed session.
 */
public data class DeviceDirectoryReconcileKey public constructor(
    public val deviceId: String,
    public val epoch: Long,
)

/** Intents the directory store handles. */
public sealed interface DeviceDirectoryIntent {
    /** Replace the device list from the account's latest device projection. */
    public data class Sync public constructor(
        public val devices: List<DeviceDirectoryDevice>,
    ) : DeviceDirectoryIntent

    public data class Load public constructor(
        public val deviceId: String,
    ) : DeviceDirectoryIntent

    public data class Retry public constructor(
        public val deviceId: String,
    ) : DeviceDirectoryIntent

    public data class SetWorkspaceExpanded public constructor(
        public val deviceId: String,
        public val path: String,
        public val expanded: Boolean,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        public val workspaceId: String?,
    ) : DeviceDirectoryIntent {
        public constructor(deviceId: String, path: String, expanded: Boolean, remoteConnectionId: String?, remoteSshHost: String?) : this(deviceId, path, expanded, remoteConnectionId, remoteSshHost, null)
        public constructor(deviceId: String, path: String, expanded: Boolean) : this(deviceId, path, expanded, null, null)
    }

    public data class RetryWorkspace public constructor(
        public val deviceId: String,
        public val path: String,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        public val workspaceId: String?,
    ) : DeviceDirectoryIntent {
        public constructor(deviceId: String, path: String, remoteConnectionId: String?, remoteSshHost: String?) : this(deviceId, path, remoteConnectionId, remoteSshHost, null)
        public constructor(deviceId: String, path: String) : this(deviceId, path, null, null)
    }

    public data object Stop : DeviceDirectoryIntent
}
