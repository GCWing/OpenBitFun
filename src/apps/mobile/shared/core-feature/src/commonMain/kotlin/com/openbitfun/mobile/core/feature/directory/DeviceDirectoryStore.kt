package com.openbitfun.mobile.core.feature.directory

import com.openbitfun.mobile.core.domain.RemoteWorkspaceIdentity
import com.openbitfun.mobile.core.domain.LegacyWorkspaceCompatibility
import com.openbitfun.mobile.core.domain.identity
import com.openbitfun.mobile.core.domain.belongsTo

import com.openbitfun.mobile.core.domain.RemoteSession
import com.openbitfun.mobile.core.domain.RecentWorkspace
import com.openbitfun.mobile.core.feature.account.AccountStore
import com.openbitfun.mobile.core.feature.session.RemoteSessionStore
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * A per-device directory fan-out.
 *
 * Each account device gets its own [RemoteSessionStore] and [RemoteWorkspaceStore]
 * keyed by the device id, so one device loading, failing, or stopping never
 * clears another. This store owns only the fan-out coordination; transport,
 * protocol, and persistence stay inside the stores it reuses.
 */
public class DeviceDirectoryStore internal constructor(
    private val scope: CoroutineScope,
    private val factory: DeviceStoreFactory,
) {
    private val _state = MutableStateFlow<DeviceDirectoryUiState>(DeviceDirectoryUiState(emptyList()))
    public val state: StateFlow<DeviceDirectoryUiState> = _state.asStateFlow()

    private val devices = linkedMapOf<String, DeviceDirectoryEntry>()
    private val slots = mutableMapOf<String, DeviceSlot>()
    private val loads = mutableMapOf<String, Job>()
    private val generations = mutableMapOf<String, Long>()
    private val epochs = mutableMapOf<String, Long>()
    private val workspaceLoads = mutableMapOf<String, Job>()
    private val workspaceGenerations = mutableMapOf<String, Long>()

    public fun dispatch(intent: DeviceDirectoryIntent) {
        when (intent) {
            is DeviceDirectoryIntent.Sync -> sync(intent.devices)
            is DeviceDirectoryIntent.Load -> load(intent.deviceId)
            is DeviceDirectoryIntent.Retry -> retry(intent.deviceId)
            is DeviceDirectoryIntent.SetWorkspaceExpanded -> setWorkspaceExpanded(
                intent.deviceId,
                RemoteWorkspaceIdentity(intent.path, intent.remoteConnectionId, intent.remoteSshHost, intent.workspaceId),
                intent.expanded,
            )
            is DeviceDirectoryIntent.RetryWorkspace -> retryWorkspace(intent.deviceId, RemoteWorkspaceIdentity(intent.path, intent.remoteConnectionId, intent.remoteSshHost, intent.workspaceId))
            DeviceDirectoryIntent.Stop -> stop()
        }
    }

    /** Captures the membership epoch that a later confirmed create must match. */
    public fun reconcileKey(deviceId: String): DeviceDirectoryReconcileKey? {
        val id = deviceId.trim()
        val entry = devices[id] ?: return null
        if (!entry.online) return null
        return DeviceDirectoryReconcileKey(id, epochs[id] ?: return null)
    }

    /**
     * Merges one server-confirmed create into only its owning device and writes
     * that device's session-list persistence. A stale membership key is rejected
     * synchronously, so logout/removal/reconnect cannot resurrect an old row.
     */
    public fun reconcileCreatedSession(
        key: DeviceDirectoryReconcileKey,
        session: RemoteSession,
    ): Boolean {
        val id = key.deviceId.trim()
        val current = devices[id] ?: return false
        if (!current.online || epochs[id] != key.epoch || session.id.isBlank()) return false
        val slot = slotFor(id) ?: return false
        if (!slot.sessionStore.reconcileConfirmedCreatedSession(session)) return false
        val sessions = mergeSession(current.sessions, session)
        devices[id] = current.copy(sessions = sessions)
        publish()
        return true
    }

    /**
     * Cancels every running load and releases the underlying stores, while
     * keeping the directory entries themselves: already-loaded data stays on
     * screen and in memory, so a later stop/resume does not need a re-fetch.
     */
    public fun stop() {
        for (job in loads.values) job.cancel()
        loads.clear()
        for (job in workspaceLoads.values) job.cancel()
        workspaceLoads.clear()
        for (id in devices.keys) {
            invalidate(id)
            invalidateEpoch(id)
            invalidateDeviceWorkspaces(id)
            if (devices[id]?.status == DeviceDirectoryStatus.LOADING) {
                devices[id] = devices.getValue(id).copy(status = DeviceDirectoryStatus.IDLE, error = null)
            }
            devices[id]?.let { entry ->
                devices[id] = entry.copy(
                    workspaceDirectory = entry.workspaceDirectory.map { workspace ->
                        if (workspace.status == WorkspaceDirectoryStatus.LOADING) {
                            workspace.copy(status = WorkspaceDirectoryStatus.IDLE)
                        } else {
                            workspace
                        }
                    },
                )
            }
        }
        publish()
        for (slot in slots.values) stopSlot(slot)
        slots.clear()
    }

    private fun sync(incoming: List<DeviceDirectoryDevice>) {
        val ids = linkedSetOf<String>()
        val added = linkedSetOf<String>()
        val updated = linkedMapOf<String, DeviceDirectoryEntry>()
        for (device in incoming) {
            val id = device.deviceId.trim()
            if (id.isEmpty()) continue
            ids += id
            val existing = devices[id]
            if (existing == null) {
                invalidateEpoch(id)
                added += id
            } else if (existing.online && !device.online) {
                invalidate(id)
                invalidateEpoch(id)
                loads.remove(id)?.cancel()
                cancelDeviceWorkspaceLoads(id)
                slots.remove(id)?.let(::stopSlot)
            }
            updated[id] = if (existing == null) {
                DeviceDirectoryEntry.empty(id, device.deviceName, device.online)
            } else {
                existing.copy(
                    deviceName = device.deviceName,
                    online = device.online,
                    workspaceDirectory = existing.workspaceDirectory.map { workspace ->
                        if (!device.online && workspace.status == WorkspaceDirectoryStatus.LOADING) {
                            workspace.copy(status = WorkspaceDirectoryStatus.IDLE)
                        } else workspace
                    },
                    status = if (device.online) {
                        existing.status
                    } else if (existing.workspaces.isNotEmpty() || existing.sessions.isNotEmpty()) {
                        DeviceDirectoryStatus.CACHED
                    } else {
                        DeviceDirectoryStatus.IDLE
                    },
                    error = if (device.online) existing.error else null,
                )
            }
        }
        val removed = devices.keys - ids
        devices.clear()
        devices.putAll(updated)
        for (id in removed) {
            invalidate(id)
            invalidateEpoch(id)
            loads.remove(id)?.cancel()
            cancelDeviceWorkspaceLoads(id)
            slots.remove(id)?.let(::stopSlot)
        }
        for (id in added) hydrateFromCache(id)
        publish()
    }

    private fun load(deviceId: String) {
        val id = deviceId.trim()
        if (id.isEmpty()) return
        val entry = devices[id] ?: return
        if (!entry.online) return
        if (loads[id]?.isActive == true) return
        if (entry.status == DeviceDirectoryStatus.READY) return
        val slot = slotFor(id)
        if (slot == null) {
            setEntry(id) { it.copy(status = DeviceDirectoryStatus.FAILED, error = DeviceDirectoryFailure.NOT_SIGNED_IN) }
            return
        }
        startLoad(id, slot, entry)
    }

    private fun retry(deviceId: String) {
        val id = deviceId.trim()
        if (id.isEmpty()) return
        val entry = devices[id] ?: return
        if (!entry.online) return
        if (loads[id]?.isActive == true) return
        val slot = slotFor(id)
        if (slot == null) {
            setEntry(id) { it.copy(status = DeviceDirectoryStatus.FAILED, error = DeviceDirectoryFailure.NOT_SIGNED_IN) }
            return
        }
        startLoad(id, slot, entry)
    }

    private fun setWorkspaceExpanded(deviceId: String, reference: RemoteWorkspaceIdentity, expanded: Boolean) {
        val identity = LegacyWorkspaceCompatibility.resolve(reference, devices[deviceId]?.workspaces.orEmpty().map { it.identity() })
            ?: run { setEntry(deviceId) { it.copy(status = DeviceDirectoryStatus.FAILED, error = DeviceDirectoryFailure.LOAD_FAILED) }; return }
        val id = deviceId.trim()
        val normalizedPath = normalizeWorkspacePath(identity.path)
        val entry = devices[id] ?: return
        if (normalizedPath.isEmpty()) return
        updateWorkspaceState(id, identity) { it.copy(expanded = expanded) }
        if (!expanded || !entry.online) return
        val state = devices[id]?.workspace(identity)
        if (state?.status != WorkspaceDirectoryStatus.READY) loadWorkspaceSessions(id, identity, false)
    }

    private fun retryWorkspace(deviceId: String, reference: RemoteWorkspaceIdentity) {
        val identity = LegacyWorkspaceCompatibility.resolve(reference, devices[deviceId]?.workspaces.orEmpty().map { it.identity() })
            ?: run { setEntry(deviceId) { it.copy(status = DeviceDirectoryStatus.FAILED, error = DeviceDirectoryFailure.LOAD_FAILED) }; return }
        val id = deviceId.trim()
        val normalizedPath = normalizeWorkspacePath(identity.path)
        val entry = devices[id] ?: return
        if (normalizedPath.isEmpty() || !entry.online) return
        updateWorkspaceState(id, identity) { it.copy(expanded = true) }
        loadWorkspaceSessions(id, identity, true)
    }

    private fun loadWorkspaceSessions(deviceId: String, identity: RemoteWorkspaceIdentity, force: Boolean) {
        val key = workspaceKey(deviceId, identity)
        if (workspaceLoads[key]?.isActive == true) return
        val entry = devices[deviceId] ?: return
        if (!entry.online) return
        val existing = entry.workspace(identity)
        if (!force && existing?.status == WorkspaceDirectoryStatus.READY) return
        val slot = slotFor(deviceId) ?: run {
            updateWorkspaceState(deviceId, identity) { it.copy(status = WorkspaceDirectoryStatus.FAILED) }
            return
        }
        val generation = nextWorkspaceGeneration(key)
        updateWorkspaceState(deviceId, identity) { it.copy(status = WorkspaceDirectoryStatus.LOADING) }
        val job = scope.launch {
            try {
                val loaded = slot.sessionStore.sessionsForWorkspace(identity)
                if (!isCurrentWorkspace(key, generation) || devices[deviceId]?.online != true) return@launch
                val current = devices[deviceId] ?: return@launch
                val merged = replaceWorkspaceSessions(current.sessions, identity, loaded)
                slot.sessionStore.persistDirectorySessions(merged)
                devices[deviceId] = current.copy(
                    sessions = merged,
                    workspaceDirectory = updateWorkspaceList(current.workspaceDirectory, identity) {
                        it.copy(status = WorkspaceDirectoryStatus.READY)
                    },
                )
                publish()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (isCurrentWorkspace(key, generation)) {
                    updateWorkspaceState(deviceId, identity) { it.copy(status = WorkspaceDirectoryStatus.FAILED) }
                }
            } finally {
                if (workspaceLoads[key] === coroutineContext[Job]) workspaceLoads.remove(key)
            }
        }
        workspaceLoads[key] = job
        if (!job.isActive && workspaceLoads[key] === job) workspaceLoads.remove(key)
    }

    private fun slotFor(id: String): DeviceSlot? {
        slots[id]?.let { return it }
        val sessionStore = factory.createSessionStore(scope, id) ?: return null
        val workspaceStore = try {
            factory.createWorkspaceStore(scope, id)
        } catch (error: Throwable) {
            sessionStore.stop()
            throw error
        }
        if (workspaceStore == null) {
            sessionStore.stop()
            return null
        }
        val slot = DeviceSlot(sessionStore, workspaceStore)
        slots[id] = slot
        return slot
    }

    private fun hydrateFromCache(id: String) {
        val current = devices[id] ?: return
        val slot = try {
            slotFor(id)
        } catch (_: Throwable) {
            null
        } ?: return
        val cachedWorkspaces = slot.workspaceStore.cachedCatalog()
        val cachedSessions = slot.sessionStore.cachedSessions()
        if (cachedWorkspaces.isEmpty() && cachedSessions.isEmpty()) return
        val sessions = if (cachedSessions.isEmpty()) current.sessions else cachedSessions
        val workspaces = when {
            current.catalogSource != null -> current.workspaces
            cachedWorkspaces.isNotEmpty() -> cachedWorkspaces
            current.workspaces.isNotEmpty() -> current.workspaces
            else -> emptyList()
        }
        val workspaceDirectory = syncWorkspaceDirectory(current.workspaceDirectory, workspaces).map { workspace ->
            if (sessions.any { session ->
                    session.belongsTo(workspace.identity, workspaces.map { it.identity() })
                }
            ) {
                workspace.copy(status = WorkspaceDirectoryStatus.READY)
            } else {
                workspace
            }
        }
        devices[id] = current.copy(
            status = if (current.status == DeviceDirectoryStatus.IDLE) DeviceDirectoryStatus.CACHED else current.status,
            workspaces = workspaces,
            sessions = sessions,
            workspaceDirectory = workspaceDirectory,
        )
    }

    private fun startLoad(id: String, slot: DeviceSlot, previous: DeviceDirectoryEntry) {
        val generation = nextGeneration(id)
        setEntry(id) { it.copy(status = DeviceDirectoryStatus.LOADING, error = null) }
        val job = scope.launch {
            try {
                runLoad(id, slot, generation)
            } catch (cancelled: CancellationException) {
                // Cancellation from stop/offline/remove must not restore an entry
                // after a newer generation has already started.
                val current = devices[id]
                if (isCurrent(id, generation) && current?.status == DeviceDirectoryStatus.LOADING) {
                    devices[id] = previous.copy(workspaceDirectory = current.workspaceDirectory)
                    publish()
                }
                throw cancelled
            } finally {
                // Never remove a newer job installed for the same device.
                if (loads[id] === coroutineContext[Job]) loads.remove(id)
            }
        }
        loads[id] = job
        if (!job.isActive && loads[id] === job) loads.remove(id)
    }

    private suspend fun runLoad(id: String, slot: DeviceSlot, generation: Long) {
        if (!isCurrent(id, generation)) return
        try {
            val catalog = slot.workspaceStore.directoryCatalog()
            val workspaces = catalog.workspaces
            if (!isCurrent(id, generation)) return
            val current = devices[id] ?: return
            // A device that went offline while its request was in flight stays
            // in the offline state established by sync; the late result is stale.
            if (!current.online) return
            devices[id] = current.copy(
                status = DeviceDirectoryStatus.READY,
                error = null,
                workspaces = workspaces,
                catalogSource = catalog.source,
                recentWorkspaces = catalog.recentWorkspaces,
                workspaceDirectory = syncWorkspaceDirectory(current.workspaceDirectory, workspaces),
            )
            publish()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            if (!isCurrent(id, generation)) return
            val current = devices[id] ?: return
            if (!current.online) return
            devices[id] = current.copy(
                status = DeviceDirectoryStatus.FAILED,
                error = DeviceDirectoryFailure.LOAD_FAILED,
            )
            publish()
        }
    }

    private fun replaceWorkspaceSessions(
        sessions: List<RemoteSession>, identity: RemoteWorkspaceIdentity, replacement: List<RemoteSession>,
    ): List<RemoteSession> {
        val replacementIds = replacement.mapTo(mutableSetOf()) { it.id }
        return replacement + sessions.filter { it.id !in replacementIds && it.workspaceIdentity?.matches(identity) != true }
    }

    private fun syncWorkspaceDirectory(
        current: List<WorkspaceDirectoryEntry>, workspaces: List<RecentWorkspace>,
    ): List<WorkspaceDirectoryEntry> = workspaces.map { workspace ->
        current.firstOrNull { it.identity.matches(workspace.identity()) }?.copy(path = workspace.path)
            ?: WorkspaceDirectoryEntry(workspace.path, false, WorkspaceDirectoryStatus.IDLE, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId)
    }

    private fun updateWorkspaceList(
        current: List<WorkspaceDirectoryEntry>, identity: RemoteWorkspaceIdentity,
        transform: (WorkspaceDirectoryEntry) -> WorkspaceDirectoryEntry,
    ): List<WorkspaceDirectoryEntry> {
        var found = false
        val updated = current.map { entry ->
            if (entry.identity.matches(identity)) { found = true; transform(entry) } else entry
        }.toMutableList()
        if (!found) updated += transform(WorkspaceDirectoryEntry(identity.path, false, WorkspaceDirectoryStatus.IDLE, identity.remoteConnectionId, identity.remoteSshHost, identity.workspaceId))
        return updated
    }

    private fun updateWorkspaceState(
        deviceId: String, identity: RemoteWorkspaceIdentity, transform: (WorkspaceDirectoryEntry) -> WorkspaceDirectoryEntry,
    ) {
        val current = devices[deviceId] ?: return
        devices[deviceId] = current.copy(workspaceDirectory = updateWorkspaceList(current.workspaceDirectory, identity, transform))
        publish()
    }

    private fun workspaceKey(deviceId: String, identity: RemoteWorkspaceIdentity): String = "$deviceId\u0001${identity.key}"

    private fun normalizeWorkspacePath(path: String): String {
        val trimmed = path.trim()
        val normalized = trimmed.trimEnd('/')
        return normalized.ifEmpty { trimmed }
    }

    private fun nextWorkspaceGeneration(key: String): Long {
        val next = (workspaceGenerations[key] ?: 0L) + 1L
        workspaceGenerations[key] = next
        return next
    }

    private fun isCurrentWorkspace(key: String, generation: Long): Boolean =
        workspaceGenerations[key] == generation

    private fun invalidateDeviceWorkspaces(deviceId: String) {
        val prefix = "$deviceId\u0001"
        workspaceGenerations.keys.filter { it.startsWith(prefix) }.forEach { key ->
            workspaceGenerations[key] = (workspaceGenerations[key] ?: 0L) + 1L
        }
    }

    private fun cancelDeviceWorkspaceLoads(deviceId: String) {
        val prefix = "$deviceId\u0001"
        workspaceLoads.keys.filter { it.startsWith(prefix) }.forEach { key ->
            workspaceLoads.remove(key)?.cancel()
            workspaceGenerations[key] = (workspaceGenerations[key] ?: 0L) + 1L
        }
    }

    private fun nextGeneration(id: String): Long {
        val next = (generations[id] ?: 0L) + 1L
        generations[id] = next
        return next
    }

    private fun invalidate(id: String) {
        generations[id] = (generations[id] ?: 0L) + 1L
    }

    private fun invalidateEpoch(id: String) {
        epochs[id] = (epochs[id] ?: 0L) + 1L
    }

    private fun mergeSession(
        sessions: List<RemoteSession>,
        confirmed: RemoteSession,
    ): List<RemoteSession> =
        listOf(confirmed) + sessions.filterNot { it.id == confirmed.id }

    private fun isCurrent(id: String, generation: Long): Boolean = generations[id] == generation

    private inline fun setEntry(id: String, transform: (DeviceDirectoryEntry) -> DeviceDirectoryEntry) {
        val entry = devices[id] ?: return
        devices[id] = transform(entry)
        publish()
    }

    private fun stopSlot(slot: DeviceSlot) {
        slot.sessionStore.stop()
        slot.workspaceStore.stop()
    }

    private fun publish() {
        _state.value = DeviceDirectoryUiState(devices.values.toList())
    }

    public companion object {
        public fun create(scope: CoroutineScope, accountStore: AccountStore): DeviceDirectoryStore =
            DeviceDirectoryStore(scope, AccountDeviceStoreFactory(accountStore))

        internal fun create(scope: CoroutineScope, factory: DeviceStoreFactory): DeviceDirectoryStore =
            DeviceDirectoryStore(scope, factory)
    }
}

/** Creates a device-keyed store pair through [AccountStore]'s explicit-device entry points. */
private class AccountDeviceStoreFactory(
    private val accountStore: AccountStore,
) : DeviceStoreFactory {
    override fun createSessionStore(scope: CoroutineScope, deviceId: String): RemoteSessionStore? =
        accountStore.createSessionStore(scope, deviceId)

    override fun createWorkspaceStore(scope: CoroutineScope, deviceId: String): RemoteWorkspaceStore? =
        accountStore.createWorkspaceStore(scope, deviceId)
}

internal interface DeviceStoreFactory {
    fun createSessionStore(scope: CoroutineScope, deviceId: String): RemoteSessionStore?
    fun createWorkspaceStore(scope: CoroutineScope, deviceId: String): RemoteWorkspaceStore?
}

private class DeviceSlot(
    val sessionStore: RemoteSessionStore,
    val workspaceStore: RemoteWorkspaceStore,
)
