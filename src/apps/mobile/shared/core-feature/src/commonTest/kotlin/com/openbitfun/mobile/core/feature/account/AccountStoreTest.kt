package com.openbitfun.mobile.core.feature.account

import com.openbitfun.mobile.core.persistence.SecureStore
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.transport.CloudAccountException
import com.openbitfun.mobile.core.transport.CloudAccountFailure
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.DeserializationStrategy
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlinx.coroutines.test.advanceTimeBy
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class AccountStoreTest {
    @Test fun cancelledLoginDirectoryCannotReviveAccountOrPersistSelectedDevice() = runTest {
        for (failure in listOf<Throwable?>(null, CloudAccountException(CloudAccountFailure.NETWORK),
            CloudAccountException(CloudAccountFailure.AUTHENTICATION), IllegalStateException("Late failure"))) {
            val secure = MemorySecureStore(); val backend = FakeAccountBackend()
            var pending: kotlin.coroutines.Continuation<Unit>? = null
            backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
            val store = AccountStore.create(this, backend, secure, "phone-1", "Android")
            store.dispatch(AccountIntent.Login); advanceUntilIdle()
            store.dispatch(AccountIntent.Logout)
            pending!!.resumeWith(if (failure == null) Result.success(Unit) else Result.failure(failure))
            advanceUntilIdle()
            assertIs<AccountUiState.SignedOut>(store.state.value)
            assertNull(secure.read("github_device_session_v1"))
            assertNull(store.createSessionStore(this))
            store.stop()
        }
    }

    @Test fun cancelledRestoreCannotReplaceSignedOutState() = runTest {
        for (failure in listOf<Throwable?>(null, CloudAccountException(CloudAccountFailure.NETWORK),
            CloudAccountException(CloudAccountFailure.AUTHENTICATION))) {
            val secure = MemorySecureStore(); val backend = FakeAccountBackend()
            val first = AccountStore.create(this, backend, secure, "phone-1", "Android")
            first.dispatch(AccountIntent.Login); advanceUntilIdle(); first.stop()
            var pending: kotlin.coroutines.Continuation<Unit>? = null
            backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
            val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
            restored.dispatch(AccountIntent.Restore); advanceUntilIdle()
            restored.dispatch(AccountIntent.Logout)
            pending!!.resumeWith(if (failure == null) Result.success(Unit) else Result.failure(failure))
            advanceUntilIdle()
            assertIs<AccountUiState.SignedOut>(restored.state.value)
            restored.stop()
        }
    }

    @Test fun cancelledRefreshFailureCannotRestoreSignedOutAccount() = runTest {
        for (failure in listOf(CloudAccountException(CloudAccountFailure.NETWORK),
            CloudAccountException(CloudAccountFailure.AUTHENTICATION), IllegalStateException("Late failure"))) {
            val backend = FakeAccountBackend()
            val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
            store.dispatch(AccountIntent.Login); advanceUntilIdle()
            var pending: kotlin.coroutines.Continuation<Unit>? = null
            backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
            store.dispatch(AccountIntent.RefreshDevices); advanceUntilIdle()
            store.dispatch(AccountIntent.Logout)
            pending!!.resumeWith(Result.failure(failure)); advanceUntilIdle()
            assertIs<AccountUiState.SignedOut>(store.state.value)
            store.stop()
        }
    }

    @Test fun cancelledAuthenticationFailureCannotExpireReplacementLoginWithSameToken() = runTest {
        val backend = FakeAccountBackend()
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login); advanceUntilIdle()
        var pending: kotlin.coroutines.Continuation<Unit>? = null
        backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
        store.dispatch(AccountIntent.RefreshDevices); advanceUntilIdle()
        store.dispatch(AccountIntent.Logout)
        backend.beforeList = null
        backend.userId = "replacement-user"
        store.dispatch(AccountIntent.Login); advanceUntilIdle()
        val replacement = assertIs<AccountUiState.Ready>(store.state.value)
        pending!!.resumeWith(Result.failure(CloudAccountException(CloudAccountFailure.AUTHENTICATION)))
        advanceUntilIdle()
        assertEquals(replacement, store.state.value)
        store.stop()
    }

    @Test fun directoryNotificationsRefreshMembershipWithoutAPeriodicPoll() = runTest {
        val changes = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 4)
        val backend = FakeAccountBackend().apply { directoryEvents = changes }
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login); advanceUntilIdle()
        val before = backend.listRequests
        backend.desktop2Online = true; changes.emit(Unit); advanceUntilIdle()
        assertEquals(before + 1, backend.listRequests)
        assertTrue(assertIs<AccountUiState.Ready>(store.state.value).devices.single { it.id == "desktop-2" }.online)
        advanceTimeBy(120_000); advanceUntilIdle()
        assertEquals(before + 1, backend.listRequests)
        store.stop(); changes.emit(Unit); advanceUntilIdle()
        assertEquals(before + 1, backend.listRequests)
    }

    @Test fun oldOfficialRelayTokenIsRetainedButNeverSentToNewRelay() = runTest {
        val secure = MemorySecureStore(); val backend = FakeAccountBackend()
        val first = AccountStore.create(this, backend, secure, "phone-1", "Android")
        first.dispatch(AccountIntent.Login); advanceUntilIdle()
        val old = secure.read("github_device_session_v1")!!.decodeToString().replace(AccountDefaults.CLOUD_RELAY_URL, "https://remote.openbitfun.com/v/retired")
        secure.write("github_device_session_v1", old.encodeToByteArray())
        val requests = backend.listRequests
        val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
        restored.dispatch(AccountIntent.Restore); advanceUntilIdle()
        val state = assertIs<AccountUiState.Failed>(restored.state.value)
        assertEquals(AccountFailureReason.AUTHENTICATION, state.reason)
        assertEquals(requests, backend.listRequests)
        assertEquals(old, secure.read("github_device_session_v1")!!.decodeToString())
        restored.dispatch(AccountIntent.Login); advanceUntilIdle()
        assertEquals(AccountDefaults.CLOUD_RELAY_URL, backend.lastLoginRelay)
        assertIs<AccountUiState.Ready>(restored.state.value)
    }

    @Test
    fun enrichesExistingAccountAndRetainsIdentityAndCacheOffline() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend().apply {
            userId = "42"
            profileResult = com.openbitfun.mobile.core.transport.GitHubProfile(42, "octocat", "https://avatars.githubusercontent.com/u/42")
        }
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals("42", ready.userId)
        assertEquals("octocat", ready.username)
        assertEquals("https://avatars.githubusercontent.com/u/42", ready.avatarUrl)
        val credentials = secure.read("github_device_session_v1")!!
        backend.profileResult = null
        val restored = AccountStore.create(this, backend, secure, "phone-1", "iOS")
        restored.dispatch(AccountIntent.Restore)
        advanceUntilIdle()
        assertEquals("octocat", assertIs<AccountUiState.Ready>(restored.state.value).username)
        assertContentEquals(credentials, secure.read("github_device_session_v1"))
        assertEquals(1, backend.profileLoads)
    }

    @Test
    fun metadataForAnotherAccountCannotReplaceDisplayOrAuthority() = runTest {
        val backend = FakeAccountBackend().apply {
            userId = "42"
            profileResult = com.openbitfun.mobile.core.transport.GitHubProfile(99, "other", null)
        }
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals("42", ready.userId)
        assertEquals("user", ready.username)
        assertNull(ready.avatarUrl)
    }

    @Test
    fun loginSelectsOnlineDesktopAndPersistsRestorableSession() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend()
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals("user-id", ready.userId)
        assertEquals("desktop-1", ready.selectedDeviceId)
        assertTrue(secure.read("github_device_session_v1")?.isNotEmpty() == true)
        assertFalse(
            AccountIntent.Login
                .toString()
                .contains("top-secret-value"),
        )

        val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
        restored.dispatch(AccountIntent.Restore)
        advanceUntilIdle()
        assertEquals("desktop-1", assertIs<AccountUiState.Ready>(restored.state.value).selectedDeviceId)
    }

    @Test
    fun onlyControllableDevicesReachTheList() = runTest {
        val store = AccountStore.create(this, FakeAccountBackend(), MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        // This device and the user's other phone are gone; the offline desktop
        // stays, because "known but not running" is worth showing.
        assertEquals(listOf("desktop-1", "desktop-2"), ready.devices.map { it.id })
    }

    @Test
    fun deviceSelectionAndLogoutUpdateSecureState() = runTest {
        val secure = MemorySecureStore()
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        // Neither this device nor an offline one can become the control target.
        store.dispatch(AccountIntent.SelectDevice("phone-1"))
        store.dispatch(AccountIntent.SelectDevice("desktop-2"))
        assertEquals("desktop-1", assertIs<AccountUiState.Ready>(store.state.value).selectedDeviceId)
        store.dispatch(AccountIntent.Logout)

        assertIs<AccountUiState.SignedOut>(store.state.value)
        assertEquals(1, secure.deleteCount)
        assertNull(secure.read("github_device_session_v1"))
    }

    @Test
    fun deviceSelectionWriteFailureRestoresBytesAndFailsClosed() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend().also { it.desktop2Online = true }
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        assertEquals("desktop-1", assertIs<AccountUiState.Ready>(store.state.value).selectedDeviceId)
        val stored = secure.read("github_device_session_v1")!!.toList()

        secure.failWrites = true
        secure.mutateBeforeWriteFailure = true
        store.dispatch(AccountIntent.SelectDevice("desktop-2"))

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.SECURE_STORAGE, failed.reason)
        assertEquals(AccountFailureStage.SECURE_STORAGE, failed.stage)
        assertEquals(stored, secure.read("github_device_session_v1")?.toList())
        assertNull(store.createSessionStore(this))
        assertNull(store.createSessionStore(this, "desktop-1"))
        assertNull(store.createWorkspaceStore(this))
        assertNull(store.createWorkspaceStore(this, "desktop-1"))
        assertTrue(backend.transportTargets.isEmpty())
        assertEquals(0, secure.deleteCount)
    }

    @Test
    fun refreshPicksUpADesktopThatCameOnlineAndSurvivesFailing() = runTest {
        val backend = FakeAccountBackend()
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        assertFalse(assertIs<AccountUiState.Ready>(store.state.value).devices.single { it.id == "desktop-2" }.online)

        backend.desktop2Online = true
        store.dispatch(AccountIntent.RefreshDevices)
        advanceUntilIdle()
        val refreshed = assertIs<AccountUiState.Ready>(store.state.value)
        assertTrue(refreshed.devices.single { it.id == "desktop-2" }.online)
        assertFalse(refreshed.refreshing)
        assertNull(refreshed.refreshFailure)

        // A failed refresh reports why and leaves the list it could not replace.
        backend.listFailure = CloudAccountFailure.NETWORK
        store.dispatch(AccountIntent.RefreshDevices)
        advanceUntilIdle()
        val failed = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals(AccountFailureReason.NETWORK, failed.refreshFailure)
        assertFalse(failed.refreshing)
        assertEquals(refreshed.devices, failed.devices)
        assertEquals("desktop-1", failed.selectedDeviceId)
    }

    @Test fun coldRestorePublishesIdentityBeforeDirectoryWithoutGrantingTargetAuthority() = runTest {
        val secure = MemorySecureStore(); val backend = FakeAccountBackend()
        val first = AccountStore.create(this, backend, secure, "phone-1", "Android")
        first.dispatch(AccountIntent.Login); advanceUntilIdle(); first.stop()
        val saved = secure.read("github_device_session_v1")!!
        var pending: kotlin.coroutines.Continuation<Unit>? = null
        backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
        val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
        restored.dispatch(AccountIntent.Restore); advanceUntilIdle()
        val loading = assertIs<AccountUiState.Ready>(restored.state.value)
        assertEquals("user-id", loading.userId)
        assertTrue(loading.refreshing)
        assertTrue(loading.devices.isEmpty())
        assertNull(loading.selectedDeviceId)
        assertNull(restored.createSessionStore(this))
        assertNull(restored.createWorkspaceStore(this, "desktop-1"))
        pending!!.resumeWith(Result.success(Unit)); advanceUntilIdle()
        val ready = assertIs<AccountUiState.Ready>(restored.state.value)
        assertFalse(ready.refreshing)
        assertEquals("desktop-1", ready.selectedDeviceId)
        assertContentEquals(saved, secure.read("github_device_session_v1"))
        restored.stop()
    }

    @Test fun failedRefreshDoesNotRollBackDeviceSelectedWhileRequestWasPending() = runTest {
        for (failure in listOf(CloudAccountException(CloudAccountFailure.TIMEOUT), IllegalStateException("Network unavailable"))) {
            val backend = FakeAccountBackend().apply { desktop2Online = true }
            val secure = MemorySecureStore()
            val store = AccountStore.create(this, backend, secure, "phone-1", "Android")
            store.dispatch(AccountIntent.Login); advanceUntilIdle()
            var pending: kotlin.coroutines.Continuation<Unit>? = null
            backend.beforeList = { kotlin.coroutines.suspendCoroutine<Unit> { pending = it } }
            store.dispatch(AccountIntent.RefreshDevices); advanceUntilIdle()
            store.dispatch(AccountIntent.SelectDevice("desktop-2"))
            val selected = assertIs<AccountUiState.Ready>(store.state.value)
            assertEquals("desktop-2", selected.selectedDeviceId)
            val saved = secure.read("github_device_session_v1")!!
            pending!!.resumeWith(Result.failure(failure)); advanceUntilIdle()
            val failed = assertIs<AccountUiState.Ready>(store.state.value)
            assertEquals(selected.selectedDeviceId, failed.selectedDeviceId)
            assertEquals(selected.selectedDeviceName, failed.selectedDeviceName)
            assertEquals(selected.devices, failed.devices)
            assertFalse(failed.refreshing)
            assertEquals(if (failure is CloudAccountException) AccountFailureReason.TIMEOUT else AccountFailureReason.NETWORK, failed.refreshFailure)
            assertContentEquals(saved, secure.read("github_device_session_v1"))
            store.createSessionStore(this)
            assertEquals("desktop-2", backend.transportTargets.last())
            store.stop()
        }
    }

    @Test
    fun explicitDeviceStoresCoexistWithSelectedTargetStore() = runTest {
        val backend = FakeAccountBackend()
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        // The old single-target entry points still resolve the selected device.
        assertTrue(store.createSessionStore(this) != null)
        assertTrue(store.createWorkspaceStore(this) != null)

        // The new explicit-device entry points address a device without changing selection.
        assertTrue(store.createSessionStore(this, "desktop-2") != null)
        assertTrue(store.createWorkspaceStore(this, "desktop-2") != null)

        assertEquals(
            listOf("desktop-1", "desktop-1", "desktop-2", "desktop-2"),
            backend.transportTargets,
        )
    }

    @Test
    fun explicitDeviceStoresRequireAuthenticatedRegisteredControlTargets() = runTest {
        val backend = FakeAccountBackend()
        val signedOut = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")
        assertNull(signedOut.createSessionStore(this, "desktop-1"))
        assertNull(signedOut.createWorkspaceStore(this, "desktop-1"))
        assertTrue(backend.transportTargets.isEmpty())

        signedOut.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        assertNull(signedOut.createSessionStore(this, ""))
        assertNull(signedOut.createSessionStore(this, "phone-1"))
        assertNull(signedOut.createSessionStore(this, "phone-2"))
        assertNull(signedOut.createSessionStore(this, "unknown"))
        // Registered offline targets remain authorized for cache-backed directory rows.
        assertTrue(signedOut.createSessionStore(this, "desktop-2") != null)
        assertTrue(signedOut.createWorkspaceStore(this, "desktop-2") != null)
        assertEquals(listOf("desktop-2", "desktop-2"), backend.transportTargets)
    }

    @Test
    fun invalidRestoreKeepsOpaqueRecordAndCanBeRetried() = runTest {
        val secure = MemorySecureStore()
        val raw = "not-a-session-record".encodeToByteArray()
        secure.write("github_device_session_v1", raw)
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Restore)
        advanceUntilIdle()
        assertEquals(AccountFailureReason.SECURE_STORAGE, assertIs<AccountUiState.Failed>(store.state.value).reason)
        assertTrue(assertIs<AccountUiState.Failed>(store.state.value).canRetry)
        assertEquals(0, secure.deleteCount)
        assertEquals(raw.toList(), secure.read("github_device_session_v1")?.toList())

        store.dispatch(AccountIntent.Restore)
        advanceUntilIdle()
        assertEquals(AccountFailureReason.SECURE_STORAGE, assertIs<AccountUiState.Failed>(store.state.value).reason)
        assertEquals(0, secure.deleteCount)
        assertEquals(raw.toList(), secure.read("github_device_session_v1")?.toList())
    }

    @Test
    fun secureReadFailureFailsClosedWithoutDeletingStoredBytes() = runTest {
        val secure = MemorySecureStore()
        val raw = "opaque-existing-session".encodeToByteArray()
        secure.write("github_device_session_v1", raw)
        secure.failReads = true
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Restore)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.SECURE_STORAGE, failed.reason)
        assertEquals(AccountFailureStage.RESTORE, failed.stage)
        assertEquals(0, secure.deleteCount)
        secure.failReads = false
        assertEquals(raw.toList(), secure.read("github_device_session_v1")?.toList())
    }

    @Test
    fun legacyRestoreKeepsOpaqueRecord() = runTest {
        val secure = MemorySecureStore()
        val raw = "{\"token\":\"legacy-token\"}".encodeToByteArray()
        secure.write("github_device_session_v1", raw)
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Restore)
        advanceUntilIdle()

        assertEquals(AccountFailureReason.SECURE_STORAGE, assertIs<AccountUiState.Failed>(store.state.value).reason)
        assertEquals(0, secure.deleteCount)
        assertEquals(raw.toList(), secure.read("github_device_session_v1")?.toList())
    }

    @Test
    fun validRestoreDoesNotDeletePersistedSession() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend()
        val first = AccountStore.create(this, backend, secure, "phone-1", "Android")
        first.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        val raw = secure.read("github_device_session_v1")

        val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
        restored.dispatch(AccountIntent.Restore)
        advanceUntilIdle()

        assertIs<AccountUiState.Ready>(restored.state.value)
        assertEquals(0, secure.deleteCount)
        assertEquals(raw?.toList(), secure.read("github_device_session_v1")?.toList())
    }

    @Test
    fun expiredRefreshRevokesCapabilitiesAndPreservesTheStoredRecord() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend()
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        assertTrue(assertIs<AccountUiState.Ready>(store.state.value).devices.isNotEmpty())

        val stored = secure.read("github_device_session_v1")!!.toList()
        backend.listFailure = CloudAccountFailure.AUTHENTICATION
        store.dispatch(AccountIntent.RefreshDevices)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.AUTHENTICATION, failed.reason)
        assertEquals(stored, secure.read("github_device_session_v1")?.toList())
        assertEquals(0, secure.deleteCount)
        assertNull(store.createSessionStore(this))
    }

    @Test
    fun signInWithNothingOnlinePicksNoTarget() = runTest {
        val backend = FakeAccountBackend().also { it.desktop1Online = false }
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        // Not this device as a consolation prize: the live account has ten
        // registered devices and no desktop running, and that is what it says.
        assertNull(assertIs<AccountUiState.Ready>(store.state.value).selectedDeviceId)
    }

    @Test
    fun backendFailuresStayTyped() = runTest {
        val backend = FakeAccountBackend().also { it.failure = CloudAccountFailure.AUTHENTICATION }
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.AUTHENTICATION, failed.reason)
        assertEquals(AccountFailureStage.AUTHENTICATION, failed.stage)
    }

    @Test
    fun unknownAuthenticationFailureIsProtocolFailureNotSecureStorage() = runTest {
        val backend = FakeAccountBackend().also { it.loginThrowable = IllegalStateException("crypto failed") }
        val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.MALFORMED_RESPONSE, failed.reason)
        assertEquals(AccountFailureStage.AUTHENTICATION, failed.stage)
    }

    @Test
    fun secureStoreWriteFailureIsTheOnlyUntypedSecureStorageFailure() = runTest {
        val secure = MemorySecureStore(failWrites = true)
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.SECURE_STORAGE, failed.reason)
        assertEquals(AccountFailureStage.SECURE_STORAGE, failed.stage)
    }

    @Test
    fun deviceListFailurePreservesAuthenticatedAccountAndPersistedData() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend().also { it.listThrowable = IllegalStateException("transport failed") }
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals(AccountFailureReason.NETWORK, ready.refreshFailure)
        assertNull(ready.selectedDeviceId)
        assertTrue(secure.read("github_device_session_v1")?.isNotEmpty() == true)
        assertEquals(0, secure.deleteCount)
    }

    @Test
    fun deviceListFailuresKeepTheirTypedReasons() = runTest {
        CloudAccountFailure.entries.forEach { transportReason ->
            val backend = FakeAccountBackend().also { it.listFailure = transportReason }
            val store = AccountStore.create(this, backend, MemorySecureStore(), "phone-1", "Android")

            store.dispatch(AccountIntent.Login)
            advanceUntilIdle()

            if (transportReason == CloudAccountFailure.AUTHENTICATION) {
                val failed = assertIs<AccountUiState.Failed>(store.state.value)
                assertEquals(AccountFailureReason.AUTHENTICATION, failed.reason)
                assertFalse(failed.canRetry)
            } else {
                val ready = assertIs<AccountUiState.Ready>(store.state.value)
                assertEquals(transportReason.toExpectedReason(), ready.refreshFailure)
                assertEquals("user-id", ready.userId)
                assertNull(store.createSessionStore(this))
            }
            store.stop()
        }
    }

    @Test
    fun deviceListRetryReusesSessionWithoutTouchingStoredBytes() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend().also { it.listFailure = CloudAccountFailure.TIMEOUT }
        val store = AccountStore.create(this, backend, secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        val readyBeforeRetry = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals(AccountFailureReason.TIMEOUT, readyBeforeRetry.refreshFailure)
        val stored = secure.read("github_device_session_v1")!!.toList()
        val writes = secure.writeCount
        val deletes = secure.deleteCount

        backend.listFailure = null
        store.dispatch(AccountIntent.Retry)
        advanceUntilIdle()

        val ready = assertIs<AccountUiState.Ready>(store.state.value)
        assertEquals("desktop-1", ready.selectedDeviceId)
        assertEquals(stored, secure.read("github_device_session_v1")?.toList())
        assertEquals(writes, secure.writeCount)
        assertEquals(deletes, secure.deleteCount)
    }

    @Test
    fun writeFailureFailsClosedAndRestoresExistingBytes() = runTest {
        val secure = MemorySecureStore()
        val existing = "existing-session-bytes".encodeToByteArray()
        secure.write("github_device_session_v1", existing)
        secure.failWrites = true
        secure.mutateBeforeWriteFailure = true
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")

        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.SECURE_STORAGE, failed.reason)
        assertNull(store.createSessionStore(this))
        assertEquals(existing.toList(), secure.read("github_device_session_v1")?.toList())
        assertEquals(0, secure.deleteCount)
    }

    @Test
    fun deleteFailureLogsOutInMemoryWithoutDestroyingStoredBytes() = runTest {
        val secure = MemorySecureStore()
        val store = AccountStore.create(this, FakeAccountBackend(), secure, "phone-1", "Android")
        store.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        val stored = secure.read("github_device_session_v1")!!.toList()
        secure.failDeletes = true

        store.dispatch(AccountIntent.Logout)

        val failed = assertIs<AccountUiState.Failed>(store.state.value)
        assertEquals(AccountFailureReason.SECURE_STORAGE, failed.reason)
        assertNull(store.createSessionStore(this))
        assertEquals(stored, secure.read("github_device_session_v1")?.toList())
    }

    @Test
    fun offlineRestoreKeepsEncryptedSessionForRetry() = runTest {
        val secure = MemorySecureStore()
        val backend = FakeAccountBackend()
        val first = AccountStore.create(this, backend, secure, "phone-1", "Android")
        first.dispatch(AccountIntent.Login)
        advanceUntilIdle()
        backend.listFailure = CloudAccountFailure.NETWORK

        val restored = AccountStore.create(this, backend, secure, "phone-1", "Android")
        restored.dispatch(AccountIntent.Restore)
        advanceUntilIdle()

        val offline = assertIs<AccountUiState.Ready>(restored.state.value)
        assertEquals(AccountFailureReason.NETWORK, offline.refreshFailure)
        assertEquals("user-id", offline.userId)
        assertTrue(offline.devices.isEmpty())
        assertNull(offline.selectedDeviceId)
        assertNull(restored.createSessionStore(this))
        val saved = secure.read("github_device_session_v1")!!.toList()
        backend.listFailure = null
        restored.dispatch(AccountIntent.RefreshDevices); advanceUntilIdle()
        val recovered = assertIs<AccountUiState.Ready>(restored.state.value)
        assertNull(recovered.refreshFailure)
        assertEquals("desktop-1", recovered.selectedDeviceId)
        assertEquals(saved, secure.read("github_device_session_v1")!!.toList())
        first.stop(); restored.stop()
    }
}

private class MemorySecureStore(
    var failWrites: Boolean = false,
    var failReads: Boolean = false,
    var failDeletes: Boolean = false,
    var mutateBeforeWriteFailure: Boolean = false,
) : SecureStore {
    private val values = mutableMapOf<String, ByteArray>()
    var writeCount: Int = 0
        private set
    var deleteCount: Int = 0
        private set

    override fun read(key: String): ByteArray? {
        if (failReads) error("secure store read failed")
        return values[key]?.copyOf()
    }

    override fun write(key: String, value: ByteArray) {
        writeCount += 1
        if (failWrites) {
            if (mutateBeforeWriteFailure) {
                values[key] = value.copyOf()
                // Let AccountStore prove that it restores the previous bytes.
                failWrites = false
            }
            error("secure store write failed")
        }
        values[key] = value.copyOf()
    }

    override fun delete(key: String) {
        deleteCount += 1
        if (failDeletes) error("secure store delete failed")
        values.remove(key)
    }
}

private fun CloudAccountFailure.toExpectedReason(): AccountFailureReason = when (this) {
    CloudAccountFailure.INVALID_CREDENTIALS -> AccountFailureReason.INVALID_CREDENTIALS
    CloudAccountFailure.AUTHENTICATION -> AccountFailureReason.AUTHENTICATION
    CloudAccountFailure.RATE_LIMITED -> AccountFailureReason.RATE_LIMITED
    CloudAccountFailure.RELAY_UNAVAILABLE -> AccountFailureReason.RELAY_UNAVAILABLE
    CloudAccountFailure.NETWORK -> AccountFailureReason.NETWORK
    CloudAccountFailure.TIMEOUT -> AccountFailureReason.TIMEOUT
    CloudAccountFailure.MALFORMED_RESPONSE -> AccountFailureReason.MALFORMED_RESPONSE
}

private class FakeAccountBackend : AccountBackend {
    var directoryEvents: kotlinx.coroutines.flow.Flow<Unit> = kotlinx.coroutines.flow.emptyFlow()
    override fun directoryChanges(session: AccountSessionData) = directoryEvents

    var userId = "user-id"
    var listRequests = 0
    var beforeList: (suspend () -> Unit)? = null
    var lastLoginRelay = ""
    var profileResult: com.openbitfun.mobile.core.transport.GitHubProfile? = null
    var profileLoads = 0
    override suspend fun profile(userId: String): com.openbitfun.mobile.core.transport.GitHubProfile? {
        profileLoads++
        return profileResult
    }

    var failure: CloudAccountFailure? = null
    var loginThrowable: Throwable? = null
    var listFailure: CloudAccountFailure? = null
    var listThrowable: Throwable? = null
    var desktop1Online: Boolean = true
    var desktop2Online: Boolean = false
    var settings: String? = null
    val transportTargets = mutableListOf<String>()
    override suspend fun login(
        relayUrl: String,
        deviceId: String,
        deviceName: String,
        deviceSecret: ByteArray,
        onAuthorization: (String) -> Unit,
    ): AccountSessionData {
        lastLoginRelay = relayUrl
        loginThrowable?.let { throw it }
        failure?.let { throw CloudAccountException(it) }
        return AccountSessionData(
            "https://remote.openbitfun.com/v/1.0.1",
            "user",
            "token",
            userId,
            ByteArray(32) { it.toByte() },
            null,
            null,
        )
    }

    override suspend fun listDevices(session: AccountSessionData, selfDeviceId: String): List<AccountDeviceUi> {
        listRequests++
        beforeList?.invoke()
        listThrowable?.let { throw it }
        listFailure?.let { throw CloudAccountException(it) }
        // The shape the live account returns: this device, one of the user's
        // other phones, and the desktops that are the only real targets.
        return listOf(
            AccountDeviceUi("phone-1", "Android", true, null),
            AccountDeviceUi("phone-2", "HarmonyOS Phone", true, 1),
            AccountDeviceUi("desktop-1", "Desktop", desktop1Online, 1),
            AccountDeviceUi("desktop-2", "DESKTOP-KM3L4UI", desktop2Online, 1),
        )
    }


    override fun transport(session: AccountSessionData, targetDeviceId: String): RemoteCommandTransport {
        transportTargets += targetDeviceId
        return object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(
                deserializer: DeserializationStrategy<T>,
                command: RemoteCommand,
                timeoutMs: Long,
            ): T = error("unused")
        }
    }
}
