package com.openbitfun.mobile.core.domain

import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.ImageAttachment
import com.openbitfun.mobile.core.protocol.RemoteDefaultModels
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse

public enum class ChatSyncPhase {
    IDLE,
    LOADING,
    SENDING,
    STREAMING,
    FINALIZING,
    RECONNECTING,
    ERROR,
}

/**
 * Who the rows in a timeline belong to.
 *
 * A transcript is published twice on the way into a session: first from the
 * copy this device wrote last time, then from the host once it answers. The two
 * are not interchangeable — the stored copy stops wherever the last write
 * stopped, which is inside the turn that was running when the app went away, and
 * it is not the host's view of the session until the host says so. Consumers
 * that would present a transcript as the session, or that gate a wait on "the
 * transcript arrived", must read this: a wait ends on [HOST], not on rows.
 */
public enum class ChatTranscriptOrigin {
    /** Rows restored from this device's stored copy; the host has not answered yet. */
    CACHE,

    /** Rows the host replayed or streamed for this session. */
    HOST,
}

public data class ChatTimelineState public constructor(
    public val sessionId: String,
    public val persistedMessages: List<ChatMessage>,
    public val optimisticMessages: List<ChatMessage>,
    public val activeTurn: ChatMessage?,
    public val syncPhase: ChatSyncPhase,
    public val cursor: ChatSessionCursor,
    public val modelCatalog: RemoteModelCatalog,
    public val selectedModelId: String,
    public val activeTurnAnchorId: String,
    /** Who the rows above belong to; see [ChatTranscriptOrigin]. */
    public val origin: ChatTranscriptOrigin,
)

public class ChatTimelineStore public constructor() {
    private var state: ChatTimelineState = emptyState("")
    private var recentlyCoveredTurn: CoveredTurn? = null
    private var activeTurnAnchor: String = ""

    public fun reset(): Unit = reset("")

    public fun reset(sessionId: String) {
        state = emptyState(sessionId)
        recentlyCoveredTurn = null
        activeTurnAnchor = ""
    }

    public fun snapshot(): ChatTimelineState = state.copy(
        persistedMessages = state.persistedMessages.toList(),
        optimisticMessages = state.optimisticMessages.toList(),
        cursor = state.cursor.copy(),
        activeTurnAnchorId = activeTurnAnchor,
    )

    public fun setSyncPhase(syncPhase: ChatSyncPhase) {
        state = state.copy(syncPhase = syncPhase)
    }

    /**
     * Records who the rows now held belong to.
     *
     * Set to [ChatTranscriptOrigin.HOST] where the host's transcript is applied,
     * and back to [ChatTranscriptOrigin.CACHE] wherever this store is filled
     * from this device's stored copy. Nothing else may move it.
     */
    public fun setTranscriptOrigin(origin: ChatTranscriptOrigin) {
        state = state.copy(origin = origin)
    }

    public fun setCursor(cursor: ChatSessionCursor) {
        state = state.copy(cursor = cursor.copy())
    }

    public fun setModelCatalog(modelCatalog: RemoteModelCatalog, selectedModelId: String) {
        state = state.copy(
            cursor = state.cursor.copy(knownModelCatalogVersion = modelCatalog.version),
            modelCatalog = modelCatalog,
            selectedModelId = selectedModelId,
        )
    }

    public fun setSelectedModelId(selectedModelId: String) {
        state = state.copy(selectedModelId = selectedModelId)
    }

    /** Reconcile a send even when the persisted message arrived before its acknowledgement. */
    public fun acknowledgeOptimisticTurn(localMessageId: String, turnId: String) {
        if (localMessageId.isBlank() || turnId.isBlank()) return
        val persisted = state.persistedMessages.any { it.role == "user" && it.turnId == turnId }
        state = state.copy(optimisticMessages = state.optimisticMessages.mapNotNull { message ->
            if (message.id != localMessageId) message
            else if (persisted) null
            else message.copy(turnId = turnId)
        })
    }

    public fun setPersistedMessages(messages: List<ChatMessage>) {
        val persisted = withoutProvisionalUserAliases(realMessages(messages))
        val newlyPersisted = newlyPersistedMessages(state.persistedMessages, persisted)
        val activeCovered = state.activeTurn?.let { active ->
            val coveredByContent = coveredByNewAssistantContent(active, newlyPersisted)
            if (coveredByContent) recentlyCoveredTurn = CoveredTurn.from(active)
            isActiveTurnCoveredByMessages(active, persisted) || coveredByContent
        } == true
        state = state.copy(
            persistedMessages = persisted,
            optimisticMessages = optimisticMessagesNotPersisted(state.optimisticMessages, newlyPersisted),
            activeTurn = state.activeTurn?.takeUnless { activeCovered },
        )
    }

    public fun mergePersistedMessages(messages: List<ChatMessage>) {
        val incoming = withoutProvisionalUserAliases(realMessages(messages))
        val newlyPersisted = newlyPersistedMessages(state.persistedMessages, incoming)
        val persisted = mergeMessages(state.persistedMessages, incoming)
        val activeCovered = state.activeTurn?.let { active ->
            val coveredByContent = coveredByNewAssistantContent(active, newlyPersisted)
            if (coveredByContent) recentlyCoveredTurn = CoveredTurn.from(active)
            isActiveTurnCoveredByMessages(active, persisted) || coveredByContent
        } == true
        state = state.copy(
            persistedMessages = persisted,
            optimisticMessages = optimisticMessagesNotPersisted(state.optimisticMessages, newlyPersisted),
            activeTurn = state.activeTurn?.takeUnless { activeCovered },
        )
    }

    public fun appendOptimisticMessage(message: ChatMessage) {
        state = state.copy(
            optimisticMessages = state.optimisticMessages + message,
            syncPhase = ChatSyncPhase.SENDING,
        )
    }

    public fun markOptimisticMessageFailed(messageId: String) {
        state = state.copy(
            optimisticMessages = state.optimisticMessages.map { message ->
                if (message.id == messageId) message.copy(status = "failed") else message
            },
            syncPhase = ChatSyncPhase.ERROR,
        )
    }

    public fun setLocalActiveTurn(turnId: String) {
        val normalizedTurnId = turnId.trim()
        if (normalizedTurnId.isEmpty()) return
        val activeId = "active-$normalizedTurnId"
        val existing = state.activeTurn
        val acknowledgedTurn = emptyMessage(id = activeId, turnId = normalizedTurnId, status = "active")
        // Fast hosts may finish and persist the reply before send_message returns.
        // A late acknowledgement must not resurrect an already completed turn.
        if (isActiveTurnCoveredByMessages(acknowledgedTurn, state.persistedMessages)) {
            if (existing == null || isLocalPendingActiveTurn(existing) || existing.turnId == normalizedTurnId) {
                state = state.copy(activeTurn = null, syncPhase = ChatSyncPhase.IDLE)
                activeTurnAnchor = ""
            }
            return
        }
        if (existing?.id == activeId) {
            val activeTurn = existing.copy(
                turnId = existing.turnId?.takeIf(String::isNotEmpty) ?: normalizedTurnId,
                status = existing.status.ifEmpty { "active" },
            )
            state = state.copy(
                activeTurn = activeTurn,
                syncPhase = phaseForActiveTurn(activeTurn, ChatSyncPhase.STREAMING),
            )
            return
        }
        if (existing != null && existing.id.isNotEmpty() && existing.id != activeId &&
            !isLocalPendingActiveTurn(existing)
        ) {
            return
        }
        if (existing == null || !isLocalPendingActiveTurn(existing)) {
            activeTurnAnchor = lastOptimisticMessageId()
        }
        state = state.copy(
            activeTurn = emptyMessage(
                id = activeId,
                turnId = normalizedTurnId,
                status = "active",
            ),
            syncPhase = ChatSyncPhase.STREAMING,
        )
    }

    public fun setPendingActiveTurn(localId: String): String {
        val normalizedLocalId = localId.trim()
        if (normalizedLocalId.isEmpty()) return ""
        val activeId = "active-pending-$normalizedLocalId"
        val existing = state.activeTurn
        if (existing != null && existing.id.isNotEmpty() && existing.id != activeId &&
            !isLocalPendingActiveTurn(existing)
        ) {
            return ""
        }
        activeTurnAnchor = normalizedLocalId
        state = state.copy(
            activeTurn = emptyMessage(id = activeId, turnId = null, status = "active"),
            syncPhase = ChatSyncPhase.STREAMING,
        )
        return activeId
    }

    public fun clearPendingActiveTurn(activeId: String) {
        val activeTurn = state.activeTurn
        if (activeTurn == null || activeTurn.id != activeId || !isLocalPendingActiveTurn(activeTurn)) return
        activeTurnAnchor = ""
        state = state.copy(activeTurn = null, syncPhase = ChatSyncPhase.IDLE)
    }

    public fun setActiveTurn(activeTurn: ChatMessage?) {
        val normalized = activeTurn?.takeIf { it.id.isNotEmpty() }
        if (normalized == null) {
            recentlyCoveredTurn = null
        } else if (recentlyCoveredTurn?.matches(normalized) == true) {
            recentlyCoveredTurn = null
            state = state.copy(activeTurn = null, syncPhase = ChatSyncPhase.IDLE)
            return
        }
        val merged = activeTurnForUpdate(state.activeTurn, normalized)
        val next = activeTurnForState(merged)
        state = state.copy(
            activeTurn = next,
            syncPhase = phaseForActiveTurn(next, state.syncPhase),
        )
    }

    public fun clearActiveTurn() {
        recentlyCoveredTurn = null
        activeTurnAnchor = ""
        state = state.copy(activeTurn = null, syncPhase = ChatSyncPhase.IDLE)
    }

    private data class CoveredTurn(val turnId: String?, val text: String) {
        fun matches(message: ChatMessage): Boolean = when {
            !turnId.isNullOrEmpty() && !message.turnId.isNullOrEmpty() -> turnId == message.turnId
            else -> text.isNotEmpty() && text == message.text.trim()
        }

        companion object {
            fun from(message: ChatMessage): CoveredTurn = CoveredTurn(
                turnId = message.turnId?.takeIf(String::isNotEmpty),
                text = message.text.trim(),
            )
        }
    }

    public fun applySnapshot(snapshot: ChatSessionSnapshot) {
        setCursor(snapshot.cursor)
        if (snapshot.messageSnapshot != null) {
            setPersistedMessages(snapshot.messageSnapshot)
        } else if (snapshot.newMessages.isNotEmpty()) {
            mergePersistedMessages(snapshot.newMessages)
        }
        setActiveTurn(snapshot.activeTurn)
        snapshot.modelCatalog?.let { catalog ->
            setModelCatalog(catalog, selectedModelIdForCatalog(catalog, state.selectedModelId))
        }
    }

    public fun applyEvent(event: ConversationEvent) {
        when (event) {
            is ConversationEvent.UserMessage -> {
                if (event.persisted) mergePersistedMessages(listOf(event.message))
                else appendOptimisticMessage(event.message)
            }
            is ConversationEvent.TurnStarted -> {
                if (acceptsSession(event.sessionId)) setLocalActiveTurn(event.turnId)
            }
            is ConversationEvent.AssistantDelta -> {
                if (acceptsSession(event.sessionId)) appendAssistantDelta(event.turnId, event.delta)
            }
            is ConversationEvent.AssistantMessage -> {
                mergePersistedMessages(listOf(event.message))
                clearActiveTurn()
            }
            is ConversationEvent.ActiveTurnUpdated -> {
                if (acceptsSession(event.sessionId)) setActiveTurn(event.message)
            }
            is ConversationEvent.ToolStarted -> {
                if (acceptsSession(event.sessionId)) updateActiveTool(event.turnId, event.tool)
            }
            is ConversationEvent.ToolFinished -> {
                if (acceptsSession(event.sessionId)) updateActiveTool(event.turnId, event.tool)
            }
            is ConversationEvent.TurnFinished -> {
                val message = event.message
                if (message != null) {
                    mergePersistedMessages(listOf(message))
                    clearActiveTurn()
                } else if (acceptsSession(event.sessionId)) {
                    val active = state.activeTurn
                    if (active?.turnId == event.turnId) setActiveTurn(active.copy(status = "completed"))
                }
            }
            is ConversationEvent.SessionUpdated -> Unit
            is ConversationEvent.Error -> setSyncPhase(ChatSyncPhase.ERROR)
        }
    }

    public fun activeTurnOrNull(): ChatMessage? = state.activeTurn

    public fun activeTurnAnchorId(): String = activeTurnAnchor

    public fun project(hasMoreMessages: Boolean): List<ChatTimelineItem> =
        ChatTimelineProjector.project(
            state.persistedMessages,
            state.optimisticMessages,
            state.activeTurn,
            hasMoreMessages,
            activeTurnAnchor,
        )

    private fun acceptsSession(sessionId: String): Boolean =
        sessionId.isEmpty() || state.sessionId.isEmpty() || state.sessionId == sessionId

    private fun appendAssistantDelta(turnId: String, delta: String) {
        if (delta.isEmpty()) return
        if (state.activeTurn?.turnId != turnId) setLocalActiveTurn(turnId)
        val active = state.activeTurn ?: return
        setActiveTurn(
            active.copy(
                text = active.text + delta,
                status = "active",
                renderVersion = (active.renderVersion ?: 0) + delta.length,
            ),
        )
    }

    private fun updateActiveTool(turnId: String, tool: RemoteToolStatusResponse) {
        if (state.activeTurn?.turnId != turnId) setLocalActiveTurn(turnId)
        val active = state.activeTurn ?: return
        val tools = active.tools.orEmpty().filter { it.id != tool.id } + tool
        setActiveTurn(
            active.copy(
                status = "active",
                tools = tools,
                renderVersion = (active.renderVersion ?: 0) + 1,
            ),
        )
    }

    private fun activeTurnForState(activeTurn: ChatMessage?): ChatMessage? {
        if (activeTurn != null && activeTurn.id.isNotEmpty()) {
            return activeTurn.takeUnless { isActiveTurnCoveredByMessages(it, state.persistedMessages) }
        }
        val previous = state.activeTurn
        // Polls can still report idle while the send RPC is in flight. Only its
        // acknowledgement/failure (or a real host turn) may settle this placeholder.
        if (previous != null && isLocalPendingActiveTurn(previous)) return previous
        if (previous != null && MessageStatusSemantics.shouldHoldCompletedTurn(previous.status) &&
            hasDisplayableAssistantFinal(previous) &&
            !isActiveTurnCoveredByMessages(previous, state.persistedMessages)
        ) {
            return previous
        }
        return null
    }

    private fun lastOptimisticMessageId(): String = state.optimisticMessages.lastOrNull()?.id.orEmpty()

    public companion object {
        public fun optimisticMessagesNotPersisted(
            optimisticMessages: List<ChatMessage>,
            persistedMessages: List<ChatMessage>,
        ): List<ChatMessage> {
            val acknowledgedIndexes = mutableSetOf<Int>()
            return optimisticMessages.filter { pending ->
                val acknowledgedIndex = persistedMessages.indices.firstOrNull { index ->
                    index !in acknowledgedIndexes &&
                        isPersistedUserDuplicate(pending, persistedMessages[index])
                }
                if (acknowledgedIndex == null) {
                    true
                } else {
                    acknowledgedIndexes += acknowledgedIndex
                    false
                }
            }
        }

        public fun isActiveTurnCoveredByMessages(
            activeTurn: ChatMessage,
            messages: List<ChatMessage>,
        ): Boolean = activeTurn.id.isEmpty() || messages.any { message ->
            isPersistedAssistantDuplicate(activeTurn, message)
        }

        private fun emptyState(sessionId: String): ChatTimelineState = ChatTimelineState(
            sessionId = sessionId,
            persistedMessages = emptyList(),
            optimisticMessages = emptyList(),
            activeTurn = null,
            syncPhase = ChatSyncPhase.IDLE,
            cursor = ChatSessionCursor(0, 0, 0),
            modelCatalog = RemoteModelCatalog(0, emptyList(), RemoteDefaultModels(), null),
            selectedModelId = "",
            activeTurnAnchorId = "",
            origin = ChatTranscriptOrigin.CACHE,
        )

        private fun emptyMessage(id: String, turnId: String?, status: String): ChatMessage = ChatMessage(
            id = id,
            role = "assistant",
            text = "",
            status = status,
            renderVersion = null,
            turnId = turnId,
            detail = "",
            timestamp = null,
            thinking = null,
            tools = null,
            items = null,
            images = null,
            error = null,
        )

        private fun realMessages(messages: List<ChatMessage>): List<ChatMessage> =
            messages.filterNot { it.id.startsWith("system-") && it.role == "assistant" }

        private fun phaseForActiveTurn(activeTurn: ChatMessage?, fallback: ChatSyncPhase): ChatSyncPhase {
            if (activeTurn == null || activeTurn.id.isEmpty()) {
                return if (fallback == ChatSyncPhase.SENDING) fallback else ChatSyncPhase.IDLE
            }
            if (MessageStatusSemantics.isStreaming(activeTurn.status)) return ChatSyncPhase.STREAMING
            if (MessageStatusSemantics.isFinalizing(activeTurn.status)) return ChatSyncPhase.FINALIZING
            return fallback
        }

        private fun activeTurnForUpdate(previous: ChatMessage?, incoming: ChatMessage?): ChatMessage? {
            if (incoming == null || incoming.id.isEmpty()) return null
            return if (previous != null && previous.id.isNotEmpty() && sameActiveTurn(previous, incoming)) {
                mergeActiveTurn(previous, incoming)
            } else {
                incoming
            }
        }

        private fun sameActiveTurn(previous: ChatMessage, incoming: ChatMessage): Boolean {
            if (!previous.turnId.isNullOrEmpty() && previous.turnId == incoming.turnId) return true
            return previous.id == incoming.id && previous.id.startsWith("active-") && incoming.id.startsWith("active-")
        }

        private fun mergeActiveTurn(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
            val previousVersion = previous.renderVersion
            val incomingVersion = incoming.renderVersion
            if (previousVersion != null && incomingVersion != null && incomingVersion < previousVersion) {
                return previous
            }
            return incoming.copy(
            turnId = incoming.turnId ?: previous.turnId,
            role = incoming.role.ifEmpty { previous.role },
            text = monotonicText(previous.text, incoming.text),
            status = incoming.status.ifEmpty { previous.status },
            timestamp = incoming.timestamp ?: previous.timestamp,
            thinking = monotonicText(previous.thinking.orEmpty(), incoming.thinking.orEmpty()).ifEmpty { null },
            tools = mergeTools(previous.tools, incoming.tools),
            items = mergeActiveItems(previous.items.orEmpty(), incoming.items.orEmpty()),
            images = incoming.images?.takeIf(List<ImageAttachment>::isNotEmpty) ?: previous.images,
            )
        }

        private fun mergeActiveItems(
            previousItems: List<ChatMessageItemResponse>,
            incomingItems: List<ChatMessageItemResponse>,
        ): List<ChatMessageItemResponse> {
            if (incomingItems.isEmpty()) return previousItems

            val working = previousItems.toMutableList()
            var searchFrom = 0

            for (incomingIndex in incomingItems.indices) {
                val incoming = incomingItems[incomingIndex]
                if (incoming.tool != null) {
                    val toolIndex = findToolMatch(working, incoming, searchFrom)
                    if (toolIndex >= 0) {
                        working[toolIndex] = mergeActiveItem(working[toolIndex], incoming)
                        searchFrom = toolIndex + 1
                    } else {
                        val anchor = anchorForNewTool(working, incomingItems, incomingIndex, searchFrom)
                        working.add(anchor, incoming)
                        searchFrom = anchor + 1
                    }
                    continue
                }

                when (val match = findTextMatch(working, incoming, incomingItems, incomingIndex, searchFrom)) {
                    is TextMatch.Merge -> {
                        working[match.index] = mergeActiveItem(working[match.index], incoming)
                        searchFrom = match.index + 1
                    }
                    is TextMatch.Collapse -> {
                        val merged = mergeActiveItem(working[match.start], incoming)
                        repeat(match.end - match.start + 1) { working.removeAt(match.start) }
                        working.add(match.start, merged)
                        searchFrom = match.start + 1
                    }
                    is TextMatch.Split -> {
                        val previous = working[match.index]
                        val prefix = incoming.copy(
                            type = incoming.type ?: previous.type,
                            subItems = mergeActiveItems(previous.subItems.orEmpty(), incoming.subItems.orEmpty()),
                        )
                        val remainder = previous.copy(
                            content = previous.content.orEmpty().substring(incoming.content.orEmpty().length),
                            subItems = previous.subItems,
                        )
                        working[match.index] = prefix
                        working.add(match.index + 1, remainder)
                        searchFrom = match.index + 1
                    }
                    null -> {
                        working.add(incoming)
                        searchFrom = working.size
                    }
                }
            }
            return working.deduplicateAdjacentActiveItems()
        }

        private sealed interface TextMatch {
            data class Merge(val index: Int) : TextMatch
            data class Collapse(val start: Int, val end: Int) : TextMatch
            data class Split(val index: Int) : TextMatch
        }

        private fun findToolMatch(
            working: List<ChatMessageItemResponse>,
            incoming: ChatMessageItemResponse,
            searchFrom: Int,
        ): Int {
            val incomingToolId = incoming.tool?.id.orEmpty()
            return (searchFrom until working.size).firstOrNull { index ->
                val toolId = working[index].tool?.id.orEmpty()
                toolId.isNotEmpty() && toolId == incomingToolId
            } ?: -1
        }

        private fun anchorForNewTool(
            working: List<ChatMessageItemResponse>,
            incomingItems: List<ChatMessageItemResponse>,
            incomingIndex: Int,
            searchFrom: Int,
        ): Int {
            for (index in incomingIndex + 1 until incomingItems.size) {
                val next = incomingItems[index]
                if (next.tool != null) continue
                val position = positionForText(working, next, searchFrom)
                if (position >= 0) return position
            }
            return working.size
        }

        private fun positionForText(
            working: List<ChatMessageItemResponse>,
            incoming: ChatMessageItemResponse,
            searchFrom: Int,
        ): Int {
            val incomingType = incoming.type.orEmpty().lowercase()
            val incomingContent = incoming.content.orEmpty()
            val exact = (searchFrom until working.size).firstOrNull { index ->
                matchesTextType(working[index], incomingType) &&
                    working[index].content.orEmpty() == incomingContent
            }
            if (exact != null) return exact

            for (start in searchFrom until working.size) {
                if (!isTextLikeItem(working[start]) || working[start].type.orEmpty().lowercase() != incomingType) continue
                var concatenated = ""
                var spaced = ""
                var end = start
                while (end < working.size && isTextLikeItem(working[end]) &&
                    working[end].type.orEmpty().lowercase() == incomingType
                ) {
                    val content = working[end].content.orEmpty()
                    concatenated += content
                    spaced = if (spaced.isEmpty()) content else "$spaced $content"
                    if (end > start && incomingContent.length > working[start].content.orEmpty().length &&
                        (prefixRelated(incomingContent, concatenated) || prefixRelated(incomingContent, spaced))
                    ) {
                        return start
                    }
                    end += 1
                }
            }

            return (searchFrom until working.size).firstOrNull { index ->
                matchesTextType(working[index], incomingType) &&
                    prefixRelated(working[index].content.orEmpty(), incomingContent)
            } ?: -1
        }

        private fun findTextMatch(
            working: List<ChatMessageItemResponse>,
            incoming: ChatMessageItemResponse,
            incomingItems: List<ChatMessageItemResponse>,
            incomingIndex: Int,
            searchFrom: Int,
        ): TextMatch? {
            val incomingType = incoming.type.orEmpty().lowercase()
            val incomingContent = incoming.content.orEmpty()

            val exact = (searchFrom until working.size).firstOrNull { index ->
                matchesTextType(working[index], incomingType) &&
                    working[index].content.orEmpty() == incomingContent
            }
            if (exact != null) return TextMatch.Merge(exact)

            for (start in searchFrom until working.size) {
                if (!isTextLikeItem(working[start]) || working[start].type.orEmpty().lowercase() != incomingType) continue
                var concatenated = ""
                var spaced = ""
                var end = start
                while (end < working.size && isTextLikeItem(working[end]) &&
                    working[end].type.orEmpty().lowercase() == incomingType
                ) {
                    val content = working[end].content.orEmpty()
                    concatenated += content
                    spaced = if (spaced.isEmpty()) content else "$spaced $content"
                    if (end > start && incomingContent.length > working[start].content.orEmpty().length &&
                        (incomingContent.startsWith(concatenated) || incomingContent.startsWith(spaced))
                    ) {
                        return TextMatch.Collapse(start, end)
                    }
                    end += 1
                }
            }

            val single = (searchFrom until working.size).firstOrNull { index ->
                matchesTextType(working[index], incomingType) &&
                    (incomingContent.isEmpty() || prefixRelated(working[index].content.orEmpty(), incomingContent))
            }
            if (single == null) return null

            val previousContent = working[single].content.orEmpty()
            if (incomingContent.isEmpty() || previousContent.isEmpty()) return TextMatch.Merge(single)
            return if (previousContent.length > incomingContent.length &&
                previousContent.startsWith(incomingContent) &&
                remainderWillBeConsumed(previousContent.substring(incomingContent.length), incomingItems, incomingIndex)
            ) {
                TextMatch.Split(single)
            } else {
                TextMatch.Merge(single)
            }
        }

        private fun remainderWillBeConsumed(
            remainder: String,
            incomingItems: List<ChatMessageItemResponse>,
            incomingIndex: Int,
        ): Boolean {
            for (index in incomingIndex + 1 until incomingItems.size) {
                val next = incomingItems[index]
                if (next.tool != null) continue
                if (prefixRelated(remainder, next.content.orEmpty())) return true
            }
            return false
        }

        private fun matchesTextType(item: ChatMessageItemResponse, incomingType: String): Boolean =
            isTextLikeItem(item) && item.type.orEmpty().lowercase() == incomingType

        private fun prefixRelated(left: String, right: String): Boolean =
            left.isNotEmpty() && right.isNotEmpty() && (left.startsWith(right) || right.startsWith(left))

        private fun List<ChatMessageItemResponse>.deduplicateAdjacentActiveItems(): List<ChatMessageItemResponse> =
            fold(mutableListOf()) { result, item ->
                if (result.lastOrNull()?.let { previous ->
                        if (previous.tool != null || item.tool != null) {
                            previous.tool?.id?.isNotEmpty() == true && previous.tool?.id == item.tool?.id
                        } else {
                            previous.type.orEmpty().lowercase() == item.type.orEmpty().lowercase() &&
                                previous.content == item.content
                        }
                    } != true
                ) result += item
                result
            }

        private fun mergeActiveItem(
            previous: ChatMessageItemResponse,
            incoming: ChatMessageItemResponse,
        ): ChatMessageItemResponse {
            val content = if (isTextLikeItem(previous) && isTextLikeItem(incoming)) {
                monotonicText(previous.content.orEmpty(), incoming.content.orEmpty())
            } else {
                incoming.content ?: previous.content
            }
            return ChatMessageItemResponse(
                type = incoming.type ?: previous.type,
                content = content,
                tool = mergeTool(previous.tool, incoming.tool),
                isSubagent = incoming.isSubagent ?: previous.isSubagent,
                subItems = mergeActiveItems(previous.subItems.orEmpty(), incoming.subItems.orEmpty()),
            )
        }

        private fun isTextLikeItem(item: ChatMessageItemResponse): Boolean =
            item.type.orEmpty().lowercase() in setOf("text", "message", "thinking")

        private fun monotonicText(previous: String, incoming: String): String = when {
            incoming.isEmpty() -> previous
            incoming.startsWith(previous) -> incoming
            previous.startsWith(incoming) -> previous
            incoming.length > previous.length && previous.isEmpty() -> incoming
            else -> previous
        }

        private fun mergeTools(
            previous: List<RemoteToolStatusResponse>?,
            incoming: List<RemoteToolStatusResponse>?,
        ): List<RemoteToolStatusResponse>? {
            if (incoming.isNullOrEmpty()) return previous ?: incoming
            if (previous.isNullOrEmpty()) return incoming
            val merged = previous.toMutableList()
            incoming.forEachIndexed { position, tool ->
                val index = if (!tool.id.isNullOrBlank()) merged.indexOfFirst { it.id == tool.id }
                else position.takeIf { it < merged.size && merged[it].id.isNullOrBlank() } ?: -1
                if (index < 0) merged += tool
                else merged[index] = mergeTool(merged[index], tool)!!
            }
            return merged
        }

        private fun mergeTool(
            previous: RemoteToolStatusResponse?,
            incoming: RemoteToolStatusResponse?,
        ): RemoteToolStatusResponse? = when {
            incoming == null -> previous
            previous == null -> incoming
            ToolStatusSemantics.shouldKeepPrevious(previous.status, incoming.status) -> previous
            else -> incoming.copy(
                id = incoming.id ?: previous.id,
                name = incoming.name ?: previous.name,
                status = incoming.status ?: previous.status,
                durationMs = incoming.durationMs ?: previous.durationMs,
                startMs = incoming.startMs ?: previous.startMs,
                inputPreview = incoming.inputPreview?.takeIf(String::isNotEmpty) ?: previous.inputPreview,
                toolInput = incoming.toolInput ?: previous.toolInput,
                stdout = incoming.stdout?.takeIf(String::isNotEmpty) ?: previous.stdout,
                stderr = incoming.stderr?.takeIf(String::isNotEmpty) ?: previous.stderr,
                toolOutput = incoming.toolOutput ?: previous.toolOutput,
                resultPreview = incoming.resultPreview?.takeIf(String::isNotEmpty) ?: previous.resultPreview,
                errorPreview = incoming.errorPreview?.takeIf(String::isNotEmpty) ?: previous.errorPreview,
                exitCode = incoming.exitCode ?: previous.exitCode,
            )
        }

        private fun isLocalPendingActiveTurn(activeTurn: ChatMessage): Boolean =
            activeTurn.id.startsWith("active-pending-") && activeTurn.turnId.isNullOrEmpty()

        private fun mergeMessages(
            current: List<ChatMessage>,
            incoming: List<ChatMessage>,
        ): List<ChatMessage> {
            val merged = current.toMutableList()
            incoming.forEach { message ->
                val existingIndex = merged.indexOfFirst { samePersistedMessage(it, message) }
                if (existingIndex >= 0) {
                    val previous = merged[existingIndex]
                    // A replayed provisional row must not replace the durable identity/body.
                    merged[existingIndex] = if (previous.id != message.id && isProvisionalUser(message)) {
                        previous
                    } else {
                        mergeMessageSnapshot(previous, message)
                    }
                } else {
                    merged += message
                }
            }
            return merged
        }

        private fun withoutProvisionalUserAliases(messages: List<ChatMessage>): List<ChatMessage> {
            val durableTurns = messages.filter { it.role == "user" && !isProvisionalUser(it) }
                .mapNotNullTo(mutableSetOf()) { it.turnId?.takeIf(String::isNotBlank) }
            return messages.filterNot { isProvisionalUser(it) && it.turnId in durableTurns }
        }

        private fun newlyPersistedMessages(
            previous: List<ChatMessage>,
            incoming: List<ChatMessage>,
        ): List<ChatMessage> {
            val ids = previous.mapTo(mutableSetOf()) { it.id }
            val userTurns = previous.filter { it.role == "user" }
                .mapNotNullTo(mutableSetOf()) { it.turnId?.takeIf(String::isNotBlank) }
            val provisionalTurns = previous.filter(::isProvisionalUser).mapTo(mutableSetOf()) { it.turnId }
            return incoming.filterNot { message ->
                message.id in ids || (message.role == "user" && !message.turnId.isNullOrBlank() &&
                    (message.turnId in provisionalTurns || (isProvisionalUser(message) && message.turnId in userTurns)))
            }
        }

        /** The host can expose a Turn placeholder before the original user message is persisted. */
        private fun isProvisionalUser(message: ChatMessage): Boolean =
            message.role == "user" && !message.turnId.isNullOrBlank() &&
                message.id == "${message.turnId}-user"

        private fun samePersistedMessage(previous: ChatMessage, incoming: ChatMessage): Boolean {
            if (previous.id == incoming.id) return true
            // Only the known host-generated placeholder is an alias. Two durable
            // user messages (including repeated steering) never merge by text or turn alone.
            return previous.role == "user" && incoming.role == "user" &&
                !previous.turnId.isNullOrBlank() && previous.turnId == incoming.turnId &&
                (isProvisionalUser(previous) || isProvisionalUser(incoming))
        }

        private fun mergeMessageSnapshot(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
            val hasIncomingText = incoming.text.trim().isNotEmpty()
            return incoming.copy(
                turnId = incoming.turnId ?: previous.turnId,
                role = incoming.role.ifEmpty { previous.role },
                text = if (hasIncomingText) incoming.text else previous.text,
                status = incoming.status.ifEmpty { previous.status },
                detail = incoming.detail ?: previous.detail,
                timestamp = incoming.timestamp ?: previous.timestamp,
                thinking = incoming.thinking ?: if (hasIncomingText) null else previous.thinking,
                tools = incoming.tools ?: previous.tools,
                items = incoming.items ?: previous.items,
                images = incoming.images ?: previous.images,
                renderVersion = incoming.renderVersion ?: previous.renderVersion,
            )
        }

        private fun isPersistedAssistantDuplicate(activeTurn: ChatMessage, message: ChatMessage): Boolean {
            if (message.role != "assistant" || !hasDisplayableAssistantFinal(message)) return false
            if (message.id == activeTurn.id) return true
            if (!activeTurn.turnId.isNullOrEmpty() && message.id == "${activeTurn.turnId}_assistant") return true
            return !activeTurn.turnId.isNullOrEmpty() && !message.turnId.isNullOrEmpty() &&
                activeTurn.turnId == message.turnId
        }

        private fun coveredByNewAssistantContent(
            activeTurn: ChatMessage,
            messages: List<ChatMessage>,
        ): Boolean {
            val activeText = activeTurn.text.trim()
            if (activeText.isEmpty()) return false
            return messages.any { message ->
                message.role == "assistant" && hasDisplayableAssistantFinal(message) &&
                    message.text.trim() == activeText
            }
        }

        private fun hasDisplayableAssistantFinal(message: ChatMessage): Boolean {
            val text = message.text.trim()
            if (text.isNotEmpty() && text != message.thinking.orEmpty().trim()) return true
            return lastTopLevelText(message.items.orEmpty()).isNotEmpty()
        }

        private fun lastTopLevelText(items: List<ChatMessageItemResponse>): String {
            for (item in items.asReversed()) {
                val type = item.type.orEmpty().lowercase()
                val content = item.content.orEmpty().trim()
                if (content.isNotEmpty() && item.tool == null && item.isSubagent != true &&
                    type !in setOf("thinking", "tool", "subagent", "agent")
                ) {
                    return content
                }
            }
            return ""
        }

        private fun isPersistedUserDuplicate(pending: ChatMessage, message: ChatMessage): Boolean {
            if (pending.role != "user" || message.role != "user") return false
            if (pending.id == message.id) return true
            if (!pending.turnId.isNullOrBlank() && !message.turnId.isNullOrBlank()) {
                return pending.turnId == message.turnId
            }
            val pendingText = pending.text.trim()
            if (pendingText.isEmpty() || pendingText != message.text.trim()) return false
            return imageSignature(pending.images.orEmpty()) == imageSignature(message.images.orEmpty())
        }

        private fun imageSignature(images: List<ImageAttachment>): String =
            images.map { "${it.name}:${it.dataUrl}" }.sorted().joinToString("|")

        private fun selectedModelIdForCatalog(catalog: RemoteModelCatalog, current: String): String {
            catalog.sessionModelId?.takeIf(String::isNotEmpty)?.let { return it }
            if (current.isNotEmpty() && ModelSelectionPolicy.resolve(catalog, current) != null) return current.trim()
            return catalog.defaultModels.primary ?: catalog.defaultModels.fast ?: current
        }
    }
}
