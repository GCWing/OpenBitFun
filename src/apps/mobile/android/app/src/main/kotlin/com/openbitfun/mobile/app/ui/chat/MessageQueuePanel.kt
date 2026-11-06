package com.openbitfun.mobile.app.ui.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.zIndex
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.core.feature.session.MessageQueueFailure
import com.openbitfun.mobile.core.feature.session.MessageQueueUiState
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent

/** Host receipts stay authoritative; a gesture submits one move only on release. */
@Composable
internal fun MessageQueuePanel(state: MessageQueueUiState, onIntent: (RemoteSessionIntent) -> Unit) {
    if (state.items.isEmpty() && state.failure == null) return
    var expanded by remember(state.sessionId) { mutableStateOf(true) }
    var menuId by remember(state.sessionId) { mutableStateOf<String?>(null) }
    var dragging by remember(state.sessionId) { mutableStateOf<String?>(null) }
    var displacement by remember { mutableFloatStateOf(0f) }
    var destination by remember { mutableStateOf<String?>(null) }
    var dragBounds by remember { mutableStateOf<Map<String, Rect>>(emptyMap()) }
    val bounds = remember { mutableMapOf<String, Rect>() }
    val queued = state.items.filter { it.status == "queued" }.map { it.id }
    val enabled = state.supportsReorder && !state.busy && state.failure == null
    val latestIntent by rememberUpdatedState(onIntent)
    val moveUp = stringResource(R.string.queue_move_up)
    val moveDown = stringResource(R.string.queue_move_down)
    val handleLabel = stringResource(R.string.queue_reorder)
    LaunchedEffect(state.revisionKey, state.busy, state.failure) { dragging = null; displacement = 0f }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        TextButton(onClick = { expanded = !expanded }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant), contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text(stringResource(R.string.queue_title, state.items.size), style = MaterialTheme.typography.labelMedium)
            Icon(painterResource(if (expanded) R.drawable.ic_symbol_chevron_down else R.drawable.ic_symbol_chevron_up), null, Modifier.size(14.dp))
        }
        if (state.failure != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(if (state.failure == MessageQueueFailure.UNSUPPORTED) R.string.queue_unsupported else R.string.queue_refresh_required), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { onIntent(RemoteSessionIntent.RefreshMessageQueue) }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !state.busy) { Text(stringResource(R.string.queue_refresh)) }
            }
        }
        if (expanded) Column(Modifier.heightIn(max = 192.dp).verticalScroll(rememberScrollState())) {
            state.items.forEach { item ->
                key(item.id) {
                    val index = queued.indexOf(item.id)
                    val canMove = enabled && index >= 0 && queued.size > 1
                    val ink = MaterialTheme.colorScheme.onSurfaceVariant
                    val marker = MaterialTheme.colorScheme.primary
                    Column(Modifier.onGloballyPositioned { bounds[item.id] = it.boundsInRoot() }
                        .graphicsLayer { if (dragging == item.id) translationY = displacement }
                        .zIndex(if (dragging == item.id) 1f else 0f)
                        .background(if (dragging == item.id) MaterialTheme.colorScheme.surfaceContainer else openBitFunColors.transparent)
                        .drawWithContent {
                            drawContent()
                            if (dragging != null && dragging != item.id) {
                                val y = if (destination == item.id) 0f
                                    else if (destination == null && item.id == queued.lastOrNull { it != dragging }) size.height
                                    else null
                                if (y != null) drawLine(marker, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
                            }
                        }
                        .semantics {
                            customActions = if (canMove) listOfNotNull(
                                if (index > 0) CustomAccessibilityAction(moveUp) { onIntent(RemoteSessionIntent.MoveQueuedMessage(item.id, queued[index - 1])); true } else null,
                                if (index < queued.lastIndex) CustomAccessibilityAction(moveDown) { onIntent(RemoteSessionIntent.MoveQueuedMessage(item.id, queued.getOrNull(index + 2))); true } else null,
                            ) else emptyList()
                        }) {
                        HorizontalDivider(Modifier.padding(horizontal = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.Top) {
                            if (state.supportsReorder) IconButton(onClick = { menuId = item.id }, enabled = canMove,
                                modifier = Modifier.size(width = 48.dp, height = 48.dp).pointerInput(item.id, queued, enabled, state.revisionKey) {
                                    if (canMove) detectDragGesturesAfterLongPress(
                                        onDragStart = { dragBounds = bounds.toMap(); dragging = item.id; displacement = 0f; destination = queued.getOrNull(index + 1) },
                                        onDragCancel = { dragging = null; displacement = 0f },
                                        onDragEnd = {
                                            if (dragging == item.id && destination != queued.getOrNull(index + 1)) latestIntent(RemoteSessionIntent.MoveQueuedMessage(item.id, destination))
                                            dragging = null; displacement = 0f
                                        },
                                        onDrag = { change, amount ->
                                            change.consume(); displacement += amount.y
                                            val center = (dragBounds[item.id]?.center?.y ?: 0f) + displacement
                                            destination = queued.firstOrNull { it != item.id && center < (dragBounds[it]?.center?.y ?: Float.MAX_VALUE) }
                                        },
                                    )
                                }) {
                                Canvas(Modifier.size(14.dp).semantics { contentDescription = handleLabel }) {
                                    for (line in 1..3) drawLine(ink, Offset(1f, size.height * line / 4), Offset(size.width - 1f, size.height * line / 4), strokeWidth = 1.5.dp.toPx())
                                }
                            }
                            Column(Modifier.weight(1f).padding(vertical = 14.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(item.text, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                                    if (item.attachmentCount > 0) Text(stringResource(R.string.queue_attachments, item.attachmentCount), style = MaterialTheme.typography.labelSmall, color = ink)
                                }
                                if (item.status != "queued") Text(stringResource(R.string.queue_waiting), style = MaterialTheme.typography.bodySmall, color = ink)
                            }
                            IconButton(onClick = { onIntent(RemoteSessionIntent.PromoteQueuedMessage(item.id)) }, enabled = !state.busy && state.failure == null && item.status in listOf("queued", "blocked")) {
                                Icon(painterResource(R.drawable.ic_symbol_arrow_up), stringResource(R.string.queue_send_now), Modifier.size(16.dp))
                            }
                            Box {
                                IconButton(onClick = { menuId = item.id }) { Icon(painterResource(R.drawable.ic_symbol_ellipsis), stringResource(R.string.queue_more), Modifier.size(16.dp)) }
                                DropdownMenu(expanded = menuId == item.id, onDismissRequest = { menuId = null }) {
                                    DropdownMenuItem(text = { Text(item.text) }, onClick = {}, enabled = false)
                                    if (!state.supportsReorder) DropdownMenuItem(text = { Text(stringResource(R.string.queue_unsupported)) }, onClick = {}, enabled = false)
                                    DropdownMenuItem(text = { Text(moveUp) }, enabled = canMove && index > 0,
                                        onClick = { menuId = null; onIntent(RemoteSessionIntent.MoveQueuedMessage(item.id, queued[index - 1])) })
                                    DropdownMenuItem(text = { Text(moveDown) }, enabled = canMove && index < queued.lastIndex,
                                        onClick = { menuId = null; onIntent(RemoteSessionIntent.MoveQueuedMessage(item.id, queued.getOrNull(index + 2))) })
                                    DropdownMenuItem(text = { Text(stringResource(R.string.queue_remove)) }, enabled = !state.busy && state.failure == null && item.status in listOf("queued", "blocked"),
                                        onClick = { menuId = null; onIntent(RemoteSessionIntent.CancelQueuedMessage(item.id)) })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
