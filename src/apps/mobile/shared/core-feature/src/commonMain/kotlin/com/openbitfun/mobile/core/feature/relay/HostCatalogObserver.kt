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
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal sealed interface HostCatalogNotice {
    data object Changed : HostCatalogNotice
    data object Failed : HostCatalogNotice
}

/**
 * One account/target catalog stream, shared by workspace and session catalog
 * consumers. The catalog is read from the online host on demand; a host that
 * predates `read_stream` is reported once and not polled again.
 */
internal fun hostCatalogObserver(scope: CoroutineScope, source: RemoteSessionStreamTransport): Flow<HostCatalogNotice> = channelFlow {
    var backoff = 1_000L
    while (currentCoroutineContext().isActive) {
        var caughtUp = false
        try {
            source.subscribe(HOST_CATALOG_ID, { trySend(HostCatalogNotice.Failed) }, {
                if (!caughtUp) { caughtUp = true; backoff = 1_000L; trySend(HostCatalogNotice.Changed) }
            }).collect { event ->
                if (caughtUp && event["event"]?.jsonPrimitive?.contentOrNull in setOf("host-catalog-changed", STREAM_EVENT_RESUMED, STREAM_EVENT_GAP)) send(HostCatalogNotice.Changed)
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (unsupported: HostStreamUnsupportedException) { send(HostCatalogNotice.Failed); awaitCancellation() }
        catch (_: Throwable) { send(HostCatalogNotice.Failed) }
        delay(backoff); backoff = (backoff * 2).coerceAtMost(30_000L)
    }
}.buffer(Channel.CONFLATED).shareIn(scope, SharingStarted.WhileSubscribed(), replay = 0)
