package com.openbitfun.mobile.app.ui.shell.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.remote.SessionActionPopup
import com.openbitfun.mobile.app.ui.remote.SessionActionSheet
import com.openbitfun.mobile.app.ui.remote.SessionDetailsSheet
import com.openbitfun.mobile.core.feature.account.AccountDeviceUi
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.connection.RemoteControlSource
import com.openbitfun.mobile.core.feature.session.SessionActionPolicy
import com.openbitfun.mobile.core.feature.session.SessionActionScope
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryUiState
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.shell.RemoteSidebarSessionRow
import com.openbitfun.mobile.core.feature.shell.RemoteSidebarWorkspaceRow
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

internal const val SIDEBAR_TEST_TAG: String = "app-sidebar"

/** Tagged because "Code" also labels the session-list filter on the remote screen. */
internal const val SIDEBAR_CODE_TEST_TAG: String = "app-sidebar-code"

/**
 * The drawer, ported from `pages/components/AppSidebar.ets`.
 *
 * The header, the source nav row and the footer are the same in every state so
 * that signing in, or switching what the content area shows, never moves the
 * shared chrome. Which half of the header and footer renders is decided by
 * [accountUserId], exactly as `isAccountAuthenticated` decides it there.
 *
 * The per-row menu is hoisted here rather than into each row: only one row's menu
 * can be open at a time, and holding that as one nullable id is what lets the
 * open row stay highlighted underneath the sheet.
 */
@Composable
internal fun AppSidebar(
    permanent: Boolean,
    sessionDetailsPlacement: SettingsPlacement,
    accountUserId: String?,
    connectionPhase: ConnectionPhase,
    remoteControlSource: RemoteControlSource,
    remoteDevices: List<AccountDeviceUi>,
    remoteSelectedDeviceId: String?,
    remoteDeviceName: String,
    remoteState: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    workspaceDirectory: WorkspaceSessionDirectoryUiState,
    remoteActive: Boolean,
    remoteSelectedSessionId: String?,
    query: String,
    searchOpen: Boolean,
    onQueryChange: (String) -> Unit,
    onToggleSearch: () -> Unit,
    onScanDesktop: () -> Unit,
    onRetryRemoteDevice: () -> Unit,
    onRefreshRemoteDevices: () -> Unit,
    refreshingRemoteDevices: Boolean,
    directoryRefreshError: String? = null,
    onSelectRemoteDevice: (String) -> Unit,
    onOpenRemoteSession: (String) -> Unit,
    onCreateRemoteInWorkspace: (RemoteSidebarWorkspaceRow, String) -> Unit,
    onOpenRemoteWorkspace: (RemoteSidebarWorkspaceRow) -> Unit,
    onExpandRemoteWorkspace: (RemoteSidebarWorkspaceRow) -> Unit,
    onRetryRemoteWorkspaceSessions: (RemoteSidebarWorkspaceRow) -> Unit,
    onAddRemoteWorkspace: (() -> Unit)? = null,
    onWorkspaceTool: (String, String?, Boolean) -> Unit,
    onDeleteRemoteSession: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenAccount: () -> Unit,
    modifier: Modifier,
) {
    val signedIn = !accountUserId.isNullOrBlank()
    var remoteActionSession by remember { mutableStateOf<RemoteSidebarSessionRow?>(null) }
    var remoteActionAnchor by remember { mutableStateOf(IntRect.Zero) }
    var remoteDetailsSessionId by rememberSaveable { mutableStateOf<String?>(null) }

    Box(modifier = modifier.fillMaxSize().testTag(SIDEBAR_TEST_TAG)) {
        // No spacedBy: the MiniApps row carries its own 4dp/8dp rhythm, and a
        // column-level gap on top of it would push the section header away.
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 20.dp, end = 20.dp, top = 0.dp, bottom = 16.dp),
        ) {
            if (signedIn) {
                SidebarAuthenticatedHeader(searchOpen, query, onQueryChange, onToggleSearch)
            } else {
                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
            }

            com.openbitfun.mobile.app.ui.miniapps.MiniAppsButton(sidebar = true)

            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 142.dp)) {
                    SidebarRemoteWorkspaceSection(
                        connectionPhase = connectionPhase,
                        controlSource = remoteControlSource,
                        devices = remoteDevices,
                        selectedDeviceId = remoteSelectedDeviceId,
                        deviceName = remoteDeviceName,
                        remoteState = remoteState,
                        workspaceState = workspaceState,
                        workspaceDirectory = workspaceDirectory,
                        selectedSessionId = remoteSelectedSessionId.takeIf { remoteActive },
                        onConnect = onScanDesktop,
                        onRetryActive = onRetryRemoteDevice,
                        onRefreshDevices = onRefreshRemoteDevices,
                        refreshingDevices = refreshingRemoteDevices,
                        directoryRefreshError = directoryRefreshError,
                        onSelectDevice = onSelectRemoteDevice,
                        onOpenSession = onOpenRemoteSession,
                        onOpenActions = { row, anchor ->
                            remoteActionAnchor = anchor
                            remoteActionSession = row
                        },
                        onCreateInWorkspace = onCreateRemoteInWorkspace,
                        onOpenWorkspace = onOpenRemoteWorkspace,
                        onExpandWorkspace = onExpandRemoteWorkspace,
                        onRetryWorkspaceSessions = onRetryRemoteWorkspaceSessions,
                        onAddWorkspace = onAddRemoteWorkspace,
                        onWorkspaceTool = onWorkspaceTool,
                    )
            }

        }

        // Over the list, not after it: the 84dp tail the list reserves is what
        // keeps the last conversation from ending up underneath this.
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
        ) {
            if (signedIn) {
                SidebarAuthenticatedFooter({ onWorkspaceTool("", null, false) }, onOpenSettings)
            } else {
                SidebarSignedOutFooter(
                    showScan = connectionPhase != ConnectionPhase.CONNECTED,
                    onScanDesktop = onScanDesktop,
                    onOpenAccount = onOpenAccount,
                )
            }
        }
    }

    remoteActionSession?.let { session ->
        val busy = (remoteState as? RemoteSessionUiState.Ready)?.busy == true
        val capabilities = SessionActionPolicy.resolve(
            SessionActionScope.REMOTE,
            session.agentType,
            busy,
        )
        if (permanent) {
            SessionActionPopup(
                anchorBounds = remoteActionAnchor,
                title = session.title,
                status = "",
                capabilities = capabilities,
                onViewDetails = { remoteDetailsSessionId = session.id },
                onDelete = { onDeleteRemoteSession(session.id) },
                onDismiss = { remoteActionSession = null },
            )
        } else {
            SessionActionSheet(
                title = session.title,
                status = "",
                capabilities = capabilities,
                onViewDetails = { remoteDetailsSessionId = session.id },
                onDelete = { onDeleteRemoteSession(session.id) },
                onDismiss = { remoteActionSession = null },
            )
        }
    }

    remoteDetailsSessionId?.let { id ->
        val session = (remoteState as? RemoteSessionUiState.Ready)?.sessions
            ?.firstOrNull { it.id == id }
        if (session == null) {
            remoteDetailsSessionId = null
            return@let
        }
        SessionDetailsSheet(
            title = session.title,
            agentType = session.agentType,
            status = session.status,
            workspaceName = session.workspaceName,
            workspacePath = session.workspacePath,
            createdAt = session.createdAt,
            updatedAt = session.updatedAt,
            messageCount = session.messageCount,
            placement = sessionDetailsPlacement,
            onDismiss = { remoteDetailsSessionId = null },
        )
    }

}
