package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.workspace.*

/** Native navigation only. Location, selected panel and PTY lifetime belong to KMP. */
@Composable
internal fun DeviceToolsDialog(state: RemoteWorkspaceUiState.Ready, onIntent: (RemoteWorkspaceIntent) -> Unit) {
    val tools = state.deviceTools
    var choosing by remember { mutableStateOf(false) }
    val panels = rememberSaveableStateHolder()
    RuntimeFullScreen(stringResource(R.string.device_tools), { onIntent(RemoteWorkspaceIntent.CloseDeviceTools) }) {
        Box {
            TextButton(enabled = !tools.busy && state.files.file == null, onClick = { choosing = true },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) {
                Text(state.savedConnections.firstOrNull { it.id == tools.connectionId }?.name ?: stringResource(R.string.workspace_target_device))
            }
            DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_target_device)) }, onClick = {
                    choosing = false; onIntent(RemoteWorkspaceIntent.OpenDeviceTools())
                })
                state.savedConnections.forEach { connection ->
                    DropdownMenuItem(text = { Text(connection.name) }, onClick = {
                        choosing = false; onIntent(RemoteWorkspaceIntent.OpenDeviceTools(connectionId = connection.id))
                    })
                }
            }
        }
        TabRow(
            selectedTabIndex = tools.panel.ordinal,
            containerColor = MaterialTheme.colorScheme.surface,
            contentColor = MaterialTheme.colorScheme.onSurface,
            indicator = { positions ->
                TabRowDefaults.SecondaryIndicator(
                    modifier = Modifier.tabIndicatorOffset(positions[tools.panel.ordinal]),
                    color = MaterialTheme.colorScheme.onSurface,
                )
            },
        ) {
            DeviceToolsPanel.entries.forEach { panel ->
                Tab(
                    selected = panel == tools.panel,
                    enabled = state.files.file == null,
                    onClick = { onIntent(RemoteWorkspaceIntent.SelectDeviceToolsPanel(panel)) },
                    selectedContentColor = MaterialTheme.colorScheme.onSurface,
                    unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    text = { Text(stringResource(if (panel == DeviceToolsPanel.FILES) R.string.workspace_browse_files else R.string.workspace_terminal)) },
                )
            }
        }
        when {
            tools.busy -> CircularProgressIndicator(Modifier.padding(16.dp))
            tools.failed -> TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { onIntent(RemoteWorkspaceIntent.OpenDeviceTools(connectionId = tools.connectionId)) }) {
                Text(stringResource(R.string.workspace_files_failed))
            }
            else -> panels.SaveableStateProvider("${tools.connectionId}:${tools.path}:${tools.panel}") {
                when (tools.panel) {
                    DeviceToolsPanel.FILES -> RuntimeFilesContent(state, onIntent)
                    DeviceToolsPanel.TERMINAL -> {
                        val terminal = state.terminal
                        if (terminal.failed) Text(terminal.errorDetail ?: stringResource(R.string.workspace_terminal_failed), color = MaterialTheme.colorScheme.error)
                        if (terminal.busy) CircularProgressIndicator(Modifier.padding(12.dp))
                        if (terminal.sessionId != null) {
                            Row {
                                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !terminal.busy, onClick = { onIntent(RemoteWorkspaceIntent.WriteTerminal("\u0003")) }) { Text(stringResource(R.string.message_stop)) }
                                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !terminal.busy, onClick = { onIntent(RemoteWorkspaceIntent.CloseTerminal) }) { Text(stringResource(R.string.workspace_terminal_close)) }
                            }
                            RuntimeTerminalView(terminal, { onIntent(RemoteWorkspaceIntent.WriteTerminal(it)) }, { cols, rows -> onIntent(RemoteWorkspaceIntent.ResizeTerminal(cols, rows)) }, Modifier.fillMaxWidth().weight(1f))
                        } else if (!terminal.busy) {
                            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = androidx.compose.ui.Alignment.Center) {
                                OutlinedButton(colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { onIntent(RemoteWorkspaceIntent.StartDeviceToolsTerminal) }) { Text(stringResource(R.string.workspace_open_terminal)) }
                            }
                        }
                    }
                }
            }
        }
    }
}
