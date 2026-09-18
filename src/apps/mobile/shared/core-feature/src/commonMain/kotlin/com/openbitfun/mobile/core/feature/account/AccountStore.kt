package com.openbitfun.mobile.core.feature.account

import com.openbitfun.mobile.core.feature.relay.HostCatalogNotice
import com.openbitfun.mobile.core.feature.relay.hostCatalogObserver
import com.openbitfun.mobile.core.transport.RemoteSessionStreamTransport
import com.openbitfun.mobile.core.feature.CoreLog
import com.openbitfun.mobile.core.feature.session.RemoteSessionStore
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceStore
import com.openbitfun.mobile.core.persistence.MobilePersistenceStores
import com.openbitfun.mobile.core.persistence.SecureStore
import com.openbitfun.mobile.core.transport.AccountDeviceCommandTransport
import com.openbitfun.mobile.core.transport.CloudAccountClient
import com.openbitfun.mobile.core.transport.CloudAccountDevice
import com.openbitfun.mobile.core.transport.CloudAccountException
import com.openbitfun.mobile.core.transport.CloudAccountFailure
import com.openbitfun.mobile.core.transport.CloudAccountSession
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import com.openbitfun.mobile.core.transport.TransportLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.io.encoding.Base64

internal data class AccountSessionData(
    val relayUrl: String,
    val username: String,
    val token: String,
    val userId: String,
    val masterKey: ByteArray,
    val targetDeviceId: String?,
    val targetDeviceName: String?,
)

internal interface AccountBackend {
    suspend fun login(
        relayUrl: String,
        deviceId: String,
        deviceName: String,
        deviceSecret: ByteArray,
        onAuthorization: (String) -> Unit,
    ): AccountSessionData

    /** [selfDeviceId] lets the transport drop this device's own row. */
    suspend fun listDevices(session: AccountSessionData, selfDeviceId: String): List<AccountDeviceUi>

    suspend fun profile(userId: String): com.openbitfun.mobile.core.transport.GitHubProfile? = null

    fun transport(session: AccountSessionData, targetDeviceId: String): RemoteCommandTransport
    fun closeAccount() {}
    fun resumeSessionStreams() {}
    fun directoryChanges(session: AccountSessionData): Flow<Unit> = emptyFlow()
}

public class AccountStore internal constructor(
    private val scope: CoroutineScope,
    private val backend: AccountBackend,
    private val secureStore: SecureStore,
    private val deviceId: String,
    private val deviceName: String,
    private val persistence: MobilePersistenceStores? = null,
) {
    private val _state = MutableStateFlow<AccountUiState>(AccountUiState.Idle)
    public val state: StateFlow<AccountUiState> = _state.asStateFlow()
    private var session: AccountSessionData? = null
    private var selectedRelayUrl: String = com.openbitfun.mobile.core.transport.DEFAULT_CLOUD_RELAY_URL
    private var catalogScope = CoroutineScope(scope.coroutineContext + kotlinx.coroutines.SupervisorJob())
    private fun closeCatalogs() { catalogScope.coroutineContext[Job]?.cancel(); catalogObservers.clear() }
    private val catalogObservers = mutableMapOf<String, Flow<HostCatalogNotice>>()
    init { scope.coroutineContext[Job]?.invokeOnCompletion { closeCatalogs() } }
    private fun catalogChanges(current: AccountSessionData, target: String): Flow<HostCatalogNotice> {
        val store = persistence?.relayStreams ?: return emptyFlow()
        if (catalogScope.coroutineContext[Job]?.isActive != true) catalogScope = CoroutineScope(scope.coroutineContext + kotlinx.coroutines.SupervisorJob())
        return catalogObservers.getOrPut(current.userId + ":" + current.token + ":" + target) {
            val source = backend.transport(current, target) as? RemoteSessionStreamTransport ?: return emptyFlow()
            hostCatalogObserver(catalogScope, source, store)
        }
    }
    private var directoryWork: Job? = null
    private var directoryIdentity: Pair<String, String>? = null
    private var directoryDirty = false
    private var work: Job? = null
    private var profileWork: Job? = null
    private var displayedProfile: AccountProfileRecord? = null
    private var profileAttemptAt: Long = 0
    private var profileAttempt: Pair<String, String>? = null
    /** Latest account membership snapshot, used to authorize explicit device stores. */
    private var controllableDevices: List<AccountDeviceUi> = emptyList()
    private var pendingInitialDeviceSelection = false

    public fun resumeSessionStreams() { backend.resumeSessionStreams() }

    public fun dispatch(intent: AccountIntent) {
        when (intent) {
            AccountIntent.Restore -> restore()
            AccountIntent.Login -> login()
            is AccountIntent.SelectRelay -> {
                val endpoint = com.openbitfun.mobile.core.transport.normalizeAccountRelayUrl(intent.relayUrl) ?: return
                if (session?.relayUrl != endpoint) {
                    work?.cancel()
                    session?.masterKey?.fill(0)
                    session = null
                    controllableDevices = emptyList()
                    selectedRelayUrl = endpoint
                    _state.value = AccountUiState.SignedOut
                }
            }
            is AccountIntent.SelectDevice -> selectDevice(intent.deviceId)
            AccountIntent.RefreshDevices -> refreshDevices()
            AccountIntent.Retry -> retryFailedStage()
            AccountIntent.Logout -> logout()
            AccountIntent.Stop -> stop()
        }
    }

    public fun createSessionStore(scope: CoroutineScope): RemoteSessionStore? {
        val current = session ?: return null
        val target = current.targetDeviceId?.let(::authorizedDeviceId) ?: return null
        return RemoteSessionStore.create(
            scope,
            backend.transport(current, target),
            deviceKey = target,
            persistence = persistence,
        ).also { it.bindCatalog(catalogChanges(current, target)) }
    }

    public fun createWorkspaceStore(scope: CoroutineScope): RemoteWorkspaceStore? {
        val current = session ?: return null
        val target = current.targetDeviceId?.let(::authorizedDeviceId) ?: return null
        return RemoteWorkspaceStore.create(
            scope,
            backend.transport(current, target),
            kotlinx.coroutines.Dispatchers.Default,
            target,
            persistence?.remoteWorkspaces,
            persistence?.relayStreams,
        ).also { it.bindCatalog(catalogChanges(current, target)) }
    }

    /**
     * A session store addressed to one specific device, independent of the
     * currently selected control target. This is how a multi-device directory
     * loads several devices at once while the old single-target methods keep
     * their existing meaning.
     */
    public fun createSessionStore(scope: CoroutineScope, deviceId: String): RemoteSessionStore? {
        val current = session ?: return null
        val target = authorizedDeviceId(deviceId) ?: return null
        return RemoteSessionStore.create(
            scope,
            backend.transport(current, target),
            deviceKey = target,
            persistence = persistence,
        ).also { it.bindCatalog(catalogChanges(current, target)) }
    }

    /** The explicit-device twin of [createWorkspaceStore]. */
    public fun createWorkspaceStore(scope: CoroutineScope, deviceId: String): RemoteWorkspaceStore? {
        val current = session ?: return null
        val target = authorizedDeviceId(deviceId) ?: return null
        return RemoteWorkspaceStore.create(
            scope,
            backend.transport(current, target),
            kotlinx.coroutines.Dispatchers.Default,
            target,
            persistence?.remoteWorkspaces,
            persistence?.relayStreams,
        ).also { it.bindCatalog(catalogChanges(current, target)) }
    }

    /**
     * The directory may retain an offline account row, but an explicit store is
     * still only granted to a device in the latest authenticated membership
     * snapshot. Offline is allowed here so cached directory data can be shown;
     * the directory's online guard prevents commands from being sent.
     */
    private fun authorizedDeviceId(deviceId: String): String? {
        val target = deviceId.trim().takeIf(String::isNotBlank) ?: return null
        return controllableDevices.firstOrNull { it.id == target }?.id
    }

    public fun stop() {
        closeCatalogs()
        directoryWork?.cancel(); directoryIdentity = null
        profileWork?.cancel()
        work?.cancel()
        work = null
    }

    private fun restore() {
        pendingInitialDeviceSelection = false
        work?.cancel()
        _state.value = AccountUiState.Restoring
        work = scope.launch {
            val restored = try {
                val stored = secureStore.read(SESSION_KEY)?.decodeToString()
                if (stored.isNullOrEmpty()) {
                    _state.value = AccountUiState.SignedOut
                    return@launch
                }
                decodeRecord(stored)
            } catch (_: Throwable) {
                // A record we cannot decode may belong to a newer or older app.
                // Keep the opaque value in secure storage so a retry or upgraded
                // client can still read it; only clear this store's projection.
                session = null
                controllableDevices = emptyList()
                _state.value = AccountUiState.Failed(
                    AccountFailureReason.SECURE_STORAGE,
                    true,
                    AccountFailureStage.RESTORE,
                )
                return@launch
            }
            if (restored.relayUrl.trimEnd('/').startsWith("https://remote.openbitfun.com/v/") &&
                restored.relayUrl.trimEnd('/') != AccountDefaults.CLOUD_RELAY_URL) {
                // Relay tokens belong to their issuing database. Keep the old encrypted
                // record/cache, but require a fresh login before using the new endpoint.
                selectedRelayUrl = AccountDefaults.CLOUD_RELAY_URL
                expireSession(AccountFailureReason.AUTHENTICATION, AccountFailureStage.AUTHENTICATION)
                return@launch
            }
            session = restored
            selectedRelayUrl = restored.relayUrl
            // Local credential restoration and remote directory availability are
            // separate facts. Publish identity before any network wait, but grant
            // no target authority until an authenticated membership snapshot arrives.
            publishReady(restored, emptyList(), selectionConfirmed = false)
            refreshDevices()
        }
    }

    /** A directory outage is not an authentication failure or device authority. */
    private fun publishDirectoryFailure(restored: AccountSessionData, reason: AccountFailureReason) {
        publishReady(restored, emptyList())
        val ready = _state.value as AccountUiState.Ready
        _state.value = ready.copy(refreshFailure = reason, selectedDeviceId = null, selectedDeviceName = null)
        // The saved target stays in session and is restored after the relay has
        // supplied its device directory. No new transport is authorized here.
    }

    private fun login() {
        pendingInitialDeviceSelection = false
        work?.cancel()
        _state.value = AccountUiState.SigningIn
        work = scope.launch {
            val deviceSecret = try {
                secureStore.read(DEVICE_KEY)?.also { require(it.size == 32) }
                    ?: (session?.masterKey?.copyOf() ?: CloudAccountClient.generateDeviceSecret()).also {
                        secureStore.write(DEVICE_KEY, it)
                    }
            } catch (_: Throwable) {
                failLogin(AccountFailureReason.SECURE_STORAGE, AccountFailureStage.SECURE_STORAGE)
                return@launch
            }
            val loginContext = currentCoroutineContext()
            val loggedIn = try {
                backend.login(
                    selectedRelayUrl,
                    deviceId,
                    deviceName,
                    deviceSecret,
                    { url -> if (loginContext.isActive) _state.value = AccountUiState.Authorizing(url) },
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: CloudAccountException) {
                currentCoroutineContext().ensureActive()
                failLogin(error.failure.toUiReason(), AccountFailureStage.AUTHENTICATION)
                return@launch
            } catch (_: Throwable) {
                currentCoroutineContext().ensureActive()
                // Live transport failures are normalized by CloudAccountClient.
                // An untyped failure here is therefore a crypto/protocol failure,
                // never evidence that secure storage was involved.
                failLogin(AccountFailureReason.MALFORMED_RESPONSE, AccountFailureStage.AUTHENTICATION)
                return@launch
            } finally {
                deviceSecret.fill(0)
            }

            currentCoroutineContext().ensureActive()
            controllableDevices = emptyList()
            if (!persistLogin(loggedIn)) return@launch
            session = loggedIn
            pendingInitialDeviceSelection = true

            val devices = loadDevices(loggedIn) ?: return@launch

            // Never this device, even as a fallback: driving the phone from
            // the phone is what `canSelectAccountDevice` forbids, and a
            // target nothing can be asked of is worse than none at all.
            val preferred = AccountDevicePolicy.preferredTarget(devices, deviceId)
            val selected = loggedIn.copy(
                targetDeviceId = preferred?.id,
                targetDeviceName = preferred?.name,
            )
            if (!persistLogin(selected)) return@launch
            session = selected
            pendingInitialDeviceSelection = false
            publishReady(selected, devices)
        }
    }

    private suspend fun loadDevices(current: AccountSessionData): List<AccountDeviceUi>? = try {
        backend.listDevices(current, deviceId).also { currentCoroutineContext().ensureActive() }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: CloudAccountException) {
        currentCoroutineContext().ensureActive()
        if (error.failure == CloudAccountFailure.AUTHENTICATION) {
            expireSession(error.failure.toUiReason(), AccountFailureStage.DEVICE_LIST)
        } else {
            publishDirectoryFailure(current, error.failure.toUiReason())
        }
        null
    } catch (_: Throwable) {
        currentCoroutineContext().ensureActive()
        publishDirectoryFailure(current, AccountFailureReason.NETWORK)
        null
    }

    private fun retryFailedStage() {
        if (_state.value is AccountUiState.Ready) { refreshDevices(); return }
        val failed = _state.value as? AccountUiState.Failed ?: return
        val current = session ?: return
        if (!failed.canRetry || failed.stage != AccountFailureStage.DEVICE_LIST) return
        work?.cancel()
        _state.value = AccountUiState.SigningIn
        work = scope.launch {
            val devices = loadDevices(current) ?: return@launch
            val preferred = current.targetDeviceId
                ?.let { selectedId -> devices.firstOrNull { it.id == selectedId } }
                ?.takeIf { AccountDevicePolicy.canSelect(it, deviceId) }
                ?: AccountDevicePolicy.preferredTarget(devices, deviceId)
            val selected = current.copy(
                targetDeviceId = preferred?.id,
                targetDeviceName = preferred?.name,
            )
            // This retry only refreshes the volatile device-list projection. The
            // authenticated bytes saved before the failed list request stay exact.
            session = selected
            pendingInitialDeviceSelection = false
            publishReady(selected, devices)
        }
    }

    private fun persistLogin(value: AccountSessionData): Boolean {
        val previous = try {
            secureStore.read(SESSION_KEY)
        } catch (_: Throwable) {
            failLogin(AccountFailureReason.SECURE_STORAGE, AccountFailureStage.SECURE_STORAGE)
            return false
        }
        return try {
            secureStore.write(SESSION_KEY, encodeRecord(value).encodeToByteArray())
            true
        } catch (_: Throwable) {
            // Platform secure stores are expected to update atomically. Restore a
            // fake or adapter that mutated before reporting failure as an extra
            // compatibility guard, without ever deleting pre-existing bytes.
            try {
                if (previous != null) secureStore.write(SESSION_KEY, previous)
                else secureStore.delete(SESSION_KEY)
            } catch (_: Throwable) {
                // The observable session still fails closed below. The original
                // write contract must preserve its previous value on failure.
            }
            failLogin(AccountFailureReason.SECURE_STORAGE, AccountFailureStage.SECURE_STORAGE)
            false
        }
    }

    private fun failLogin(reason: AccountFailureReason, stage: AccountFailureStage) {
        session = null
        controllableDevices = emptyList()
        _state.value = AccountUiState.Failed(reason, true, stage)
    }

    private fun selectDevice(targetId: String) {
        val current = session ?: return
        val ready = _state.value as? AccountUiState.Ready ?: return
        // `ready.devices` is already filtered, so the id alone would nearly do —
        // but presence is not, and an offline row is a row the user can see.
        val selected = ready.devices.firstOrNull { it.id == targetId }
            ?.takeIf { AccountDevicePolicy.canSelect(it, deviceId) }
            ?: return
        val updated = current.copy(targetDeviceId = selected.id, targetDeviceName = selected.name)
        if (!persistLogin(updated)) return
        session = updated
        _state.value = ready.copy(selectedDeviceId = selected.id, selectedDeviceName = selected.name)
    }

    /**
     * Re-ask the relay who is online.
     *
     * The old list stays on screen while this runs, and survives a failure: the
     * user asked whether anything changed, and "I could not find out" has to
     * leave them no worse off than not asking.
     */
    private fun refreshDevices() {
        val current = session ?: return
        val ready = _state.value as? AccountUiState.Ready ?: return
        if (ready.refreshing) { directoryDirty = true; return }
        work?.cancel()
        _state.value = ready.copy(refreshing = true, refreshFailure = null)
        work = scope.launch {
            try {
                val devices = backend.listDevices(current, deviceId)
                currentCoroutineContext().ensureActive()
                if (session?.token == current.token && session?.relayUrl == current.relayUrl) {
                    val active = session!!
                    val selected = if (pendingInitialDeviceSelection) {
                        val preferred = AccountDevicePolicy.preferredTarget(devices, deviceId)
                        active.copy(targetDeviceId = preferred?.id, targetDeviceName = preferred?.name)
                    } else active
                    pendingInitialDeviceSelection = false
                    session = selected
                    publishReady(selected, devices)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: CloudAccountException) {
                currentCoroutineContext().ensureActive()
                if (error.failure == CloudAccountFailure.AUTHENTICATION) {
                    expireSession(error.failure.toUiReason(), AccountFailureStage.DEVICE_LIST)
                } else {
                    publishRefreshFailure(current, error.failure.toUiReason())
                }
            } catch (_: Throwable) {
                currentCoroutineContext().ensureActive()
                publishRefreshFailure(current, AccountFailureReason.NETWORK)
            } finally {
                if (currentCoroutineContext().isActive && directoryDirty && session?.token == current.token && session?.relayUrl == current.relayUrl) { directoryDirty = false; refreshDevices() }
            }
        }
    }

    private fun publishRefreshFailure(requestSession: AccountSessionData, reason: AccountFailureReason) {
        val active = session ?: return
        if (active.token != requestSession.token || active.relayUrl != requestSession.relayUrl) return
        val latest = _state.value as? AccountUiState.Ready ?: return
        // Selection/profile changes made during the request belong to the current
        // UI. A failed directory read has no authority to restore an old snapshot.
        _state.value = latest.copy(refreshing = false, refreshFailure = reason)
    }

    private fun logout() {
        closeCatalogs()
        directoryWork?.cancel(); directoryIdentity = null
        backend.closeAccount()
        profileWork?.cancel()
        displayedProfile = null
        profileAttempt = null
        work?.cancel()
        work = null
        // Logout is immediately observable even when Keychain cannot remove the
        // durable record. A stale persisted record must never keep capabilities
        // active in this process.
        session = null
        controllableDevices = emptyList()
        _state.value = AccountUiState.SignedOut
        try {
            secureStore.delete(SESSION_KEY)
        } catch (_: Throwable) {
            _state.value = AccountUiState.Failed(
                AccountFailureReason.SECURE_STORAGE,
                true,
                AccountFailureStage.SECURE_STORAGE,
            )
        }
    }

    private fun expireSession(reason: AccountFailureReason, stage: AccountFailureStage) {
        closeCatalogs()
        directoryWork?.cancel(); directoryIdentity = null
        backend.closeAccount()
        session = null
        controllableDevices = emptyList()
        _state.value = AccountUiState.Failed(reason, false, stage)
    }

    /**
     * The one place the relay's list becomes the list a screen renders, so the
     * filter cannot be forgotten by a caller — or applied twice with two
     * different answers on two platforms.
     */
    private fun publishReady(current: AccountSessionData, devices: List<AccountDeviceUi>, selectionConfirmed: Boolean = true) {
        val directoryKey = current.relayUrl to current.token
        if (directoryIdentity != directoryKey) {
            directoryWork?.cancel(); directoryIdentity = directoryKey
            directoryWork = scope.launch {
                try { backend.directoryChanges(current).collect { if (session?.token == current.token) refreshDevices() } }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Throwable) { if (session?.token == current.token) refreshDevices() }
            }
        }
        controllableDevices = AccountDevicePolicy.controlTargets(devices, deviceId)
        _state.value = AccountUiState.Ready(
            userId = current.userId,
            relayUrl = current.relayUrl,
            username = displayedProfile?.takeIf { it.userId == current.userId }?.username ?: current.username,
            devices = controllableDevices,
            selectedDeviceId = current.targetDeviceId.takeIf { selectionConfirmed },
            selectedDeviceName = current.targetDeviceName.takeIf { selectionConfirmed },
        ).copy(avatarUrl = displayedProfile?.takeIf { it.userId == current.userId }?.avatarUrl)
        enrichProfile(current)
    }


    private fun enrichProfile(current: AccountSessionData) {
        val identity = current.userId to current.token
        val attemptedAt = kotlin.time.Clock.System.now().epochSeconds
        if (profileAttempt == identity && attemptedAt - profileAttemptAt in 0 until 86400) return
        profileAttemptAt = attemptedAt
        profileAttempt = identity
        profileWork?.cancel()
        profileWork = scope.launch {
            fun isCurrent(): Boolean = session?.userId == current.userId && session?.token == current.token
            fun project(profile: AccountProfileRecord) {
                if (!isCurrent() || profile.userId != current.userId) return
                displayedProfile = profile
                val ready = _state.value as? AccountUiState.Ready ?: return
                if (ready.userId == profile.userId) _state.value = ready.copy(username = profile.username, avatarUrl = profile.avatarUrl)
            }
            try {
                val cached = secureStore.read("github_display_profile_v1")?.decodeToString()?.let {
                    runCatching { JSON.decodeFromString<AccountProfileRecord>(it) }.getOrNull()
                }?.takeIf { it.userId == current.userId }
                if (cached != null) project(cached)
                val now = kotlin.time.Clock.System.now().epochSeconds
                if (cached != null && now - cached.fetchedAt in 0 until 86400) return@launch
                val profile = backend.profile(current.userId) ?: return@launch
                if (!isCurrent() || profile.userId != current.userId) return@launch
                val record = AccountProfileRecord(profile.userId, profile.username, profile.avatarUrl, now)
                project(record)
                secureStore.write("github_display_profile_v1", JSON.encodeToString(record).encodeToByteArray())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Public metadata failures retain the session and cached display.
            }
        }
    }

    public companion object {
        internal fun create(
            scope: CoroutineScope,
            backend: AccountBackend,
            secureStore: SecureStore,
            deviceId: String,
            deviceName: String,
            persistence: MobilePersistenceStores? = null,
        ): AccountStore = AccountStore(scope, backend, secureStore, deviceId, deviceName, persistence)

        internal fun backend(log: CoreLog, legacyMobileDeviceNames: Set<String>): AccountBackend {
            val transportLog = log.asTransportLog()
            return CloudBackend(
                CloudAccountClient.create(transportLog, legacyMobileDeviceNames),
                transportLog,
            )
        }

        private const val DEVICE_KEY = "relay_device_private_key_v1"
        private const val SESSION_KEY = "github_device_session_v1"
        private val JSON = Json { ignoreUnknownKeys = true }

        private fun encodeRecord(session: AccountSessionData): String = JSON.encodeToString(
            AccountSessionRecord(
                relayUrl = session.relayUrl,
                username = session.username,
                token = session.token,
                userId = session.userId,
                masterKey = Base64.Default.encode(session.masterKey),
                targetDeviceId = session.targetDeviceId,
                targetDeviceName = session.targetDeviceName,
            ),
        )

        private fun decodeRecord(value: String): AccountSessionData {
            val record = JSON.decodeFromString<AccountSessionRecord>(value)
            return AccountSessionData(
                record.relayUrl,
                record.username,
                record.token,
                record.userId,
                Base64.Default.decode(record.masterKey),
                record.targetDeviceId,
                record.targetDeviceName,
            )
        }
    }
}

/**
 * The sign-in poll loop, kept apart from its transport so it can be tested.
 *
 * The loop is the whole of the fix it carries: a poll that fails has to be
 * tried again rather than end the sign-in, and only this shape lets a test say
 * so without a relay to fail against.
 */
internal object AuthorizationPoll {
    /**
     * Whether a failed poll should be tried again inside the sign-in window.
     *
     * Retry what the next tick could plausibly get past: a dropped connection,
     * a timeout, a relay that is briefly unavailable, and a rate limit that
     * asks for exactly the wait the loop already does between polls. Stop for
     * anything the relay meant — a rejected or unparseable transaction stays
     * rejected however long the phone keeps asking.
     */
    fun retryable(failure: CloudAccountFailure): Boolean = when (failure) {
        CloudAccountFailure.NETWORK,
        CloudAccountFailure.TIMEOUT,
        CloudAccountFailure.RATE_LIMITED,
        CloudAccountFailure.RELAY_UNAVAILABLE -> true
        CloudAccountFailure.INVALID_CREDENTIALS,
        CloudAccountFailure.AUTHENTICATION,
        CloudAccountFailure.MALFORMED_RESPONSE -> false
    }

    /**
     * Polls [poll] until the transaction is authorized, refused, or its window
     * closes, and returns the access token it was granted.
     *
     * The window spans the minutes the user spends in a browser and a mail app,
     * which is exactly when a phone drops a connection, hops networks, or
     * sleeps its radio. Ending the sign-in on the first hiccup would send them
     * back to the start for something the next tick fixes by itself, so a
     * [retryable] failure only costs one interval. A window that ran out while
     * every poll was failing surfaces that failure rather than
     * [CloudAccountFailure.AUTHENTICATION]: the network is what the user can
     * act on, and the transaction was never actually refused.
     */
    suspend fun awaitAccessToken(
        start: com.openbitfun.mobile.core.transport.GitHubAuthorization,
        log: TransportLog,
        nowSeconds: () -> Long = { kotlin.time.Clock.System.now().epochSeconds },
        poll: suspend () -> com.openbitfun.mobile.core.transport.GitHubAuthorizationPoll,
    ): String {
        var lastTransient: CloudAccountException? = null
        while (nowSeconds() < start.expiresAt) {
            kotlinx.coroutines.delay(start.pollIntervalSeconds.coerceIn(1, 30) * 1000L)
            val result = try {
                poll()
            } catch (cause: CloudAccountException) {
                if (!retryable(cause.failure)) throw cause
                lastTransient = cause
                log.warn("account authorization poll retrying reason=${cause.failure}")
                continue
            }
            lastTransient = null
            if (result.status == "authorized") {
                val token = result.tokens?.accessToken
                if (!token.isNullOrEmpty()) return token
                break
            }
            if (result.status == "expired" || result.status == "denied") break
        }
        throw lastTransient ?: CloudAccountException(CloudAccountFailure.AUTHENTICATION)
    }
}

private class CloudBackend(
    private val client: CloudAccountClient,
    private val log: TransportLog,
) : AccountBackend {
    override suspend fun login(
        relayUrl: String,
        deviceId: String,
        deviceName: String,
        deviceSecret: ByteArray,
        onAuthorization: (String) -> Unit,
    ): AccountSessionData {
        val start = client.startAuthorization(relayUrl)
        onAuthorization(start.authorizationUrl)
        val token = AuthorizationPoll.awaitAccessToken(start, log) { client.pollAuthorization(relayUrl, start) }
        val session = client.login(relayUrl, token, deviceId, deviceName, deviceSecret)
        return AccountSessionData(
            relayUrl = relayUrl,
            username = session.userId,
            token = session.token,
            userId = session.userId,
            masterKey = session.masterKey,
            targetDeviceId = null,
            targetDeviceName = null,
        )
    }

    override fun directoryChanges(session: AccountSessionData): Flow<Unit> = client.deviceDirectoryChanges(session.relayUrl, session.toTransportSession())
    override fun resumeSessionStreams() { client.resumeSessionStreams() }
    override fun closeAccount() { client.closeAccount() }

    override suspend fun profile(userId: String): com.openbitfun.mobile.core.transport.GitHubProfile? = client.githubProfile(userId)

    override suspend fun listDevices(session: AccountSessionData, selfDeviceId: String): List<AccountDeviceUi> =
        client.listDevices(session.relayUrl, session.toTransportSession(), selfDeviceId).map { it.toUi() }

    override fun transport(session: AccountSessionData, targetDeviceId: String): RemoteCommandTransport =
        AccountDeviceCommandTransport(client, session.relayUrl, session.toTransportSession(), targetDeviceId, log)

    private fun AccountSessionData.toTransportSession(): CloudAccountSession =
        CloudAccountSession(token, userId, masterKey)

    private fun CloudAccountDevice.toUi(): AccountDeviceUi = AccountDeviceUi(deviceId, deviceName, online, lastSeenAt)
}

@Serializable
private data class AccountSessionRecord(
    val relayUrl: String,
    val username: String,
    val token: String,
    val userId: String,
    val masterKey: String,
    val targetDeviceId: String?,
    val targetDeviceName: String?,
)

private fun CloudAccountFailure.toUiReason(): AccountFailureReason = when (this) {
    CloudAccountFailure.INVALID_CREDENTIALS -> AccountFailureReason.INVALID_CREDENTIALS
    CloudAccountFailure.AUTHENTICATION -> AccountFailureReason.AUTHENTICATION
    CloudAccountFailure.RATE_LIMITED -> AccountFailureReason.RATE_LIMITED
    CloudAccountFailure.RELAY_UNAVAILABLE -> AccountFailureReason.RELAY_UNAVAILABLE
    CloudAccountFailure.NETWORK -> AccountFailureReason.NETWORK
    CloudAccountFailure.TIMEOUT -> AccountFailureReason.TIMEOUT
    CloudAccountFailure.MALFORMED_RESPONSE -> AccountFailureReason.MALFORMED_RESPONSE
}

@Serializable
private data class AccountProfileRecord(
    val userId: String,
    val username: String,
    val avatarUrl: String?,
    val fetchedAt: Long,
)
