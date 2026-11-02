package com.openbitfun.mobile.core.feature.relay

import com.openbitfun.mobile.core.transport.HOST_CATALOG_ID
import com.openbitfun.mobile.core.transport.HostStreamUnsupportedException
import com.openbitfun.mobile.core.transport.RemoteSessionStreamTransport
import com.openbitfun.mobile.core.transport.STREAM_EVENT_GAP
import com.openbitfun.mobile.core.transport.STREAM_EVENT_RESUMED
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

internal sealed interface HostCatalogNotice {
    data class Changed(
        val sessionsRevision: Long? = null,
        val workspacesRevision: Long? = null,
    ) : HostCatalogNotice
    data object Failed : HostCatalogNotice
}

/**
 * Shortest spacing between two `Changed` notices handed to the catalog consumers.
 *
 * A running turn rewrites its own records, and every rewrite is one host catalog
 * change, so the notices arrive for as long as the turn does. Each consumer
 * answers a notice with relay round trips (`list_sessions` + `get_model_catalog`,
 * `list_recent_workspaces` + `list_assistants`), and a pass takes about as long
 * as the round trip it measures, so answering every notice keeps the one relayed
 * channel busy around the clock — measured at ~2 commands per second during an active
 * turn, competing with the user's own taps. A floor turns that into a bounded
 * refresh rate; the panel is at most this stale, and the first notice after an
 * idle period is still immediate.
 */
internal const val HOST_CATALOG_NOTICE_MIN_INTERVAL_MS: Long = 3_000L

/**
 * One account/target catalog stream, shared by workspace and session catalog
 * consumers. The catalog is read from the online host on demand; a host that
 * predates `read_stream` is reported once and not polled again.
 */
internal fun hostCatalogObserver(scope: CoroutineScope, source: RemoteSessionStreamTransport): Flow<HostCatalogNotice> = channelFlow {
    var backoff = 1_000L
    // Pacing lives on its own coroutine: the stream collector must keep draining
    // the reader lane, and a delay in it would hold back the host's own pages.
    val changed = Channel<Unit>(Channel.CONFLATED)
    var pending: HostCatalogNotice.Changed? = null
    fun invalidate(notice: HostCatalogNotice.Changed) {
        val previous = pending
        pending = if (previous == HostCatalogNotice.Changed() || notice == HostCatalogNotice.Changed()) {
            HostCatalogNotice.Changed()
        } else {
            HostCatalogNotice.Changed(
                notice.sessionsRevision ?: previous?.sessionsRevision,
                notice.workspacesRevision ?: previous?.workspacesRevision,
            )
        }
        changed.trySend(Unit)
    }
    launch {
        while (true) {
            changed.receive()
            val notice = pending ?: continue
            pending = null
            send(notice)
            delay(HOST_CATALOG_NOTICE_MIN_INTERVAL_MS)
        }
    }
    while (currentCoroutineContext().isActive) {
        var caughtUp = false
        try {
            source.subscribe(HOST_CATALOG_ID, { trySend(HostCatalogNotice.Failed) }, {
                if (!caughtUp) { caughtUp = true; backoff = 1_000L; invalidate(HostCatalogNotice.Changed()) }
            }).collect { event ->
                if (caughtUp && event["event"]?.jsonPrimitive?.contentOrNull in setOf("host-catalog-changed", STREAM_EVENT_RESUMED, STREAM_EVENT_GAP)) {
                    val payload = event["payload"] as? kotlinx.serialization.json.JsonObject
                    val sessionsRevision = payload?.get("sessionsRevision")?.jsonPrimitive?.longOrNull
                    val workspacesRevision = payload?.get("workspacesRevision")?.jsonPrimitive?.longOrNull
                    invalidate(HostCatalogNotice.Changed(sessionsRevision, workspacesRevision))
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (unsupported: HostStreamUnsupportedException) { send(HostCatalogNotice.Failed); awaitCancellation() }
        catch (_: Throwable) { send(HostCatalogNotice.Failed) }
        delay(backoff); backoff = (backoff * 2).coerceAtMost(30_000L)
    }
}.buffer(Channel.CONFLATED).shareIn(scope, SharingStarted.WhileSubscribed(), replay = 0)
