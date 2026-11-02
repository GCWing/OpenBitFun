package com.openbitfun.mobile.core.feature.relay

import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class HostCatalogObserverTest {
    @Test fun workspaceAndSessionShareOneTargetStreamAndReleaseItWhenBothLeave() = runTest {
        var attached = 0; var closed = 0
        val source = object : RemoteSessionStreamTransport {
            override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> = flow {
                assertEquals(HOST_CATALOG_ID, sessionId)
                attached++; onCaughtUp()
                try { awaitCancellation() } finally { closed++ }
            }
        }
        val changes = hostCatalogObserver(backgroundScope, source)
        val a = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { changes.collect() }
        val b = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { changes.collect() }
        runCurrent(); assertEquals(1, attached)
        a.cancel(); runCurrent(); assertEquals(0, closed)
        b.cancel(); runCurrent(); assertEquals(1, closed)
    }

    @Test fun aHostRestartOrResumeInvalidatesTheCatalogLikeAChange() = runTest {
        val events = MutableSharedFlow<JsonObject>()
        val source = object : RemoteSessionStreamTransport {
            override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> =
                events.onStart { onCaughtUp() }
        }
        val notices = mutableListOf<HostCatalogNotice>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hostCatalogObserver(backgroundScope, source).collect { notices += it } }
        runCurrent()
        assertEquals(listOf<HostCatalogNotice>(HostCatalogNotice.Changed()), notices)
        fun event(name: String) = buildJsonObject { put("session_id", HOST_CATALOG_ID); put("event", name); put("payload", JsonObject(emptyMap())) }
        events.emit(event("host-catalog-changed")); runCurrent()
        events.emit(event(STREAM_EVENT_GAP)); runCurrent()
        events.emit(event("session-record")); runCurrent()
        assertEquals(1, notices.size)
        advanceTimeBy(HOST_CATALOG_NOTICE_MIN_INTERVAL_MS + 1); runCurrent()
        assertEquals(2, notices.size)
        events.emit(event(STREAM_EVENT_RESUMED)); runCurrent()
        assertEquals(2, notices.size)
        advanceTimeBy(HOST_CATALOG_NOTICE_MIN_INTERVAL_MS + 1); runCurrent()
        assertEquals(3, notices.size)
        assertTrue(notices.all { it is HostCatalogNotice.Changed })
    }

    /**
     * A running turn rewrites its records continuously, and every rewrite is one
     * catalog change. Answering each one keeps the relayed channel busy with
     * refreshes; the panel only has to be recent, so a burst costs one refresh.
     */
    @Test fun aBurstOfChangesCostsOneRefreshPerInterval() = runTest {
        val events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 64)
        val source = object : RemoteSessionStreamTransport {
            override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> =
                events.onStart { onCaughtUp() }
        }
        val notices = mutableListOf<HostCatalogNotice>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hostCatalogObserver(backgroundScope, source).collect { notices += it } }
        runCurrent()
        assertEquals(1, notices.size)
        fun event(name: String) = buildJsonObject { put("session_id", HOST_CATALOG_ID); put("event", name); put("payload", JsonObject(emptyMap())) }
        repeat(20) { events.emit(event("host-catalog-changed")); advanceTimeBy(50); runCurrent() }
        assertEquals(1, notices.size)
        advanceTimeBy(HOST_CATALOG_NOTICE_MIN_INTERVAL_MS); runCurrent()
        assertEquals(2, notices.size)
    }

    @Test fun catalogRevisionPayloadSurvivesHintCoalescing() = runTest {
        val events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 8)
        val source = object : RemoteSessionStreamTransport {
            override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> =
                events.onStart { onCaughtUp() }
        }
        val notices = mutableListOf<HostCatalogNotice>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            hostCatalogObserver(backgroundScope, source).collect { notices += it }
        }
        runCurrent()
        assertEquals(HostCatalogNotice.Changed(), notices.single())
        events.emit(buildJsonObject {
            put("session_id", HOST_CATALOG_ID)
            put("event", "host-catalog-changed")
            put("payload", buildJsonObject { put("sessionsRevision", 7); put("workspacesRevision", 11) })
        })
        runCurrent()
        advanceTimeBy(HOST_CATALOG_NOTICE_MIN_INTERVAL_MS + 1)
        runCurrent()
        assertEquals(HostCatalogNotice.Changed(7, 11), notices.last())
    }

    @Test fun anOlderHostIsReportedOnceAndNotPolledAgain() = runTest {
        var attached = 0
        val source = object : RemoteSessionStreamTransport {
            override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): Flow<JsonObject> = flow {
                attached++
                throw HostStreamUnsupportedException()
            }
        }
        val notices = mutableListOf<HostCatalogNotice>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { hostCatalogObserver(backgroundScope, source).collect { notices += it } }
        runCurrent()
        advanceTimeBy(120_000); runCurrent()
        assertEquals(listOf<HostCatalogNotice>(HostCatalogNotice.Failed), notices)
        assertEquals(1, attached)
    }
}
