package com.openbitfun.mobile.app

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.openbitfun.mobile.app.ui.chat.tool.ToolConfirmationPanel
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import org.junit.Rule
import org.junit.Test

class ToolConfirmationPanelTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun approvalShowsVerdictButtonsWithoutEditableInput() {
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ToolConfirmationPanel(
                    input = "",
                    canApprove = true,
                    canReject = true,
                    enabled = true,
                    onApprove = {},
                    onReject = {},
                )
            }
        }

        composeRule.onNodeWithText(testString(R.string.tool_approve)).assertIsDisplayed()
        composeRule.onNodeWithText(testString(R.string.tool_reject)).assertIsDisplayed()
        composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
    }
    @Test
    fun invalidEditedInputDisablesApprovalButKeepsRejectionAvailable() {
        var rejected = 0
        var approved = 0
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ToolConfirmationPanel(canApprove = true, canReject = true, enabled = true, input = "{}",
                    onApprove = { approved++ }, onReject = { rejected++ })
            }
        }
        composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        composeRule.onNodeWithText(testString(R.string.tool_edit_approval_input)).performClick()
        composeRule.onNode(hasSetTextAction()).performTextReplacement("invalid")
        composeRule.onNodeWithText(testString(R.string.tool_approve)).assertIsNotEnabled()
        composeRule.onNodeWithText(testString(R.string.tool_reject)).performClick()
        composeRule.runOnIdle { assertEquals(1, rejected); assertEquals(0, approved) }
        composeRule.onNodeWithText(testString(R.string.tool_hide_approval_input)).performClick()
        composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
    }

}
