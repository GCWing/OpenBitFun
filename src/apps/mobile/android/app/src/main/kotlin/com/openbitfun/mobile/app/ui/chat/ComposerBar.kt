package com.openbitfun.mobile.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.OpenBitFunEaseOut
import com.openbitfun.mobile.app.ui.theme.MotionQuickMillis
import com.openbitfun.mobile.app.ui.theme.MotionStructureMillis
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignBreakpoints
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.ChatComposerPolicy
import com.openbitfun.mobile.core.feature.session.ComposerImage
import com.openbitfun.mobile.core.feature.session.ComposerPrimaryAction
import com.openbitfun.mobile.core.feature.session.ModelOption

internal const val COMPOSER_TEST_TAG: String = "composer"
internal const val COMPOSER_INPUT_TEST_TAG: String = "composer-input"
internal const val COMPOSER_SEND_TEST_TAG: String = "composer-send"
internal const val MODEL_CONTROL_TEST_TAG: String = "composer-model-control"
internal const val MODEL_SELECTOR_TEST_TAG: String = "composer-model-selector"
internal const val MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX: String = "composer-model-option:"

/** The relay refuses more than this, and refusing here is a better error. */
internal const val MAX_COMPOSER_IMAGES: Int = 4

internal fun composerIsWide(screenWidthDp: Int): Boolean =
    screenWidthDp >= MobileDesignBreakpoints.Wide

// The measurements come straight from `ComposerBar.ets`, which sizes the bar in
// vp — the same unit as dp. Naming them keeps the two files diffable.
private val ActionSize = MobileDesignGeometry.ComposerActionSize
private val InputHeight = MobileDesignGeometry.ComposerInputHeight
private val ExpandedInputHeight = MobileDesignGeometry.ComposerExpandedInputHeight
private val CollapsedBarHeight = MobileDesignGeometry.ComposerCollapsedHeight
private val ExpandedInputRowHeight = MobileDesignGeometry.ComposerExpandedInputRowHeight
private val ExpandedActionRowHeight = MobileDesignGeometry.ComposerExpandedActionRowHeight

/**
 * The input bar, ported from `pages/components/ComposerBar.ets`.
 *
 * It is a floating pill rather than a docked band, and it has two forms: a
 * one-line row while the user is elsewhere, and a taller one — field on its own
 * row, controls beneath — once they are writing. Both are [ChatComposerPolicy]'s
 * call rather than this file's, along with which single action the round button
 * on the right is offering. The two clients must agree on all of it: a message
 * refused after the fact reads as a lost message.
 *
 * [capabilities] is what lets general chat reuse the bar unchanged: it has no
 * desktop to wait for and no attachment pipeline, and hiding those controls is
 * the difference between the two surfaces, not a second widget.
 *
 * There is no in-app listening state here, unlike HarmonyOS: Android dictation
 * is a system activity that draws its own listening UI on top of this one.
 */
@Composable
internal fun ComposerBar(
    draft: String,
    images: List<ComposerImage>,
    busy: Boolean,
    streaming: Boolean,
    phase: ConnectionPhase,
    model: ModelOption?,
    modelOptions: List<ModelOption> = emptyList(),
    /**
     * Whether the model catalog command failed and left no selectable models.
     * When true the bar still offers the model control so the settings sheet can
     * explain the failure and offer Retry, instead of silently dropping the
     * control and hiding the only route to that explanation.
     */
    modelCatalogFailed: Boolean = false,
    capabilities: ChatComposerCapabilities,
    /**
     * What the empty field says. Every surface asks for something different —
     * a message into an open session, or the first instruction of a session
     * that does not exist yet — and the source gives each its own wording.
     */
    placeholder: String,
    onDraftChange: (String) -> Unit,
    onRemoveImage: (String) -> Unit,
    onAttach: () -> Unit,
    onVoice: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onOpenModels: () -> Unit,
    onSelectModel: (String) -> Unit = {},
    modifier: Modifier,
) {
    var modelSelectorOpen by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val expanded = ChatComposerPolicy.isExpanded(
        text = draft,
        inputFocused = focused,
        // Android has no quick-action panel — the add button opens the system
        // photo picker directly — and the model list is a sheet that covers the
        // bar rather than a popover anchored to it.
        quickActionsOpen = false,
        modelSelectorOpen = modelSelectorOpen,
    )
    val action = ChatComposerPolicy.primaryAction(
        text = draft,
        attachmentCount = images.size,
        busy = busy,
        streaming = streaming,
        requiresRemoteConnection = capabilities.requiresRemoteConnection,
        phase = phase,
        showVoiceInput = capabilities.showVoiceInput,
    )
    val structureSpec = tween<androidx.compose.ui.unit.Dp>(
        durationMillis = MotionStructureMillis,
        easing = OpenBitFunEaseOut,
    )
    val radius by animateDpAsState(
        if (expanded || images.isNotEmpty()) {
            MobileDesignGeometry.ComposerExpandedRadius
        } else {
            MobileDesignGeometry.ComposerCollapsedRadius
        },
        structureSpec,
        label = "composer-radius",
    )
    val contentTopPadding by animateDpAsState(
        if (expanded) 4.dp else 0.dp,
        structureSpec,
        label = "composer-top-padding",
    )
    val contentBottomPadding by animateDpAsState(
        if (expanded) 2.dp else 0.dp,
        structureSpec,
        label = "composer-bottom-padding",
    )
    val inputRowHeight by animateDpAsState(
        if (expanded) ExpandedInputRowHeight else CollapsedBarHeight,
        structureSpec,
        label = "composer-input-row-height",
    )
    val actionSpacing by animateDpAsState(
        if (expanded) 0.dp else 5.dp,
        structureSpec,
        label = "composer-action-spacing",
    )
    val actionRowOffset = with(LocalDensity.current) { 8.dp.roundToPx() }
    val actionEnter = fadeIn(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) +
        slideInVertically(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) { actionRowOffset }
    val actionExit = fadeOut(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) +
        slideOutVertically(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) { actionRowOffset }
    val compactControlEnter = fadeIn(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) +
        expandHorizontally(tween(MotionQuickMillis, easing = OpenBitFunEaseOut))
    val compactControlExit = fadeOut(tween(MotionQuickMillis, easing = OpenBitFunEaseOut)) +
        shrinkHorizontally(tween(MotionQuickMillis, easing = OpenBitFunEaseOut))

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(
                start = MobileDesignGeometry.ConversationOverlaySideInset,
                end = MobileDesignGeometry.ConversationOverlaySideInset,
                top = 8.dp,
                bottom = 14.dp,
            )
            .testTag(COMPOSER_TEST_TAG),
    ) {
        Surface(
            shape = RoundedCornerShape(radius),
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 2.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(2.dp),
                modifier = Modifier.padding(
                    PaddingValues(
                        start = 8.dp,
                        end = 8.dp,
                        top = contentTopPadding,
                        bottom = contentBottomPadding,
                    ),
                ),
            ) {
                if (capabilities.supportsAttachments && images.isNotEmpty()) {
                    AttachmentStrip(
                        images = images,
                        enabled = !busy,
                        onRemove = onRemoveImage,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(actionSpacing),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = inputRowHeight),
                ) {
                    // While expanded both side controls move to the row below,
                    // so the field gets the full width for what is being typed.
                    AnimatedVisibility(
                        visible = !expanded && capabilities.supportsAttachments && capabilities.showAddButton,
                        enter = compactControlEnter,
                        exit = compactControlExit,
                    ) {
                        AddButton(
                            enabled = !busy && images.size < MAX_COMPOSER_IMAGES,
                            onClick = onAttach,
                        )
                    }
                    ComposerField(
                        draft = draft,
                        enabled = !busy,
                        expanded = expanded,
                        placeholder = placeholder,
                        onDraftChange = onDraftChange,
                        onFocusChange = { focused = it },
                        modifier = Modifier.weight(1f),
                    )
                    AnimatedVisibility(
                        visible = !expanded,
                        enter = compactControlEnter,
                        exit = compactControlExit,
                    ) {
                        if (capabilities.showVoiceInput && !busy && (draft.isNotBlank() || images.isNotEmpty())) {
                            PrimaryActionButton(action = ComposerPrimaryAction.VOICE, onVoice = onVoice, onSend = onSend, onStop = onStop, testTag = "composer-voice")
                        }
                        PrimaryActionButton(
                            action = action,
                            onVoice = onVoice,
                            onSend = onSend,
                            onStop = onStop,
                        )
                    }
                }

                AnimatedVisibility(
                    visible = expanded,
                    enter = actionEnter,
                    exit = actionExit,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(ExpandedActionRowHeight)
                            .padding(start = 2.dp),
                    ) {
                        if (capabilities.supportsAttachments && capabilities.showAddButton) {
                            AddButton(
                                enabled = !busy && images.size < MAX_COMPOSER_IMAGES,
                                onClick = onAttach,
                            )
                        }
                        // The model belongs to the session, but it is chosen
                        // here: it is the one setting a user changes mid-turn.
                        if (model != null || modelOptions.isNotEmpty() || modelCatalogFailed) {
                            ModelControl(
                                model = model,
                                enabled = !busy,
                                modelOptions = modelOptions,
                                onClick = {
                                    if (modelOptions.isEmpty()) onOpenModels() else modelSelectorOpen = true
                                },
                                onSelectModel = { id ->
                                    onSelectModel(id)
                                    modelSelectorOpen = false
                                },
                                selectorOpen = modelSelectorOpen,
                                onSelectorDismiss = { modelSelectorOpen = false },
                            )
                        }
                        Box(modifier = Modifier.weight(1f))
                        if (capabilities.showVoiceInput && !busy && (draft.isNotBlank() || images.isNotEmpty())) {
                            PrimaryActionButton(action = ComposerPrimaryAction.VOICE, onVoice = onVoice, onSend = onSend, onStop = onStop, testTag = "composer-voice")
                        }
                        PrimaryActionButton(
                            action = action,
                            onVoice = onVoice,
                            onSend = onSend,
                            onStop = onStop,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The field itself: a bare text field on the pill's own background.
 *
 * A Material `OutlinedTextField` would draw a second border and a floating label
 * inside a shape that is already the input, which is why the placeholder is
 * hand-drawn here.
 */
@Composable
private fun ComposerField(
    draft: String,
    enabled: Boolean,
    expanded: Boolean,
    placeholder: String,
    onDraftChange: (String) -> Unit,
    onFocusChange: (Boolean) -> Unit,
    modifier: Modifier,
) {
    val colors = MaterialTheme.colorScheme
    BasicTextField(
        value = draft,
        onValueChange = onDraftChange,
        enabled = enabled,
        // Collapsed the bar is one line tall, so the field must not grow past
        // it; expanded it stops at four and scrolls, as the other client does.
        maxLines = if (expanded) 4 else 1,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.onSurface),
        modifier = modifier
            .heightIn(min = if (expanded) ExpandedInputHeight else InputHeight)
            .onFocusChanged { onFocusChange(it.isFocused) }
            .testTag(COMPOSER_INPUT_TEST_TAG),
        decorationBox = { field ->
            Box(
                contentAlignment = Alignment.CenterStart,
                modifier = Modifier.padding(
                    start = 4.dp,
                    end = 4.dp,
                    top = if (expanded) 10.dp else 9.dp,
                    bottom = if (expanded) 8.dp else 9.dp,
                ),
            ) {
                if (draft.isEmpty()) {
                    Text(
                        placeholder,
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.onSurfaceVariant,
                    )
                }
                field()
            }
        },
    )
}

/** The attachment control: a plain glyph, sized to match the primary action. */
@Composable
private fun AddButton(enabled: Boolean, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(ActionSize)
            .clip(CircleShape)
            .clickable(role = Role.Button, enabled = enabled, onClick = onClick),
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_plus),
            contentDescription = stringResource(R.string.message_attach_image),
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(22.dp).alpha(if (enabled) 1f else DimmedAlpha),
        )
    }
}

/**
 * The current model, as a label the user can press rather than a chip.
 *
 * It only exists in the expanded form, matching the other client: a model swap
 * is something you do while writing the message it applies to.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelControl(
    model: ModelOption?,
    enabled: Boolean,
    modelOptions: List<ModelOption>,
    onClick: () -> Unit,
    onSelectModel: (String) -> Unit,
    selectorOpen: Boolean,
    onSelectorDismiss: () -> Unit,
) {
    val label = stringResource(R.string.models_title)
    val displayModel = model ?: modelOptions.firstOrNull { it.selected }
    val displayLabel = displayModel?.primaryLabel ?: label
    val wide = composerIsWide(LocalConfiguration.current.screenWidthDp)
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            modifier = Modifier
                .heightIn(min = MobileDesignGeometry.ComposerActionSize)
                .widthIn(max = 220.dp)
                .clip(RoundedCornerShape(9.dp))
                .clickable(enabled = enabled, onClick = onClick)
                .padding(horizontal = 4.dp)
                .testTag(MODEL_CONTROL_TEST_TAG)
                .semantics {
                    contentDescription = "$label · $displayLabel"
                    role = Role.Button
                },
        ) {
            Text(
                displayLabel,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(
                painterResource(
                    if (selectorOpen) R.drawable.ic_symbol_chevron_up
                    else R.drawable.ic_symbol_chevron_down,
                ),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(14.dp).alpha(0.68f),
            )
        }
        if (wide) {
            DropdownMenu(
                expanded = selectorOpen,
                onDismissRequest = onSelectorDismiss,
                modifier = Modifier.width(MobileDesignGeometry.ComposerModelSelectorWidth),
                shape = RoundedCornerShape(MobileDesignGeometry.ComposerModelSelectorRadius),
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                tonalElevation = 0.dp,
                shadowElevation = MobileDesignGeometry.PopoverShadowRadius,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                ModelSelectorContent(
                    options = modelOptions,
                    onSelect = onSelectModel,
                    compact = true,
                    onDismiss = onSelectorDismiss,
                )
            }
        }
    }
    if (!wide && selectorOpen) {
        ModalBottomSheet(
            onDismissRequest = onSelectorDismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.surface,
            shape = RoundedCornerShape(
                topStart = MobileDesignGeometry.SelectionTopRadius,
                topEnd = MobileDesignGeometry.SelectionTopRadius,
            ),
            dragHandle = null,
        ) {
            ModelSelectorContent(
                options = modelOptions,
                onSelect = onSelectModel,
                compact = false,
                onDismiss = onSelectorDismiss,
            )
        }
    }
}

@Composable
private fun ModelSelectorContent(
    options: List<ModelOption>,
    onSelect: (String) -> Unit,
    compact: Boolean,
    onDismiss: () -> Unit,
) {
    val selectorOptions = remember(options) {
        options.filter(ModelOption::selected) + options.filterNot(ModelOption::selected)
    }
    val visibleRows = selectorOptions.size.coerceAtMost(7)
    val listHeight = if (visibleRows == 0) {
        MobileDesignGeometry.ComposerModelSelectorRowHeight
    } else {
        MobileDesignGeometry.ComposerModelSelectorRowHeight * visibleRows +
            MobileDesignGeometry.ComposerModelSelectorRowGap * (visibleRows - 1)
    }
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            // Material's anchored menu reserves 8dp vertically around its
            // content. Add only the remaining 2dp there so both the popover
            // and the sheet expose the HarmonyOS 10dp inner inset.
            .padding(horizontal = 10.dp, vertical = if (compact) 2.dp else 10.dp)
            .testTag(MODEL_SELECTOR_TEST_TAG),
    ) {
        if (!compact) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().heightIn(min = MobileDesignGeometry.SelectionCloseSize),
            ) {
                Text(
                    stringResource(R.string.model_selector_title),
                    fontSize = MaterialTheme.typography.labelLarge.fontSize,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(MobileDesignGeometry.SelectionCloseSize)
                        .clip(CircleShape)
                        .clickable(role = Role.Button, onClick = onDismiss),
                ) {
                    Icon(
                        painterResource(R.drawable.ic_symbol_xmark),
                        contentDescription = stringResource(R.string.common_close),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(15.dp),
                    )
                }
            }
        }
        if (selectorOptions.isEmpty()) {
            Text(
                stringResource(R.string.model_selector_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = MobileDesignGeometry.ComposerModelSelectorRowHeight)
                    .padding(horizontal = 10.dp, vertical = 14.dp),
            )
        } else {
            Column(
                verticalArrangement = Arrangement.spacedBy(
                    MobileDesignGeometry.ComposerModelSelectorRowGap,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(listHeight)
                    .verticalScroll(rememberScrollState()),
            ) {
                selectorOptions.forEach { option ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = MobileDesignGeometry.ComposerModelSelectorRowHeight)
                            .clip(
                                RoundedCornerShape(
                                    MobileDesignGeometry.ComposerModelSelectorRowRadius,
                                ),
                            )
                            .background(
                                if (option.selected) MaterialTheme.colorScheme.surfaceVariant
                                else openBitFunColors.transparent,
                            )
                            .clickable { onSelect(option.id) }
                            .semantics {
                                contentDescription =
                                    "${option.primaryLabel} · ${option.secondaryLabel}"
                                role = Role.Button
                                selected = option.selected
                            }
                            .padding(horizontal = 10.dp, vertical = 8.dp)
                            .testTag(MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX + option.id),
                    ) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier.size(20.dp),
                        ) {
                            if (option.selected) {
                                Icon(
                                    painterResource(R.drawable.ic_symbol_checkmark_circle),
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                        Column(
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(
                                option.primaryLabel,
                                fontSize = MaterialTheme.typography.labelLarge.fontSize,
                                fontWeight = FontWeight.Medium,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                option.secondaryLabel,
                                fontSize = MaterialTheme.typography.bodySmall.fontSize,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** What a control that is offered but not usable right now looks like. */
private const val DimmedAlpha: Float = 0.38f

/**
 * One slot, never two actions.
 *
 * Which action it holds is [ChatComposerPolicy.primaryAction]'s decision; this
 * only draws it. Stop is the one state with a filled background, because it is
 * the one state where pressing the button undoes something.
 */
@Composable
private fun PrimaryActionButton(
    action: ComposerPrimaryAction,
    onVoice: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    testTag: String = COMPOSER_SEND_TEST_TAG,
) {
    val colors = MaterialTheme.colorScheme
    val enabled = action == ComposerPrimaryAction.STOP ||
        action == ComposerPrimaryAction.SEND ||
        action == ComposerPrimaryAction.VOICE
    val description = when (action) {
        ComposerPrimaryAction.STOP -> R.string.message_stop
        ComposerPrimaryAction.VOICE, ComposerPrimaryAction.VOICE_BLOCKED ->
            R.string.message_voice_input
        else -> R.string.message_send
    }
    val actionDescription = stringResource(description)

    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(ActionSize)
            .clip(CircleShape)

            .clickable(enabled = enabled) {
                when (action) {
                    ComposerPrimaryAction.STOP -> onStop()
                    ComposerPrimaryAction.SEND -> onSend()
                    ComposerPrimaryAction.VOICE -> onVoice()
                    else -> Unit
                }
            }
            .semantics {
                contentDescription = actionDescription
                role = Role.Button
            }
            .testTag(testTag),
    ) {
        if (action == ComposerPrimaryAction.SEND || action == ComposerPrimaryAction.STOP) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(colors.primary))
        }
        when (action) {
            // The same neutral primary disc as send, matching the reference composer.
            ComposerPrimaryAction.STOP -> Box(
                modifier = Modifier
                    .size(10.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(colors.onPrimary),
            )

            ComposerPrimaryAction.VOICE, ComposerPrimaryAction.VOICE_BLOCKED -> Icon(
                painterResource(R.drawable.ic_symbol_mic),
                contentDescription = null,
                tint = colors.onSurface,
                modifier = Modifier.size(22.dp).alpha(
                    if (action == ComposerPrimaryAction.VOICE) 1f else DimmedAlpha,
                ),
            )

            else -> Icon(
                painterResource(R.drawable.ic_symbol_arrow_up),
                contentDescription = null,
                tint = if (action == ComposerPrimaryAction.SEND) colors.onPrimary else colors.onSurfaceVariant,
                modifier = Modifier.size(20.dp).alpha(
                    if (action == ComposerPrimaryAction.SEND) 1f else DimmedAlpha,
                ),
            )
        }
    }
}

/**
 * The pending attachments, each with its own remove control.
 *
 * A count alone was not enough: the picker can only add, so without a per-image
 * remove the only way to drop a wrong photo was to send it.
 */
@Composable
private fun AttachmentStrip(
    images: List<ComposerImage>,
    enabled: Boolean,
    onRemove: (String) -> Unit,
    modifier: Modifier,
) {
    LazyRow(
        modifier = modifier.height(64.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(end = 4.dp),
    ) {
        items(images, key = { it.id }) { image ->
            Box(modifier = Modifier.size(64.dp)) {
                val bitmap = remember(image.dataUrl) { decodeInlineImage(image.dataUrl) }
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.size(64.dp).clip(RoundedCornerShape(14.dp)),
                    )
                } else {
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.size(64.dp),
                    ) {
                        Text(
                            stringResource(R.string.chat_image),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(4.dp),
                        )
                    }
                }
                // Media controls sit over arbitrary photo content, so their
                // scrim is a dedicated mobile design token.
                val removeLabel = stringResource(R.string.message_remove_image)
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(openBitFunColors.mediaScrim)
                        .clickable(role = Role.Button, enabled = enabled) { onRemove(image.id) }
                        .semantics { contentDescription = removeLabel },
                ) {
                    Text(
                        "×",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
            }
        }
    }
}
