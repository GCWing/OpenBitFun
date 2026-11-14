package com.openbitfun.mobile.app.ui.chat

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.platform.launchComposerActivity
import com.openbitfun.mobile.app.platform.prepareComposerImage
import com.openbitfun.mobile.app.ui.common.CircleControl
import com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface
import com.openbitfun.mobile.app.ui.settings.ModelServiceScreen
import com.openbitfun.mobile.app.viewmodel.GeneralChatViewModel
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.generalchat.GeneralChatFailureReason
import com.openbitfun.mobile.core.feature.generalchat.GeneralChatIntent
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.ConversationRowKind
import com.openbitfun.mobile.core.feature.session.ModelOption
import com.openbitfun.mobile.core.feature.session.conversationRows
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal const val GENERAL_CHAT_TEST_TAG: String = "general-chat"
// Keep the shell-level automation id while the control is now owned by the
// surface header rather than by a platform TopAppBar.
internal const val GENERAL_CHAT_SIDEBAR_TEST_TAG: String = "shell-menu"
internal const val GENERAL_CHAT_MENU_TEST_TAG: String = "general-chat-menu"
internal const val GENERAL_CHAT_MODEL_TEST_TAG: String = "general-chat-model"

/**
 * The general-chat surface, the counterpart of `ConversationView` for a
 * conversation that has no desktop behind it.
 *
 * It renders the same rows through the same bubbles and the same composer as the
 * remote session: both surfaces project the same shared timeline, and letting
 * them diverge visually is how the two clients drift apart. What differs is the
 * header menu — rename and delete are this store's own operations — and
 * the composer's capabilities.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GeneralChatScreen(
    modifier: Modifier,
    modelServicePlacement: SettingsPlacement,
    onOpenSidebar: (() -> Unit)? = null,
    viewModel: GeneralChatViewModel = viewModel(factory = GeneralChatViewModel.Factory),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val rows = remember(state.timeline) { state.timeline.conversationRows() }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    var menuOpen by rememberSaveable { mutableStateOf(false) }
    var showModelService by rememberSaveable { mutableStateOf(false) }
    var renaming by rememberSaveable { mutableStateOf(false) }

    val untitled = stringResource(R.string.sidebar_untitled)
    val userLabel = stringResource(R.string.general_chat_role_user)
    val assistantLabel = stringResource(R.string.general_chat_role_assistant)
    val localModelSource = stringResource(R.string.model_selector_local)
    val accountModelSource = stringResource(R.string.model_selector_account)
    val title = state.sessions.firstOrNull { it.id == state.sessionId }
        ?.title
        ?.takeIf(String::isNotBlank)
        ?: stringResource(R.string.app_name)
    var renameDraft by rememberSaveable(title) { mutableStateOf(title) }
    val visibleRows = remember(rows) { rows.filter { it.kind != ConversationRowKind.EMPTY } }
    val uploadedFileCount = visibleRows.sumOf { it.images.size }
    // Read in composition, not in the menu callback -- see `ConversationView`.
    val uploadedFilesMessage = if (uploadedFileCount > 0) {
        stringResource(R.string.session_uploaded_files_count, uploadedFileCount)
    } else {
        stringResource(R.string.session_uploaded_files_empty)
    }
    val composerModels = remember(
        state.models,
        state.activeModelId,
        localModelSource,
        accountModelSource,
    ) {
        state.models.map { model ->
            ModelOption(
                id = model.id,
                primaryLabel = model.label,
                secondaryLabel = when (model.source) {
                    com.openbitfun.mobile.core.feature.generalchat.GeneralChatModelSource.LOCAL ->
                        localModelSource
                    com.openbitfun.mobile.core.feature.generalchat.GeneralChatModelSource.ACCOUNT ->
                        accountModelSource
                },
                selected = model.id == state.activeModelId,
            )
        }
    }

    val voiceInput = rememberComposerVoiceInput(state.sessionId) { text ->
        viewModel.dispatch(GeneralChatIntent.UpdateDraft(listOf(state.draft.trim(), text.trim()).filter(String::isNotEmpty).joinToString(" ")))
    }
    val pickerScope = rememberCoroutineScope()
    val currentState by rememberUpdatedState(state)
    var pickerOwner by rememberSaveable { mutableStateOf<String?>(null) }
    var preparingImage by remember(state.sessionId) { mutableStateOf(false) }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val target = pickerOwner
        pickerOwner = null
        if (uri != null && target == state.sessionId && state.images.size < MAX_COMPOSER_IMAGES) {
            preparingImage = true
            pickerScope.launch {
                try {
                    val prepared = prepareComposerImage(context.contentResolver, uri)
                    val latest = currentState
                    if (latest.sessionId == target && latest.images.size < MAX_COMPOSER_IMAGES) {
                        viewModel.dispatch(GeneralChatIntent.SetImages(latest.images + prepared))
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (currentState.sessionId == target) {
                        Toast.makeText(context, R.string.chat_image_prepare_failed, Toast.LENGTH_LONG).show()
                    }
                } finally {
                    if (currentState.sessionId == target) preparingImage = false
                }
            }
        }
    }

    // An export's share sheet is raised by `MobileScreen`, which is mounted
    // whichever surface is showing: the drawer can export a conversation this
    // screen is not on, and two consumers would raise two choosers.
    LaunchedEffect(rows.size) {
        if (rows.isNotEmpty()) listState.animateScrollToItem(rows.lastIndex)
    }

    Column(modifier = modifier.fillMaxSize().testTag(GENERAL_CHAT_TEST_TAG)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry.ConversationHeaderHeight)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onOpenSidebar != null) {
                CircleControl(
                    icon = R.drawable.ic_symbol_menu_lines,
                    glyphSize = 22,
                    contentDescription = stringResource(R.string.shell_open_sidebar),
                    onClick = onOpenSidebar,
                    modifier = Modifier.testTag(GENERAL_CHAT_SIDEBAR_TEST_TAG),
                )
            } else {
                Box(Modifier.size(44.dp))
            }
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp)
                    .clickable(enabled = state.sessions.any { it.id == state.sessionId }) {
                        renameDraft = title
                        renaming = true
                    },
                textAlign = TextAlign.Center,
            )
            if (visibleRows.isNotEmpty()) {
                Box {
                    // The same box `ConversationHeader` gives the glyph: this
                    // header is the general-chat face of the one HarmonyOS
                    // draws for every conversation, so the dots are the source's
                    // 23x7 rather than a square that would fit them smaller.
                    CircleControl(
                        icon = R.drawable.ic_symbol_ellipsis,
                        glyphSize = 20,
                        glyphWidth = 23,
                        glyphHeight = 7,
                        contentDescription = stringResource(R.string.general_chat_menu),
                        onClick = { menuOpen = true },
                        modifier = Modifier.testTag(GENERAL_CHAT_MENU_TEST_TAG),
                    )
                    // Every session mutation remains disabled until a stored
                    // conversation exists; the shared menu only changes the
                    // presentation, not that capability rule.
                    val stored = state.sessions.any { it.id == state.sessionId }
                    val current = state.sessions.firstOrNull { it.id == state.sessionId }
                    val archived = current?.status.equals(ARCHIVED, ignoreCase = true)
                    OpenBitFunHeaderActionMenu(
                        expanded = menuOpen,
                        onDismiss = { menuOpen = false },
                        sectionTitle = stringResource(R.string.session_section),
                        actions = listOf(
                            OpenBitFunHeaderAction(
                                icon = R.drawable.ic_symbol_checkmark_circle,
                                label = stringResource(
                                    if (current?.pinned == true) R.string.session_unpin
                                    else R.string.session_pin,
                                ),
                                enabled = stored,
                                selected = current?.pinned == true,
                                onClick = {
                                    viewModel.dispatch(
                                        GeneralChatIntent.PinSession(
                                            state.sessionId,
                                            current?.pinned != true,
                                        ),
                                    )
                                },
                            ),
                            OpenBitFunHeaderAction(
                                icon = R.drawable.ic_symbol_cloud,
                                label = stringResource(R.string.session_uploaded_files),
                                onClick = {
                                    Toast
                                        .makeText(context, uploadedFilesMessage, Toast.LENGTH_SHORT)
                                        .show()
                                },
                            ),
                            OpenBitFunHeaderAction(
                                icon = R.drawable.ic_symbol_folder,
                                label = stringResource(
                                    if (archived) R.string.session_unarchive else R.string.session_archive,
                                ),
                                enabled = stored,
                                dividerBefore = true,
                                onClick = {
                                    viewModel.dispatch(GeneralChatIntent.ArchiveSession(state.sessionId, !archived))
                                },
                            ),
                            OpenBitFunHeaderAction(
                                icon = R.drawable.ic_symbol_gearshape,
                                label = stringResource(R.string.session_delete),
                                enabled = stored,
                                onClick = {
                                    viewModel.dispatch(GeneralChatIntent.DeleteSession(state.sessionId))
                                },
                            ),
                        ),
                    )
                }
            } else {
                Box(Modifier.size(44.dp))
            }
        }

        if (renaming) {
            TitleEditor(
                draft = renameDraft,
                enabled = !state.busy,
                onDraftChange = { renameDraft = it },
                onSave = {
                    viewModel.dispatch(GeneralChatIntent.RenameSession(state.sessionId, renameDraft.trim()))
                    renaming = false
                },
                onCancel = { renaming = false },
            )
        }

        if (visibleRows.isEmpty()) {
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                if (!state.configured) {
                    Text(
                        stringResource(R.string.general_chat_unconfigured),
                        fontSize = 17.sp,
                        lineHeight = 24.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 24.dp),
                    )
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(visibleRows, key = { it.id }) { row ->
                    ChatMessageBubble(
                        row = row,
                        enabled = !state.busy,
                        // General chat has no tools: the provider stream carries
                        // text only, so no row can ever ask for an approval.
                        onApproveTool = { _, _ -> },
                        onRejectTool = { _, _ -> },
                        onCancelTool = { _, _ -> },
                        onAnswerTool = { _, _ -> },
                        onAnswerToolStructured = { _, _ -> },
                        onRetry = { row ->
                            viewModel.dispatch(GeneralChatIntent.UpdateDraft(row.text))
                            viewModel.dispatch(GeneralChatIntent.Send)
                        },
                        // No desktop behind this surface, so a link to a file has
                        // nothing to open — only a web address goes anywhere, and
                        // it leaves the app. Anything else is left as plain text.
                        onOpenLink = { url, _ -> openWebLink(context, url) },
                        // No preview surface here either, so no card is ever the
                        // open one; the projector only matches `computer://`, so
                        // a general-chat turn produces no cards to mark anyway.
                        previewingRemotePath = "",
                        previewLoading = false,
                        download = com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState.None,
                        onDownloadFile = { _, _ -> },
                        downloadEnabled = false,
                        modifier = Modifier,
                    )
                }
            }
        }

        state.failure?.let { failure ->
            Text(
                stringResource(failure.messageRes()),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }

        ComposerBar(
            draft = state.draft,
            images = state.images,
            busy = state.busy || preparingImage,
            inputEnabled = !state.busy && !preparingImage,
            streaming = state.timeline.activeTurn != null,
            // Never consulted: general chat's capabilities do not require a
            // desktop, so the phase cannot gate the send.
            phase = ConnectionPhase.DISCONNECTED,
            model = composerModels.firstOrNull { it.selected },
            modelOptions = composerModels,
            capabilities = ChatComposerCapabilities.GeneralChat,
            placeholder = stringResource(R.string.message_input_label),
            onDraftChange = { viewModel.dispatch(GeneralChatIntent.UpdateDraft(it)) },
            onRemoveImage = { id ->
                viewModel.dispatch(GeneralChatIntent.SetImages(state.images.filterNot { it.id == id }))
            },
            onAttach = {
                pickerOwner = state.sessionId
                if (!launchComposerActivity(context, R.string.chat_photo_picker_unavailable) {
                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }) pickerOwner = null
            },
            onOpenModels = { showModelService = true },
            onSelectModel = { viewModel.dispatch(GeneralChatIntent.SelectModel(it)) },
            onSend = { viewModel.dispatch(GeneralChatIntent.Send) },
            onStop = { viewModel.dispatch(GeneralChatIntent.Cancel) },
            modifier = Modifier,
            onVoice = voiceInput,
        )
    }

    if (showModelService) {
        val dismissModelService = {
            showModelService = false
            viewModel.dispatch(GeneralChatIntent.ClearConfigFailure)
            viewModel.dispatch(GeneralChatIntent.ClearConnectionTest)
        }
        AdaptiveModalSurface(
            visible = true,
            placement = modelServicePlacement,
            onDismissRequest = dismissModelService,
        ) { surfaceModifier ->
            ModelServiceScreen(
                config = state.config,
                models = state.models,
                activeModelId = state.activeModelId,
                failure = state.configFailure,
                connectionTest = state.connectionTest,
                onIntent = viewModel::dispatch,
                onSave = { intent ->
                    viewModel.dispatch(intent)
                    // Read back rather than waiting for recomposition: dispatch
                    // is synchronous, and a refused save must keep the form up
                    // with the reason next to the field that caused it.
                    viewModel.state.value.configFailure == null
                },
                onClose = dismissModelService,
                modifier = surfaceModifier,
            )
        }
    }

}

/** Shown above the transcript rather than instead of it: an unconfigured provider
 *  does not hide a conversation the user can still read back. */
@Composable
private fun UnconfiguredNotice(onConfigure: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            stringResource(R.string.general_chat_setup_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onConfigure) {
            Text(stringResource(R.string.general_chat_setup))
        }
    }
}

/**
 * Hands a link to whatever the phone opens web addresses with.
 *
 * Only `http` and `https`: everything else a model can write into a link — a
 * path, a `file:` url, an intent scheme — either points at a machine this app
 * cannot reach or is a way to aim this app's own components from text a server
 * sent. A device with no browser at all is the remaining failure, and doing
 * nothing is the right answer there too.
 */
private fun openWebLink(context: Context, url: String) {
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    if (uri.scheme?.lowercase() !in setOf("http", "https")) return
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

internal fun GeneralChatFailureReason.messageRes(): Int = when (this) {
    GeneralChatFailureReason.UNCONFIGURED -> R.string.general_chat_unconfigured
    GeneralChatFailureReason.AUTHENTICATION -> R.string.general_chat_authentication
    GeneralChatFailureReason.RATE_LIMITED -> R.string.general_chat_rate_limited
    GeneralChatFailureReason.SERVICE_UNAVAILABLE -> R.string.general_chat_service_unavailable
    GeneralChatFailureReason.INVALID_RESPONSE -> R.string.general_chat_invalid_response
    GeneralChatFailureReason.NETWORK -> R.string.general_chat_network
}

/** The status the store writes for a filed-away conversation. */
private const val ARCHIVED = "archived"
