package com.openbitfun.mobile.app

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RuntimeFileEditorDialog
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RuntimeFilesUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class RuntimeFileEditorTest {
    @get:Rule val compose = createComposeRule()
    private fun text(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    @Test fun failedSavePreservesDraftAndCancelledDiscardKeepsEditorOpen() {
        val state = mutableStateOf(RuntimeFilesUiState("/repo", emptyList(), false, "/repo/file.md", "original", false, false))
        val intents = mutableListOf<RemoteWorkspaceIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RuntimeFileEditorDialog(state.value) { intents += it }
            }
        }
        compose.onNode(hasSetTextAction()).performTextReplacement("unsaved draft")
        compose.onNodeWithText(text(R.string.workspace_save_file)).performClick()
        compose.runOnIdle {
            assertEquals("unsaved draft", (intents.single() as RemoteWorkspaceIntent.SaveFile).content)
            state.value = state.value.copy(failed = true)
        }
        compose.onNode(hasSetTextAction()).assertTextEquals("unsaved draft")
        compose.onNodeWithText(text(R.string.workspace_files_failed)).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.common_back)).performClick()
        compose.onNodeWithText(text(R.string.workspace_discard_changes)).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.common_cancel)).performClick()
        compose.onNode(hasSetTextAction()).assertTextEquals("unsaved draft")
        compose.runOnIdle { assertEquals(1, intents.size) }
        compose.onNodeWithText(text(R.string.common_back)).performClick()
        compose.onNodeWithText(text(R.string.workspace_discard)).performClick()
        compose.runOnIdle { assertTrue(intents.last() is RemoteWorkspaceIntent.CloseFileEditor) }
    }
}
