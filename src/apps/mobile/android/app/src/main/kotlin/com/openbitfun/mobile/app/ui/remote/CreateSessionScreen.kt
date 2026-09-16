package com.openbitfun.mobile.app.ui.remote

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.core.feature.session.HarnessProfilePolicy
import com.openbitfun.mobile.core.feature.session.HarnessProfile
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.chat.ComposerBar
import com.openbitfun.mobile.app.ui.common.CircleControl
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.CreateSessionPresenter
import com.openbitfun.mobile.core.feature.session.ModelOption
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.createModelOptions
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

internal const val CREATE_SESSION_TEST_TAG: String = "create-session"
internal const val CREATE_SESSION_BACK_TEST_TAG: String = "create-session-back"
internal const val CREATE_SESSION_WORKSPACE_TEST_TAG: String = "create-session-workspace"

internal data class CreateDeviceChoice(
    val id: String,
    val name: String,
    val online: Boolean,
    val selected: Boolean,
)

private enum class CreateSelectionKind { DEVICE, WORKSPACE }

/**
 * [CreateSessionScreen] plus the one thing it cannot decide for itself: when the
 * session it asked for exists.
 *
 * The store answers a successful create by selecting the new session, so the
 * signal is that the selection changed from whatever it was when this screen
 * opened. Both hosts route on it identically, which is why it lives here rather
 * than twice in the screens that mount this.
 */
@Composable
internal fun CreateSessionRoute(
    sessionState: RemoteSessionUiState,
    workspaceState: RemoteWorkspaceUiState,
    phase: ConnectionPhase,
    deviceId: String,
    devices: List<CreateDeviceChoice>,
    compact: Boolean,
    onDevicePick: (String) -> Unit,
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onIntent: (RemoteSessionIntent) -> Unit,
    modifier: Modifier,
) {
    val ready = sessionState as? RemoteSessionUiState.Ready
    val modelOptions = ready?.createModelOptions(stringResource(R.string.models_unnamed)).orEmpty()
    val baseline = rememberSaveable { mutableStateOf(ready?.selectedSessionId) }
    val created = ready?.selectedSessionId
    val hasTimeline = ready?.timeline != null
    LaunchedEffect(created, hasTimeline) {
        if (created != null && created != baseline.value && hasTimeline) onCreated(created)
    }

    CreateSessionScreen(
        workspaceState = workspaceState,
        phase = phase,
        deviceId = deviceId,
        devices = devices,
        modelOptions = modelOptions,
        compact = compact,
        onDevicePick = onDevicePick,
        // Anything other than a settled list means the store is mid-request or
        // has nothing to create against, and either way the send would be lost.
        busy = ready?.busy ?: true,
        onBack = onBack,
        onWorkspaceIntent = onWorkspaceIntent,
        onIntent = onIntent,
        modifier = modifier,
    )
}

/**
 * The new-session screen, ported from `pages/components/RemoteCreateSessionView.ets`.
 *
 * It is deliberately almost empty: a way back, one line saying where the work
 * will happen, and the composer. The source has no title field and no agent
 * picker on this route because both are inferred — the agent follows from the
 * workspace ([CreateSessionPresenter.agentType]) and the title is whatever the
 * agent renames the session to after reading the first message.
 *
 * The pencil menu on the session list stays as it is: that is a different,
 * faster act — start a Code or Cowork session here in this project — and the
 * source keeps both too.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CreateSessionScreen(
    workspaceState: RemoteWorkspaceUiState,
    phase: ConnectionPhase,
    /** The desktop this would run on. Empty means there is nothing to create on. */
    deviceId: String,
    devices: List<CreateDeviceChoice>,
    modelOptions: List<ModelOption> = emptyList(),
    compact: Boolean,
    busy: Boolean,
    onBack: () -> Unit,
    onDevicePick: (String) -> Unit,
    onWorkspaceIntent: (RemoteWorkspaceIntent) -> Unit,
    onIntent: (RemoteSessionIntent) -> Unit,
    modifier: Modifier,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    var workspacePath by rememberSaveable { mutableStateOf("") }
    var workspaceConnectionId by rememberSaveable { mutableStateOf<String?>(null) }
    var workspaceSshHost by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedModelId by rememberSaveable { mutableStateOf<String?>(null) }
    // Not saveable: an open sheet is a finger part-way through a gesture.
    var pickerKind by remember { mutableStateOf<CreateSelectionKind?>(null) }
    val focusManager = LocalFocusManager.current
    var harnessProfile by remember { mutableStateOf(HarnessProfile.STANDARD) }
    var harnessMenuOpen by remember { mutableStateOf(false) }
    val ready = workspaceState as? RemoteWorkspaceUiState.Ready
    LaunchedEffect(modelOptions) {
        if (modelOptions.none { it.id == selectedModelId }) {
            selectedModelId = modelOptions.firstOrNull { it.selected }?.id ?: modelOptions.firstOrNull()?.id
        }
    }
    val selectedModel = modelOptions.firstOrNull { it.id == selectedModelId }
        ?: modelOptions.firstOrNull { it.selected }
        ?: modelOptions.firstOrNull()
    val selectWorkspace: (WorkspaceChoice?) -> Unit = { workspace ->
        workspacePath = workspace?.path.orEmpty()
        workspaceConnectionId = workspace?.remoteConnectionId
        workspaceSshHost = workspace?.remoteSshHost
    }

    val voiceInput = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (text.isNotBlank()) {
                draft = listOf(draft.trim(), text.trim()).filter(String::isNotEmpty).joinToString(" ")
            }
        }
    }

    Column(modifier = modifier.fillMaxSize().testTag(CREATE_SESSION_TEST_TAG)) {
        Row(
            modifier = Modifier.fillMaxWidth().height(78.dp).padding(start = 18.dp, top = 14.dp),
            verticalAlignment = Alignment.Top,
        ) {
            CircleControl(
                icon = R.drawable.ic_symbol_chevron_left,
                glyphSize = 20,
                contentDescription = stringResource(R.string.create_back),
                onClick = onBack,
                modifier = Modifier.testTag(CREATE_SESSION_BACK_TEST_TAG),
            )
        }

        // The empty middle is load-bearing in the source: it is what the user
        // taps to put the keyboard away without leaving the screen.
        DismissFiller(focusManager = focusManager, modifier = Modifier.weight(1f))

        if (deviceId.isEmpty()) {
            Text(
                stringResource(R.string.create_no_device),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 4.dp),
            )
        }

        Column(modifier = Modifier.fillMaxWidth()) {
            if (!compact && devices.isNotEmpty()) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    ContextRow(
                        glyph = R.drawable.ic_symbol_desktop,
                        label = devices.firstOrNull { it.selected }?.name
                            ?.ifBlank { deviceId }
                            ?: deviceId,
                        expanded = pickerKind == CreateSelectionKind.DEVICE,
                        enabled = !busy,
                        onClick = {
                            focusManager.clearFocus()
                            pickerKind = CreateSelectionKind.DEVICE
                        },
                        modifier = Modifier,
                    )
                    DropdownMenu(
                        expanded = pickerKind == CreateSelectionKind.DEVICE,
                        onDismissRequest = { pickerKind = null },
                        modifier = Modifier.width(340.dp),
                        shape = RoundedCornerShape(16.dp),
                        containerColor = MaterialTheme.colorScheme.surface,
                        tonalElevation = 0.dp,
                        shadowElevation = 18.dp,
                    ) {
                        DevicePicker(
                            devices = devices,
                            onPick = { id ->
                                pickerKind = null
                                onDevicePick(id)
                            },
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        )
                    }
                }
            }

            Box(modifier = Modifier.fillMaxWidth()) {
                ContextRow(
                glyph = if (workspacePath.isEmpty()) {
                    R.drawable.ic_symbol_message
                } else {
                    R.drawable.ic_symbol_folder
                },
                label = when {
                    workspaceState is RemoteWorkspaceUiState.Loading -> stringResource(R.string.sessions_loading)
                    workspacePath.isEmpty() -> stringResource(R.string.create_chat)
                    else -> ready?.workspaces?.firstOrNull { it.path == workspacePath }?.displayName.orEmpty()
                        .ifEmpty { workspacePath }
                },
                expanded = pickerKind == CreateSelectionKind.WORKSPACE,
                enabled = !busy,
                onClick = {
                    focusManager.clearFocus()
                    pickerKind = CreateSelectionKind.WORKSPACE
                },
                    modifier = Modifier.testTag(CREATE_SESSION_WORKSPACE_TEST_TAG),
                )
                if (!compact) {
                    DropdownMenu(
                    expanded = pickerKind == CreateSelectionKind.WORKSPACE,
                    onDismissRequest = { pickerKind = null },
                    modifier = Modifier.width(340.dp),
                    shape = RoundedCornerShape(16.dp),
                    containerColor = MaterialTheme.colorScheme.surface,
                    tonalElevation = 0.dp,
                    shadowElevation = 18.dp,
                    ) {
                        WorkspacePicker(
                        workspaces = ready?.workspaces.orEmpty().map {
                            WorkspaceChoice(path = it.path, name = it.displayName, remoteConnectionId = it.remoteConnectionId, remoteSshHost = it.remoteSshHost)
                        },
                        selectedPath = workspacePath,
                        selectedConnectionId = workspaceConnectionId,
                        selectedSshHost = workspaceSshHost,
                        showHeader = false,
                        onDismiss = { pickerKind = null },
                        onPick = { path ->
                            pickerKind = null
                            selectWorkspace(path)
                        },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        )
                    }
                }
            }
        }

        if (!workspacePath.isNullOrBlank() && HarnessProfilePolicy.supported(ready?.hostCapabilities.orEmpty())) {
            Box {
                androidx.compose.material3.TextButton(onClick = { harnessMenuOpen = true }) { HarnessProfileLabel(harnessProfile) }
                androidx.compose.material3.DropdownMenu(expanded = harnessMenuOpen, onDismissRequest = { harnessMenuOpen = false }) {
                    HarnessProfile.entries.forEach { profile ->
                        androidx.compose.material3.DropdownMenuItem(text = { HarnessProfileLabel(profile) }, onClick = {
                            harnessProfile = profile
                            harnessMenuOpen = false
                        })
                    }
                }
            }
        }
        ComposerBar(
            draft = draft,
            images = emptyList(),
            busy = busy,
            streaming = false,
            // No device means the remote genuinely is not reachable, so the send
            // dims itself the way it does during a dropout. The field stays
            // typable on purpose: the draft is worth keeping until a desktop
            // comes back, and the source blocks only the send too.
            phase = if (deviceId.isEmpty()) ConnectionPhase.DISCONNECTED else phase,
            // There is no session yet, so there is no per-session model to swap.
            model = selectedModel,
            modelOptions = modelOptions,
            capabilities = ChatComposerCapabilities.RemoteCreate,
            placeholder = stringResource(R.string.create_placeholder),
            onDraftChange = { draft = it },
            onRemoveImage = {},
            onAttach = {},
            onOpenModels = {},
            onSelectModel = { selectedModelId = it },
            onVoice = {
                voiceInput.launch(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                        putExtra(
                            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                        )
                    },
                )
            },
            onSend = {
                if (CreateSessionPresenter.canSubmit(draft, deviceId, busy)) {
                    onIntent(
                        RemoteSessionIntent.CreateSession(
                            agentType = if (workspacePath.isNullOrBlank()) CreateSessionPresenter.agentType(workspacePath) else HarnessProfilePolicy.creationAgent(harnessProfile, ready?.hostCapabilities.orEmpty()),
                            title = "",
                            instruction = draft,
                            modelId = selectedModelId,
                            workspacePath = workspacePath.takeIf { it.isNotBlank() },
                            remoteConnectionId = workspaceConnectionId,
                            remoteSshHost = workspaceSshHost,
                        ),
                    )
                    draft = ""
                }
            },
            onStop = {},
            modifier = Modifier,
        )
    }

    if (compact && pickerKind == CreateSelectionKind.WORKSPACE) {
        ModalBottomSheet(onDismissRequest = { pickerKind = null }) {
            WorkspacePicker(
                workspaces = ready?.workspaces.orEmpty().map {
                    WorkspaceChoice(path = it.path, name = it.displayName, remoteConnectionId = it.remoteConnectionId, remoteSshHost = it.remoteSshHost)
                },
                selectedPath = workspacePath,
                selectedConnectionId = workspaceConnectionId,
                selectedSshHost = workspaceSshHost,
                showHeader = true,
                onDismiss = { pickerKind = null },
                onPick = { path ->
                    pickerKind = null
                    selectWorkspace(path)
                },
                modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp),
            )
        }
    }

}

/** What the desktop calls the workspace it keeps its chat sessions in. */
private const val ASSISTANT_KIND = "assistant"

/**
 * One row of the picker.
 *
 * The workspace domain type carries a kind and a timestamp the picker has no use
 * for, and the app layer cannot see `core-domain` anyway.
 */
private data class WorkspaceChoice(val path: String, val name: String, val remoteConnectionId: String?, val remoteSshHost: String?)

/**
 * The tap target that puts the keyboard away.
 *
 * No ripple and no role: it is empty space, and an indication here would read as
 * a control the user had missed.
 */
@Composable
private fun DismissFiller(focusManager: FocusManager, modifier: Modifier) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clickable(
                interactionSource = interaction,
                indication = null,
            ) { focusManager.clearFocus() },
    )
}

/**
 * One line saying where the session will run, as the source's `ContextRow` is:
 * a glyph for the kind of place, its name, and a chevron because it opens.
 */
@Composable
private fun ContextRow(
    @DrawableRes glyph: Int,
    label: String,
    expanded: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            painterResource(glyph),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(
            painterResource(
                if (expanded) R.drawable.ic_symbol_chevron_up
                else R.drawable.ic_symbol_chevron_down,
            ),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
    }
}

@Composable
private fun DevicePicker(
    devices: List<CreateDeviceChoice>,
    onPick: (String) -> Unit,
    modifier: Modifier,
) {
    Column(modifier = modifier) {
        devices.forEach { device ->
            PickerRow(
                title = device.name.ifBlank { device.id },
                subtitle = stringResource(if (device.online) R.string.account_online else R.string.account_offline),
                selected = device.selected,
                enabled = device.online || device.selected,
                onClick = { onPick(device.id) },
            )
        }
    }
}

/**
 * Where the session will run: chat, or one of the desktop's recent workspaces.
 *
 * Chat leads because it is the one option that needs no project, and because
 * choosing it is how the user says "just talk to me" rather than "work here".
 */
@Composable
private fun WorkspacePicker(
    workspaces: List<WorkspaceChoice>,
    selectedPath: String,
    selectedConnectionId: String?,
    selectedSshHost: String?,
    showHeader: Boolean,
    onDismiss: () -> Unit,
    onPick: (WorkspaceChoice?) -> Unit,
    modifier: Modifier,
) {
    Column(modifier = modifier) {
        if (showHeader) {
            Row(
                modifier = Modifier.fillMaxWidth().height(52.dp).padding(start = 18.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.create_workspace_picker),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss, modifier = Modifier.size(44.dp)) {
                    Icon(
                        painterResource(R.drawable.ic_symbol_xmark),
                        contentDescription = stringResource(R.string.common_close),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
        PickerRow(
            title = stringResource(R.string.create_chat),
            subtitle = "",
            selected = selectedPath.isEmpty(),
            onClick = { onPick(null) },
        )
        if (workspaces.isEmpty()) {
            Text(
                stringResource(R.string.create_no_workspaces),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
            )
            return@Column
        }
        workspaces.forEach { workspace ->
            PickerRow(
                title = workspace.name.ifBlank { workspace.path },
                // Two projects can share a name; the path is what tells them
                // apart, and it is the only place the user can check.
                subtitle = workspace.path,
                selected = workspace.path == selectedPath && workspace.remoteConnectionId == selectedConnectionId &&
                    workspace.remoteSshHost == selectedSshHost,
                onClick = { onPick(workspace) },
            )
        }
    }
}

@Composable
private fun PickerRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.55f)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotEmpty()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) {
            Icon(
                painterResource(R.drawable.ic_symbol_checkmark_circle),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(19.dp),
            )
        }
    }
}
