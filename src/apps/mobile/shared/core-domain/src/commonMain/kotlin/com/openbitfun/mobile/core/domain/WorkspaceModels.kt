package com.openbitfun.mobile.core.domain

public data class RecentWorkspace public constructor(
    public val path: String,
    public val name: String,
    public val lastOpened: String,
    public val kind: String,
    public val remoteSshHost: String?,
    public val remoteConnectionId: String?,
    public val workspaceId: String?,
) {
    public constructor(path: String, name: String, lastOpened: String, kind: String, remoteSshHost: String?, remoteConnectionId: String?) :
        this(path, name, lastOpened, kind, remoteSshHost, remoteConnectionId, null)
    public constructor(path: String, name: String, lastOpened: String, kind: String) :
        this(path, name, lastOpened, kind, null, null)
    public constructor(path: String, name: String, lastOpened: String, kind: String, remoteSshHost: String?) :
        this(path, name, lastOpened, kind, remoteSshHost, null)
    public val displayName: String
        get() = remoteSshHost?.trim()?.takeIf { it.isNotEmpty() }?.let { "$name · $it" } ?: name
}

public data class WorkspaceAssistant public constructor(
    public val path: String,
    public val name: String,
    public val assistantId: String?,
    public val workspaceId: String?,
) {
    public constructor(path: String, name: String, assistantId: String?) : this(path, name, assistantId, null)
}

public data class SelectedWorkspace public constructor(
    public val path: String,
    public val name: String,
    public val gitBranch: String,
    public val kind: String,
    public val assistantId: String?,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
    public val workspaceId: String?,
) {
    public constructor(path: String, name: String, gitBranch: String, kind: String, assistantId: String?, remoteConnectionId: String?, remoteSshHost: String?) :
        this(path, name, gitBranch, kind, assistantId, remoteConnectionId, remoteSshHost, null)
    public constructor(path: String, name: String, gitBranch: String, kind: String, assistantId: String?) :
        this(path, name, gitBranch, kind, assistantId, null, null)
}
