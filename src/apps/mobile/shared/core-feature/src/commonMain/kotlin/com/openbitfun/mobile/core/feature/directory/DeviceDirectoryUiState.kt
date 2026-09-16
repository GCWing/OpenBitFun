package com.openbitfun.mobile.core.feature.directory

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
) {
    public constructor(path: String, expanded: Boolean, status: WorkspaceDirectoryStatus) : this(path, expanded, status, null, null)
    public val identity: RemoteWorkspaceIdentity get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost)
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
    public val expanded: Boolean,
    public val status: DeviceDirectoryStatus,
    public val error: DeviceDirectoryFailure?,
    public val workspaces: List<RecentWorkspace>,
    public val sessions: List<RemoteSession>,
    public val workspaceDirectory: List<WorkspaceDirectoryEntry>,
    public val catalogSource: WorkspaceCatalogSource?,
    public val recentWorkspaces: List<RecentWorkspace>,
) {
    public constructor(deviceId: String, deviceName: String, online: Boolean, expanded: Boolean, status: DeviceDirectoryStatus, error: DeviceDirectoryFailure?, workspaces: List<RecentWorkspace>, sessions: List<RemoteSession>, workspaceDirectory: List<WorkspaceDirectoryEntry>) : this(deviceId, deviceName, online, expanded, status, error, workspaces, sessions, workspaceDirectory, null, workspaces)
    public constructor(
        deviceId: String,
        deviceName: String,
        online: Boolean,
        expanded: Boolean,
        status: DeviceDirectoryStatus,
        error: DeviceDirectoryFailure?,
        workspaces: List<RecentWorkspace>,
        sessions: List<RemoteSession>,
    ) : this(deviceId, deviceName, online, expanded, status, error, workspaces, sessions, emptyList())

    public fun sessionsForWorkspace(path: String, remoteConnectionId: String?, remoteSshHost: String?): List<RemoteSession> {
        val identity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost)
        return sessions.filter { it.belongsTo(identity, workspaces.map { row -> row.identity() }) }
    }

    public fun workspace(path: String): WorkspaceDirectoryEntry? = workspace(path, null, null)

    public fun workspace(path: String, remoteConnectionId: String?, remoteSshHost: String?): WorkspaceDirectoryEntry? {
        val identity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost)
        return workspaceDirectory.firstOrNull { it.identity.matches(identity) }
    }

    public companion object {
        private fun normalizeWorkspacePath(path: String): String {
            val trimmed = path.trim()
            val normalized = trimmed.trimEnd('/')
            return normalized.ifEmpty { trimmed }
        }

        public fun empty(deviceId: String, deviceName: String, online: Boolean): DeviceDirectoryEntry =
            DeviceDirectoryEntry(
                deviceId = deviceId,
                deviceName = deviceName,
                online = online,
                expanded = false,
                status = DeviceDirectoryStatus.IDLE,
                error = null,
                workspaces = emptyList(),
                sessions = emptyList(),
                workspaceDirectory = emptyList(),
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

    public data class Expand public constructor(
        public val deviceId: String,
    ) : DeviceDirectoryIntent

    public data class Collapse public constructor(
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
    ) : DeviceDirectoryIntent {
        public constructor(deviceId: String, path: String, expanded: Boolean) : this(deviceId, path, expanded, null, null)
    }

    public data class RetryWorkspace public constructor(
        public val deviceId: String,
        public val path: String,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
    ) : DeviceDirectoryIntent {
        public constructor(deviceId: String, path: String) : this(deviceId, path, null, null)
    }

    public data object Stop : DeviceDirectoryIntent
}
