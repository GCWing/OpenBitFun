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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.settings.RemoteSettingsSheet
import com.openbitfun.mobile.app.ui.common.AdaptiveModalSurface
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.ComposerImage
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
            kotlinx.coroutines.delay(140)
            loadingVisible = true
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
        Column(modifier = Modifier.fillMaxSize().testTag(CONVERSATION_TEST_TAG)) {
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
            if (timeline == null) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    if (loadingVisible) ConversationLoadingState(Modifier.fillMaxSize())
                }
            } else if (visibleRows.isEmpty() && !state.hasMoreMessages) {
                ConversationEmptyState(modifier = Modifier.weight(1f).fillMaxWidth())
            } else {
                key(attachmentOwner, sessionId) {
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
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                }
            }
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
