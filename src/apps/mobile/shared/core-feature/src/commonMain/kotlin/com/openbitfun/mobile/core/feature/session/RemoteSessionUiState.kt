package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatTimelineState
import com.openbitfun.mobile.core.domain.LegacyWorkspaceCompatibility
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.SessionAgentTypes
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog

/**
 * Which agent kinds the session list is narrowed to.
 *
 * The desktop's `list_sessions` has no agent filter, so narrowing happens on the
 * client; what each `agent_type` string means is [SessionAgentTypes]' business.
 */
public enum class SessionAgentFilter {
    ALL,
    CODE,
    COWORK,
    ;

    public fun matches(agentType: String): Boolean = when (this) {
        ALL -> true
        CODE -> SessionAgentTypes.isCode(agentType)
        COWORK -> SessionAgentTypes.isCowork(agentType)
    }
}

public enum class SessionPermissionMode {
    ASK,
    AUTO,
    FULL_ACCESS,

    /** Unknown or unavailable permission mode, surfaced instead of assuming ask. */
    UNKNOWN,
}

/**
 * Why the permission section has no mode to show.
 *
 * A permission command that fails must not take the session down with it: the
 * transcript is still live and the user is still reading it, so the failure
 * stays inside the section that caused it. Which of the two it was decides
 * whether the shown mode is stale or simply unknown.
 */
public enum class PermissionModeFailure {
    /** `get_permission_mode` failed, so no mode is known. */
    LOAD,

    /** `set_permission_mode` failed; the mode still shown is the desktop's old one. */
    SAVE,
}

/** Typed lifecycle of the most recent create-session request. */
public sealed interface CreateSessionOperationState {
    public data object Idle : CreateSessionOperationState

    public data class InFlight public constructor(
        public val requestId: String,
        /** The remote target owning this operation; never a controller path. */
        public val deviceKey: String?,
        public val workspacePath: String,
    ) : CreateSessionOperationState

    public data class Succeeded public constructor(
        public val requestId: String,
        public val createdSessionId: String,
        /** Canonical projection confirmed by create, including its owning workspace. */
        public val confirmedSession: RemoteSession?,
        /** Minimum Ready revision that contains this committed session. */
        public val commitRevision: Long,
    ) : CreateSessionOperationState {
        public constructor(
            requestId: String,
            createdSessionId: String,
            confirmedSession: RemoteSession?,
        ) : this(requestId, createdSessionId, confirmedSession, 0)

        public constructor(requestId: String, createdSessionId: String) : this(requestId, createdSessionId, null, 0)
    }

    public data class Failed public constructor(
        public val requestId: String,
        public val reason: CreateSessionOperationFailure,
        public val retryable: Boolean,
        public val unsupported: Boolean,
    ) : CreateSessionOperationState

    public data class Cancelled public constructor(
        public val requestId: String,
        public val reason: CreateSessionOperationFailure,
    ) : CreateSessionOperationState
}

public enum class CreateSessionOperationFailure {
    TRANSPORT,
    UNSUPPORTED,
    DISCONNECTED,
    WORKSPACE,
    DEVICE_MISMATCH,
    PROTOCOL,
    CANCELLED,

    /**
     * The request named a workspace by ID but the connected host does not
     * advertise `workspace_id_references_v1`. The ID is kept and nothing is sent:
     * downgrading to the path would let the host pick a same-path workspace.
     */
    WORKSPACE_ID_UNSUPPORTED,

    /** The request named a workspace ID this host does not serve. */
    WORKSPACE_ID_UNKNOWN,
}

/** Independent backward-page request state; never blocks live generation. */
public enum class HistoryLoadState { IDLE, LOADING, FAILED }

/** Why the optional model catalog could not be loaded. */
public enum class ModelCatalogFailure {
    /**
     * The catalog command failed with any of the generic transport results
     * (rejected, malformed, timed out, unreachable, ...). Retrying is
     * meaningful, so the UI offers Retry.
     */
    LOAD_FAILED,

    /**
     * Reserved forward-compat state for a real peer-capability signal: the peer
     * is known to lack `get_model_catalog`. The current transport produces no
     * such signal, so this value is never set from a generic command failure —
     * a rejection or malformed response can also come from a modern desktop or
     * a local protocol fault. The UI still renders it explicitly if a future
     * transport surfaces it.
     */
    UNSUPPORTED_BY_PEER,
}

public enum class RemoteSessionFailureReason {
    TRANSPORT,
    SESSION_NOT_FOUND,
    PROTOCOL_MISMATCH,

    /**
     * The desktop has no workspace open, so `list_sessions` and `create_session`
     * cannot be answered. Detected before sending rather than by matching the
     * desktop's rejection text, which is localized on the desktop side.
     */
    NO_WORKSPACE,

    /**
     * The command reached the desktop and the desktop refused it. The reason it
     * gave is in [RemoteSessionUiState.Failed.remoteMessage] — the split matches
     * [com.openbitfun.mobile.core.feature.pairing.PairingFailureReason.DesktopRejected].
     */
    REMOTE_REJECTED,

    /** The command never reached the relay. */
    NETWORK,

    /** The relay or the desktop did not answer in time. */
    TIMEOUT,

    /** The relay is throttling this client. */
    RATE_LIMITED,

    /**
     * The command named a workspace by ID but the connected host does not
     * advertise `workspace_id_references_v1`. Nothing was sent; the path is
     * never substituted for an ID the client knows.
     */
    WORKSPACE_ID_UNSUPPORTED,

    /** The host does not serve the workspace ID the command named. */
    WORKSPACE_ID_UNKNOWN,
}

public enum class WorkspaceSessionDirectoryStatus {
    IDLE,
    LOADING,
    READY,
    FAILED,

    /**
     * The branch is keyed by a workspace ID the connected host cannot address
     * (it lacks `workspace_id_references_v1` or no longer serves the ID). The
     * cached sessions stay visible; loading by path is not attempted.
     */
    UNSUPPORTED,
}

/** One independently loaded workspace branch in a live remote session store. */
public data class WorkspaceSessionDirectoryEntry public constructor(
    public val path: String,
    public val status: WorkspaceSessionDirectoryStatus,
    public val sessions: List<RemoteSession>,
    public val remoteConnectionId: String?,
    public val remoteSshHost: String?,
    public val workspaceId: String?,
) {
    public constructor(path: String, status: WorkspaceSessionDirectoryStatus, sessions: List<RemoteSession>, remoteConnectionId: String?, remoteSshHost: String?) :
        this(path, status, sessions, remoteConnectionId, remoteSshHost, null)

    public constructor(path: String, status: WorkspaceSessionDirectoryStatus, sessions: List<RemoteSession>) :
        this(path, status, sessions, null, null)

    public val identity: RemoteWorkspaceIdentity get() = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost, workspaceId)
}

public data class WorkspaceSessionDirectoryUiState public constructor(
    public val workspaces: List<WorkspaceSessionDirectoryEntry>,
) {
    public fun workspace(path: String): WorkspaceSessionDirectoryEntry? = workspace(path, null, null)

    /**
     * Legacy lookup: the reference has no ID, so it is matched through
     * [LegacyWorkspaceCompatibility] against the loaded branches. Ambiguous
     * paths resolve to nothing rather than to the first branch.
     */
    public fun workspace(path: String, remoteConnectionId: String?, remoteSshHost: String?): WorkspaceSessionDirectoryEntry? =
        workspace(RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost))

    /** ID-first lookup: an identity with a workspace ID matches on the ID alone. */
    public fun workspace(identity: RemoteWorkspaceIdentity): WorkspaceSessionDirectoryEntry? {
        identity.workspaceId?.let { id -> return workspaces.firstOrNull { it.workspaceId == id } }
        val resolved = LegacyWorkspaceCompatibility.resolve(identity, workspaces.map { it.identity }) ?: return null
        return workspaces.firstOrNull { it.identity.matches(resolved) }
    }

    public fun workspaceById(workspaceId: String): WorkspaceSessionDirectoryEntry? =
        workspaces.firstOrNull { it.workspaceId == workspaceId }
}



public data class ComposerImage public constructor(
    public val id: String,
    public val dataUrl: String,
    public val mimeType: String,
)

/** A host acknowledgement, used to consume only the draft that was sent. */
public data class SentChatMessage public constructor(
    public val id: String,
    public val sessionId: String,
    public val content: String,
    public val imageIds: List<String>,
)

public sealed interface RemoteSessionUiState {
    public data object Idle : RemoteSessionUiState

    public data object Loading : RemoteSessionUiState

    public data class Ready public constructor(
        public val sessions: List<RemoteSession>,
        public val selectedSessionId: String?,
        public val timeline: ChatTimelineState?,
        public val busy: Boolean,
        public val permissionMode: SessionPermissionMode?,
        /** Null while the permission section is either loading or settled. */
        public val permissionModeFailure: PermissionModeFailure?,
        /** The search text the visible list was produced with; empty when unfiltered. */
        public val query: String,
        public val agentFilter: SessionAgentFilter,
        /** Whether another `list_sessions` page is worth asking for. */
        public val hasMore: Boolean,
        /** Whether the open transcript has an older page above what is visible. */
        public val hasMoreMessages: Boolean,
        /**
         * Desktop model choices are account/device facts, not session facts.
         *
         * Keeping the catalog beside the session list lets a new-session surface
         * offer the same model picker before any transcript has been opened.
         * It is null until a catalog loads successfully.
         */
        public val modelCatalog: RemoteModelCatalog?,
        /**
         * Non-null when catalog loading failed. [ModelCatalogFailure.LOAD_FAILED]
         * is the generic, retryable classification; [ModelCatalogFailure.UNSUPPORTED_BY_PEER]
         * is reserved for a future peer-capability signal the transport does not
         * yet produce.
         */
        public val modelCatalogFailure: ModelCatalogFailure?,
        public val draft: String,
        /** Monotonic authority revision for session-list projection on this store. */
        public val revision: Long,
        public val lastSentMessage: SentChatMessage?,
        public val permissionMailbox: PermissionMailboxUiState,
        public val historyLoadState: HistoryLoadState,
    ) : RemoteSessionUiState {
        public constructor(
            sessions: List<RemoteSession>, selectedSessionId: String?, timeline: ChatTimelineState?, busy: Boolean,
            permissionMode: SessionPermissionMode?, permissionModeFailure: PermissionModeFailure?, query: String,
            agentFilter: SessionAgentFilter, hasMore: Boolean, hasMoreMessages: Boolean,
            modelCatalog: RemoteModelCatalog?, modelCatalogFailure: ModelCatalogFailure?, draft: String,
            revision: Long, lastSentMessage: SentChatMessage?, permissionMailbox: PermissionMailboxUiState,
        ) : this(sessions, selectedSessionId, timeline, busy, permissionMode, permissionModeFailure, query,
            agentFilter, hasMore, hasMoreMessages, modelCatalog, modelCatalogFailure, draft, revision,
            lastSentMessage, permissionMailbox, HistoryLoadState.IDLE)
        public constructor(
            sessions: List<RemoteSession>, selectedSessionId: String?, timeline: ChatTimelineState?, busy: Boolean,
            permissionMode: SessionPermissionMode?, permissionModeFailure: PermissionModeFailure?, query: String,
            agentFilter: SessionAgentFilter, hasMore: Boolean, hasMoreMessages: Boolean,
            modelCatalog: RemoteModelCatalog?, modelCatalogFailure: ModelCatalogFailure?, draft: String,
            revision: Long, lastSentMessage: SentChatMessage?,
        ) : this(sessions, selectedSessionId, timeline, busy, permissionMode, permissionModeFailure, query,
            agentFilter, hasMore, hasMoreMessages, modelCatalog, modelCatalogFailure, draft, revision,
            lastSentMessage, PermissionMailboxUiState(emptyList(), false, false))

        /** Preserve the existing Swift/Kotlin initializer when adding acknowledgement state. */
        public constructor(
            sessions: List<RemoteSession>,
            selectedSessionId: String?,
            timeline: ChatTimelineState?,
            busy: Boolean,
            permissionMode: SessionPermissionMode?,
            permissionModeFailure: PermissionModeFailure?,
            query: String,
            agentFilter: SessionAgentFilter,
            hasMore: Boolean,
            hasMoreMessages: Boolean,
            modelCatalog: RemoteModelCatalog?,
            modelCatalogFailure: ModelCatalogFailure?,
            draft: String,
            revision: Long,
        ) : this(
            sessions, selectedSessionId, timeline, busy, permissionMode, permissionModeFailure,
            query, agentFilter, hasMore, hasMoreMessages, modelCatalog, modelCatalogFailure, draft, revision, null,
        )

        public constructor(
            sessions: List<RemoteSession>,
            selectedSessionId: String?,
            timeline: ChatTimelineState?,
            busy: Boolean,
            permissionMode: SessionPermissionMode?,
            permissionModeFailure: PermissionModeFailure?,
            query: String,
            agentFilter: SessionAgentFilter,
            hasMore: Boolean,
            hasMoreMessages: Boolean,
            modelCatalog: RemoteModelCatalog?,
            modelCatalogFailure: ModelCatalogFailure?,
            draft: String,
        ) : this(
            sessions, selectedSessionId, timeline, busy, permissionMode, permissionModeFailure,
            query, agentFilter, hasMore, hasMoreMessages, modelCatalog, modelCatalogFailure, draft, 0,
        )

        /**
         * The pre-catalog/pre-draft shape. A secondary constructor rather than
         * default arguments: Kotlin defaults do not survive into Swift, so an
         * iOS caller would be forced to name fields it does not use — see the
         * design doc §4.1.
         */
        public constructor(
            sessions: List<RemoteSession>,
            selectedSessionId: String?,
            timeline: ChatTimelineState?,
            busy: Boolean,
            permissionMode: SessionPermissionMode?,
            permissionModeFailure: PermissionModeFailure?,
            query: String,
            agentFilter: SessionAgentFilter,
            hasMore: Boolean,
            hasMoreMessages: Boolean,
            modelCatalog: RemoteModelCatalog?,
        ) : this(
            sessions = sessions, selectedSessionId = selectedSessionId, timeline = timeline, busy = busy,
            permissionMode = permissionMode, permissionModeFailure = permissionModeFailure,
            query = query, agentFilter = agentFilter, hasMore = hasMore, hasMoreMessages = hasMoreMessages,
            modelCatalog = modelCatalog, modelCatalogFailure = null, draft = "",
        )
    }

    /**
     * @param remoteMessage verbatim text from the desktop, present only for
     * [RemoteSessionFailureReason.REMOTE_REJECTED]. It was written by the peer,
     * so it is not and cannot be localized here; apps show it as supporting
     * detail under their own heading for the reason.
     */
    public data class Failed public constructor(
        public val reason: RemoteSessionFailureReason,
        public val remoteMessage: String?,
    ) : RemoteSessionUiState {
        /** Most reasons carry no detail; a secondary constructor because Swift ignores Kotlin defaults. */
        public constructor(reason: RemoteSessionFailureReason) : this(reason, null)
    }
}

public sealed interface RemoteSessionIntent {
    public data class StartQuestionInteraction(public val toolId: String) : RemoteSessionIntent
    public data class RespondPermission(public val requestId: String, public val approve: Boolean, public val updatedInput: String?) : RemoteSessionIntent
    public data object RefreshPermissionMailbox : RemoteSessionIntent

    /** Native lifecycle controls foreground connection health probes. */
    public data class SetForeground(public val active: Boolean) : RemoteSessionIntent

    public data object Load : RemoteSessionIntent

    public data object Refresh : RemoteSessionIntent

    /** Fetch the next page of the session list, keeping what is already shown. */
    public data object LoadMore : RemoteSessionIntent

    /** Fetch the transcript page immediately before the oldest visible message. */
    public data object LoadOlderMessages : RemoteSessionIntent

    /** Load one sidebar workspace branch without changing the desktop's active workspace. */
    /**
     * Load one workspace's sessions for the directory tree. With a [workspaceId]
     * only the ID is sent; the legacy fields are used only for rows that never
     * had an ID.
     */
    public data class LoadWorkspaceSessions public constructor(
        public val path: String,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        public val workspaceId: String?,
    ) : RemoteSessionIntent {
        public constructor(path: String, remoteConnectionId: String?, remoteSshHost: String?) : this(path, remoteConnectionId, remoteSshHost, null)
        public constructor(path: String) : this(path, null, null)
    }

    public data class RetryWorkspaceSessions public constructor(
        public val path: String,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        public val workspaceId: String?,
    ) : RemoteSessionIntent {
        public constructor(path: String, remoteConnectionId: String?, remoteSshHost: String?) : this(path, remoteConnectionId, remoteSshHost, null)
        public constructor(path: String) : this(path, null, null)
    }

    public data class Search public constructor(
        public val query: String,
    ) : RemoteSessionIntent

    public data class SetAgentFilter public constructor(
        public val filter: SessionAgentFilter,
    ) : RemoteSessionIntent

    public data class Open public constructor(
        public val sessionId: String,
    ) : RemoteSessionIntent

    /**
     * Create a session and open it.
     *
     * [instruction] is sent as the first message once the session exists, which
     * is how the HarmonyOS "new session with a prompt" flow works; an empty
     * instruction just leaves the session idle.
     */
    public data class CreateSession public constructor(
        public val agentType: String,
        public val title: String,
        public val instruction: String,
        public val modelId: String?,
        public val workspacePath: String?,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        /**
         * Target workspace by ID. When set, `create_session` carries only the ID;
         * [workspacePath] then only labels the in-flight operation. Null keeps
         * the legacy path projection for rows that never had an ID.
         */
        public val workspaceId: String?,
    ) : RemoteSessionIntent {
        public constructor(agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?, remoteConnectionId: String?, remoteSshHost: String?) : this(agentType, title, instruction, modelId, workspacePath, remoteConnectionId, remoteSshHost, null)
        public constructor(agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?, remoteConnectionId: String?) : this(agentType, title, instruction, modelId, workspacePath, remoteConnectionId, null)
        public constructor(agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?) : this(agentType, title, instruction, modelId, workspacePath, null)
        public constructor(
            agentType: String,
            title: String,
            instruction: String,
            modelId: String?,
        ) : this(agentType, title, instruction, modelId, null)

        public constructor(agentType: String) : this(agentType, "", "", null, null)
    }

    /** Create with an identity that Swift can retain and correlate with its UI. */
    public data class CreateSessionOperation public constructor(
        public val requestId: String,
        public val agentType: String,
        public val title: String,
        public val instruction: String,
        public val modelId: String?,
        public val workspacePath: String?,
        public val remoteConnectionId: String?,
        public val remoteSshHost: String?,
        public val workspaceId: String?,
    ) : RemoteSessionIntent {
        public constructor(requestId: String, agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?, remoteConnectionId: String?, remoteSshHost: String?) : this(requestId, agentType, title, instruction, modelId, workspacePath, remoteConnectionId, remoteSshHost, null)
        public constructor(requestId: String, agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?, remoteConnectionId: String?) : this(requestId, agentType, title, instruction, modelId, workspacePath, remoteConnectionId, null)
        public constructor(requestId: String, agentType: String, title: String, instruction: String, modelId: String?, workspacePath: String?) : this(requestId, agentType, title, instruction, modelId, workspacePath, null)
        public constructor(
            requestId: String,
            agentType: String,
            title: String,
            instruction: String,
            modelId: String?,
        ) : this(requestId, agentType, title, instruction, modelId, null)
    }

    public data class DeleteSession public constructor(
        public val sessionId: String,
    ) : RemoteSessionIntent

    public data class RenameSession public constructor(
        public val sessionId: String,
        public val title: String,
    ) : RemoteSessionIntent

    /** Answer a tool that asked the user a question, rather than approving it. */
    public data class AnswerQuestion public constructor(
        public val sessionId: String,
        public val toolId: String,
        public val answer: String,
    ) : RemoteSessionIntent

    public data class AnswerStructuredQuestion public constructor(
        public val sessionId: String,
        public val toolId: String,
        public val answers: List<QuestionAnswer>,
    ) : RemoteSessionIntent

    public data class UpdateDraft public constructor(
        public val text: String,
    ) : RemoteSessionIntent

    public data class SendMessage public constructor(
        public val sessionId: String,
        public val content: String,
        public val images: List<ComposerImage>?,
    ) : RemoteSessionIntent {
        public constructor(sessionId: String, content: String) : this(sessionId, content, null)
    }

    public data class BuildPlan public constructor(
        public val sessionId: String,
        public val path: String,
        public val name: String,
    ) : RemoteSessionIntent

    public data class CancelTurn public constructor(
        public val sessionId: String,
        public val turnId: String?,
    ) : RemoteSessionIntent

    public data class ApproveTool public constructor(
        public val sessionId: String,
        public val toolId: String,
        public val updatedInput: String?,
    ) : RemoteSessionIntent {
        public constructor(sessionId: String, toolId: String) : this(sessionId, toolId, null)
    }

    public data class RejectTool public constructor(
        public val sessionId: String,
        public val toolId: String,
        public val reason: String,
    ) : RemoteSessionIntent

    public data class CancelTool public constructor(
        public val sessionId: String,
        public val toolId: String,
        public val reason: String,
    ) : RemoteSessionIntent

    /**
     * No session id: `set_permission_mode` is addressed to the desktop, not to
     * one of its sessions, and the mode it sets applies to every session on it.
     */
    public data class SetPermissionMode public constructor(
        public val mode: SessionPermissionMode,
    ) : RemoteSessionIntent

    /**
     * Ask the desktop for its permission mode again.
     *
     * Separate from [Load] because it must not touch the session list: it is
     * both what the settings page asks on open and the retry it offers once a
     * load or a save has failed.
     */
    public data object RefreshPermissionMode : RemoteSessionIntent

    /**
     * Re-read the desktop's model catalog without touching the session list or
     * the open transcript, as [RefreshPermissionMode] does for the permission
     * mode.
     *
     * The store supplies the currently selected session id so the host also
     * returns that session's authoritative model selection. Callers do not
     * carry an id that could become stale after navigation.
     */
    public data object RefreshModelCatalog : RemoteSessionIntent

    public data class SelectModel public constructor(
        public val sessionId: String,
        public val modelId: String,
    ) : RemoteSessionIntent

    public data object Stop : RemoteSessionIntent
}
