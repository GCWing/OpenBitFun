package com.openbitfun.mobile.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.state.SessionViewSettings
import com.openbitfun.mobile.core.feature.session.SessionAgentGroup
import com.openbitfun.mobile.core.feature.session.SessionGroupMode
import com.openbitfun.mobile.core.feature.session.SessionListPresentation
import com.openbitfun.mobile.core.feature.session.SessionStatusLabel
import com.openbitfun.mobile.core.feature.session.SessionWorkspaceOption

internal const val VIEW_SETTINGS_TEST_TAG: String = "session-view-settings"

/** The sheet's own header repeats its name, so the button that opens it is tagged. */
internal const val VIEW_SETTINGS_TOGGLE_TEST_TAG: String = "session-view-settings-toggle"

/**
 * The view-settings sheet, ported from `pages/components/ConversationViewSettings.ets`.
 *
 * The option lists are passed in rather than derived here: they come from
 * [com.openbitfun.mobile.core.feature.session.SessionListPresentation], which reads
 * them off the same sessions the list is drawing, so a filter can never offer a
 * value that would empty the list.
 *
 * It does not scroll: it is inlined above the list inside a column the caller
 * already scrolls, and a second scroller in the same direction has no height to
 * measure against.
 */
@Composable
internal fun SessionViewSettingsSheet(
    settings: SessionViewSettings,
    workspaces: List<SessionWorkspaceOption>,
    agentGroups: List<SessionAgentGroup>,
    statuses: List<String>,
    onChange: (SessionViewSettings) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 16.dp)
            .testTag(VIEW_SETTINGS_TEST_TAG),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.view_settings_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.view_settings_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onClose) { Text(stringResource(R.string.common_close)) }
        }

        SectionTitle(stringResource(R.string.view_settings_grouping))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column {
                GROUP_MODES.forEachIndexed { index, entry ->
                    if (index > 0) HorizontalDivider()
                    ChoiceRow(
                        label = stringResource(entry.label),
                        selected = settings.groupMode == entry.mode,
                        onSelect = { onChange(settings.copy(groupMode = entry.mode)) },
                    )
                }
            }
        }

        SectionTitle(stringResource(R.string.view_settings_filters))

        FilterLabel(stringResource(R.string.view_settings_workspace))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column {
                ChoiceRow(
                    label = stringResource(R.string.view_settings_all_workspaces),
                    selected = settings.workspaceFilter.isEmpty(),
                    onSelect = { onChange(settings.copy(workspaceFilter = "")) },
                )
                workspaces.forEach { option ->
                    HorizontalDivider()
                    ChoiceRow(
                        label = option.name,
                        // Filters store the identity key (workspace ID first). A filter
                        // persisted as a bare path before IDs still highlights its row.
                        selected = settings.workspaceFilter == option.key || settings.workspaceFilter == option.path,
                        onSelect = { onChange(settings.copy(workspaceFilter = option.key)) },
                    )
                }
            }
        }

        FilterLabel(stringResource(R.string.view_settings_agent_type))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column {
                ChoiceRow(
                    label = stringResource(R.string.view_settings_all_agent_types),
                    selected = settings.agentFilter == null,
                    onSelect = { onChange(settings.copy(agentFilter = null)) },
                )
                agentGroups.forEach { group ->
                    HorizontalDivider()
                    ChoiceRow(
                        label = stringResource(group.labelRes()),
                        selected = settings.agentFilter == group,
                        onSelect = { onChange(settings.copy(agentFilter = group)) },
                    )
                }
            }
        }

        FilterLabel(stringResource(R.string.view_settings_status))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column {
                ChoiceRow(
                    label = stringResource(R.string.view_settings_all_statuses),
                    selected = settings.statusFilter.isEmpty(),
                    onSelect = { onChange(settings.copy(statusFilter = "")) },
                )
                statuses.forEach { status ->
                    HorizontalDivider()
                    ChoiceRow(
                        label = statusText(status),
                        selected = settings.statusFilter == status,
                        onSelect = { onChange(settings.copy(statusFilter = status)) },
                    )
                }
            }
        }

        SectionTitle(stringResource(R.string.view_settings_metadata))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column {
                ToggleRow(
                    label = stringResource(R.string.view_settings_workspace),
                    checked = settings.showWorkspace,
                    onChange = { onChange(settings.copy(showWorkspace = it)) },
                )
                HorizontalDivider()
                ToggleRow(
                    label = stringResource(R.string.view_settings_updated),
                    checked = settings.showUpdated,
                    onChange = { onChange(settings.copy(showUpdated = it)) },
                )
                HorizontalDivider()
                ToggleRow(
                    label = stringResource(R.string.view_settings_status),
                    checked = settings.showStatus,
                    onChange = { onChange(settings.copy(showStatus = it)) },
                )
            }
        }
    }
}

/** The desktop's own word when we have none of our own; see [SessionStatusLabel]. */
@Composable
internal fun statusText(status: String): String =
    when (SessionListPresentation.statusLabel(status)) {
        SessionStatusLabel.RUNNING -> stringResource(R.string.status_running)
        SessionStatusLabel.READY -> stringResource(R.string.status_ready)
        SessionStatusLabel.ARCHIVED -> stringResource(R.string.session_archived)
        SessionStatusLabel.RAW -> status
    }

internal fun SessionAgentGroup.labelRes(): Int = when (this) {
    SessionAgentGroup.CHAT -> R.string.session_group_chat
    SessionAgentGroup.CODE -> R.string.sessions_filter_code
    SessionAgentGroup.COWORK -> R.string.sessions_filter_cowork
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun FilterLabel(label: String) {
    Text(
        label,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// The whole row is the control in both cases: the radio and the switch report
// no click of their own, so the row's semantics stay a single target rather
// than a label sitting next to an unrelated tappable box.
@Composable
private fun ChoiceRow(label: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onSelect)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(value = checked, onValueChange = onChange)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null)
    }
}

private class GroupModeEntry(val mode: SessionGroupMode, val label: Int)

private val GROUP_MODES = listOf(
    GroupModeEntry(SessionGroupMode.PROJECT, R.string.group_by_project),
    GroupModeEntry(SessionGroupMode.TIME, R.string.group_by_time),
    GroupModeEntry(SessionGroupMode.CHAT, R.string.group_chat_first),
)
