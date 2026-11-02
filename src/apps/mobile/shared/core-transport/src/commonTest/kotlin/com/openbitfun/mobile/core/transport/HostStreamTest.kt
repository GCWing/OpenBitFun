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
    /** Parks a history read so a test can end the stream while the page is in flight. */
    var olderGate: CompletableDeferred<Unit>? = null
    /** Parks a forward read so a test can queue hints behind a catch-up in flight. */
    var forwardGate: CompletableDeferred<Unit>? = null

    fun append(event: String, payload: JsonElement = JsonObject(emptyMap())): Long {
        val seq = nextSeq++
        events += StreamEventWire(seq, event, payload)
        return seq
    }
    fun restart() { epoch += 1; events.clear(); nextSeq = 1 }
    val cursor: Long get() = nextSeq - 1

    override suspend fun read(after: Long?, before: Long?, epoch: Long?): StreamPageWire {
        reads += Triple(after, before, epoch)
        if (before != null) olderGate?.await()
        if (after != null) forwardGate?.await()
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

    /** A `session-record` payload as the host writes it: every record names its turn. */
    private fun turnRecord(turn: String, n: Int) = buildJsonObject {
        put("n", n); put("id", "item/$n"); put("turn", buildJsonObject { put("turnId", turn) })
    }

    private fun emittedTurnIds(events: List<JsonObject>) = events
        .filter { it.getValue("event").jsonPrimitive.content == "session-record" }
        .map { it.getValue("payload").jsonObject.getValue("turn").jsonObject.getValue("turnId").jsonPrimitive.content }

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

    @Test fun jsSafeHistoryCursorsDoNotMoveTheForwardCursor() = runTest {
        val ceiling = 1L shl 52
        val host = FakeHost("s1", pageSize = 2)
        host.nextSeq = ceiling - 3
        repeat(3) { host.append("session-record", turnRecord("t$it", it)) }
        val hints = MutableSharedFlow<StreamHint>()
        val older = Channel<CompletableDeferred<Unit>>()
        val (received, _) = open(host, hints = hints, older = older)
        runCurrent()
        val page = CompletableDeferred<Unit>(); older.send(page); runCurrent()
        assertTrue(page.isCompleted)
        assertEquals(Triple<Long?,Long?,Long?>(null, ceiling - 2, 1L), host.reads.last())
        host.append("session-record", turnRecord("live", 3))
        hints.emit(StreamHint("desktop-1", "s1",host.epoch,host.cursor)); runCurrent()
        assertEquals(Triple<Long?,Long?,Long?>(ceiling - 1, null, 1L),host.reads.last())
        assertEquals(listOf("t1","t2","t0","live"), emittedTurnIds(received))
    }

    @Test fun completionWaitsUntilTheCollectorConsumesTheWholePage() = runTest {
        val host = FakeHost("s1", pageSize = 2)
        repeat(4) { host.append("session-record", turnRecord("turn-$it", it)) }
        val older = Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED)
        var caughtUp = false
        var gate = CompletableDeferred<Unit>()
        var received = 0
        val job = backgroundScope.launch {
            hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), host, older,
                { throw it }, { caughtUp = true }).collect {
                gate.await()
                received++
            }
        }
        runCurrent()
        assertFalse(caughtUp, "Enqueued records are not yet a hydrated transcript")
        gate.complete(Unit); runCurrent()
        assertTrue(caughtUp)
        assertEquals(3, received)
        gate = CompletableDeferred()
        val page = CompletableDeferred<Unit>()
        older.send(page); runCurrent()
        assertFalse(page.isCompleted, "History loading must cover reducer consumption, not only the RPC")
        gate.complete(Unit); runCurrent()
        assertTrue(page.isCompleted)
        assertEquals(7, received)
        job.cancel(); runCurrent()
    }

    @Test fun failedLaterPageSettlesReceivedRecordsBeforeReportingFailure() = runTest {
        val host = FakeHost("s1", pageSize = 2)
        repeat(10) { host.append("session-record", turnRecord("same-turn", it)) }
        var olderReads = 0
        val reads = object : HostStreamReads {
            override suspend fun read(after: Long?, before: Long?, epoch: Long?): StreamPageWire {
                if (before != null && ++olderReads == 2) error("later page unavailable")
                return host.read(after, before, epoch)
            }
            override suspend fun unsubscribe() = host.unsubscribe()
        }
        val older = Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED)
        val received = mutableListOf<JsonObject>()
        var gate = CompletableDeferred<Unit>().apply { complete(Unit) }
        val job = backgroundScope.launch {
            hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), reads, older, { throw it }, {}).collect {
                gate.await(); received += it
            }
        }
        runCurrent()
        gate = CompletableDeferred()
        val request = CompletableDeferred<Unit>()
        older.send(request); runCurrent()
        assertFalse(request.isCompleted, "Failure cannot release loading before queued records are consumed")
        gate.complete(Unit); runCurrent()
        assertTrue(request.isCancelled)
        assertEquals(listOf(STREAM_EVENT_HISTORY_STARTED, "session-record", "session-record", STREAM_EVENT_READY), names(received.takeLast(4)))
        assertTrue(received.last().getValue("payload").jsonObject.getValue("hasMore").jsonPrimitive.boolean)
        job.cancel(); runCurrent()
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
        // One turn per record: every older page shows a turn the transcript does
        // not have yet, so each request reads exactly the page it was asked for.
        repeat(7) { host.append("session-record", turnRecord("t$it", it + 1)) }
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

    @Test fun oneHistoryRequestKeepsReadingUntilAPageShowsAnOlderTurn() = runTest {
        val host = FakeHost("s1")
        repeat(3) { host.append("session-record", turnRecord("t1", it)) }
        repeat(9) { host.append("session-record", turnRecord("t2", it + 3)) }
        val older = Channel<CompletableDeferred<Unit>>()
        val (received, _) = open(host, older = older)
        runCurrent()
        assertEquals(1, host.reads.size, "the opening page is the newest one")

        val request = CompletableDeferred<Unit>(); older.send(request); runCurrent()
        assertTrue(request.isCompleted)
        // The newest page holds only t2 records, and so do the two pages behind
        // it: reading one page per request would show the reader nothing new.
        assertEquals(listOf(10L, 7L, 4L), host.reads.drop(1).map { it.second })
        assertEquals(
            listOf("t2", "t2", "t2", "t2", "t2", "t2", "t2", "t2", "t2", "t1", "t1", "t1"),
            emittedTurnIds(received),
        )
        assertEquals(false, received.last().getValue("payload").jsonObject.getValue("hasMore").jsonPrimitive.boolean)
    }

    @Test fun aHistoryRequestStopsAtItsPageBudgetAndTheNextOneContinues() = runTest {
        val host = FakeHost("s1")
        repeat(3) { host.append("session-record", turnRecord("t1", it)) }
        repeat(21) { host.append("session-record", turnRecord("t2", it + 3)) }
        val older = Channel<CompletableDeferred<Unit>>()
        val (received, _) = open(host, older = older)
        runCurrent()

        val first = CompletableDeferred<Unit>(); older.send(first); runCurrent()
        assertTrue(first.isCompleted)
        assertEquals(listOf(22L, 19L, 16L, 13L), host.reads.drop(1).map { it.second })
        assertTrue(emittedTurnIds(received).all { it == "t2" }, "the budget stops before t1 is reached")
        assertEquals(true, received.last().getValue("payload").jsonObject.getValue("hasMore").jsonPrimitive.boolean)

        val second = CompletableDeferred<Unit>(); older.send(second); runCurrent()
        assertTrue(second.isCompleted)
        assertEquals(listOf(10L, 7L, 4L), host.reads.drop(5).map { it.second })
        assertTrue(emittedTurnIds(received).contains("t1"), "the next request continues where the budget stopped")
        assertEquals(false, received.last().getValue("payload").jsonObject.getValue("hasMore").jsonPrimitive.boolean)
    }

    @Test fun aHintBurstCostsOneCatchUpAndDoesNotDelayAQueuedHistoryRequest() = runTest {
        val host = FakeHost("s1")
        repeat(7) { host.append("session-record", turnRecord("t$it", it + 1)) }
        val hints = MutableSharedFlow<StreamHint>()
        val older = Channel<CompletableDeferred<Unit>>()
        val (_, _) = open(host, hints = hints, older = older)
        runCurrent()

        // A streaming host fans out one hint per event. Park the catch-up the
        // first hint starts, so the rest pile up behind it exactly as they do
        // while a turn is streaming.
        val gate = CompletableDeferred<Unit>()
        host.forwardGate = gate
        repeat(4) { host.append("session-record", turnRecord("t9", 90 + it)); hints.emit(StreamHint("desktop-1", "s1", host.epoch, host.cursor)) }
        runCurrent()
        assertEquals(1, host.reads.count { it.first != null }, "the hints queue behind one catch-up read")
        val readsBeforeGate = host.reads.size

        val request = CompletableDeferred<Unit>(); older.send(request); runCurrent()
        gate.complete(Unit); runCurrent()

        assertTrue(request.isCompleted, "the queued request is answered as soon as the lane is free")
        val refreshed = host.reads.drop(readsBeforeGate).count { it.first != null }
        assertTrue(refreshed <= 2, "four queued hints cost one catch-up, not one each: reads=$refreshed")
        assertEquals(5L, host.reads.first { it.second != null }.second, "the request reads before the oldest known sequence")
    }

    @Test fun aHistoryRequestTheLaneNeverReachedIsFailedWhenTheStreamEnds() = runTest {
        val host = FakeHost("s1")
        repeat(7) { host.append("session-record", buildJsonObject { put("n", it) }) }
        val gate = CompletableDeferred<Unit>()
        host.olderGate = gate
        val older = Channel<CompletableDeferred<Unit>>()
        val (_, job) = open(host, older = older)
        runCurrent()
        val inFlight = CompletableDeferred<Unit>()
        older.send(inFlight); runCurrent()
        assertFalse(inFlight.isCompleted, "the page is still parked on the host")
        val queued = CompletableDeferred<Unit>()
        older.send(queued); runCurrent()
        assertFalse(queued.isCompleted)

        job.cancel(); runCurrent()
        assertTrue(inFlight.isCompleted)
        assertTrue(queued.isCompleted, "a request the lane cannot serve must still be answered")
        assertFailsWith<IllegalStateException> { queued.getCompleted() }
        gate.complete(Unit); runCurrent()
    }

    @Test fun aHistoryRequestQueuedBeforeTheLaneStartsIsFailedWhenTheOpeningReadIsFatal() = runTest {
        val host = FakeHost("s1")
        host.append("session-record")
        host.failNext = CloudAccountException(CloudAccountFailure.AUTHENTICATION)
        val older = Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED)
        val request = CompletableDeferred<Unit>()
        older.send(request)
        val fatal = CompletableDeferred<Throwable>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            try { hostStream("s1", "desktop-1", emptyFlow(), emptyFlow(), host, older, {}, {}).collect() }
            catch (error: Throwable) { fatal.complete(error) }
        }
        runCurrent()
        assertTrue(request.isCompleted, "a lane that never started still answers what was queued for it")
        assertFailsWith<IllegalStateException> { request.getCompleted() }
        assertEquals(CloudAccountFailure.AUTHENTICATION, (fatal.getCompleted() as CloudAccountException).failure)
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
