package com.openbitfun.mobile.app.ui.preview

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.ui.chat.MessageQueuePanel
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.session.*

/** Isolated native review surface. The production panel uses simulated host replies. */
@Composable
internal fun MessageQueuePreview() {
    var dark by remember { mutableStateOf(true) }
    var narrow by remember { mutableStateOf(true) }
    var revision by remember { mutableIntStateOf(1) }
    var items by remember { mutableStateOf(listOf(
        QueuedMessageUiState("first", "Review the queue layout", 1, "queued", null),
        QueuedMessageUiState("second", "Check long messages and attachment spacing", 2, "queued", null),
        QueuedMessageUiState("third", "Run the focused tests", 0, "queued", null),
    )) }
    OpenBitFunTheme(dark = dark) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding(), verticalArrangement = Arrangement.Center) {
                Row(Modifier.padding(horizontal = 12.dp)) {
                    TextButton(onClick = { dark = !dark }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) { Text("Light / Dark") }
                    TextButton(onClick = { narrow = !narrow }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) { Text("Resize") }
                }
                Text("Queue · Native component preview", Modifier.padding(20.dp), style = MaterialTheme.typography.titleMedium)
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Box(if (narrow) Modifier.width(320.dp) else Modifier.fillMaxWidth()) {
                        MessageQueuePanel(MessageQueueUiState("preview", true, true, "preview:$revision", items, false, null)) { intent ->
                            when (intent) {
                                is RemoteSessionIntent.MoveQueuedMessage -> {
                                    val item = items.firstOrNull { it.id == intent.id }
                                    if (item != null) {
                                        val next = items.filterNot { it.id == intent.id }.toMutableList()
                                        next.add(intent.beforeId?.let { id -> next.indexOfFirst { it.id == id } }?.coerceAtLeast(0) ?: next.size, item)
                                        items = next; revision++
                                    }
                                }
                                is RemoteSessionIntent.CancelQueuedMessage -> { items = items.filterNot { it.id == intent.id }; revision++ }
                                is RemoteSessionIntent.PromoteQueuedMessage -> { items = items.filterNot { it.id == intent.id }; revision++ }
                                else -> Unit
                            }
                        }
                    }
                }
            }
        }
    }
}
