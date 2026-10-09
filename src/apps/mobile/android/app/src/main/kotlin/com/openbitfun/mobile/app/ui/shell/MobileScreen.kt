package com.openbitfun.mobile.app.ui.shell

import com.openbitfun.mobile.app.ui.account.messageRes
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PermanentDrawerSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScaffoldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.platform.rememberWindowMetrics
import com.openbitfun.mobile.app.state.MobileSurface
import com.openbitfun.mobile.app.state.rememberAppShellState
import com.openbitfun.mobile.app.ui.account.AccountLoginScreen
import com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface
import com.openbitfun.mobile.app.ui.remote.AccountRemoteScreen
import com.openbitfun.mobile.app.ui.remote.ConnectAccountDeviceScreen
import com.openbitfun.mobile.app.ui.remote.FilePreviewSurface
import com.openbitfun.mobile.app.ui.settings.SettingsScreen
import com.openbitfun.mobile.app.ui.shell.sidebar.AppSidebar
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.app.viewmodel.AccountViewModel
import com.openbitfun.mobile.core.feature.account.AccountIntent
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.connection.RemoteControlPresenter
import com.openbitfun.mobile.core.feature.connection.RemoteControlSource
import com.openbitfun.mobile.core.feature.connection.allowsRemoteCommands
import com.openbitfun.mobile.core.feature.layout.ConversationLayoutPolicy
import com.openbitfun.mobile.core.feature.layout.AdaptiveLayoutInput
import com.openbitfun.mobile.core.feature.layout.FilePreviewPlacement
import com.openbitfun.mobile.core.feature.layout.FilePreviewPlacementPolicy
import com.openbitfun.mobile.core.feature.layout.SettingsPlacementPolicy
import com.openbitfun.mobile.core.feature.layout.SettingsSheetKind
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.WorkspaceSessionDirectoryUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteFilePreviewUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

internal const val MENU_TEST_TAG: String = "shell-menu"

/** Present only while the sidebar is permanent, which is the whole assertion. */
internal const val MASTER_DETAIL_TEST_TAG: String = "shell-master-detail"

/**
 * Keeps the detail pane's content off a hinge it would otherwise be laid across.
 *
 * The policy answers in window coordinates; the padding here is what that offset
 * is once the master pane has already taken its own width. A flat screen asks
 * for no padding at all, and so does a fold that falls behind the master pane —
 * in both cases the pane is its own content.
 */
private fun Modifier.dodgingCrease(
    paneWidth: Int,
    contentOffset: Int,
    contentWidth: Int,
): Modifier {
    if (contentWidth <= 0) return this
    val leading = contentOffset.coerceAtLeast(0)
    val trailing = (paneWidth - contentOffset - contentWidth).coerceAtLeast(0)
    if (leading == 0 && trailing == 0) return this
    return padding(start = leading.dp, end = trailing.dp)
}

/**
 * What goes between two panes.
 *
 * A hinge is already a seam, so nothing is drawn on one; a flat window gets the
 * hairline the policy did not reserve room for, out of the pane that can spare it.
 */
@Composable
private fun PaneSeparator(gapWidth: Int) {
    if (gapWidth > 0) Spacer(Modifier.width(gapWidth.dp)) else VerticalDivider(Modifier.fillMaxHeight())
}

/**
 * The app shell: a drawer beside the content, with settings and the account as
 * sheets over it. Ported from `pages/components/AppShell.ets`.
 *
 * Both view models are resolved here as well as inside their screens; they are
 * activity-scoped, so this is the same instance and not a second store. Reading
 * them at the shell is what lets the drawer show connection state and decide
 * between its signed-in and signed-out chrome, and it is also why swapping the
 * content surface cannot drop an open conversation — the timeline lives in the
 * view model, not in the composable that was removed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MobileScreen(onAccountRestored: (Boolean) -> Unit = {}) {
    var compactDrawerOpen by rememberSaveable { mutableStateOf(false) }
    val shell = rememberAppShellState()

    val accountViewModel: AccountViewModel = viewModel(factory = AccountViewModel.Factory)
    val accountWorkspaceState by accountViewModel.workspaceState.collectAsStateWithLifecycle()
    val accountState by accountViewModel.state.collectAsStateWithLifecycle()
    val accountRemoteState by accountViewModel.remoteState.collectAsStateWithLifecycle()
    val accountPhase by accountViewModel.connectionPhase.collectAsStateWithLifecycle()
    val accountWorkspaceDirectory by accountViewModel.workspaceDirectory.collectAsStateWithLifecycle()
    val readyAccount = accountState as? AccountUiState.Ready
    LaunchedEffect(accountPhase, shell.remoteCreating) {
        // A create failure is terminal for the creation route. The shared
        // store keeps the last valid session projection so returning to the
        // remote home here restores the same pre-create route as Harmony and
        // iOS, while the store's typed create error remains available to the
        // surface-level error/toast handling.
        if (shell.remoteCreating && accountPhase == ConnectionPhase.FAILED) {
            shell.closeRemoteSession()
        }
    }
    LaunchedEffect(accountState) {
        if (accountState !is AccountUiState.Idle && accountState !is AccountUiState.Restoring) {
            onAccountRestored(readyAccount?.userId?.isNotBlank() == true)
        }
    }
    // Login is its own sheet only while it is running. Once the account is
    // ready it shows inside settings, so the sheet hands the user over there.
    LaunchedEffect(shell.showAccount, readyAccount != null) {
        if (shell.showAccount && readyAccount != null) shell.completeLogin()
    }
    // A connect sheet restored from before sign-out has no picker to show; drop
    // it once the account has settled as signed out rather than reopen it later.
    LaunchedEffect(shell.remoteConnectOpen, accountState) {
        if (shell.remoteConnectOpen && (accountState is AccountUiState.SignedOut || accountState is AccountUiState.Failed)) {
            shell.closeRemoteConnect()
        }
    }

    val accountUserId = readyAccount?.userId
    val controlSummary = remember(readyAccount, accountPhase) {
        RemoteControlPresenter.summarize(
            accountDeviceId = readyAccount?.selectedDeviceId.orEmpty(),
            accountDeviceName = readyAccount?.selectedDeviceName.orEmpty(),
            accountPhase = accountPhase,
        )
    }
    val phase = controlSummary.phase
    val activeWorkspaceState = when (controlSummary.source) {
        RemoteControlSource.ACCOUNT_DEVICE -> accountWorkspaceState
        RemoteControlSource.NONE -> RemoteWorkspaceUiState.Idle
    }
    val activeRemoteState = when (controlSummary.source) {
        RemoteControlSource.ACCOUNT_DEVICE -> accountRemoteState
        RemoteControlSource.NONE -> RemoteSessionUiState.Idle
    }
    val committedRemoteSessions = (activeRemoteState as? RemoteSessionUiState.Ready)?.sessions.orEmpty()
    // Shell navigation is only a transient request while the shared store
    // catches up. Once a delete succeeds the row disappears, which invalidates
    // a stale shell request and lets the store's selection take over.
    val routedSessionId = shell.remoteSessionId
        ?.takeIf { requested -> committedRemoteSessions.any { it.id == requested } }
        ?: (activeRemoteState as? RemoteSessionUiState.Ready)?.selectedSessionId
    val activeWorkspaceDirectory = when (controlSummary.source) {
        RemoteControlSource.ACCOUNT_DEVICE -> accountWorkspaceDirectory
        RemoteControlSource.NONE -> WorkspaceSessionDirectoryUiState(emptyList())
    }

    fun dispatchActiveWorkspace(intent: RemoteWorkspaceIntent) {
        when (controlSummary.source) {
            RemoteControlSource.ACCOUNT_DEVICE -> accountViewModel.dispatchWorkspace(intent)
            RemoteControlSource.NONE -> Unit
        }
    }

    // Full-screen previews replace the conversation composition. Keep the
    // platform document launcher alive across both presentation surfaces.
    com.openbitfun.mobile.app.ui.remote.RemoteDownloadSaver(activeWorkspaceState, ::dispatchActiveWorkspace)

    fun dispatchActiveSession(intent: RemoteSessionIntent) {
        when (controlSummary.source) {
            RemoteControlSource.ACCOUNT_DEVICE -> accountViewModel.dispatchSession(intent)
            RemoteControlSource.NONE -> Unit
        }
    }

    fun closeDrawer() {
        // A no-op while the sidebar is permanent, which is why the sidebar's
        // callbacks are the same lambdas in both shapes: only the container that
        // holds it changes, not what its rows do.
        compactDrawerOpen = false
    }

    // Whether there is room for the sidebar to stay. The policy is the same one
    // `AppRootPresentation.ets` asks, given the same three facts.
    val window = rememberWindowMetrics()
    val layoutCreases = if (window.isFolded || window.isHoverLayout) {
        emptyList()
    } else {
        ConversationLayoutPolicy.effectiveVerticalCreases(
            viewportWidth = window.widthDp,
            creases = window.creases,
            synthesizeCenterHinge = window.isExpandedFoldable,
        )
    }
    val wide = ConversationLayoutPolicy.useMasterDetail(
        viewportWidth = window.widthDp,
        wideViewportMatched = window.wideViewportMatched,
        isFolded = window.isFolded,
        creases = layoutCreases,
        isExpandedFoldable = window.isExpandedFoldable,
        isHover = window.isHoverLayout,
    )
    val geometry = ConversationLayoutPolicy.resolveWideGeometry(window.widthDp, layoutCreases)
    val adaptiveLayoutInput = AdaptiveLayoutInput(
        viewportWidth = window.widthDp,
        viewportHeight = window.heightDp,
        isFolded = window.isFolded,
        isExpandedFoldable = window.isExpandedFoldable,
        isHoverOperate = window.isHoverLayout,
        wideLayoutMatched = window.wideViewportMatched,
        verticalCreases = window.creases,
        horizontalCreases = window.horizontalCreases,
        isRtl = LocalLayoutDirection.current == LayoutDirection.Rtl,
    )
    val settingsPlacement = SettingsPlacementPolicy.resolve(
        adaptiveLayoutInput,
        SettingsSheetKind.SETTINGS,
    )
    val connectPlacement = SettingsPlacementPolicy.resolve(adaptiveLayoutInput, SettingsSheetKind.CONNECT)
    val sessionDetailsPlacement = SettingsPlacementPolicy.resolve(
        adaptiveLayoutInput,
        SettingsSheetKind.SESSION_DETAILS,
    )
    val remoteViewSettingsPlacement = SettingsPlacementPolicy.resolve(
        adaptiveLayoutInput,
        SettingsSheetKind.REMOTE_VIEW_SETTINGS,
    )

    // A file the agent referenced is the third thing that wants the window, and
    // the one that decides whether the other two still fit. Only the remote
    // surface has one to place: a file opened from the account sheet belongs to
    // that sheet's own store and stays inside it.
    val preview = (activeWorkspaceState as? RemoteWorkspaceUiState.Ready)?.preview
    val previewVisible = shell.surface == MobileSurface.REMOTE &&
        preview != null && preview !is RemoteFilePreviewUiState.None
    val previewLayout = FilePreviewPlacementPolicy.resolveLayout(
        previewVisible = previewVisible,
        largeScreenLayout = wide,
        viewportWidth = window.widthDp,
        creases = layoutCreases,
        // So the list does not jump sideways the moment a file opens beside it.
        preferredMasterWidth = geometry.masterPaneWidth,
    )
    val sidebarWidth = when {
        !wide -> 0
        previewLayout.placement == FilePreviewPlacement.Hidden -> geometry.masterPaneWidth
        // A focus split gave the list's room to the file; a full-page preview
        // never had room for either.
        else -> previewLayout.masterPaneWidth
    }
    // Match `AppShell.sidebarWidth()` for the compact drawer. Material's
    // default drawer is 360dp, which is visibly wider than Harmony's 280dp
    // sidebar on a normal phone window.
    val compactDrawerWidth = minOf(280, maxOf(220, (window.widthDp * 0.68f).toInt()))
    // The button and the pane are the same sidebar; exactly one of them is real.
    val showMenu = sidebarWidth == 0

    // Persist the owner with the visibility flag: rememberSaveable inputs alone
    // do not validate the identity of restored values after recreation.
    val workspacePickerOwner = listOf(readyAccount?.relayUrl.orEmpty(), readyAccount?.userId.orEmpty(),
        readyAccount?.selectedDeviceId.orEmpty(), controlSummary.source.name)
    var workspacePickerSavedOwner by rememberSaveable { mutableStateOf(workspacePickerOwner) }
    var workspacePickerOpen by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(workspacePickerOwner) {
        if (workspacePickerSavedOwner != workspacePickerOwner) {
            workspacePickerOpen = false
            workspacePickerSavedOwner = workspacePickerOwner
        }
    }
    if (workspacePickerOpen && workspacePickerSavedOwner == workspacePickerOwner) {
        (activeWorkspaceState as? RemoteWorkspaceUiState.Ready)?.let { ready ->
            com.openbitfun.mobile.app.ui.remote.RuntimeWorkspacePickerDialog(
                ready, ::dispatchActiveWorkspace, { workspacePickerOpen = false },
            )
        }
    }
    (activeWorkspaceState as? RemoteWorkspaceUiState.Ready)?.let { ready ->
        if (ready.deviceTools.visible) com.openbitfun.mobile.app.ui.remote.DeviceToolsDialog(ready, ::dispatchActiveWorkspace)
    }
    val sidebar: @Composable () -> Unit = {
        AppSidebar(
            permanent = sidebarWidth > 0,
            sessionDetailsPlacement = sessionDetailsPlacement,
            accountUserId = accountUserId,
            connectionPhase = phase,
            remoteControlSource = controlSummary.source,
            remoteDevices = readyAccount?.devices.orEmpty(),
            remoteSelectedDeviceId = readyAccount?.selectedDeviceId
                .takeIf { controlSummary.source == RemoteControlSource.ACCOUNT_DEVICE },
            remoteDeviceName = controlSummary.desktopName,
            remoteState = activeRemoteState,
            workspaceState = activeWorkspaceState,
            workspaceDirectory = activeWorkspaceDirectory,
            remoteActive = shell.surface == MobileSurface.REMOTE,
            // The session store owns selection. The shell only owns the
            // container route, so deleting the active row clears this value
            // without leaving a stale requested session behind.
            remoteSelectedSessionId = routedSessionId,
            query = shell.sidebarQuery,
            searchOpen = shell.searchOpen,
            onQueryChange = shell::search,
            onToggleSearch = shell::toggleSearch,
            onConnectDesktop = {
                // Desktops are reached only through the account: signed in, the
                // row opens the account's device picker; signed out, login.
                if (readyAccount != null) shell.openRemoteConnect() else shell.openAccount(signedIn = false)
                closeDrawer()
            },
            onRefreshRemoteDevices = { accountViewModel.dispatch(AccountIntent.RefreshDevices) },
            refreshingRemoteDevices = readyAccount?.refreshing == true,
            directoryRefreshError = readyAccount?.refreshFailure?.let { stringResource(it.messageRes()) },
            onRetryRemoteDevice = {
                dispatchActiveSession(RemoteSessionIntent.Load)
                dispatchActiveWorkspace(RemoteWorkspaceIntent.Load)
            },
            onSelectRemoteDevice = { deviceId ->
                accountViewModel.selectDevice(deviceId)
                shell.show(MobileSurface.REMOTE)
                shell.closeRemoteSession()
            },
            onOpenRemoteSession = { sessionId ->
                shell.openRemoteSession(sessionId)
                closeDrawer()
                dispatchActiveSession(RemoteSessionIntent.Open(sessionId))
            },
            onCreateRemoteInWorkspace = { workspace, agentType ->
                // Workspace quick-create used to dispatch directly while the
                // shell still rendered the home surface, so its committed
                // session had no creation route callback. Enter the same
                // creation route as the global new-session action first.
                shell.createRemoteSession()
                // With an ID the create carries only the ID; the legacy triple is for pre-ID rows.
                dispatchActiveSession(
                    RemoteSessionIntent.CreateSession(
                        agentType = agentType,
                        title = "",
                        instruction = "",
                        modelId = null,
                        workspacePath = workspace.path,
                        remoteConnectionId = workspace.remoteConnectionId,
                        remoteSshHost = workspace.remoteSshHost,
                        workspaceId = workspace.workspaceId,
                    ),
                )
                closeDrawer()
            },
            onWorkspaceTool = { path, connectionId, terminal ->
                dispatchActiveWorkspace(RemoteWorkspaceIntent.OpenDeviceTools(path, connectionId))
                if (terminal) dispatchActiveWorkspace(RemoteWorkspaceIntent.SelectDeviceToolsPanel(com.openbitfun.mobile.core.feature.workspace.DeviceToolsPanel.TERMINAL))
                closeDrawer()
            },
            onAddRemoteWorkspace = { workspacePickerOpen = true },
            onOpenRemoteWorkspace = { workspace ->
                dispatchActiveWorkspace(RemoteWorkspaceIntent.SelectWorkspace(workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, false, workspace.workspaceId))
                shell.show(MobileSurface.REMOTE)
                shell.closeRemoteSession()
                closeDrawer()
            },
            onExpandRemoteWorkspace = { workspace ->
                // The branch is loaded by workspace ID; the legacy triple only serves pre-ID rows.
                dispatchActiveSession(
                    RemoteSessionIntent.LoadWorkspaceSessions(
                        workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId,
                    ),
                )
            },
            onRetryRemoteWorkspaceSessions = { workspace ->
                dispatchActiveSession(
                    RemoteSessionIntent.RetryWorkspaceSessions(
                        workspace.path, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId,
                    ),
                )
            },
            onDeleteRemoteSession = { id -> dispatchActiveSession(RemoteSessionIntent.DeleteSession(id)) },
            onOpenSettings = {
                // The gear and the remote home header open the same page.
                shell.openSettings()
                closeDrawer()
            },
            onOpenAccount = {
                shell.openAccount(signedIn = readyAccount != null)
                closeDrawer()
            },
            modifier = Modifier,
        )
    }

    val content: @Composable () -> Unit = {
        if (controlSummary.source == RemoteControlSource.NONE && readyAccount == null) {
            // The compact signed-out welcome surface owns the full window,
            // including the gesture/navigation area. Keeping it outside the
            // Scaffold prevents Scaffold's content insets from leaving a
            // platform-colored strip below the welcome dock.
            WelcomeHome(
                signedIn = false,
                onLogin = { shell.openAccount(signedIn = false) },
                modifier = Modifier.fillMaxSize(),
            )
        } else Scaffold(
            // The manifest asks for `adjustResize`, but an edge-to-edge window
            // is never resized by it — the keyboard simply draws on top, and
            // what it draws on top of is the composer. Adding the IME to the
            // insets the content already lifts itself out of is what actually
            // keeps the input bar above the keyboard. `union` rather than a
            // second padding: the IME inset already contains the navigation
            // bar's, and adding them would leave a gap the height of the bar.
            contentWindowInsets = (if (shell.surface == MobileSurface.REMOTE && routedSessionId != null) {
                // The conversation owns the bottom strip: its viewport reaches
                // the screen edge while the fixed composer clears navigation.
                ScaffoldDefaults.contentWindowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
            } else ScaffoldDefaults.contentWindowInsets).union(WindowInsets.ime),
            // HarmonyOS hides the platform title bar. Each product surface owns
            // its 44dp controls and title row, so a Material TopAppBar here would
            // add a second header above every conversation and remote page.
            topBar = {},
        ) { insets ->
            Box(Modifier.padding(insets).consumeWindowInsets(insets)) {
                when (shell.surface) {
                    MobileSurface.REMOTE -> when (controlSummary.source) {
                        RemoteControlSource.ACCOUNT_DEVICE -> AccountRemoteScreen(
                            remoteState = accountRemoteState,
                            workspaceState = accountWorkspaceState,
                            deviceId = readyAccount?.selectedDeviceId.orEmpty(),
                            deviceName = controlSummary.desktopName,
                            createDevices = readyAccount?.devices.orEmpty().map { device ->
                                com.openbitfun.mobile.app.ui.remote.CreateDeviceChoice(
                                    id = device.id,
                                    name = device.name,
                                    online = device.online,
                                    selected = device.id == readyAccount?.selectedDeviceId,
                                )
                            },
                            accountUsername = readyAccount?.username.orEmpty(),
                            attachmentOwner = org.json.JSONArray(listOf(readyAccount?.relayUrl, readyAccount?.username, readyAccount?.selectedDeviceId)).toString(),
                            phase = accountPhase,
                            settingsPlacement = settingsPlacement,
                            sessionDetailsPlacement = sessionDetailsPlacement,
                            viewSettingsPlacement = remoteViewSettingsPlacement,
                            onOpenRemoteSettings = { shell.openSettings() },
                            onCreateDevicePick = accountViewModel::selectDevice,
                            onSessionIntent = accountViewModel::dispatchSession,
                            onWorkspaceIntent = accountViewModel::dispatchWorkspace,
                            onOpenSidebar = if (showMenu) {
                                { compactDrawerOpen = true }
                            } else {
                                null
                            },
                            compact = !wide,
                            requestedSessionId = routedSessionId,
                            creatingSession = shell.remoteCreating,
                            onOpenSession = shell::openRemoteSession,
                            onCreatedSession = { id ->
                                shell.openRemoteSession(id)
                                closeDrawer()
                            },
                            onCreateSession = shell::createRemoteSession,
                            onRemoteHome = shell::closeRemoteSession,
                            modifier = Modifier,
                        )

                        RemoteControlSource.NONE -> if (readyAccount != null) {
                            com.openbitfun.mobile.app.ui.remote.RemoteCompactHome(
                                remoteState = RemoteSessionUiState.Idle,
                                desktopName = "",
                                onOpenSidebar = { compactDrawerOpen = true },
                                onBrowse = { shell.openRemoteConnect() },
                                onOpen = {},
                            )
                        } else WelcomeHome(
                            signedIn = readyAccount != null,
                            onLogin = {
                                if (readyAccount != null) shell.openRemoteConnect() else shell.openAccount(signedIn = false)
                            },
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }

    val previewPane: @Composable () -> Unit = {
        preview?.let { current ->
            FilePreviewSurface(
                preview = current,
                download = (activeWorkspaceState as? RemoteWorkspaceUiState.Ready)?.download
                    ?: RemoteFileDownloadUiState.None,
                remoteAvailable = phase.allowsRemoteCommands(),
                onIntent = ::dispatchActiveWorkspace,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }

    // The drawer wraps both shapes rather than only the compact one: a window
    // that loses its permanent sidebar to a preview still has a menu button, and
    // that button needs something to open.
    LaunchedEffect(showMenu) {
        if (!showMenu) compactDrawerOpen = false
    }
    OpenBitFunCompactDrawer(
        open = showMenu && compactDrawerOpen,
        compact = showMenu,
        drawerWidth = compactDrawerWidth.dp,
        onDismiss = ::closeDrawer,
        drawerContent = {
            Surface(
                color = MaterialTheme.colorScheme.background,
                modifier = Modifier.fillMaxSize().safeDrawingPadding().imePadding(),
            ) { sidebar() }
        },
    ) {
        if (previewLayout.placement == FilePreviewPlacement.CompactFullPage) {
            // Two documents in one phone width is two columns of hyphenation, so
            // the file covers the conversation — the same trade
            // `FilePreviewSurface.ets` makes. Covering the page means covering
            // the app bar with it, so the way out has to be the system's own
            // back gesture as well as the card's button, and the insets the
            // scaffold was applying have to be applied here instead.
            BackHandler {
                dispatchActiveWorkspace(RemoteWorkspaceIntent.DismissPreview)
            }
            Surface(Modifier.fillMaxSize()) {
                Box(Modifier.safeDrawingPadding()) { previewPane() }
            }
        } else {
            Row(Modifier.fillMaxSize()) {
                if (sidebarWidth > 0) {
                    PermanentDrawerSheet(
                        Modifier.width(sidebarWidth.dp).testTag(MASTER_DETAIL_TEST_TAG),
                        // Material fills a drawer sheet from surfaceContainerLow;
                        // the rail paints its own chrome, so the sheet gets out
                        // of the way rather than tinting a second layer under it.
                        drawerContainerColor = openBitFunColors.sidebar.background,
                    ) { sidebar() }
                    PaneSeparator(
                        if (previewVisible) {
                            previewLayout.masterConversationGap
                        } else {
                            geometry.masterDetailGap
                        },
                    )
                }
                if (previewLayout.placement == FilePreviewPlacement.Hidden) {
                    val hasMaster = sidebarWidth > 0
                    Box(
                        Modifier
                            .weight(1f)
                            .dodgingCrease(
                                paneWidth = window.widthDp - sidebarWidth - geometry.masterDetailGap,
                                contentOffset = if (hasMaster) {
                                    geometry.detailContentOffset
                                } else {
                                    geometry.collapsedDetailContentOffset
                                },
                                contentWidth = if (hasMaster) {
                                    geometry.detailContentWidth
                                } else {
                                    geometry.collapsedDetailContentWidth
                                },
                            ),
                    ) { content() }
                } else {
                    Box(Modifier.width(previewLayout.conversationPaneWidth.dp)) { content() }
                    PaneSeparator(previewLayout.conversationPreviewGap)
                    Box(Modifier.width(previewLayout.previewPaneWidth.dp)) { previewPane() }
                }
            }
        }
    }

    // The settings page embeds the account, so it takes these verbs.
    val signInFromSettings: () -> Unit = { shell.openAccount(signedIn = false) }
    val refreshAccountDevices: () -> Unit = { accountViewModel.dispatch(AccountIntent.RefreshDevices) }
    val selectAccountDevice: (String) -> Unit = { deviceId ->
        accountViewModel.selectDevice(deviceId)
        shell.dismissSettings()
        shell.closeRemoteSession()
        shell.show(MobileSurface.REMOTE)
    }
    val signOutFromSettings: () -> Unit = {
        accountViewModel.dispatch(AccountIntent.Logout)
        shell.dismissSettings()
    }
    val settingsContent: @Composable (Modifier) -> Unit = { contentModifier ->
        SettingsScreen(
            modifier = contentModifier,
            account = readyAccount,
            summary = controlSummary,
            // The permission mode belongs to the desktop the summary named, so
            // it has to be asked of that desktop's store — asking another would
            // answer for a connection this page is not describing.
            remoteState = activeRemoteState,
            onSessionIntent = ::dispatchActiveSession,
            onClose = shell::dismissSettings,
            onSignIn = signInFromSettings,
            onRefreshDevices = refreshAccountDevices,
            onSelectDevice = selectAccountDevice,
            onSignOut = signOutFromSettings,
            onDisconnect = { accountViewModel.disconnectDevice() },
            onReconnect = {
                // A device is asked for again, which is the same command its
                // row in the account sends. Nothing re-pairs behind the user's
                // back.
                when (controlSummary.source) {
                    RemoteControlSource.ACCOUNT_DEVICE -> {
                        val deviceId = readyAccount?.selectedDeviceId
                        if (deviceId != null) {
                            accountViewModel.selectDevice(deviceId)
                        }
                    }

                    RemoteControlSource.NONE -> Unit
                }
            },
        )
    }

    // The connect sheet is the account's device picker and nothing else; a
    // signed-out user is sent to login by every entry point instead.
    val connectAccount = readyAccount
    AdaptiveModalSurface(
        visible = shell.remoteConnectOpen && connectAccount != null,
        edgeToEdgeContent = true,
        placement = connectPlacement,
        onDismissRequest = shell::closeRemoteConnect,
    ) { sheetModifier ->
        if (connectAccount != null) {
            ConnectAccountDeviceScreen(
                state = connectAccount,
                onBack = shell::closeRemoteConnect,
                onRefresh = { accountViewModel.dispatch(AccountIntent.RefreshDevices) },
                onSelect = { shell.closeRemoteConnect(); accountViewModel.selectDevice(it) },
                modifier = sheetModifier,
            )
        }
    }
    AdaptiveModalSurface(
        visible = shell.showSettings,
        placement = settingsPlacement,
        onDismissRequest = shell::dismissSettings,
        // The settings body is one long scroll, so a pull-down has to scroll it
        // rather than drag the page away. The page closes through its own close
        // button, the back action, and a tap on the scrim.
        draggable = false,
        content = settingsContent,
    )
    AdaptiveModalSurface(
        visible = shell.showAccount,
        fitContent = true,
        placement = settingsPlacement,
        onDismissRequest = shell::dismissAccount,
    ) { modifier ->
        AccountLoginScreen(
            modifier = modifier,
            onBack = shell::dismissAccount,
            viewModel = accountViewModel,
        )
    }
}
