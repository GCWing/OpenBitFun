package com.openbitfun.mobile.core.feature.account

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AccountDeviceLinkTest {
    @Test fun explicitLegacyConstructorsPreserveTheExistingDefaults() {
        assertNull(AccountDeviceLinkResult(AccountDeviceLinkStatus.INVALID, null).relayUrl)
        val legacy = AccountUiState.Ready("user", "name", emptyList(), null, null)
        assertEquals("https://remote.openbitfun.com/relay", legacy.relayUrl)
        assertEquals(false, legacy.refreshing)
        assertNull(legacy.refreshFailure)
    }

    private val endpoint = "https://remote.openbitfun.com/relay"
    private val link = "$endpoint/#/pair?did=desktop-1"
    private val ready = AccountUiState.Ready(userId = "user", username = "name", relayUrl = endpoint, devices = listOf(AccountDeviceUi("desktop-1", "Desktop", true, null)), selectedDeviceId = null, selectedDeviceName = null)

    @Test fun onlyAuthenticatedOnlineMembershipCanResolveTheTarget() {
        assertEquals(AccountDeviceLinkStatus.SIGN_IN_REQUIRED, resolveAccountDeviceLink(link, AccountUiState.SignedOut).status)
        assertEquals("desktop-1", resolveAccountDeviceLink(link, ready).deviceId)
        assertEquals(AccountDeviceLinkStatus.UNAVAILABLE, resolveAccountDeviceLink(link.replace("desktop-1", "foreign"), ready).status)
        assertEquals(AccountDeviceLinkStatus.UNAVAILABLE, resolveAccountDeviceLink(link, ready.copy(devices = ready.devices.map { it.copy(online = false) })).status)
    }

    @Test fun lanRequiresLoginOnTheScannedEndpointAndUsesTheSameDirectory() {
        val endpoint = "http://192.168.1.10:9700"
        val localLink = "$endpoint/#/pair?did=desktop-1"
        val signedOut = resolveAccountDeviceLink(localLink, ready)
        assertEquals(AccountDeviceLinkStatus.SIGN_IN_REQUIRED, signedOut.status)
        assertEquals(endpoint, signedOut.relayUrl)
        assertEquals(AccountDeviceLinkStatus.READY, resolveAccountDeviceLink(localLink, ready.copy(relayUrl = endpoint)).status)
        assertEquals(AccountDeviceLinkStatus.UNAVAILABLE,
            resolveAccountDeviceLink(localLink.replace("desktop-1", "foreign"), ready.copy(relayUrl = endpoint)).status)
    }

    @Test fun rejectsLookalikeEndpointsAndUnexpectedRoutingFields() {
        for (invalid in listOf(
            link.replace("https:", "http:"), link.replace("remote.openbitfun.com", "evil.example"),
            link.replace("remote.openbitfun.com", "user@remote.openbitfun.com"),
            // Another host's `/relay` is not the official deployment.
            link.replace("https://remote.openbitfun.com", "https://remote.openbitfun.com.evil.example"),
            // A query on the endpoint may only ever carry the service version.
            link.replace("/#/pair?did=", "/?v=1.0.9&relay=evil#/pair?did="),
            link.replace("/#/pair?did=", "/?version=1.0.9#/pair?did="),
            link + "&did=foreign", link + "&pk=untrusted", link + "&relay=evil", link.replace("did=desktop-1", "room=old"),
            link.replace("did=desktop-1", "did=../bad"),
        )) {
            val result = resolveAccountDeviceLink(invalid, ready)
            assertEquals(AccountDeviceLinkStatus.INVALID, result.status, invalid)
            assertNull(result.deviceId)
        }
    }
}
