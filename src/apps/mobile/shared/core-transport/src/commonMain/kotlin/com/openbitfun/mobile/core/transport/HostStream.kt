package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.isError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Controller-side reader of one host-owned stream.
 *
 * Wire contract shared with `remote_connect/host_stream.rs` and the Web
 * `HostStream.ts`: every page is read from the online desktop over pairwise
 * encrypted device RPC (`read_stream`), and the desktop pushes
 * `host-stream-changed` hints naming only the stream, its epoch and newest
 * sequence. The relay forwards ciphertext and stores nothing; this client keeps
 * no cache either, so closing the flow forgets the transcript.
 */

public const val HOST_CATALOG_ID: String = "@host/catalog"
public const val HOST_STREAM_CHANGED_EVENT: String = "host-stream-changed"
public const val REMOTE_CAPABILITY_HOST_STREAM_V1: String = "host_stream_v1"

/** Hosts keep hint subscriptions alive for 10 minutes; renew well before. */
internal const val HOST_STREAM_KEEPALIVE_MS: Long = 4 * 60 * 1000L

/**
 * How many pages one history request may read while it has not yet shown the
 * reader anything it did not already have.
 *
 * Host pages are cut by sequence, and a record's sequence is the moment it was
 * last updated, so one long turn owns every record it produced: a page of
 * history can be nothing but more records of the turn that is already on
 * screen. Reading exactly one page per request then looks like "history loaded"
 * while the transcript above stayed the same, and the newest turn of a long
 * session can hold several pages by itself. The budget keeps that walk bounded
 * (a request is a user gesture, not an unbounded download); the next request
 * continues from where this one stopped.
 */
internal const val MAX_HISTORY_PAGES_PER_REQUEST: Int = 4

/** Pseudo events the stream emits around the host's own records. */
public const val STREAM_EVENT_HISTORY_STARTED: String = "relay://session-history-started"
public const val STREAM_EVENT_READY: String = "relay://session-ready"
public const val STREAM_EVENT_RESUMED: String = "relay://session-resumed"
public const val STREAM_EVENT_GAP: String = "relay://session-gap"

/**
 * The controlled device predates on-demand streams. Nothing on this side can
 * make it answer `read_stream`; the user has to update that device.
 */
public class HostStreamUnsupportedException public constructor(cause: Throwable?) :
    RelayTransportException(RelayFailure.HostStreamUnsupported, cause) {
    public constructor() : this(null)
}

@Serializable
internal data class StreamEventWire(val seq: Long, val event: String, val payload: JsonElement = JsonNull)

/** `RemoteResponse::StreamPage` as flattened onto the wire. */
@Serializable
internal data class StreamPageWire(
    @SerialName("resp") override val resp: String? = null,
    @SerialName("message") override val message: String? = null,
    @SerialName("stream_id") val streamId: String = "",
    val epoch: Long = -1,
    val events: List<StreamEventWire> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
    val cursor: Long = -1,
    @SerialName("oldest_seq") val oldestSeq: Long = -1,
    val truncated: Boolean = false,
) : CommandStatus

/** A decrypted `host-stream-changed` device event. */
public data class StreamHint(
    public val sourceDeviceId: String,
    public val streamId: String,
    public val epoch: Long,
    public val cursor: Long,
)

/** Parses a decrypted `device_event` plaintext; null for anything that is not a stream hint. */
internal fun parseStreamHint(sourceDeviceId: String, plaintext: JsonObject): StreamHint? {
    if ((plaintext["cmd"] as? JsonPrimitive)?.content != "device_event") return null
    if ((plaintext["event"] as? JsonPrimitive)?.content != HOST_STREAM_CHANGED_EVENT) return null
    val payload = plaintext["payload"] as? JsonObject ?: return null
    val streamId = (payload["stream_id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val epoch = (payload["epoch"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull() ?: return null
    val cursor = (payload["cursor"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull() ?: return null
    return StreamHint(sourceDeviceId, streamId, epoch, cursor)
}

/**
 * Whether a desktop rejection means "this host has no `read_stream`", as
 * opposed to a refusal it chose. Older hosts answer an unknown `cmd` with a
 * parse failure; there is no capability bit to consult on that path.
 */
internal fun isUnknownStreamCommandRejection(message: String?): Boolean {
    val text = message.orEmpty()
    return text.contains("invalid RPC command") || text.contains("unknown variant") ||
        text.contains("Could not parse device command")
}

internal fun isRetryableStreamFailure(failure: Throwable): Boolean =
    failure is CloudAccountException && failure.failure in setOf(
        CloudAccountFailure.NETWORK, CloudAccountFailure.TIMEOUT,
        CloudAccountFailure.RELAY_UNAVAILABLE, CloudAccountFailure.RATE_LIMITED,
    )

/** Rejects a page the host did not accept and asserts it answers this stream. */
internal fun checkStreamPage(streamId: String, page: StreamPageWire): StreamPageWire {
    if (page.isError) {
        if (isUnknownStreamCommandRejection(page.message)) throw HostStreamUnsupportedException()
        throw RelayTransportException(RelayFailure.RemoteRejected(page.message))
    }
    if (page.resp != null && page.resp != "stream_page") throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
    if (page.streamId != streamId || page.epoch < 0 || page.cursor < 0) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
    return page
}

/** Host reads issued by one stream; production is encrypted device RPC. */
internal interface HostStreamReads {
    suspend fun read(after: Long?, before: Long?, epoch: Long?): StreamPageWire
    suspend fun unsubscribe()
}

/**
 * The turn a stream event belongs to, for the reader's "is this older than what
 * the caller already has" check. `session-record` payloads always carry
 * `turn.turnId`; control events belong to no turn and are ignored.
 */
internal fun streamEventTurnId(event: StreamEventWire): String? {
    if (event.event != "session-record") return null
    val turn = (event.payload as? JsonObject)?.get("turn") as? JsonObject ?: return null
    return (turn["turnId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

private class HostStreamReader(
    private val streamId: String,
    private val reads: HostStreamReads,
    private val emit: suspend (JsonObject) -> Unit,
) {
    var epoch = 0L
    var cursor = 0L
    var oldest = 1L
    var hasMore = false
    var truncated = false

    /** Turns already emitted to the caller, i.e. already part of the transcript. */
    private val emittedTurns = mutableSetOf<String>()

    private suspend fun read(after: Long? = null, before: Long? = null, epoch: Long? = null): StreamPageWire =
        checkStreamPage(streamId, reads.read(after, before, epoch))

    private suspend fun emitPage(page: StreamPageWire) {
        for (event in page.events) {
            emit(buildJsonObject { put("session_id", streamId); put("event", event.event); put("payload", event.payload) })
            streamEventTurnId(event)?.let { emittedTurns += it }
        }
    }

    private suspend fun emitReady() {
        emit(buildJsonObject {
            put("session_id", streamId); put("event", STREAM_EVENT_READY)
            put("payload", buildJsonObject { put("hasMore", hasMore); put("oldestSeq", oldest); put("cursor", cursor); put("truncated", truncated) })
        })
    }

    private suspend fun emitGap() {
        emit(buildJsonObject {
            put("session_id", streamId); put("event", STREAM_EVENT_GAP)
            put("payload", buildJsonObject { put("reason", "host stream restarted") })
        })
    }

    /** Latest page first, like opening a chat at its bottom. */
    suspend fun resync() {
        val page = read()
        epoch = page.epoch
        cursor = page.cursor
        oldest = page.events.firstOrNull()?.seq ?: (page.cursor + 1)
        hasMore = page.hasMore
        truncated = page.truncated
        emitPage(page)
        emitReady()
    }

    /** False when the host restarted the stream and a resync is required. */
    private suspend fun catchUp(): Boolean {
        while (true) {
            val page = read(after = cursor, epoch = epoch)
            if (page.epoch != epoch) return false
            emitPage(page)
            page.events.lastOrNull()?.let { cursor = maxOf(cursor, it.seq) }
            if (!page.hasMore) {
                // The newest sequence may belong to an evicted control event;
                // adopt it so the next hint compares against the host's view.
                cursor = maxOf(cursor, page.cursor)
                return true
            }
        }
    }

    suspend fun refresh() {
        if (catchUp()) return
        emitGap()
        resync()
    }

    suspend fun loadOlder() {
        var pages = 0
        try {
            while (hasMore && pages < MAX_HISTORY_PAGES_PER_REQUEST) {
                val page = read(before = oldest, epoch = epoch)
                if (page.epoch != epoch) {
                    emitGap()
                    resync()
                    throw IllegalStateException("Session history restarted on the host; reloaded from its latest page")
                }
                // A page that only repeats turns the transcript already has is not
                // progress: keep reading until the caller gets an older turn, the
                // host runs out of history, or this request's budget is spent.
                val showsAnOlderTurn = page.events.any { event ->
                    streamEventTurnId(event)?.let { it !in emittedTurns } == true
                }
                if (pages == 0) emit(buildJsonObject {
                    put("session_id", streamId); put("event", STREAM_EVENT_HISTORY_STARTED)
                    put("payload", JsonObject(emptyMap()))
                })
                emitPage(page)
                page.events.firstOrNull()?.let { oldest = it.seq }
                hasMore = page.hasMore
                truncated = page.truncated
                pages++
                if (showsAnOlderTurn) break
            }
        } finally {
            if (pages > 0) emitReady()
        }
    }

    fun hintIsNew(hint: StreamHint, target: String): Boolean =
        hint.sourceDeviceId == target && hint.streamId == streamId && (hint.epoch != epoch || hint.cursor > cursor)
}

private sealed interface Wake {
    /** Re-read the host; [announce] marks a connection or foreground recovery. */
    class Dirty(val announce: Boolean) : Wake
    class Older(val request: CompletableDeferred<Unit>) : Wake
}

private data class StreamDelivery(val event: JsonObject? = null, val consumed: CompletableDeferred<Unit>? = null)

/**
 * One host stream as a flow of `{session_id, event, payload}` objects.
 *
 * The opening page is read before the first emission, retrying transient
 * relay failures with backoff while [onError] reports each one; a host that
 * refuses or cannot parse `read_stream` fails the flow instead. Afterwards
 * hints, reconnects and the keepalive share one reader lane with history
 * requests so pages never interleave.
 *
 * Every wake that re-reads the host after a recovery emits
 * [STREAM_EVENT_RESUMED] first; a host restart emits [STREAM_EVENT_GAP] before
 * the latest page is replayed, and each completed catch-up calls [onCaughtUp].
 *
 * Every request on [olderRequests] is answered: one the lane cannot serve is
 * failed before the flow ends, never left awaiting, because the caller waits for
 * that answer independently of this flow.
 *
 * Wakes coalesce before the lane serves them: any number of pending hints cost
 * one catch-up read, and a history request already queued is served in that same
 * pass instead of behind one refresh per hint.
 */
internal fun hostStream(
    streamId: String,
    target: String,
    hints: Flow<StreamHint>,
    reconnects: Flow<Long>,
    reads: HostStreamReads,
    olderRequests: Channel<CompletableDeferred<Unit>>,
    onError: (Throwable) -> Unit,
    onCaughtUp: () -> Unit,
    keepaliveMs: Long = HOST_STREAM_KEEPALIVE_MS,
): Flow<JsonObject> = channelFlow<StreamDelivery> {
    val reader = HostStreamReader(streamId, reads) { send(StreamDelivery(event = it)) }
    // channelFlow.send only enqueues a record. Completion must follow reduction
    // of all preceding records, including when the UI collector is slower.
    suspend fun awaitConsumption() {
        val consumed = CompletableDeferred<Unit>()
        send(StreamDelivery(consumed = consumed))
        consumed.await()
    }
    // Declared outside the lane so closing it can answer what the lane left.
    val wakes = Channel<Wake>(Channel.UNLIMITED)
    // Requests the lane took off [wakes] and has not served yet. One sweep can
    // hand it several, and every one of them is owed an answer.
    val waiting = ArrayDeque<CompletableDeferred<Unit>>()
    // Set once a page was read with `subscribe`; before that there is nothing
    // on the host to release.
    var subscribed = false
    try {
        var retryMs = 1000L
        while (true) {
            try {
                reader.resync()
                subscribed = true
                break
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (!isRetryableStreamFailure(error)) throw error
                onError(error)
                delay(retryMs)
                retryMs = (retryMs * 2).coerceAtMost(30_000L)
            }
        }
        awaitConsumption()
        onCaughtUp()

        launch { hints.collect { hint -> if (reader.hintIsNew(hint, target)) wakes.send(Wake.Dirty(false)) } }
        launch { reconnects.collect { wakes.send(Wake.Dirty(true)) } }
        launch { while (currentCoroutineContext().isActive) { delay(keepaliveMs); wakes.send(Wake.Dirty(false)) } }
        launch { for (request in olderRequests) wakes.send(Wake.Older(request)) }

        var backoffMs = 1000L
        var dirty = false
        var announce = false
        while (currentCoroutineContext().isActive) {
            // Sweep whatever is already queued before serving anything. A
            // streaming session fans out one hint per host event, and every hint
            // carries the same meaning: read forward once. Serving exactly one
            // wake per refresh turned a hint burst into a queue of refreshes, and
            // a history request that arrived during the burst waited behind the
            // whole queue, one catch-up read at a time.
            var older = waiting.removeFirstOrNull()
            var gathered = older != null
            while (true) {
                val queued = wakes.tryReceive().getOrNull() ?: break
                gathered = true
                when (queued) {
                    is Wake.Dirty -> { dirty = true; announce = announce || queued.announce }
                    is Wake.Older -> if (older == null) older = queued.request else waiting.addLast(queued.request)
                }
            }
            // Nothing was queued: wait for a wake instead of re-running a refresh
            // that just failed. Its retry wake is what carries the backoff.
            if (!gathered) {
                when (val wake = wakes.receive()) {
                    is Wake.Dirty -> { dirty = true; announce = announce || wake.announce }
                    is Wake.Older -> older = wake.request
                }
            }
            try {
                if (dirty) {
                    if (announce) {
                        send(StreamDelivery(event = buildJsonObject { put("session_id", streamId); put("event", STREAM_EVENT_RESUMED); put("payload", JsonObject(emptyMap())) }))
                    }
                    reader.refresh()
                    dirty = false
                    announce = false
                    awaitConsumption()
                    onCaughtUp()
                }
                older?.let { request ->
                    try { reader.loadOlder(); awaitConsumption(); request.complete(Unit) } catch (cancelled: CancellationException) { throw cancelled } catch (error: Throwable) { awaitConsumption(); request.completeExceptionally(error) }
                }
                backoffMs = 1000L
            } catch (cancelled: CancellationException) {
                older?.cancel()
                throw cancelled
            } catch (error: Throwable) {
                older?.completeExceptionally(error)
                if (error is HostStreamUnsupportedException) throw error
                onError(error)
                dirty = true
                // The retry is its own wake so a hint arriving meanwhile is not lost.
                val wait = backoffMs
                launch { delay(wait); wakes.send(Wake.Dirty(false)) }
                backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
            }
        }
    } finally {
        // The caller of a history request waits outside this flow, so the lane
        // owes every request an answer: one left queued here would suspend its
        // caller for the life of the app, and every later request would sit
        // behind it. Both queues close first, so a request sent during this
        // cleanup is rejected rather than parked in a lane that has ended.
        withContext(NonCancellable) {
            val closed = IllegalStateException("Session history stream is closed")
            wakes.close()
            while (true) {
                val wake = wakes.tryReceive().getOrNull() ?: break
                if (wake is Wake.Older) wake.request.completeExceptionally(closed)
            }
            while (true) {
                val swept = waiting.removeFirstOrNull() ?: break
                swept.completeExceptionally(closed)
            }
            olderRequests.close()
            while (true) {
                val queued = olderRequests.tryReceive().getOrNull() ?: break
                queued.completeExceptionally(closed)
            }
            // Best effort: the host also drops idle subscriptions on its own.
            if (subscribed) {
                try { withTimeout(5_000L) { reads.unsubscribe() } } catch (_: Throwable) {}
            }
        }
    }
}.transform { delivery ->
    delivery.event?.let { emit(it) }
    delivery.consumed?.complete(Unit)
}

/** Streams that a command transport can also read on demand from its device. */
public interface RemoteSessionStreamTransport {
    /** Re-read every open stream now, e.g. when the app returns to the foreground. */
    public fun wakeSessionStreams() {}
    public suspend fun loadOlder(sessionId: String) { error("History stream is unavailable") }

    /**
     * Opens one host stream. The returned flow emits the host's own records as
     * `{session_id, event, payload}` plus the `relay://` pseudo events declared
     * above. Nothing is persisted on this device.
     */
    public suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject>
}
