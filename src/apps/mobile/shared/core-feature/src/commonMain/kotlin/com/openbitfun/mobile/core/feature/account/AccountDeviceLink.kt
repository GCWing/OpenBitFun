package com.openbitfun.mobile.core.feature.account

import com.openbitfun.mobile.core.transport.accountDeviceLink
import com.openbitfun.mobile.core.transport.sameRelayDeployment

public enum class AccountDeviceLinkStatus { INVALID, SIGN_IN_REQUIRED, UNAVAILABLE, READY }

public data class AccountDeviceLinkResult(public val status: AccountDeviceLinkStatus, public val deviceId: String?, public val relayUrl: String?) {
    public constructor(status: AccountDeviceLinkStatus, deviceId: String?) : this(status, deviceId, null)
}

/** Membership must come from the account signed in at this exact Relay endpoint. */
public fun resolveAccountDeviceLink(url: String, state: AccountUiState): AccountDeviceLinkResult {
    val link = accountDeviceLink(url)
        ?: return AccountDeviceLinkResult(AccountDeviceLinkStatus.INVALID, null)
    val id = link.deviceId
    val ready = (state as? AccountUiState.Ready)?.takeIf { sameRelayDeployment(it.relayUrl, link.relayUrl) }
        ?: return AccountDeviceLinkResult(AccountDeviceLinkStatus.SIGN_IN_REQUIRED, id, link.relayUrl)
    // A scanned target must never resolve to a device the Relay confirmed is
    // incompatible; the link reads as unavailable, the same as offline.
    return if (ready.devices.any { it.id == id && it.online && it.controllable }) {
        AccountDeviceLinkResult(AccountDeviceLinkStatus.READY, id, link.relayUrl)
    } else AccountDeviceLinkResult(AccountDeviceLinkStatus.UNAVAILABLE, null)
}
