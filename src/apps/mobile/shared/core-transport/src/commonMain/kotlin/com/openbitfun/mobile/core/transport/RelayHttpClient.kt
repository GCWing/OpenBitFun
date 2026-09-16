package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.network.sockets.ConnectTimeoutException
import io.ktor.client.network.sockets.SocketTimeoutException
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.accept
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** Connect budget, carried over from the HarmonyOS client. */
public const val RELAY_CONNECT_TIMEOUT_MS: Long = 15_000

/** Default per-request budget; long-running commands raise it per call. */
public const val RELAY_DEFAULT_TIMEOUT_MS: Long = 30_000

/**
 * Builds an [HttpClient] configured for the relay.
 *
 * The module owns client construction rather than accepting an arbitrary one
 * because the timeouts are part of the ported behaviour: without the
 * [HttpTimeout] plugin installed, a per-request `timeout { }` block is silently
 * a no-op on some engines and throws on others.
 *
 * `expectSuccess` stays off so status codes reach [httpFailureFor] instead of
 * surfacing as ktor's own exception types.
 */
public fun relayHttpClient(engine: HttpClientEngine): HttpClient =
    HttpClient(engine) { configureForRelay() }

/** As [relayHttpClient], using the engine linked into the platform artifact. */
public fun relayHttpClient(): HttpClient = HttpClient { configureForRelay() }

private fun HttpClientConfig<*>.configureForRelay() {
    expectSuccess = false
    // OkHttp rejects session.maxFrameSize assignment during the handshake.
    // Enforce the protocol limit in AccountRealtime before decoding instead.
    install(io.ktor.client.plugins.websocket.WebSockets)
    install(HttpTimeout) {
        connectTimeoutMillis = RELAY_CONNECT_TIMEOUT_MS
        requestTimeoutMillis = RELAY_DEFAULT_TIMEOUT_MS
    }
}
