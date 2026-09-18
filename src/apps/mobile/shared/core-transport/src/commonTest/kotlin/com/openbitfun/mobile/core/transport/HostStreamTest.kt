package com.openbitfun.mobile.core.transport

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import kotlin.test.*

/** An in-memory stand-in for `HostStreamHub`: one stream, one epoch, pages of [pageSize]. */
private class FakeHost(private val streamId: String, private val pageSize: Int = 3) : HostStreamReads {
    var epoch = 1L
    val events = mutableListOf<StreamEventWire>()
    var nextSeq = 1L
    val reads = mutableListOf<Triple<Long?, Long?, Long?>>()
    var unsubscribed = 0
    var failNext: Throwable? = null
    var rejectWith: String? = null

    fun append(event: String, payload: JsonElement = JsonObject(emptyMap())): Long {
        val seq = nextSeq++
        events += StreamEventWire(seq, event, payload)
        return seq
    }
    fun restart() { epoch += 1; events.clear(); nextSeq = 1 }
    val cursor: Long get() = nextSeq - 1

    override suspend fun read(after: Long?, before: Long?, epoch: Long?): StreamPageWire {
        reads += Triple(after, before, epoch)
        failNext?.let { failNext = null; throw it }
        rejectWith?.let { return StreamPageWire(resp = "error", message = it) }
        val page = when {
            epoch != null && epoch != this.epoch -> emptyList()
            after != null -> events.filter { it.seq > after }.take(pageSize)
            before != null -> events.filter { it.seq < before }.takeLast(pageSize)
            else -> events.takeLast(pageSize)
        }
        val hasMore = when {
            epoch != null && epoch != this.epoch -> false
            after != null -> page.isNotEmpty() && page.last().seq < cursor
            else -> page.isNotEmpty() && page.first().seq > (events.firstOrNull()?.seq ?: 1L)
        }
        return StreamPageWire(resp = "stream_page", streamId = streamId, epoch = this.epoch, events = page,
            hasMore = hasMore, cursor = cursor, oldestSeq = events.firstOrNull()?.seq ?: 1L)
    }
    override suspend fun unsubscribe() { unsubscribed++ }
}

@OptIn(ExperimentalCoroutinesApi::class)
class HostStreamTest {
    private fun names(events: List<JsonObject>) = events.map { it.getValue("event").jsonPrimitive.content }

    private fun TestScope.open(
        host: FakeHost, hints: Flow<StreamHint> = emptyFlow(), reconnects: Flow<Long> = emptyFlow(),
        older: Channel<CompletableDeferred<Unit>> = Channel(), onError: (Throwable) -> Unit = {}, onCaughtUp: () -> Unit = {},
        keepaliveMs: Long = HOST_STREAM_KEEPALIVE_MS,
    ): Pair<MutableList<JsonObject>, Job> {
        val received = mutableListOf<JsonObject>()
        val job = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            hostStream("s1", "desktop-1", hints, reconnects, host, older, onError, onCaughtUp, keepaliveMs).collect { received += it }
        }
        return received to job
    }

    @Test fun opensAtTheLatestPageAndReportsHistory() = runTest {
        val host = FakeHost("s1")
        repeat(5) { host.append("session-record", buildJsonObject { put("n", it) }) }
        var caughtUp = 0
        val (received, job) = open(host, onCaughtUp = { caughtUp++ })
        runCurrent()
        assertEquals(listOf("session-record", "session-record", "session-record", STREAM_EVENT_READY), names(received))
        assertEquals(listOf(2, 3, 4), received.dropLast(1).map { it.getValue("payload").jsonObject.getValue("n").jsonPrimitive.int })
        val ready = received.last().getValue("payload").jsonObject
        assertEquals(true, ready.getValue("hasMore").jsonPrimitive.boolean)
        assertEquals(3L, ready.getValue("oldestSeq").jsonPrimitive.long)
        assertEquals(5L, ready.getValue("cursor").jsonPrimitive.long)
        assertEquals(1, caughtUp)
        assertEquals(listOf(Triple<Long?, Long?, Long?>(null, null, null)), host.reads)
        job.cancel(); runCurrent()
        assertEquals(1, host.unsubscribed, "closing the flow releases the host subscription")
    }

    @Test fun onlyHintsForThisStreamFromThisHostThatMoveTheCursorAreRead() = runTest {
        val host = FakeHost("s1")
        host.append("session-record")
        val hints = MutableSharedFlow<StreamHint>()
        var caughtUp = 0
        val (received, _) = open(host, hints = hints, onCaughtUp = { caughtUp++ })
        runCurrent()
        val readsAfterOpen = host.reads.size
        hints.emit(StreamHint("desktop-2", "s1", host.epoch, 99)); runCurrent()
        hints.emit(StreamHint("desktop-1", "other", host.epoch, 99)); runCurrent()
        hints.emit(StreamHint("desktop-1", "s1", host.epoch, host.cursor)); runCurrent()
        assertEquals(readsAfterOpen, host.reads.size, "foreign and stale hints do not touch the host")

        host.append("session-record", buildJsonObject { put("n", 2) })
        hints.emit(StreamHint("desktop-1", "s1", host.epoch, host.cursor)); runCurrent()
        assertEquals(Triple<Long?, Long?, Long?>(1L, null, 1L), host.reads.last())
        assertEquals(listOf("session-record", STREAM_EVENT_READY, "session-record"), names(received))
        assertEquals(2, caughtUp)
    }

    @Test fun hostRestartIsAnnouncedAsAGapBeforeTheLatestPageIsReplayed() = runTest {
        val host = FakeHost("s1")
        host.append("session-record", buildJsonObject { put("n", 1) })
        val hints = MutableSharedFlow<StreamHint>()
        val (received, _) = open(host, hints = hints)
        runCurrent()
        host.restart()
        host.append("session-record", buildJsonObject { put("n", 10) })
        hints.emit(StreamHint("desktop-1", "s1", host.epoch, host.cursor)); runCurrent()
        assertEquals(listOf("session-record", STREAM_EVENT_READY, STREAM_EVENT_GAP, "session-record", STREAM_EVENT_READY), names(received))
        assertEquals(10, received[3].getValue("payload").jsonObject.getValue("n").jsonPrimitive.int)
        // The next hint compares against the new epoch, not the old one.
        val reads = host.reads.size
        hints.emit(StreamHint("desktop-1", "s1", host.epoch, host.cursor)); runCurrent()
        assertEquals(reads, host.reads.size)
    }

    @Test fun olderPagesAreReadBeforeTheOldestKnownSequence() = runTest {
        val host = FakeHost("s1")
        repeat(7) { host.append("session-record", buildJsonObject { put("n", it + 1) }) }
        val older = Channel<CompletableDeferred<Unit>>()
        val (received, _) = open(host, older = older)
        runCurrent()
        val first = CompletableDeferred<Unit>(); older.send(first); runCurrent()
        assertTrue(first.isCompleted)
        assertEquals(Triple<Long?, Long?, Long?>(null, 5L, 1L), host.reads.last())
        val second = CompletableDeferred<Unit>(); older.send(second); runCurrent()
        assertTrue(second.isCompleted)
        assertEquals(Triple<Long?, Long?, Long?>(null, 2L, 1L), host.reads.last())
        val loaded = received.filter { it.getValue("event").jsonPrimitive.content == "session-record" }
            .map { it.getValue("payload").jsonObject.getValue("n").jsonPrimitive.int }
        assertEquals(listOf(5, 6, 7, 2, 3, 4, 1), loaded)
        assertEquals(false, received.last().getValue("payload").jsonObject.getValue("hasMore").jsonPrimitive.boolean)
        val reads = host.reads.size
        val third = CompletableDeferred<Unit>(); older.send(third); runCurrent()
        assertTrue(third.isCompleted)
        assertEquals(reads, host.reads.size, "no history left means no read")
    }

    @Test fun openingRetriesTransientFailuresWithoutEmittingAndStopsAtAuthentication() = runTest {
        val host = FakeHost("s1")
        host.append("session-record")
        host.failNext = CloudAccountException(CloudAccountFailure.TIMEOUT)
        val failures = mutableListOf<Throwable>()
        var caughtUp = 0
        val (received, job) = open(host, onError = { failures += it }, onCaughtUp = { caughtUp++ })
        runCurrent()
        assertEquals(1, failures.size)
        assertEquals(0, caughtUp)
        assertTrue(received.isEmpty())
        advanceTimeBy(1000); runCurrent()
        assertEquals(2, host.reads.size)
        assertEquals(1, caughtUp)
        assertTrue(job.isActive)

        val second = FakeHost("s1")
        second.failNext = CloudAccountException(CloudAccountFailure.AUTHENTICATION)
        val fatal = CompletableDeferred<Throwable>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            try { hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), second, Channel(), {}, {}).collect() }
            catch (error: Throwable) { fatal.complete(error) }
        }
        runCurrent()
        assertEquals(CloudAccountFailure.AUTHENTICATION, (fatal.getCompleted() as CloudAccountException).failure)
        assertEquals(0, second.unsubscribed, "nothing was subscribed, so nothing is released")
    }

    @Test fun anOlderHostThatCannotParseReadStreamFailsAsUnsupported() = runTest {
        val host = FakeHost("s1")
        host.rejectWith = "Could not parse device command: unknown variant `read_stream`"
        val fatal = CompletableDeferred<Throwable>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            try { hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), host, Channel(), {}, {}).collect() }
            catch (error: Throwable) { fatal.complete(error) }
        }
        runCurrent()
        assertIs<HostStreamUnsupportedException>(fatal.getCompleted())
        assertEquals(RelayFailure.HostStreamUnsupported, (fatal.getCompleted() as RelayTransportException).failure)
        assertEquals(1, host.reads.size, "an unsupported host is not retried")
    }

    @Test fun aRefusalTheHostChoseIsSurfacedAsRemoteRejected() = runTest {
        val host = FakeHost("s1")
        host.rejectWith = "Host streams are only available over account device routing"
        val fatal = CompletableDeferred<Throwable>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            try { hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), host, Channel(), {}, {}).collect() }
            catch (error: Throwable) { fatal.complete(error) }
        }
        runCurrent()
        val error = assertIs<RelayTransportException>(fatal.getCompleted())
        assertEquals(RelayFailure.RemoteRejected("Host streams are only available over account device routing"), error.failure)
    }

    @Test fun reconnectAnnouncesResumeThenCatchesUpAndFailuresBackOff() = runTest {
        val host = FakeHost("s1")
        host.append("session-record")
        val reconnects = MutableSharedFlow<Long>()
        val failures = mutableListOf<Throwable>()
        val (received, job) = open(host, reconnects = reconnects, onError = { failures += it })
        runCurrent()
        host.append("session-record")
        reconnects.emit(1L); runCurrent()
        assertEquals(listOf("session-record", STREAM_EVENT_READY, STREAM_EVENT_RESUMED, "session-record"), names(received))

        host.failNext = CloudAccountException(CloudAccountFailure.NETWORK)
        host.append("session-record")
        reconnects.emit(2L); runCurrent()
        assertEquals(1, failures.size)
        assertEquals(STREAM_EVENT_RESUMED, names(received).last(), "the failed read emitted nothing else")
        val reads = host.reads.size
        advanceTimeBy(999); runCurrent()
        assertEquals(reads, host.reads.size)
        advanceTimeBy(1); runCurrent()
        assertEquals("session-record", names(received).last())
        // Consecutive failures double the wait; the earlier success had reset it.
        host.failNext = CloudAccountException(CloudAccountFailure.NETWORK)
        host.append("session-record")
        reconnects.emit(3L); runCurrent()
        assertEquals(2, failures.size)
        host.failNext = CloudAccountException(CloudAccountFailure.NETWORK)
        advanceTimeBy(1000); runCurrent()
        assertEquals(3, failures.size)
        advanceTimeBy(1999); runCurrent()
        assertEquals(3, failures.size)
        assertEquals(STREAM_EVENT_RESUMED, names(received).last())
        advanceTimeBy(1); runCurrent()
        assertEquals("session-record", names(received).last())
        assertTrue(job.isActive)
    }

    @Test fun keepaliveReReadsTheHostSoTheSubscriptionNeverLapses() = runTest {
        val host = FakeHost("s1")
        val (_, _) = open(host, keepaliveMs = 1_000)
        runCurrent()
        assertEquals(1, host.reads.size)
        advanceTimeBy(1_000); runCurrent()
        assertEquals(2, host.reads.size)
        assertEquals(Triple<Long?, Long?, Long?>(0L, null, 1L), host.reads.last())
    }

    @Test fun streamHintsAreOnlyTakenFromDeviceEventsWithNumericFields() {
        val good = buildJsonObject {
            put("cmd", "device_event"); put("event", HOST_STREAM_CHANGED_EVENT)
            put("payload", buildJsonObject { put("stream_id", "s1"); put("epoch", 3); put("cursor", 9) })
        }
        assertEquals(StreamHint("desktop-1", "s1", 3, 9), parseStreamHint("desktop-1", good))
        val stringy = buildJsonObject {
            put("cmd", "device_event"); put("event", HOST_STREAM_CHANGED_EVENT)
            put("payload", buildJsonObject { put("stream_id", "s1"); put("epoch", "3"); put("cursor", 9) })
        }
        assertNull(parseStreamHint("desktop-1", stringy))
        val other = buildJsonObject { put("cmd", "device_event"); put("event", "session-updated"); put("payload", JsonObject(emptyMap())) }
        assertNull(parseStreamHint("desktop-1", other))
    }

    @Test fun pagesForAnotherStreamOrWithoutACursorAreMalformed() {
        assertFailsWith<CloudAccountException> { checkStreamPage("s1", StreamPageWire(resp = "stream_page", streamId = "s2", epoch = 1, cursor = 1)) }
        assertFailsWith<CloudAccountException> { checkStreamPage("s1", StreamPageWire(resp = "stream_page", streamId = "s1")) }
        assertFailsWith<CloudAccountException> { checkStreamPage("s1", StreamPageWire(resp = "workspace_info", streamId = "s1", epoch = 1, cursor = 1)) }
        assertEquals(1L, checkStreamPage("s1", StreamPageWire(resp = "stream_page", streamId = "s1", epoch = 1, cursor = 1)).cursor)
    }
}
