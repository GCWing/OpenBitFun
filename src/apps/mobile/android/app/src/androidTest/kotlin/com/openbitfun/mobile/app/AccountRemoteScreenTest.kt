package com.openbitfun.mobile.app

import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionFailureReason
import com.openbitfun.mobile.app.ui.chat.CONVERSATION_LOADING_TEST_TAG
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openbitfun.mobile.app.ui.remote.CONNECT_ACCOUNT_DEVICE_REFRESH_TEST_TAG
import com.openbitfun.mobile.app.ui.remote.CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX
import com.openbitfun.mobile.app.ui.remote.ConnectAccountDeviceScreen
import com.openbitfun.mobile.app.ui.remote.AccountRemoteScreen
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.account.AccountDeviceUi
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.layout.SettingsPlacementMode
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals

class AccountRemoteScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun aSelectedAccountDeviceBypassesThePairingForm() {
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                AccountRemoteScreen(
                    remoteState = RemoteSessionUiState.Idle,
                    workspaceState = RemoteWorkspaceUiState.Idle,
                    deviceId = "device-1",
                    deviceName = "Studio Mac",
                    createDevices = emptyList(),
                    accountUsername = "tester",
                    phase = ConnectionPhase.CONNECTED,
                    settingsPlacement = SettingsPlacement(
                        mode = SettingsPlacementMode.BOTTOM,
                        width = 0,
                        height = 0,
                        maxHeight = 0,
                    ),
                    sessionDetailsPlacement = SettingsPlacement(
                        mode = SettingsPlacementMode.BOTTOM,
                        width = 0,
                        height = 0,
                        maxHeight = 0,
                    ),
                    viewSettingsPlacement = SettingsPlacement(
                        mode = SettingsPlacementMode.BOTTOM,
                        width = 0,
                        height = 0,
                        maxHeight = 0,
                    ),
                    onOpenRemoteSettings = {},
                    onCreateDevicePick = {},
                    onSessionIntent = {},
                    onWorkspaceIntent = {},
                    modifier = Modifier,
                )
            }
        }

        composeRule.onAllNodesWithText(testString(R.string.pairing_title)).assertCountEquals(0)
    }

    @Test
    fun aRequestedSessionRoutesImmediatelyAndCanRetryALoadFailure() {
        val state = mutableStateOf<RemoteSessionUiState>(RemoteSessionUiState.Idle)
        val intents = mutableListOf<RemoteSessionIntent>()
        var wentBack = false
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                val placement = SettingsPlacement(SettingsPlacementMode.BOTTOM, 0, 0, 0)
                AccountRemoteScreen(
                    remoteState = state.value, workspaceState = RemoteWorkspaceUiState.Idle,
                    deviceId = "device-1", deviceName = "Studio Mac", createDevices = emptyList(),
                    accountUsername = "tester", phase = ConnectionPhase.RECONNECTING,
                    settingsPlacement = placement, sessionDetailsPlacement = placement,
                    viewSettingsPlacement = placement, onOpenRemoteSettings = {}, onCreateDevicePick = {},
                    onSessionIntent = { intents += it }, onWorkspaceIntent = {},
                    requestedSessionId = "requested", onRemoteHome = { wentBack = true },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        composeRule.mainClock.advanceTimeBy(200)
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.home_recent_title)).assertDoesNotExist()
        composeRule.runOnIdle { state.value = RemoteSessionUiState.Failed(RemoteSessionFailureReason.TRANSPORT) }
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertDoesNotExist()
        composeRule.onNodeWithText(testString(R.string.sessions_failed)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.sessions_retry)).performClick()
        assertEquals(listOf(RemoteSessionIntent.Open("requested")), intents)
        composeRule.onNodeWithText(testString(R.string.conversation_back)).performClick()
        assertEquals(true, wentBack)
    }

    @Test
    fun aSignedInAccountWithoutATargetCanRefreshOrSelect() {
        var refreshes = 0
        var selected = ""
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ConnectAccountDeviceScreen(
                    state = AccountUiState.Ready(
                        userId = "user-1",
                        username = "tester",
                        devices = listOf(
                            AccountDeviceUi("desk-1", "Studio Mac", online = true, lastSeenAt = null),
                            AccountDeviceUi("desk-2", "Office PC", online = false, lastSeenAt = null),
                        ),
                        selectedDeviceId = null,
                        selectedDeviceName = null,
                    ),
                    onBack = {},
                    onRefresh = { refreshes += 1 },
                    onSelect = { selected = it },
                    modifier = Modifier,
                )
            }
        }

        composeRule.onNodeWithText(testString(R.string.connect_account_devices_title)).assertIsDisplayed()
        composeRule.onNodeWithTag(CONNECT_ACCOUNT_DEVICE_REFRESH_TEST_TAG).performClick()
        composeRule.onNodeWithTag(CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX + "desk-1").performClick()
        composeRule.onNodeWithTag(CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX + "desk-2").performClick()

        assertEquals(1, refreshes)
        assertEquals("desk-1", selected)
    }

    @Test
    fun aSelectedOfflineAccountDeviceCanReconnect() {
        var selected = ""
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ConnectAccountDeviceScreen(
                    state = AccountUiState.Ready(
                        userId = "user-1",
                        username = "tester",
                        devices = listOf(
                            AccountDeviceUi("desk-1", "Studio Mac", online = true, lastSeenAt = null),
                            AccountDeviceUi("desk-2", "Office PC", online = false, lastSeenAt = null),
                        ),
                        selectedDeviceId = "desk-2",
                        selectedDeviceName = "Office PC",
                    ),
                    onBack = {},
                    onRefresh = {},
                    onSelect = { selected = it },
                    modifier = Modifier,
                )
            }
        }

        composeRule.onNodeWithTag(CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX + "desk-2").performClick()

        assertEquals("desk-2", selected)
    }
}
