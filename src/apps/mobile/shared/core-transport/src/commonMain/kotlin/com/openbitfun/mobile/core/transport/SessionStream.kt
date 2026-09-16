package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.crypto.SessionEventCipher
import com.openbitfun.mobile.core.protocol.RelayJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import kotlin.io.encoding.Base64

/** Persistence belongs to the feature's store. A commit must atomically store
 * encrypted fragments and the receive cursor; upload acknowledgements never enter here. */
public interface SessionStreamReplica {
    public suspend fun eventIds(): List<String>
    public suspend fun historyBefore(): Long = 0
    public suspend fun setHistoryBefore(value: Long) {}
    public suspend fun cursor(): Long
    public suspend fun fragments(eventId: String): List<String>
    public suspend fun commitHistory(fragments: List<String>, cursor: Long, before: Long) { commit(fragments, cursor); setHistoryBefore(before) }
    public suspend fun commit(fragments: List<String>, cursor: Long)
}

@Serializable
internal data class StreamFragment(val v: Int, val eventId: String, val index: Int, val count: Int, val data: String)
@Serializable
internal data class StreamContent(val t: String, val c: String)
@Serializable
internal data class StreamMessage(val seq: Long, val content: StreamContent)
@Serializable
internal data class StreamPage(val messages: List<StreamMessage>, val hasMore: Boolean)

internal fun sessionStream(
    sessionId: String,
    key: String,
    relaySessionId: String,
    notifications: Flow<JsonObject>,
    reconnects: Flow<Long>,
    replica: SessionStreamReplica,
    readPage: suspend (Long) -> StreamPage,
    readBefore: suspend (Long) -> StreamPage,
    olderRequests: Channel<CompletableDeferred<Unit>>,
    onError: (Throwable) -> Unit,
    onCaughtUp: () -> Unit,
    prefetchOlder: Boolean = true,
): Flow<JsonObject> = flow {
    coroutineScope {
        for (id in replica.eventIds()) {
            val parts = replica.fragments(id).map { RelayJson.decodeFromString<StreamFragment>(it) }.sortedBy { it.index }
            if (parts.isNotEmpty() && parts.size == parts.first().count) emit(decryptFragments(sessionId, key, parts))
        }
        val wake = Channel<StreamMessage?>(Channel.CONFLATED)
        var resumed = true
        launch { notifications.collect { update ->
            val body = (update["body"] as? JsonObject) ?: update
            if (body["sid"]?.jsonPrimitive?.content == relaySessionId) {
                val message = body["message"]?.let { runCatching { RelayJson.decodeFromJsonElement<StreamMessage>(it) }.getOrNull() }
                wake.trySend(message)
            }
        } }
        launch { reconnects.collect { resumed = true; wake.trySend(null) } }
        wake.trySend(null)
        suspend fun older(before: Long) {
            var boundary = before
            val messages = mutableListOf<StreamMessage>()
            var more: Boolean
            do {
                val page = readBefore(boundary)
                val sorted = page.messages.sortedBy { it.seq }
                more = page.hasMore
                if (sorted.isEmpty()) { more = false; break }
                check(sorted.all { it.content.t == "encrypted" }) { "Unencrypted history record" }
                check(sorted.zipWithNext().all { (left, right) -> right.seq == left.seq + 1 }) { "History sequence gap" }
                if (messages.isNotEmpty()) check(sorted.last().seq == boundary - 1) { "History page gap" }
                check(sorted.last().seq < boundary) { "History pagination did not advance" }
                messages.addAll(0, sorted)
                boundary = sorted.first().seq
                if (RelayJson.decodeFromString<StreamFragment>(messages.first().content.c).index == 0) break
                check(more) { "History starts within an incomplete event" }
            } while (more)
            val parts = messages.map { RelayJson.decodeFromString<StreamFragment>(it.content.c) }
            parts.groupBy { it.eventId }.values.forEach { fragments ->
                if (fragments.last().index == fragments.last().count - 1) emit(decryptFragments(sessionId, key, fragments.sortedBy { it.index }))
            }
            replica.commitHistory(messages.map { it.content.c }, maxOf(replica.cursor(), messages.lastOrNull()?.seq ?: 0), if (more) boundary else -boundary)
            emit(buildJsonObject { put("session_id", sessionId); put("event", "relay://session-ready"); put("payload", buildJsonObject { put("hasMore", more); put("oldestSeq", boundary); put("cursor", replica.cursor()) }) })
        }
        if (replica.cursor() == 0L) {
            var initialRetry = 1000L
            while (true) {
                // The host grants the key from its durable local log before the
                // publisher necessarily creates the relay session. A first-read
                // 404 is pending publication, never an empty transcript.
                try { older(9007199254740991L); break }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Throwable) {
                    onError(failure)
                    if (!isRetryableStreamFailure(failure) &&
                        !(failure is CloudAccountException && failure.statusCode == 404)) throw failure
                    delay(initialRetry)
                    initialRetry = (initialRetry * 2).coerceAtMost(30000)
                }
            }
        }
        else emit(buildJsonObject { put("session_id", sessionId); put("event", "relay://session-ready"); put("payload", buildJsonObject { put("hasMore", replica.historyBefore() > 0); put("oldestSeq", kotlin.math.abs(replica.historyBefore())); put("cursor", replica.cursor()) }) })
        if (prefetchOlder) launch {
            while (replica.historyBefore() > 0) {
                delay(250)
                if (replica.historyBefore() <= 0) break
                val completion = CompletableDeferred<Unit>()
                olderRequests.send(completion)
                try { completion.await() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Throwable) { break }
            }
        }

        var retry = 1000L
        while (true) {
            var historyRequest: CompletableDeferred<Unit>? = null
            val delivered = select<StreamMessage?> {
                olderRequests.onReceive { historyRequest = it; null }
                wake.onReceive { it }
            }
            if (historyRequest != null) {
                try { val before = replica.historyBefore(); if (before > 0) older(before); onCaughtUp(); historyRequest?.complete(Unit) }
                catch (cancelled: CancellationException) { historyRequest?.cancel(); throw cancelled }
                catch (failure: Throwable) { historyRequest?.completeExceptionally(failure); onError(failure) }
                continue
            }
            try {
                if (delivered != null && delivered.seq <= replica.cursor()) continue
                var direct = delivered
                do {
                    val cursor = replica.cursor()
                    val page = if (direct?.seq == cursor + 1) StreamPage(listOf(direct!!), false) else readPage(cursor)
                    direct = null
                    var next = cursor
                    val pending = mutableListOf<String>()
                    val events = mutableMapOf<String, MutableMap<Int, StreamFragment>>()
                    for (message in page.messages) {
                        check(message.seq == next + 1) { "Session sequence gap" }
                        check(message.content.t == "encrypted") { "Unencrypted session message" }
                        val fragment = RelayJson.decodeFromString<StreamFragment>(message.content.c)
                        check(fragment.v == 1 && fragment.count > 0 && fragment.index in 0 until fragment.count) { "Invalid session fragment" }
                        val parts = events.getOrPut(fragment.eventId) {
                            mutableMapOf<Int, StreamFragment>()
                        }
                        if (parts.isEmpty()) replica.fragments(fragment.eventId).forEach {
                            val old = RelayJson.decodeFromString<StreamFragment>(it); parts[old.index] = old
                        }
                        parts[fragment.index] = fragment
                        pending += message.content.c
                        if (fragment.index == fragment.count - 1) {
                            check(parts.size == fragment.count) { "Missing session fragments" }
                            emit(decryptFragments(sessionId, key, parts.values.sortedBy { it.index }))
                        }
                        next = message.seq
                    }
                    check(!page.hasMore || next > cursor) { "Session page made no progress" }
                    replica.commit(pending, next)
                    retry = 1000L
                } while (page.hasMore)
                onCaughtUp()
                if (resumed) {
                    resumed = false
                    emit(buildJsonObject { put("session_id", sessionId); put("event", "relay://session-resumed"); put("payload", buildJsonObject {}) })
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Throwable) {
                onError(failure)
                if (!isRetryableStreamFailure(failure)) throw failure
                // Retrying reads cannot execute host mutations. Caller cancellation remains immediate.
                delay(retry); retry = (retry * 2).coerceAtMost(30000); wake.trySend(null)
            }
        }
    }
}

public interface RemoteSessionStreamTransport {
    public fun wakeSessionStreams() {}
    public suspend fun loadOlder(sessionId: String) { error("History stream is unavailable") }
    public val streamIdentity: String
    public suspend fun subscribe(sessionId: String, replica: SessionStreamReplica, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject>
}

private suspend fun decryptFragments(sessionId: String, key: String, parts: List<StreamFragment>): JsonObject {
    val first = parts.first()
    check(parts.size == first.count) { "Missing session fragments" }
    val bytes = parts.mapIndexed { index, part ->
        check(part.index == index && part.eventId == first.eventId && part.count == first.count) { "Session fragment binding mismatch" }
        Base64.Default.decode(part.data)
    }
    val joined = ByteArray(bytes.sumOf { it.size })
    var position = 0
    bytes.forEach { it.copyInto(joined, position); position += it.size }
    val envelope = RelayJson.parseToJsonElement(joined.decodeToString(throwOnInvalidSequence = true)).jsonObject
    val plaintext = SessionEventCipher.decrypt(key, envelope.getValue("nonce").jsonPrimitive.content, envelope.getValue("data").jsonPrimitive.content)
    val event = RelayJson.parseToJsonElement(plaintext).jsonObject
    check(event["session_id"]?.jsonPrimitive?.content == sessionId && event["event"] is JsonPrimitive && event.containsKey("payload")) { "Session encryption binding mismatch" }
    return event
}

internal fun isRetryableStreamFailure(failure: Throwable): Boolean =
    failure is CloudAccountException && failure.failure in setOf(
        CloudAccountFailure.NETWORK, CloudAccountFailure.TIMEOUT,
        CloudAccountFailure.RELAY_UNAVAILABLE, CloudAccountFailure.RATE_LIMITED,
    )
