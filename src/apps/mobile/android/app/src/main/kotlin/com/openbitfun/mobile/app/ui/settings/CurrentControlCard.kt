package com.openbitfun.mobile.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.common.labelRes
import com.openbitfun.mobile.core.feature.connection.RemoteControlAction
import com.openbitfun.mobile.core.feature.connection.RemoteControlSource
import com.openbitfun.mobile.core.feature.connection.RemoteControlSummary

internal const val CURRENT_CONTROL_TEST_TAG: String = "current-control"
internal const val CONTROL_ACTION_TEST_TAG: String = "current-control-action"

/**
 * What this phone is driving right now, ported from `CurrentControlCard()`.
 *
 * The card answers three questions in the order the source asks them: which
 * desktop, whether it is answering, and how the link was made. The third is the
 * one neither screen behind this page can say on its own — the account lists
 * devices and the pairing screen holds a room, and only here do the two become
 * one connection with a provenance.
 */
@Composable
internal fun CurrentControlCard(
    summary: RemoteControlSummary,
    onDisconnect: () -> Unit,
    onReconnect: () -> Unit,
    modifier: Modifier,
) {
    SettingsCard(modifier = modifier.testTag(CURRENT_CONTROL_TEST_TAG)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 92.dp)
                .padding(horizontal = 18.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SettingsAvatar(icon = R.drawable.ic_symbol_desktop, diameter = 40)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    stringResource(R.string.remote_settings_desktop_product),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    summary.desktopName.ifBlank {
                        stringResource(R.string.remote_settings_no_desktop)
                    },
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    stringResource(summary.phase.labelRes()),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            when (summary.action) {
                RemoteControlAction.DISCONNECT -> SettingsChip(
                    label = stringResource(R.string.remote_settings_disconnect),
                    enabled = true,
                    onClick = onDisconnect,
                    modifier = Modifier.testTag(CONTROL_ACTION_TEST_TAG),
                )

                RemoteControlAction.RECONNECT -> SettingsChip(
                    label = stringResource(R.string.remote_settings_reconnect),
                    enabled = true,
                    onClick = onReconnect,
                    modifier = Modifier.testTag(CONTROL_ACTION_TEST_TAG),
                )

                // Nothing is selected, so there is neither a link to leave nor one
                // to try again; the account's device list below makes the first.
                RemoteControlAction.NONE -> Unit
            }
        }

        HorizontalDivider(Modifier.padding(horizontal = 18.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 52.dp)
                .padding(horizontal = 18.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // How the link was made: today only through the signed-in account.
            Icon(
                painterResource(R.drawable.ic_symbol_link),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.58f),
                modifier = Modifier.size(20.dp),
            )
            Text(
                stringResource(R.string.remote_settings_connection_source),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            SettingsChip(
                label = stringResource(summary.source.sourceLabelRes()),
                enabled = true,
                onClick = null,
                modifier = Modifier,
            )
        }
    }
}

private fun RemoteControlSource.sourceLabelRes(): Int = when (this) {
    RemoteControlSource.ACCOUNT_DEVICE -> R.string.remote_settings_source_account_device
    RemoteControlSource.NONE -> R.string.remote_settings_source_none
}
