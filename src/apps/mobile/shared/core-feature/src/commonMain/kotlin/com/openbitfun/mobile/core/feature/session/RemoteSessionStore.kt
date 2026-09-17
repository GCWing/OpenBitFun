package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.transport.RelayTransportException
import com.openbitfun.mobile.core.transport.RelayFailure
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.belongsTo
import com.openbitfun.mobile.core.persistence.PersistedWorkspaceIdentity

import com.openbitfun.mobile.core.feature.relay.HostCatalogNotice

import com.openbitfun.mobile.core.domain.ChatSyncPhase
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.domain.ChatSessionCursor
import com.openbitfun.mobile.core.domain.ChatTimelineStore
import com.openbitfun.mobile.core.persistence.MobilePersistenceStores
import com.openbitfun.mobile.core.persistence.PersistedRemoteCursor
import com.openbitfun.mobile.core.persistence.PersistedRemoteMessage
import com.openbitfun.mobile.core.persistence.PersistedRemoteSession
import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.SessionNaming
import com.openbitfun.mobile.core.domain.SessionListVisibility
import com.openbitfun.mobile.core.domain.TranscriptIntegrityPolicy
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.protocol.ActiveTurnSnapshotResponse
import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.ChatMessageResponse
import com.openbitfun.mobile.core.protocol.CreateSessionResponse
import com.openbitfun.mobile.core.protocol.InitialSyncResponse
import com.openbitfun.mobile.core.protocol.ImageAttachment
import com.openbitfun.mobile.core.protocol.ModelCatalogResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.protocol.RemotePermissionMode
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog
import com.openbitfun.mobile.core.protocol.isError
import com.openbitfun.mobile.core.protocol.CommandStatusResponse
import com.openbitfun.mobile.core.protocol.PermissionModeResponse
import com.openbitfun.mobile.core.protocol.SetSessionModelResponse
import com.openbitfun.mobile.core.protocol.SendMessageResponse
import com.openbitfun.mobile.core.protocol.SessionItemResponse
import com.openbitfun.mobile.core.protocol.SessionListResponse
import com.openbitfun.mobile.core.protocol.WorkspaceInfoResponse
import com.openbitfun.mobile.core.feature.relay.PersistentSessionReplica
import com.openbitfun.mobile.core.transport.RemoteSessionStreamTransport
import kotlinx.coroutines.flow.collect
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import com.openbitfun.mobile.core.transport.send
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceStore
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import kotlin.time.Clock

/** The remote session feature: the session list plus the conversation that is open. */
public class RemoteSessionStore internal constructor(
    private val scope: CoroutineScope,
    private val transport: RemoteCommandTransport,
    private val deviceKey: String? = null,
    private val persistence: MobilePersistenceStores? = null,
    private val relayStreamStore: com.openbitfun.mobile.core.persistence.RelayStreamStore? = persistence?.relayStreams,
) {
    private var catalogSubscription: Job? = null
    private var catalogRefresh: Job? = null
    private var catalogDirty = false
    internal fun bindCatalog(changes: kotlinx.coroutines.flow.Flow<HostCatalogNotice>) {
        catalogSubscription?.cancel()
        catalogSubscription = scope.launch { changes.collect { notice ->
            if (notice == HostCatalogNotice.Changed) refreshCatalog() else _connectionPhase.value = ConnectionPhase.RECONNECTING
        } }
    }
    private fun refreshCatalog() {
        catalogDirty = true
        if (catalogRefresh?.isActive == true) return
        catalogRefresh = scope.launch {
            while (catalogDirty) {
                catalogDirty = false
                val before = _state.value as? RemoteSessionUiState.Ready ?: run { catalogDirty = true; return@launch }
                try {
                    val page = listSessions(0, before.query, before.agentFilter, maxOf(PAGE_SIZE, before.sessions.size))
                    val latest = _state.value as? RemoteSessionUiState.Ready ?: return@launch
                    if (latest.query == before.query && latest.agentFilter == before.agentFilter) {
                        commitSessionPage(page)
                        if (persistenceEnabled && before.query.isEmpty() && before.agentFilter == SessionAgentFilter.ALL) savePersistedSessions(page.sessions, page.hasMore)
                        publishAuthorityReady(latest.copy(sessions = page.sessions, hasMore = page.hasMore))
                        refreshModelCatalog(invalidated = true)
                        markConnected()
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Throwable) { _connectionPhase.value = ConnectionPhase.RECONNECTING }
            }
        }
    }
    private val persistenceEnabled: Boolean get() = persistence != null && !deviceKey.isNullOrBlank()
    private val _state = MutableStateFlow<RemoteSessionUiState>(RemoteSessionUiState.Idle)
    public val state: StateFlow<RemoteSessionUiState> = _state.asStateFlow()
    private val _connectionPhase = MutableStateFlow(ConnectionPhase.IDLE)
    public val connectionPhase: StateFlow<ConnectionPhase> = _connectionPhase.asStateFlow()
    private val _createOperation = MutableStateFlow<CreateSessionOperationState>(CreateSessionOperationState.Idle)
    /** Outcome is changed only by create operations, never by open/list selection. */
    public val createOperation: StateFlow<CreateSessionOperationState> = _createOperation.asStateFlow()
    private val _workspaceDirectory = MutableStateFlow(WorkspaceSessionDirectoryUiState(emptyList()))
    public val workspaceDirectory: StateFlow<WorkspaceSessionDirectoryUiState> = _workspaceDirectory.asStateFlow()
    private var nextCreateRequestId: Long = 0
    private var nextCreateGeneration: Long = 0
    private var activeCreateGeneration: Long? = null
    private var authorityRevision: Long = 0
    private var workGeneration: Long = 0
    private var modelCatalogRefresh: Job? = null
    private var modelCatalogDirty = false
    private var permissionRefresh: Job? = null
    private val timelineStore = ChatTimelineStore()
    private val permissionMailbox = PermissionMailboxStore(scope, transport) { mailbox ->
        val ready = _state.value as? RemoteSessionUiState.Ready
        if (ready != null) _state.value = ready.copy(permissionMailbox = mailbox)
    }
    private var sessionUpdates: Job? = null
    private var work: Job? = null
    private var historyWork: Job? = null
    private var historyGeneration = 0L
    private var healthWork: Job? = null
    private var healthGeneration: Long = 0
    private var modelCatalog: RemoteModelCatalog? = null
    private var modelCatalogFailure: ModelCatalogFailure? = null
    private val locallyCreatedSessions: MutableMap<String, RemoteSession> = mutableMapOf()
    private val workspaceDirectoryJobs: MutableMap<String, Job> = mutableMapOf()
    private val workspaceDirectoryGenerations: MutableMap<String, Long> = mutableMapOf()

    /**
     * The re-read of the transcript that follows a turn ending.
     *
     * Its own job rather than [work]: it must not cancel, or be cancelled by, the
     * list request a user action started, and the settle window fires the request
     * repeatedly — one in flight is enough.
     */

    /**
     * The workspace the desktop currently has open, learned from `get_workspace_info`.
     *
     * `list_sessions` and `create_session` are rejected outright when this is
     * missing, so it is resolved before either is sent rather than passed down
     * from the UI — the same shape as `RemoteSessionManager.workspace`.
     */
    private var workspaceConnectionId: String? = null
    private var workspaceSshHost: String? = null
    private var workspacePath: String = ""
    private var hostCapabilities: List<String> = emptyList()

    public fun dispatch(intent: RemoteSessionIntent) {
        val current = _state.value as? RemoteSessionUiState.Ready
        when (intent) {
            is RemoteSessionIntent.StartQuestionInteraction -> permissionMailbox.startQuestion(intent.toolId)
            is RemoteSessionIntent.RespondPermission -> permissionMailbox.respond(intent.requestId, intent.approve, intent.updatedInput)
            RemoteSessionIntent.RefreshPermissionMailbox -> permissionMailbox.invalidate()
            is RemoteSessionIntent.SetForeground -> setForeground(intent.active)
            RemoteSessionIntent.Load, RemoteSessionIntent.Refresh ->
                load(current?.query.orEmpty(), current?.agentFilter ?: SessionAgentFilter.ALL)
            RemoteSessionIntent.LoadMore -> loadMore()
            RemoteSessionIntent.LoadOlderMessages -> loadOlderMessages()
            is RemoteSessionIntent.LoadWorkspaceSessions -> loadWorkspaceSessions(intent.path, false, intent.remoteConnectionId, intent.remoteSshHost)
            is RemoteSessionIntent.RetryWorkspaceSessions -> loadWorkspaceSessions(intent.path, true, intent.remoteConnectionId, intent.remoteSshHost)
            is RemoteSessionIntent.Search ->
                load(intent.query, current?.agentFilter ?: SessionAgentFilter.ALL)
            is RemoteSessionIntent.SetAgentFilter -> load(current?.query.orEmpty(), intent.filter)
            is RemoteSessionIntent.Open -> open(intent.sessionId)
            is RemoteSessionIntent.CreateSession -> createSession(intent, nextRequestId())
            is RemoteSessionIntent.CreateSessionOperation -> createSession(
                RemoteSessionIntent.CreateSession(
                    intent.agentType, intent.title, intent.instruction, intent.modelId, intent.workspacePath, intent.remoteConnectionId, intent.remoteSshHost,
                ),
                intent.requestId.trim().ifEmpty { nextRequestId() },
            )
            is RemoteSessionIntent.DeleteSession -> deleteSession(intent.sessionId)
            is RemoteSessionIntent.RenameSession -> renameSession(intent)
            is RemoteSessionIntent.AnswerQuestion -> runAction(
                intent.sessionId,
                RemoteCommand(
                    cmd = "answer_question",
                    toolId = intent.toolId,
                    // The desktop forwards this opaquely to the tool. Both spellings
                    // are what `RemoteQuestionAnswerPayload` sends from HarmonyOS.
                    answers = buildJsonObject {
                        put("answer", intent.answer)
                        put("0", intent.answer)
                    },
                ),
            )
            is RemoteSessionIntent.AnswerStructuredQuestion -> runAction(
                intent.sessionId,
                RemoteCommand(
                    cmd = "answer_question",
                    toolId = intent.toolId,
                    answers = buildJsonObject {
                        intent.answers.forEach { answer ->
                            put(
                                answer.index.toString(),
                                when (val value = answer.value) {
                                    is QuestionAnswerValue.Text -> JsonPrimitive(value.text)
                                    is QuestionAnswerValue.Choice -> JsonArray(value.values.map(::JsonPrimitive))
                                },
                            )
                        }
                    },
                ),
            )
            is RemoteSessionIntent.UpdateDraft -> updateDraft(intent.text)
            is RemoteSessionIntent.SendMessage -> sendMessage(intent)
            is RemoteSessionIntent.BuildPlan -> {
                // Native plan cards expose the unsupported state. A stale or direct
                // intent must not discard the live transcript or its draft.
                if ("plan_build_v1" in hostCapabilities && current?.timeline?.activeTurn == null && intent.path.isNotBlank()) {
                    sendMessage(RemoteSessionIntent.SendMessage(intent.sessionId, "Build Plan: ${intent.name}"), intent)
                }
            }
            is RemoteSessionIntent.CancelTurn -> cancelTurn(intent)
            is RemoteSessionIntent.ApproveTool -> approveTool(intent)
            is RemoteSessionIntent.RejectTool -> runAction(
                intent.sessionId,
                RemoteCommand(cmd = "reject_tool", toolId = intent.toolId, reason = intent.reason),
            )
            is RemoteSessionIntent.CancelTool -> runAction(
                intent.sessionId,
                RemoteCommand(cmd = "cancel_tool", toolId = intent.toolId, reason = intent.reason),
            )
            is RemoteSessionIntent.SetPermissionMode -> setPermissionMode(intent)
            is RemoteSessionIntent.RefreshPermissionMode -> refreshPermissionMode()
            RemoteSessionIntent.RefreshModelCatalog -> refreshModelCatalog()
            is RemoteSessionIntent.SelectModel -> selectModel(intent)
            RemoteSessionIntent.Stop -> stop()
        }
    }

    private fun nextRequestId(): String {
        nextCreateRequestId += 1
        return "create-${nextCreateRequestId}"
    }

    /**
     * Validates the assistant on this target and creates in its explicit workspace.
     * Session creation does not change the runtime's current workspace.
     */
    public fun createAssistantSession(
        workspaceStore: RemoteWorkspaceStore,
        requestId: String,
        assistantPath: String,
        title: String,
        instruction: String,
        modelId: String?,
    ) {
        val normalizedRequestId = requestId.trim().ifEmpty { nextRequestId() }
        val normalizedPath = assistantPath.trim()
        if (workspaceStore.deviceKey == null || workspaceStore.deviceKey != deviceKey) {
            _createOperation.value = CreateSessionOperationState.Failed(
                normalizedRequestId, CreateSessionOperationFailure.DEVICE_MISMATCH, false, false,
            )
            return
        }
        if (normalizedPath.isEmpty()) {
            _createOperation.value = CreateSessionOperationState.Failed(
                normalizedRequestId, CreateSessionOperationFailure.WORKSPACE, true, false,
            )
            return
        }
        _createOperation.value = CreateSessionOperationState.InFlight(normalizedRequestId, deviceKey, normalizedPath)
        nextCreateGeneration += 1
        activeCreateGeneration = nextCreateGeneration
        val generation = nextCreateGeneration
        val stopVersion = workspaceStore.stopVersion.value
        val operationToken = beginWork()
        work = scope.launch {
            try {
                if (workspaceStore.stopVersion.value != stopVersion) {
                    cancelCreateIfActive(normalizedRequestId, generation, CreateSessionOperationFailure.CANCELLED)
                    return@launch
                }
                if (workspaceStore.state.value is RemoteWorkspaceUiState.Idle) {
                    workspaceStore.dispatch(RemoteWorkspaceIntent.Load)
                }
                val beforeSelection = withTimeout(30_000) {
                    workspaceStore.state.first { state ->
                        workspaceStore.stopVersion.value != stopVersion || when (state) {
                            is RemoteWorkspaceUiState.Ready -> !state.busy
                            is RemoteWorkspaceUiState.Failed -> true
                            else -> false
                        }
                    }
                }
                if (!isCurrentWork(operationToken) || activeCreateGeneration != generation) return@launch
                if (workspaceStore.stopVersion.value != stopVersion) {
                    cancelCreateIfActive(normalizedRequestId, generation, CreateSessionOperationFailure.CANCELLED)
                    return@launch
                }
                if (beforeSelection !is RemoteWorkspaceUiState.Ready || beforeSelection.loadFailure) {
                    failCreate(normalizedRequestId, generation, CreateSessionOperationFailure.WORKSPACE, true, false)
                    return@launch
                }
                if (beforeSelection.assistants.none { it.path == normalizedPath }) {
                    failCreate(normalizedRequestId, generation, CreateSessionOperationFailure.WORKSPACE, false, false)
                    return@launch
                }
                work = null
                createSession(
                    RemoteSessionIntent.CreateSession(
                        agentType = "Claw",
                        title = title,
                        instruction = instruction,
                        modelId = modelId,
                        workspacePath = normalizedPath,
                    ),
                    normalizedRequestId,
                )
            } catch (cancelled: CancellationException) {
                cancelCreateIfActive(normalizedRequestId, generation, CreateSessionOperationFailure.CANCELLED)
                throw cancelled
            } catch (_: Throwable) {
                if (isCurrentWork(operationToken)) {
                    failCreate(normalizedRequestId, generation, CreateSessionOperationFailure.WORKSPACE, true, false)
                }
            }
        }
    }

    /**
     * Accepts a create result already confirmed by the owning remote device.
     * The supplied projection is authoritative, including its own workspace;
     * no active-workspace state is consulted. Repeating the same id is idempotent.
     */
    public fun reconcileConfirmedCreatedSession(session: RemoteSession): Boolean {
        beginWork()
        return projectConfirmedCreatedSession(session)
    }

    /** Last device-scoped list stored on disk, used by the multi-device directory without a request. */
    internal fun cachedSessions(): List<RemoteSession> {
        if (!persistenceEnabled) return emptyList()
        val rows = persistedSessionSlice()?.sessions.orEmpty()
        restorePendingConfirmed(rows)
        return rows.map(::toRemoteSession)
    }

    /** Loads one disclosed workspace without changing the desktop's active workspace. */
    internal suspend fun sessionsForWorkspace(path: String, remoteConnectionId: String? = null, remoteSshHost: String? = null): List<RemoteSession> {
        val identity = RemoteWorkspaceIdentity(path, remoteConnectionId, remoteSshHost)
        val normalizedPath = path.trim()
        if (normalizedPath.isEmpty()) return emptyList()
        val response = transport.send<SessionListResponse>(
            RemoteCommand(
                cmd = "list_sessions",
                workspacePath = normalizedPath,
                remoteConnectionId = remoteConnectionId,
                remoteSshHost = remoteSshHost,
                limit = DIRECTORY_WORKSPACE_PAGE_SIZE,
                offset = 0,
            ),
        )
        val server = response.sessions
            .map(RemoteResponseMapper::session)
            .filter { SessionListVisibility.isMobileVisible(it) }
            .map { session ->
                session.copy(workspacePath = session.workspacePath?.takeIf { it.isNotBlank() } ?: normalizedPath, workspaceIdentity = identity)
            }
        val serverIds = server.mapTo(mutableSetOf()) { it.id }
        serverIds.forEach(locallyCreatedSessions::remove)
        val pending = locallyCreatedSessions.values.filter { session ->
            session.id !in serverIds && session.belongsTo(identity, listOf(identity))
        }
        return pending + server
    }

    /** Persists the directory's merged cross-workspace snapshot for offline restore. */
    internal fun persistDirectorySessions(sessions: List<RemoteSession>) {
        savePersistedSessions(sessions, false)
    }

    private fun loadWorkspaceSessions(path: String, force: Boolean, remoteConnectionId: String?, remoteSshHost: String?) {
        val normalizedPath = normalizeWorkspacePath(path)
        if (normalizedPath.isEmpty()) return
        val identity = RemoteWorkspaceIdentity(normalizedPath, remoteConnectionId, remoteSshHost)
        val key = identity.key
        if (workspaceDirectoryJobs[key]?.isActive == true) return
        val existing = _workspaceDirectory.value.workspace(normalizedPath, remoteConnectionId, remoteSshHost)
        if (!force && existing?.status == WorkspaceSessionDirectoryStatus.READY) return
        val generation = (workspaceDirectoryGenerations[key] ?: 0L) + 1L
        workspaceDirectoryGenerations[key] = generation
        updateWorkspaceDirectory(identity) {
            it.copy(status = WorkspaceSessionDirectoryStatus.LOADING)
        }
        val job = scope.launch {
            try {
                val loaded = sessionsForWorkspace(normalizedPath, remoteConnectionId, remoteSshHost)
                if (workspaceDirectoryGenerations[key] != generation) return@launch
                if (persistenceEnabled) {
                    val cached = cachedSessions()
                    persistDirectorySessions(replaceWorkspaceSessions(cached, identity, loaded))
                }
                updateWorkspaceDirectory(identity) {
                    it.copy(status = WorkspaceSessionDirectoryStatus.READY, sessions = loaded)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (workspaceDirectoryGenerations[key] == generation) {
                    updateWorkspaceDirectory(identity) {
                        it.copy(status = WorkspaceSessionDirectoryStatus.FAILED)
                    }
                }
            } finally {
                if (workspaceDirectoryJobs[key] === coroutineContext[Job]) {
                    workspaceDirectoryJobs.remove(key)
                }
            }
        }
        workspaceDirectoryJobs[key] = job
        if (!job.isActive && workspaceDirectoryJobs[key] === job) {
            workspaceDirectoryJobs.remove(key)
        }
    }

    private fun updateWorkspaceDirectory(
        identity: RemoteWorkspaceIdentity,
        transform: (WorkspaceSessionDirectoryEntry) -> WorkspaceSessionDirectoryEntry,
    ) {
        var found = false
        val entries = _workspaceDirectory.value.workspaces.map { entry ->
            if (entry.identity.matches(identity)) {
                found = true
                transform(entry)
            } else {
                entry
            }
        }.toMutableList()
        if (!found) {
            entries += transform(
                WorkspaceSessionDirectoryEntry(identity.path, WorkspaceSessionDirectoryStatus.IDLE, emptyList(), identity.remoteConnectionId, identity.remoteSshHost),
            )
        }
        _workspaceDirectory.value = WorkspaceSessionDirectoryUiState(entries)
    }

    private fun replaceWorkspaceSessions(
        sessions: List<RemoteSession>,
        identity: RemoteWorkspaceIdentity,
        replacement: List<RemoteSession>,
    ): List<RemoteSession> {
        val replacementIds = replacement.mapTo(mutableSetOf()) { it.id }
        val retained = sessions.filter { session ->
            session.id !in replacementIds &&
                !session.belongsTo(identity, _workspaceDirectory.value.workspaces.map { it.identity })
        }
        return replacement + retained
    }

    private fun normalizeWorkspacePath(path: String): String {
        val trimmed = path.trim()
        val normalized = trimmed.trimEnd('/')
        return normalized.ifEmpty { trimmed }
    }

    private fun projectConfirmedCreatedSession(session: RemoteSession): Boolean {
        val sessionId = session.id.trim()
        if (sessionId.isEmpty()) return false
        val confirmed = if (sessionId == session.id) session else session.copy(id = sessionId)
        locallyCreatedSessions[sessionId] = confirmed
        val current = _state.value as? RemoteSessionUiState.Ready
        if (current != null) {
            publishAuthorityReady(current.copy(sessions = mergeConfirmed(current.sessions, confirmed)))
        }
        persistedSessionSlice()?.let { persisted ->
            val persistedRows = persisted.sessions
            restorePendingConfirmed(persistedRows)
            savePersistedSessions(
                mergeConfirmed(persistedRows.map(::toRemoteSession), confirmed),
                persisted.hasMore,
            )
        }
        return true
    }

    private fun publishCommittedCreate(session: RemoteSession, previous: RemoteSessionUiState.Ready?): Long {
        projectConfirmedCreatedSession(session)
        if (_state.value !is RemoteSessionUiState.Ready) {
            publishAuthorityReady(RemoteSessionUiState.Ready(
                sessions = listOf(session),
                selectedSessionId = session.id,
                timeline = null,
                busy = true,
                permissionMode = previous?.permissionMode,
                permissionModeFailure = previous?.permissionModeFailure,
                query = previous?.query.orEmpty(),
                agentFilter = previous?.agentFilter ?: SessionAgentFilter.ALL,
                hasMore = previous?.hasMore ?: false,
                hasMoreMessages = false,
                modelCatalog = modelCatalog ?: previous?.modelCatalog,
                modelCatalogFailure = modelCatalogFailure ?: previous?.modelCatalogFailure,
                draft = "",
            ))
        }
        return (_state.value as RemoteSessionUiState.Ready).revision
    }

    private fun publishAuthorityReady(ready: RemoteSessionUiState.Ready): Long {
        authorityRevision += 1
        _state.value = ready.copy(revision = authorityRevision)
        return authorityRevision
    }

    private fun beginWork(): Long {
        workGeneration += 1
        work?.cancel()
        historyWork?.cancel()
        modelCatalogRefresh?.cancel()
        permissionRefresh?.cancel()
        return workGeneration
    }

    private fun isCurrentWork(token: Long): Boolean = token == workGeneration

    public fun stop() {
        catalogSubscription?.cancel(); catalogRefresh?.cancel()
        permissionMailbox.select(null)
        setForeground(false)
        activeCreateGeneration?.let { generation ->
            val requestId = (_createOperation.value as? CreateSessionOperationState.InFlight)?.requestId
            if (requestId != null) {
                _createOperation.value = CreateSessionOperationState.Cancelled(
                    requestId, CreateSessionOperationFailure.CANCELLED,
                )
            }
            activeCreateGeneration = null
        }
        beginWork()
        work = null
        workspaceDirectoryJobs.values.forEach(Job::cancel)
        workspaceDirectoryJobs.clear()
        workspaceDirectoryGenerations.keys.forEach { path ->
            workspaceDirectoryGenerations[path] = (workspaceDirectoryGenerations[path] ?: 0L) + 1L
        }
        _workspaceDirectory.value = WorkspaceSessionDirectoryUiState(
            _workspaceDirectory.value.workspaces.map { entry ->
                if (entry.status == WorkspaceSessionDirectoryStatus.LOADING) {
                    entry.copy(status = WorkspaceSessionDirectoryStatus.IDLE)
                } else {
                    entry
                }
            },
        )
        sessionUpdates?.cancel()
        _connectionPhase.value = ConnectionPhase.DISCONNECTED
    }

    private fun load(query: String, filter: SessionAgentFilter) {
        if (_state.value is RemoteSessionUiState.Loading) return
        val current = _state.value as? RemoteSessionUiState.Ready
        if (current == null && persistenceEnabled) {
            val cachedSlice = persistedSessionSlice()
            val cached = cachedSlice?.sessions.orEmpty()
            restorePendingConfirmed(cached)
            if (cached.isNotEmpty()) {
                publishAuthorityReady(RemoteSessionUiState.Ready(
                    sessions = cached.map(::toRemoteSession), selectedSessionId = null, timeline = null,
                    busy = true, permissionMode = null, permissionModeFailure = null,
                    query = query, agentFilter = filter,
                    hasMore = cachedSlice?.hasMore ?: false, hasMoreMessages = false,
                    modelCatalog = null,
                ))
            }
        }
        if (current == null) _connectionPhase.value = ConnectionPhase.CONNECTING
        val generation = beginWork()
        // Searching or switching tabs keeps the list on screen; only a cold start
        // blanks it, so typing in the search box does not flash a spinner.
        _state.value = (_state.value as? RemoteSessionUiState.Ready)?.copy(busy = true, query = query, agentFilter = filter)
            ?: RemoteSessionUiState.Loading
        work = scope.launch {
            try {
                val workspaceResolved = resolveWorkspacePath(generation)
                if (!isCurrentWork(generation)) return@launch
                if (!workspaceResolved) {
                    failKnown(RemoteSessionFailureReason.NO_WORKSPACE, current)
                    return@launch
                }
                // Catalog enrichment must not gate navigation or transcript loading.
                // Keep it a child of this load so replacing/stopping the load cancels
                // it, but publish the authoritative session page before awaiting it.
                val catalogRequest = async { loadModelCatalog(force = false) }
                val page = listSessions(0, query, filter)
                if (!isCurrentWork(generation)) return@launch
                commitSessionPage(page)
                if (persistenceEnabled && query.isEmpty() && filter == SessionAgentFilter.ALL) {
                    savePersistedSessions(page.sessions, page.hasMore)
                }
                if (generation != workGeneration) return@launch
                publishAuthorityReady(RemoteSessionUiState.Ready(
                    sessions = page.sessions,
                    selectedSessionId = current?.selectedSessionId,
                    timeline = currentTimeline(),
                    busy = false,
                    permissionMode = current?.permissionMode,
                    permissionModeFailure = current?.permissionModeFailure,
                    query = query,
                    agentFilter = filter,
                    hasMore = page.hasMore,
                    hasMoreMessages = current?.hasMoreMessages ?: false,
                    modelCatalog = modelCatalog ?: current?.modelCatalog,
                    modelCatalogFailure = modelCatalogFailure,
                    draft = current?.draft ?: "",
                ))
                markConnected()
                val catalog = catalogRequest.await()
                if (!isCurrentWork(generation)) return@launch
                commitModelCatalog(catalog)
                val ready = _state.value as? RemoteSessionUiState.Ready ?: return@launch
                _state.value = ready.copy(
                    modelCatalog = catalog.catalog ?: ready.modelCatalog,
                    modelCatalogFailure = catalog.failure,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(generation)) {
                    handleFailure(error, _state.value as? RemoteSessionUiState.Ready)
                }
            }
        }
    }

    private fun loadMore() {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (!current.hasMore || current.busy) return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                val page = listSessions(current.sessions.size, current.query, current.agentFilter)
                if (!isCurrentWork(operationToken)) return@launch
                val known = current.sessions.mapTo(mutableSetOf()) { it.id }
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                val sessions = current.sessions + page.sessions.filterNot { it.id in known }
                commitSessionPage(page)
                if (persistenceEnabled && current.query.isEmpty() && current.agentFilter == SessionAgentFilter.ALL) {
                    savePersistedSessions(sessions, page.hasMore)
                }
                publishAuthorityReady(ready.copy(
                    sessions = sessions,
                    hasMore = page.hasMore,
                    busy = false,
                ))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (isCurrentWork(operationToken)) {
                    setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                }
            }
        }
    }

    /**
     * Reads the desktop's open workspace, returning false when it has none.
     *
     * Checking here rather than letting `list_sessions` fail keeps the reason a
     * typed one: the desktop answers a missing workspace with a prose message
     * that the phone would otherwise have to pattern-match.
     */
    private suspend fun resolveWorkspacePath(operationToken: Long): Boolean {
        val info = transport.send<WorkspaceInfoResponse>(RemoteCommand(cmd = "get_workspace_info"))
        if (!isCurrentWork(operationToken)) return false
        workspacePath = (info.path ?: info.workspacePath).orEmpty().trim()
        workspaceConnectionId = info.remoteConnectionId
        workspaceSshHost = info.remoteSshHost
        hostCapabilities = info.capabilities
        return workspacePath.isNotEmpty() && workspacePath != "/"
    }

    private suspend fun listSessions(offset: Int, query: String, filter: SessionAgentFilter, count: Int = PAGE_SIZE): SessionPage {
        val trimmedQuery = query.trim()
        val identity = RemoteWorkspaceIdentity(workspacePath, workspaceConnectionId, workspaceSshHost)
        // `list_sessions` cannot apply either the mobile ACP visibility rule or
        // the agent tab. Pull from the start until there are enough visible rows
        // so an invisible server row never creates a short page or a dishonest
        // `hasMore` result.
        val targetCount = offset + count
        val filtered = mutableListOf<RemoteSession>()
        var pageOffset = 0
        var hasMore = true
        val pageSize = if (filter == SessionAgentFilter.ALL) PAGE_SIZE else FILTER_PAGE_SIZE
        while (hasMore && filtered.size < targetCount) {
            val response = sendListSessions(pageSize, pageOffset, trimmedQuery, identity)
            val sessions = response.sessions.map(RemoteResponseMapper::session).map { it.copy(workspaceIdentity = identity) }
            sessions.filterTo(filtered) {
                SessionListVisibility.isMobileVisible(it) && filter.matches(it.agentType)
            }
            hasMore = response.hasMore
            pageOffset += sessions.size
            if (sessions.isEmpty()) break
        }
        val serverIds = filtered.mapTo(mutableSetOf()) { it.id }
        val projected = mergeLocallyCreated(filtered, trimmedQuery, filter)
        return SessionPage(
            sessions = projected.subList(minOf(offset, projected.size), minOf(targetCount, projected.size)).toList(),
            hasMore = projected.size > targetCount || hasMore,
            confirmedServerIds = serverIds,
        )
    }

    private fun mergeConfirmed(sessions: List<RemoteSession>, confirmed: RemoteSession): List<RemoteSession> =
        listOf(confirmed) + sessions.filterNot { it.id == confirmed.id }

    private fun mergeLocallyCreated(
        sessions: List<RemoteSession>,
        query: String,
        filter: SessionAgentFilter,
    ): List<RemoteSession> {
        val known = sessions.mapTo(mutableSetOf()) { it.id }
        val local = locallyCreatedSessions.values.filter { session ->
            session.id !in known &&
                SessionListVisibility.isMobileVisible(session) &&
                filter.matches(session.agentType) &&
                (query.isEmpty() || session.title.contains(query, ignoreCase = true) ||
                    session.workspaceName.orEmpty().contains(query, ignoreCase = true) ||
                    session.workspacePath.orEmpty().contains(query, ignoreCase = true))
        }
        return local + sessions
    }

    /**
     * A model catalog is useful before a session exists. Failure is deliberately
     * non-fatal: the create screen hides the picker and every other remote
     * feature remains available.
     *
     * Every catalog failure is typed as [ModelCatalogFailure.LOAD_FAILED] until
     * the transport exposes a distinguishing peer-capability signal. A generic
     * rejection or malformed response is not proof of an old peer: a modern
     * desktop can reject the command transiently, and a malformed response can be
     * a local protocol fault.
     *
     * [force] re-requests even when a catalog is already cached, which is how a
     * settings retry reaches a catalog that a transient failure lost.
     */
    private suspend fun loadModelCatalog(force: Boolean, sessionId: String? = null): ModelCatalogLoadResult {
        if (!force) {
            modelCatalog?.let { return ModelCatalogLoadResult(it, null) }
        }
        return try {
            val catalog = transport.send<ModelCatalogResponse>(RemoteCommand(cmd = "get_model_catalog", sessionId = sessionId)).catalog
                ?.takeUnless { it.version == 0L && it.models.isEmpty() }
            ModelCatalogLoadResult(catalog, null)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            ModelCatalogLoadResult(null, ModelCatalogFailure.LOAD_FAILED)
        }
    }

    private fun commitModelCatalog(result: ModelCatalogLoadResult) {
        result.catalog?.let { modelCatalog = it }
        modelCatalogFailure = result.failure
    }

    private data class ModelCatalogLoadResult(
        val catalog: RemoteModelCatalog?,
        val failure: ModelCatalogFailure?,
    )

    private suspend fun sendListSessions(limit: Int, offset: Int, query: String, identity: RemoteWorkspaceIdentity): SessionListResponse =
        transport.send(
            RemoteCommand(
                cmd = "list_sessions",
                workspacePath = identity.path,
                remoteConnectionId = identity.remoteConnectionId,
                remoteSshHost = identity.remoteSshHost,
                limit = limit,
                offset = offset.toLong(),
                query = query.takeIf(String::isNotEmpty),
            ),
        )

    private fun open(sessionId: String) {
        val normalized = sessionId.trim()
        if (normalized.isEmpty()) {
            _state.value = RemoteSessionUiState.Failed(RemoteSessionFailureReason.SESSION_NOT_FOUND)
            _connectionPhase.value = ConnectionPhase.FAILED
            return
        }
        val current = _state.value as? RemoteSessionUiState.Ready
        val restoredDraft = loadPersistedDraft(normalized)
        var resumableCursor: ChatSessionCursor? = null
        if (persistenceEnabled) {
            val cached = try {
                persistence!!.remoteTranscripts.load(deviceKey!!, normalized)
            } catch (_: Throwable) {
                emptyList()
            }
            if (cached.isNotEmpty()) {
                timelineStore.reset(normalized)
                val restoredMessages = cached.map(::toChatMessage)
                timelineStore.setPersistedMessages(restoredMessages)
                val cursor = try {
                    persistence!!.remoteTranscripts.loadCursor(deviceKey!!, normalized)
                } catch (_: Throwable) {
                    null
                }
                cursor?.let {
                    val restoredCursor = ChatSessionCursor(
                        it.pollVersion.toIntOrNull() ?: 0,
                        it.knownMessageCount,
                        it.knownModelCatalogVersion.toLongOrNull() ?: 0L,
                    )
                    timelineStore.setCursor(restoredCursor)
                    if (it.knownMessageCount == restoredMessages.size &&
                        !TranscriptIntegrityPolicy.hasHollowAssistants(restoredMessages)
                    ) {
                        resumableCursor = restoredCursor
                    }
                }
                _state.value = RemoteSessionUiState.Ready(
                    sessions = current?.sessions.orEmpty(), selectedSessionId = normalized,
                    timeline = timelineStore.snapshot(), busy = true,
                    permissionMode = current?.permissionMode, permissionModeFailure = current?.permissionModeFailure,
                    query = current?.query.orEmpty(), agentFilter = current?.agentFilter ?: SessionAgentFilter.ALL,
                    hasMore = current?.hasMore ?: false, hasMoreMessages = false,
                    modelCatalog = modelCatalog ?: current?.modelCatalog,
                    modelCatalogFailure = modelCatalogFailure ?: current?.modelCatalogFailure,
                    draft = restoredDraft,
                    revision = current?.revision ?: authorityRevision,
                )
            }
        }
        if (current == null) _connectionPhase.value = ConnectionPhase.CONNECTING
        val operationToken = beginWork()
        _state.value = (_state.value as? RemoteSessionUiState.Ready)?.copy(busy = true) ?: current?.copy(busy = true)
            ?: RemoteSessionUiState.Loading
        work = scope.launch {
            try {
                // Direct opens can bypass the list that normally discovers host capabilities.
                if (workspacePath.isEmpty()) {
                    try {
                        resolveWorkspacePath(operationToken)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        // Known sessions still open on old peers; new commands remain gated.
                    }
                }
                if (!isCurrentWork(operationToken)) return@launch
                val opened = openSession(normalized, operationToken, resumableCursor) ?: return@launch
                if (!isCurrentWork(operationToken)) return@launch
                _state.value = RemoteSessionUiState.Ready(
                    sessions = current?.sessions.orEmpty(),
                    selectedSessionId = normalized,
                    timeline = timelineStore.snapshot(),
                    busy = false,
                    permissionMode = opened.permission.mode,
                    permissionModeFailure = opened.permission.failure,
                    query = current?.query.orEmpty(),
                    agentFilter = current?.agentFilter ?: SessionAgentFilter.ALL,
                    hasMore = current?.hasMore ?: false,
                    hasMoreMessages = opened.hasMoreMessages,
                    modelCatalog = modelCatalog ?: current?.modelCatalog,
                    modelCatalogFailure = modelCatalogFailure ?: current?.modelCatalogFailure,
                    draft = restoredDraft,
                    revision = current?.revision ?: authorityRevision,
                )
                markConnected()
                refreshModelCatalog()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    handleFailure(error, _state.value as? RemoteSessionUiState.Ready)
                }
            }
        }
    }

    private var sessionHistoryHasMore = false

    private fun publishDurableTimeline() {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        val snapshot = timelineStore.snapshot()
        if (current.selectedSessionId != snapshot.sessionId) return
        _state.value = current.copy(timeline = snapshot, hasMoreMessages = sessionHistoryHasMore)
        markConnected()
    }

    private fun subscribeSessionUpdates(sessionId: String): CompletableDeferred<Unit> {
        val initialHistory = CompletableDeferred<Unit>()
        permissionMailbox.select(sessionId)
        sessionUpdates?.cancel()
        sessionHistoryHasMore = false
        sessionUpdates = scope.launch {
            try {
                val source = transport as? RemoteSessionStreamTransport ?: error("Durable session transport unavailable")
                val store = relayStreamStore ?: error("Durable session storage unavailable")
                val records = SessionRecordReplica(sessionId)
                var caughtUp = false
                source.subscribe(sessionId, PersistentSessionReplica(store, source.streamIdentity + ":session:" + sessionId),
                    { handleFailure(it, _state.value as? RemoteSessionUiState.Ready) },
                    {
                        caughtUp = true
                        publishDurableTimeline()
                        persistTranscript(sessionId, preserveOlder = sessionHistoryHasMore)
                        initialHistory.complete(Unit)
                    },
                ).collect { event ->
                    check(event["session_id"]?.jsonPrimitive?.content == sessionId) { "Session binding mismatch" }
                    val payload = event["payload"] as? JsonObject ?: error("Missing session event payload")
                    when (event["event"]?.jsonPrimitive?.content) {
                        "session-record", "agentic://tool-event" -> {
                            if (event["event"]?.jsonPrimitive?.content == "session-record") records.apply(payload) else {
                                records.applyControl(payload)
                                val kind = (payload["toolEvent"] as? JsonObject)?.get("event_type")?.jsonPrimitive?.content
                                if (kind in setOf("ConfirmationNeeded", "Confirmed", "Rejected", "Cancelled")) permissionMailbox.invalidate()
                            }
                            timelineStore.clearActiveTurn()
                            val messages = records.messages()
                            val active = messages.lastOrNull()?.takeIf { it.role == "assistant" && it.status == "streaming" }
                            timelineStore.setPersistedMessages(if (active == null) messages else messages.dropLast(1))
                            timelineStore.setActiveTurn(active)
                            timelineStore.setSyncPhase(when (messages.lastOrNull()?.status) {
                                "streaming" -> ChatSyncPhase.STREAMING
                                "failed" -> ChatSyncPhase.ERROR
                                else -> ChatSyncPhase.IDLE
                            })
                            if (caughtUp) { publishDurableTimeline(); persistTranscript(sessionId, preserveOlder = sessionHistoryHasMore) }
                        }
                        "relay://session-resumed", "session-interaction-changed" -> permissionMailbox.invalidate()
                        "relay://session-ready" -> {
                            sessionHistoryHasMore = payload["hasMore"]?.jsonPrimitive?.content == "true"
                            val current = _state.value as? RemoteSessionUiState.Ready
                            if (current != null) _state.value = current.copy(hasMoreMessages = sessionHistoryHasMore)
                        }
                        "session-state" -> {
                            val status = payload["status"]?.jsonPrimitive?.content
                            if (status != "running" && status != "streaming") timelineStore.clearActiveTurn()
                            timelineStore.setSyncPhase(when (status) {
                                "running", "streaming" -> ChatSyncPhase.STREAMING
                                "failed", "error" -> ChatSyncPhase.ERROR
                                else -> ChatSyncPhase.IDLE
                            })
                            if (caughtUp) publishDurableTimeline()
                        }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) {
                initialHistory.completeExceptionally(error)
                handleFailure(error, _state.value as? RemoteSessionUiState.Ready)
            } finally {
                initialHistory.cancel()
            }
        }
        return initialHistory
    }

    /** Hydrate history once, then receive durable invalidations through the shared transport. */
    private suspend fun openSession(
        sessionId: String,
        operationToken: Long,
        resumableCursor: ChatSessionCursor? = null,
    ): OpenedSession? {
        if (timelineStore.snapshot().sessionId != sessionId) timelineStore.reset(sessionId)
        val initialHistory = subscribeSessionUpdates(sessionId)
        val permission = readPermissionMode()
        // A successful permission RPC does not mean the durable transcript has
        // arrived. Keep cached content/loading until the initial replay is atomic.
        initialHistory.await()
        if (!isCurrentWork(operationToken)) return null
        return OpenedSession(permission, sessionHistoryHasMore)
    }

    private data class OpenedSession(
        val permission: OpenedPermission,
        val hasMoreMessages: Boolean,
    )

    private fun loadOlderMessages() {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        val sessionId = current.selectedSessionId.orEmpty()
        // Pagination belongs to the durable cursor, including pages containing
        // only deletions or control records with no visible chat message.
        if (sessionId.isEmpty() || !current.hasMoreMessages || current.busy || historyWork?.isActive == true) return
        // Pagination is an independent read, not a new session operation. It must
        // not cancel model hydration or disable the composer while reading history.
        val operationToken = workGeneration
        val historyToken = ++historyGeneration
        _state.value = current.copy(historyLoadState = HistoryLoadState.LOADING)
        historyWork = scope.launch {
            try {
                val source = transport as? RemoteSessionStreamTransport ?: error("Durable session transport unavailable")
                source.loadOlder(sessionId)
                if (!isCurrentWork(operationToken) || timelineStore.snapshot().sessionId != sessionId) return@launch
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                _state.value = ready.copy(timeline = timelineStore.snapshot())

            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (isCurrentWork(operationToken)) {
                    (_state.value as? RemoteSessionUiState.Ready)?.let {
                        _state.value = it.copy(historyLoadState = HistoryLoadState.FAILED)
                    }
                }
            } finally {
                if (historyToken == historyGeneration) {
                    (_state.value as? RemoteSessionUiState.Ready)?.let {
                        if (it.historyLoadState == HistoryLoadState.LOADING) {
                            _state.value = it.copy(historyLoadState = HistoryLoadState.IDLE)
                        }
                    }
                }
            }
        }
    }

    /**
     * The permission mode alone, with its own failure.
     *
     * Unaddressed, as `RemoteCommandFactory.getPermissionMode()` sends it: the
     * desktop holds one mode for all of its sessions, so naming a session here
     * would ask the wrong question and get the same answer.
     *
     * Deliberately not allowed to throw: the transcript above it has already
     * loaded, and losing a whole session because one settings read failed is a
     * far worse outcome than a settings section that says so and offers Refresh.
     */
    private suspend fun readPermissionMode(): OpenedPermission = try {
        OpenedPermission(
            transport.send<PermissionModeResponse>(
                RemoteCommand(cmd = "get_permission_mode"),
            ).mode?.toUiMode() ?: SessionPermissionMode.UNKNOWN,
            null,
        )
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        OpenedPermission(null, PermissionModeFailure.LOAD)
    }

    private data class OpenedPermission(
        val mode: SessionPermissionMode?,
        val failure: PermissionModeFailure?,
    )

    private fun createSession(intent: RemoteSessionIntent.CreateSession, requestId: String) {
        val current = _state.value as? RemoteSessionUiState.Ready
        if (current == null) _connectionPhase.value = ConnectionPhase.CONNECTING
        // Create has priority over list refresh. Invalidating the work generation
        // prevents a cancelled refresh from publishing a late stale page.
        val operationToken = beginWork()
        nextCreateGeneration += 1
        val generation = nextCreateGeneration
        activeCreateGeneration = generation
        _createOperation.value = CreateSessionOperationState.InFlight(
            requestId = requestId,
            deviceKey = deviceKey,
            workspacePath = intent.workspacePath?.trim().orEmpty(),
        )
        _state.value = current?.copy(busy = true) ?: RemoteSessionUiState.Loading
        work = scope.launch {
            try {
                val requestedWorkspacePath = intent.workspacePath?.trim().orEmpty()
                // An explicit path is the cross-workspace sidebar flow: creating
                // there must not change the desktop's active workspace. The
                // ordinary create flow still re-reads the active path so a
                // recent workspace selection cannot race a cached value.
                val assistantCreate = intent.agentType.equals("Claw", ignoreCase = true)
                val workspaceResolved = assistantCreate || requestedWorkspacePath.isNotEmpty() || resolveWorkspacePath(operationToken)
                if (!isCurrentWork(operationToken)) return@launch
                if (!workspaceResolved) {
                    failCreate(requestId, generation, CreateSessionOperationFailure.WORKSPACE, retryable = true, unsupported = false)
                    failKnown(RemoteSessionFailureReason.NO_WORKSPACE, current)
                    return@launch
                }
                val targetWorkspacePath = requestedWorkspacePath.ifEmpty { if (assistantCreate) "" else workspacePath }.takeIf { it.isNotEmpty() }
                val targetConnectionId = if (assistantCreate && requestedWorkspacePath.isEmpty()) null else
                    (if (requestedWorkspacePath.isNotEmpty()) intent.remoteConnectionId else workspaceConnectionId).orEmpty()
                val targetSshHost = if (assistantCreate && requestedWorkspacePath.isEmpty()) null else
                    if (requestedWorkspacePath.isNotEmpty()) intent.remoteSshHost else workspaceSshHost
                val created = transport.send<CreateSessionResponse>(
                    RemoteCommand(
                        cmd = "create_session",
                        agentType = intent.agentType,
                        sessionName = SessionNaming.wireSessionName(intent.agentType, intent.title),
                        workspacePath = targetWorkspacePath,
                        remoteConnectionId = targetConnectionId,
                        remoteSshHost = targetSshHost,
                    ),
                )
                val sessionId = created.resolvedSessionId?.trim().orEmpty()
                if (sessionId.isEmpty()) {
                    failCreate(requestId, generation, CreateSessionOperationFailure.PROTOCOL, retryable = false, unsupported = true)
                    failKnown(RemoteSessionFailureReason.PROTOCOL_MISMATCH, current)
                    return@launch
                }
                // A valid id is the remote commit point. Persist and publish it
                // before optional initialization so cancellation or failure below
                // cannot turn an already-created remote session into a failed create.
                val now = Clock.System.now().toString()
                val confirmedPath = created.workspacePath ?: targetWorkspacePath
                val confirmedIdentity = confirmedPath?.takeIf(String::isNotBlank)?.let { path ->
                    RemoteWorkspaceIdentity(path,
                        if (created.workspacePath != null) created.remoteConnectionId else targetConnectionId,
                        if (created.workspacePath != null) created.remoteSshHost else targetSshHost)
                }
                val confirmedSession = RemoteSession(
                    id = sessionId,
                    title = created.title?.takeIf(String::isNotBlank)
                        ?: SessionNaming.fallbackTitle(intent.agentType),
                    agentType = intent.agentType,
                    status = "active",
                    updatedAt = now,
                    createdAt = now,
                    messageCount = 0,
                    workspacePath = confirmedPath,
                    workspaceName = null,
                    workspaceIdentity = confirmedIdentity,
                )
                if (!isCurrentWork(operationToken)) return@launch
                val commitRevision = publishCommittedCreate(confirmedSession, current)
                if (!succeedCreate(requestId, generation, confirmedSession, commitRevision)) return@launch
                activeCreateGeneration = null

                intent.modelId?.trim()?.takeIf(String::isNotEmpty)?.let { modelId ->
                    transport.send<SetSessionModelResponse>(
                        RemoteCommand(cmd = "set_session_model", sessionId = sessionId, modelId = modelId),
                    )
                    if (!isCurrentWork(operationToken)) return@launch
                }
                val opened = openSession(sessionId, operationToken) ?: return@launch
                intent.instruction.trim().takeIf(String::isNotEmpty)?.let { instruction ->
                    val sent = transport.send<SendMessageResponse>(
                        RemoteCommand(
                            cmd = "send_message",
                            sessionId = sessionId,
                            content = instruction,
                            agentType = intent.agentType,
                        ),
                    )
                    if (!isCurrentWork(operationToken)) return@launch
                    sent.turnId?.let(timelineStore::setLocalActiveTurn)
                    (transport as? RemoteSessionStreamTransport)?.wakeSessionStreams()
                }
                val page = listSessions(0, current?.query.orEmpty(), current?.agentFilter ?: SessionAgentFilter.ALL)
                if (!isCurrentWork(operationToken)) return@launch
                commitSessionPage(page)
                publishAuthorityReady(RemoteSessionUiState.Ready(
                    sessions = page.sessions,
                    selectedSessionId = sessionId,
                    timeline = timelineStore.snapshot(),
                    busy = false,
                    permissionMode = opened.permission.mode,
                    permissionModeFailure = opened.permission.failure,
                    query = current?.query.orEmpty(),
                    agentFilter = current?.agentFilter ?: SessionAgentFilter.ALL,
                    hasMore = page.hasMore,
                    hasMoreMessages = opened.hasMoreMessages,
                    modelCatalog = modelCatalog ?: current?.modelCatalog,
                    modelCatalogFailure = modelCatalogFailure ?: current?.modelCatalogFailure,
                    draft = "",
                ))
                markConnected()
                refreshModelCatalog()
            } catch (cancelled: CancellationException) {
                if (isCurrentWork(operationToken)) {
                    if (isCommittedCreate(requestId)) {
                        val ready = _state.value as? RemoteSessionUiState.Ready
                        if (ready != null) _state.value = ready.copy(busy = false)
                    } else {
                        cancelCreateIfActive(requestId, generation, CreateSessionOperationFailure.CANCELLED)
                    }
                }
                throw cancelled
            } catch (error: Throwable) {
                if (!isCurrentWork(operationToken)) return@launch
                if (isCommittedCreate(requestId)) {
                    handleFailure(error, _state.value as? RemoteSessionUiState.Ready)
                    return@launch
                }
                if (activeCreateGeneration != generation) return@launch
                failCreateFromError(requestId, generation, error)
                handleFailure(error, current)
            }
        }
    }

    private fun isCommittedCreate(requestId: String): Boolean =
        (_createOperation.value as? CreateSessionOperationState.Succeeded)?.requestId == requestId

    private fun cancelCreateIfActive(requestId: String, generation: Long, reason: CreateSessionOperationFailure) {
        if (activeCreateGeneration == generation && (_createOperation.value as? CreateSessionOperationState.InFlight)?.requestId == requestId) {
            _createOperation.value = CreateSessionOperationState.Cancelled(requestId, reason)
            activeCreateGeneration = null
        }
    }

    private fun succeedCreate(
        requestId: String,
        generation: Long,
        session: RemoteSession,
        commitRevision: Long,
    ): Boolean {
        if (activeCreateGeneration != generation ||
            (_createOperation.value as? CreateSessionOperationState.InFlight)?.requestId != requestId
        ) return false
        _createOperation.value = CreateSessionOperationState.Succeeded(
            requestId, session.id, session, commitRevision,
        )
        return true
    }

    private fun failCreate(requestId: String, generation: Long, reason: CreateSessionOperationFailure, retryable: Boolean, unsupported: Boolean) {
        if (activeCreateGeneration == generation && (_createOperation.value as? CreateSessionOperationState.InFlight)?.requestId == requestId) {
            _createOperation.value = CreateSessionOperationState.Failed(requestId, reason, retryable, unsupported)
            activeCreateGeneration = null
        }
    }

    private fun failCreateFromError(requestId: String, generation: Long, error: Throwable) {
        val reason = when (remoteSessionFailure(error).reason) {
            RemoteSessionFailureReason.PROTOCOL_MISMATCH -> CreateSessionOperationFailure.UNSUPPORTED
            RemoteSessionFailureReason.NO_WORKSPACE -> CreateSessionOperationFailure.WORKSPACE
            RemoteSessionFailureReason.NETWORK, RemoteSessionFailureReason.TIMEOUT,
            RemoteSessionFailureReason.TRANSPORT, RemoteSessionFailureReason.RATE_LIMITED,
            RemoteSessionFailureReason.REMOTE_REJECTED, RemoteSessionFailureReason.SESSION_NOT_FOUND ->
                CreateSessionOperationFailure.TRANSPORT
        }
        failCreate(requestId, generation, reason, retryable = reason != CreateSessionOperationFailure.UNSUPPORTED, unsupported = reason == CreateSessionOperationFailure.UNSUPPORTED)
    }

    private fun deleteSession(sessionId: String) {
        val normalized = sessionId.trim()
        if (normalized.isEmpty()) return
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                transport.send<CommandStatusResponse>(
                    RemoteCommand(cmd = "delete_session", sessionId = normalized),
                )
                locallyCreatedSessions.remove(normalized)
                if (persistenceEnabled) {
                    persistedSessionSlice()?.let { persisted ->
                        val persistedSessions = persisted.sessions
                            .filterNot { it.sessionId == normalized }
                        savePersistedSessionRows(persistedSessions, persisted.hasMore)
                    }
                    try {
                        persistence!!.drafts.delete(draftId(normalized))
                    } catch (_: Throwable) {
                        // Each optional cache is cleaned independently so one failure does not block another.
                    }
                    try {
                        persistence!!.remoteTranscripts.delete(deviceKey!!, normalized)
                    } catch (_: Throwable) {
                        // Each optional cache is cleaned independently so one failure does not block another.
                    }
                }
                if (!isCurrentWork(operationToken)) return@launch
                val closingOpenSession = current.selectedSessionId == normalized
                if (closingOpenSession) {
                    sessionUpdates?.cancel()
                    timelineStore.reset("")
                }
                if (!isCurrentWork(operationToken)) return@launch
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                publishAuthorityReady(ready.copy(
                    sessions = ready.sessions.filterNot { it.id == normalized },
                    selectedSessionId = ready.selectedSessionId.takeUnless { closingOpenSession },
                    timeline = if (closingOpenSession) null else ready.timeline,
                    permissionMode = if (closingOpenSession) null else ready.permissionMode,
                    busy = false,
                ))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                    handleFailure(error, (_state.value as? RemoteSessionUiState.Ready) ?: current)
                }
            }
        }
    }

    private fun renameSession(intent: RemoteSessionIntent.RenameSession) {
        val sessionId = intent.sessionId.trim()
        val title = intent.title.trim()
        if (sessionId.isEmpty() || title.isEmpty()) return
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (current.sessions.any { it.id == sessionId && it.title == title }) return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                transport.send<CommandStatusResponse>(
                    RemoteCommand(cmd = "update_session_title", sessionId = sessionId, title = title),
                )
                if (persistenceEnabled) {
                    persistedSessionSlice()?.let { persisted ->
                        val persistedSessions = persisted.sessions.map { session ->
                            if (session.sessionId == sessionId) session.copy(title = title) else session
                        }
                        savePersistedSessionRows(persistedSessions, persisted.hasMore)
                    }
                }
                if (!isCurrentWork(operationToken)) return@launch
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                publishAuthorityReady(ready.copy(
                    sessions = ready.sessions.map { if (it.id == sessionId) it.copy(title = title) else it },
                    busy = false,
                ))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                    handleFailure(error, (_state.value as? RemoteSessionUiState.Ready) ?: current)
                }
            }
        }
    }

    private class SessionPage(
        val sessions: List<RemoteSession>,
        val hasMore: Boolean,
        val confirmedServerIds: Set<String>,
    )

    private fun commitSessionPage(page: SessionPage) {
        page.confirmedServerIds.forEach(locallyCreatedSessions::remove)
    }

    private fun currentTimeline() = timelineStore.snapshot().takeIf { it.sessionId.isNotEmpty() }

    private var draftRevision: Long = 0

    private fun sendMessage(intent: RemoteSessionIntent.SendMessage, plan: RemoteSessionIntent.BuildPlan? = null) {
        val sessionId = intent.sessionId.trim()
        val content = intent.content
        if (sessionId.isEmpty() || (content.trim().isEmpty() && intent.images.isNullOrEmpty())) return
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (current.busy || current.selectedSessionId != sessionId) return
        val submittedDraftRevision = draftRevision
        val activeTurnId = current.timeline?.activeTurn?.turnId?.takeIf { it.isNotBlank() }
        val steering = plan == null && activeTurnId != null && "dialog_steer_v1" in hostCapabilities
        val wireImages = intent.images?.map { image ->
            com.openbitfun.mobile.core.protocol.ImageAttachment(
                name = image.id,
                dataUrl = image.dataUrl,
            )
        }
        val imageContexts = intent.images?.map { image ->
            com.openbitfun.mobile.core.protocol.RemoteImageContext(
                id = image.id,
                imagePath = null,
                dataUrl = image.dataUrl,
                mimeType = image.mimeType,
                metadata = null,
            )
        }
        val clientTurnId = "mobile-${Clock.System.now().toEpochMilliseconds()}-${kotlin.random.Random.nextLong().toULong().toString(16)}"
        val local = ChatMessage(
            id = clientTurnId,
            role = "user",
            text = content,
            status = "sent",
            renderVersion = null,
            turnId = clientTurnId,
            detail = null,
            timestamp = null,
            thinking = null,
            tools = null,
            items = null,
            images = wireImages,
            error = null,
        )
        timelineStore.appendOptimisticMessage(local)
        val pendingActiveId = timelineStore.setPendingActiveTurn(local.id)
        (transport as? RemoteSessionStreamTransport)?.wakeSessionStreams()
        _state.value = current.copy(busy = true, timeline = timelineStore.snapshot())
        val operationToken = beginWork()
        work = scope.launch {
            try {
                val agentType = current.sessions.firstOrNull { it.id == sessionId }?.agentType
                    ?: locallyCreatedSessions[sessionId]?.agentType
                val response = transport.send<SendMessageResponse>(
                    RemoteCommand(
                        cmd = if (plan != null) "build_plan" else if (steering) "steer_turn" else "send_message",
                        turnId = if (steering) activeTurnId else if (plan == null && activeTurnId == null) clientTurnId else null,
                        displayContent = content.takeIf { steering },
                        planFilePath = plan?.path,
                        planName = plan?.name,
                        sessionId = sessionId,
                        content = content,
                        agentType = agentType,
                        imageContexts = imageContexts,
                    ),
                )
                if (!isCurrentWork(operationToken)) return@launch
                response.turnId?.takeIf(String::isNotBlank)?.let { turnId ->
                    timelineStore.acknowledgeOptimisticTurn(local.id, turnId)
                    if (!steering && current.timeline?.activeTurn == null) timelineStore.setLocalActiveTurn(turnId)
                } ?: timelineStore.clearPendingActiveTurn(pendingActiveId)
                (transport as? RemoteSessionStreamTransport)?.wakeSessionStreams()
                val ready = ((_state.value as? RemoteSessionUiState.Ready) ?: current)
                if (ready.selectedSessionId == sessionId) {
                    // An acknowledgement owns only the submitted draft. Keep
                    // newer typing and let each native picker remove only the
                    // acknowledged images; failed sends retain their pixels.
                    val draftUnchanged = plan == null && draftRevision == submittedDraftRevision && ready.draft == current.draft && ready.draft.trim() == content.trim()
                    if (draftUnchanged) deletePersistedDraft(sessionId)
                    _state.value = ready.copy(
                        timeline = timelineStore.snapshot(),
                        draft = if (draftUnchanged) "" else ready.draft,
                        lastSentMessage = SentChatMessage(
                            local.id, sessionId, content, intent.images.orEmpty().map { it.id },
                        ),
                    )
                }
                setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
            } catch (cancelled: CancellationException) {
                // A list refresh or another command may supersede this RPC.
                // Do not leave an unowned waiting placeholder, or touch a newly opened session.
                if (timelineStore.snapshot().sessionId == sessionId) {
                    timelineStore.markOptimisticMessageFailed(local.id)
                    timelineStore.clearPendingActiveTurn(pendingActiveId)
                    val ready = _state.value as? RemoteSessionUiState.Ready
                    if (ready?.selectedSessionId == sessionId) {
                        _state.value = ready.copy(timeline = timelineStore.snapshot())
                    }
                }
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    timelineStore.markOptimisticMessageFailed(local.id)
                    timelineStore.clearPendingActiveTurn(pendingActiveId)
                    handleFailure(error, ((_state.value as? RemoteSessionUiState.Ready) ?: current)
                        .copy(timeline = timelineStore.snapshot()))
                }
            }
        }
    }

    private fun updateDraft(text: String) {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        val id = current.selectedSessionId ?: return
        draftRevision++
        savePersistedDraft(id, text)
        _state.value = current.copy(draft = text)
    }

    private data class PersistedSessionSlice(
        val sessions: List<PersistedRemoteSession>,
        val hasMore: Boolean,
    )

    private fun persistedSessionSlice(): PersistedSessionSlice? {
        if (!persistenceEnabled) return null
        return try {
            PersistedSessionSlice(
                persistence!!.remoteSessions.load(deviceKey!!),
                persistence.remoteSessions.hasMore(deviceKey),
            )
        } catch (_: Throwable) {
            null
        }
    }

    private fun savePersistedSessions(sessions: List<RemoteSession>, hasMore: Boolean) {
        savePersistedSessionRows(sessions.map(::toPersistedSession), hasMore)
    }

    private fun savePersistedSessionRows(sessions: List<PersistedRemoteSession>, hasMore: Boolean) {
        if (!persistenceEnabled) return
        try {
            persistence!!.remoteSessions.save(deviceKey!!, sessions, hasMore)
        } catch (_: Throwable) {
            // Remote state stays authoritative when its optional cache is unavailable.
        }
    }

    private fun loadPersistedDraft(sessionId: String): String {
        if (!persistenceEnabled) return ""
        return try {
            persistence!!.drafts.load(draftId(sessionId)).orEmpty()
        } catch (_: Throwable) {
            ""
        }
    }

    private fun savePersistedDraft(sessionId: String, text: String) {
        if (!persistenceEnabled) return
        try {
            if (text.isEmpty()) persistence!!.drafts.delete(draftId(sessionId))
            else persistence!!.drafts.save(draftId(sessionId), text)
        } catch (_: Throwable) {
            // Draft persistence is best effort; the in-memory composer remains usable.
        }
    }

    private fun deletePersistedDraft(sessionId: String) {
        savePersistedDraft(sessionId, "")
    }

    private fun draftId(sessionId: String): String = "remote-composer:$deviceKey:$sessionId"

    private fun cancelTurn(intent: RemoteSessionIntent.CancelTurn) {
        val sessionId = intent.sessionId.trim()
        if (sessionId.isEmpty()) return
        runAction(sessionId, RemoteCommand(cmd = "cancel_task", sessionId = sessionId, turnId = intent.turnId))
    }

    private fun approveTool(intent: RemoteSessionIntent.ApproveTool) {
        val updated = intent.updatedInput?.let { text ->
            val parsed = runCatching { STORE_JSON.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (parsed == null) { failKnown(RemoteSessionFailureReason.PROTOCOL_MISMATCH, _state.value as? RemoteSessionUiState.Ready); return }
            parsed
        }
        runAction(intent.sessionId, RemoteCommand(cmd = "confirm_tool", toolId = intent.toolId, updatedInput = updated))
    }

    private fun setPermissionMode(intent: RemoteSessionIntent.SetPermissionMode) {
        val wireMode = intent.mode.toWireMode() ?: return
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                val response = transport.send<PermissionModeResponse>(
                    RemoteCommand(cmd = "set_permission_mode", mode = wireMode),
                )
                check(!response.isError) { response.message ?: "Permission mode update failed" }
                // Older hosts acknowledge the mutation without returning the mode.
                // Read their authority instead of reporting the requested value as fact.
                val confirmed = response.mode ?: transport.send<PermissionModeResponse>(
                    RemoteCommand(cmd = "get_permission_mode"),
                ).let { snapshot ->
                    check(!snapshot.isError) { snapshot.message ?: "Permission mode read failed" }
                    snapshot.mode
                }
                if (!isCurrentWork(operationToken)) return@launch
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                _state.value = ready.copy(
                    busy = false,
                    permissionMode = confirmed?.toUiMode() ?: SessionPermissionMode.UNKNOWN,
                    permissionModeFailure = null,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (!isCurrentWork(operationToken)) return@launch
                // The session itself is fine — only this one setting failed, so
                // the failure stays inside the permission section rather than
                // replacing the transcript the user is reading.
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                _state.value = ready.copy(
                    busy = false,
                    permissionModeFailure = PermissionModeFailure.SAVE,
                )
            }
        }
    }

    private fun refreshPermissionMode() {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (current.busy || permissionRefresh?.isActive == true) return
        val operationToken = workGeneration
        permissionRefresh = scope.launch {
            val permission = readPermissionMode()
            if (!isCurrentWork(operationToken)) return@launch
            val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
            _state.value = ready.copy(
                permissionMode = permission.mode ?: ready.permissionMode,
                permissionModeFailure = permission.failure,
            )
        }
    }

    /**
     * Re-reads the model catalog alone, the way [refreshPermissionMode] re-reads
     * the permission mode: the session list, transcript, and draft stay on
     * screen, and only the model section changes. A failure keeps the store in
     * [RemoteSessionUiState.Ready] with the typed failure instead of taking the
     * transcript down with it.
     */
    private fun refreshModelCatalog(invalidated: Boolean = false) {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (modelCatalogRefresh?.isActive == true) {
            if (invalidated) modelCatalogDirty = true
            return
        }
        if (current.busy && !invalidated) return
        // Forward-compat: a future transport may produce a real unsupported-by-
        // peer signal. That is the only case where a retry cannot help, because
        // every generic failure is typed as LOAD_FAILED and remains retryable.
        if (modelCatalogFailure == ModelCatalogFailure.UNSUPPORTED_BY_PEER) return
        // A read of optional settings must not own the conversation's mutation
        // slot. Superseding navigation/mutations still cancel and fence this read.
        val operationToken = workGeneration
        modelCatalogRefresh = scope.launch {
            try {
                do {
                    modelCatalogDirty = false
                    val result = loadModelCatalog(force = true, sessionId = current.selectedSessionId)
                    if (!isCurrentWork(operationToken)) return@launch
                    if (modelCatalogDirty) continue
                    commitModelCatalog(result)
                    val timeline = result.catalog?.let { catalog ->
                        val snapshot = timelineStore.snapshot()
                        if (snapshot.sessionId.isNotEmpty()) {
                            timelineStore.setModelCatalog(
                                catalog,
                                catalog.sessionModelId?.takeIf(String::isNotEmpty) ?: snapshot.selectedModelId,
                            )
                            timelineStore.snapshot()
                        } else {
                            null
                        }
                    }
                    val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                    _state.value = ready.copy(
                        modelCatalog = result.catalog ?: ready.modelCatalog,
                        modelCatalogFailure = result.failure,
                        timeline = timeline ?: ready.timeline,
                    )
                } while (modelCatalogDirty)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (isCurrentWork(operationToken)) {
                    val ready = _state.value as? RemoteSessionUiState.Ready ?: return@launch
                    _state.value = ready.copy(modelCatalogFailure = ModelCatalogFailure.LOAD_FAILED)
                }
            }
        }
    }

    private fun selectModel(intent: RemoteSessionIntent.SelectModel) {
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        if (intent.modelId.trim().isEmpty() || current.selectedSessionId != intent.sessionId ||
            timelineStore.snapshot().sessionId != intent.sessionId) return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                val response = transport.send<SetSessionModelResponse>(
                    RemoteCommand(cmd = "set_session_model", sessionId = intent.sessionId, modelId = intent.modelId),
                )
                if (!isCurrentWork(operationToken)) return@launch
                timelineStore.setSelectedModelId(response.modelId ?: intent.modelId)
                val ready = (_state.value as? RemoteSessionUiState.Ready) ?: current
                _state.value = ready.copy(busy = false, timeline = timelineStore.snapshot())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                    handleFailure(error, (_state.value as? RemoteSessionUiState.Ready) ?: current)
                }
            }
        }
    }

    private fun runAction(sessionId: String, command: RemoteCommand) {
        val toolId = command.toolId
        val answers = command.answers as? JsonObject
        if (command.cmd == "answer_question" && toolId != null && answers != null &&
            permissionMailbox.answer(sessionId, toolId, answers)) return
        val current = _state.value as? RemoteSessionUiState.Ready ?: return
        setBusy(current, true)
        val operationToken = beginWork()
        work = scope.launch {
            try {
                val result = transport.send<CommandStatusResponse>(command.copy(sessionId = command.sessionId ?: sessionId))
                check(!result.isError) { result.message ?: "Remote action failed" }
                if (!isCurrentWork(operationToken)) return@launch
                setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                (transport as? RemoteSessionStreamTransport)?.wakeSessionStreams()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isCurrentWork(operationToken)) {
                    setBusy((_state.value as? RemoteSessionUiState.Ready) ?: current, false)
                    handleFailure(error, (_state.value as? RemoteSessionUiState.Ready) ?: current)
                }
            }
        }
    }

    private fun setBusy(
        current: RemoteSessionUiState.Ready,
        busy: Boolean,
        permissionMode: SessionPermissionMode? = current.permissionMode,
    ) {
        _state.value = current.copy(busy = busy, permissionMode = permissionMode)
    }

    private fun SessionPermissionMode.toWireMode(): RemotePermissionMode? = when (this) {
        SessionPermissionMode.ASK -> RemotePermissionMode.Ask
        SessionPermissionMode.AUTO -> RemotePermissionMode.Auto
        SessionPermissionMode.FULL_ACCESS -> RemotePermissionMode.FullAccess
        SessionPermissionMode.UNKNOWN -> null
    }

    private fun RemotePermissionMode.toUiMode(): SessionPermissionMode = when (this) {
        RemotePermissionMode.Ask -> SessionPermissionMode.ASK
        RemotePermissionMode.Auto -> SessionPermissionMode.AUTO
        RemotePermissionMode.FullAccess -> SessionPermissionMode.FULL_ACCESS
        RemotePermissionMode.Unknown -> SessionPermissionMode.UNKNOWN
    }

    private fun persistTranscript(sessionId: String, preserveOlder: Boolean = true) {
        if (!persistenceEnabled || sessionId.isEmpty()) return
        val snapshot = timelineStore.snapshot()
        if (snapshot.sessionId != sessionId) return
        try {
            val p = persistence!!
            val persistedDeviceKey = deviceKey!!
            val window = snapshot.persistedMessages.map { toPersisted(sessionId, it) }
            val windowIds = window.mapTo(mutableSetOf()) { it.messageId }
            // A paginated re-read (limit 100) must not truncate pages the user already
            // loaded: keep older cached rows the current window does not cover.
            val older = if (preserveOlder) {
                p.remoteTranscripts.load(persistedDeviceKey, sessionId).filterNot { it.messageId in windowIds }
            } else {
                emptyList()
            }
            p.remoteTranscripts.replace(persistedDeviceKey, sessionId, older + window)
            p.remoteTranscripts.saveCursor(persistedDeviceKey, sessionId, PersistedRemoteCursor(
                pollVersion = snapshot.cursor.pollVersion.toString(),
                knownMessageCount = snapshot.cursor.knownMessageCount,
                knownModelCatalogVersion = snapshot.cursor.knownModelCatalogVersion.toString(),
            ))
        } catch (_: Throwable) {
            // Transcript persistence is optional; live session state remains authoritative.
        }
    }

    private fun restorePendingConfirmed(rows: List<PersistedRemoteSession>) {
        rows.filter { it.pendingConfirmed }.forEach { row ->
            if (row.sessionId !in locallyCreatedSessions) {
                locallyCreatedSessions[row.sessionId] = toRemoteSession(row)
            }
        }
    }

    private fun toRemoteSession(s: PersistedRemoteSession): RemoteSession = RemoteSession(
        id = s.sessionId, title = s.title, agentType = s.agentType, status = s.status,
        updatedAt = s.updatedAt, createdAt = s.createdAt, messageCount = s.messageCount,
        workspacePath = s.workspacePath, workspaceName = s.workspaceName,
        workspaceIdentity = s.workspaceIdentity?.let { RemoteWorkspaceIdentity(it.path, it.remoteConnectionId, it.remoteSshHost) },
    )

    private fun toPersistedSession(s: RemoteSession): PersistedRemoteSession = PersistedRemoteSession(
        sessionId = s.id, title = s.title, agentType = s.agentType, status = s.status,
        updatedAt = s.updatedAt, createdAt = s.createdAt, messageCount = s.messageCount,
        lastMessageId = "", workspacePath = s.workspacePath, workspaceName = s.workspaceName,
        pendingConfirmed = s.id in locallyCreatedSessions,
        workspaceIdentity = s.workspaceIdentity?.let { PersistedWorkspaceIdentity(it.path, it.remoteConnectionId, it.remoteSshHost) },
    )


    /**
     * A dropped transport must not replace an already-rendered transcript with a
     * list error. The poll loop keeps running, so its next successful response is
     * also the recovery probe and the durable stream moves the phase back to live.
     */
    private fun handleFailure(error: Throwable, current: RemoteSessionUiState.Ready?) {
        val failed = remoteSessionFailure(error)
        if (current == null) {
            _state.value = failed
            _connectionPhase.value = ConnectionPhase.FAILED
            return
        }
        _state.value = current.copy(busy = false)
        _connectionPhase.value = when (failed.reason) {
            RemoteSessionFailureReason.NETWORK,
            RemoteSessionFailureReason.TIMEOUT,
            RemoteSessionFailureReason.TRANSPORT,
            -> ConnectionPhase.RECONNECTING

            else -> ConnectionPhase.FAILED
        }
    }

    private fun failKnown(reason: RemoteSessionFailureReason, current: RemoteSessionUiState.Ready?) {
        if (current == null) {
            _state.value = RemoteSessionUiState.Failed(reason)
        } else {
            _state.value = current.copy(busy = false)
        }
        _connectionPhase.value = ConnectionPhase.FAILED
    }

    /** Relay replay proves log availability, not that the controlled host is online.
     * Keep foreground host probes for idle open conversations as well as lists. */
    private fun setForeground(active: Boolean) {
        if (active && healthWork?.isActive == true) return
        val generation = ++healthGeneration
        healthWork?.cancel()
        healthWork = null
        if (!active) return
        healthWork = scope.launch {
            while (generation == healthGeneration) {
                val ready = _state.value as? RemoteSessionUiState.Ready
                if (ready != null && !ready.busy) {
                    try {
                        kotlinx.coroutines.withTimeoutOrNull(10_000) {
                            transport.send<com.openbitfun.mobile.core.protocol.CommandStatusResponse>(
                                RemoteCommand(cmd = "ping"), timeoutMs = 10_000,
                            )
                        } ?: throw RelayTransportException(RelayFailure.Timeout)
                        // A probe cannot overwrite a newer mutation's connection outcome.
                        if (generation == healthGeneration && _state.value === ready) markConnected()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Throwable) {
                        if (generation == healthGeneration && _state.value === ready) handleFailure(error, ready)
                    }
                }
                // Match the native HarmonyOS idle health cadence, with no overlapping probes.
                kotlinx.coroutines.delay(15_000)
            }
        }
    }

    private fun markConnected() {
        _connectionPhase.value = ConnectionPhase.CONNECTED
    }

    public companion object {
        /** One screenful of sessions. Matches the desktop's own `list_sessions` default. */
        private const val PAGE_SIZE: Int = 30

        /**
         * Window used while narrowing by agent type. The desktop clamps `limit`
         * to 100, so asking for more only costs round trips.
         */
        private const val FILTER_PAGE_SIZE: Int = 100
        private const val DIRECTORY_WORKSPACE_PAGE_SIZE: Int = 50

        internal fun create(scope: CoroutineScope, transport: RemoteCommandTransport): RemoteSessionStore =
            RemoteSessionStore(scope, transport)

        internal fun create(
            scope: CoroutineScope,
            transport: RemoteCommandTransport,
            deviceKey: String?,
            persistence: MobilePersistenceStores?,
        ): RemoteSessionStore = RemoteSessionStore(scope, transport, deviceKey, persistence)


    }
}

@Serializable
private data class StoredRemoteMessagePayload(
    val renderVersion: Int? = null,
    val turnId: String? = null,
    val detail: String? = null,
    val tools: List<RemoteToolStatusResponse>? = null,
    val items: List<ChatMessageItemResponse>? = null,
    val images: List<ImageAttachment>? = null,
    val error: String? = null,
)

private val STORE_JSON = Json { ignoreUnknownKeys = true }

private fun toPersisted(sessionId: String, m: ChatMessage): PersistedRemoteMessage = PersistedRemoteMessage(
    messageId = m.id, sessionId = sessionId, role = m.role, text = m.text, status = m.status,
    timestamp = m.timestamp, thinking = m.thinking,
    payloadJson = STORE_JSON.encodeToString(StoredRemoteMessagePayload(
        renderVersion = m.renderVersion,
        turnId = m.turnId,
        detail = m.detail,
        tools = m.tools,
        items = m.items,
        images = m.images,
        error = m.error,
    )),
)

private fun toChatMessage(m: PersistedRemoteMessage): ChatMessage {
    val payload = try {
        STORE_JSON.decodeFromString<StoredRemoteMessagePayload>(m.payloadJson)
    } catch (_: Throwable) {
        StoredRemoteMessagePayload()
    }
    return ChatMessage(
        id = m.messageId, role = m.role, text = m.text, status = m.status,
        renderVersion = payload.renderVersion, turnId = payload.turnId, detail = payload.detail,
        timestamp = m.timestamp, thinking = m.thinking, tools = payload.tools,
        items = payload.items, images = payload.images, error = payload.error,
    )
}

internal object RemoteResponseMapper {
    fun session(item: SessionItemResponse): RemoteSession {
        val id = item.id.orEmpty()
        return RemoteSession(
            id = id,
            title = item.title?.takeIf(String::isNotEmpty) ?: "Session ${id.take(6)}",
            agentType = item.agentType ?: "code",
            status = item.status ?: "idle",
            updatedAt = item.updatedAt,
            createdAt = item.createdAt,
            messageCount = item.messageCount ?: 0,
            workspacePath = item.workspacePath,
            workspaceName = item.workspaceName,
            // Callers attach the identity of the workspace they listed under.
            workspaceIdentity = null,
            parentSessionId = item.parentSessionId,
            relationshipKind = item.relationshipKind,
        )
    }

    fun chatMessage(item: ChatMessageResponse): ChatMessage {
        val text = messageText(item.content, item.items)
        val tools = if (item.tools.isNotEmpty()) item.tools else itemTools(item.items)
        return ChatMessage(
            id = item.resolvedId ?: generatedId(item.role, item.timestamp.orEmpty(), text),
            role = item.role,
            text = text,
            status = item.status ?: if (item.role == "assistant") "done" else "sent",
            renderVersion = null,
            turnId = item.turnId,
            detail = messageDetail(tools),
            timestamp = item.timestamp,
            thinking = item.thinking,
            tools = tools,
            items = item.items,
            images = item.images,
            error = item.error,
        )
    }

    fun activeTurn(turn: ActiveTurnSnapshotResponse, renderVersion: Int = 0): ChatMessage {
        val tools = if (turn.tools.isNotEmpty()) turn.tools else itemTools(turn.items)
        return ChatMessage(
            id = "active-${turn.turnId}",
            role = "assistant",
            text = messageText(turn.text.orEmpty(), turn.items),
            status = turn.status,
            renderVersion = renderVersion,
            turnId = turn.turnId,
            detail = messageDetail(tools),
            timestamp = null,
            thinking = turn.thinking,
            tools = tools,
            items = turn.items,
            images = null,
            error = turn.error,
        )
    }

    private fun messageText(content: String, items: List<ChatMessageItemResponse>): String =
        content.takeIf { it.trim().isNotEmpty() } ?: lastTopLevelText(items)

    private fun lastTopLevelText(items: List<ChatMessageItemResponse>): String = items.asReversed()
        .firstOrNull { item ->
            val type = item.type.orEmpty().lowercase()
            item.content.orEmpty().trim().isNotEmpty() && item.tool == null && item.isSubagent != true &&
                type !in setOf("thinking", "tool", "subagent", "agent")
        }?.content.orEmpty().trim()

    private fun itemTools(items: List<ChatMessageItemResponse>): List<com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse> =
        items.flatMap { item -> listOfNotNull(item.tool) + item.subItems.orEmpty().let(::itemTools) }

    private fun messageDetail(tools: List<com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse>): String =
        tools.joinToString("\n") { "${it.name ?: "Tool"} · ${it.status ?: "pending"}" }

    private fun generatedId(role: String, timestamp: String, text: String): String =
        "$role-$timestamp-${text.hashCode().toUInt().toString(36)}"
}
