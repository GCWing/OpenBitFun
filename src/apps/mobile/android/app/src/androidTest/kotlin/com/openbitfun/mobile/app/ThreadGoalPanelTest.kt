package com.openbitfun.mobile.app

import android.graphics.Bitmap
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.chat.ThreadGoalPanel
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.session.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

class ThreadGoalPanelTest {
    @get:Rule val compose = createComposeRule()
    @Test fun activeGoalCanPauseAndResume() = verify(false)
    @Test fun darkGoalCanPauseAndResume() = verify(true)
    private fun verify(dark: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val actions = mutableListOf<ThreadGoalAction>()
        compose.setContent {
            var state by remember { mutableStateOf(ThreadGoalUiState("s").copy(visible = true, loaded = true, objective = "Verify mobile goals", status = "active", tokensUsed = 1200)) }
            OpenBitFunTheme(dark = dark) {
                ThreadGoalPanel(state, "s", true) { intent ->
                    val goal = intent as RemoteSessionIntent.Goal
                    actions += goal.action
                    if (goal.action == ThreadGoalAction.PAUSE) state = state.copy(status = "paused")
                    if (goal.action == ThreadGoalAction.RESUME) state = state.copy(status = "active")
                }
            }
        }
        compose.onNodeWithText(context.getString(R.string.goal_pause)).performClick()
        compose.onAllNodesWithText(context.getString(R.string.goal_paused)).onLast().assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.goal_resume)).performClick()
        compose.onAllNodesWithText(context.getString(R.string.goal_active)).onLast().assertIsDisplayed()
        assertEquals(listOf(ThreadGoalAction.PAUSE, ThreadGoalAction.RESUME), actions.filter { it != ThreadGoalAction.READ })
        compose.waitForIdle()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            File(context.cacheDir, "goal-${if (dark) "dark" else "light"}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
    @Test fun editCancelPreservesHostGoalAndCloseKeepsStrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val actions = mutableListOf<ThreadGoalAction>()
        var state by mutableStateOf(ThreadGoalUiState("s").copy(visible = true, loaded = true,
            objective = "Keep typing", status = "active"))
        compose.setContent { OpenBitFunTheme(dark = false) {
            ThreadGoalPanel(state, "s", true) {
                val action = (it as RemoteSessionIntent.Goal).action
                actions += action
                if (action == ThreadGoalAction.CLOSE) state = state.copy(visible = false)
            }
        } }
        compose.onNodeWithText(context.getString(R.string.goal_modify)).performClick()
        compose.runOnIdle { state = state.copy(busy = true) }
        compose.onNode(hasSetTextAction()).assertIsEnabled().performTextReplacement("Unsaved draft")
        compose.runOnIdle { state = state.copy(busy = false) }
        compose.onNodeWithText(context.getString(R.string.goal_cancel)).performClick()
        compose.onNodeWithText("Unsaved draft").assertDoesNotExist()
        compose.onNodeWithText(context.getString(R.string.goal_close)).performClick()
        compose.onNodeWithText("Keep typing").assertIsDisplayed()
        assertEquals(false, actions.contains(ThreadGoalAction.EDIT))
    }
    @Test fun clearingRequiresConfirmation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val actions = mutableListOf<ThreadGoalAction>()
        compose.setContent { OpenBitFunTheme(dark = false) {
            ThreadGoalPanel(ThreadGoalUiState("s").copy(visible = true, loaded = true,
                objective = "Keep this goal", status = "active"), "s", true) {
                actions += (it as RemoteSessionIntent.Goal).action
            }
        } }
        compose.onNodeWithText(context.getString(R.string.goal_clear)).performClick()
        assertEquals(false, actions.contains(ThreadGoalAction.CLEAR))
        compose.onNodeWithText(context.getString(R.string.goal_clearhint)).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.goal_clear)).performClick()
        assertEquals(true, actions.contains(ThreadGoalAction.CLEAR))
    }
    @Test fun creatingGoalReturnsToComposerStrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var state by mutableStateOf(ThreadGoalUiState("s").copy(visible = true, loaded = true))
        compose.setContent { OpenBitFunTheme(dark = false) {
            ThreadGoalPanel(state, "s", true) {
                val goal = it as RemoteSessionIntent.Goal
                if (goal.action == ThreadGoalAction.START) state = state.copy(objective = goal.objective, status = "active")
                if (goal.action == ThreadGoalAction.CLOSE) state = state.copy(visible = false)
            }
        } }
        compose.onNode(hasSetTextAction()).performTextReplacement("Ship the aligned UI")
        compose.onAllNodesWithText(context.getString(R.string.goal_set)).onLast().performClick()
        compose.onNodeWithText("Ship the aligned UI").assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.goal_close)).assertDoesNotExist()
    }
    @Test fun unsupportedHostExplainsWhyWithoutOfferingMutations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        compose.setContent { OpenBitFunTheme(dark = false) {
            ThreadGoalPanel(ThreadGoalUiState("s").copy(visible = true, failure = ThreadGoalFailure.UNSUPPORTED), "s", true) {}
        } }
        compose.onNodeWithText(context.getString(R.string.goal_unsupported)).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.goal_start)).assertDoesNotExist()
    }
}
