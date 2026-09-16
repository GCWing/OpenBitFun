package com.openbitfun.mobile.app

import android.graphics.Bitmap
import java.io.File
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RuntimeFilesDialog
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.workspace.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RuntimeFileBrowserTest {
    @get:Rule val compose = createComposeRule()
    private fun text(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    @Test fun changingSortResetsAnchorButAppendingPreservesIt() {
        val entries = (0 until 80).map { RuntimeFileUiState("/repo/$it", "entry-$it", false) }
        val files = RuntimeFilesUiState("/repo", entries, false, null, "", false, false)
        val state = mutableStateOf(RemoteWorkspaceUiState.Ready(emptyList(), emptyList(), null, RemoteFilePreviewUiState.None, false, RemoteFileDownloadUiState.None).copy(files = files))
        compose.setContent {
            OpenBitFunTheme(dark = false) { RuntimeFilesDialog(state.value, onBack = {}, onIntent = {}) }
        }
        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(30)
        compose.onNodeWithText("entry-30").assertIsDisplayed()
        compose.runOnIdle {
            state.value = state.value.copy(files = files.copy(entries = entries + RuntimeFileUiState("/repo/80", "entry-80", false)))
        }
        compose.onNodeWithText("entry-30").assertIsDisplayed()
        compose.runOnIdle {
            state.value = state.value.copy(files = files.copy(sort = RuntimeFileSort.NAME_DESC, entries = entries.reversed()))
        }
        compose.onNodeWithText("entry-79").assertIsDisplayed()
        compose.runOnIdle {
            state.value = state.value.copy(files = files.copy(directory = "/other"))
        }
        compose.onNodeWithText("entry-0").assertIsDisplayed()
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun rowRenameRetainsFailedDraftAndFastRetryClosesForm() {
        val files = RuntimeFilesUiState("/repo", listOf(RuntimeFileUiState("/repo/report.md", "report.md", false)), false, null, "", false, false)
        val state = mutableStateOf(RemoteWorkspaceUiState.Ready(emptyList(), emptyList(), null, RemoteFilePreviewUiState.None, false, RemoteFileDownloadUiState.None).copy(files = files))
        val intents = mutableListOf<RemoteWorkspaceIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RuntimeFilesDialog(state.value, onBack = {}, onIntent = { intent ->
                    intents += intent
                    if (intent is RemoteWorkspaceIntent.RenameFileEntry) {
                        val current = state.value.files
                        state.value = state.value.copy(files = current.copy(failed = intents.size == 1, completedOperation = current.completedOperation + 1))
                    }
                })
            }
        }
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        capture("file-browser-list.png")
        compose.onNodeWithContentDescription(text(R.string.workspace_file_actions)).performClick()
        compose.onNodeWithText(text(R.string.session_rename)).performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("renamed.md")
        compose.onAllNodesWithText(text(R.string.session_rename)).filter(hasClickAction()).onFirst().performClick()
        compose.onNode(hasSetTextAction()).assertTextContains("renamed.md")
        compose.onNodeWithText(text(R.string.workspace_files_failed)).assertIsDisplayed()
        capture("file-browser-failed-form.png")
        compose.runOnIdle {
            val intent = intents.single() as RemoteWorkspaceIntent.RenameFileEntry
            assertEquals("/repo/report.md", intent.path)
            assertEquals("renamed.md", intent.name)
        }
        compose.onAllNodesWithText(text(R.string.session_rename)).filter(hasClickAction()).onFirst().performClick()
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
    }
}
