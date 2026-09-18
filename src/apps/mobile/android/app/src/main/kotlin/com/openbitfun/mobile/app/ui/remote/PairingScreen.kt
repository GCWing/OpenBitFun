package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.HorizontalDivider
import com.openbitfun.mobile.app.ui.shell.WelcomeBrandFlow
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.core.feature.session.RecentSessionsPresentation
import com.openbitfun.mobile.core.feature.session.RecentSessionUiState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.chat.ConversationView
import com.openbitfun.mobile.app.ui.common.CircleControl
import com.openbitfun.mobile.app.ui.shell.MENU_TEST_TAG
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.session.ConversationHeaderPresenter
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

/** The account-device route, which bypasses the QR pairing form entirely. */
@Composable
internal fun AccountRemoteScreen(
    remoteState: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    deviceId: String,
    deviceName: String,
    createDevices: List<CreateDeviceChoice>,
    accountUsername: String,
    attachmentOwner: String = deviceId,
    phase: ConnectionPhase,
    settingsPlacement: SettingsPlacement,
    sessionDetailsPlacement: SettingsPlacement,
    viewSettingsPlacement: SettingsPlacement,
    onOpenRemoteSettings: () -> Unit,
    onCreateDevicePick: (String) -> Unit,
    onSessionIntent: (com.openbitfun.mobile.core.feature.session.RemoteSessionIntent) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onOpenSidebar: (() -> Unit)? = null,
    compact: Boolean = true,
    requestedSessionId: String? = null,
    creatingSession: Boolean = false,
    onOpenSession: (String) -> Unit = {},
    onCreateSession: () -> Unit = {},
    onRemoteHome: () -> Unit = {},
    modifier: Modifier,
) {
    RemoteConnectedScreen(
        remoteState = remoteState,
        workspaceState = workspaceState,
        phase = phase,
        settingsPlacement = settingsPlacement,
        sessionDetailsPlacement = sessionDetailsPlacement,
        viewSettingsPlacement = viewSettingsPlacement,
        onOpenRemoteSettings = onOpenRemoteSettings,
        deviceId = deviceId,
        attachmentOwner = attachmentOwner,
        createDevices = createDevices,
        desktopName = deviceName,
        onCreateDevicePick = onCreateDevicePick,
        onSessionIntent = onSessionIntent,
        onWorkspaceIntent = onWorkspaceIntent,
        onOpenSidebar = onOpenSidebar,
        compact = compact,
        requestedSessionId = requestedSessionId,
        creatingSession = creatingSession,
        onOpenSession = onOpenSession,
        onCreateSession = onCreateSession,
        onRemoteHome = onRemoteHome,
        connectionDetails = {
            AccountDeviceDetails(deviceName = deviceName, accountUsername = accountUsername)
        },
        modifier = modifier,
    )
}

@Composable
private fun RemoteConnectedScreen(
    remoteState: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    phase: ConnectionPhase,
    settingsPlacement: SettingsPlacement,
    sessionDetailsPlacement: SettingsPlacement,
    viewSettingsPlacement: SettingsPlacement,
    onOpenRemoteSettings: () -> Unit,
    deviceId: String,
    attachmentOwner: String,
    createDevices: List<CreateDeviceChoice>,
    desktopName: String,
    onCreateDevicePick: (String) -> Unit,
    onSessionIntent: (com.openbitfun.mobile.core.feature.session.RemoteSessionIntent) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onOpenSidebar: (() -> Unit)?,
    compact: Boolean,
    requestedSessionId: String?,
    creatingSession: Boolean,
    onOpenSession: (String) -> Unit,
    onCreateSession: () -> Unit,
    onRemoteHome: () -> Unit,
    connectionDetails: @Composable () -> Unit,
    modifier: Modifier,
) {
    val ready = remoteState as? RemoteSessionUiState.Ready
    // Route immediately. A previous session snapshot must never stand in for the requested one.
    val conversation = requestedSessionId?.takeIf { remoteState !is RemoteSessionUiState.Failed }?.let { requested ->
        val matches = ready?.selectedSessionId == requested && ready.timeline?.sessionId == requested
        if (matches) ready else RemoteSessionUiState.Ready(
            sessions = ready?.sessions.orEmpty(), selectedSessionId = requested,
            timeline = null, busy = true, permissionMode = null, permissionModeFailure = null,
            query = "", agentFilter = com.openbitfun.mobile.core.feature.session.SessionAgentFilter.ALL,
            hasMore = false, hasMoreMessages = false, modelCatalog = null,
        )
    }
    if (conversation != null) {
        ConversationView(
            state = conversation,
            attachmentOwner = attachmentOwner,
            hostCapabilities = (workspaceState as? RemoteWorkspaceUiState.Ready)?.hostCapabilities.orEmpty(),
            phase = phase,
            settingsPlacement = settingsPlacement,
            onBack = onRemoteHome,
            onOpenSidebar = onOpenSidebar,
            onIntent = onSessionIntent,
            contextTitle = ConversationHeaderPresenter.contextTitle(
                desktopName = desktopName,
                workspaceBranch = (workspaceState as? RemoteWorkspaceUiState.Ready)
                    ?.selected?.gitBranch.orEmpty(),
            ),
            onOpenFile = { path, label ->
                onWorkspaceIntent(
                    RemoteWorkspaceIntent.OpenFile(
                        path,
                        label,
                        conversation.selectedSessionId.orEmpty(),
                    ),
                )
            },
            previewingRemotePath = workspaceState.previewingRemotePath(),
            previewLoading = workspaceState.previewLoading(),
            download = (workspaceState as? RemoteWorkspaceUiState.Ready)?.download
                ?: com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState.None,
            onDownloadFile = { path, label ->
                onWorkspaceIntent(
                    RemoteWorkspaceIntent.DownloadFile(
                        path,
                        label,
                        conversation.selectedSessionId.orEmpty(),
                    ),
                )
            },
            modifier = modifier,
        )
    } else if (requestedSessionId != null && remoteState is RemoteSessionUiState.Failed) {
        Column(modifier.fillMaxSize()) {
            RemoteShellHeader(onOpenSidebar, desktopName, onOpenRemoteSettings)
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text(stringResource(R.string.sessions_failed), color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = {
                    onSessionIntent(com.openbitfun.mobile.core.feature.session.RemoteSessionIntent.Open(requestedSessionId))
                }) { Text(stringResource(R.string.sessions_retry)) }
                TextButton(onClick = onRemoteHome) { Text(stringResource(R.string.conversation_back)) }
            }
        }
    } else if (creatingSession) {
        CreateSessionRoute(
            sessionState = remoteState,
            workspaceState = workspaceState,
            phase = phase,
            deviceId = deviceId,
            devices = createDevices,
            compact = compact,
            onDevicePick = onCreateDevicePick,
            onBack = onRemoteHome,
            onCreated = onOpenSession,
            onWorkspaceIntent = onWorkspaceIntent,
            onIntent = onSessionIntent,
            modifier = modifier,
        )
    } else {
        RemoteCompactHome(
            remoteState = remoteState,
            desktopName = desktopName,
            onOpenSidebar = onOpenSidebar,
            onBrowse = onOpenSidebar,
            onOpen = { id ->
                onOpenSession(id)
                onSessionIntent(com.openbitfun.mobile.core.feature.session.RemoteSessionIntent.Open(id))
            },
            modifier = modifier,
        )
    }
}

@Composable
internal fun RemoteCompactHome(
    remoteState: RemoteSessionUiState,
    desktopName: String,
    onOpenSidebar: (() -> Unit)?,
    onBrowse: (() -> Unit)?,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ready = remoteState as? RemoteSessionUiState.Ready
    val sessions = ready?.sessions.orEmpty()
    val recent = RecentSessionsPresentation.sessionIds(sessions.map {
        RecentSessionUiState(it.id, it.status, it.updatedAt, it.createdAt)
    }).mapNotNull { id -> sessions.firstOrNull { it.id == id } }
    Column(modifier.fillMaxSize()) {
        RemoteShellHeader(onOpenSidebar, desktopName, null)
        Column(
            Modifier.weight(1f).align(Alignment.CenterHorizontally)
                .widthIn(max = MobileDesignGeometry.RecentHomeMaxWidth).fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = MobileDesignGeometry.RecentHomeGutter, vertical = 24.dp),
        ) {
            WelcomeBrandFlow(Modifier.align(Alignment.CenterHorizontally).size(MobileDesignGeometry.RecentHomeMarkSize), sweep = true)
            Text(stringResource(R.string.home_recent_title), fontSize = 25.sp,
                fontWeight = FontWeight.Medium, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 32.dp))
            if (remoteState is RemoteSessionUiState.Loading) CircularProgressIndicator(Modifier.size(24.dp))
            if (remoteState is RemoteSessionUiState.Failed) {
                Text(stringResource(R.string.sessions_failed), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.home_recent_recent), fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                if (onBrowse != null) TextButton(
                    onClick = onBrowse,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                ) { Text(stringResource(R.string.home_recent_all), fontSize = 12.sp) }
            }
            recent.forEach { session ->
                Column(Modifier.fillMaxWidth().clickable(enabled = !ready!!.busy) { onOpen(session.id) }
                    .padding(vertical = MobileDesignGeometry.RecentHomeRowPadding)) {
                    Text(session.title, fontSize = 15.sp, maxLines = 2)
                    val workspace = session.workspaceName?.takeIf { it.isNotBlank() }
                        ?: session.workspacePath.orEmpty().trimEnd('/').substringAfterLast('/')
                    Text(listOf(desktopName, workspace).filter { it.isNotBlank() }.joinToString(" · "),
                        fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 6.dp), maxLines = 1)
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            if (recent.isEmpty() && remoteState !is RemoteSessionUiState.Loading) {
                Text(stringResource(if (desktopName.isBlank()) R.string.home_recent_connect else R.string.home_recent_empty),
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 18.dp))
            }
        }
    }
}

@Composable
private fun RemoteShellHeader(
    onOpenSidebar: (() -> Unit)?,
    subtitle: String = "",
    onOpenRemoteSettings: (() -> Unit)?,
) {
    val hasSubtitle = subtitle.isNotBlank()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (hasSubtitle) 76.dp else 64.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        onOpenSidebar?.let { openSidebar ->
            CircleControl(
                icon = R.drawable.ic_symbol_menu_lines,
                glyphSize = 22,
                contentDescription = stringResource(R.string.shell_open_sidebar),
                onClick = openSidebar,
                modifier = Modifier.testTag(MENU_TEST_TAG),
            )
        } ?: Box(Modifier.size(44.dp))
        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                stringResource(R.string.app_name),
                fontSize = if (hasSubtitle) 18.sp else 17.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                textAlign = TextAlign.Center,
            )
            if (hasSubtitle) {
                Text(
                    subtitle,
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    textAlign = TextAlign.Center,
                )
            }
        }
        if (onOpenRemoteSettings != null) CircleControl(
            icon = R.drawable.ic_symbol_gearshape,
            glyphSize = 19,
            contentDescription = stringResource(R.string.remote_settings_title),
            onClick = onOpenRemoteSettings,
            modifier = Modifier,
        ) else Box(Modifier.size(com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry.ControlTouchSize))
    }
}

@Composable
private fun AccountDeviceDetails(deviceName: String, accountUsername: String) {
    Text(stringResource(R.string.paired_title), style = MaterialTheme.typography.headlineSmall)
    Text(
        stringResource(R.string.account_device_controlling, deviceName),
        style = MaterialTheme.typography.bodyMedium,
    )
    if (accountUsername.isNotBlank()) {
        Text(
            stringResource(R.string.paired_user, accountUsername),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
internal fun RemoteWorkspacePanel(
    state: RemoteWorkspaceUiState,
    sessionId: String,
    onIntent: (RemoteWorkspaceIntent) -> Unit,
    // False wherever the shell places the preview itself: the file gets a pane
    // or the whole page there, and a second copy inline under the list would be
    // the same document twice.
    showPreview: Boolean = true,
) {
    var fileReference by rememberSaveable { mutableStateOf("") }
    var directoryDialog by rememberSaveable { mutableStateOf(false) }
    var workspacePath by rememberSaveable { mutableStateOf("") }
    var savedConnectionId by rememberSaveable { mutableStateOf<String?>(null) }
    Text(stringResource(R.string.workspace_title), style = MaterialTheme.typography.titleLarge)
    when (state) {
        RemoteWorkspaceUiState.Idle -> Unit
        RemoteWorkspaceUiState.Loading -> CircularProgressIndicator()
        is RemoteWorkspaceUiState.Failed -> {
            Text(stringResource(R.string.workspace_failed), color = MaterialTheme.colorScheme.error)
            TextButton(onClick = { onIntent(RemoteWorkspaceIntent.Load) }) {
                Text(stringResource(R.string.sessions_refresh))
            }
        }
        is RemoteWorkspaceUiState.Ready -> {
            if (directoryDialog) RuntimeDirectoryPickerDialog(state.directoryPicker, savedConnectionId, onIntent, { workspacePath = it; directoryDialog = false }, { directoryDialog = false })
            state.selected?.let { selected ->
                Text(selected.name, style = MaterialTheme.typography.titleMedium)
                if (selected.gitBranch.isNotEmpty()) Text(selected.gitBranch)
            }
            OutlinedTextField(value = workspacePath, onValueChange = { workspacePath = it },
                label = { Text(stringResource(R.string.workspace_target_path)) }, enabled = !state.busy,
                modifier = Modifier.fillMaxWidth())
            TextButton(onClick = { directoryDialog = true; onIntent(RemoteWorkspaceIntent.BrowseWorkspaceDirectories(workspacePath.ifBlank { "/" }, savedConnectionId, false)) }, enabled = !state.busy) { Text(stringResource(R.string.workspace_choose_folder)) }
            TextButton(onClick = { savedConnectionId = null }, enabled = !state.busy) {
                Text(stringResource(R.string.workspace_target_device))
            }
            state.savedConnections.forEach { connection ->
                TextButton(onClick = { savedConnectionId = connection.id }, enabled = !state.busy) {
                    Text((if (savedConnectionId == connection.id) "✓ " else "") + connection.name)
                }
            }
            if (state.savedConnectionsFailure) Text(stringResource(R.string.workspace_connections_failed), color = MaterialTheme.colorScheme.error)
            // A hand-typed path has no workspace ID: only the legacy projection can be sent.
            TextButton(enabled = !state.busy && workspacePath.isNotBlank(), onClick = {
                onIntent(RemoteWorkspaceIntent.SelectWorkspace(workspacePath, savedConnectionId, null))
            }) { Text(stringResource(R.string.workspace_open_path)) }
            state.workspaceReferenceFailure?.let { failure ->
                Text(stringResource(workspaceReferenceFailureText(failure)), color = MaterialTheme.colorScheme.error)
            }
            state.workspaces.forEach { workspace ->
                TextButton(
                    onClick = { onIntent(RemoteWorkspaceIntent.SelectWorkspace(workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, false, workspace.workspaceId)) },
                    enabled = !state.busy && !state.isSelected(workspace),
                ) { Text(workspace.displayName) }
            }
            if (state.assistants.isNotEmpty()) {
                Text(stringResource(R.string.assistants_title), style = MaterialTheme.typography.titleSmall)
                state.assistants.forEach { assistant ->
                    TextButton(
                        onClick = { onIntent(RemoteWorkspaceIntent.SelectAssistant(assistant.path, assistant.workspaceId)) },
                        enabled = !state.busy && !state.isSelected(assistant),
                    ) { Text(assistant.name) }
                }
            }
            OutlinedTextField(
                value = fileReference,
                onValueChange = { fileReference = it },
                label = { Text(stringResource(R.string.file_reference_label)) },
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    onIntent(RemoteWorkspaceIntent.OpenFile(fileReference, "", sessionId))
                },
                enabled = fileReference.isNotBlank(),
            ) { Text(stringResource(R.string.file_preview_open)) }
            if (showPreview) {
                // The pane sizes itself to the space it is given, and this
                // panel is inside a scrolling column with none to give.
                FilePreviewSurface(
                    preview = state.preview,
                    download = state.download,
                    remoteAvailable = true,
                    onIntent = onIntent,
                    modifier = Modifier.fillMaxWidth().height(360.dp),
                )
            }
        }
    }
}
