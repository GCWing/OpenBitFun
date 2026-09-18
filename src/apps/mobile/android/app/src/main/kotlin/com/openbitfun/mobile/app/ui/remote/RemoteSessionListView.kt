package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.core.feature.session.HarnessProfilePolicy
import com.openbitfun.mobile.core.feature.session.HarnessProfile
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.state.SessionViewSettings
import com.openbitfun.mobile.app.ui.settings.SessionViewSettingsSheet
import com.openbitfun.mobile.app.ui.settings.VIEW_SETTINGS_TOGGLE_TEST_TAG
import com.openbitfun.mobile.app.ui.settings.statusText
import com.openbitfun.mobile.app.ui.shell.sidebar.SidebarCircleButton
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.core.feature.session.RelativeTime
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.session.RemoteSessionFailureReason
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionActionPolicy
import com.openbitfun.mobile.core.feature.session.SessionActionScope
import com.openbitfun.mobile.core.feature.session.SessionListPresentation
import com.openbitfun.mobile.core.feature.session.SessionListSection
import com.openbitfun.mobile.core.feature.session.SessionTimePresentation
import com.openbitfun.mobile.core.feature.session.SessionWorkspaceContext
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import kotlinx.coroutines.delay
import com.openbitfun.mobile.app.ui.theme.openBitFunColors

internal const val SESSION_LIST_TEST_TAG: String = "session-list"
internal const val SESSION_PROJECTS_TEST_TAG: String = "session-projects"
internal const val SESSION_PROJECT_CREATE_TEST_TAG_PREFIX: String = "session-project-create:"
internal const val SESSION_CHAT_CREATE_TEST_TAG: String = "session-chat-create"
internal const val SESSION_SHOW_MORE_TEST_TAG_PREFIX: String = "session-show-more:"
internal const val SESSION_SEARCH_TOGGLE_TEST_TAG: String = "session-search-toggle"
internal const val SESSION_SEARCH_FIELD_TEST_TAG: String = "session-search-field"

/**
 * The paired desktop's sessions, ported from `pages/components/SessionList.ets`.
 *
 * Opening a row hands the screen over to [ConversationView]; this surface is
 * everything that is *about* sessions rather than inside one.
 */
@Composable
internal fun RemoteSessionListView(
    state: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    compact: Boolean,
    sessionDetailsPlacement: SettingsPlacement,
    viewSettingsPlacement: SettingsPlacement,
    connectionDetails: @Composable () -> Unit,
    onIntent: (RemoteSessionIntent) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(start = 20.dp, end = 20.dp, top = 4.dp)
            .testTag(SESSION_LIST_TEST_TAG),
    ) {
        RemoteSessionListContent(
            state = state,
            workspaceState = workspaceState,
            compact = compact,
            sessionDetailsPlacement = sessionDetailsPlacement,
            viewSettingsPlacement = viewSettingsPlacement,
            onIntent = onIntent,
            onWorkspaceIntent = onWorkspaceIntent,
            onOpen = onOpen,
            onCreate = onCreate,
            connectionDetails = connectionDetails,
            workspaceContent = {
                RemoteWorkspacePanel(
                    state = workspaceState,
                    sessionId = (state as? RemoteSessionUiState.Ready)?.selectedSessionId.orEmpty(),
                    onIntent = onWorkspaceIntent,
                    showPreview = false,
                )
            },
        )
    }
}

/**
 * The session list itself, without a scroll container of its own.
 *
 * Kept separate because the account sheet shows the same list under a different
 * header, and both callers already own the surface they scroll.
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun RemoteSessionListContent(
    state: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    compact: Boolean,
    sessionDetailsPlacement: SettingsPlacement,
    viewSettingsPlacement: SettingsPlacement,
    onIntent: (RemoteSessionIntent) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onOpen: (String) -> Unit,
    /** Opens the longer create route, where the first message is written. */
    onCreate: () -> Unit,
    connectionDetails: @Composable () -> Unit,
    workspaceContent: @Composable () -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var actionsFor by rememberSaveable { mutableStateOf<String?>(null) }
    var actionAnchor by remember { mutableStateOf<IntRect?>(null) }
    var detailsFor by rememberSaveable { mutableStateOf<String?>(null) }
    var viewSettingsOpen by rememberSaveable { mutableStateOf(false) }
    var collapsedSectionKeys by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
    var revealedSectionKeys by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
    // Not saveable, like the delete confirmation: an open menu is a finger
    // half-way through a gesture, not a place to come back to.
    // Keyed by the project's identity key, never its path: two open workspaces may share a root.
    var projectCreateMenuKey by remember { mutableStateOf<String?>(null) }
    var viewSettings by rememberSaveable(stateSaver = SessionViewSettings.Saver) {
        mutableStateOf(SessionViewSettings.Default)
    }

    val ready = state as? RemoteSessionUiState.Ready
    LaunchedEffect(ready?.query) {
        if (ready != null && ready.query != search) search = ready.query
    }
    LaunchedEffect(search, searchOpen) {
        if (searchOpen && ready != null && search != ready.query) {
            delay(250)
            onIntent(RemoteSessionIntent.Search(search))
        }
    }
    val createAssistantSession = {
        onIntent(RemoteSessionIntent.CreateSession("Claw"))
    }

    Column(modifier = Modifier.fillMaxSize()) {
        RemoteSessionListHeader(
            onToggleViewSettings = { viewSettingsOpen = true },
            onToggleSearch = {
                searchOpen = !searchOpen
                if (!searchOpen && search.isNotEmpty()) {
                    search = ""
                    onIntent(RemoteSessionIntent.Search(""))
                }
            },
        )
        if (searchOpen) {
            RemoteSessionSearchField(
                query = search,
                enabled = ready != null,
                onQueryChange = { search = it },
            )
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            connectionDetails()
            when (state) {
                RemoteSessionUiState.Idle -> Unit
                RemoteSessionUiState.Loading -> Text(stringResource(R.string.sessions_loading))
                is RemoteSessionUiState.Failed -> SessionFailure(
                    state,
                    onRetry = { onIntent(RemoteSessionIntent.Load) },
                )
                is RemoteSessionUiState.Ready -> {
                // The desktop's search is a separate, server-side narrowing; the
                // sheet's filters are applied here on what came back, exactly as
                // `RemoteSessionList.ets` layers the two.
                val workspace = workspaceState.asSessionContext()
                val view = remember(state.sessions, workspace, viewSettings) {
                    SessionListPresentation.view(
                        sessions = state.sessions,
                        workspace = workspace,
                        options = viewSettings.options(query = ""),
                        nowMs = System.currentTimeMillis(),
                    )
                }

                val rows = view.sections.flatMap { it.sessions }
                if (rows.isEmpty()) {
                    Text(stringResource(R.string.sessions_empty))
                } else {
                    val projectCount = view.sections.count { it is SessionListSection.Project }
                    view.sections.forEachIndexed { index, section ->
                        if (section is SessionListSection.Project &&
                            view.sections.take(index).none { it is SessionListSection.Project }
                        ) {
                            ProjectTreeHeader(projectCount)
                        }
                        val sectionKey = sectionKey(section)
                        val collapsed = sectionKey in collapsedSectionKeys
                        SectionHeader(
                            supportsHarnessProfiles = HarnessProfilePolicy.supported((workspaceState as? RemoteWorkspaceUiState.Ready)?.hostCapabilities.orEmpty()),
                            section = section,
                            collapsed = collapsed,
                            createMenuOpen = section is SessionListSection.Project &&
                                projectCreateMenuKey == section.key,
                            onToggleCreateMenu = if (section is SessionListSection.Project) {
                                {
                                    projectCreateMenuKey = if (projectCreateMenuKey == section.key) {
                                        null
                                    } else {
                                        section.key
                                    }
                                }
                            } else null,
                            onDismissCreateMenu = { projectCreateMenuKey = null },
                            onCreateAgent = if (section is SessionListSection.Project) {
                                { agentType ->
                                    projectCreateMenuKey = null
                                    // The section already carries the resolved workspace identity: with an
                                    // ID the create is addressed by ID only; a pre-ID row sends its legacy
                                    // triple. The shared store refuses unknown IDs instead of retrying by path.
                                    onIntent(RemoteSessionIntent.CreateSession(agentType, "", "", null, section.path,
                                        section.remoteConnectionId, section.remoteSshHost, section.workspaceId))
                                }
                            } else null,
                            onCreateAssistant = if (section is SessionListSection.Chat) {
                                createAssistantSession
                            } else null,
                            onToggle = {
                                collapsedSectionKeys = if (collapsed) {
                                    collapsedSectionKeys - sectionKey
                                } else {
                                    collapsedSectionKeys + sectionKey
                                }
                            },
                        )
                        val batch = SessionListPresentation.batch(
                            sessions = section.sessions,
                            revealedSteps = revealedSectionKeys.count { it == sectionKey },
                        )
                        if (!collapsed) batch.visible.forEach { session ->
                            SessionRow(
                                title = session.title,
                                status = session.status,
                                updatedAt = session.updatedAt,
                                workspace = session.workspaceName
                                    ?: session.workspacePath.orEmpty(),
                                settings = viewSettings,
                                projectChild = section is SessionListSection.Project,
                                selected = session.id == state.selectedSessionId,
                                enabled = !state.busy,
                                onOpen = {
                                    onIntent(RemoteSessionIntent.Open(session.id))
                                    onOpen(session.id)
                                },
                                onActions = { anchor ->
                                    actionAnchor = anchor
                                    actionsFor = session.id
                                },
                            )
                        }
                        if (!collapsed && batch.nextCount > 0) {
                            TextButton(
                                onClick = {
                                    revealedSectionKeys = revealedSectionKeys + sectionKey
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag(SESSION_SHOW_MORE_TEST_TAG_PREFIX + sectionKey),
                            ) {
                                Text(stringResource(R.string.sessions_show_more, batch.nextCount))
                            }
                        }
                    }
                    if (state.hasMore) {
                        TextButton(
                            onClick = { onIntent(RemoteSessionIntent.LoadMore) },
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(R.string.sessions_load_more)) }
                    }
                }
                // Looked up by id rather than held as an object: a refresh that
                // lands while the sheet is open replaces every row, and holding
                // the old copy would show a title the list no longer has. If the
                // session is gone entirely the sheet closes with it.
                rows.firstOrNull { it.id == actionsFor }?.let { session ->
                    val capabilities = SessionActionPolicy.resolve(
                        SessionActionScope.REMOTE,
                        session.agentType,
                        state.busy,
                    )
                    val dismissActions = {
                        actionsFor = null
                        actionAnchor = null
                    }
                    val openDetails = { detailsFor = session.id }
                    val delete = { onIntent(RemoteSessionIntent.DeleteSession(session.id)) }
                    if (compact || actionAnchor == null) SessionActionSheet(
                        title = session.title,
                        status = session.status,
                        capabilities = capabilities,
                        onViewDetails = openDetails,
                        onDelete = delete,
                        onDismiss = dismissActions,
                    ) else SessionActionPopup(
                        anchorBounds = actionAnchor!!,
                        title = session.title,
                        status = session.status,
                        capabilities = capabilities,
                        onViewDetails = openDetails,
                        onDelete = delete,
                        onDismiss = dismissActions,
                    )
                }
                rows.firstOrNull { it.id == detailsFor }?.let { session ->
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
                        onDismiss = { detailsFor = null },
                    )
                }
                }
            }
            workspaceContent()
        }
    }

    if (viewSettingsOpen && ready != null) {
        val workspace = workspaceState.asSessionContext()
        com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface(
            visible = true,
            placement = viewSettingsPlacement,
            onDismissRequest = { viewSettingsOpen = false },
        ) { surfaceModifier ->
            Column(surfaceModifier.verticalScroll(rememberScrollState())) {
                SessionViewSettingsSheet(
                    settings = viewSettings,
                    workspaces = remember(ready.sessions, workspace) {
                        SessionListPresentation.workspaceOptions(ready.sessions, workspace)
                    },
                    agentGroups = remember(ready.sessions, workspace) {
                        SessionListPresentation.agentGroups(ready.sessions, workspace)
                    },
                    statuses = remember(ready.sessions) {
                        SessionListPresentation.statusOptions(ready.sessions)
                    },
                    onChange = { viewSettings = it },
                    onClose = { viewSettingsOpen = false },
                    modifier = Modifier,
                )
            }
        }
    }
}

@Composable
private fun RemoteSessionListHeader(
    onToggleViewSettings: () -> Unit,
    onToggleSearch: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().height(50.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.app_name),
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.weight(1f),
        )
        SidebarCircleButton(
            icon = R.drawable.ic_symbol_ellipsis,
            contentDescription = stringResource(R.string.view_settings_title),
            diameter = 38,
            onClick = onToggleViewSettings,
            modifier = Modifier.testTag(VIEW_SETTINGS_TOGGLE_TEST_TAG),
        )
        SidebarCircleButton(
            icon = R.drawable.ic_symbol_magnifyingglass,
            contentDescription = stringResource(R.string.sidebar_search),
            diameter = 38,
            onClick = onToggleSearch,
            modifier = Modifier.testTag(SESSION_SEARCH_TOGGLE_TEST_TAG),
        )
    }
}

@Composable
private fun CompactCreateMenuItem(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    DropdownMenuItem(
        text = {
            Text(label, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        },
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(MobileDesignGeometry.CompactPopoverActionHeight),
    )
}

@Composable
private fun RemoteSessionSearchField(
    query: String,
    enabled: Boolean,
    onQueryChange: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp, bottom = 4.dp)
            .height(42.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_magnifyingglass),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            enabled = enabled,
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurface,
            ),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
            decorationBox = { field ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) {
                        Text(
                            stringResource(R.string.sidebar_search_placeholder),
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    field()
                }
            },
            modifier = Modifier.fillMaxWidth().testTag(SESSION_SEARCH_FIELD_TEST_TAG),
        )
    }
}

/**
 * The selected workspace and the desktop's recents, as the grouping needs them.
 *
 * A workspace list we have not loaded yet is not an error here: the grouping
 * falls back to a single unnamed project, which is what the list looked like
 * before any of this existed.
 */
@Composable
private fun RemoteWorkspaceUiState.asSessionContext(): SessionWorkspaceContext {
    val ready = this as? RemoteWorkspaceUiState.Ready
    return remember(ready) {
        SessionWorkspaceContext(
            selectedPath = ready?.selected?.path.orEmpty(),
            selectedName = ready?.selected?.name.orEmpty(),
            selectedKind = ready?.selected?.kind.orEmpty(),
            recent = ready?.workspaces.orEmpty(),
            selectedWorkspaceId = ready?.selected?.workspaceId,
            selectedRemoteConnectionId = ready?.selected?.remoteConnectionId,
            selectedRemoteSshHost = ready?.selected?.remoteSshHost,
        )
    }
}

/** One group heading; the project ones are named by the desktop, not by us. */
@Composable
private fun ProjectTreeHeader(projectCount: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .testTag(SESSION_PROJECTS_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.sessions_projects),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            projectCount.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** One collapsible group heading; project ones form the folder tree. */
@Composable
private fun SectionHeader(
    supportsHarnessProfiles: Boolean,
    section: SessionListSection,
    collapsed: Boolean,
    createMenuOpen: Boolean,
    onToggleCreateMenu: (() -> Unit)?,
    onDismissCreateMenu: () -> Unit,
    onCreateAgent: ((String) -> Unit)?,
    onCreateAssistant: (() -> Unit)?,
    onToggle: () -> Unit,
) {
    val label = when (section) {
        is SessionListSection.Chat -> stringResource(R.string.session_group_chat)
        is SessionListSection.Today -> stringResource(R.string.time_today)
        is SessionListSection.Yesterday -> stringResource(R.string.time_yesterday)
        is SessionListSection.Earlier -> stringResource(R.string.time_earlier)
        is SessionListSection.Project ->
            section.name.ifBlank { stringResource(R.string.view_settings_workspace) }
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 42.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .padding(horizontal = if (section is SessionListSection.Project) 4.dp else 0.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (section is SessionListSection.Project) {
            Icon(
                painterResource(R.drawable.ic_symbol_folder),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = if (section is SessionListSection.Project) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (section is SessionListSection.Project) {
            Text(
                section.sessions.size.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ProjectCreateControl(
                supportsHarnessProfiles = supportsHarnessProfiles,
                path = section.path,
                expanded = createMenuOpen,
                onToggle = { onToggleCreateMenu?.invoke() },
                onDismiss = onDismissCreateMenu,
                onCreateAgent = { onCreateAgent?.invoke(it) },
            )
        }
        if (section is SessionListSection.Chat) {
            ChatCreateControl(onCreate = { onCreateAssistant?.invoke() })
        }
        Icon(
            painterResource(
                if (collapsed) R.drawable.ic_symbol_chevron_right
                else R.drawable.ic_symbol_chevron_down,
            ),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
internal fun ChatCreateControl(onCreate: () -> Unit) {
    IconButton(
        onClick = onCreate,
        modifier = Modifier.size(40.dp).testTag(SESSION_CHAT_CREATE_TEST_TAG),
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_square_and_pencil),
            contentDescription = stringResource(R.string.sidebar_new_chat),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
internal fun ProjectCreateControl(
    supportsHarnessProfiles: Boolean = false,
    enabled: Boolean = true,
    path: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    onDismiss: () -> Unit,
    onCreateAgent: (String) -> Unit,
    modesOnly: Boolean = false,
    onFiles: (() -> Unit)? = null,
    onTerminal: (() -> Unit)? = null,
) {
    Box {
        IconButton(
            onClick = onToggle,
            enabled = enabled,
            modifier = Modifier
                .size(36.dp)
                .testTag(SESSION_PROJECT_CREATE_TEST_TAG_PREFIX + path),
        ) {
            Icon(
                painterResource(if (modesOnly || onFiles != null || onTerminal != null) R.drawable.ic_symbol_plus else R.drawable.ic_symbol_square_and_pencil),
                contentDescription = stringResource(if (modesOnly || onFiles != null || onTerminal != null) R.string.workspace_actions else R.string.sidebar_new_chat),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = onDismiss,
            modifier = Modifier.width(MobileDesignGeometry.CompactPopoverWidth),
            shape = RoundedCornerShape(MobileDesignGeometry.CompactPopoverRadius),
            containerColor = MaterialTheme.colorScheme.surface,
            tonalElevation = 0.dp,
            shadowElevation = 18.dp,
        ) {
            HarnessProfile.entries.forEach { profile ->
                androidx.compose.material3.DropdownMenuItem(
                    text = { HarnessProfileLabel(profile) },
                    onClick = { onCreateAgent(profile.agentType) },
                )
            }
        }
    }
}

private fun sectionKey(section: SessionListSection): String = when (section) {
    is SessionListSection.Chat -> "chat"
    is SessionListSection.Project -> "project:" + section.key
    is SessionListSection.Today -> "today"
    is SessionListSection.Yesterday -> "yesterday"
    is SessionListSection.Earlier -> "earlier"
}

private const val ASSISTANT_WORKSPACE_KIND = "assistant"

/**
 * One session in the list, from `RemoteSessionList.ets#SessionRow`.
 *
 * A flat row rather than a filled button: the source paints a background only on
 * the session being read, so the list reads as a list with one thing marked in
 * it. Every row filled meant the marked one had nowhere left to go, and a column
 * of solid blocks buried the metadata line under its own contrast.
 *
 * Which parts of the metadata appear is the user's choice, and by default none
 * of them do — a row is its title until someone asks for more. Each part is
 * still conditional on having something to say: a timestamp the desktop did not
 * send is left out rather than shown as "unknown", and only `archived` has a
 * word of our own, so any other status is passed through as the desktop spelled
 * it. The row is shorter when it has only the title, as the source's height is.
 *
 * Long-pressing opens the same actions the overflow does, which is how the
 * source reaches them on a phone.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    title: String,
    status: String,
    updatedAt: String,
    workspace: String,
    settings: SessionViewSettings,
    projectChild: Boolean,
    selected: Boolean,
    enabled: Boolean,
    onOpen: () -> Unit,
    onActions: (IntRect) -> Unit,
) {
    var anchorBounds by remember { mutableStateOf(IntRect.Zero) }
    val now = remember(updatedAt) { System.currentTimeMillis() }
    val relative = remember(updatedAt, now) { SessionTimePresentation.relative(updatedAt, now) }
    val metadata = listOfNotNull(
        workspace.takeIf { settings.showWorkspace && it.isNotBlank() },
        relativeTimeText(relative).takeIf { settings.showUpdated },
        status.takeIf { settings.showStatus && it.isNotBlank() }?.let { statusText(it) },
    ).joinToString(" · ")

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = if (metadata.isEmpty()) 46.dp else 56.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else openBitFunColors.transparent,
            )
            .onGloballyPositioned { coordinates ->
                anchorBounds = coordinates.boundsInWindow().toIntRect()
            }
            .combinedClickable(
                enabled = enabled,
                onClick = onOpen,
                onLongClick = { onActions(anchorBounds) },
            )
            .padding(start = if (projectChild) 28.dp else 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title.ifBlank { stringResource(R.string.sidebar_untitled) },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (metadata.isNotEmpty()) {
                Text(
                    metadata,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The overflow keeps the destructive actions one deliberate tap away,
        // as `SessionMoreButton` does. Two permanent buttons under every row
        // made destroying a session as reachable as opening one.
        IconButton(onClick = { onActions(anchorBounds) }) {
            Icon(
                painterResource(R.drawable.ic_symbol_ellipsis),
                contentDescription = stringResource(R.string.session_actions),
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun Rect.toIntRect(): IntRect = IntRect(
    left = left.toInt(),
    top = top.toInt(),
    right = right.toInt(),
    bottom = bottom.toInt(),
)

/** Null when the desktop sent nothing readable — see [SessionRowLabel]. */
@Composable
internal fun relativeTimeText(relative: RelativeTime): String? = when (relative) {
    RelativeTime.Unknown -> null
    RelativeTime.JustNow -> stringResource(R.string.time_just_now)
    is RelativeTime.MinutesAgo -> stringResource(R.string.time_minutes_ago, relative.minutes)
    is RelativeTime.HoursAgo -> stringResource(R.string.time_hours_ago, relative.hours)
    is RelativeTime.DaysAgo -> stringResource(R.string.time_days_ago, relative.days)
    // A plain ISO date rather than a localized one: it sits beside a status the
    // desktop wrote, and a sortable date reads the same in both languages.
    is RelativeTime.OnDate -> buildString {
        append(relative.year.toString().padStart(4, '0'))
        append('-')
        append(relative.month.toString().padStart(2, '0'))
        append('-')
        append(relative.day.toString().padStart(2, '0'))
    }
}

@Composable
private fun SessionFailure(state: RemoteSessionUiState.Failed, onRetry: () -> Unit) {
    Column {
        Text(
            stringResource(
                when (state.reason) {
                    RemoteSessionFailureReason.NO_WORKSPACE -> R.string.sessions_failed_no_workspace
                    RemoteSessionFailureReason.REMOTE_REJECTED -> R.string.sessions_failed_remote_rejected
                    RemoteSessionFailureReason.NETWORK -> R.string.sessions_failed_network
                    RemoteSessionFailureReason.TIMEOUT -> R.string.sessions_failed_timeout
                    RemoteSessionFailureReason.RATE_LIMITED -> R.string.sessions_failed_rate_limited
                    RemoteSessionFailureReason.PROTOCOL_MISMATCH -> R.string.sessions_failed_protocol_mismatch
                    RemoteSessionFailureReason.SESSION_NOT_FOUND -> R.string.sessions_failed_session_not_found
                    RemoteSessionFailureReason.WORKSPACE_ID_UNSUPPORTED -> R.string.sessions_failed_workspace_id_unsupported
                    RemoteSessionFailureReason.WORKSPACE_ID_UNKNOWN -> R.string.sessions_failed_workspace_id_unknown
                    RemoteSessionFailureReason.HOST_STREAM_UNSUPPORTED -> R.string.sessions_failed_host_stream_unsupported
                    // Exhaustive on purpose rather than an `else`: every reason
                    // that reaches this screen was raised to say something
                    // specific, and a new one falling into the generic line is
                    // the bug this branch exists to prevent.
                    RemoteSessionFailureReason.TRANSPORT -> R.string.sessions_failed
                },
            ),
            color = MaterialTheme.colorScheme.error,
        )
        // The desktop wrote this sentence; it cannot be translated on this side,
        // so it sits under our heading as supporting detail.
        state.remoteMessage?.let { detail ->
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Every reason above is retryable in the sense that matters here: the
        // request can be made again. Without this the screen is a dead end that
        // states a problem and offers nothing, which is how the account path
        // stranded a real session behind one bad decode.
        TextButton(onClick = onRetry) { Text(stringResource(R.string.sessions_retry)) }
    }
}
