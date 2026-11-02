package com.openbitfun.mobile.app

import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openbitfun.mobile.app.ui.settings.FULL_ACCESS_CONFIRM_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.PERMISSION_SECTION_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.PermissionSection
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionAgentFilter
import com.openbitfun.mobile.core.feature.session.SessionPermissionMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PermissionModeCardTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun knownModesRenderAndSelectingAutoDispatches() {
        val intents = mutableListOf<RemoteSessionIntent>()
        setPermissionContent(
            permissionMode = SessionPermissionMode.ASK,
            onIntent = { intents += it },
        )

        composeRule.onNodeWithText(testString(R.string.permission_ask)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_auto)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_full)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_auto)).performClick()

        assertEquals(
            listOf(RemoteSessionIntent.SetPermissionMode(SessionPermissionMode.AUTO)),
            intents,
        )
    }

    @Test
    fun fullAccessRequiresConfirmationAndCanBeCancelled() {
        val intents = mutableListOf<RemoteSessionIntent>()
        setPermissionContent(
            permissionMode = SessionPermissionMode.ASK,
            onIntent = { intents += it },
        )

        composeRule.onNodeWithText(testString(R.string.permission_full)).performClick()
        assertTrue(intents.isEmpty())
        composeRule.onNodeWithTag(FULL_ACCESS_CONFIRM_TEST_TAG).assertIsDisplayed()

        composeRule.onNodeWithText(testString(R.string.common_cancel)).performClick()
        composeRule.onNodeWithTag(FULL_ACCESS_CONFIRM_TEST_TAG).assertDoesNotExist()
        assertTrue(intents.isEmpty())

        composeRule.onNodeWithText(testString(R.string.permission_full)).performClick()
        composeRule.onNodeWithText(testString(R.string.permission_full_confirm_action)).performClick()
        assertEquals(
            listOf(RemoteSessionIntent.SetPermissionMode(SessionPermissionMode.FULL_ACCESS)),
            intents,
        )
    }

    @Test
    fun unknownModeExplainsFailureDisablesModesAndLeavesRefreshEnabled() {
        setPermissionContent(permissionMode = SessionPermissionMode.UNKNOWN)

        composeRule
            .onNodeWithText(testString(R.string.permission_unknown))
            .assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_ask)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_auto)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_full)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.account_devices_refresh)).assertIsEnabled()
    }

    @Test
    fun disconnectedStateExplainsConnectionAndDisablesModes() {
        setPermissionContent(
            permissionMode = SessionPermissionMode.ASK,
            connected = false,
        )

        composeRule
            .onNodeWithText(testString(R.string.permission_needs_connection))
            .assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_ask)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_auto)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_full)).assertIsNotEnabled()
    }

    @Test
    fun withoutAReadySessionTheSectionStaysVisibleButDisabled() {
        val intents = mutableListOf<RemoteSessionIntent>()
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                PermissionSection(
                    state = null,
                    connected = false,
                    onIntent = { intents += it },
                    modifier = Modifier,
                )
            }
        }

        composeRule.onNodeWithTag(PERMISSION_SECTION_TEST_TAG).assertIsDisplayed()
        composeRule
            .onNodeWithText(testString(R.string.permission_needs_connection))
            .assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.permission_ask)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_auto)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_full)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.permission_full)).performClick()
        composeRule.onNodeWithTag(FULL_ACCESS_CONFIRM_TEST_TAG).assertDoesNotExist()
        assertTrue(intents.isEmpty())
    }

    private fun setPermissionContent(
        permissionMode: SessionPermissionMode?,
        connected: Boolean = true,
        onIntent: (RemoteSessionIntent) -> Unit = {},
    ) {
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                PermissionSection(
                    state = readyState(permissionMode),
                    connected = connected,
                    onIntent = onIntent,
                    modifier = Modifier,
                )
            }
        }
    }

    private fun readyState(permissionMode: SessionPermissionMode?) = RemoteSessionUiState.Ready(
        sessions = emptyList(),
        selectedSessionId = null,
        timeline = null,
        busy = false,
        permissionMode = permissionMode,
        permissionModeFailure = null,
        query = "",
        agentFilter = SessionAgentFilter.ALL,
        hasMore = false,
        hasMoreMessages = false,
        modelCatalog = null,
    )
}
