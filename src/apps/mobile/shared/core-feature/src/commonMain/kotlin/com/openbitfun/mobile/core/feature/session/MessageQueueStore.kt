package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.protocol.DialogQueueRequest
import com.openbitfun.mobile.core.protocol.DialogQueueResponse
import com.openbitfun.mobile.core.protocol.DialogQueueSnapshot
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.protocol.isError
import com.openbitfun.mobile.core.transport.RemoteCommandTransport
import com.openbitfun.mobile.core.transport.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.Clock

public data class QueuedMessageUiState public constructor(
    public val id: String, public val text: String, public val attachmentCount: Int,
    public val status: String, public val reason: String?,
)
public enum class MessageQueueFailure { LOAD, CONFLICT, OUTCOME_UNKNOWN, UNSUPPORTED }
public data class MessageQueueUiState public constructor(
    public val sessionId: String?, public val supported: Boolean, public val supportsReorder: Boolean,
    public val revisionKey: String, public val items: List<QueuedMessageUiState>, public val busy: Boolean, public val failure: MessageQueueFailure?,
) {
    public constructor() : this(null, false, false, "", emptyList(), false, null)
}

/** Reads the execution host's queue. Mutations are never replayed after an ambiguous reply. */
internal class MessageQueueStore(private val scope: CoroutineScope, private val transport: RemoteCommandTransport,
    private val publish: (MessageQueueUiState) -> Unit) {
    private var state = MessageQueueUiState()
    private var snapshot: DialogQueueSnapshot? = null
    private var generation = 0L
    private var foreground = true
    private var reader: Job? = null
    private var mutation: Job? = null
    private val mutex = Mutex()
    private fun update(next: MessageQueueUiState) { state = next; publish(next) }
    fun select(sessionId: String?, supported: Boolean) {
        if (state.sessionId == sessionId && state.supported == supported) return
        generation++
        reader?.cancel(); mutation?.cancel(); snapshot = null
        val retained = state.items.takeIf { state.sessionId == sessionId }.orEmpty()
        update(MessageQueueUiState(sessionId, supported, false, "", retained, false,
            MessageQueueFailure.UNSUPPORTED.takeIf { !supported && retained.isNotEmpty() }))
        restartReader()
    }
    fun setForeground(active: Boolean) { foreground = active; restartReader() }
    private fun restartReader() {
        reader?.cancel(); reader = null
        if (!foreground || !state.supported || state.sessionId == null) return
        val ticket = generation
        reader = scope.launch {
            while (ticket == generation) {
                refresh()
                delay(if (state.items.isEmpty()) 10_000 else 2_000)
            }
        }
    }
    fun invalidate() { restartReader() }
    private suspend fun invoke(request: DialogQueueRequest): DialogQueueSnapshot {
        val response = transport.send<DialogQueueResponse>(RemoteCommand(cmd = "dialog_queue", request = request))
        check(!response.isError) { response.message ?: "Queue request failed" }
        val value = checkNotNull(response.snapshot) { "Missing queue snapshot" }
        check(value.sessionId == request.sessionId && value.queueEpoch.isNotBlank()) { "Invalid queue scope" }
        return value
    }
    private fun accept(value: DialogQueueSnapshot, authoritative: Boolean) {
        val previous = snapshot
        if (previous != null && (value.queueEpoch != previous.queueEpoch && !authoritative ||
                value.queueEpoch == previous.queueEpoch && value.revision < previous.revision)) return
        snapshot = value
        update(state.copy(supportsReorder = value.supportsReorder, failure = null, revisionKey = "${value.queueEpoch}:${value.revision}",
            items = value.items.map { QueuedMessageUiState(it.turnId, it.displayContent, it.attachmentCount, it.status, it.reason) }))
    }
    private suspend fun refresh() {
        val selected = state.sessionId ?: return
        val ticket = generation
        try {
            mutex.withLock {
                val value = invoke(DialogQueueRequest(selected, "list"))
                if (ticket == generation) accept(value, true)
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Throwable) { if (ticket == generation) update(state.copy(failure = MessageQueueFailure.LOAD)) }
    }
    fun move(id: String, beforeId: String?) = act(id, "reorder", beforeId)
    fun act(id: String, action: String, beforeId: String? = null) {
        val observed = snapshot ?: return
        if (state.busy || state.failure != null || !state.supported || !foreground) return
        val item = state.items.find { it.id == id } ?: return
        if (item.status !in listOf("queued", "blocked")) return
        if (action == "reorder" && (!observed.supportsReorder || item.status != "queued")) {
            update(state.copy(failure = MessageQueueFailure.UNSUPPORTED)); return
        }
        val ticket = generation
        val operationId = "mobile-queue-${Clock.System.now().toEpochMilliseconds()}-${kotlin.random.Random.nextLong().toULong()}"
        update(state.copy(busy = true))
        mutation = scope.launch {
            try {
                mutex.withLock {
                    val value = invoke(DialogQueueRequest(observed.sessionId, action, observed.queueEpoch, id, operationId,
                        beforeId, observed.revision.takeIf { action == "reorder" }, observed.activeTurnId))
                    if (ticket == generation) {
                        check(value.queueEpoch == observed.queueEpoch) { "queue_conflict: queue owner changed" }
                        accept(value, false)
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) {
                if (ticket == generation) update(state.copy(failure = if (error.message?.contains("queue_conflict:") == true ||
                    error.message?.contains("too_late:") == true) MessageQueueFailure.CONFLICT else MessageQueueFailure.OUTCOME_UNKNOWN))
            } finally { if (ticket == generation) update(state.copy(busy = false)) }
        }
    }
}
