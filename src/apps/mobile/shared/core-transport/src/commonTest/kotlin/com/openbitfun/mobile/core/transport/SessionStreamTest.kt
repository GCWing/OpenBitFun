package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.RelayJson
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class SessionStreamTest {
    @Test fun initialHistoryTimeoutRecoversWithoutResubscribingOrAdvancingCursor() = runTest {
        var reads = 0; var caughtUp = 0
        val failures = mutableListOf<Throwable>()
        val replica = MemoryReplica()
        val owner = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionStream("session", "unused", "relay", emptyFlow(), emptyFlow(), replica,
                readPage = { StreamPage(emptyList(), false) },
                readBefore = { reads++; if (reads == 1) throw CloudAccountException(CloudAccountFailure.TIMEOUT); StreamPage(emptyList(), false) },
                olderRequests = Channel(), onError = { failures.add(it) }, onCaughtUp = { caughtUp++ },
                prefetchOlder = false,
            ).collect()
        }
        runCurrent()
        assertEquals(1, failures.size)
        assertEquals(0, caughtUp)
        assertEquals(0L, replica.cursor())
        advanceTimeBy(1000); runCurrent()
        assertEquals(2, reads)
        assertEquals(1, caughtUp)
        assertTrue(owner.isActive)
        owner.cancel()
    }

    @Test fun initialHistoryWaitsForHostPublicationWithoutCommittingEmptyHistory() = runTest {
        var reads = 0
        var caughtUp = 0
        val replica = MemoryReplica()
        val owner = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionStream("session", "unused", "relay", emptyFlow(), emptyFlow(), replica,
                readPage = { StreamPage(emptyList(), false) },
                readBefore = {
                    reads++
                    if (reads < 3) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE, 404)
                    StreamPage(emptyList(), false)
                }, olderRequests = Channel(), onError = {}, onCaughtUp = { caughtUp++ }, prefetchOlder = false,
            ).collect()
        }
        runCurrent()
        advanceTimeBy(1000); runCurrent()
        assertEquals(2, reads)
        assertEquals(0, caughtUp)
        assertEquals(0L, replica.historyBefore())
        advanceTimeBy(2000); runCurrent()
        assertEquals(3, reads)
        assertEquals(1, caughtUp)
        assertTrue(owner.isActive)
        owner.cancel()
    }

    @Test fun stoppingDuringInitialBackoffCancelsFurtherReads() = runTest {
        var reads = 0
        val owner = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionStream("session", "unused", "relay", emptyFlow(), emptyFlow(), MemoryReplica(),
                readPage = { error("Must not read forward history") },
                readBefore = { reads++; throw CloudAccountException(CloudAccountFailure.TIMEOUT) },
                olderRequests = Channel(), onError = {}, onCaughtUp = {}, prefetchOlder = false,
            ).collect()
        }
        runCurrent(); assertEquals(1, reads)
        owner.cancelAndJoin()
        advanceTimeBy(60_000); runCurrent()
        assertEquals(1, reads)
    }

    @Test fun authenticationAndInvalidHistoryFailWithoutRetryOrCursorMutation() = runTest {
        for (failure in listOf(CloudAccountException(CloudAccountFailure.AUTHENTICATION),
            CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE), IllegalStateException("Invalid sequence"))) {
            var reads = 0; var reported = 0
            val replica = MemoryReplica()
            val result = runCatching {
                sessionStream("session", "unused", "relay", emptyFlow(), emptyFlow(), replica,
                    readPage = { error("Must not read forward history") },
                    readBefore = { reads++; throw failure }, olderRequests = Channel(),
                    onError = { reported++ }, onCaughtUp = { error("Must not report connected") }, prefetchOlder = false,
                ).collect()
            }
            val actual = assertNotNull(result.exceptionOrNull())
            assertEquals(failure::class, actual::class)
            assertEquals(failure.message, actual.message)
            assertEquals(1, reads); assertEquals(1, reported)
            assertEquals(0L, replica.cursor())
        }
    }

    @Test fun latestPageRepairsFragmentBoundaryAndOlderHistoryKeepsForwardCursor() = runTest {
        val fragments = RelayJson.decodeFromString<List<StreamFragment>>(FRAGMENTS)
        val messages = (0..1).flatMap { event -> fragments.mapIndexed { index, fragment ->
            StreamMessage((event * 5 + index + 1).toLong(), StreamContent("encrypted", RelayJson.encodeToString(StreamFragment.serializer(), fragment.copy(eventId = event.toString().padStart(20, '0')))))
        } }
        val replica = MemoryReplica()
        val notifications = MutableSharedFlow<JsonObject>()
        val reconnects = MutableSharedFlow<Long>()
        val history = Channel<CompletableDeferred<Unit>>()
        val beforeReads = mutableListOf<Long>()
        val afterReads = mutableListOf<Long>()
        val events = mutableListOf<JsonObject>()
        val errors = mutableListOf<Throwable>()
        val owner = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            sessionStream("terminal-vector", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "relay-id", notifications, reconnects, replica,
                readPage = { afterReads.add(it); StreamPage(emptyList(), false) },
                readBefore = { before ->
                    beforeReads.add(before)
                    val eligible = messages.filter { it.seq < before }.reversed()
                    val selected = eligible.take(if (before > 10) 3 else if (before == 8L) 2 else 5)
                    StreamPage(selected, eligible.size > selected.size)
                }, olderRequests = history, onError = { errors.add(it) }, onCaughtUp = {},
            ).collect { events.add(it) }
        }
        runCurrent()
        assertEquals(listOf(9007199254740991L, 8L), beforeReads)
        assertEquals(10L, replica.cursor())
        assertEquals(1, events.count { it["event"]?.jsonPrimitive?.content == "terminal-output" })
        val completed = CompletableDeferred<Unit>()
        history.send(completed); runCurrent(); completed.await()
        assertEquals(10L, replica.cursor())
        assertEquals(2, events.count { it["event"]?.jsonPrimitive?.content == "terminal-output" })
        assertTrue(replica.historyBefore() < 0)
        val reads = afterReads.size
        reconnects.emit(1); runCurrent()
        assertEquals(reads + 1, afterReads.size)
        assertTrue(errors.isEmpty())
        owner.cancel()
    }
    private class MemoryReplica : SessionStreamReplica {
        var position = 0L; var oldest = 0L
        val parts = mutableMapOf<String, MutableMap<Int,String>>()
        override suspend fun eventIds() = parts.keys.toList()
        override suspend fun cursor() = position
        override suspend fun historyBefore() = oldest
        override suspend fun setHistoryBefore(value: Long) { oldest = value }
        override suspend fun fragments(eventId: String) = parts[eventId]?.toSortedMap()?.values?.toList() ?: emptyList()
        override suspend fun commit(fragments: List<String>, cursor: Long) {
            fragments.forEach { value -> val fragment = RelayJson.decodeFromString<StreamFragment>(value); parts.getOrPut(fragment.eventId) { mutableMapOf() }[fragment.index] = value }
            position = cursor
        }
    }
    private companion object { const val FRAGMENTS = """[{"v":1,"eventId":"00000000000000000001","index":0,"count":5,"data":"eyJub25jZSI6IklDRWlJeVFsSmljb0tTb3IiLCJkYXRhIjoicVJqVkZSL3JjMkYw"},{"v":1,"eventId":"00000000000000000001","index":1,"count":5,"data":"SXl1cTR5TFdqYlU3Z2ZYcDRRL0RHcE1QWmliNGZDVlg2NU5oNEZFWDREYUpDK0Ex"},{"v":1,"eventId":"00000000000000000001","index":2,"count":5,"data":"WUhHcGpnZUQrKzVNV0JYc1RsMXRMY3Rtc3JsQzd6SHR0Wkh6K1FlQVNkb3haZ2l4"},{"v":1,"eventId":"00000000000000000001","index":3,"count":5,"data":"dFFrbXdaN2xhcUE5NEFZNGYrdXVjVHRjZFBKd3JOL3I2TUYvMTlUM01SajA0eTcr"},{"v":1,"eventId":"00000000000000000001","index":4,"count":5,"data":"L2t1MXhoV1NnOWY2Ly9rby9hYjlUeE01WUNkejZZV3ZQaFk9In0="}]""" }
}
