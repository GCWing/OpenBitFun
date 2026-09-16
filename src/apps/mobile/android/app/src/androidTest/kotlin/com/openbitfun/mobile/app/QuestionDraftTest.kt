package com.openbitfun.mobile.app

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.ui.chat.PermissionMailboxView
import com.openbitfun.mobile.core.feature.session.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.chat.tool.ToolQuestionAnswerPanel
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class QuestionDraftTest {
    @get:Rule val compose = createComposeRule()

    @Test fun mailboxOwnsTheOnlyAnswerFormWhileTranscriptKeepsItsSummary() {
        val question = ToolCard("question", "AskUserQuestion", ToolPhase.RUNNING,
            ToolKind.QUESTION, ToolOperation.UNKNOWN, "", "", "", "", "", "One answer only", setOf(ToolAction.ANSWER))
        val mailbox = mutableStateOf(PermissionMailboxUiState(emptyList(), false, false, listOf(question)))
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                androidx.compose.runtime.CompositionLocalProvider(
                    com.openbitfun.mobile.app.ui.chat.tool.LocalPermissionMailbox provides mailbox.value,
                ) {
                    androidx.compose.foundation.layout.Column {
                        PermissionMailboxView(mailbox.value, "session", 400.dp) {}
                        com.openbitfun.mobile.app.ui.chat.tool.ToolStatusList(
                            listOf(question), true, { _, _ -> }, { _, _ -> }, { _, _ -> },
                            { _, _ -> }, { _, _ -> }, { _, _ -> }, androidx.compose.ui.Modifier,
                        )
                    }
                }
            }
        }
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        compose.onNodeWithTag(com.openbitfun.mobile.app.ui.chat.tool.TOOL_ROW_TEST_TAG).assertExists()
        compose.onNode(hasSetTextAction()).performTextReplacement("Single draft")
        compose.onNodeWithText("One answer only").assertExists()
        compose.runOnIdle { mailbox.value = mailbox.value.copy(questions = emptyList(), ownedToolIds = setOf(question.id)) }
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        compose.onNodeWithTag(com.openbitfun.mobile.app.ui.chat.tool.TOOL_ROW_TEST_TAG).assertExists()
        // No mailbox authority on a legacy peer: its transcript still provides the answer UI.
        compose.runOnIdle { mailbox.value = PermissionMailboxUiState(emptyList(), false, false) }
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(1)
    }

    @Test fun removingAnEarlierMailboxQuestionPreservesTheRemainingDraft() {
        fun question(id: String) = ToolCard(id, "AskUserQuestion", ToolPhase.RUNNING,
            ToolKind.QUESTION, ToolOperation.UNKNOWN, "", "", "", "", "", "Question $id", setOf(ToolAction.ANSWER))
        val questions = mutableStateOf(listOf(question("first"), question("second")))
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                PermissionMailboxView(PermissionMailboxUiState(emptyList(), false, false, questions.value), "session", 700.dp) {}
            }
        }
        compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("Second question draft")
        compose.runOnIdle { questions.value = questions.value.drop(1) }
        compose.onNode(hasSetTextAction()).assertTextContains("Second question draft")
        compose.onNodeWithText("Question first").assertDoesNotExist()
    }

    @Test fun answerSurvivesPendingAndFailedSubmissionButNewQuestionStartsEmpty() {
        val question = mutableStateOf("question-1")
        val enabled = mutableStateOf(true)
        val answers = mutableListOf<String>()
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                ToolQuestionAnswerPanel(question.value, "Explain the change", enabled.value) {
                    answers += it
                    enabled.value = false
                }
            }
        }
        val label = InstrumentationRegistry.getInstrumentation().targetContext.getString(R.string.tool_answer_send)
        compose.onNode(hasSetTextAction()).performTextReplacement("Keep this draft")
        compose.onNodeWithText(label).performClick()
        compose.onNodeWithText("Keep this draft").assertIsNotEnabled()
        compose.runOnIdle { enabled.value = true }
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this draft")
        compose.onNodeWithText(label).performClick()
        compose.runOnIdle {
            assertEquals(listOf("Keep this draft", "Keep this draft"), answers)
            question.value = "question-2"
            enabled.value = true
        }
        compose.onNode(hasSetTextAction()).assertTextContains("")
        compose.onNodeWithText(label).assertIsNotEnabled()
    }
}
