package com.openbitfun.mobile.app

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.chat.MessageQueuePanel
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.session.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class MessageQueuePanelTest {
    @get:Rule val rule = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun state(supports: Boolean = true) = MessageQueueUiState("s", true, supports, "e:1", listOf(
        QueuedMessageUiState("a", "First", 1, "queued", null),
        QueuedMessageUiState("b", "Second", 0, "queued", null),
        QueuedMessageUiState("c", "Third", 0, "queued", null),
    ), false, null)

    @Test fun compactMenuMovesUseStableMessageIdentityInBothThemes() {
        var dark by mutableStateOf(true)
        val intents = mutableListOf<RemoteSessionIntent>()
        rule.setContent { OpenBitFunTheme(dark = dark) { Box(Modifier.width(320.dp)) { MessageQueuePanel(state(), intents::add) } } }
        repeat(2) {
            rule.onAllNodesWithContentDescription(context.getString(R.string.queue_more))[0].performClick()
            rule.onNodeWithText(context.getString(R.string.queue_move_up)).assertIsNotEnabled()
            rule.onNodeWithText(context.getString(R.string.queue_move_down)).performClick()
            assertEquals(RemoteSessionIntent.MoveQueuedMessage("a", "c"), intents.last())
            rule.runOnIdle { dark = false }
        }
    }

    @Test fun longPressDragCommitsOnceAtRelease() {
        val intents = mutableListOf<RemoteSessionIntent>()
        rule.setContent { OpenBitFunTheme(dark = true) { Box(Modifier.width(320.dp)) { MessageQueuePanel(state(), intents::add) } } }
        val handles = rule.onAllNodesWithContentDescription(context.getString(R.string.queue_reorder))
        val offset = handles[0].fetchSemanticsNode().boundsInRoot.center.y - handles[2].fetchSemanticsNode().boundsInRoot.center.y - 10f
        handles[2].performTouchInput {
            down(center); advanceEventTime(650); moveBy(Offset(0f, offset), delayMillis = 120)
        }
        rule.runOnIdle { assertTrue(intents.isEmpty()) }
        handles[2].performTouchInput { up() }
        rule.runOnIdle { assertEquals(listOf(RemoteSessionIntent.MoveQueuedMessage("c", "a")), intents) }
    }

    @Test fun hostRevisionChangeCancelsAnActiveDragAndLegacyHostsHaveNoHandle() {
        var current by mutableStateOf(state())
        val intents = mutableListOf<RemoteSessionIntent>()
        rule.setContent { OpenBitFunTheme(dark = false) { MessageQueuePanel(current, intents::add) } }
        val handles = rule.onAllNodesWithContentDescription(context.getString(R.string.queue_reorder))
        handles[0].performTouchInput { down(center); advanceEventTime(650); moveBy(Offset(0f, 100f), delayMillis = 120) }
        rule.runOnIdle { current = current.copy(revisionKey = "e:2") }
        handles[0].performTouchInput { up() }
        rule.runOnIdle { assertTrue(intents.isEmpty()); current = current.copy(supportsReorder = false) }
        rule.onAllNodesWithContentDescription(context.getString(R.string.queue_reorder)).assertCountEquals(0)
        rule.onAllNodesWithContentDescription(context.getString(R.string.queue_more))[0].performClick()
        rule.onNodeWithText(context.getString(R.string.queue_unsupported)).assertExists()
        rule.onNodeWithText(context.getString(R.string.queue_move_down)).assertIsNotEnabled()
    }
}
