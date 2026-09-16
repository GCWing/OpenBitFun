package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

/** Native presentation only; directory access and workspace mutation stay in KMP. */
@Composable
internal fun RuntimeWorkspacePickerDialog(
    state: RemoteWorkspaceUiState.Ready,
    onIntent: (RemoteWorkspaceIntent) -> Unit,
    onDismiss: () -> Unit,
) {
    val actionColors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    val selectionColors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.onSurface)
    var path by rememberSaveable { mutableStateOf("") }
    var connectionId by rememberSaveable { mutableStateOf<String?>(null) }
    var browsing by rememberSaveable { mutableStateOf(false) }
    var submittedPath by rememberSaveable { mutableStateOf<String?>(null) }
    var submittedConnectionId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(state.busy, state.selected, state.loadFailure, submittedPath, submittedConnectionId) {
        val targetPath = submittedPath ?: return@LaunchedEffect
        if (!state.busy) {
            if (!state.loadFailure && state.selected?.path == targetPath &&
                state.selected?.remoteConnectionId == submittedConnectionId) onDismiss()
        }
    }
    fun open(targetPath: String, targetConnection: String?, sshHost: String? = null) {
        submittedPath = targetPath
        submittedConnectionId = targetConnection
        onIntent(RemoteWorkspaceIntent.SelectWorkspace(targetPath, targetConnection, sshHost, false))
    }
    if (browsing) RuntimeDirectoryPickerDialog(
        state.directoryPicker, connectionId, onIntent,
        { path = it; browsing = false }, { browsing = false },
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workspace_open_path)) },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(colors = actionColors, onClick = { connectionId = null; path = "" }, enabled = !state.busy) {
                    RadioButton(colors = selectionColors, selected = connectionId == null, onClick = null)
                    Text(stringResource(R.string.workspace_target_device))
                }
                state.savedConnections.forEach { connection ->
                    TextButton(colors = actionColors, onClick = { connectionId = connection.id; path = "" }, enabled = !state.busy) {
                        RadioButton(colors = selectionColors, selected = connectionId == connection.id, onClick = null)
                        Text(connection.name)
                    }
                }
                if (state.savedConnectionsFailure) Text(stringResource(R.string.workspace_connections_failed),
                    color = MaterialTheme.colorScheme.error)
                OutlinedTextField(value = path, onValueChange = { path = it }, singleLine = true,
                    label = { Text(stringResource(R.string.workspace_target_path)) },
                    enabled = !state.busy, modifier = Modifier.fillMaxWidth())
                TextButton(colors = actionColors, enabled = !state.busy, onClick = {
                    browsing = true
                    onIntent(RemoteWorkspaceIntent.BrowseWorkspaceDirectories(path.ifBlank { "/" }, connectionId, false))
                }) { Text(stringResource(R.string.workspace_choose_folder)) }
                if (state.loadFailure) {
                    Text(stringResource(R.string.workspace_failed), color = MaterialTheme.colorScheme.error)
                    TextButton(colors = actionColors, onClick = { onIntent(RemoteWorkspaceIntent.Load) }, enabled = !state.busy) {
                        Text(stringResource(R.string.sessions_refresh))
                    }
                }
                state.workspaces.forEach { workspace ->
                    TextButton(colors = actionColors, enabled = !state.busy, onClick = {
                        open(workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost)
                    }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(workspace.displayName, style = MaterialTheme.typography.bodyMedium)
                            Text(workspace.path, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(colors = actionColors, enabled = !state.busy && path.isNotBlank(), onClick = { open(path.trim(), connectionId) }) {
                Text(stringResource(R.string.workspace_open_path))
            }
        },
        dismissButton = { TextButton(colors = actionColors, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
