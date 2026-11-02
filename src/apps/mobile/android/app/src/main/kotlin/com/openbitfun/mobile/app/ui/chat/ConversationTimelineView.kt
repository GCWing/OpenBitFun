package com.openbitfun.mobile.app.ui.chat

import com.openbitfun.mobile.core.feature.session.HistoryLoadState

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.rememberUpdatedState
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
import kotlinx.coroutines.flow.distinctUntilChanged

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
     * The LazyColumn puts one leading header in front of the messages when the
     * transcript has an older page to load or has not been confirmed by the
     * host yet, so the real tail is one past [rowCount] instead of
     * `rowCount - 1`.
     */
    fun lastItemIndex(rowCount: Int, hasLeadingItem: Boolean): Int =
        if (hasLeadingItem) rowCount else (rowCount - 1).coerceAtLeast(0)
}

/** One automatic page per deliberate drag; layout and bounce cannot re-arm it. */
internal class HistoryPageArrivalTracker {
    private var consumed = true
    fun beginGesture() { consumed = false }
    fun arrived(atStart: Boolean): Boolean {
        if (!atStart || consumed) return false
        consumed = true
        return true
    }
    fun cancelArrival() { consumed = true }
}

/** Timeline renderer over feature-owned presentation rows; session routing stays above it. */
@Composable
internal fun ConversationTimelineView(
    rows: List<ConversationRow>,
    hasMoreMessages: Boolean,
    /**
     * The rows on screen are this device's stored copy rather than the host's
     * transcript: a reopened session shows them at once, and the host has not
     * answered for it yet. See `ChatTranscriptOrigin`.
     */
    transcriptUnconfirmed: Boolean = false,
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
    // One header slot holds both leading rows, so the scroll policy counts an
    // item, not a row.
    val hasLeadingItem = hasMoreMessages || transcriptUnconfirmed

    val historyArrival = remember { HistoryPageArrivalTracker() }
    var userDragging by remember { mutableStateOf(false) }
    LaunchedEffect(listState.interactionSource) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> { historyArrival.beginGesture(); userDragging = true; stickToBottom = false }
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
    LaunchedEffect(rows, stickToBottom, hasLeadingItem) {
        if (ConversationScrollPolicy.shouldScrollToBottom(stickToBottom, rows.isNotEmpty())) {
            // A large offset positions the item's bottom at the viewport tail directly;
            // unlike scrollToItem(index), it does not briefly expose the item's top.
            listState.scrollToItem(
                ConversationScrollPolicy.lastItemIndex(rows.size, hasLeadingItem),
                scrollOffset = Int.MAX_VALUE,
            )
        }
    }

    // Reaching the start of the loaded transcript asks for the next page by
    // itself; the header stays as the loading and retry state. Busy gestures
    // are consumed so completion cannot silently queue another page.
    val canRequestOlder by rememberUpdatedState(
        enabled && hasMoreMessages && historyLoadState != HistoryLoadState.LOADING
            && historyLoadState != HistoryLoadState.FAILED,
    )
    val requestOlder by rememberUpdatedState {
        stickToBottom = false
        onLoadOlder()
    }
    LaunchedEffect(listState, hasMoreMessages) {
        // Index zero is the "load older messages" header, so seeing it is the
        // reader standing at the start of what is loaded. Following the tail is
        // excluded: a first page that does not fill the pane is at the start
        // without the reader having gone there, and asking from there would
        // fight the initial tail scroll.
        snapshotFlow { userDragging && listState.firstVisibleItemIndex == 0 && !stickToBottom }
            .distinctUntilChanged()
            .collect { readerReachedStart ->
                if (!historyArrival.arrived(readerReachedStart)) return@collect
                if (canRequestOlder) requestOlder()
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (hasLeadingItem) {
                item(key = "load-older-messages") {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        if (transcriptUnconfirmed) {
                            // These rows stop where this device's last write stopped,
                            // inside the turn that was running when the app went away.
                            // Say the rest is on its way instead of letting a
                            // half-finished turn read as the session.
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                horizontalArrangement = Arrangement.Center,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(modifier = Modifier.width(7.dp))
                                Text(
                                    text = stringResource(R.string.chat_transcript_syncing),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        if (hasMoreMessages) {
                            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                TextButton(
                                    onClick = { historyArrival.cancelArrival(); stickToBottom = false; onLoadOlder() },
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
