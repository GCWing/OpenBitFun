package com.openbitfun.mobile.app

import android.content.ClipboardManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.chat.ChatMessageBubble
import com.openbitfun.mobile.app.ui.chat.message.SUBAGENT_GROUP_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.message.TYPING_DOTS_TEST_TAG
import com.openbitfun.mobile.core.feature.session.ConversationRow
import com.openbitfun.mobile.core.feature.session.ConversationRowKind
import com.openbitfun.mobile.core.feature.session.MessageBlock
import com.openbitfun.mobile.core.feature.session.ToolCard
import com.openbitfun.mobile.core.feature.session.ToolKind
import com.openbitfun.mobile.core.feature.session.ToolOperation
import com.openbitfun.mobile.core.feature.session.ToolPhase
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * A turn as the agent produced it, ported from `ChatMessageBubble.ets`.
 *
 * What is worth pinning is the ordering: a turn that worked in steps has to read
 * as steps. The flat bubble this replaced put every tool below every paragraph,
 * so the agent appeared to have explained the whole job before touching any of
 * it — which is the one thing about the transcript that is not true.
 */
class ChatMessageBubbleTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun aTurnThatWorkedInStepsIsDrawnInSteps() {
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    blocks = listOf(
                        MessageBlock.Text("b1", "Checking the manifest.", false),
                        MessageBlock.Tools("b2", listOf(runningTool())),
                        MessageBlock.Text("b3", "It targets API 35.", false),
                    ),
                ),
            )
        }

        val first = composeRule.onNodeWithText("Checking the manifest.").getUnclippedBoundsInRoot()
        val tool = composeRule.onNodeWithText(testString(R.string.tool_line_running, "AndroidManifest.xml")).getUnclippedBoundsInRoot()
        val second = composeRule.onNodeWithText("It targets API 35.").getUnclippedBoundsInRoot()

        assertTrue(first.top < tool.top)
        assertTrue(tool.top < second.top)
    }

    @Test
    fun aSubagentsWorkIsBoxedApartFromTheAgentThatStartedIt() {
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    blocks = listOf(
                        MessageBlock.Subagent(
                            id = "b1",
                            title = "Audit the auth flow",
                            running = false,
                            text = "",
                            children = listOf(MessageBlock.Text("b1-1", "No leaks found.", false)),
                        ),
                    ),
                ),
            )
        }

        composeRule.onNodeWithTag(SUBAGENT_GROUP_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithText("Audit the auth flow").assertIsDisplayed()
        assertTrue(composeRule.onAllNodesWithText("No leaks found.").fetchSemanticsNodes().isEmpty())

        composeRule.onNodeWithText("Audit the auth flow").performClick()
        composeRule.onNodeWithText("No leaks found.").assertIsDisplayed()
    }

    @Test
    fun aRunningSubagentKeepsChildrenCollapsedUntilOpened() {
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    blocks = listOf(
                        MessageBlock.Subagent(
                            id = "running-subagent",
                            title = "Inspect the build",
                            running = true,
                            text = "Still working",
                            children = listOf(MessageBlock.Text("child", "Build step started.", false)),
                        ),
                    ),
                ),
            )
        }

        composeRule.onNodeWithText("Build step started.").assertDoesNotExist()
        composeRule.onNodeWithText("Inspect the build").performClick()
        composeRule.onNodeWithText("Build step started.").assertIsDisplayed()
    }

    @Test
    fun aCompletedSubagentCanBeExpandedAndCollapsed() {
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    blocks = listOf(
                        MessageBlock.Subagent(
                            id = "completed-subagent",
                            title = "Inspect the build",
                            running = false,
                            text = "Finished",
                            children = listOf(MessageBlock.Text("child", "Build step finished.", false)),
                        ),
                    ),
                ),
            )
        }

        assertTrue(composeRule.onAllNodesWithText("Build step finished.").fetchSemanticsNodes().isEmpty())
        composeRule.onNodeWithText("Inspect the build").performClick()
        composeRule.onNodeWithText("Build step finished.").assertIsDisplayed()
        composeRule.onNodeWithText("Inspect the build").performClick()
        assertTrue(composeRule.onAllNodesWithText("Build step finished.").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aRunningSubagentPreservesUserCollapseAcrossStreamUpdates() {
        var block by mutableStateOf(
            MessageBlock.Subagent(
                id = "streaming-subagent",
                title = "Inspect the build",
                running = true,
                text = "Working",
                children = listOf(MessageBlock.Text("child", "Initial step.", false)),
            ),
        )
        composeRule.setContent {
            Bubble(row(kind = ConversationRowKind.ASSISTANT, blocks = listOf(block)))
        }

        composeRule.onNodeWithText("Inspect the build").performClick()
        composeRule.onNodeWithText("Initial step.").assertIsDisplayed()
        composeRule.onNodeWithText("Inspect the build").performClick()
        assertTrue(composeRule.onAllNodesWithText("Initial step.").fetchSemanticsNodes().isEmpty())

        composeRule.runOnIdle {
            block = block.copy(
                text = "Still working",
                children = listOf(MessageBlock.Text("child-2", "Updated step.", false)),
            )
        }
        assertTrue(composeRule.onAllNodesWithText("Updated step.").fetchSemanticsNodes().isEmpty())

        composeRule.runOnIdle { block = block.copy(running = false) }
        assertTrue(composeRule.onAllNodesWithText("Updated step.").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aFailureSaysWhichHalfOfTheExchangeFailed() {
        composeRule.setContent {
            Bubble(row(kind = ConversationRowKind.ASSISTANT, text = "Half an ans", showRetry = true))
        }

        // The agent's reply started and stopped; it was never "not delivered".
        composeRule.onNodeWithText(testString(R.string.chat_reply_interrupted)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.account_devices_retry)).assertIsDisplayed()
    }

    @Test
    fun aMessageThatNeverLeftTheDeviceUsesTheSendFailureCopy() {
        composeRule.setContent {
            Bubble(row(kind = ConversationRowKind.USER, text = "ship it", showRetry = true))
        }

        composeRule.onNodeWithText(string(R.string.chat_send_failed)).assertIsDisplayed()
    }

    @Test
    fun theWaitingDotsStandInForTheFirstTokenAndNothingMore() {
        // The dots never settle, so the clock is driven by hand rather than
        // waiting for an idle that will not come.
        composeRule.mainClock.autoAdvance = false

        composeRule.setContent {
            Bubble(row(kind = ConversationRowKind.ASSISTANT, streaming = true, typing = true))
        }

        composeRule.onNodeWithTag(TYPING_DOTS_TEST_TAG).assertIsDisplayed()
    }

    @Test
    fun onceTheAnswerStartsTheDotsAreGone() {
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    text = "Working on it",
                    streaming = true,
                    typing = false,
                ),
            )
        }

        composeRule.onNodeWithTag(TYPING_DOTS_TEST_TAG).assertDoesNotExist()
        composeRule.waitUntil(timeoutMillis = 3_000L) {
            composeRule.onAllNodesWithText("Working on it").fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText("Working on it").assertIsDisplayed()
    }

    @androidx.compose.runtime.Composable
    private fun Bubble(row: ConversationRow) {
        ChatMessageBubble(
            row = row,
            enabled = true,
            onApproveTool = { _, _ -> },
            onRejectTool = { _, _ -> },
            onCancelTool = { _, _ -> },
            onAnswerTool = { _, _ -> },
            onAnswerToolStructured = { _, _ -> },
            onRetry = {},
            onOpenLink = { _, _ -> },
            previewingRemotePath = "",
            previewLoading = false,
            modifier = Modifier,
        )
    }

    private fun row(
        kind: ConversationRowKind,
        text: String = "",
        blocks: List<MessageBlock> = emptyList(),
        streaming: Boolean = false,
        typing: Boolean = false,
        showRetry: Boolean = false,
    ) = ConversationRow(
        id = "row-1",
        kind = kind,
        text = text,
        thinking = null,
        images = emptyList(),
        tools = emptyList(),
        blocks = blocks,
        streaming = streaming,
        pending = false,
        typing = typing,
        showRetry = showRetry,
        error = null,
        live = false,
    )

    private fun runningTool(): ToolCard = ToolCard(
        id = "tool-1",
        name = "Read",
        phase = ToolPhase.RUNNING,
        kind = ToolKind.DOCUMENT,
        operation = ToolOperation.READ_FILE,
        target = "AndroidManifest.xml",
        filePath = "",
        fileLabel = "",
        input = "",
        output = "",
        question = null,
        actions = emptySet(),
    )

    private fun string(resource: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)

    @Test
    fun thinkingCollapseSurvivesStreamedTokenUpdates() {
        var block by mutableStateOf(MessageBlock.Thinking("stable-thinking", "Initial reasoning", true))

        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    blocks = listOf(block),
                ).copy(id = "thinking-row"),
            )
        }

        composeRule.onNodeWithText("Initial reasoning").assertIsDisplayed()
        composeRule.onNodeWithText(string(R.string.chat_thinking_in_progress)).performClick()
        assertTrue(composeRule.onAllNodesWithText("Initial reasoning").fetchSemanticsNodes().isEmpty())

        composeRule.runOnIdle {
            block = MessageBlock.Thinking("stable-thinking", "Initial reasoning with more streamed tokens", true)
        }
        assertTrue(
            composeRule.onAllNodesWithText("Initial reasoning with more streamed tokens")
                .fetchSemanticsNodes()
                .isEmpty(),
        )

        composeRule.runOnIdle {
            block = MessageBlock.Thinking("stable-thinking", "Initial reasoning with more streamed tokens", false)
        }
        assertTrue(
            composeRule.onAllNodesWithText("Initial reasoning with more streamed tokens")
                .fetchSemanticsNodes()
                .isEmpty(),
        )
    }

    @Test
    fun streamingCodeBlockCopyCopiesTheFullText() {
        val fullCode = "```\necho full-command\n```"
        composeRule.setContent {
            Bubble(
                row(
                    kind = ConversationRowKind.ASSISTANT,
                    text = fullCode,
                    streaming = true,
                ).copy(id = "streaming-copy-row"),
            )
        }

        val copyLabel = string(R.string.chat_copy)
        composeRule.waitUntil(timeoutMillis = 3_000L) {
            composeRule.onAllNodesWithText(copyLabel).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithText(copyLabel).performClick()
        composeRule.waitUntil(timeoutMillis = 3_000L) {
            val clipboard = InstrumentationRegistry.getInstrumentation().targetContext
                .getSystemService(ClipboardManager::class.java)
            clipboard.primaryClip?.getItemAt(0)?.text?.toString() == fullCode
        }
        val clipboard = InstrumentationRegistry.getInstrumentation().targetContext
            .getSystemService(ClipboardManager::class.java)
        assertTrue(clipboard.primaryClip?.getItemAt(0)?.text?.toString() == fullCode)
    }

    @Test
    fun streamingTextShowsEachDeltaImmediately() {
        var currentRow by mutableStateOf(
            row(kind = ConversationRowKind.ASSISTANT, text = "first.", streaming = true),
        )
        composeRule.setContent { Bubble(currentRow) }
        composeRule.onNodeWithText("first.").assertIsDisplayed()

        composeRule.runOnIdle { currentRow = currentRow.copy(text = "first. second.") }
        composeRule.onNodeWithText("first. second.").assertIsDisplayed()

        composeRule.runOnIdle { currentRow = currentRow.copy(text = "first. second. third.") }
        composeRule.onNodeWithText("first. second. third.").assertIsDisplayed()
    }

    @Test
    fun streamingTextRewriteShowsTheNewTextWithoutBlanking() {
        var currentRow by mutableStateOf(
            row(kind = ConversationRowKind.ASSISTANT, text = "old response.", streaming = true),
        )
        composeRule.setContent { Bubble(currentRow) }
        composeRule.onNodeWithText("old response.").assertIsDisplayed()

        composeRule.runOnIdle { currentRow = currentRow.copy(text = "new response.") }
        composeRule.onNodeWithText("new response.").assertIsDisplayed()
        assertTrue(composeRule.onAllNodesWithText("old response.").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun streamingToCompleteShowsTheFullTextWithoutAnEndJump() {
        var currentRow by mutableStateOf(
            row(kind = ConversationRowKind.ASSISTANT, text = "A complete answer.", streaming = true),
        )
        composeRule.setContent { Bubble(currentRow) }
        composeRule.onNodeWithText("A complete answer.").assertIsDisplayed()

        composeRule.runOnIdle { currentRow = currentRow.copy(streaming = false) }
        composeRule.onNodeWithText("A complete answer.").assertIsDisplayed()
    }

}
