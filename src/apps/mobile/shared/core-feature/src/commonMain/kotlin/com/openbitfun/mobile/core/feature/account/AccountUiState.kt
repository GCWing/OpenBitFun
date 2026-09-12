package com.openbitfun.mobile.core.feature.account

public enum class AccountFailureReason {
    INVALID_CREDENTIALS,
    AUTHENTICATION,
    RATE_LIMITED,
    RELAY_UNAVAILABLE,
    NETWORK,
    TIMEOUT,
    MALFORMED_RESPONSE,
    SECURE_STORAGE,
}

public enum class AccountFailureStage {
    RESTORE,
    AUTHENTICATION,
    DEVICE_LIST,
    SECURE_STORAGE,
}

public data class AccountDeviceUi public constructor(
    public val id: String,
    public val name: String,
    public val online: Boolean,
    public val lastSeenAt: Long?,
)

public sealed interface AccountUiState {
    public data object Idle : AccountUiState
    public data object Restoring : AccountUiState
    public data object SignedOut : AccountUiState
    public data object SigningIn : AccountUiState
    public data class Authorizing(public val authorizationUrl: String) : AccountUiState
    public data class Ready public constructor(
        public val userId: String,
        public val relayUrl: String,
        /**
         * The name this session signed in under.
         *
         * What a settings page names the account by: the id behind it is a
         * machine identifier, and a screen that shows it in place of a name has
         * told the user nothing and published an identifier for nothing.
         */
        public val username: String,
        /**
         * The devices this one can drive, already filtered by
         * [AccountDevicePolicy] — a screen that renders these rows has no
         * further rule to remember.
         */
        public val devices: List<AccountDeviceUi>,
        public val selectedDeviceId: String?,
        public val selectedDeviceName: String?,
        /** A device-list reload in flight, with the previous list still shown. */
        public val refreshing: Boolean,
        /**
         * Why the last reload failed, or null. [devices] is still the last list
         * that arrived, so a failed refresh costs the user nothing they had.
         */
        public val refreshFailure: AccountFailureReason?,
        public val avatarUrl: String?,
    ) : AccountUiState {
        public constructor(
            userId: String, relayUrl: String, username: String, devices: List<AccountDeviceUi>,
            selectedDeviceId: String?, selectedDeviceName: String?, refreshing: Boolean,
            refreshFailure: AccountFailureReason?,
        ) : this(userId, relayUrl, username, devices, selectedDeviceId, selectedDeviceName, refreshing, refreshFailure, null)

        public constructor(
            userId: String,
            username: String,
            relayUrl: String,
            devices: List<AccountDeviceUi>,
            selectedDeviceId: String?,
            selectedDeviceName: String?,
        ) : this(userId, relayUrl, username, devices, selectedDeviceId, selectedDeviceName, false, null)

    }
    public data class Failed public constructor(
        public val reason: AccountFailureReason,
        public val canRetry: Boolean,
        public val stage: AccountFailureStage,
    ) : AccountUiState
}

public sealed interface AccountIntent {
    public data object Restore : AccountIntent
    public data object Login : AccountIntent
    public data class SelectRelay(public val relayUrl: String) : AccountIntent
    public data class SelectDevice public constructor(public val deviceId: String) : AccountIntent

    /**
     * Ask the relay for the device list again.
     *
     * The list is a presence snapshot, so it is stale the moment it arrives —
     * a desktop that starts up after sign-in is invisible until something asks
     * again, and this is that something.
     */
    public data object RefreshDevices : AccountIntent

    /** Retry the failed device-list stage with the authenticated session already in memory. */
    public data object Retry : AccountIntent
    public data object Logout : AccountIntent
    public data object Stop : AccountIntent
}
