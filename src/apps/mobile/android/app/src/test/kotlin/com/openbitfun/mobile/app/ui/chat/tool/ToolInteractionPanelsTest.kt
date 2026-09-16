package com.openbitfun.mobile.app.ui.chat.tool

import com.openbitfun.mobile.core.feature.session.QuestionAnswerValue
import com.openbitfun.mobile.core.feature.session.QuestionOption
import com.openbitfun.mobile.core.feature.session.ToolApprovalEditContract
import com.openbitfun.mobile.core.feature.session.ToolApprovalEditSupport
import com.openbitfun.mobile.core.feature.session.ToolQuestion
import org.junit.Assert.assertEquals
import org.junit.Test

class ToolInteractionPanelsTest {
    @Test
    fun approvalEditSupportMatchesRuntimeUpdatedInputContract() {
        assertEquals(ToolApprovalEditSupport.SUPPORTED, ToolApprovalEditContract.support)
    }

    private val questions = listOf(
        ToolQuestion(0, "", "Pick one", listOf(QuestionOption("A", null), QuestionOption("B", null)), false),
        ToolQuestion(1, "", "Pick many", listOf(QuestionOption("X", null)), true),
    )

    @Test
    fun buildStructuredAnswers_mapsSelectionsAndReplacesOther() {
        val answers = buildStructuredAnswers(
            questions = questions,
            selectedByIndex = mapOf(0 to setOf("B"), 1 to setOf("X", "Other")),
            customByIndex = mapOf(1 to "custom value"),
            otherLabel = "Other",
        )

        assertEquals(QuestionAnswerValue.Text("B"), answers[0].value)
        assertEquals(QuestionAnswerValue.Choice(listOf("X", "custom value")), answers[1].value)
    }

    @Test
    fun buildStructuredAnswers_recognizesWireOtherWithLocalizedOtherLabel() {
        val question = ToolQuestion(
            0,
            "",
            "Pick one",
            listOf(QuestionOption("Other", null)),
            false,
        )

        val answers = buildStructuredAnswers(
            questions = listOf(question),
            selectedByIndex = mapOf(0 to setOf("Other")),
            customByIndex = mapOf(0 to "custom value"),
            otherLabel = "其他",
        )

        assertEquals(QuestionAnswerValue.Text("custom value"), answers.single().value)
        val options = effectiveOptions(question, "其他")
        assertEquals(1, options.size)
        assertEquals(1, options.count { isOtherOption(it.label, "其他") })
    }

    @Test
    fun buildStructuredAnswers_recognizesChineseWireOtherWithEnglishOtherLabel() {
        val question = ToolQuestion(
            0,
            "",
            "Pick one",
            listOf(QuestionOption("其他", null)),
            false,
        )

        val answers = buildStructuredAnswers(
            questions = listOf(question),
            selectedByIndex = mapOf(0 to setOf("其他")),
            customByIndex = mapOf(0 to "custom value"),
            otherLabel = "Other",
        )

        assertEquals(QuestionAnswerValue.Text("custom value"), answers.single().value)
        val options = effectiveOptions(question, "Other")
        assertEquals(1, options.size)
        assertEquals(1, options.count { isOtherOption(it.label, "Other") })
    }

    @Test
    fun buildStructuredAnswers_keepsEmptyAnswersForUnselectedQuestions() {
        val answers = buildStructuredAnswers(questions, emptyMap(), emptyMap(), "Other")

        assertEquals(QuestionAnswerValue.Text(""), answers[0].value)
        assertEquals(QuestionAnswerValue.Choice(emptyList()), answers[1].value)
    }
}
