package com.openbitfun.mobile.app.ui.shell

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
import com.openbitfun.mobile.app.state.SettingsMode
import com.openbitfun.mobile.app.state.rememberAppShellState
import com.openbitfun.mobile.app.ui.account.AccountScreen
import com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface
import com.openbitfun.mobile.app.ui.remote.AccountRemoteScreen
import com.openbitfun.mobile.app.ui.remote.ConnectAccountDeviceScreen
import com.openbitfun.mobile.app.ui.remote.FilePreviewSurface
import com.openbitfun.mobile.app.ui.remote.ConnectView
import com.openbitfun.mobile.app.ui.settings.GeneralSettingsScreen
import com.openbitfun.mobile.app.ui.settings.SettingsScreen
import com.openbitfun.mobile.app.ui.shell.sidebar.AppSidebar
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
internal fun MobileScreen() {
    var compactDrawerOpen by rememberSaveable { mutableStateOf(false) }
    val shell = rememberAppShellState()

    val accountViewModel: AccountViewModel = viewModel(factory = AccountViewModel.Factory)
    val accountWorkspaceState by accountViewModel.workspaceState.collectAsStateWithLifecycle()
    val accountState by accountViewModel.state.collectAsStateWithLifecycle()
    val accountRemoteState by accountViewModel.remoteState.collectAsStateWithLifecycle()
    val accountPhase by accountViewModel.connectionPhase.collectAsStateWithLifecycle()
    val readyAccount = accountState as? AccountUiState.Ready
    val linkContext = androidx.compose.ui.platform.LocalContext.current
    var pendingDeviceLink by rememberSaveable { mutableStateOf<String?>(null) }
    val connectDeviceLink: (String) -> Unit = { url ->
        val result = com.openbitfun.mobile.core.feature.account.resolveAccountDeviceLink(url, accountState)
        when (result.status) {
            com.openbitfun.mobile.core.feature.account.AccountDeviceLinkStatus.READY -> {
                pendingDeviceLink = null
                accountViewModel.selectDevice(result.deviceId!!)
                shell.closeRemoteConnect()
            }
            com.openbitfun.mobile.core.feature.account.AccountDeviceLinkStatus.SIGN_IN_REQUIRED -> {
                pendingDeviceLink = url
                accountViewModel.dispatch(com.openbitfun.mobile.core.feature.account.AccountIntent.SelectRelay(result.relayUrl!!))
                shell.closeRemoteConnect()
                shell.openAccount()
            }
            else -> {
                pendingDeviceLink = null
                android.widget.Toast.makeText(linkContext,
                    linkContext.getString(if (result.status == com.openbitfun.mobile.core.feature.account.AccountDeviceLinkStatus.INVALID)
                        R.string.account_device_link_invalid else R.string.account_device_link_unavailable),
                    android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    LaunchedEffect(readyAccount) {
        if (readyAccount != null) pendingDeviceLink?.let(connectDeviceLink)
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

    fun dispatchActiveWorkspace(intent: RemoteWorkspaceIntent) {
        when (controlSummary.source) {
            RemoteControlSource.ACCOUNT_DEVICE -> accountViewModel.dispatchWorkspace(intent)
            RemoteControlSource.NONE -> Unit
        }
    }

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
            remoteActive = shell.surface == MobileSurface.REMOTE,
            remoteSelectedSessionId = shell.remoteSessionId,
            query = shell.sidebarQuery,
            searchOpen = shell.searchOpen,
            onQueryChange = shell::search,
            onToggleSearch = shell::toggleSearch,
            onScanDesktop = {
                // The sidebar row opens the choose-connection page, not the
                // camera: ML Kit's scanner is a full-screen system activity, so
                // launching it from the drawer would leave the user no way to
                // pick "scan" vs "sign in" and would cover the app on every tap.
                shell.openRemoteConnect()
                closeDrawer()
            },
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
                dispatchActiveSession(RemoteSessionIntent.Open(sessionId))
                shell.openRemoteSession(sessionId)
                closeDrawer()
            },
            onCreateRemoteInWorkspace = { path, agentType ->
                dispatchActiveSession(
                    RemoteSessionIntent.CreateSession(
                        agentType = agentType,
                        title = "",
                        instruction = "",
                        modelId = null,
                        workspacePath = path,
                    ),
                )
                shell.show(MobileSurface.REMOTE)
                closeDrawer()
            },
            onOpenRemoteWorkspace = { path ->
                dispatchActiveWorkspace(RemoteWorkspaceIntent.SelectWorkspace(path))
                shell.show(MobileSurface.REMOTE)
                shell.closeRemoteSession()
                closeDrawer()
            },
            onDeleteRemoteSession = { id -> dispatchActiveSession(RemoteSessionIntent.DeleteSession(id)) },
            onOpenSettings = {
                // HarmonyOS' `onSidebar.settings` always opens root settings.
                // Remote-control settings has a separate remote-home action;
                // the sidebar gear does not change meaning behind the drawer.
                shell.openSettings(SettingsMode.GENERAL)
                closeDrawer()
            },
            onOpenAccount = {
                shell.openAccount()
                closeDrawer()
            },
            modifier = Modifier,
        )
    }

    val content: @Composable () -> Unit = {
        Scaffold(
            // The manifest asks for `adjustResize`, but an edge-to-edge window
            // is never resized by it — the keyboard simply draws on top, and
            // what it draws on top of is the composer. Adding the IME to the
            // insets the content already lifts itself out of is what actually
            // keeps the input bar above the keyboard. `union` rather than a
            // second padding: the IME inset already contains the navigation
            // bar's, and adding them would leave a gap the height of the bar.
            contentWindowInsets = ScaffoldDefaults.contentWindowInsets.union(WindowInsets.ime),
            // HarmonyOS hides the platform title bar. Each product surface owns
            // its 44dp controls and title row, so a Material TopAppBar here would
            // add a second header above every conversation and remote page.
            topBar = {},
        ) { insets ->
            Box(Modifier.padding(insets)) {
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
                            phase = accountPhase,
                            settingsPlacement = settingsPlacement,
                            sessionDetailsPlacement = sessionDetailsPlacement,
                            viewSettingsPlacement = remoteViewSettingsPlacement,
                            onOpenRemoteSettings = { shell.openSettings(SettingsMode.REMOTE) },
                            onCreateDevicePick = accountViewModel::selectDevice,
                            onSessionIntent = accountViewModel::dispatchSession,
                            onWorkspaceIntent = accountViewModel::dispatchWorkspace,
                            onOpenSidebar = if (showMenu) {
                                { compactDrawerOpen = true }
                            } else {
                                null
                            },
                            compact = !wide,
                            requestedSessionId = shell.remoteSessionId,
                            creatingSession = shell.remoteCreating,
                            onOpenSession = shell::openRemoteSession,
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
                                onOpenRemoteSettings = { shell.openRemoteConnect() },
                            )
                        } else WelcomeHome(
                            signedIn = readyAccount != null,
                            onLogin = {
                                if (readyAccount != null) shell.openRemoteConnect() else shell.openAccount()
                            },
                            onScan = shell::openRemoteScanner,
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

    val settingsContent: @Composable (Modifier) -> Unit = { contentModifier ->
        when (shell.settingsMode) {
            SettingsMode.GENERAL -> GeneralSettingsScreen(
                modifier = contentModifier,
                accountUserId = accountUserId,
                accountUsername = readyAccount?.username.orEmpty(),
                onOpenAccount = shell::openAccount,
                onClose = shell::dismissSettings,
            )

            SettingsMode.REMOTE -> SettingsScreen(
                modifier = contentModifier,
                accountUserId = accountUserId,
                summary = controlSummary,
                // The permission mode belongs to the desktop the summary
                // named, so it has to be asked of that desktop's store —
                // asking the other one would answer for a connection this
                // page is not describing, or for none at all.
                remoteState = when (controlSummary.source) {
                    RemoteControlSource.ACCOUNT_DEVICE -> accountRemoteState
                    RemoteControlSource.NONE -> RemoteSessionUiState.Idle
                },
                onSessionIntent = when (controlSummary.source) {
                    RemoteControlSource.ACCOUNT_DEVICE -> accountViewModel::dispatchSession
                    RemoteControlSource.NONE -> {
                        {}
                    }
                },
                onClose = shell::dismissSettings,
                onOpenAccount = shell::openAccount,
                onDisconnect = { accountViewModel.disconnectDevice() },
                onReconnect = {
                    // A room is re-checked where it stands; a device is asked
                    // for again, which is the same command its row in the
                    // account sends. Neither re-pairs behind the user's back.
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
                onConnectByLink = {
                    shell.dismissSettings()
                    shell.openRemoteScanner()
                },
            )
        }
    }

    AdaptiveModalSurface(
        visible = shell.remoteConnectOpen,
        edgeToEdgeContent = true,
        placement = connectPlacement,
        onDismissRequest = shell::closeRemoteConnect,
    ) { sheetModifier ->
        if (readyAccount != null && !shell.remoteScanRequested) {
            ConnectAccountDeviceScreen(
                state = readyAccount,
                onBack = shell::closeRemoteConnect,
                onRefresh = { accountViewModel.dispatch(AccountIntent.RefreshDevices) },
                onSelect = { shell.closeRemoteConnect(); accountViewModel.selectDevice(it) },
                onOpenScanner = shell::openRemoteScanner,
                modifier = sheetModifier,
            )
        } else ConnectView(
            onSubmit = connectDeviceLink,
            modifier = sheetModifier,
            onBack = shell::closeRemoteConnect,
            onOpenAccount = { shell.closeRemoteConnect(); shell.openAccount() },
            startScanning = shell.remoteScanRequested,
        )
    }
    AdaptiveModalSurface(
        visible = shell.showSettings,
        placement = settingsPlacement,
        onDismissRequest = shell::dismissSettings,
        content = settingsContent,
    )
    AdaptiveModalSurface(
        visible = shell.showAccount,
        fitContent = readyAccount == null,
        edgeToEdgeContent = readyAccount != null,
        placement = settingsPlacement,
        onDismissRequest = shell::dismissAccount,
    ) { modifier ->
        AccountScreen(
                modifier = modifier,
                onBack = shell::dismissAccount,
                onDeviceSelected = {
                    shell.dismissAccount()
                    shell.dismissSettings()
                    shell.closeRemoteSession()
                    shell.show(MobileSurface.REMOTE)
                },
                viewModel = accountViewModel,
            )
    }
}
