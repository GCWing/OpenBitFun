package com.openbitfun.mobile.app.ui.chat.tool

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.material3.Checkbox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.core.feature.session.QuestionAnswer
import com.openbitfun.mobile.core.feature.session.QuestionAnswerValue
import com.openbitfun.mobile.core.feature.session.QuestionOption
import com.openbitfun.mobile.core.feature.session.ToolQuestion

/** Compact approval actions; rejection remains available while JSON edits are invalid. */
@Composable
internal fun ToolConfirmationPanel(
    canApprove: Boolean,
    canReject: Boolean,
    enabled: Boolean,
    input: String,
    onApprove: (String?) -> Unit,
    onReject: () -> Unit,
) {
    var editing by rememberSaveable(input) { mutableStateOf(false) }
    var editedInput by rememberSaveable(input) { mutableStateOf(input.ifBlank { "{}" }) }
    val valid = !editing || runCatching { org.json.JSONObject(editedInput) }.isSuccess
    Column(verticalArrangement = Arrangement.spacedBy(MobileDesignGeometry.ApprovalCardGap)) {
        if (canApprove) {
            TextButton(onClick = { editing = !editing }, enabled = enabled) { Text(stringResource(if (editing) R.string.tool_hide_approval_input else R.string.tool_edit_approval_input)) }
            if (editing) OutlinedTextField(enabled = enabled, value = editedInput, onValueChange = { editedInput = it }, isError = !valid, label = { Text(stringResource(R.string.tool_input)) }, modifier = Modifier.fillMaxWidth())
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(MobileDesignGeometry.ApprovalCardGap, androidx.compose.ui.Alignment.End),
        ) {
            if (canReject) {
                Button(
                    onClick = onReject,
                    enabled = enabled,
                    shape = RoundedCornerShape(MobileDesignGeometry.ApprovalActionRadius),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        contentColor = MaterialTheme.colorScheme.onSurface),
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    modifier = Modifier.height(MobileDesignGeometry.ApprovalActionHeight),
                ) { Text(stringResource(R.string.tool_reject)) }
            }
            if (canApprove) {
                Button(
                    onClick = { if (valid) onApprove(if (editing) editedInput else null) },
                    enabled = enabled && valid,
                    shape = RoundedCornerShape(MobileDesignGeometry.ApprovalActionRadius),
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    modifier = Modifier.height(MobileDesignGeometry.ApprovalActionHeight),
                ) { Text(stringResource(R.string.tool_approve)) }
            }
        }
    }
}

/**
 * The agent's question and its answer box, ported from
 * `ToolQuestionAnswerPanel` in `pages/components/ToolInteractionPanels.ets`.
 *
 * Inline rather than the dialog this used to be. The turn does not move until
 * the question is answered, so the box belongs in the transcript beside the
 * question it answers — a dialog can be dismissed, which leaves the turn stuck
 * with nothing on screen saying why.
 */
@Composable
internal fun ToolQuestionAnswerPanel(
    toolId: String,
    prompt: String,
    enabled: Boolean,
    onSubmit: (String) -> Unit,
) {
    // Keyed on the tool: a new question is a new blank box, and the answer to
    // the one before it should not be sitting in it.
    var answer by remember(toolId) { mutableStateOf("") }
    val canSubmit = enabled && toolId.isNotEmpty() && answer.isNotBlank()

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(prompt, style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = answer,
            onValueChange = { answer = it },
            label = { Text(stringResource(R.string.tool_answer_label)) },
            // Multi-line, as the source's `TextArea` is: an answer to an agent is
            // prose, and the send action is the button rather than the return key.
            minLines = 3,
            maxLines = 6,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
        PillButton(
            label = stringResource(R.string.tool_answer_send),
            primary = true,
            enabled = canSubmit,
            compact = false,
            onClick = {
                onSubmit(answer.trim())
                // Keep the draft until the authoritative question leaves the UI.
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

internal fun isOtherOption(label: String, otherLabel: String): Boolean {
    val normalizedLabel = label.trim()
    return normalizedLabel.equals("other", ignoreCase = true) ||
        normalizedLabel.equals(otherLabel.trim(), ignoreCase = true) ||
        normalizedLabel == "其他"
}

internal fun effectiveOptions(
    question: ToolQuestion,
    otherLabel: String,
): List<QuestionOption> = question.options + if (
    question.options.none { isOtherOption(it.label, otherLabel) }
) {
    listOf(QuestionOption(otherLabel, null))
} else {
    emptyList()
}

internal fun buildStructuredAnswers(
    questions: List<ToolQuestion>,
    selectedByIndex: Map<Int, Set<String>>,
    customByIndex: Map<Int, String>,
    otherLabel: String,
): List<QuestionAnswer> = questions.map { question ->
    val selected = selectedByIndex[question.index].orEmpty()
    val custom = customByIndex[question.index].orEmpty().trim()
    val effectiveOptions = effectiveOptions(question, otherLabel)
    val values = effectiveOptions.map { it.label }.filter { it in selected }.map { label ->
        if (isOtherOption(label, otherLabel)) custom else label
    }
    if (question.multiSelect) {
        QuestionAnswer(question.index, QuestionAnswerValue.Choice(values))
    } else {
        QuestionAnswer(question.index, QuestionAnswerValue.Text(values.firstOrNull().orEmpty()))
    }
}

@Composable
internal fun ToolStructuredQuestionPanel(
    toolId: String,
    questions: List<ToolQuestion>,
    enabled: Boolean,
    onSubmit: (List<QuestionAnswer>) -> Unit,
) {
    val otherLabel = stringResource(R.string.tool_option_other)
    var selectedByIndex by remember(toolId) { mutableStateOf<Map<Int, Set<String>>>(emptyMap()) }
    var customByIndex by remember(toolId) { mutableStateOf<Map<Int, String>>(emptyMap()) }
    val answers = buildStructuredAnswers(questions, selectedByIndex, customByIndex, otherLabel)
    val canSubmit = enabled && toolId.isNotEmpty() && questions.all { question ->
        val selected = selectedByIndex[question.index].orEmpty()
        selected.isNotEmpty() && (!selected.any { isOtherOption(it, otherLabel) } || customByIndex[question.index].orEmpty().isNotBlank())
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        questions.forEach { question ->
            val selected = selectedByIndex[question.index].orEmpty()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (question.header.isNotBlank()) {
                    Text(question.header, style = MaterialTheme.typography.labelLarge)
                }
                Text(question.question, style = MaterialTheme.typography.bodyMedium)
                val options = effectiveOptions(question, otherLabel)
                options.forEach { option ->
                    val checked = option.label in selected
                    Column(
                        modifier = Modifier.fillMaxWidth().toggleable(
                            value = checked,
                            enabled = enabled,
                            role = if (question.multiSelect) androidx.compose.ui.semantics.Role.Checkbox else androidx.compose.ui.semantics.Role.RadioButton,
                            onValueChange = {
                                selectedByIndex = selectedByIndex.toMutableMap().apply {
                                    this[question.index] = if (question.multiSelect) {
                                        if (checked) selected - option.label else selected + option.label
                                    } else {
                                        setOf(option.label)
                                    }
                                }
                            },
                        ).padding(vertical = 2.dp),
                    ) {
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            if (question.multiSelect) Checkbox(checked, null, enabled = enabled)
                            else RadioButton(checked, null, enabled = enabled)
                            Text(option.label, style = MaterialTheme.typography.bodyMedium)
                        }
                        option.description?.takeIf(String::isNotBlank)?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 48.dp))
                        }
                    }
                    if (isOtherOption(option.label, otherLabel) && checked) {
                        OutlinedTextField(
                            value = customByIndex[question.index].orEmpty(),
                            onValueChange = { customByIndex = customByIndex + (question.index to it) },
                            label = { Text(stringResource(R.string.tool_answer_label)) },
                            enabled = enabled,
                            modifier = Modifier.fillMaxWidth().padding(start = 48.dp),
                        )
                    }
                }
            }
        }
        PillButton(
            label = stringResource(R.string.tool_answer_send),
            primary = true,
            enabled = canSubmit,
            compact = false,
            onClick = { onSubmit(answers) },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * The source draws every tool action as a 32-high rounded capsule, filled for
 * the affirmative one and outlined for the rest. This is that shape.
 *
 * [compact] is the one that rides inside a tool row rather than under it, so it
 * has to fit the row's own height instead of setting it.
 */
@Composable
internal fun PillButton(
    label: String,
    primary: Boolean,
    enabled: Boolean,
    compact: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(percent = 50)
    val padding = if (compact) {
        PaddingValues(horizontal = 12.dp, vertical = 0.dp)
    } else {
        ButtonDefaults.ContentPadding
    }
    val sized = modifier.heightIn(min = if (compact) 28.dp else 36.dp)
    val content: @Composable () -> Unit = {
        Text(
            label,
            style = if (compact) {
                MaterialTheme.typography.labelMedium
            } else {
                MaterialTheme.typography.labelLarge
            },
            maxLines = 1,
        )
    }
    if (primary) {
        Button(
            onClick = onClick,
            enabled = enabled,
            shape = shape,
            contentPadding = padding,
            modifier = sized,
        ) { content() }
    } else {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            shape = shape,
            contentPadding = padding,
            modifier = sized,
        ) { content() }
    }
}
