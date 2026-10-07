package com.openbitfun.mobile.app.state

import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.*
import org.junit.Test

class AppShellStateTest {
    private fun state() = AppShellState(
        MobileSurface.REMOTE, false, false, false, false, "",
    )

    private val scope = object : SaverScope {
        override fun canBeSaved(value: Any): Boolean = true
    }

    @Test fun disconnectedHomeIsSeparateFromConnectionChooser() {
        val shell = state()
        assertFalse(shell.remoteConnectOpen)
        shell.openRemoteConnect()
        assertTrue(shell.remoteConnectOpen)
        shell.closeRemoteConnect()
        assertFalse(shell.remoteConnectOpen)
    }

    @Test fun selectingADeviceOrSessionClosesConnectionFlow() {
        val shell = state()
        shell.openRemoteConnect()
        shell.closeRemoteSession()
        assertFalse(shell.remoteConnectOpen)
        shell.openRemoteConnect()
        shell.openRemoteSession("session")
        assertEquals("session", shell.remoteSessionId)
        assertFalse(shell.remoteConnectOpen)
    }

    @Test fun restoreAcceptsOldSavedStateAndRetainsNewConnectionRoute() {
        val legacy = listOf("REMOTE", false, "GENERAL", false, false, false, "", null, false, false)
        assertFalse(AppShellState.Saver.restore(legacy)!!.remoteConnectOpen)
        // Older builds saved a scanner request at index 9 and nothing after it;
        // that request meant the connect sheet was open.
        val legacyScanner = legacy.dropLast(1) + true
        assertTrue(AppShellState.Saver.restore(legacyScanner)!!.remoteConnectOpen)
        // A build that also wrote index 10 is read from index 10.
        val legacyBoth = legacy + false
        val closedWithScanFlag = legacyBoth.toMutableList().also { it[9] = true }
        assertFalse(AppShellState.Saver.restore(closedWithScanFlag)!!.remoteConnectOpen)

        val shell = state().apply { openRemoteConnect() }
        val saved = with(AppShellState.Saver) { scope.save(shell) }!!
        assertEquals(11, (saved as List<*>).size)
        assertEquals(false, saved[9])
        assertTrue(AppShellState.Saver.restore(saved)!!.remoteConnectOpen)
    }

    @Test fun restoreMapsTheRetiredRemoteSettingsPageToTheOneSettingsPage() {
        // Builds with two settings pages saved "REMOTE" at index 2. It must
        // still restore, onto the single settings page, rather than throw.
        val legacyRemote = listOf("REMOTE", true, "REMOTE", false, false, false, "", null, false, false, false)
        val restored = AppShellState.Saver.restore(legacyRemote)!!
        assertTrue(restored.showSettings)
        assertFalse(restored.showAccount)

        val saved = with(AppShellState.Saver) { scope.save(restored) } as List<*>
        assertEquals("GENERAL", saved[2])
        assertTrue(AppShellState.Saver.restore(saved)!!.showSettings)
    }

    @Test fun signedInAccountOpensSettingsInsteadOfASeparatePage() {
        val shell = state()
        shell.openAccount(signedIn = true)
        assertTrue(shell.showSettings)
        assertFalse(shell.showAccount)
    }

    @Test fun signedInAccountKeepsTheSettingsPageAlreadyShowing() {
        val shell = state()
        shell.openSettings()
        shell.openAccount(signedIn = true)
        assertTrue(shell.showSettings)
        assertFalse(shell.showAccount)
    }

    @Test fun signedOutLoginFromSettingsReturnsToSettings() {
        val shell = state()
        shell.openSettings()
        shell.openAccount(signedIn = false)
        assertTrue(shell.showAccount)
        assertFalse(shell.showSettings)
        shell.completeLogin()
        assertFalse(shell.showAccount)
        assertTrue(shell.showSettings)
    }

    @Test fun signedOutLoginFromOutsideSettingsLandsOnSettings() {
        val shell = state()
        shell.openAccount(signedIn = false)
        shell.completeLogin()
        assertFalse(shell.showAccount)
        assertTrue(shell.showSettings)
    }

    @Test fun cancellingLoginRestoresOnlyTheSettingsThatAskedForIt() {
        val fromSettings = state().apply {
            openSettings()
            openAccount(signedIn = false)
            dismissAccount()
        }
        assertTrue(fromSettings.showSettings)
        val fromHome = state().apply {
            openAccount(signedIn = false)
            dismissAccount()
        }
        assertFalse(fromHome.showSettings)
        assertFalse(fromHome.showAccount)
    }

    @Test fun completeLoginWithoutAnOpenLoginSheetDoesNothing() {
        val shell = state()
        shell.completeLogin()
        assertFalse(shell.showSettings)
    }
}
