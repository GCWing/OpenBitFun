package com.openbitfun.mobile.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.account.ACCOUNT_SETTINGS_DEVICES_TEST_TAG
import com.openbitfun.mobile.app.ui.account.ACCOUNT_SETTINGS_SIGN_IN_TEST_TAG
import com.openbitfun.mobile.app.ui.account.ACCOUNT_SETTINGS_SIGN_OUT_TEST_TAG
import com.openbitfun.mobile.app.ui.remote.CONNECT_ACCOUNT_DEVICE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.SETTINGS_CLOSE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.SETTINGS_MODEL_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.PERMISSION_SECTION_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.SETTINGS_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_ACCOUNT_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_KEY_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_LOCAL_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_MODEL_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_PROBE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_SAVE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.MODEL_SERVICE_URL_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.SETTINGS_PROFILE_TEST_TAG
import com.openbitfun.mobile.app.ui.shell.MENU_TEST_TAG
import com.openbitfun.mobile.app.ui.shell.sidebar.SIDEBAR_CODE_TEST_TAG
import com.openbitfun.mobile.app.ui.shell.sidebar.SIDEBAR_REMOTE_SESSION_TEST_TAG
import com.openbitfun.mobile.app.ui.shell.sidebar.SIDEBAR_SETTINGS_TEST_TAG
import com.openbitfun.mobile.app.ui.shell.sidebar.SIDEBAR_TEST_TAG
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Covers the Android-to-feature seam without requiring a relay or credentials. */
class MobileScreenTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    private fun text(resource: Int): String = InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)

    @Test
    fun welcomeOrDrawerExposesNavigationEntries() {
        if (!hasDrawerEntry()) {
            composeRule.onNodeWithText(text(R.string.welcome_login)).assertIsDisplayed()
            composeRule.onNodeWithText(text(R.string.miniapps_title)).performClick()
            composeRule.onNodeWithContentDescription(text(R.string.miniapps_back)).assertIsDisplayed().performClick()
            composeRule.onNodeWithText(text(R.string.welcome_login)).assertIsDisplayed()
            return
        }
        composeRule.onNodeWithTag(SIDEBAR_TEST_TAG).assertIsNotDisplayed()

        openDrawer()
        composeRule.onNodeWithTag(SIDEBAR_TEST_TAG).assertIsDisplayed()
        // The recent list holds general-chat sessions, and a session is only
        // stored once something has been sent to it — so a device that has never
        // chatted shows the empty state rather than a blank row.
        composeRule.onNodeWithText(text(R.string.sidebar_recent_empty)).assertIsDisplayed()

        composeRule.onNodeWithTag(SIDEBAR_CODE_TEST_TAG).performClick()

        // A signed-in drawer reaches desktops only through the account's device
        // picker; there is no scan or pairing-link step behind it any more.
        waitForTag(CONNECT_ACCOUNT_DEVICE_TEST_TAG)
        composeRule.onNodeWithTag(SIDEBAR_TEST_TAG).assertIsNotDisplayed()
    }

    /**
     * The account has to be reachable, and the drawer has to get out of its way.
     *
     * Worth an instrumentation test because the account was once reachable only
     * from a footer that the signed-in drawer replaces, which left a signed-in
     * user with no way back to it at all. The rule that a sheet closes whatever
     * opened it lives in `AppShellState`; this is what it looks like on a phone.
     *
     * Both footers are walked because a device that has signed in once stays
     * signed in: pinning the test to the signed-out door would mean it only
     * passes on a fresh install, which is the one state the regression it
     * guards against cannot happen in.
     */
    @Test
    fun accountEntryWorksFromWelcomeOrDrawer() {
        if (!hasDrawerEntry()) {
            composeRule.onNodeWithText(text(R.string.welcome_login)).performClick()
            composeRule.onNode(hasText(text(R.string.account_login_title)) and hasClickAction()).assertIsDisplayed()
            return
        }
        openDrawer()
        composeRule.onNodeWithTag(SIDEBAR_TEST_TAG).assertIsDisplayed()

        val signedOut = composeRule.onAllNodesWithText(text(R.string.account_login_title))
            .fetchSemanticsNodes()
            .isNotEmpty()
        if (signedOut) {
            composeRule.onNodeWithText(text(R.string.account_login_title)).performClick()
            waitForText(text(R.string.account_login_title))
        } else {
            // The account is embedded in settings: the gear is the way to it,
            // and the page itself shows who is signed in, the devices, and sign
            // out, without another page behind a row.
            composeRule.onNodeWithTag(SIDEBAR_SETTINGS_TEST_TAG).performClick()
            waitForTag(SETTINGS_PROFILE_TEST_TAG)
            composeRule.onNodeWithTag(ACCOUNT_SETTINGS_DEVICES_TEST_TAG).assertExists()
            composeRule.onNodeWithTag(ACCOUNT_SETTINGS_SIGN_OUT_TEST_TAG).assertExists()
            composeRule.onAllNodesWithTag(ACCOUNT_SETTINGS_SIGN_IN_TEST_TAG).assertCountEquals(0)
        }
        composeRule.onNodeWithTag(SIDEBAR_TEST_TAG).assertIsNotDisplayed()
    }

    /**
     * The settings page closes by its own button.
     *
     * The page's body is one long scroll and the sheet does not take a pull-down,
     * so a downward drag never dismisses it and this button is the exit that is
     * always there. Losing it would strand the page.
     */
    @Test
    fun theSettingsPageClosesByItsOwnButton() {
        openDrawer()
        openSettingsFromAuthenticatedDrawerOrSkip()
        waitForText(text(R.string.navigation_settings))

        composeRule.onNodeWithTag(SETTINGS_CLOSE_TEST_TAG).performClick()

        waitForNoText(text(R.string.settings_about_section))
    }

    /** The sidebar gear is the app-settings entry, even over a remote surface. */
    @Test
    fun theGearAlwaysOpensRootSettings() {
        openDrawer()
        openSettingsFromAuthenticatedDrawerOrSkip()

        waitForTag(SETTINGS_TEST_TAG)
        composeRule.onNodeWithTag(SETTINGS_MODEL_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithTag(SETTINGS_CLOSE_TEST_TAG).performClick()
        waitForNoTag(SETTINGS_TEST_TAG)

        openDrawer()
        waitForTag(SIDEBAR_TEST_TAG)
        val connectNodes = composeRule.onAllNodesWithTag(SIDEBAR_CODE_TEST_TAG)
            .fetchSemanticsNodes()
        if (connectNodes.isNotEmpty()) {
            composeRule.onNodeWithTag(SIDEBAR_CODE_TEST_TAG).performClick()
        } else {
            val remoteSessions = composeRule.onAllNodesWithTag(SIDEBAR_REMOTE_SESSION_TEST_TAG)
                .fetchSemanticsNodes()
            assumeTrue(
                "A connected instrumentation device needs at least one remote session",
                remoteSessions.isNotEmpty(),
            )
            composeRule.onAllNodesWithTag(SIDEBAR_REMOTE_SESSION_TEST_TAG)[0].performClick()
        }
        waitForTag(MENU_TEST_TAG)

        openDrawer()
        waitForTag(SIDEBAR_TEST_TAG)
        openSettingsFromAuthenticatedDrawerOrSkip()

        waitForTag(SETTINGS_TEST_TAG)
        composeRule.onNodeWithTag(SETTINGS_MODEL_TEST_TAG).assertIsDisplayed()
        // One settings page: the permission section is on it whether or not a
        // desktop is connected.
        composeRule.onNodeWithTag(PERMISSION_SECTION_TEST_TAG).assertExists()
        composeRule.onNodeWithTag(SETTINGS_CLOSE_TEST_TAG).performClick()
        waitForNoTag(SETTINGS_TEST_TAG)
    }

    /**
     * The provider editor is the only general-chat path that can be driven
     * without a real model endpoint, and it is the one that touches the
     * keystore — so it is worth having on a device rather than only in the
     * shared store's tests.
     */
    @Test
    fun modelServiceSheetRefusesAnInvalidApiUrl() {
        openGeneralModelService()
        composeRule.onNodeWithTag(MODEL_SERVICE_TEST_TAG).assertIsDisplayed()

        // The panel opens on the overview, so the form is one row in.
        composeRule.onNodeWithTag(MODEL_SERVICE_LOCAL_TEST_TAG).performClick()
        composeRule.onNodeWithTag(MODEL_SERVICE_URL_TEST_TAG).performTextInput("api.example.com")
        composeRule.onNodeWithTag(MODEL_SERVICE_MODEL_TEST_TAG).performTextInput("chat-model")
        composeRule.onNodeWithTag(MODEL_SERVICE_KEY_TEST_TAG).performTextInput("instrumentation-key")
        composeRule.onNodeWithTag(MODEL_SERVICE_SAVE_TEST_TAG).performClick()

        // Refused, and still on the form: the reason has to sit next to the field
        // that caused it, which the overview has none of.
        composeRule.onNodeWithText(text(R.string.model_service_invalid_url))
            .assertIsDisplayed()
        composeRule.onNodeWithTag(MODEL_SERVICE_URL_TEST_TAG).assertIsDisplayed()
    }

    /**
     * The account section is a row that is always there, saying what it has.
     *
     * Whether it has anything depends on who is signed in on the device running
     * this, so the assertion is that the section exists at all: "nothing synced"
     * and "no such feature" look identical to a user unless the row is present to
     * tell them apart, which is exactly what this panel used to get wrong by
     * omitting the section entirely.
     */
    @Test
    fun theModelPanelSaysWhatTheAccountHasSynced() {
        openGeneralModelService()

        composeRule.onNodeWithText(text(R.string.model_service_account_section)).assertIsDisplayed()
        composeRule.onNodeWithTag(MODEL_SERVICE_ACCOUNT_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithText(text(R.string.model_service_account_summary)).assertIsDisplayed()
    }

    /**
     * A probe with nothing to send is refused by the button, not by the endpoint.
     *
     * Without this the button is live on an empty form, and the first thing a new
     * user learns about their provider is a 401 that says nothing about the fact
     * that this app never sent a credential — the request was always going to fail
     * and the failure describes the wrong thing.
     */
    @Test
    fun theConnectionTestWaitsForSomethingToAuthenticateWith() {
        openGeneralModelService()
        composeRule.onNodeWithTag(MODEL_SERVICE_LOCAL_TEST_TAG).performClick()

        composeRule.onNodeWithTag(MODEL_SERVICE_PROBE_TEST_TAG).assertIsNotEnabled()
        composeRule.onNodeWithText(text(R.string.model_service_test_needs_key))
            .assertIsDisplayed()

        composeRule.onNodeWithTag(MODEL_SERVICE_KEY_TEST_TAG).performTextInput("instrumentation-key")

        composeRule.onNodeWithTag(MODEL_SERVICE_PROBE_TEST_TAG).assertIsEnabled()
    }

    private fun waitForText(text: String, substring: Boolean = false, timeoutMillis: Long = 20_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMillis) {
            composeRule.onAllNodesWithText(text, substring = substring)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    /** The other half of [waitForText]: a sheet leaves over an animation, not at once. */
    private fun waitForNoText(text: String, timeoutMillis: Long = 20_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMillis) {
            composeRule.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty()
        }
    }

    private fun waitForTag(tag: String, timeoutMillis: Long = 20_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMillis) {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun waitForNoTag(tag: String, timeoutMillis: Long = 20_000) {
        composeRule.waitUntil(timeoutMillis = timeoutMillis) {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty()
        }
    }

    private fun hasDrawerEntry(): Boolean = composeRule.onAllNodesWithTag(MENU_TEST_TAG).fetchSemanticsNodes().isNotEmpty()

    private fun openDrawer() {
        assumeTrue("This path requires an authenticated shell; signed-out welcome is covered separately", hasDrawerEntry())
        composeRule.onNodeWithTag(MENU_TEST_TAG).performClick()
    }

    private fun openSettingsFromAuthenticatedDrawerOrSkip() {
        val settingsNodes = composeRule.onAllNodesWithTag(SIDEBAR_SETTINGS_TEST_TAG)
            .fetchSemanticsNodes()
        assumeTrue(
            "Settings footer is only available when the instrumentation device is signed in",
            settingsNodes.isNotEmpty(),
        )
        composeRule.onNodeWithTag(SIDEBAR_SETTINGS_TEST_TAG).performClick()
    }

    private fun openGeneralModelService() {
        openDrawer()
        openSettingsFromAuthenticatedDrawerOrSkip()
        waitForText(text(R.string.navigation_settings))
        composeRule.onNodeWithTag(SETTINGS_MODEL_TEST_TAG).performClick()
    }
}
