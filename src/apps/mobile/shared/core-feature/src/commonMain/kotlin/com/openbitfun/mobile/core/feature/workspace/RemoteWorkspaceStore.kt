package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.domain.FilePreviewFailure
import com.openbitfun.mobile.core.domain.FilePreviewFailureReason
import com.openbitfun.mobile.core.domain.FilePreviewPolicy
import com.openbitfun.mobile.core.domain.FilePreviewRenderer
import com.openbitfun.mobile.core.domain.FilePreviewTarget
import com.openbitfun.mobile.core.domain.FilePreviewTargetContext
import com.openbitfun.mobile.core.domain.FileReferenceKind
import com.openbitfun.mobile.core.domain.FileTargetResolver
import com.openbitfun.mobile.core.domain.LegacyWorkspaceCompatibility
import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.SelectedWorkspace
import com.openbitfun.mobile.core.domain.WorkspaceAssistant
import com.openbitfun.mobile.core.domain.WorkspaceReferencePolicy
import com.openbitfun.mobile.core.domain.WorkspaceReferenceResolution
import com.openbitfun.mobile.core.domain.identity
import com.openbitfun.mobile.core.feature.relay.HostCatalogNotice
import com.openbitfun.mobile.core.persistence.TemporaryDownload
import kotlinx.coroutines.flow.collect
import com.openbitfun.mobile.core.persistence.PersistedRemoteWorkspace
import com.openbitfun.mobile.core.persistence.RemoteWorkspaceListStore
import com.openbitfun.mobile.core.protocol.AssistantListResponse
import com.openbitfun.mobile.core.protocol.FileInfoResponse
import com.openbitfun.mobile.core.protocol.ReadFileChunkResponse
import com.openbitfun.mobile.core.protocol.RecentWorkspaceListResponse
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.protocol.SetAssistantResponse
import com.openbitfun.mobile.core.protocol.SetWorkspaceResponse
import com.openbitfun.mobile.core.protocol.SavedRuntimeConnectionsResponse
import kotlinx.serialization.json.*
import kotlinx.serialization.Serializable
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.WorkspaceInfoResponse
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import com.openbitfun.mobile.core.transport.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.io.encoding.Base64

@Serializable
private data class DeviceToolHostResponse(override val resp: String? = null, override val message: String? = null,
    val ok: Boolean = false, val value: JsonElement = JsonNull) : CommandStatus

public class RemoteWorkspaceStore internal constructor(
    private val scope: CoroutineScope,
    private val transport: RemoteCommandTransport,
    private val backgroundDispatcher: CoroutineDispatcher,
    public val deviceKey: String? = null,
    private val persistence: RemoteWorkspaceListStore? = null,
) {
    private var catalogSubscription: Job? = null
    private var catalogRefresh: Job? = null
    private var catalogDirty = false
    internal fun bindCatalog(changes: kotlinx.coroutines.flow.Flow<HostCatalogNotice>) {
        catalogSubscription?.cancel()
        catalogSubscription = scope.launch { changes.collect { notice ->
            if (notice == HostCatalogNotice.Changed) refreshCatalog()
            else updateReady { it.copy(loadFailure = true) }
        } }
    }
    private fun refreshCatalog() {
        catalogDirty = true
        if (catalogRefresh?.isActive == true) return
        catalogRefresh = scope.launch {
            while (catalogDirty) {
                catalogDirty = false
                if (_state.value !is RemoteWorkspaceUiState.Ready) { catalogDirty = true; return@launch }
                try {
                    val (recent, assistants) = coroutineScope {
                        val a = async { transport.send<RecentWorkspaceListResponse>(RemoteCommand(cmd = "list_recent_workspaces")) }
                        val b = async { transport.send<AssistantListResponse>(RemoteCommand(cmd = "list_assistants")) }
                        a.await() to b.await()
                    }
                    updateReady { it.copy(workspaces = recent.workspaces.map { item ->
                        RecentWorkspace(item.path.orEmpty(), item.name ?: basename(item.path.orEmpty()), item.lastOpened, item.workspaceKind.orEmpty(), item.remoteSshHost, item.remoteConnectionId, item.workspaceId)
                    }, assistants = assistants.assistants.map { item -> WorkspaceAssistant(item.path, item.name, item.assistantId, item.workspaceId) },
                        catalog = recent.sidebarCatalog(assistants.assistants.map { item -> WorkspaceAssistant(item.path, item.name, item.assistantId, item.workspaceId) }), loadFailure = false) }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Throwable) { updateReady { it.copy(loadFailure = true) } }
            }
        }
    }
    private val persistenceEnabled: Boolean get() = persistence != null && !deviceKey.isNullOrBlank()
    private val _state = MutableStateFlow<RemoteWorkspaceUiState>(RemoteWorkspaceUiState.Idle)
    public val state: StateFlow<RemoteWorkspaceUiState> = _state.asStateFlow()
    private val _stopVersion = MutableStateFlow(0L)
    /** Changes only when this target store is stopped; useful to cancel observers. */
    public val stopVersion: StateFlow<Long> = _stopVersion.asStateFlow()
    private var downloadStaging: TemporaryDownload? = null
    private var work: Job? = null
    private var previewWork: Job? = null
    private var downloadWork: Job? = null
    private data class DownloadBinding(
        val target: FilePreviewTarget,
        val workspacePath: String?,
        val connectionId: String?,
        val generation: Long,
        val stopVersion: Long,
    )
    private var downloadBinding: DownloadBinding? = null
    private var loadGeneration: Long = 0
    private var targetEpoch: Int = 0
    private var previewGeneration: Long = 0
    private var activePreviewRequestId: String? = null
    private var deviceToolAction: Job? = null
    private var deviceToolGeneration = 0L
    /**
     * Location the file browser is bound to. `path` is the browsed directory (an IO operand),
     * `remoteConnectionId` the provider, and `workspaceId` the owning workspace when the tools
     * were opened for one; the identity key, not the path, scopes the cache.
     */
    private var fileWorkspace: RemoteWorkspaceIdentity? = null
    private val directoryPicker = RuntimeFilesStore(scope, transport)
    private var directoryPickerObserver: Job? = null
    private val files = RuntimeFilesStore(scope, transport)
    private var filesObserver: Job? = null
    /** Device-tool terminals keyed by [RemoteWorkspaceIdentity.key] (workspace ID first, legacy triple otherwise). */
    private val workspaceTerminals = mutableMapOf<String, RuntimeTerminalStore>()
    private var terminal = RuntimeTerminalStore(scope, transport)
    private var terminalObserver: Job? = null
    /** False until a live `get_workspace_info` reported the host capability list for this connection. */
    private var hostCapabilitiesKnown = false

    /**
     * Whether the connected host honours ID-only workspace commands, or null when no live
     * capability list has been received yet (cached catalogs never answer this).
     */
    public val supportsWorkspaceIdReferences: Boolean?
        get() = if (!hostCapabilitiesKnown) null else (_state.value as? RemoteWorkspaceUiState.Ready)?.supportsWorkspaceIdReferences

    private fun recordHostCapabilities(capabilities: List<String>) {
        hostCapabilitiesKnown = true
        updateReady { it.copy(hostCapabilities = capabilities) }
    }

    /**
     * Resolves whether an ID-bearing command may be sent. Fetches the live capability list
     * when it is not known yet so a cached catalog never decides the answer.
     */
    private suspend fun ensureWorkspaceIdReferences(): Boolean {
        if (!hostCapabilitiesKnown) {
            val info = transport.send<WorkspaceInfoResponse>(RemoteCommand(cmd = "get_workspace_info"))
            recordHostCapabilities(info.capabilities)
        }
        return WorkspaceReferencePolicy.supportsWorkspaceIdReferences(
            (_state.value as? RemoteWorkspaceUiState.Ready)?.hostCapabilities.orEmpty(),
        )
    }

    private fun failWorkspaceReference(failure: WorkspaceReferenceFailure) {
        updateReady { it.copy(busy = false, workspaceReferenceFailure = failure) }
    }


    private fun nextPreviewIdentity(target: FilePreviewTarget, requestedId: String = ""): PreviewRequestIdentity {
        previewGeneration += 1
        val requestId = requestedId.trim().ifEmpty { "preview-$previewGeneration" }
        activePreviewRequestId = requestId
        return PreviewRequestIdentity(requestId, deviceKey, target.sessionId, target.remotePath)
    }

    private fun cancelDownload() {
        downloadWork?.cancel()
        downloadWork = null
        updateReady { ready ->
            val loading = ready.download as? RemoteFileDownloadUiState.Loading
            if (loading == null) ready else ready.copy(download = RemoteFileDownloadUiState.Failed(
                loading.target, FilePreviewFailureKind.UNAVAILABLE, true,
            ))
        }
    }

    private fun invalidatePreview() {
        previewWork?.cancel()
        previewWork = null
        previewGeneration += 1
        activePreviewRequestId = null
    }

    public fun dispatch(intent: RemoteWorkspaceIntent) {
        when (intent) {
            RemoteWorkspaceIntent.Load -> load()
            is RemoteWorkspaceIntent.BrowseWorkspaceDirectories -> {
                if (directoryPickerObserver == null) directoryPickerObserver = scope.launch { directoryPicker.state.collect { value -> updateReady { it.copy(directoryPicker = value) } } }
                val ready = _state.value as? RemoteWorkspaceUiState.Ready
                if (intent.remoteConnectionId == null || ready?.savedConnections?.any { it.id == intent.remoteConnectionId } == true) {
                    directoryPicker.browse(intent.path, "/", intent.remoteConnectionId, intent.append)
                } else {
                    updateReady { it.copy(directoryPicker = it.directoryPicker.copy(failed = true, busy = false)) }
                }
            }
            is RemoteWorkspaceIntent.SortFiles -> files.sort(intent.sort)
            RemoteWorkspaceIntent.CloseFileEditor -> files.closeFile()
            is RemoteWorkspaceIntent.OpenDeviceTools -> openDeviceTools(intent.path, intent.connectionId, intent.workspaceId)
            is RemoteWorkspaceIntent.SelectDeviceToolsPanel -> updateReady { it.copy(deviceTools = it.deviceTools.copy(panel = intent.panel)) }
            RemoteWorkspaceIntent.CloseDeviceTools -> {
                deviceToolGeneration++; deviceToolAction?.cancel()
                updateReady { it.copy(deviceTools = it.deviceTools.copy(visible = false, busy = false)) }
            }
            RemoteWorkspaceIntent.StartDeviceToolsTerminal -> {
                val tools = (_state.value as? RemoteWorkspaceUiState.Ready)?.deviceTools
                if (tools != null && tools.visible && !tools.busy && !tools.failed && tools.path.isNotEmpty()) terminal.open(tools.path, tools.connectionId)
            }
            is RemoteWorkspaceIntent.OpenDeviceFiles -> openDeviceTool(intent.path, intent.remoteConnectionId, false, workspaceId = intent.workspaceId)
            is RemoteWorkspaceIntent.OpenDeviceTerminal -> openDeviceTool(intent.path, intent.remoteConnectionId, true, workspaceId = intent.workspaceId)
            is RemoteWorkspaceIntent.BrowseFiles -> {
                if (filesObserver == null) filesObserver = scope.launch { files.state.collect { value -> updateReady { it.copy(files = value) } } }
                val selected = (_state.value as? RemoteWorkspaceUiState.Ready)?.selected
                val binding = fileWorkspace ?: selected?.identity()
                if (binding != null) {
                    files.browse(intent.path, intent.path, binding.remoteConnectionId, intent.append)
                }
                else failRetainingCache()
            }
            is RemoteWorkspaceIntent.UploadFile -> files.upload(intent.path, intent.source)
            is RemoteWorkspaceIntent.ReadFile -> files.read(intent.path)
            is RemoteWorkspaceIntent.SaveFile -> files.save(intent.content)
            is RemoteWorkspaceIntent.CreateFile -> files.createFile(intent.path)
            is RemoteWorkspaceIntent.RenameFile -> files.renameFile(intent.path)
            RemoteWorkspaceIntent.DeleteFile -> files.deleteFile()
            is RemoteWorkspaceIntent.CreateDirectory -> files.createDirectory(intent.path)
            is RemoteWorkspaceIntent.UploadFileEntry -> files.uploadEntry(intent.name, intent.source)
            is RemoteWorkspaceIntent.CreateFileEntry -> files.createEntry(intent.name, intent.directory)
            is RemoteWorkspaceIntent.RenameFileEntry -> files.renameEntry(intent.path, intent.name)
            is RemoteWorkspaceIntent.DeleteFileEntry -> files.deleteEntry(intent.path)
            RemoteWorkspaceIntent.OpenTerminal -> {
                if (terminalObserver == null) terminalObserver = scope.launch { terminal.state.collect { value -> updateReady { it.copy(terminal = value) } } }
                val selected = (_state.value as? RemoteWorkspaceUiState.Ready)?.selected
                if (selected != null && (selected.kind != "remote" || selected.remoteConnectionId != null)) terminal.open(selected.path, selected.remoteConnectionId)
                else failRetainingCache()
            }
            is RemoteWorkspaceIntent.ResizeTerminal -> terminal.resize(intent.cols, intent.rows)
            RemoteWorkspaceIntent.CloseTerminal -> terminal.close()
            RemoteWorkspaceIntent.ReopenTerminal -> terminal.reopen()
            is RemoteWorkspaceIntent.WriteTerminal -> terminal.write(intent.data)
            is RemoteWorkspaceIntent.SelectWorkspace -> selectWorkspace(intent)
            is RemoteWorkspaceIntent.SelectAssistant -> selectAssistant(intent)
            is RemoteWorkspaceIntent.OpenFile -> resolveAndOpenFile(intent)
            is RemoteWorkspaceIntent.DownloadFile -> resolveAndDownloadFile(intent)
            RemoteWorkspaceIntent.RetryDownload -> retryDownload()
            is RemoteWorkspaceIntent.DownloadSaved -> finishDownload(intent.reference, true)
            is RemoteWorkspaceIntent.DownloadSaveFailed -> finishDownload(intent.reference, false)
            RemoteWorkspaceIntent.DismissPreview -> {
                invalidatePreview()
                updateReady { it.copy(preview = RemoteFilePreviewUiState.None) }
            }
            RemoteWorkspaceIntent.Stop -> stop()
        }
    }

    public fun stop() {
        updateReady { it.copy(deviceTools = DeviceToolsUiState()) }
        downloadBinding = null
        deviceToolGeneration++; deviceToolAction?.cancel()
        directoryPicker.reset(); directoryPickerObserver?.cancel(); directoryPickerObserver = null; fileWorkspace = null
        catalogSubscription?.cancel(); catalogRefresh?.cancel()
        downloadStaging?.delete(); downloadStaging = null
        files.stop()
        filesObserver?.cancel()
        terminal.stop()
        workspaceTerminals.values.forEach { it.stop() }; workspaceTerminals.clear()
        terminalObserver?.cancel()
        _stopVersion.value += 1
        loadGeneration += 1
        hostCapabilitiesKnown = false
        invalidatePreview()
        cancelDownload()
        work?.cancel()
        work = null
    }

    /** Last device-scoped catalog stored on disk, merged the same way the directory renders it. */
    internal fun cachedCatalog(): List<RecentWorkspace> {
        if (!persistenceEnabled) return emptyList()
        val rows = try {
            persistence!!.load(deviceKey!!)
        } catch (_: Throwable) {
            emptyList()
        }
        val cached = cachedReady(rows)
        return mergedCatalog(cached.workspaces, cached.assistants)
    }

    /** Device-directory catalog request; it must not depend on the desktop's active workspace. */
    internal suspend fun directoryCatalog(): WorkspaceCatalogUiState = coroutineScope {
        val recentDeferred = async {
            transport.send<RecentWorkspaceListResponse>(RemoteCommand(cmd = "list_recent_workspaces"))
        }
        val assistantsDeferred = async {
            transport.send<AssistantListResponse>(RemoteCommand(cmd = "list_assistants"))
        }
        val recent = recentDeferred.await()
        val assistants = assistantsDeferred.await()
        val loadedWorkspaces = recent.workspaces.map { item ->
            RecentWorkspace(
                path = item.path.orEmpty(),
                name = item.name?.takeIf(String::isNotBlank) ?: basename(item.path.orEmpty()),
                lastOpened = item.lastOpened,
                workspaceId = item.workspaceId,
                kind = item.workspaceKind.orEmpty(),
                remoteSshHost = item.remoteSshHost.takeUnless { item.workspaceKind == "normal" || item.workspaceKind == "assistant" },
                remoteConnectionId = item.remoteConnectionId.takeUnless { item.workspaceKind == "normal" || item.workspaceKind == "assistant" },
            )
        }.filter { it.path.isNotEmpty() }
        val loadedAssistants = assistants.assistants.map { item ->
            WorkspaceAssistant(item.path, item.name, item.assistantId, item.workspaceId)
        }
        if (persistenceEnabled) {
            try {
                persistence!!.save(deviceKey!!, persistedCatalog(loadedWorkspaces, loadedAssistants))
            } catch (_: Throwable) {
                // The remote catalog remains authoritative when its optional cache is unavailable.
            }
        }
        recent.sidebarCatalog(loadedAssistants)
    }

    private fun load() {
        val generation = ++loadGeneration
        invalidatePreview()
        cancelDownload()
        work?.cancel()
        if (_state.value !is RemoteWorkspaceUiState.Ready && persistenceEnabled) {
            val cached = try {
                persistence!!.load(deviceKey!!)
            } catch (_: Throwable) {
                emptyList()
            }
            if (cached.isNotEmpty()) {
                _state.value = cachedReady(cached)
            }
        }
        _state.value = (_state.value as? RemoteWorkspaceUiState.Ready)
            ?.copy(busy = true, loadFailure = false)
            ?: RemoteWorkspaceUiState.Loading
        work = scope.launch {
            try {
                supervisorScope {
                    val recentDeferred = async<Any> {
                        transport.send<RecentWorkspaceListResponse>(RemoteCommand(cmd = "list_recent_workspaces"))
                    }
                    val assistantsDeferred = async<Any> {
                        transport.send<AssistantListResponse>(RemoteCommand(cmd = "list_assistants"))
                    }
                    val infoDeferred = async<Any> {
                        transport.send<WorkspaceInfoResponse>(RemoteCommand(cmd = "get_workspace_info"))
                    }
                    try {
                        val results = awaitAll(recentDeferred, assistantsDeferred, infoDeferred)
                        val recent = results[0] as RecentWorkspaceListResponse
                        val assistants = results[1] as AssistantListResponse
                        val info = results[2] as WorkspaceInfoResponse
                        if (generation == loadGeneration) {
                            val loadedWorkspaces = recent.workspaces.map { item ->
                                RecentWorkspace(
                                    path = item.path.orEmpty(),
                                    name = item.name?.takeIf(String::isNotBlank) ?: basename(item.path.orEmpty()),
                                    lastOpened = item.lastOpened,
                                    workspaceId = item.workspaceId,
                kind = item.workspaceKind.orEmpty(),
                                    remoteSshHost = item.remoteSshHost.takeUnless { item.workspaceKind == "normal" || item.workspaceKind == "assistant" },
                remoteConnectionId = item.remoteConnectionId.takeUnless { item.workspaceKind == "normal" || item.workspaceKind == "assistant" },
                                )
                            }.filter { it.path.isNotEmpty() }
                            val loadedAssistants = assistants.assistants.map { item ->
                                WorkspaceAssistant(item.path, item.name, item.assistantId, item.workspaceId)
                            }
                            if (persistenceEnabled) {
                                try {
                                    persistence!!.save(
                                        deviceKey!!,
                                        persistedCatalog(loadedWorkspaces, loadedAssistants),
                                    )
                                } catch (_: Throwable) {
                                    // Cache writes must not turn a successful remote load into a failure.
                                }
                            }
                            downloadStaging?.delete(); downloadStaging = null
                            hostCapabilitiesKnown = true
                            _state.value = RemoteWorkspaceUiState.Ready(
                                workspaces = loadedWorkspaces,
                                assistants = loadedAssistants,
                                selected = info.asSelectedWorkspace(),
                                hostCapabilities = info.capabilities,
                                preview = RemoteFilePreviewUiState.None,
                                busy = false,
                                download = RemoteFileDownloadUiState.None,
                                loadFailure = false,
                            ).copy(catalog = recent.sidebarCatalog(loadedAssistants))
                            if (catalogDirty && catalogRefresh?.isActive != true) refreshCatalog()
                            try {
                                val connections = transport.send<SavedRuntimeConnectionsResponse>(RemoteCommand(
                                    cmd = "host_invoke", command = "ssh_list_saved_connections", args = JsonObject(emptyMap()),
                                ))
                                check(connections.ok) { "Saved connection catalog failed" }
                                if (generation == loadGeneration) updateReady { ready -> ready.copy(
                                    savedConnections = connections.value.map { SavedRuntimeConnectionUiState(it.id, it.name, it.host) },
                                    savedConnectionsFailure = false,
                                ) }
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Throwable) {
                                if (generation == loadGeneration) updateReady { it.copy(savedConnectionsFailure = true) }
                            }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Throwable) {
                        recentDeferred.cancel()
                        assistantsDeferred.cancel()
                        infoDeferred.cancel()
                        recentDeferred.join()
                        assistantsDeferred.join()
                        infoDeferred.join()
                        if (generation == loadGeneration) failRetainingCache()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (generation == loadGeneration) failRetainingCache()
            }
        }
    }

    /**
     * Sends `set_workspace`. A known workspace ID is sent alone so an ID-aware host can
     * never fall back to the path. A path without an ID is first resolved against the
     * live catalog through [LegacyWorkspaceCompatibility]: a unique row that carries an
     * ID upgrades the reference to that ID, a unique pre-ID row lends its saved
     * connection identity, an ambiguous path is refused, and only a path the catalog
     * does not know at all (a hand-typed location) is sent as the legacy projection.
     */
    private fun selectWorkspace(intent: RemoteWorkspaceIntent.SelectWorkspace) {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        val explicitId = intent.workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        if (explicitId != null) {
            runSelection(RemoteCommand(cmd = "set_workspace", workspaceId = explicitId), assistant = false)
            return
        }
        val normalized = intent.path.trim()
        if (normalized.isEmpty()) return
        val reference = RemoteWorkspaceIdentity(normalized, intent.remoteConnectionId, intent.remoteSshHost)
        val catalog = ready.workspaces.map { it.identity() }
        val known: RemoteWorkspaceIdentity? = if (intent.inferSavedIdentity) {
            when (val resolution = LegacyWorkspaceCompatibility.resolveReference(reference, catalog)) {
                is WorkspaceReferenceResolution.Resolved -> resolution.identity
                is WorkspaceReferenceResolution.Ambiguous -> {
                    failWorkspaceReference(WorkspaceReferenceFailure.AMBIGUOUS_PATH)
                    return
                }
                is WorkspaceReferenceResolution.UnknownId, WorkspaceReferenceResolution.Unresolved -> null
            }
        } else {
            // An explicit picker already named the provider: only an exact legacy triple may lend its ID.
            catalog.singleOrNull { it.workspaceId != null && it.matches(reference) }
        }
        val knownId = known?.workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        if (knownId != null) {
            runSelection(RemoteCommand(cmd = "set_workspace", workspaceId = knownId), assistant = false)
            return
        }
        runSelection(RemoteCommand(cmd = "set_workspace", path = normalized,
            remoteConnectionId = intent.remoteConnectionId ?: known?.remoteConnectionId,
            remoteSshHost = intent.remoteSshHost ?: known?.remoteSshHost), assistant = false)
    }

    /**
     * Sends `set_assistant`. With an ID only the ID is sent. Without one the path must
     * resolve to exactly one pre-ID assistant row; assistants are never matched by path
     * once the catalog carries IDs, and an unknown path is refused rather than guessed.
     */
    private fun selectAssistant(intent: RemoteWorkspaceIntent.SelectAssistant) {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        val explicitId = intent.workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        if (explicitId != null) {
            runSelection(RemoteCommand(cmd = "set_assistant", workspaceId = explicitId), assistant = true)
            return
        }
        val normalized = intent.path.trim()
        if (normalized.isEmpty()) return
        val catalog = ready.assistants.map { it.identity() }
        when (val resolution = LegacyWorkspaceCompatibility.resolveReference(RemoteWorkspaceIdentity(normalized, null, null), catalog)) {
            is WorkspaceReferenceResolution.Resolved -> {
                val resolvedId = resolution.identity.workspaceId?.trim()?.takeIf { it.isNotEmpty() }
                if (resolvedId != null) runSelection(RemoteCommand(cmd = "set_assistant", workspaceId = resolvedId), assistant = true)
                else runSelection(RemoteCommand(cmd = "set_assistant", path = resolution.identity.path), assistant = true)
            }
            is WorkspaceReferenceResolution.Ambiguous -> failWorkspaceReference(WorkspaceReferenceFailure.AMBIGUOUS_PATH)
            is WorkspaceReferenceResolution.UnknownId, WorkspaceReferenceResolution.Unresolved -> failRetainingCache()
        }
    }

    private fun runSelection(command: RemoteCommand, assistant: Boolean) {
        val current = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        val generation = ++loadGeneration
        invalidatePreview()
        cancelDownload()
        work?.cancel()
        _state.value = ((_state.value as? RemoteWorkspaceUiState.Ready) ?: current).copy(busy = true, workspaceReferenceFailure = null)
        work = scope.launch {
            try {
                if (command.workspaceId != null && !ensureWorkspaceIdReferences()) {
                    // Keep the ID and refuse: downgrading a known ID to its path would let the
                    // host pick a same-path workspace the user never chose.
                    if (generation == loadGeneration) failWorkspaceReference(WorkspaceReferenceFailure.ID_REFERENCES_UNSUPPORTED)
                    return@launch
                }
                val accepted = if (assistant) {
                    transport.send<SetAssistantResponse>(command).success == true
                } else {
                    transport.send<SetWorkspaceResponse>(command).success == true
                }
                if (!accepted) {
                    if (generation != loadGeneration) return@launch
                    // The wire carries no error code. An ID the live catalog does not list is
                    // reported as unknown; anything else is an ordinary failed request.
                    val rejectedId = command.workspaceId
                    if (rejectedId != null && isUnknownId(rejectedId, assistant)) failWorkspaceReference(WorkspaceReferenceFailure.UNKNOWN_ID)
                    else failRetainingCache()
                    return@launch
                }
                val info = transport.send<WorkspaceInfoResponse>(RemoteCommand(cmd = "get_workspace_info"))
                if (generation != loadGeneration) return@launch
                hostCapabilitiesKnown = true
                if (fileWorkspace == null) files.reset()
                updateReady { it.copy(selected = info.asSelectedWorkspace(), hostCapabilities = info.capabilities, busy = false, loadFailure = false, workspaceReferenceFailure = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (generation == loadGeneration) failRetainingCache()
            }
        }
    }

    private fun isUnknownId(workspaceId: String, assistant: Boolean): Boolean {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return false
        val catalog = if (assistant) ready.assistants.map { it.identity() } else ready.workspaces.map { it.identity() }
        return LegacyWorkspaceCompatibility.resolveById(workspaceId, catalog).isUnknownId
    }

    private fun openFile(target: FilePreviewTarget, requestedId: String) {
        val current = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        val connectionId = current.selected?.remoteConnectionId.takeIf { target.sessionId.isEmpty() }
        val identity = nextPreviewIdentity(target, requestedId)
        val generation = previewGeneration
        previewWork?.cancel()
        _state.value = current.copy(preview = RemoteFilePreviewUiState.Loading(target, identity))
        previewWork = scope.launch {
            try {
                val info = transport.send<FileInfoResponse>(
                    RemoteCommand(cmd = "get_file_info", path = target.remotePath, sessionId = target.sessionId.ifEmpty { null }, workspacePath = target.workspacePath.takeIf { target.sessionId.isEmpty() }, remoteConnectionId = connectionId),
                )
                val size = info.size ?: 0
                val mime = info.mimeType ?: "application/octet-stream"
                val name = info.name ?: basename(target.remotePath)
                // The name decides as much as the type does: the desktop reports
                // `text/plain` for Markdown, and `image/svg+xml` for a file the
                // preview can only show as source.
                when (FilePreviewPolicy.rendererFor(name.ifEmpty { target.remotePath }, mime)) {
                    FilePreviewRenderer.MARKDOWN -> loadText(target, identity, generation, name, mime, size, connectionId, markdown = true)
                    FilePreviewRenderer.TEXT -> loadText(target, identity, generation, name, mime, size, connectionId, markdown = false)
                    FilePreviewRenderer.IMAGE ->
                        if (FilePreviewPolicy.canPreviewImage(size)) {
                            loadImage(target, identity, generation, name, mime, size, connectionId)
                        } else {
                            failPreview(target, identity, generation, "file too large", mime, size)
                        }
                    FilePreviewRenderer.UNSUPPORTED ->
                        updatePreview(identity, generation) { it.copy(preview = RemoteFilePreviewUiState.Unsupported(target, mime, size, identity)) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // `get_file_info` may be what failed, so the type and size are
                // not known here; the header falls back to the path it asked for.
                failPreview(target, identity, generation, error.message.orEmpty(), "", 0)
            }
        }
    }

    private fun resolveAndOpenFile(intent: RemoteWorkspaceIntent.OpenFile) {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        targetEpoch += 1
        val resolution = FileTargetResolver.resolve(
            reference = intent.reference,
            label = intent.label,
            context = FilePreviewTargetContext(
                sessionId = intent.sessionId,
                workspacePath = ready.selected?.path.orEmpty(),
                controlTargetEpoch = targetEpoch,
            ),
        )
        val resolvedTarget = resolution.target
        if (resolution.kind != FileReferenceKind.REMOTE_WORKSPACE_FILE || resolvedTarget == null) {
            val placeholder = FilePreviewTarget(
                intent.reference,
                intent.reference,
                intent.label,
                intent.sessionId,
                ready.selected?.path.orEmpty(),
                targetEpoch,
                0,
                0,
            )
            updateReady {
                it.copy(
                    preview = RemoteFilePreviewUiState.Failed(
                        placeholder,
                        FilePreviewFailureKind.UNAVAILABLE,
                        true,
                        "",
                        0,
                        nextPreviewIdentity(placeholder, intent.requestId),
                    ),
                )
            }
            return
        }
        openFile(resolvedTarget, intent.requestId)
    }

    private fun resolveAndDownloadFile(intent: RemoteWorkspaceIntent.DownloadFile) {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        targetEpoch += 1
        val resolution = FileTargetResolver.resolve(
            reference = intent.reference,
            label = intent.label,
            context = FilePreviewTargetContext(
                sessionId = intent.sessionId,
                workspacePath = (fileWorkspace?.path.takeIf { intent.sessionId.isEmpty() } ?: ready.selected?.path).orEmpty(),
                controlTargetEpoch = targetEpoch,
            ),
        )
        val target = resolution.target
        if (resolution.kind != FileReferenceKind.REMOTE_WORKSPACE_FILE || target == null) {
            val placeholder = FilePreviewTarget(
                intent.reference,
                intent.reference,
                intent.label,
                intent.sessionId,
                (fileWorkspace?.path.takeIf { intent.sessionId.isEmpty() } ?: ready.selected?.path).orEmpty(),
                targetEpoch,
                0,
                0,
            )
            updateReady {
                it.copy(
                    download = RemoteFileDownloadUiState.Failed(
                        placeholder,
                        FilePreviewFailureKind.UNAVAILABLE,
                        false,
                    ),
                )
            }
            return
        }
        downloadFile(target)
    }

    /** Binds the active terminal to the store cached for [scope]'s identity key (workspace ID first, legacy triple otherwise). */
    private fun bindTerminal(scope: RemoteWorkspaceIdentity) {
        terminalObserver?.cancel()
        terminal = workspaceTerminals.getOrPut(scope.key) { RuntimeTerminalStore(this.scope, transport) }
        updateReady { it.copy(terminal = terminal.state.value) }
        terminalObserver = this.scope.launch { terminal.state.collect { value -> updateReady { it.copy(terminal = value) } } }
    }

    private fun openDeviceTools(path: String, connectionId: String?, workspaceId: String?) {
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        // The editor must be closed through its discard/save flow before changing providers.
        if (ready.deviceTools.visible && ready.files.file != null) return
        val panel = if (ready.deviceTools.visible) ready.deviceTools.panel else DeviceToolsPanel.FILES
        updateReady { it.copy(deviceTools = DeviceToolsUiState(true, panel, "", connectionId, true, false)) }
        openDeviceTool(path, connectionId, false, unifiedTools = true, workspaceId = workspaceId)
    }

    private fun openDeviceTool(path: String, connectionId: String?, terminalTool: Boolean, unifiedTools: Boolean = false, workspaceId: String? = null) {
        val scopedWorkspaceId = workspaceId?.trim()?.takeIf { it.isNotEmpty() }
        val ready = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        deviceToolAction?.cancel()
        val generation = ++deviceToolGeneration
        // Detach the previous provider before validating the replacement: even
        // a rejected selection must fence late directory responses from it.
        if (!terminalTool) {
            filesObserver?.cancel(); filesObserver = null
            files.reset(); fileWorkspace = null
            updateReady { it.copy(files = files.state.value.copy(busy = true)) }
        }
        if (connectionId != null && ready.savedConnections.none { it.id == connectionId }) {
            if (unifiedTools) updateReady { it.copy(deviceTools = it.deviceTools.copy(busy = false, failed = true)) }
            updateReady { if (terminalTool) it.copy(terminal = RuntimeTerminalUiState(null, "", false, true)) else it.copy(files = RuntimeFilesUiState("", emptyList(), false, null, "", false, true)) }
            return
        }
        if (terminalTool) updateReady { it.copy(terminal = RuntimeTerminalUiState(null, "", true, false)) }
        deviceToolAction = scope.launch {
            try {
                val location = path.takeIf { it.isNotBlank() } ?: if (connectionId != null) "/" else {
                    val response = transport.send<DeviceToolHostResponse>(RemoteCommand(cmd = "host_invoke", command = "get_system_info", args = JsonObject(emptyMap())))
                    check(response.ok) { "Runtime system information unavailable" }
                    response.value.jsonObject["homeDir"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() } ?: error("Runtime home directory unavailable")
                }
                if (generation != deviceToolGeneration) return@launch
                val toolScope = RemoteWorkspaceIdentity(location, connectionId, null, scopedWorkspaceId)
                if (terminalTool) {
                    bindTerminal(toolScope)
                    terminal.open(location, connectionId)
                } else {
                    if (unifiedTools) {
                        bindTerminal(toolScope)
                        updateReady { it.copy(deviceTools = it.deviceTools.copy(path = location, busy = false, failed = false)) }
                    }
                    if (filesObserver == null) filesObserver = scope.launch { files.state.collect { value ->
                        // Browsing deeper moves the IO operand only; the owning workspace identity is kept.
                        if (value.directory.isNotEmpty() && !value.failed) fileWorkspace = (fileWorkspace ?: toolScope).copy(path = value.directory, remoteConnectionId = connectionId)
                        updateReady { it.copy(files = value) }
                    } }
                    fileWorkspace = toolScope
                    files.browse(location, location, connectionId, false)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Throwable) {
                if (generation == deviceToolGeneration && unifiedTools) updateReady { it.copy(deviceTools = it.deviceTools.copy(busy = false, failed = true)) }
                if (generation == deviceToolGeneration) updateReady { if (terminalTool) it.copy(terminal = RuntimeTerminalUiState(null, "", false, true)) else it.copy(files = it.files.copy(busy = false, failed = true)) }
            }
        }
    }

    private fun retryDownload() {
        val failed = (_state.value as? RemoteWorkspaceUiState.Ready)?.download as? RemoteFileDownloadUiState.Failed ?: return
        val binding = downloadBinding ?: return
        if (!failed.retryable || failed.target != binding.target ||
            binding.generation != loadGeneration || binding.stopVersion != _stopVersion.value) return
        downloadFile(binding.target, binding)
    }

    private fun downloadFile(target: FilePreviewTarget, previousBinding: DownloadBinding? = null) {
        val current = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        if (current.busy || current.download is RemoteFileDownloadUiState.Loading ||
            current.download is RemoteFileDownloadUiState.AwaitingSave
        ) return
        if (previousBinding == null && target.sessionId.isEmpty() && fileWorkspace == null && current.selected?.kind == "remote" && current.selected.remoteConnectionId.isNullOrBlank()) {
            failDownload(target, "Remote workspace connection identity is unavailable"); return
        }
        val binding = previousBinding ?: DownloadBinding(
            target,
            (fileWorkspace?.path ?: current.selected?.path).takeIf { target.sessionId.isEmpty() },
            (fileWorkspace?.remoteConnectionId ?: current.selected?.remoteConnectionId.takeIf { fileWorkspace == null }).takeIf { target.sessionId.isEmpty() },
            loadGeneration,
            _stopVersion.value,
        )
        downloadBinding = binding
        val workspacePath = binding.workspacePath
        val connectionId = binding.connectionId
        downloadWork?.cancel()
        _state.value = current.copy(download = RemoteFileDownloadUiState.Loading(target, 0, 0))
        val downloadGeneration = loadGeneration
        val downloadStopVersion = _stopVersion.value
        fun downloadIsCurrent(): Boolean = loadGeneration == downloadGeneration && _stopVersion.value == downloadStopVersion
        downloadWork = scope.launch {
            var staging: TemporaryDownload? = null
            try {
                val info = transport.send<FileInfoResponse>(
                    RemoteCommand(
                        cmd = "get_file_info",
                        path = target.remotePath,
                        sessionId = target.sessionId.ifEmpty { null },
                        workspacePath = workspacePath, remoteConnectionId = connectionId,
                    ),
                )
                if (!downloadIsCurrent()) throw CancellationException("File target changed")
                val total = info.size ?: error("remote file size is unavailable")
                check(total >= 0) { "Remote file size is invalid" }
                val sink = TemporaryDownload(info.name ?: basename(target.remotePath))
                staging = sink
                var offset = 0L
                var revision: String? = null
                val expectedTotal = total
                var name = info.name ?: basename(target.remotePath)
                var mime = info.mimeType ?: "application/octet-stream"
                updateReady { it.copy(download = RemoteFileDownloadUiState.Loading(target, 0, total)) }
                do {
                    val response = transport.send<ReadFileChunkResponse>(
                        RemoteCommand(
                            cmd = "read_file_chunk",
                            path = target.remotePath,
                            sessionId = target.sessionId.ifEmpty { null },
                        workspacePath = workspacePath, remoteConnectionId = connectionId,
                            offset = offset.toLong(),
                            limit = DOWNLOAD_CHUNK_BYTES,
                        ),
                    )
                    if (!downloadIsCurrent()) throw CancellationException("File target changed")
                    val bytes = withContext(backgroundDispatcher) { decode(response.chunkBase64.orEmpty()) }
                    validateFileChunk(response, bytes, offset, expectedTotal, DOWNLOAD_CHUNK_BYTES)
                    if (response.name != null && response.name != name || response.mimeType != null && response.mimeType != mime) {
                        error("remote file changed during transfer")
                    }
                    if (offset > 0 && response.revision != revision) error("remote file changed during transfer")
                    revision = response.revision
                    withContext(backgroundDispatcher) { sink.write(bytes) }
                    if (!downloadIsCurrent()) throw CancellationException("File target changed")
                    offset += bytes.size
                    name = response.name?.takeIf(String::isNotBlank) ?: name
                    mime = response.mimeType?.takeIf(String::isNotBlank) ?: mime
                    val responseTotal = expectedTotal.coerceAtLeast(offset.toLong())
                    updateReady {
                        it.copy(download = RemoteFileDownloadUiState.Loading(target, offset.toLong(), responseTotal))
                    }
                } while (offset.toLong() < expectedTotal)
                withContext(backgroundDispatcher) { sink.close() }
                if (!downloadIsCurrent()) throw CancellationException("File target changed")
                downloadStaging?.delete()
                downloadStaging = sink
                staging = null
                updateReady {
                    it.copy(download = RemoteFileDownloadUiState.AwaitingSave(target, name, mime, sink.reference))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (!downloadIsCurrent()) return@launch
                failDownload(target, error.message.orEmpty())
            } finally { staging?.delete() }
        }
    }

    private fun finishDownload(reference: String, saved: Boolean) {
        val current = (_state.value as? RemoteWorkspaceUiState.Ready)?.download
            as? RemoteFileDownloadUiState.AwaitingSave ?: return
        if (reference != current.target.path && reference != current.target.remotePath) return
        downloadStaging?.delete(); downloadStaging = null
        updateReady {
            it.copy(
                download = if (saved) {
                    RemoteFileDownloadUiState.Saved(current.target, current.name)
                } else {
                    RemoteFileDownloadUiState.Failed(current.target, FilePreviewFailureKind.LOAD_FAILED, true)
                },
            )
        }
    }

    private fun failDownload(target: FilePreviewTarget, message: String) {
        val failure = if (message.isBlank()) {
            FilePreviewFailure(FilePreviewFailureReason.LOAD_FAILED, true)
        } else {
            FilePreviewPolicy.failure(message)
        }
        updateReady {
            it.copy(download = RemoteFileDownloadUiState.Failed(target, failure.toKind(), failure.retryable))
        }
    }

    private suspend fun loadText(
        target: FilePreviewTarget,
        identity: PreviewRequestIdentity,
        generation: Long,
        name: String,
        mime: String,
        size: Long,
        connectionId: String?,
        markdown: Boolean,
    ) {
        val limit = FilePreviewPolicy.textReadLimit(size).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val response = readChunk(target, limit, connectionId)
        val bytes = withContext(backgroundDispatcher) { decode(response.chunkBase64.orEmpty()) }
        val content = withContext(backgroundDispatcher) { bytes.decodeToString() }
        // The type said text; the bytes are the only thing that can disagree,
        // and a wall of replacement characters is worse than saying no.
        if (FilePreviewPolicy.looksBinary(bytes) || FilePreviewPolicy.looksUndecodable(bytes, content)) {
            updatePreview(identity, generation) {
                it.copy(
                    preview = RemoteFilePreviewUiState.Unsupported(
                        target,
                        response.mimeType ?: mime,
                        response.totalSize ?: size,
                        identity,
                    ),
                )
            }
            return
        }
        updatePreview(identity, generation) {
            it.copy(
                preview = RemoteFilePreviewUiState.Text(
                    target = target,
                    name = response.name ?: name,
                    content = content,
                    truncated = (response.totalSize ?: size) > bytes.size,
                    loadedBytes = bytes.size.toLong(),
                    mimeType = response.mimeType ?: mime,
                    sizeBytes = response.totalSize ?: size,
                    markdown = markdown,
                    identity = identity,
                ),
            )
        }
    }

    private suspend fun loadImage(target: FilePreviewTarget, identity: PreviewRequestIdentity, generation: Long, name: String, mime: String, size: Long, connectionId: String?) {
        val chunks = mutableListOf<ByteArray>()
        var revision: String? = null
        var offset = 0
        do {
            if (previewGeneration != generation) throw CancellationException("File target changed")
            val response = transport.send<ReadFileChunkResponse>(RemoteCommand(
                cmd = "read_file_chunk", path = target.remotePath,
                sessionId = target.sessionId.ifEmpty { null }, workspacePath = target.workspacePath.takeIf { target.sessionId.isEmpty() }, remoteConnectionId = connectionId, offset = offset.toLong(),
                limit = minOf(DOWNLOAD_CHUNK_BYTES, (size - offset).coerceAtLeast(1).toInt()),
            ))
            if (previewGeneration != generation) throw CancellationException("File target changed")
            val chunk = withContext(backgroundDispatcher) { decode(response.chunkBase64.orEmpty()) }
            validateFileChunk(response, chunk, offset.toLong(), size, DOWNLOAD_CHUNK_BYTES)
            if (response.name != null && response.name != name || response.mimeType != null && response.mimeType != mime) {
                error("remote image changed during transfer")
            }
            if (offset > 0 && response.revision != revision) error("remote image changed during transfer")
            revision = response.revision
            chunks += chunk
            offset += chunk.size
        } while (offset.toLong() < size)
        val bytes = withContext(backgroundDispatcher) { chunks.joinBytes() }
        updatePreview(identity, generation) {
            it.copy(
                preview = RemoteFilePreviewUiState.Image(
                    target = target,
                    name = name,
                    mimeType = mime,
                    bytes = bytes,
                    sizeBytes = size,
                    identity = identity,
                ),
            )
        }
    }

    private fun validateFileChunk(response: ReadFileChunkResponse, bytes: ByteArray, offset: Long, total: Long, limit: Int) {
        if (response.offset != null && response.offset != offset.toLong() ||
            response.chunkSize != null && response.chunkSize != bytes.size.toLong() ||
            response.totalSize != null && response.totalSize != total ||
            bytes.size > limit || bytes.size.toLong() > total - offset ||
            bytes.isEmpty() && offset.toLong() < total) {
            error("remote file transfer is incomplete or inconsistent")
        }
    }

    private suspend fun readChunk(target: FilePreviewTarget, limit: Int, connectionId: String?): ReadFileChunkResponse =
        transport.send(
            RemoteCommand(
                cmd = "read_file_chunk",
                path = target.remotePath,
                sessionId = target.sessionId.ifEmpty { null },
                workspacePath = target.workspacePath.takeIf { target.sessionId.isEmpty() }, remoteConnectionId = connectionId,
                offset = 0,
                limit = limit,
            ),
        )

    private fun failPreview(target: FilePreviewTarget, identity: PreviewRequestIdentity, generation: Long, message: String, mime: String, size: Long) {
        val failure = if (message.isBlank()) {
            FilePreviewFailure(FilePreviewFailureReason.LOAD_FAILED, true)
        } else {
            FilePreviewPolicy.failure(message)
        }
        updatePreview(identity, generation) {
            it.copy(
                preview = RemoteFilePreviewUiState.Failed(target, failure.toKind(), failure.retryable, mime, size, identity),
            )
        }
    }

    private fun updatePreview(
        identity: PreviewRequestIdentity,
        generation: Long,
        transform: (RemoteWorkspaceUiState.Ready) -> RemoteWorkspaceUiState.Ready,
    ) {
        if (previewGeneration != generation || activePreviewRequestId != identity.requestId) return
        updateReady(transform)
    }

    private fun updateReady(transform: (RemoteWorkspaceUiState.Ready) -> RemoteWorkspaceUiState.Ready) {
        val current = _state.value as? RemoteWorkspaceUiState.Ready ?: return
        _state.value = transform(current)
        if (catalogDirty && catalogRefresh?.isActive != true) refreshCatalog()
    }

    private fun WorkspaceInfoResponse.asSelectedWorkspace(): SelectedWorkspace? {
        val path = resolvedPath.orEmpty()
        if (hasWorkspace != true && path.isEmpty()) return null
        return SelectedWorkspace(
            path = path,
            name = resolvedName?.takeIf(String::isNotBlank) ?: basename(path),
            gitBranch = gitBranch.orEmpty(),
            workspaceId = workspaceId,
            kind = workspaceKind.orEmpty(),
            assistantId = assistantId,
            remoteConnectionId = remoteConnectionId.takeUnless { workspaceKind == "normal" || workspaceKind == "assistant" },
            remoteSshHost = remoteSshHost.takeUnless { workspaceKind == "normal" || workspaceKind == "assistant" },
        )
    }

    private fun decode(value: String): ByteArray = Base64.Default.decode(value)

    private fun List<ByteArray>.joinBytes(): ByteArray {
        val result = ByteArray(sumOf { it.size })
        var offset = 0
        forEach { chunk ->
            chunk.copyInto(result, offset)
            offset += chunk.size
        }
        return result
    }

    private fun basename(path: String): String = path.replace('\\', '/').substringAfterLast('/').ifEmpty { "file" }

    private fun failRetainingCache() {
        _state.value = (_state.value as? RemoteWorkspaceUiState.Ready)
            ?.copy(busy = false, loadFailure = true)
            ?: RemoteWorkspaceUiState.Failed(true)
    }

    private fun cachedReady(rows: List<PersistedRemoteWorkspace>): RemoteWorkspaceUiState.Ready {
        val assistants = rows.filter { it.workspaceKind == ASSISTANT_KIND }.map { row ->
            WorkspaceAssistant(row.path, row.name.ifEmpty { basename(row.path) }, null, row.workspaceId)
        }
        val workspaces = rows.filterNot { it.workspaceKind == ASSISTANT_KIND }.map { row ->
            RecentWorkspace(row.path, row.name.ifEmpty { basename(row.path) }, row.lastOpened, row.workspaceKind, row.remoteSshHost, row.remoteConnectionId, row.workspaceId)
        }
        return RemoteWorkspaceUiState.Ready(
            workspaces = workspaces,
            assistants = assistants,
            selected = null,
            preview = RemoteFilePreviewUiState.None,
            busy = true,
            download = RemoteFileDownloadUiState.None,
            loadFailure = false,
        )
    }

    private fun persistedCatalog(
        workspaces: List<RecentWorkspace>,
        assistants: List<WorkspaceAssistant>,
    ): List<PersistedRemoteWorkspace> {
        val rows = workspaces.map { workspace ->
            PersistedRemoteWorkspace(workspace.path, workspace.name, workspace.lastOpened, workspace.kind, workspace.remoteSshHost, workspace.remoteConnectionId, workspace.workspaceId)
        }.toMutableList()
        // Dedupe by workspace identity (ID first, legacy triple otherwise), never by path:
        // an assistant and a project may share a root and must both survive the cache.
        assistants.forEach { assistant ->
            val row = PersistedRemoteWorkspace(assistant.path, assistant.name, "", ASSISTANT_KIND, null, null, assistant.workspaceId)
            if (rows.none { it.key == row.key }) rows += row
        }
        return rows
    }

    internal fun mergedCatalog(
        workspaces: List<RecentWorkspace>,
        assistants: List<WorkspaceAssistant>,
    ): List<RecentWorkspace> {
        return projectWorkspaceCatalog(workspaces, assistants).workspaces
    }

    public companion object {
        internal fun create(scope: CoroutineScope, transport: RemoteCommandTransport): RemoteWorkspaceStore =
            RemoteWorkspaceStore(scope, transport, Dispatchers.Default)

        internal fun create(
            scope: CoroutineScope,
            transport: RemoteCommandTransport,
            backgroundDispatcher: CoroutineDispatcher,
        ): RemoteWorkspaceStore = RemoteWorkspaceStore(scope, transport, backgroundDispatcher)

        internal fun create(
            scope: CoroutineScope,
            transport: RemoteCommandTransport,
            backgroundDispatcher: CoroutineDispatcher,
            deviceKey: String,
            persistence: RemoteWorkspaceListStore? = null,
        ): RemoteWorkspaceStore = RemoteWorkspaceStore(scope, transport, backgroundDispatcher, deviceKey, persistence)

        private const val DOWNLOAD_CHUNK_BYTES = 3 * 1024 * 1024
        private const val ASSISTANT_KIND = "assistant"
    }
}
