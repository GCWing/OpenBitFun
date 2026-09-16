package com.openbitfun.mobile.app

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RuntimeWorkspacePickerDialog
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.workspace.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RuntimeWorkspacePickerTest {
    @get:Rule val compose = createComposeRule()

    @Test fun recreationRetainsDraftAndDoesNotReplayWorkspaceMutation() {
        val restoration = StateRestorationTester(compose)
        val state = mutableStateOf(RemoteWorkspaceUiState.Ready(emptyList(), emptyList(), null,
            RemoteFilePreviewUiState.None, false, RemoteFileDownloadUiState.None))
        val intents = mutableListOf<RemoteWorkspaceIntent>()
        restoration.setContent {
            OpenBitFunTheme(dark = true) {
                RuntimeWorkspacePickerDialog(state.value, onIntent = {
                    intents += it
                    state.value = state.value.copy(busy = true)
                }, onDismiss = {})
            }
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("/workspace/draft")
        restoration.emulateSavedInstanceStateRestore()
        compose.onNode(hasSetTextAction()).assertTextContains("/workspace/draft")
        compose.runOnIdle { assertEquals(0, intents.size) }
        val open = InstrumentationRegistry.getInstrumentation().targetContext.getString(R.string.workspace_open_path)
        compose.onAllNodesWithText(open).filter(hasClickAction()).onFirst().performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertEquals(1, intents.size)
            state.value = state.value.copy(busy = false, loadFailure = true)
        }
        compose.onNode(hasSetTextAction()).assertTextContains("/workspace/draft")
        compose.runOnIdle { assertEquals(1, intents.size) }
    }
}
