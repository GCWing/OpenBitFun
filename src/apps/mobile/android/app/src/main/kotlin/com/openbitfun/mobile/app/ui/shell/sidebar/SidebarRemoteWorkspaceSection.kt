package com.openbitfun.mobile.app.ui.shell.sidebar

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.ui.remote.ProjectCreateControl
import com.openbitfun.mobile.core.feature.session.HarnessProfilePolicy
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.common.labelRes
import com.openbitfun.mobile.core.feature.account.AccountDeviceUi
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.connection.ConnectionStatusPresenter
import com.openbitfun.mobile.core.feature.connection.RemoteControlSource
import com.openbitfun.mobile.core.feature.shell.RemoteSidebarSessionRow
import com.openbitfun.mobile.core.feature.shell.RemoteSidebarWorkspaceRow
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import com.openbitfun.mobile.app.ui.theme.openBitFunColors

private const val SESSIONS_PER_WORKSPACE = 3
private const val WORKSPACES_PER_BATCH = 3
private const val DEVICES_PER_BATCH = 3
internal const val SIDEBAR_REMOTE_SESSION_TEST_TAG: String = "app-sidebar-remote-session"

/** The remote workspace tree appended under local conversations in Harmony's unified sidebar. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SidebarRemoteWorkspaceSection(
    connectionPhase: ConnectionPhase,
    controlSource: RemoteControlSource,
    devices: List<AccountDeviceUi>,
    selectedDeviceId: String?,
    deviceName: String,
    remoteState: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    selectedSessionId: String?,
    onConnect: () -> Unit,
    onRetryActive: () -> Unit,
    onRefreshDevices: () -> Unit,
    refreshingDevices: Boolean,
    directoryRefreshError: String? = null,
    onSelectDevice: (String) -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenActions: (RemoteSidebarSessionRow, IntRect) -> Unit,
    onCreateInWorkspace: (String, String?, String?, String) -> Unit,
    onOpenWorkspace: (String) -> Unit,
    onAddWorkspace: (() -> Unit)? = null,
    onWorkspaceTool: (String, String?, Boolean) -> Unit,
) {
    val connected = ConnectionStatusPresenter.canReachSessions(connectionPhase)
    val refreshDevicesLabel = stringResource(R.string.account_devices_refresh)
    val projectedDevices = devices
    val activeDeviceId = if (controlSource == RemoteControlSource.ACCOUNT_DEVICE) selectedDeviceId else null
    var expandedDeviceIds by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var visibleDeviceCount by rememberSaveable { mutableStateOf(DEVICES_PER_BATCH) }
    var cachedRemoteStates by remember {
        mutableStateOf(emptyMap<String, RemoteSessionUiState.Ready>())
    }
    var cachedWorkspaceStates by remember {
        mutableStateOf(emptyMap<String, RemoteWorkspaceUiState.Ready>())
    }

    LaunchedEffect(activeDeviceId, remoteState, workspaceState) {
        activeDeviceId?.let { id ->
            if (id !in expandedDeviceIds) expandedDeviceIds = expandedDeviceIds + id
            (remoteState as? RemoteSessionUiState.Ready)?.let { ready ->
                cachedRemoteStates = cachedRemoteStates + (id to ready)
            }
            (workspaceState as? RemoteWorkspaceUiState.Ready)?.let { ready ->
                cachedWorkspaceStates = cachedWorkspaceStates + (id to ready)
            }
        }
    }

    Column(modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().height(38.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.sidebar_devices),
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Box(Modifier.weight(1f))
            if (!connected && projectedDevices.isEmpty()) {
                Text(
                    stringResource(R.string.sidebar_workspaces_offline),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.padding(end = 8.dp),
                )
            }
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .clickable(enabled = !refreshingDevices, role = Role.Button, onClick = onRefreshDevices)
                    .testTag("sidebar-refresh-devices")
                    .semantics(mergeDescendants = true) {
                        contentDescription = refreshDevicesLabel
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (refreshingDevices) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 1.5.dp)
                else Icon(
                    painterResource(R.drawable.ic_symbol_arrow_clockwise),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(17.dp),
                )
            }
        }

        directoryRefreshError?.let { error ->
            Text(error, fontSize = 12.sp, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
                    .clickable(enabled = !refreshingDevices, role = Role.Button, onClick = onRefreshDevices))
        }

        if (projectedDevices.isEmpty()) {
            SidebarActiveDeviceBody(
                connected = connected,
                loading = remoteState is RemoteSessionUiState.Loading ||
                    workspaceState is RemoteWorkspaceUiState.Loading,
                failed = remoteState is RemoteSessionUiState.Failed ||
                    workspaceState is RemoteWorkspaceUiState.Failed,
                deviceKey = deviceName,
                remoteState = remoteState as? RemoteSessionUiState.Ready,
                workspaceState = workspaceState as? RemoteWorkspaceUiState.Ready,
                selectedSessionId = selectedSessionId,
                onConnect = onConnect,
                onRetry = onRetryActive,
                onOpenSession = onOpenSession,
                onOpenActions = onOpenActions,
                canActOnSessions = true,
                onCreateInWorkspace = onCreateInWorkspace,
                onOpenWorkspace = onOpenWorkspace,
                onAddWorkspace = onAddWorkspace,
                onWorkspaceTool = onWorkspaceTool,
            )
        } else {
            projectedDevices.take(visibleDeviceCount).forEach { device ->
                val expanded = device.id in expandedDeviceIds
                val active = device.id == activeDeviceId
                val cachedRemote = cachedRemoteStates[device.id]
                val cachedWorkspace = cachedWorkspaceStates[device.id]
                val shownRemote = if (active) {
                    (remoteState as? RemoteSessionUiState.Ready) ?: cachedRemote
                } else {
                    cachedRemote
                }
                val shownWorkspace = if (active) {
                    (workspaceState as? RemoteWorkspaceUiState.Ready) ?: cachedWorkspace
                } else {
                    cachedWorkspace
                }
                val loading = active && (
                    remoteState is RemoteSessionUiState.Idle ||
                        remoteState is RemoteSessionUiState.Loading ||
                        workspaceState is RemoteWorkspaceUiState.Idle ||
                        workspaceState is RemoteWorkspaceUiState.Loading
                    )
                val failed = active && (
                    remoteState is RemoteSessionUiState.Failed ||
                        workspaceState is RemoteWorkspaceUiState.Failed
                    )
                SidebarDeviceHeader(
                    deviceName = device.name.ifBlank { device.id },
                    online = device.online,
                    selected = active,
                    expanded = expanded,
                    loading = loading,
                    phase = if (active) connectionPhase else null,
                    onToggle = {
                        if (active) {
                            expandedDeviceIds = if (expanded) {
                                expandedDeviceIds - device.id
                            } else {
                                expandedDeviceIds + device.id
                            }
                        } else if (device.online) {
                            activeDeviceId?.let { currentId ->
                                (remoteState as? RemoteSessionUiState.Ready)?.let { ready ->
                                    cachedRemoteStates = cachedRemoteStates + (currentId to ready)
                                }
                                (workspaceState as? RemoteWorkspaceUiState.Ready)?.let { ready ->
                                    cachedWorkspaceStates = cachedWorkspaceStates + (currentId to ready)
                                }
                            }
                            if (!expanded) expandedDeviceIds = expandedDeviceIds + device.id
                            onSelectDevice(device.id)
                        }
                    },
                )
                if (active && connectionPhase in listOf(ConnectionPhase.RECONNECTING, ConnectionPhase.FAILED, ConnectionPhase.DISCONNECTED)) {
                    SidebarConnectionRecovery(connectionPhase, onRetryActive)
                }
                if (expanded) {
                    SidebarActiveDeviceBody(
                        connected = if (active) connected else shownWorkspace != null,
                        loading = loading,
                        failed = failed,
                        deviceKey = device.id,
                        remoteState = shownRemote,
                        workspaceState = shownWorkspace,
                        selectedSessionId = selectedSessionId,
                        onConnect = onConnect,
                        onRetry = { onSelectDevice(device.id) },
                        onOpenSession = onOpenSession,
                        onOpenActions = onOpenActions,
                        canActOnSessions = active,
                        onCreateInWorkspace = onCreateInWorkspace,
                        onOpenWorkspace = onOpenWorkspace,
                onAddWorkspace = onAddWorkspace,
                onWorkspaceTool = onWorkspaceTool,
                    )
                }
            }
            if (visibleDeviceCount < projectedDevices.size) {
                MoreRow(
                    hidden = projectedDevices.size - visibleDeviceCount,
                    startPadding = 10,
                    onClick = { visibleDeviceCount += DEVICES_PER_BATCH },
                    devices = true,
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SidebarActiveDeviceBody(
    connected: Boolean,
    loading: Boolean,
    failed: Boolean,
    deviceKey: String,
    remoteState: RemoteSessionUiState.Ready?,
    workspaceState: RemoteWorkspaceUiState.Ready?,
    selectedSessionId: String?,
    onConnect: () -> Unit,
    onRetry: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenActions: (RemoteSidebarSessionRow, IntRect) -> Unit,
    canActOnSessions: Boolean,
    onCreateInWorkspace: (String, String?, String?, String) -> Unit,
    onOpenWorkspace: (String) -> Unit,
    onAddWorkspace: (() -> Unit)? = null,
    onWorkspaceTool: (String, String?, Boolean) -> Unit,
) {
    val readyWorkspace = workspaceState
    val readySessions = remoteState
    val busy = remoteState?.busy == true
    val entries = remember(readyWorkspace, readySessions) {
        com.openbitfun.mobile.core.feature.shell.RemoteSidebarPresentation.workspaces(readyWorkspace, readySessions)
    }
    var collapsedPaths by rememberSaveable(deviceKey) { mutableStateOf(emptyList<String>()) }
    var expandedSessionPaths by rememberSaveable(deviceKey) { mutableStateOf(emptyList<String>()) }
    var visibleWorkspaceCount by rememberSaveable(deviceKey) {
        mutableStateOf(WORKSPACES_PER_BATCH)
    }

    Row(
        Modifier.fillMaxWidth().padding(top = 16.dp).height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.sidebar_workspaces), fontSize = 14.sp,
            fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f))
        if (onAddWorkspace != null) {
            androidx.compose.material3.IconButton(onClick = onAddWorkspace,
                enabled = connected && canActOnSessions && readyWorkspace != null && !readyWorkspace.busy,
                modifier = Modifier.testTag("sidebar-add-workspace")) {
                Icon(painterResource(R.drawable.ic_symbol_plus),
                    contentDescription = stringResource(R.string.workspace_open_path),
                    modifier = Modifier.size(18.dp))
            }
        }
    }

    if (readyWorkspace?.catalog?.source == com.openbitfun.mobile.core.feature.workspace.WorkspaceCatalogSource.RECENT) {
        Text(
            stringResource(R.string.sidebar_legacy_workspace_catalog),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }

    if (!connected) {
        ConnectDesktopRow(onConnect)
    } else if (failed) {
        DeviceFailedRow(onRetry)
    } else if (loading && entries.isEmpty()) {
        DeviceLoadingRow()
    } else if (entries.isEmpty()) {
        Text(
            stringResource(R.string.sidebar_empty_workspaces),
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(start = 10.dp, top = 6.dp, bottom = 6.dp),
        )
    } else {
        entries.take(visibleWorkspaceCount).forEach { entry ->
            val path = entry.path
            val identityKey = entry.key
            val workspaceSessions = entry.sessions
            val collapsed = identityKey in collapsedPaths
            Column(modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(46.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .combinedClickable(
                            role = Role.Button,
                            onClick = {
                                collapsedPaths = if (collapsed) {
                                    collapsedPaths - identityKey
                                } else {
                                    collapsedPaths + identityKey
                                }
                            },
                            onLongClick = { onOpenWorkspace(path) },
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription = entry.name.ifBlank { path.substringAfterLast('/') }
                        }
                        .padding(start = 10.dp, end = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painterResource(R.drawable.ic_symbol_folder),
                        contentDescription = null,
                        tint = if (entry.selected) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.size(21.dp),
                    )
                    Text(
                        entry.name.ifBlank { path.substringAfterLast('/') },
                        fontSize = 15.sp,
                        fontWeight = if (entry.selected) {
                            FontWeight.Medium
                        } else {
                            FontWeight.Normal
                        },
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    var createMenuOpen by remember(path) { mutableStateOf(false) }
                    ProjectCreateControl(
                        enabled = canActOnSessions && connected,
                        supportsHarnessProfiles = true,
                        modesOnly = true,
                        path = path,
                        expanded = createMenuOpen,
                        onToggle = { createMenuOpen = !createMenuOpen },
                        onDismiss = { createMenuOpen = false },
                        onCreateAgent = { agent -> createMenuOpen = false; onCreateInWorkspace(path, entry.remoteConnectionId, entry.remoteSshHost, agent) },
                    )
                    Icon(
                        painterResource(
                            if (collapsed) R.drawable.ic_symbol_chevron_right
                            else R.drawable.ic_symbol_chevron_down,
                        ),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(13.dp),
                    )
                }

                if (!collapsed) {
                    val limit = if (identityKey in expandedSessionPaths) {
                        workspaceSessions.size
                    } else {
                        SESSIONS_PER_WORKSPACE
                    }
                    workspaceSessions.take(limit).forEach { session ->
                        RemoteSessionRow(
                            session = session,
                            selected = session.id == selectedSessionId,
                            busy = busy,
                            canActOnSessions = canActOnSessions,
                            onOpenSession = onOpenSession,
                            onOpenActions = onOpenActions,
                        )
                    }
                    if (limit < workspaceSessions.size) {
                        MoreRow(
                            hidden = workspaceSessions.size - limit,
                            startPadding = 26,
                            onClick = { expandedSessionPaths = expandedSessionPaths + identityKey },
                        )
                    }
                }
            }
        }
        if (visibleWorkspaceCount < entries.size) {
            MoreRow(
                hidden = entries.size - visibleWorkspaceCount,
                startPadding = 10,
                onClick = { visibleWorkspaceCount += WORKSPACES_PER_BATCH },
                workspaces = true,
            )
        }
        if (loading) DeviceLoadingRow()
    }
}

@Composable
private fun SidebarDeviceHeader(
    deviceName: String,
    online: Boolean,
    selected: Boolean,
    expanded: Boolean,
    loading: Boolean,
    phase: ConnectionPhase? = null,
    onToggle: () -> Unit,
) {
    val deviceLabel = deviceName
    val healthLabel = phase?.let { stringResource(it.labelRes()) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(role = Role.Button, onClick = onToggle)
            .semantics(mergeDescendants = true) {
                contentDescription = deviceLabel
                healthLabel?.let { stateDescription = it }
            }
            .padding(start = 10.dp, end = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_desktop),
            contentDescription = null,
            tint = if (online) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.outline,
            modifier = Modifier.size(21.dp),
        )
        Text(
            deviceName,
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (online) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.outline,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (phase != null) {
            ConnectionDot(phase)
        } else if (!online) {
            Text(
                stringResource(R.string.sidebar_device_offline),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        if (loading) {
            CircularProgressIndicator(
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                strokeWidth = 1.5.dp,
                modifier = Modifier.size(14.dp),
            )
        }
        Icon(
            painterResource(
                if (expanded) R.drawable.ic_symbol_chevron_down
                else R.drawable.ic_symbol_chevron_right,
            ),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(13.dp),
        )
    }
}

@Composable
internal fun SidebarConnectionRecovery(phase: ConnectionPhase, onRetry: () -> Unit) {
    val retryLabel = stringResource(R.string.sidebar_device_retry)
    Row(
        modifier = Modifier.fillMaxWidth().height(44.dp).padding(start = 10.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(phase.labelRes()), fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        IconButton(onClick = onRetry, modifier = Modifier.size(44.dp).testTag("sidebar-retry-connection")) {
            Icon(painterResource(R.drawable.ic_symbol_arrow_clockwise), contentDescription = retryLabel,
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
private fun DeviceLoadingRow() {
    Row(
        modifier = Modifier.fillMaxWidth().height(40.dp).padding(start = 10.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            strokeWidth = 1.5.dp,
            modifier = Modifier.size(14.dp),
        )
        Text(
            stringResource(R.string.sidebar_device_loading),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DeviceFailedRow(onRetry: () -> Unit) {
    val retryLabel = stringResource(R.string.sidebar_device_retry)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .padding(start = 10.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.sidebar_device_load_failed),
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Text(
            retryLabel,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .clickable(role = Role.Button, onClick = onRetry)
                .semantics { contentDescription = retryLabel },
        )
    }
}

@Composable
private fun ConnectDesktopRow(onConnect: () -> Unit) {
    val connectLabel = stringResource(R.string.sidebar_connect_desktop)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(RoundedCornerShape(10.dp))
            .clickable(role = Role.Button, onClick = onConnect)
            .semantics(mergeDescendants = true) {
                contentDescription = connectLabel
            }
            .padding(start = 10.dp, end = 8.dp)
            .testTag(SIDEBAR_CODE_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_desktop),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
        Text(
            connectLabel,
            fontSize = 15.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Icon(
            painterResource(R.drawable.ic_symbol_chevron_right),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(13.dp),
        )
    }
}

@Composable
private fun RemoteSessionRow(
    session: RemoteSidebarSessionRow,
    selected: Boolean,
    busy: Boolean,
    canActOnSessions: Boolean,
    onOpenSession: (String) -> Unit,
    onOpenActions: (RemoteSidebarSessionRow, IntRect) -> Unit,
) {
    var anchorBounds by remember { mutableStateOf(IntRect.Zero) }
    val sessionTitle = session.title.ifBlank { stringResource(R.string.sidebar_untitled) }
    val icon = when (session.agentType.lowercase()) {
        "code" -> R.drawable.ic_symbol_code_square
        "claw", "assistant", "chat" -> R.drawable.ic_symbol_message
        else -> R.drawable.ic_symbol_doc_text
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else openBitFunColors.transparent)
            .onGloballyPositioned { coordinates ->
                anchorBounds = coordinates.boundsInWindow().toIntRect()
            }
            .combinedClickable(
                enabled = !busy,
                role = Role.Button,
                onClick = { onOpenSession(session.id) },
                onLongClick = if (canActOnSessions) {
                    { onOpenActions(session, anchorBounds) }
                } else {
                    null
                },
            )
            .semantics(mergeDescendants = true) {
                contentDescription = sessionTitle
            }
            .padding(start = 26.dp, end = 4.dp)
            .testTag(SIDEBAR_REMOTE_SESSION_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(19.dp),
        )
        Text(
            sessionTitle,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (canActOnSessions) {
            IconButton(
                enabled = !busy,
                onClick = { onOpenActions(session, anchorBounds) },
            ) {
                Icon(
                    painterResource(R.drawable.ic_symbol_ellipsis),
                    contentDescription = stringResource(R.string.session_actions),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

private fun Rect.toIntRect(): IntRect = IntRect(
    left = left.toInt(),
    top = top.toInt(),
    right = right.toInt(),
    bottom = bottom.toInt(),
)

@Composable
private fun MoreRow(
    hidden: Int,
    startPadding: Int,
    onClick: () -> Unit,
    workspaces: Boolean = false,
    devices: Boolean = false,
) {
    val moreLabel = stringResource(
        when {
            devices -> R.string.sidebar_more_devices
            workspaces -> R.string.sidebar_more_workspaces
            else -> R.string.sessions_show_more
        },
        hidden,
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = moreLabel
            }
            .padding(start = startPadding.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            moreLabel,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
