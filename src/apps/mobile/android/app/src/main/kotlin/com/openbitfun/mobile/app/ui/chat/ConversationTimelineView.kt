package com.openbitfun.mobile.app.ui.chat

import com.openbitfun.mobile.core.feature.session.HistoryLoadState

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.session.ConversationRow
import com.openbitfun.mobile.core.feature.session.QuestionAnswer
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState

/** Pure decisions for keeping a forward timeline at its visual tail. */
internal object ConversationScrollPolicy {
    fun shouldStickToBottom(
        currentlySticking: Boolean,
        isAtBottom: Boolean,
        isScrollInProgress: Boolean,
    ): Boolean = when {
        isScrollInProgress -> false
        isAtBottom -> true
        else -> currentlySticking
    }

    fun shouldScrollToBottom(stickToBottom: Boolean, hasRows: Boolean): Boolean =
        stickToBottom && hasRows

    /**
     * The LazyColumn puts the "load older messages" header at index zero when
     * [hasMoreMessages] is true, so the real tail is one past [rowCount] instead
     * of `rowCount - 1`.
     */
    fun lastItemIndex(rowCount: Int, hasMoreMessages: Boolean): Int =
        if (hasMoreMessages) rowCount else (rowCount - 1).coerceAtLeast(0)
}

/** Timeline renderer over feature-owned presentation rows; session routing stays above it. */
@Composable
internal fun ConversationTimelineView(
    rows: List<ConversationRow>,
    hasMoreMessages: Boolean,
    onLoadOlder: () -> Unit,
    enabled: Boolean,
    onApproveTool: (String, String?) -> Unit,
    onRejectTool: (String, String) -> Unit,
    onCancelTool: (String, String) -> Unit,
    onAnswerTool: (String, String) -> Unit,
    onAnswerToolStructured: (String, List<QuestionAnswer>) -> Unit,
    onRetry: (ConversationRow) -> Unit,
    onOpenFile: (String, String) -> Unit,
    previewingRemotePath: String,
    previewLoading: Boolean,
    download: RemoteFileDownloadUiState,
    onDownloadFile: (String, String) -> Unit,
    downloadEnabled: Boolean,
    modifier: Modifier,
    historyLoadState: HistoryLoadState = HistoryLoadState.IDLE,
    /**
     * How much of the pane the floating header and composer cover. The list
     * runs the full height behind them, so without these the first and last
     * messages would sit under a capsule and never come out from under it.
     */
    topInset: Dp = 0.dp,
    bottomInset: Dp = 0.dp,
) {
    val listState = rememberLazyListState()
    var stickToBottom by rememberSaveable { mutableStateOf(true) }
    val atBottom by remember(listState) { derivedStateOf { !listState.canScrollForward } }

    var userDragging by remember { mutableStateOf(false) }
    LaunchedEffect(listState.interactionSource) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> { userDragging = true; stickToBottom = false }
                is DragInteraction.Stop, is DragInteraction.Cancel -> userDragging = false
            }
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { userDragging to listState.canScrollForward }
            .collect { (dragging, canScrollForward) ->
                stickToBottom = ConversationScrollPolicy.shouldStickToBottom(
                    currentlySticking = stickToBottom,
                    isAtBottom = !canScrollForward,
                    isScrollInProgress = dragging,
                )
            }
    }
    LaunchedEffect(rows, stickToBottom, hasMoreMessages) {
        if (ConversationScrollPolicy.shouldScrollToBottom(stickToBottom, rows.isNotEmpty())) {
            // A large offset positions the item's bottom at the viewport tail directly;
            // unlike scrollToItem(index), it does not briefly expose the item's top.
            listState.scrollToItem(
                ConversationScrollPolicy.lastItemIndex(rows.size, hasMoreMessages),
                scrollOffset = Int.MAX_VALUE,
            )
        }
    }

    Box(modifier = modifier) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().testTag(CONVERSATION_LIST_TEST_TAG),
            contentPadding = PaddingValues(
                start = 20.dp,
                end = 20.dp,
                top = topInset,
                bottom = if (bottomInset > 0.dp) bottomInset else 12.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom),
        ) {
            if (hasMoreMessages) {
                item(key = "load-older-messages") {
                    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        TextButton(
                            onClick = { stickToBottom = false; onLoadOlder() },
                            enabled = enabled && historyLoadState != HistoryLoadState.LOADING,
                            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
                        ) {
                            Text(stringResource(when (historyLoadState) {
                                HistoryLoadState.LOADING -> R.string.chat_loading_older_messages
                                HistoryLoadState.FAILED -> R.string.chat_load_older_failed
                                else -> R.string.chat_load_older_messages
                            }))
                        }
                    }
                }
            }
            val currentUser = rows.lastOrNull { it.kind == com.openbitfun.mobile.core.feature.session.ConversationRowKind.USER }
            items(rows, key = { if (it === currentUser) "current-user" else "message:${it.id}" }) { row ->
                ChatMessageBubble(
                    row = row,
                    enabled = enabled,
                    onApproveTool = onApproveTool,
                    onRejectTool = onRejectTool,
                    onCancelTool = onCancelTool,
                    onAnswerTool = onAnswerTool,
                    onAnswerToolStructured = onAnswerToolStructured,
                    onRetry = onRetry,
                    onOpenLink = onOpenFile,
                    previewingRemotePath = previewingRemotePath,
                    previewLoading = previewLoading,
                    download = download,
                    onDownloadFile = onDownloadFile,
                    downloadEnabled = downloadEnabled,
                    modifier = Modifier,
                )
            }
        }
        if (!atBottom) {
            Surface(
                onClick = { stickToBottom = true },
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surface,
                shadowElevation = 5.dp,
                tonalElevation = 1.dp,
                // Sits above the floating composer rather than behind it.
                modifier = Modifier.align(Alignment.BottomCenter)
                    .offset(y = -(bottomInset + 4.dp))
                    .size(42.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painterResource(R.drawable.ic_symbol_chevron_down),
                        contentDescription = stringResource(R.string.chat_scroll_to_bottom),
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}
