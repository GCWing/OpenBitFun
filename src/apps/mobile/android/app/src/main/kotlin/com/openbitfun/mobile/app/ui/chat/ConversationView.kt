package com.openbitfun.mobile.app.ui.chat

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignTypography
import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.launch
import com.openbitfun.mobile.app.platform.prepareComposerImage
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.settings.RemoteSettingsSheet
import com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.ComposerImage
import com.openbitfun.mobile.core.feature.session.ConversationRow
import com.openbitfun.mobile.core.feature.session.ConversationRowKind
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent.AnswerStructuredQuestion
import com.openbitfun.mobile.core.feature.session.QuestionAnswer
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.conversationRows
import com.openbitfun.mobile.core.feature.session.modelOptions
import com.openbitfun.mobile.core.feature.session.selectedModelOption
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState

internal const val CONVERSATION_TEST_TAG: String = "conversation"
internal const val CONVERSATION_BACK_TEST_TAG: String = "conversation-back"
internal const val CONVERSATION_LOADING_TEST_TAG: String = "conversation-loading"

/**
 * Grace before a conversation open is announced as a wait, and how long that
 * announcement may stand. A cached transcript normally arrives inside the
 * grace period, and swapping it for a skeleton and back reads as a stall
 * rather than as speed. The cap is the other end: a transcript that never
 * lands would otherwise leave the skeleton standing for the rest of the
 * session, and a placeholder that outlives its subject reads as a hang.
 * Matched to HarmonyOS's `DeferredLoadingGate` and iOS's open gate.
 */
private const val CONVERSATION_LOADING_DELAY_MS: Long = 140
private const val CONVERSATION_LOADING_MAX_VISIBLE_MS: Long = 20_000

/**
 * The transcript itself, tagged so a test can scroll it to a row.
 *
 * Separate from [CONVERSATION_TEST_TAG] because that one sits on the whole
 * surface, header and composer included, and it is not the scrollable.
 */
internal const val CONVERSATION_LIST_TEST_TAG: String = "conversation-list"

/**
 * Joins a dictated fragment onto whatever the composer already holds.
 *
 * Uses the shared policy to preserve existing whitespace and avoid inserting
 * spaces between CJK fragments.
 */
internal fun mergeComposerDraft(existing: String, spoken: String): String =
    com.openbitfun.mobile.core.feature.session.VoiceDraftPolicy.merge(existing, spoken)

/**
 * One open session: the transcript and the composer, ported from
 * `pages/components/ConversationSurface.ets`.
 *
 * The transcript is a lazy list and the composer is pinned below it, so a
 * long session never pushes the input off screen. That is also why this surface
 * replaces the session list rather than sitting under it — the list's own scroll
 * cannot contain a lazy list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationView(
    state: RemoteSessionUiState.Ready,
    phase: ConnectionPhase,
    settingsPlacement: SettingsPlacement,
    onBack: () -> Unit,
    onOpenSidebar: (() -> Unit)? = null,
    onIntent: (RemoteSessionIntent) -> Unit,
    /**
     * Where this transcript is running — a desktop name, or the brand and the
     * branch. Built by `ConversationHeaderPresenter` at the call site, because
     * only the screen knows whether it reached this session through a pairing
     * or through an account device.
     */
    contextTitle: String,
    /** A file the agent named, taken from a markdown link. Path, then label. */
    onOpenFile: (String, String) -> Unit,
    /**
     * The file the preview surface currently holds, normalised, and whether it
     * is still arriving. Passed as two scalars rather than the workspace state:
     * this screen is about the transcript, and the only thing it needs from the
     * preview is which of its own file cards is the one on screen.
     */
    previewingRemotePath: String,
    previewLoading: Boolean,
    download: RemoteFileDownloadUiState,
    onDownloadFile: (String, String) -> Unit,
    modifier: Modifier,
    hostCapabilities: List<String> = emptyList(),
    attachmentOwner: String = "",
) {
    val timeline = state.timeline?.takeIf { it.sessionId == state.selectedSessionId }
    var loadingVisible by remember(attachmentOwner, state.selectedSessionId) { mutableStateOf(false) }
    LaunchedEffect(state.selectedSessionId, timeline == null) {
        loadingVisible = false
        if (timeline == null) {
            kotlinx.coroutines.delay(CONVERSATION_LOADING_DELAY_MS)
            loadingVisible = true
            kotlinx.coroutines.delay(CONVERSATION_LOADING_MAX_VISIBLE_MS)
            loadingVisible = false
        }
    }
    val activeTurn = timeline?.activeTurn
    val sessionId = state.selectedSessionId.orEmpty()
    val rows = remember(timeline) { timeline?.conversationRows().orEmpty() }
    val visibleRows = remember(rows) { rows.filter { it.kind != ConversationRowKind.EMPTY } }
    val uploadedFileCount = rows.sumOf { it.images.size }
    // Resolved here rather than inside the click: a Toast is raised from a
    // callback, and reading resources off `LocalContext` there reads them
    // without the composition's configuration.
    val uploadedFilesMessage = if (uploadedFileCount > 0) {
        stringResource(R.string.session_uploaded_files_count, uploadedFileCount)
    } else {
        stringResource(R.string.session_uploaded_files_empty)
    }
    // The remote composer's single source of truth is the store's draft. Typing,
    // voice, and send all round-trip through `state.draft` so a half-written
    // message survives session switches and process restarts via DraftStore.
    var submittedDraft by remember(attachmentOwner, state.selectedSessionId) { mutableStateOf<String?>(null) }
    val draft = if (submittedDraft == state.draft) "" else state.draft
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // Only the submitted draft is hidden while awaiting acknowledgement. Failure restores it;
    // subsequent typing belongs to the new draft and must never be cleared by the old send.
    LaunchedEffect(state.busy, state.lastSentMessage) {
        if (!state.busy) submittedDraft = null
    }
    val attachments: com.openbitfun.mobile.app.viewmodel.ComposerAttachmentsViewModel =
        androidx.lifecycle.viewmodel.compose.viewModel()
    val context = LocalContext.current
    val attachmentKey = org.json.JSONArray(listOf(attachmentOwner, sessionId)).toString()
    val attachmentDraft = remember(attachmentKey, attachments) {
        attachments.forSession(attachmentKey, java.io.File(context.noBackupFilesDir, "composer-attachments"))
    }
    var images by attachmentDraft.images
    val attachmentsBlocked = attachmentDraft.loading.value || attachmentDraft.saving.value || attachmentDraft.failed.value
    LaunchedEffect(attachmentKey, state.lastSentMessage, attachmentDraft.loading.value) {
        state.lastSentMessage?.takeIf { it.sessionId == sessionId }?.let { sent ->
            images = images.filterNot { it.id in sent.imageIds }
        }
    }
    var showSettings by rememberSaveable(sessionId) { mutableStateOf(false) }
    val pickerScope = rememberCoroutineScope()
    val currentAttachmentKey by rememberUpdatedState(attachmentKey)
    var preparingImage by remember(attachmentKey) { mutableStateOf(false) }
    var pickerOwner by rememberSaveable { mutableStateOf<String?>(null) }
    val importPhotos: (List<android.net.Uri>) -> Unit = { uris ->
        val belongsToCurrentTarget = pickerOwner == attachmentKey
        pickerOwner = null
        if (belongsToCurrentTarget && uris.isNotEmpty() && images.size < MAX_COMPOSER_IMAGES) {
            val targetSession = attachmentKey
            preparingImage = true
            pickerScope.launch {
                try {
                    for (uri in uris.take(MAX_COMPOSER_IMAGES - images.size)) {
                        val prepared = prepareComposerImage(context.contentResolver, uri)
                        if (currentAttachmentKey == targetSession && images.size < MAX_COMPOSER_IMAGES) {
                            images = images + prepared
                        }
                    }
                } catch (_: Exception) {
                    if (currentAttachmentKey == targetSession) {
                        Toast.makeText(context, R.string.chat_image_prepare_failed, Toast.LENGTH_LONG).show()
                    }
                } finally {
                    if (currentAttachmentKey == targetSession) preparingImage = false
                }
            }
        }
    }

    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_COMPOSER_IMAGES), importPhotos)
    val singlePhotoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) importPhotos(listOf(uri))
    }

    val voiceInput = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (text.isNotBlank()) {
                onIntent(RemoteSessionIntent.UpdateDraft(mergeComposerDraft(state.draft, text)))
            }
        }
    }

    androidx.compose.runtime.CompositionLocalProvider(
        com.openbitfun.mobile.app.ui.chat.tool.LocalPermissionMailbox provides state.permissionMailbox,
        com.openbitfun.mobile.app.ui.chat.tool.LocalPlanActions provides com.openbitfun.mobile.app.ui.chat.tool.PlanActions(
            supported = "plan_build_v1" in hostCapabilities,
            enabled = !state.busy && activeTurn == null && phase == ConnectionPhase.CONNECTED,
            build = { plan -> onIntent(RemoteSessionIntent.BuildPlan(sessionId, plan.path, plan.name)) },
        ),
    ) {
        androidx.compose.foundation.layout.BoxWithConstraints(modifier.fillMaxSize()) {
        val mailboxMaxHeight = maxHeight * 0.4f
        // How much of the pane the two floating layers cover, measured rather
        // than assumed: the composer grows with multiline text and attachments,
        // and the mailbox appears without warning. The transcript runs the full
        // height behind them and borrows these as its content insets, so a
        // stale number would leave the first or last message under a capsule.
        var topInset by remember { mutableStateOf(0.dp) }
        var bottomInset by remember { mutableStateOf(0.dp) }
        val density = LocalDensity.current
        Box(modifier = Modifier.fillMaxSize().testTag(CONVERSATION_TEST_TAG)) {
            if (timeline == null) {
                Box(Modifier.fillMaxSize()) {
                    if (loadingVisible) ConversationLoadingState(Modifier.fillMaxSize())
                }
            } else if (visibleRows.isEmpty() && !state.hasMoreMessages) {
                ConversationEmptyState(modifier = Modifier.fillMaxSize())
            } else {
                key(attachmentOwner, sessionId) {
                    ConversationTimelineViewHost(
                        state = state,
                        sessionId = sessionId,
                        visibleRows = visibleRows,
                        images = images,
                        phase = phase,
                        previewingRemotePath = previewingRemotePath,
                        previewLoading = previewLoading,
                        download = download,
                        onDownloadFile = onDownloadFile,
                        onOpenFile = onOpenFile,
                        onIntent = onIntent,
                        topInset = topInset,
                        bottomInset = bottomInset,
                    )
                }
            }

            Column(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .onSizeChanged { topInset = with(density) { it.height.toDp() } },
            ) {
                Column(modifier = Modifier.fillMaxWidth().background(overlayFill())) {
            ConversationHeader(
                title = state.sessions.firstOrNull { it.id == sessionId }?.title.orEmpty(),
                contextTitle = contextTitle,
                canStop = activeTurn != null,
                enabled = !state.busy && sessionId.isNotEmpty(),
                onBack = onBack,
                onOpenSidebar = onOpenSidebar,
                onRename = { title ->
                    onIntent(RemoteSessionIntent.RenameSession(sessionId, title))
                },
                onShowUploadedFiles = {
                    Toast.makeText(context, uploadedFilesMessage, Toast.LENGTH_SHORT).show()
                },
                onStop = {
                    onIntent(RemoteSessionIntent.CancelTurn(sessionId, activeTurn?.turnId))
                },
                modifier = Modifier,
            )

            key(sessionId) { PermissionMailboxView(state.permissionMailbox, sessionId, mailboxMaxHeight, onIntent) }
                }
                ConversationTopEdgeFade()
            }

            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .onSizeChanged { bottomInset = with(density) { it.height.toDp() } }
                    // The fade covers the whole layer, not just a strip above
                    // it: the transcript runs behind the composer, so anything
                    // short of that leaves a line of text sitting crisp and
                    // legible beside the pill after it has already faded out
                    // higher up.
                    .background(bottomOverlayFade()),
            ) {
                if (attachmentDraft.failed.value) {
                    TextButton(onClick = { attachmentDraft.retry() }) {
                        Text(stringResource(R.string.chat_attachment_recovery_failed))
                    }
                }
                ComposerBar(
                    draft = draft,
                    images = images,
                    // An empty session id would send nowhere, so it reads as busy.
                    busy = state.busy || preparingImage || attachmentsBlocked || sessionId.isEmpty(),
                    streaming = activeTurn != null,
                    phase = phase,
                    model = timeline?.selectedModelOption(stringResource(R.string.models_unnamed)),
                    modelOptions = timeline?.modelOptions(stringResource(R.string.models_unnamed)) ?: emptyList(),
                    modelCatalogFailed = state.modelCatalogFailure != null,
                    capabilities = ChatComposerCapabilities.RemoteChat,
                    placeholder = stringResource(R.string.message_input_label),
                    onDraftChange = {
                        submittedDraft = null
                        onIntent(RemoteSessionIntent.UpdateDraft(it))
                    },
                    onRemoveImage = { id -> images = images.filterNot { it.id == id } },
                    onOpenModels = { showSettings = true },
                    onSelectModel = { modelId ->
                        onIntent(RemoteSessionIntent.SelectModel(sessionId, modelId))
                    },
                    modifier = Modifier,
                    onAttach = {
                        pickerOwner = attachmentKey
                        val remaining = MAX_COMPOSER_IMAGES - images.size
                        if (remaining == 1) singlePhotoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        else if (remaining > 1) photoPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly, maxItems = remaining),
                        )
                    },
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
                        submittedDraft = draft
                        keyboard?.hide()
                        focusManager.clearFocus(force = true)
                        onIntent(
                            RemoteSessionIntent.SendMessage(
                                sessionId,
                                draft,
                                images.takeIf { it.isNotEmpty() },
                            ),
                        )
                    },
                    onStop = {
                        onIntent(RemoteSessionIntent.CancelTurn(sessionId, activeTurn?.turnId))
                    },
                )
            }
        }
        }

    }

    if (showSettings) {
        AdaptiveModalSurface(
            visible = true,
            placement = settingsPlacement,
            onDismissRequest = { showSettings = false },
        ) { surfaceModifier ->
            RemoteSettingsSheet(
                state = state,
                sessionId = sessionId,
                onIntent = onIntent,
                modifier = surfaceModifier.padding(16.dp),
            )
        }
    }
}

/**
 * The timeline call is long enough that inlining it under the floating layout
 * buried the layout itself. Nothing here is new behaviour; it is the same call
 * with the measured insets handed through.
 */
@Composable
private fun ConversationTimelineViewHost(
    state: RemoteSessionUiState.Ready,
    sessionId: String,
    visibleRows: List<ConversationRow>,
    images: List<ComposerImage>,
    phase: ConnectionPhase,
    previewingRemotePath: String,
    previewLoading: Boolean,
    download: RemoteFileDownloadUiState,
    onDownloadFile: (String, String) -> Unit,
    onOpenFile: (String, String) -> Unit,
    onIntent: (RemoteSessionIntent) -> Unit,
    topInset: Dp,
    bottomInset: Dp,
) {
    ConversationTimelineView(
        rows = visibleRows,
        hasMoreMessages = state.hasMoreMessages,
        historyLoadState = state.historyLoadState,
        onLoadOlder = { onIntent(RemoteSessionIntent.LoadOlderMessages) },
        enabled = !state.busy,
        onApproveTool = { toolId, updatedInput ->
            onIntent(RemoteSessionIntent.ApproveTool(sessionId, toolId, updatedInput))
        },
        onRejectTool = { toolId, reason ->
            onIntent(RemoteSessionIntent.RejectTool(sessionId, toolId, reason))
        },
        onCancelTool = { toolId, reason ->
            onIntent(RemoteSessionIntent.CancelTool(sessionId, toolId, reason))
        },
        onAnswerTool = { toolId, answer ->
            onIntent(RemoteSessionIntent.AnswerQuestion(sessionId, toolId, answer))
        },
        onAnswerToolStructured = { toolId, answers ->
            onIntent(AnswerStructuredQuestion(sessionId, toolId, answers))
        },
        onRetry = { row ->
            val retryImages = row.images.map { image ->
                images.firstOrNull { it.dataUrl == image.dataUrl } ?: ComposerImage(
                    id = image.name,
                    dataUrl = image.dataUrl,
                    mimeType = image.dataUrl.substringAfter("data:").substringBefore(';'),
                )
            }
            onIntent(RemoteSessionIntent.SendMessage(sessionId, row.text, retryImages))
        },
        onOpenFile = onOpenFile,
        previewingRemotePath = previewingRemotePath,
        previewLoading = previewLoading,
        download = download,
        onDownloadFile = onDownloadFile,
        downloadEnabled = !state.busy && phase == ConnectionPhase.CONNECTED,
        modifier = Modifier.fillMaxSize(),
        topInset = topInset,
        bottomInset = bottomInset,
    )
}

/**
 * Softens where the transcript meets a floating layer. Without it a line of
 * text is cut in half at the capsule's edge and reads as clipped rather than as
 * continuing underneath.
 */
/**
 * The floor under the bottom layer: transparent where the transcript is still
 * fully readable, settling into the page colour by the time it reaches the
 * composer. Matches the gradient HarmonyOS paints behind the same layer.
 */
@Composable
private fun bottomOverlayFade(): Brush = Brush.verticalGradient(
    // The page colour at zero alpha rather than a bare transparent: a gradient
    // run to plain transparent interpolates through grey and leaves a smudge
    // over the transcript.
    0f to overlayFill().copy(alpha = 0f),
    0.45f to overlayFill(),
    1f to overlayFill(),
)

/**
 * Carries the header's opaque band down into the transcript, so a line of text
 * is not cut in half at its edge. The bottom layer needs no strip of its own —
 * its whole background is [bottomOverlayFade].
 */
@Composable
private fun ConversationTopEdgeFade() {
    val page = MaterialTheme.colorScheme.background
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(MobileDesignGeometry.ConversationEdgeFadeHeight)
            .background(Brush.verticalGradient(listOf(page, page.copy(alpha = 0f)))),
    )
}

/**
 * The floor under the top layer. Compose has no first-party backdrop blur, so
 * where iOS and HarmonyOS put a material this puts a near-opaque page colour:
 * the transcript still passes behind it, and the header stays readable over
 * whatever is passing.
 */
@Composable
private fun overlayFill(): Color = MaterialTheme.colorScheme.background.copy(alpha = 0.94f)

@Composable
private fun ConversationLoadingState(modifier: Modifier) {
    Column(modifier.testTag(CONVERSATION_LOADING_TEST_TAG).padding(horizontal = 22.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        listOf(0.72f to 78, 0.46f to 42, 0.84f to 112).forEachIndexed { index, (width, height) ->
            Box(Modifier.fillMaxWidth(), contentAlignment = if (index == 1) androidx.compose.ui.Alignment.CenterEnd else androidx.compose.ui.Alignment.CenterStart) {
                Column(Modifier.fillMaxWidth(width).height(height.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    listOf(0.74f, 0.92f, 0.58f).forEach { fraction ->
                        Box(Modifier.fillMaxWidth(fraction).height(6.dp)
                            .background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(3.dp)))
                    }
                }
            }
        }
    }
}

@Composable
internal fun PermissionMailboxView(state: com.openbitfun.mobile.core.feature.session.PermissionMailboxUiState, sessionId: String, maxHeight: androidx.compose.ui.unit.Dp, onIntent: (RemoteSessionIntent) -> Unit) {
    if (!state.failed && state.requests.isEmpty() && state.questions.isEmpty()) return
    Column(Modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(MobileDesignGeometry.ApprovalCardGap)) {
        if (state.failed) Text(stringResource(R.string.permission_mailbox_failed))
        if (state.failed) androidx.compose.material3.TextButton(onClick = { onIntent(RemoteSessionIntent.RefreshPermissionMailbox) }) {
            Text(stringResource(R.string.sessions_retry))
        }
        state.questions.forEach { question ->
            androidx.compose.runtime.key(sessionId, question.id) {
                Column(Modifier.fillMaxWidth().pointerInput(question.id) {
                    awaitEachGesture { awaitFirstDown(requireUnconsumed = false); onIntent(RemoteSessionIntent.StartQuestionInteraction(question.id)) }
                }) {
                    if (question.questions.isNotEmpty()) {
                        com.openbitfun.mobile.app.ui.chat.tool.ToolStructuredQuestionPanel(
                            toolId = question.id, questions = question.questions, enabled = !state.busy,
                            onSubmit = { answers -> onIntent(RemoteSessionIntent.AnswerStructuredQuestion(sessionId, question.id, answers)) })
                    } else {
                        com.openbitfun.mobile.app.ui.chat.tool.ToolQuestionAnswerPanel(
                            toolId = question.id, prompt = question.question ?: stringResource(R.string.tool_question_default), enabled = !state.busy,
                            onSubmit = { answer -> onIntent(RemoteSessionIntent.AnswerQuestion(sessionId, question.id, answer)) })
                    }
                }
            }
        }
        state.requests.forEach { request ->
            androidx.compose.runtime.key(sessionId, request.requestId) {
                var edit by rememberSaveable { mutableStateOf(false) }
                var input by rememberSaveable { mutableStateOf("{}") }
                val valid = !edit || runCatching { org.json.JSONObject(input) }.isSuccess
                Column(Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(MobileDesignGeometry.ApprovalCardRadius))
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(MobileDesignGeometry.ApprovalCardRadius))
                    .padding(MobileDesignGeometry.ApprovalCardPadding),
                    verticalArrangement = Arrangement.spacedBy(MobileDesignGeometry.ApprovalCardGap)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Image(painterResource(R.drawable.approval_shield), contentDescription = null, modifier = Modifier.size(16.dp))
                        Text(request.source.ifBlank { request.action }, modifier = Modifier.weight(1f), style = MobileDesignTypography.BodySmall)
                        TextButton(onClick = { edit = !edit }, enabled = !state.busy,
                            modifier = Modifier.height(32.dp), contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Text(stringResource(if (edit) R.string.tool_hide_approval_input else R.string.tool_edit_approval_input), style = MobileDesignTypography.LabelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (request.source.isNotBlank() && !request.source.equals(request.action, ignoreCase = true)) {
                        Text(request.action, style = MobileDesignTypography.BodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (request.resources.isNotEmpty()) {
                        Text(request.resources.joinToString("\n"), style = MobileDesignTypography.LabelSmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(10.dp))
                    }
                    if (edit) androidx.compose.material3.OutlinedTextField(value = input, onValueChange = { input = it }, enabled = !state.busy,
                        isError = !valid, modifier = Modifier.fillMaxWidth().heightIn(max = 120.dp), textStyle = MobileDesignTypography.LabelSmall.copy(fontFamily = FontFamily.Monospace))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                        Button(onClick = { onIntent(RemoteSessionIntent.RespondPermission(request.requestId, false, null)) }, enabled = !state.busy,
                            shape = RoundedCornerShape(MobileDesignGeometry.ApprovalActionRadius),
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurface),
                            modifier = Modifier.height(MobileDesignGeometry.ApprovalActionHeight)) { Text(stringResource(R.string.tool_reject), style = MobileDesignTypography.LabelMedium) }
                        Button(onClick = { onIntent(RemoteSessionIntent.RespondPermission(request.requestId, true, if (edit) input else null)) }, enabled = !state.busy && valid,
                            shape = RoundedCornerShape(MobileDesignGeometry.ApprovalActionRadius), modifier = Modifier.height(MobileDesignGeometry.ApprovalActionHeight)) {
                            Text(stringResource(R.string.tool_approve), style = MobileDesignTypography.LabelMedium)
                        }
                    }
                }
            }
        }
    }
}
