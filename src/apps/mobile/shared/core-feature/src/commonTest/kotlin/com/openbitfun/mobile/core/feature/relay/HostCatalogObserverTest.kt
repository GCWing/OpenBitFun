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
        assertEquals(listOf<HostCatalogNotice>(HostCatalogNotice.Changed), notices)
        fun event(name: String) = buildJsonObject { put("session_id", HOST_CATALOG_ID); put("event", name); put("payload", JsonObject(emptyMap())) }
        events.emit(event("host-catalog-changed")); runCurrent()
        events.emit(event(STREAM_EVENT_GAP)); runCurrent()
        events.emit(event("session-record")); runCurrent()
        assertEquals(3, notices.size)
        assertTrue(notices.all { it == HostCatalogNotice.Changed })
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
