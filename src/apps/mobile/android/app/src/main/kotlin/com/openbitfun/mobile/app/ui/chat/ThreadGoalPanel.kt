package com.openbitfun.mobile.app.ui.chat

import androidx.compose.runtime.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.session.*

@Composable
internal fun ThreadGoalPanel(state: ThreadGoalUiState, sessionId: String, connected: Boolean, onIntent: (RemoteSessionIntent) -> Unit) {
    val current = state.takeIf { it.sessionId == sessionId } ?: ThreadGoalUiState(sessionId)
    fun action(value: ThreadGoalAction, objective: String? = null) = onIntent(RemoteSessionIntent.Goal(sessionId, value, objective))
    LaunchedEffect(sessionId, connected) { if (connected && sessionId.isNotEmpty()) action(ThreadGoalAction.READ) }
    var editing by remember(sessionId, current.visible) { mutableStateOf(false) }
    var clearing by remember(sessionId, current.visible) { mutableStateOf(false) }
    var saving by remember(sessionId) { mutableStateOf(false) }
    var objective by remember(sessionId, current.visible) { mutableStateOf("") }
    LaunchedEffect(current.busy, current.failure, saving) {
        if (saving && !current.busy) {
            if (current.failure == null) { editing = false; action(ThreadGoalAction.CLOSE) }
            saving = false
        }
    }
    val colors = MaterialTheme.colorScheme
    val status = stringResource(when (current.status) {
        "active" -> R.string.goal_active
        "paused" -> R.string.goal_paused
        "blocked" -> R.string.goal_blocked
        "usageLimited" -> R.string.goal_usagelimited
        "budgetLimited" -> R.string.goal_budgetlimited
        "complete" -> R.string.goal_complete
        else -> R.string.goal_unknown
    })
    if (current.objective != null) {
        Surface(onClick = { action(ThreadGoalAction.OPEN) }, color = colors.surfaceContainerLow, contentColor = colors.onSurface,
            shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (connected) status else stringResource(R.string.goal_offline), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                    Text(current.objective.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                }
                Text("›", style = MaterialTheme.typography.titleMedium, color = colors.onSurfaceVariant)
            }
        }
    }
    if (!current.visible) return
    val enabled = connected && !current.busy && current.loaded && current.failure == null
    Dialog(onDismissRequest = { action(ThreadGoalAction.CLOSE) }) {
        Surface(shape = RoundedCornerShape(20.dp), color = colors.surface, border = BorderStroke(1.dp, colors.outlineVariant)) {
            Column(Modifier.widthIn(max = 420.dp).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(when { clearing -> R.string.goal_cleartitle; editing -> R.string.goal_modify; current.objective == null -> R.string.goal_set; else -> R.string.goal_title }), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    TextButton(colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface), onClick = { action(ThreadGoalAction.CLOSE) }) { Text(stringResource(R.string.goal_close)) }
                }
                if (!connected) Text(stringResource(R.string.goal_offline), color = colors.onSurfaceVariant)
                if (current.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                current.failure?.let { failure ->
                    Text(stringResource(when (failure) {
                        ThreadGoalFailure.UNSUPPORTED -> R.string.goal_unsupported
                        ThreadGoalFailure.ATTACHMENTS -> R.string.goal_attachments
                        else -> R.string.goal_failed
                    }), color = colors.onSurfaceVariant)
                    TextButton(colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface), enabled = connected && !current.busy, onClick = { action(ThreadGoalAction.READ) }) { Text(stringResource(R.string.goal_retry)) }
                }
                if (current.loaded) {
                    when {
                        clearing -> {
                            Text(stringResource(R.string.goal_clearhint), style = MaterialTheme.typography.bodyMedium)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface), onClick = { clearing = false }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.goal_keep)) }
                                OutlinedButton(enabled = enabled, onClick = { saving = true; action(ThreadGoalAction.CLEAR) }, modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.error)) { Text(stringResource(R.string.goal_clear)) }
                            }
                        }
                        current.objective == null || editing -> {
                            Text(stringResource(R.string.goal_hint), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                            OutlinedTextField(value = objective, onValueChange = { objective = it }, label = { Text(stringResource(R.string.goal_description)) }, enabled = connected && !saving, minLines = 4, maxLines = 8, modifier = Modifier.fillMaxWidth())
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface), onClick = { if (current.objective != null) editing = false else action(ThreadGoalAction.CLOSE) }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.goal_cancel)) }
                                Button(colors = ButtonDefaults.buttonColors(containerColor = colors.onSurface, contentColor = colors.surface), enabled = enabled && objective.isNotBlank(), onClick = { saving = true; action(if (current.objective == null) ThreadGoalAction.START else ThreadGoalAction.EDIT, objective.trim()) }, modifier = Modifier.weight(1f)) { Text(stringResource(if (current.objective == null) R.string.goal_set else R.string.goal_save)) }
                            }
                        }
                        else -> {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Surface(shape = RoundedCornerShape(50), color = colors.surfaceContainerHigh) { Text(status, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) }
                                Spacer(Modifier.weight(1f))
                                Text(stringResource(R.string.goal_usage, current.tokensUsed), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                            }
                            GoalContentCard(stringResource(R.string.goal_description), current.objective.orEmpty())
                            GoalContentCard(stringResource(R.string.goal_workflow), if (current.status == "active") stringResource(R.string.goal_workflowhint) else if (current.status == "paused") stringResource(R.string.goal_pausedhint) else status)
                            HorizontalDivider(color = colors.outlineVariant)
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                OutlinedButton(colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface), enabled = enabled, onClick = { objective = current.objective.orEmpty(); editing = true }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.weight(1f)) { Text(stringResource(R.string.goal_modify)) }
                                if (current.status == "active" || current.canResume) OutlinedButton(colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface), enabled = enabled, onClick = { action(if (current.status == "active") ThreadGoalAction.PAUSE else ThreadGoalAction.RESUME) }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.weight(1f)) { Text(stringResource(if (current.status == "active") R.string.goal_pause else R.string.goal_resume)) }
                                OutlinedButton(enabled = enabled, onClick = { clearing = true }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.error)) { Text(stringResource(R.string.goal_clear)) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun GoalContentCard(label: String, content: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(content, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
