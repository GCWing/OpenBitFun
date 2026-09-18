package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.domain.FilePreviewFailure
import com.openbitfun.mobile.core.domain.FilePreviewFailureReason
import com.openbitfun.mobile.core.domain.FilePreviewTarget
import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.SelectedWorkspace
import com.openbitfun.mobile.core.domain.WorkspaceAssistant
import com.openbitfun.mobile.core.domain.WorkspaceReferencePolicy
import com.openbitfun.mobile.core.domain.identity

public data class PreviewRequestIdentity public constructor(
    public val requestId: String,
    public val deviceKey: String?,
    public val sessionId: String,
    public val path: String,
)

public sealed interface RemoteFilePreviewUiState {
    public data object None : RemoteFilePreviewUiState
    public data class Loading public constructor(
        public val target: FilePreviewTarget,
        public val identity: PreviewRequestIdentity,
    ) : RemoteFilePreviewUiState {
        public constructor(target: FilePreviewTarget) : this(target, PreviewRequestIdentity("", null, target.sessionId, target.remotePath))
    }
    public data class Text public constructor(
        public val target: FilePreviewTarget,
        public val name: String,
        public val content: String,
        public val truncated: Boolean,
        public val loadedBytes: Long,
        public val mimeType: String,
        public val sizeBytes: Long,
        /** Markdown is rendered rather than shown as numbered source. */
        public val markdown: Boolean,
        public val identity: PreviewRequestIdentity,
    ) : RemoteFilePreviewUiState {
        public constructor(
            target: FilePreviewTarget, name: String, content: String, truncated: Boolean,
            loadedBytes: Long, mimeType: String, sizeBytes: Long, markdown: Boolean,
        ) : this(target, name, content, truncated, loadedBytes, mimeType, sizeBytes, markdown,
            PreviewRequestIdentity("", null, target.sessionId, target.remotePath))
    }
    public data class Image public constructor(
        public val target: FilePreviewTarget,
        public val name: String,
        public val mimeType: String,
        public val bytes: ByteArray,
        public val sizeBytes: Long,
        public val identity: PreviewRequestIdentity,
    ) : RemoteFilePreviewUiState {
        public constructor(target: FilePreviewTarget, name: String, mimeType: String, bytes: ByteArray, sizeBytes: Long) :
            this(target, name, mimeType, bytes, sizeBytes, PreviewRequestIdentity("", null, target.sessionId, target.remotePath))
    }
    public data class Unsupported public constructor(
        public val target: FilePreviewTarget,
        public val mimeType: String,
        public val sizeBytes: Long,
        public val identity: PreviewRequestIdentity,
    ) : RemoteFilePreviewUiState {
        public constructor(target: FilePreviewTarget, mimeType: String, sizeBytes: Long) :
            this(target, mimeType, sizeBytes, PreviewRequestIdentity("", null, target.sessionId, target.remotePath))
    }
    /**
     * @param retryable whether asking again could give a different answer. A
     * file outside the workspace will not appear on a second try, so offering
     * Retry there would be a lie.
     */
    public data class Failed public constructor(
        public val target: FilePreviewTarget,
        public val kind: FilePreviewFailureKind,
        public val retryable: Boolean,
        public val mimeType: String,
        public val sizeBytes: Long,
        public val identity: PreviewRequestIdentity,
    ) : RemoteFilePreviewUiState {
        public constructor(target: FilePreviewTarget, kind: FilePreviewFailureKind, retryable: Boolean, mimeType: String, sizeBytes: Long) :
            this(target, kind, retryable, mimeType, sizeBytes, PreviewRequestIdentity("", null, target.sessionId, target.remotePath))
    }
}

/**
 * Byte counts as the preview surface says them, matching HarmonyOS'
 * `RemoteUiState.formatBytes` exactly: whole units, and never a unit smaller
 * than the number deserves. A header line that disagreed across the two apps
 * would be a parity difference no screenshot could explain away.
 */
public object FilePreviewFormat {
    private const val KB: Long = 1024
    private const val MB: Long = 1024 * 1024

    public fun bytes(value: Long): String = when {
        value < KB -> "$value B"
        value < MB -> "${((value.toDouble() / KB) + 0.5).toLong()} KB"
        else -> "${((value.toDouble() / MB) + 0.5).toLong()} MB"
    }
}

public sealed interface RemoteFileDownloadUiState {
    public data object None : RemoteFileDownloadUiState
    public data class Loading public constructor(
        public val target: FilePreviewTarget,
        public val downloadedBytes: Long,
        public val totalBytes: Long,
    ) : RemoteFileDownloadUiState
    public data class AwaitingSave public constructor(
        public val target: FilePreviewTarget,
        public val name: String,
        public val mimeType: String,
        public val localReference: String,
    ) : RemoteFileDownloadUiState
    public data class Saved public constructor(
        public val target: FilePreviewTarget,
        public val name: String,
    ) : RemoteFileDownloadUiState
    public data class Failed public constructor(
        public val target: FilePreviewTarget,
        public val kind: FilePreviewFailureKind,
        public val retryable: Boolean,
    ) : RemoteFileDownloadUiState
}

/**
 * Why a preview has no content.
 *
 * The desktop's own sentence is not carried across: it is written in the
 * desktop's locale and often names a host path. Apps say it in their own words —
 * see the design doc section 4.3.
 */
public enum class FilePreviewFailureKind {
    NOT_FOUND,
    UNAVAILABLE,
    ACCESS_DENIED,
    TOO_LARGE,
    CONNECTION,
    LOAD_FAILED,
}

internal fun FilePreviewFailure.toKind(): FilePreviewFailureKind = when (reason) {
    FilePreviewFailureReason.NOT_FOUND -> FilePreviewFailureKind.NOT_FOUND
    FilePreviewFailureReason.UNAVAILABLE -> FilePreviewFailureKind.UNAVAILABLE
    FilePreviewFailureReason.ACCESS_DENIED -> FilePreviewFailureKind.ACCESS_DENIED
    FilePreviewFailureReason.TOO_LARGE -> FilePreviewFailureKind.TOO_LARGE
    FilePreviewFailureReason.CONNECTION -> FilePreviewFailureKind.CONNECTION
    FilePreviewFailureReason.LOAD_FAILED -> FilePreviewFailureKind.LOAD_FAILED
}

public data class SavedRuntimeConnectionUiState public constructor(
    public val id: String, public val name: String, public val host: String,
)

/** Device tools are independent of chat/workspace selection. Labels stay native. */
public enum class DeviceToolsPanel { FILES, TERMINAL }
public data class DeviceToolsUiState public constructor(
    public val visible: Boolean,
    public val panel: DeviceToolsPanel,
    public val path: String,
    public val connectionId: String?,
    public val busy: Boolean,
    public val failed: Boolean,
) {
    public constructor() : this(false, DeviceToolsPanel.FILES, "", null, false, false)
}

/**
 * Why the last workspace or assistant selection was not sent, or was refused,
 * as a workspace reference. Distinct from [RemoteWorkspaceUiState.Ready.loadFailure]:
 * nothing is wrong with the connection, the reference itself cannot be honoured.
 */
public enum class WorkspaceReferenceFailure {
    /**
     * The reference has a workspace ID but the host does not advertise
     * `workspace_id_references_v1`. The ID was kept and no path was sent.
     */
    ID_REFERENCES_UNSUPPORTED,

    /** The reference's ID is not in this host's catalog. */
    UNKNOWN_ID,

    /** A pre-ID path matched several catalog rows; nothing was selected. */
    AMBIGUOUS_PATH,
}

public sealed interface RemoteWorkspaceUiState {
    public data object Idle : RemoteWorkspaceUiState
    public data object Loading : RemoteWorkspaceUiState
    public data class Ready public constructor(
        public val workspaces: List<RecentWorkspace>,
        public val assistants: List<WorkspaceAssistant>,
        public val selected: SelectedWorkspace?,
        public val preview: RemoteFilePreviewUiState,
        public val busy: Boolean,
        public val download: RemoteFileDownloadUiState,
        /** True when cached content survived the latest catalog or selection request failing. */
        public val loadFailure: Boolean,
        /** Live target capabilities; never inferred from a cached catalog. */
        public val hostCapabilities: List<String>,
        public val savedConnections: List<SavedRuntimeConnectionUiState>,
        public val savedConnectionsFailure: Boolean,
        public val terminal: RuntimeTerminalUiState,
        public val files: RuntimeFilesUiState,
        public val directoryPicker: RuntimeFilesUiState,
        public val catalog: WorkspaceCatalogUiState?,
        public val deviceTools: DeviceToolsUiState,
        /** Set when the last selection named a workspace the host cannot address; cleared by the next successful one. */
        public val workspaceReferenceFailure: WorkspaceReferenceFailure?,
    ) : RemoteWorkspaceUiState {
        /** Whether the live host honours ID-only workspace commands. False for a cached catalog. */
        public val supportsWorkspaceIdReferences: Boolean
            get() = WorkspaceReferencePolicy.supportsWorkspaceIdReferences(hostCapabilities)

        /** ID-first: whether [workspace] is the live selection. IDs decide when both carry one; the legacy triple otherwise. */
        public fun isSelected(workspace: RecentWorkspace): Boolean =
            selected?.identity()?.sameWorkspace(workspace.identity()) == true

        /** ID-first: whether [assistant] is the live selection. */
        public fun isSelected(assistant: WorkspaceAssistant): Boolean =
            selected?.identity()?.sameWorkspace(assistant.identity()) == true

        public constructor(workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?, preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState, loadFailure: Boolean, hostCapabilities: List<String>, savedConnections: List<SavedRuntimeConnectionUiState>, savedConnectionsFailure: Boolean, terminal: RuntimeTerminalUiState, files: RuntimeFilesUiState, directoryPicker: RuntimeFilesUiState, catalog: WorkspaceCatalogUiState?, deviceTools: DeviceToolsUiState) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, hostCapabilities, savedConnections, savedConnectionsFailure, terminal, files, directoryPicker, catalog, deviceTools, null)
        public constructor(workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?, preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState, loadFailure: Boolean, hostCapabilities: List<String>, savedConnections: List<SavedRuntimeConnectionUiState>, savedConnectionsFailure: Boolean, terminal: RuntimeTerminalUiState, files: RuntimeFilesUiState, directoryPicker: RuntimeFilesUiState, catalog: WorkspaceCatalogUiState?) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, hostCapabilities, savedConnections, savedConnectionsFailure, terminal, files, directoryPicker, catalog, DeviceToolsUiState())
        public constructor(workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?, preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState, loadFailure: Boolean, hostCapabilities: List<String>, savedConnections: List<SavedRuntimeConnectionUiState>, savedConnectionsFailure: Boolean, terminal: RuntimeTerminalUiState, files: RuntimeFilesUiState, directoryPicker: RuntimeFilesUiState) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, hostCapabilities, savedConnections, savedConnectionsFailure, terminal, files, directoryPicker, null)
        public constructor(workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?, preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState, loadFailure: Boolean, hostCapabilities: List<String>, savedConnections: List<SavedRuntimeConnectionUiState>, savedConnectionsFailure: Boolean, terminal: RuntimeTerminalUiState, files: RuntimeFilesUiState) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, hostCapabilities, savedConnections, savedConnectionsFailure, terminal, files, RuntimeFilesUiState("", emptyList(), false, null, "", false, false))
        public constructor(
            workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?,
            preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState,
            loadFailure: Boolean, hostCapabilities: List<String>,
        ) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, hostCapabilities, emptyList(), false, RuntimeTerminalUiState(null, "", false, false), RuntimeFilesUiState("", emptyList(), false, null, "", false, false))

        public constructor(
            workspaces: List<RecentWorkspace>, assistants: List<WorkspaceAssistant>, selected: SelectedWorkspace?,
            preview: RemoteFilePreviewUiState, busy: Boolean, download: RemoteFileDownloadUiState, loadFailure: Boolean,
        ) : this(workspaces, assistants, selected, preview, busy, download, loadFailure, emptyList())

        public constructor(
            workspaces: List<RecentWorkspace>,
            assistants: List<WorkspaceAssistant>,
            selected: SelectedWorkspace?,
            preview: RemoteFilePreviewUiState,
            busy: Boolean,
            download: RemoteFileDownloadUiState,
        ) : this(workspaces, assistants, selected, preview, busy, download, false)
    }
    public data class Failed public constructor(public val retryable: Boolean) : RemoteWorkspaceUiState
}

public sealed interface RemoteWorkspaceIntent {
    public data class ResizeTerminal(public val cols: Int, public val rows: Int) : RemoteWorkspaceIntent
    public data class UploadFile(public val path: String, public val source: RuntimeUploadSource) : RemoteWorkspaceIntent
    public data object Load : RemoteWorkspaceIntent
    /**
     * Device tools browse a location on a provider. [workspaceId] is optional: when the
     * location is an open workspace, it keys the terminal/file caches by workspace identity
     * instead of by path so two workspaces sharing a path never share a terminal.
     */
    public data class OpenDeviceTools public constructor(public val path: String, public val connectionId: String?, public val workspaceId: String?) : RemoteWorkspaceIntent {
        public constructor(path: String, connectionId: String?) : this(path, connectionId, null)
        public constructor() : this("", null)
        public constructor(connectionId: String?) : this("", connectionId)
    }
    public data class SelectDeviceToolsPanel(public val panel: DeviceToolsPanel) : RemoteWorkspaceIntent
    public data object CloseDeviceTools : RemoteWorkspaceIntent
    public data object StartDeviceToolsTerminal : RemoteWorkspaceIntent
    public data class OpenDeviceFiles public constructor(public val path: String, public val remoteConnectionId: String?, public val workspaceId: String?) : RemoteWorkspaceIntent {
        public constructor(path: String, remoteConnectionId: String?) : this(path, remoteConnectionId, null)
    }
    public data class OpenDeviceTerminal public constructor(public val path: String, public val remoteConnectionId: String?, public val workspaceId: String?) : RemoteWorkspaceIntent {
        public constructor(path: String, remoteConnectionId: String?) : this(path, remoteConnectionId, null)
    }
    public data class BrowseFiles(public val path: String, public val append: Boolean) : RemoteWorkspaceIntent
    public data class ReadFile(public val path: String) : RemoteWorkspaceIntent
    public data class SaveFile(public val content: String) : RemoteWorkspaceIntent
    public data class BrowseWorkspaceDirectories(public val path: String, public val remoteConnectionId: String?, public val append: Boolean) : RemoteWorkspaceIntent
    public data class SortFiles(public val sort: RuntimeFileSort) : RemoteWorkspaceIntent
    public data object CloseFileEditor : RemoteWorkspaceIntent
    public data class CreateFile(public val path: String) : RemoteWorkspaceIntent
    public data class RenameFile(public val path: String) : RemoteWorkspaceIntent
    public data object DeleteFile : RemoteWorkspaceIntent
    public data class CreateDirectory(public val path: String) : RemoteWorkspaceIntent
    public data class UploadFileEntry(public val name: String, public val source: RuntimeUploadSource) : RemoteWorkspaceIntent
    public data class CreateFileEntry(public val name: String, public val directory: Boolean) : RemoteWorkspaceIntent
    public data class RenameFileEntry(public val path: String, public val name: String) : RemoteWorkspaceIntent
    public data class DeleteFileEntry(public val path: String) : RemoteWorkspaceIntent
    public data object OpenTerminal : RemoteWorkspaceIntent
    public data object ReopenTerminal : RemoteWorkspaceIntent
    public data object CloseTerminal : RemoteWorkspaceIntent
    public data class WriteTerminal(public val data: String) : RemoteWorkspaceIntent
    /**
     * Selects a workspace. With [workspaceId] the host is addressed by ID only and the
     * path/connection fields are display context. Without it, explicit location pickers
     * disable inference: null then means the controlled host itself.
     */
    public data class SelectWorkspace public constructor(public val path: String, public val remoteConnectionId: String?, public val remoteSshHost: String?, public val inferSavedIdentity: Boolean, public val workspaceId: String?) : RemoteWorkspaceIntent {
        public constructor(path: String, remoteConnectionId: String?, remoteSshHost: String?, inferSavedIdentity: Boolean) : this(path, remoteConnectionId, remoteSshHost, inferSavedIdentity, null)
        public constructor(path: String, remoteConnectionId: String?, remoteSshHost: String?) : this(path, remoteConnectionId, remoteSshHost, true)
        public constructor(path: String) : this(path, null, null)
    }
    /** Selects an assistant workspace by ID when known; the path is only used for pre-ID catalog rows. */
    public data class SelectAssistant public constructor(public val path: String, public val workspaceId: String?) : RemoteWorkspaceIntent {
        public constructor(path: String) : this(path, null)
    }
    public data class OpenFile public constructor(
        public val reference: String,
        public val label: String,
        public val sessionId: String,
        /** Optional local correlation supplied by Swift; blank values are generated. */
        public val requestId: String,
    ) : RemoteWorkspaceIntent {
        public constructor(reference: String, label: String, sessionId: String) :
            this(reference, label, sessionId, "")
    }
    public data class DownloadFile public constructor(
        public val reference: String,
        public val label: String,
        public val sessionId: String,
    ) : RemoteWorkspaceIntent
    public data object RetryDownload : RemoteWorkspaceIntent
    public data class DownloadSaved public constructor(public val reference: String) : RemoteWorkspaceIntent
    public data class DownloadSaveFailed public constructor(public val reference: String) : RemoteWorkspaceIntent
    public data object DismissPreview : RemoteWorkspaceIntent
    public data object Stop : RemoteWorkspaceIntent
}
