package com.openbitfun.mobile.app.ui.chat.tool

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.session.ToolAction
import com.openbitfun.mobile.core.feature.session.ToolCard
import com.openbitfun.mobile.core.feature.session.QuestionAnswer
import com.openbitfun.mobile.core.feature.session.ToolOperation
import com.openbitfun.mobile.core.feature.session.ToolPhase
import com.openbitfun.mobile.core.feature.session.ToolRow
import com.openbitfun.mobile.core.feature.session.collapseToolRows
import com.openbitfun.mobile.app.ui.theme.openBitFunColors

/** Anything the desktop must be told about a rejection needs a reason; this is ours. */
internal data class PlanActions(
    val supported: Boolean = false,
    val enabled: Boolean = false,
    val build: (com.openbitfun.mobile.core.feature.session.PlanToolDescriptor) -> Unit = {},
)
internal val LocalPlanActions = androidx.compose.runtime.staticCompositionLocalOf { PlanActions() }

internal class ToolDisclosure(selectedState: MutableState<String?>) {
    var selected by selectedState
}
internal val LocalToolDisclosure = staticCompositionLocalOf<ToolDisclosure?> { null }
internal val LocalPermissionMailbox = staticCompositionLocalOf<com.openbitfun.mobile.core.feature.session.PermissionMailboxUiState?> { null }

private const val REJECT_REASON = "Rejected from the Android client"
private const val CANCEL_REASON = "Cancelled from the Android client"

internal const val TOOL_ROW_TEST_TAG: String = "tool-row"
internal const val TOOL_GROUP_TEST_TAG: String = "tool-group"
internal const val TOOL_EXPAND_TEST_TAG: String = "tool-expand"

/** The indent that lines a row's detail up under its label rather than its icon. */
private val DETAIL_INDENT = 28.dp

/**
 * The tools a turn ran, ported from `pages/components/ToolStatusList.ets`.
 *
 * A line each, not a card each: a turn can run a dozen tools, and a dozen filled
 * boxes between two paragraphs is a wall rather than a trace. Weight is spent
 * only where something is unresolved — a failure, or a tool that cannot go on
 * until the user answers it — and consecutive finished lookups fold into one
 * line, because six `Read`s in a row say the same thing six times.
 */
@Composable
internal fun ToolStatusList(
    tools: List<ToolCard>,
    enabled: Boolean,
    onApprove: (String, String?) -> Unit,
    onReject: (String, String) -> Unit,
    onCancel: (String, String) -> Unit,
    onAnswer: (String, String) -> Unit,
    onAnswerStructured: (String, List<QuestionAnswer>) -> Unit,
    onOpenFile: (String, String) -> Unit,
    modifier: Modifier,
) {
    val rows = remember(tools) { collapseToolRows(tools) }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        rows.forEach { row ->
            when (row) {
                is ToolRow.Single -> ToolStatusRow(
                    tool = row.tool,
                    enabled = enabled,
                    onApprove = { input -> onApprove(row.tool.id, input) },
                    onReject = { reason -> onReject(row.tool.id, reason) },
                    onCancel = { reason -> onCancel(row.tool.id, reason) },
                    onAnswer = { answer -> onAnswer(row.tool.id, answer) },
                    onAnswerStructured = { answers -> onAnswerStructured(row.tool.id, answers) },
                    onOpenFile = onOpenFile,
                    modifier = Modifier,
                )

                is ToolRow.Collapsed -> CollapsedToolGroup(
                    group = row,
                    enabled = enabled,
                    onOpenFile = onOpenFile,
                    modifier = Modifier,
                )
            }
        }
    }
}

/**
 * Several finished lookups behind one line, opened by tapping it.
 *
 * Expanding keeps the summary on screen above the tools it stands for, so the
 * column does not appear to grow out of nothing.
 */
@Composable
private fun CollapsedToolGroup(
    group: ToolRow.Collapsed,
    enabled: Boolean,
    onOpenFile: (String, String) -> Unit,
    modifier: Modifier,
) {
    var expanded by remember(group.id) { mutableStateOf(false) }
    Column(
        modifier = modifier.fillMaxWidth().testTag(TOOL_GROUP_TEST_TAG),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 28.dp).clickable { expanded = !expanded },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ToolSummaryIcon(group.readCount, group.searchCount, Modifier)
            Text(
                stringResource(R.string.tool_group_summary, group.tools.size),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Chevron(
                if (expanded) {
                    R.drawable.ic_symbol_chevron_up
                } else {
                    R.drawable.ic_symbol_chevron_down
                },
            )
        }
        if (expanded) {
            group.tools.forEach { tool ->
                ToolStatusRow(
                    tool = tool,
                    enabled = enabled,
                    // Nothing in a folded group is still actionable; that is what
                    // made it foldable.
                    onApprove = {},
                    onReject = {},
                    onCancel = {},
                    onAnswer = {},
                    onAnswerStructured = {},
                    onOpenFile = onOpenFile,
                    modifier = Modifier,
                )
            }
        }
    }
}

/**
 * One tool, ported from `ToolRow` in `pages/components/ToolStatusList.ets`.
 *
 * The label is the whole row when nothing is pending: a line naming what was
 * done and to what. It becomes a link when the tool worked on a file, because
 * the file is what the user would go looking for next.
 */
@Composable
internal fun ToolStatusRow(
    tool: ToolCard,
    enabled: Boolean,
    onApprove: (String?) -> Unit,
    onReject: (String) -> Unit,
    onCancel: (String) -> Unit,
    onAnswer: (String) -> Unit,
    onAnswerStructured: (List<QuestionAnswer>) -> Unit,
    onOpenFile: (String, String) -> Unit,
    modifier: Modifier,
) {
    val plan = tool.plan
    if (plan != null) {
        val actions = LocalPlanActions.current
        Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(plan.name.ifBlank { stringResource(R.string.plan_title) }, style = MaterialTheme.typography.titleSmall)
            if (plan.overview.isNotBlank()) Text(plan.overview, style = MaterialTheme.typography.bodySmall)
            androidx.compose.material3.TextButton(onClick = { onOpenFile(plan.path, plan.name) }, enabled = enabled && plan.path.isNotBlank()) {
                Text(stringResource(R.string.plan_view))
            }
            androidx.compose.material3.Button(onClick = { actions.build(plan) }, enabled = actions.supported && actions.enabled && tool.phase == ToolPhase.COMPLETED && plan.path.isNotBlank()) {
                Text(stringResource(R.string.plan_build))
            }
            if (!actions.supported) Text(stringResource(R.string.plan_unsupported), style = MaterialTheme.typography.bodySmall)
            else if (!actions.enabled) Text(stringResource(R.string.plan_wait), style = MaterialTheme.typography.bodySmall)
        }
        return
    }
    var localExpanded by rememberSaveable(tool.id) { mutableStateOf(false) }
    val disclosure = LocalToolDisclosure.current
    val expanded = disclosure?.let { it.selected == tool.id } ?: localExpanded
    val toggle = {
        if (disclosure == null) localExpanded = !localExpanded
        else disclosure.selected = if (expanded) null else tool.id
    }
    val transcriptActions = if (LocalPermissionMailbox.current?.ownsToolInteraction(tool.id) == true) {
        tool.actions - setOf(ToolAction.ANSWER, ToolAction.APPROVE, ToolAction.REJECT) -
            (if (ToolAction.ANSWER in tool.actions) setOf(ToolAction.CANCEL) else emptySet())
    } else tool.actions
    val blocking = transcriptActions.isNotEmpty()
    val emphasized = expanded || blocking || tool.phase == ToolPhase.FAILED
    val canExpand = tool.expandable
    val openable = tool.filePath.isNotEmpty()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .testTag(TOOL_ROW_TEST_TAG)
            .background(
                color = if (emphasized) {
                    MaterialTheme.colorScheme.surfaceVariant
                } else {
                    openBitFunColors.transparent
                },
                shape = RoundedCornerShape(if (emphasized) 14.dp else 8.dp),
            )
            .border(
                width = if (emphasized) 1.dp else 0.dp,
                color = if (emphasized) MaterialTheme.colorScheme.outlineVariant else openBitFunColors.transparent,
                shape = RoundedCornerShape(if (emphasized) 14.dp else 8.dp),
            )
            .padding(
                horizontal = if (emphasized) 10.dp else 0.dp,
                vertical = if (emphasized) 6.dp else 0.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 28.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ToolStatusIcon(tool, Modifier)
            Text(
                toolLineLabel(tool),
                style = MaterialTheme.typography.bodySmall,
                color = when {
                    tool.phase == ToolPhase.FAILED -> MaterialTheme.colorScheme.error
                    openable -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .clickable(enabled = openable || canExpand) {
                        if (openable) {
                            onOpenFile(tool.filePath, tool.fileLabel)
                        } else {
                            toggle()
                        }
                    },
            )
            if (canExpand) {
                Box(
                    modifier = Modifier
                        .size(width = 32.dp, height = 28.dp)
                        .testTag(TOOL_EXPAND_TEST_TAG)
                        .clickable { toggle() },
                    contentAlignment = Alignment.Center,
                ) {
                    Chevron(
                        if (expanded) {
                            R.drawable.ic_symbol_chevron_down
                        } else {
                            R.drawable.ic_symbol_chevron_right
                        },
                    )
                }
            }
        }

        if (expanded) {
            if (tool.input.isNotEmpty()) {
                ToolDetail(stringResource(R.string.tool_input), tool.input, false)
            }
            if (tool.output.isNotEmpty()) {
                val failed = tool.phase == ToolPhase.FAILED
                ToolDetail(
                    stringResource(if (failed) R.string.tool_error else R.string.tool_output),
                    tool.output,
                    failed,
                )
            }
        }

        if (ToolAction.APPROVE in transcriptActions || ToolAction.REJECT in transcriptActions) {
            ToolConfirmationPanel(
                input = tool.input,
                canApprove = ToolAction.APPROVE in transcriptActions,
                canReject = ToolAction.REJECT in transcriptActions,
                enabled = enabled,
                onApprove = onApprove,
                onReject = { onReject(REJECT_REASON) },
            )
        }

        if (ToolAction.ANSWER in transcriptActions) {
            if (tool.questions.isNotEmpty()) {
                ToolStructuredQuestionPanel(
                    toolId = tool.id,
                    questions = tool.questions,
                    enabled = enabled,
                    onSubmit = onAnswerStructured,
                )
            } else {
                ToolQuestionAnswerPanel(
                    toolId = tool.id,
                    // The agent did not always send a prompt to quote, so we ask in ours.
                    prompt = tool.question ?: stringResource(R.string.tool_question_default),
                    enabled = enabled,
                    onSubmit = onAnswer,
                )
            }
        }

        if (ToolAction.CANCEL in transcriptActions) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = DETAIL_INDENT),
                horizontalArrangement = Arrangement.End,
            ) {
                PillButton(
                    label = stringResource(R.string.tool_cancel),
                    primary = false,
                    enabled = enabled,
                    compact = true,
                    onClick = { onCancel(CANCEL_REASON) },
                    modifier = Modifier,
                )
            }
        }
    }
}

/**
 * The row's one line, ported from `toolLineLabel`.
 *
 * What it leads with is what the reader wants first, and that changes with the
 * state: a running tool leads with the thing it is working on, a failed one with
 * the failure, and anything waiting on the user with the fact that it is.
 */
@Composable
private fun toolLineLabel(tool: ToolCard): String {
    val operation = operationLabel(tool)
    val target = tool.target
    return when {
        tool.phase == ToolPhase.RUNNING ->
            stringResource(R.string.tool_line_running, target.ifEmpty { operation })

        tool.phase == ToolPhase.FAILED ->
            join(stringResource(R.string.tool_line_failed, operation), target)

        tool.phase == ToolPhase.PENDING_CONFIRMATION || ToolAction.ANSWER in tool.actions ->
            join(stringResource(R.string.tool_phase_pending), operation)

        tool.phase == ToolPhase.WAITING -> join(stringResource(R.string.tool_phase_waiting), operation)
        else -> join(operation, target)
    }
}

@Composable
private fun join(head: String, tail: String): String =
    if (tail.isEmpty()) head else stringResource(R.string.tool_line_target, head, tail)

/** What the tool is doing, or its own name when this client cannot tell. */
@Composable
private fun operationLabel(tool: ToolCard): String {
    val label = when (tool.operation) {
        ToolOperation.UPDATE_TODOS -> R.string.tool_op_update_todos
        ToolOperation.START_TASK -> R.string.tool_op_start_task
        ToolOperation.READ_FILE -> R.string.tool_op_read_file
        ToolOperation.WRITE_FILE -> R.string.tool_op_write_file
        ToolOperation.DELETE_FILE -> R.string.tool_op_delete_file
        ToolOperation.VIEW_DIFF -> R.string.tool_op_view_diff
        ToolOperation.EDIT_FILE -> R.string.tool_op_edit_file
        ToolOperation.RUN_COMMAND -> R.string.tool_op_run_command
        ToolOperation.SEARCH_WEB -> R.string.tool_op_search_web
        ToolOperation.OPEN_WEB -> R.string.tool_op_open_web
        ToolOperation.SEARCH_CODE -> R.string.tool_op_search_code
        ToolOperation.ASK_CONFIRMATION -> R.string.tool_op_ask_confirmation
        ToolOperation.UNKNOWN -> null
    }
    return label?.let { stringResource(it) } ?: tool.name.ifBlank { stringResource(R.string.tool_unknown) }
}

@Composable
private fun Chevron(@DrawableRes icon: Int) {
    Icon(
        painter = painterResource(icon),
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(14.dp),
    )
}

@Composable
private fun ToolDetail(label: String, body: String, isError: Boolean) {
    Column(modifier = Modifier.fillMaxWidth().padding(start = DETAIL_INDENT)) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = if (isError) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            // Capped the way the source caps it: a tool that printed a file
            // should not push the answer the user is reading off the screen.
            maxLines = 5,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
