package com.openbitfun.mobile.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.core.feature.session.PermissionModeFailure
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionPermissionMode

internal const val FULL_ACCESS_CONFIRM_TEST_TAG: String = "full-access-confirm"
internal const val PERMISSION_SECTION_TEST_TAG: String = "permission-section"

/**
 * Whether the desktop runs a tool without asking, ported from
 * `PermissionSectionHeader()` + `PermissionModeCard()`.
 *
 * The consequential setting on either client, which is why each mode carries the
 * sentence that says what it will do and why the widest one is a two-step choice
 * with its own red card.
 *
 * It belongs to the desktop rather than to one of its sessions — both permission
 * commands go out unaddressed — so it sits on the settings page beside the
 * connection it describes, where the source puts it, and needs no session open to
 * be asked or answered.
 *
 * Always on the settings page. With no Ready session store ([state] null) there
 * is no desktop to be permitted by, so the section stays in place but disabled —
 * rows faded and inert, the connection hint under them — rather than vanishing
 * and moving the rest of the page.
 */
@Composable
internal fun PermissionSection(
    state: RemoteSessionUiState.Ready?,
    connected: Boolean,
    onIntent: (RemoteSessionIntent) -> Unit,
    modifier: Modifier,
) {
    // Cleared whenever the mode changes underneath it: a confirmation left
    // standing after a successful change would confirm the wrong thing.
    val permissionMode = state?.permissionMode
    // Nothing to command without a Ready store, whatever the link says.
    val live = state != null && connected
    var confirmFullAccess by rememberSaveable(permissionMode, live) { mutableStateOf(false) }
    val refreshEnabled = live && state?.busy == false
    val selectEnabled = refreshEnabled && permissionMode != SessionPermissionMode.UNKNOWN

    Column(
        modifier = modifier.fillMaxWidth().testTag(PERMISSION_SECTION_TEST_TAG),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SettingsSectionHeader(
                stringResource(R.string.permission_title),
                modifier = Modifier.weight(1f),
            )
            // Gone rather than disabled while there is no desktop answering, as
            // `if (this.canManagePermissions())` has it: a refresh that cannot
            // reach anything is not an action the page should keep offering, and
            // the line under the modes already says why.
            if (live) {
                TextButton(
                    onClick = { onIntent(RemoteSessionIntent.RefreshPermissionMode) },
                    enabled = refreshEnabled,
                ) { Text(stringResource(R.string.sessions_refresh)) }
            }
        }

        SettingsCard(
            modifier = Modifier,
            radius = MobileDesignGeometry.SettingsProminentCardRadius,
        ) {
            Text(
                stringResource(R.string.permission_scope),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 4.dp),
            )
            PERMISSION_MODES.forEachIndexed { index, entry ->
                if (index > 0) HorizontalDivider(Modifier.padding(horizontal = 18.dp))
                PermissionModeRow(
                    label = stringResource(entry.label),
                    description = stringResource(entry.description),
                    selected = permissionMode == entry.mode,
                    enabled = selectEnabled,
                    onSelect = {
                        // Full access removes every confirmation the desktop
                        // would otherwise ask for, so this one is confirmed.
                        if (entry.mode == SessionPermissionMode.FULL_ACCESS) {
                            confirmFullAccess = true
                        } else {
                            confirmFullAccess = false
                            onIntent(RemoteSessionIntent.SetPermissionMode(entry.mode))
                        }
                    },
                )
            }
            PermissionStatus(state = state, connected = live)

            // Inside the card, under the row it is about, where the source puts
            // it. Below the card it would read as a fourth section of the page
            // rather than as the second half of choosing Full access.
            if (confirmFullAccess) {
                FullAccessConfirmation(
                    enabled = selectEnabled,
                    onCancel = { confirmFullAccess = false },
                    onConfirm = {
                        onIntent(
                            RemoteSessionIntent.SetPermissionMode(
                                SessionPermissionMode.FULL_ACCESS,
                            ),
                        )
                        confirmFullAccess = false
                    },
                )
            }
        }
    }
}

/**
 * One mode.
 *
 * A checkmark rather than a radio button, which is what `PermissionModeRow`
 * draws: the choice is remembered on the desktop, not made in this card, so the
 * glyph reports the desktop's answer rather than offering three empty slots. A
 * row that cannot be changed fades whole, the way the source's `.opacity(0.54)`
 * does, instead of leaving a lit label above a dead control.
 */
@Composable
private fun PermissionModeRow(
    label: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, onClick = onSelect)
            .defaultMinSize(minHeight = 72.dp)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val alpha = if (enabled) 1f else 0.54f
        // Ahead of the label, as the source draws it, and reserved whether or
        // not it is filled so the three rows keep one left edge. Leading rather
        // than trailing because it reads as the answer to "which one is on"
        // before the labels are read, not as a tick beside one of them.
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            if (selected) {
                Icon(
                    painterResource(R.drawable.ic_symbol_checkmark_circle_fill),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary.copy(alpha = alpha),
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = alpha),
            )
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha),
            )
        }
    }
}

/** One line under the modes: loading, unreachable, or which command failed. */
@Composable
private fun ColumnScope.PermissionStatus(state: RemoteSessionUiState.Ready?, connected: Boolean) {
    if (state == null || !connected) {
        Text(
            stringResource(R.string.permission_needs_connection),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 4.dp, bottom = 16.dp),
        )
        return
    }
    val failure = state.permissionModeFailure
    val text = when {
        failure == PermissionModeFailure.LOAD -> stringResource(R.string.permission_load_failed)
        failure == PermissionModeFailure.SAVE -> stringResource(R.string.permission_save_failed)
        state.permissionMode == SessionPermissionMode.UNKNOWN -> stringResource(R.string.permission_unknown)
        state.permissionMode == null -> stringResource(R.string.permission_loading)
        else -> return
    }
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (failure == null && state.permissionMode != SessionPermissionMode.UNKNOWN) {
            MaterialTheme.colorScheme.onSurfaceVariant
        } else {
            MaterialTheme.colorScheme.error
        },
        modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 4.dp, bottom = 16.dp),
    )
}

/**
 * The second step, ported from `FullAccessConfirmation()`.
 *
 * A card outlined in red with a filled red confirm, rather than two equal text
 * buttons on a tinted surface: this is the one control in the app that hands a
 * remote machine the right to run commands unasked, and it has to look unlike
 * every other row on the page.
 */
@Composable
private fun FullAccessConfirmation(
    enabled: Boolean,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
        // Inset from the card it sits in, so its red outline reads as something
        // laid on the card rather than as the card's own edge.
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, bottom = 14.dp)
            .testTag(FULL_ACCESS_CONFIRM_TEST_TAG),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                stringResource(R.string.permission_full_confirm_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.error,
            )
            Text(
                stringResource(R.string.permission_full_confirm_body),
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = onCancel,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onSurface,
                    ),
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.common_cancel)) }
                Button(
                    onClick = onConfirm,
                    enabled = enabled,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.permission_full_confirm_action)) }
            }
        }
    }
}

private class PermissionModeEntry(
    val mode: SessionPermissionMode,
    val label: Int,
    val description: Int,
)

private val PERMISSION_MODES = listOf(
    PermissionModeEntry(
        SessionPermissionMode.ASK,
        R.string.permission_ask,
        R.string.permission_ask_description,
    ),
    PermissionModeEntry(
        SessionPermissionMode.AUTO,
        R.string.permission_auto,
        R.string.permission_auto_description,
    ),
    PermissionModeEntry(
        SessionPermissionMode.FULL_ACCESS,
        R.string.permission_full,
        R.string.permission_full_description,
    ),
)
