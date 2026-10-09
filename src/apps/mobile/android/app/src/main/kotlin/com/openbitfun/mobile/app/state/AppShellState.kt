package com.openbitfun.mobile.app.state

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

/**
 * What the content area shows.
 *
 * Only two, because the shell moved settings and the account onto sheets the
 * way `AppShell.ets` binds them — a sheet is not a destination, so neither can
 * displace the conversation the user was reading.
 */
internal enum class MobileSurface {
    REMOTE,
}

/**
 * The shell's own navigation and overlay state, ported from
 * `pages/state/AppShellState.ets`.
 *
 * The transitions live here rather than in the composable for the reason the
 * source keeps them in a class: "opening the account closes settings" is a rule
 * about the shell, and a rule spread across the call sites that trigger it is a
 * rule each new call site can get wrong. The view reads the properties and calls
 * the verbs; nothing outside sets a field.
 */
@Stable
internal class AppShellState(
    surface: MobileSurface,
    showSettings: Boolean,
    showAccount: Boolean,
    accountReturnsToSettings: Boolean,
    searchOpen: Boolean,
    sidebarQuery: String,
    remoteSessionId: String? = null,
    remoteCreating: Boolean = false,
    remoteConnectOpen: Boolean = false,
) {
    internal var surface: MobileSurface by mutableStateOf(surface)
        private set

    internal var showSettings: Boolean by mutableStateOf(showSettings)
        private set

    /** Whether closing the account lands back on the page that opened it. */
    private var accountReturnsToSettings: Boolean by mutableStateOf(accountReturnsToSettings)

    internal var showAccount: Boolean by mutableStateOf(showAccount)
        private set

    internal var searchOpen: Boolean by mutableStateOf(searchOpen)
        private set

    internal var sidebarQuery: String by mutableStateOf(sidebarQuery)
        private set

    internal var remoteSessionId: String? by mutableStateOf(remoteSessionId)
        private set

    internal var remoteCreating: Boolean by mutableStateOf(remoteCreating)
        private set

    internal var remoteConnectOpen: Boolean by mutableStateOf(remoteConnectOpen)
        private set

    internal fun closeRemoteConnect() {
        remoteConnectOpen = false
    }

    internal fun show(next: MobileSurface) {
        surface = next
    }

    internal fun openRemoteSession(sessionId: String) {
        closeRemoteConnect()
        surface = MobileSurface.REMOTE
        remoteCreating = false
        remoteSessionId = sessionId
    }

    internal fun createRemoteSession() {
        closeRemoteConnect()
        surface = MobileSurface.REMOTE
        remoteCreating = true
        remoteSessionId = null
    }

    internal fun closeRemoteSession() {
        closeRemoteConnect()
        remoteCreating = false
        remoteSessionId = null
    }

    /**
     * Opens the account-device picker on the remote surface.
     *
     * The only way to reach a desktop is through the signed-in account, so the
     * caller decides between this and [openAccount] by whether an account is
     * ready; the sheet itself never offers another way in.
     */
    internal fun openRemoteConnect() {
        remoteConnectOpen = true
        surface = MobileSurface.REMOTE
        remoteCreating = false
        remoteSessionId = null
    }

    /**
     * Opens the one settings page. The sidebar gear and the remote home header
     * both land here: there is no separate remote-control settings page.
     */
    internal fun openSettings() {
        showSettings = true
    }

    internal fun dismissSettings() {
        showSettings = false
    }

    /**
     * The account lives inside the settings page (the way `SettingsSheet.ets`
     * embeds `AccountProfilePanel`), so a signed-in account is shown by opening
     * settings. Only a signed-out user gets a separate step: the login sheet.
     *
     * One sheet at a time: login replaces settings rather than stacking on it, and
     * whether settings asked for it is remembered — the source's
     * `accountReturnMode` — so cancelling puts that page back.
     */
    internal fun openAccount(signedIn: Boolean) {
        if (signedIn) {
            if (!showSettings) openSettings()
            return
        }
        accountReturnsToSettings = showSettings
        showSettings = false
        showAccount = true
    }

    /**
     * Login finished: the account now shows inside settings, so the user lands
     * there whether or not settings sent them.
     */
    internal fun completeLogin() {
        if (!showAccount) return
        showAccount = false
        accountReturnsToSettings = false
        openSettings()
    }

    internal fun dismissAccount() {
        showAccount = false
        if (accountReturnsToSettings) {
            accountReturnsToSettings = false
            showSettings = true
        }
    }

    internal fun search(query: String) {
        sidebarQuery = query
    }

    /** Closing the field clears it, so reopening it never resumes an old search. */
    internal fun toggleSearch() {
        searchOpen = !searchOpen
        if (!searchOpen) sidebarQuery = ""
    }

    internal companion object {
        private const val SETTINGS_PAGE_PLACEHOLDER = "GENERAL"

        // Enums are not saveable, so the surface crosses as its name — a stable
        // identifier, unlike an ordinal, if a case is ever inserted.
        val Saver: Saver<AppShellState, Any> = listSaver(
            save = {
                listOf(
                    it.surface.name,
                    it.showSettings,
                    // Index 2 held the settings page, when there were two
                    // (GENERAL and REMOTE). There is one now; the slot keeps
                    // the name every build can read so positions line up.
                    SETTINGS_PAGE_PLACEHOLDER,
                    it.showAccount,
                    it.accountReturnsToSettings,
                    it.searchOpen,
                    it.sidebarQuery,
                    it.remoteSessionId,
                    it.remoteCreating,
                    // Index 9 held the retired scanner request. It stays a
                    // placeholder so the positions older builds wrote still
                    // line up with what [restore] reads.
                    false,
                    it.remoteConnectOpen,
                )
            },
            restore = {
                AppShellState(
                    surface = MobileSurface.REMOTE,
                    showSettings = it[1] as Boolean,
                    // Index 2 is ignored: an old "REMOTE" and "GENERAL" both
                    // restore to the single settings page.
                    showAccount = it[3] as Boolean,
                    accountReturnsToSettings = it[4] as Boolean,
                    searchOpen = it[5] as Boolean,
                    sidebarQuery = it[6] as String,
                    remoteSessionId = it.getOrNull(7) as String?,
                    remoteCreating = it.getOrNull(8) as? Boolean ?: false,
                    // A state saved before index 10 existed only knew the
                    // scanner request, which opened the connect sheet.
                    remoteConnectOpen = it.getOrNull(10) as? Boolean
                        ?: (it.getOrNull(9) as? Boolean ?: false),
                )
            },
        )
    }
}

@Composable
internal fun rememberAppShellState(): AppShellState = rememberSaveable(saver = AppShellState.Saver) {
    AppShellState(
        surface = MobileSurface.REMOTE,
        showSettings = false,
        showAccount = false,
        accountReturnsToSettings = false,
        searchOpen = false,
        sidebarQuery = "",
        remoteSessionId = null,
        remoteCreating = false,
    )
}
